from flask import Flask, Response, request, jsonify
from flask_cors import CORS
import openai
import os
import re
import sys
import glob
import time
import uuid
import random
import shutil
import platform
import importlib.util
import ffmpeg
import redis
import hashlib
import tiktoken
import json
import socket
import ipaddress
import urllib.parse
import urllib.request
import tempfile
import threading
import numpy as np
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed


app = Flask(__name__)
CORS(app, origins=os.getenv("CORS_ORIGINS", "*").split(","))
# Oversized uploads get a 413 instead of filling the disk.
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_CONTENT_LENGTH", str(2 * 1024**3)))

CACHE_TTL = 86400
JOB_TTL = 3600


class MemoryCache:
    """In-process stand-in for Redis when REDIS_URL is unset (local dev / Mac
    GPU mode). Single-process only — matches the gunicorn --workers 1 setup."""

    def __init__(self):
        self._data = {}
        self._lock = threading.Lock()

    @staticmethod
    def _to_bytes(value):
        # Redis returns bytes; coerce on write so callers see identical types
        # (json.loads and np.frombuffer both accept bytes).
        return value if isinstance(value, bytes) else str(value).encode()

    def get(self, key):
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            value, expires_at = entry
            if time.time() > expires_at:
                del self._data[key]
                return None
            return value

    def setex(self, key, ttl, value):
        with self._lock:
            self._data[key] = (self._to_bytes(value), time.time() + ttl)

    def exists(self, key):
        return 1 if self.get(key) is not None else 0

    def delete(self, key):
        with self._lock:
            self._data.pop(key, None)

    def ping(self):
        return True


def make_cache():
    redis_url = os.getenv("REDIS_URL")
    if redis_url:
        # Upstash hands out rediss:// TLS URLs; redis-py handles them natively.
        return redis.from_url(redis_url), "redis"
    return MemoryCache(), "memory"


cache, CACHE_MODE = make_cache()


# Load OpenAI API key
openai.api_key = os.getenv("OPENAI_API_KEY")
if not openai.api_key:
    raise ValueError("Missing OpenAI API key! Set OPENAI_API_KEY in your environment.")

openai_client = openai.OpenAI(api_key=openai.api_key)

SUMMARY_MODEL = os.getenv("SUMMARY_MODEL", "gpt-4.1-nano")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "512"))
# Hosted transcription: any OpenAI-compatible endpoint. Defaults to OpenRouter,
# which routes whisper-large-v3 across Groq, DeepInfra and Together.
TRANSCRIBE_BASE_URL = os.getenv("TRANSCRIBE_BASE_URL", "https://openrouter.ai/api/v1")
TRANSCRIBE_MODEL = os.getenv("TRANSCRIBE_MODEL", "openai/whisper-large-v3")
MLX_WHISPER_MODEL = os.getenv("MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
CHUNK_SECONDS = int(os.getenv("CHUNK_SECONDS", "600"))
TRANSCRIBE_MAX_WORKERS = 6  # parallel chunk uploads per job
# "openai" re-runs a chunk on whisper-1 when the API stays rate-limited.
TRANSCRIBE_FALLBACK = os.getenv("TRANSCRIBE_FALLBACK", "").lower()

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def detect_backends():
    """Discover which transcription backends can run here. Uses find_spec, not
    a real import: importing mlx_whisper would load the MLX runtime at boot."""
    backends = []
    if os.getenv("TRANSCRIBE_API_KEY"):
        backends.append("api")
    if (
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        and importlib.util.find_spec("mlx_whisper")
    ):
        backends.append("mlx")
    if importlib.util.find_spec("faster_whisper"):
        backends.append("local")
    return tuple(backends)


AVAILABLE_BACKENDS = detect_backends()

_requested_backend = os.getenv("TRANSCRIBE_BACKEND", "api").lower()
DEFAULT_BACKEND = (
    _requested_backend
    if _requested_backend in AVAILABLE_BACKENDS
    else (AVAILABLE_BACKENDS[0] if AVAILABLE_BACKENDS else None)
)

MAX_DURATION_SECONDS = int(os.getenv("MAX_DURATION_SECONDS", "10800"))  # 3 hours

# ---------------------------------------------------------------------------
# Per-IP rate limit on the endpoints that spend model money. In-memory is
# correct here for the same reason as the job registry: gunicorn --workers 1.
# ---------------------------------------------------------------------------

RATE_LIMIT_JOBS_PER_HOUR = int(os.getenv("RATE_LIMIT_JOBS_PER_HOUR", "6"))   # 0 disables
RATE_LIMIT_JOBS_PER_DAY = int(os.getenv("RATE_LIMIT_JOBS_PER_DAY", "12"))    # 0 disables
# A resummarize is a single gpt-4.1-nano call — roughly 30x cheaper than a
# full analysis (which is transcription-dominated) — so it gets its own,
# 2x larger allowance instead of competing with processing for slots.
RATE_LIMIT_SUMMARIES_PER_HOUR = int(
    os.getenv("RATE_LIMIT_SUMMARIES_PER_HOUR", str(2 * RATE_LIMIT_JOBS_PER_HOUR))
)
RATE_LIMIT_SUMMARIES_PER_DAY = int(
    os.getenv("RATE_LIMIT_SUMMARIES_PER_DAY", str(2 * RATE_LIMIT_JOBS_PER_DAY))
)
# kind -> (per-hour limit, per-day limit, noun for the 429 message)
_RATE_LIMITS = {
    "analysis": (RATE_LIMIT_JOBS_PER_HOUR, RATE_LIMIT_JOBS_PER_DAY, "analyses"),
    "summary": (RATE_LIMIT_SUMMARIES_PER_HOUR, RATE_LIMIT_SUMMARIES_PER_DAY,
                "summary regenerations"),
}
_rate_buckets = {}  # (kind, ip) -> deque of claim timestamps
_rate_lock = threading.Lock()


def _client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _claim_job_slot(ip, kind="analysis"):
    """Take one slot of the given kind for this IP against both windows
    (analyses: 6/hour, 12/day; summaries: 2x that, by default). Returns
    (True, 0, None) when granted, else
    (False, seconds_until_a_slot_frees, "hour"|"day")."""
    per_hour, per_day, _ = _RATE_LIMITS[kind]
    if per_hour <= 0 and per_day <= 0:
        return True, 0, None
    now = time.time()
    with _rate_lock:
        bucket = _rate_buckets.setdefault((kind, ip), deque())
        while bucket and now - bucket[0] > 86400:
            bucket.popleft()
        for stale in [key for key, entries in _rate_buckets.items() if not entries]:
            if stale != (kind, ip):
                del _rate_buckets[stale]

        retry_after, scope = 0, None
        hour_hits = [t for t in bucket if now - t <= 3600]
        if per_hour > 0 and len(hour_hits) >= per_hour:
            retry_after = int(hour_hits[0] + 3600 - now) + 1
            scope = "hour"
        if per_day > 0 and len(bucket) >= per_day:
            day_wait = int(bucket[0] + 86400 - now) + 1
            if day_wait > retry_after:
                retry_after, scope = day_wait, "day"
        if scope:
            return False, retry_after, scope

        bucket.append(now)
        return True, 0, None


def _release_job_slot(ip, kind="analysis"):
    """Give back a slot when no new work actually started (dedupe/error)."""
    with _rate_lock:
        bucket = _rate_buckets.get((kind, ip))
        if bucket:
            bucket.pop()


def _fully_cached(video_key):
    """True when every pipeline stage would be a cache hit, i.e. re-processing
    this video spends no model money and should not count against the limit."""
    return bool(
        cache.get(f"transcript:{video_key}")
        and cache.get(f"summary:{video_key}")
        and cache.exists(f"search:{video_key}")
        and cache.exists(f"searchvec:{video_key}")
    )


def _fmt_wait(seconds):
    if seconds < 90:
        return "a minute"
    if seconds < 5400:
        return f"{(seconds + 59) // 60} minutes"
    hours = (seconds + 1799) // 3600
    return f"about {hours} hour" + ("s" if hours > 1 else "")


def _rate_limited_response(retry_after, scope, kind="analysis"):
    per_hour, per_day, noun = _RATE_LIMITS[kind]
    limit = per_hour if scope == "hour" else per_day
    per = "per hour" if scope == "hour" else "per day"
    response = jsonify({
        "error": f"Rate limit reached ({limit} {noun} {per}). "
                 f"Try again in {_fmt_wait(retry_after)}.",
        "retry_after": retry_after,
    })
    response.status_code = 429
    response.headers["Retry-After"] = str(retry_after)
    return response


# ---------------------------------------------------------------------------
# Job registry. One process (gunicorn --workers 1): the pool and the running
# set live in memory, job records live in the cache so the frontend can poll.
# ---------------------------------------------------------------------------

JOB_WORKERS = int(os.getenv("JOB_WORKERS", "2"))  # 2 jobs = 12 parallel API calls
JOB_POOL = ThreadPoolExecutor(max_workers=JOB_WORKERS)
_running_jobs = set()
_jobs_lock = threading.Lock()


def _update_job(job_id, **updates):
    with _jobs_lock:
        raw = cache.get(f"job:{job_id}")
        record = json.loads(raw) if raw else {}
        record.update(updates)
        record["updated_at"] = time.time()
        cache.setex(f"job:{job_id}", JOB_TTL, json.dumps(record))
        return record


def start_job(video_key, backend, upload_path, workdir):
    """Queue the pipeline for a video, deduplicating concurrent uploads:
    a second upload of the same video attaches to the running job."""
    with _jobs_lock:
        existing = cache.get(f"jobfor:{video_key}")
        if existing:
            existing_id = existing.decode() if isinstance(existing, bytes) else str(existing)
            raw = cache.get(f"job:{existing_id}")
            still_running = (
                raw
                and json.loads(raw).get("status") in ("queued", "running")
                and existing_id in _running_jobs
            )
            if still_running:
                shutil.rmtree(workdir, ignore_errors=True)
                return existing_id, True

        job_id = uuid.uuid4().hex[:16]
        now = time.time()
        record = {
            "status": "queued",
            "stage": "queued",
            "progress": None,
            "message": "Waiting for a worker",
            "sha256": video_key.split(":")[0],
            "backend": backend,
            "video_hash": video_key,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }
        cache.setex(f"job:{job_id}", JOB_TTL, json.dumps(record))
        cache.setex(f"jobfor:{video_key}", JOB_TTL, job_id)
        _running_jobs.add(job_id)

    JOB_POOL.submit(run_pipeline, job_id, video_key, backend, upload_path, workdir)
    return job_id, False


def run_pipeline(job_id, video_key, backend, upload_path, workdir, source_url=None, url_key=None):
    """The whole pipeline off-request. Every stage checks its cache key first,
    so re-submitting after a crash resumes from the last completed stage."""
    try:
        if source_url:
            # A URL seen before whose results are all still cached needs no
            # re-download: the stages below will hit their cache keys.
            sha256 = None
            urlsha_raw = cache.get(f"urlsha:{url_key}")
            if urlsha_raw:
                known_sha = urlsha_raw.decode() if isinstance(urlsha_raw, bytes) else str(urlsha_raw)
                if _fully_cached(f"{known_sha}:{backend}"):
                    sha256 = known_sha

            if sha256 is None:
                _update_job(job_id, status="running", stage="downloading", message="Downloading")

                def dl_progress(current, total):
                    _update_job(job_id, progress={"current": current, "total": total})

                upload_path = _download_source(source_url, workdir, dl_progress)
                sha256 = get_video_hash(upload_path)
                cache.setex(f"urlsha:{url_key}", CACHE_TTL, sha256)

            video_key = f"{sha256}:{backend}"
            # From here the job is addressable by file hash, like an upload.
            _update_job(job_id, sha256=sha256, video_hash=video_key, progress=None)
            cache.setex(f"jobfor:{video_key}", JOB_TTL, job_id)

        _update_job(job_id, status="running", stage="extracting", message="Extracting audio")

        transcript_raw = cache.get(f"transcript:{video_key}")
        if transcript_raw:
            transcript = json.loads(transcript_raw)
        else:
            audio_path = extract_audio(upload_path, workdir)
            if upload_path != audio_path and os.path.exists(upload_path):
                os.remove(upload_path)  # a raw video can be ~1 GB; free it now

            duration = _probe_duration(audio_path)
            if duration and duration > MAX_DURATION_SECONDS:
                raise RuntimeError(
                    f"Video is longer than {MAX_DURATION_SECONDS // 3600} hours, not supported."
                )

            _update_job(job_id, stage="transcribing", message="Transcribing")

            def progress(current, total):
                _update_job(job_id, progress={"current": current, "total": total})

            transcript = transcribe_audio(audio_path, backend, workdir, progress)
            if not transcript:
                raise RuntimeError("Transcription produced no segments.")
            cache.setex(f"transcript:{video_key}", CACHE_TTL, json.dumps(transcript))

        _update_job(job_id, stage="summarizing", progress=None, message="Summarizing")
        if not cache.get(f"summary:{video_key}"):
            short_summary, detailed_summary = summarize_text(transcript)
            cache.setex(
                f"summary:{video_key}",
                CACHE_TTL,
                json.dumps({"short": short_summary, "detailed": detailed_summary}),
            )

        _update_job(job_id, stage="indexing", message="Building search index")
        if not (cache.exists(f"search:{video_key}") and cache.exists(f"searchvec:{video_key}")):
            if not create_search_index(transcript, video_key):
                raise RuntimeError("Failed to generate embeddings.")

        _update_job(job_id, status="done", stage="done", message="Complete")
    except Exception as e:
        print(f"❌ Job {job_id} failed: {e}")
        _update_job(job_id, status="error", stage="error", error=str(e), message="Failed")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        if video_key:
            cache.delete(f"jobfor:{video_key}")
        if url_key:
            cache.delete(f"jobfor:{url_key}")
        with _jobs_lock:
            _running_jobs.discard(job_id)


def start_url_job(url, backend, workdir):
    """Queue a job that downloads its source from a URL. Dedupes on the URL
    until the file hash is known, then on the hash like upload jobs."""
    url_key = f"url:{hashlib.sha256(url.encode()).hexdigest()}:{backend}"
    with _jobs_lock:
        existing = cache.get(f"jobfor:{url_key}")
        if existing:
            existing_id = existing.decode() if isinstance(existing, bytes) else str(existing)
            raw = cache.get(f"job:{existing_id}")
            still_running = (
                raw
                and json.loads(raw).get("status") in ("queued", "running")
                and existing_id in _running_jobs
            )
            if still_running:
                shutil.rmtree(workdir, ignore_errors=True)
                return existing_id, True

        job_id = uuid.uuid4().hex[:16]
        now = time.time()
        record = {
            "status": "queued",
            "stage": "queued",
            "progress": None,
            "message": "Waiting for a worker",
            "sha256": None,
            "backend": backend,
            "video_hash": None,
            "source_url": url,
            "youtube_id": _youtube_id(url),
            "error": None,
            "created_at": now,
            "updated_at": now,
        }
        cache.setex(f"job:{job_id}", JOB_TTL, json.dumps(record))
        cache.setex(f"jobfor:{url_key}", JOB_TTL, job_id)
        _running_jobs.add(job_id)

    JOB_POOL.submit(run_pipeline, job_id, None, backend, None, workdir, url, url_key)
    return job_id, False


def _youtube_id(url):
    """Video id for youtube.com/watch, /shorts, /embed, /live and youtu.be."""
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    for prefix in ("www.", "m.", "music."):
        host = host.removeprefix(prefix)
    if host == "youtu.be":
        vid = parsed.path.lstrip("/").split("/")[0]
    elif host == "youtube.com":
        if parsed.path == "/watch":
            vid = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
        elif parsed.path.startswith(("/shorts/", "/embed/", "/live/")):
            parts = parsed.path.split("/")
            vid = parts[2] if len(parts) > 2 else ""
        else:
            vid = ""
    else:
        return None
    return vid if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid or "") else None


def _ytdlp_extractor_name(url):
    """Name of the non-generic yt-dlp extractor that handles this URL, if any
    (YouTube, Google Drive, Vimeo, …). Imported lazily: yt-dlp takes ~1s."""
    from yt_dlp.extractor import gen_extractor_classes

    for ie in gen_extractor_classes():
        if ie.IE_NAME != "generic" and ie.suitable(url):
            return ie.IE_NAME
    return None


def _download_with_ytdlp(url, workdir, progress=None):
    import yt_dlp

    def hook(d):
        if progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                progress(d.get("downloaded_bytes", 0), int(total))

    options = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": os.path.join(workdir, "source.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "progress_hooks": [hook],
        "max_filesize": app.config["MAX_CONTENT_LENGTH"],
        # Reject over-long videos before spending bandwidth on them.
        "match_filter": yt_dlp.utils.match_filter_func(
            f"duration < {MAX_DURATION_SECONDS}"
        ),
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        ydl.download([url])
    files = sorted(glob.glob(os.path.join(workdir, "source.*")))
    if not files:
        raise RuntimeError("The downloader produced no file.")
    return files[0]


def _assert_public_host(url):
    """SSRF guard for direct downloads: http(s) only, and the host must not
    resolve to a private/loopback/link-local address. (Best-effort: a
    small public app, not a multi-tenant proxy.)"""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise RuntimeError("Only http(s) URLs are supported.")
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise RuntimeError("That hostname does not resolve.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise RuntimeError("That URL points at a private address.")


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _assert_public_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _download_direct(url, workdir, progress=None):
    """Stream a direct file URL to disk with a size cap."""
    _assert_public_host(url)
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    request_ = urllib.request.Request(url, headers={"User-Agent": "DeepRecall/1.0"})
    limit = app.config["MAX_CONTENT_LENGTH"]
    with opener.open(request_, timeout=60) as resp:
        if "text/html" in (resp.headers.get("Content-Type") or ""):
            raise RuntimeError(
                "That link returns a web page, not a video file. Use a direct file link."
            )
        total = int(resp.headers.get("Content-Length") or 0)
        if total and total > limit:
            raise RuntimeError("That file exceeds the size limit.")
        ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
        path = os.path.join(workdir, "source" + (ext if ext in _UPLOAD_EXTS else ".bin"))
        done = 0
        with open(path, "wb") as f:
            while chunk := resp.read(1024 * 1024):
                done += len(chunk)
                if done > limit:
                    raise RuntimeError("That file exceeds the size limit.")
                f.write(chunk)
                if progress and total:
                    progress(done, total)
    return path


def _download_source(url, workdir, progress=None):
    if _ytdlp_extractor_name(url):
        try:
            return _download_with_ytdlp(url, workdir, progress)
        except Exception as e:
            message = str(e)
            if "Sign in" in message or "bot" in message.lower():
                raise RuntimeError(
                    "YouTube blocked the server's request. Try a direct file "
                    "link or upload the file instead."
                )
            raise RuntimeError(f"Could not download from that link: {message[:200]}")
    return _download_direct(url, workdir, progress)


_MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
}
# Each proxied stream pins one gunicorn gthread (of 8) for its lifetime.
_MEDIA_STREAMS = threading.BoundedSemaphore(int(os.getenv("MEDIA_PROXY_STREAMS", "3")))


@app.route("/media/by-url")
def media_by_url():
    """Streaming proxy for direct-link videos whose origin refuses inline
    playback (octet-stream + nosniff + attachment, e.g. GitHub release
    assets). Storage-free: bytes are piped through with a real video
    content-type, and Range passthrough keeps seeking alive. Only URLs that
    were actually processed here are served, so this is not an open proxy."""
    url = (request.args.get("url") or "").strip()
    if not url.lower().startswith(("http://", "https://")) or len(url) > 2000:
        return jsonify({"error": "Provide an http(s) URL."}), 400
    url_sha = hashlib.sha256(url.encode()).hexdigest()
    if not any(cache.get(f"urlsha:url:{url_sha}:{b}") for b in AVAILABLE_BACKENDS):
        return jsonify({"error": "Unknown media URL. Process it first."}), 404
    try:
        _assert_public_host(url)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 400
    if not _MEDIA_STREAMS.acquire(blocking=False):
        return jsonify({"error": "Too many concurrent streams. Try again shortly."}), 503
    try:
        headers = {"User-Agent": "DeepRecall/1.0"}
        if request.headers.get("Range"):
            headers["Range"] = request.headers["Range"]
        opener = urllib.request.build_opener(_SafeRedirectHandler())
        upstream = opener.open(urllib.request.Request(url, headers=headers), timeout=30)
    except Exception as e:
        _MEDIA_STREAMS.release()
        return jsonify({"error": f"Could not fetch that URL: {e}"}), 502

    def generate():
        try:
            while chunk := upstream.read(64 * 1024):
                yield chunk
        finally:
            upstream.close()
            _MEDIA_STREAMS.release()

    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    resp = Response(
        generate(),
        status=getattr(upstream, "status", 200),
        mimetype=_MEDIA_TYPES.get(ext, "video/mp4"),
    )
    resp.headers["Content-Disposition"] = "inline"
    resp.headers["Accept-Ranges"] = upstream.headers.get("Accept-Ranges", "bytes")
    for name in ("Content-Length", "Content-Range"):
        if upstream.headers.get(name):
            resp.headers[name] = upstream.headers[name]
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


def _sweep_stale_workdirs():
    """Remove temp dirs orphaned by a crash or restart."""
    cutoff = time.time() - 2 * 3600
    for path in glob.glob(os.path.join(tempfile.gettempdir(), "deeprecall-*")):
        try:
            if os.path.getmtime(path) < cutoff:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


_sweep_stale_workdirs()


def get_api_client():
    key = os.getenv("TRANSCRIBE_API_KEY")
    if not key:
        raise RuntimeError(
            "TRANSCRIBE_API_KEY is not set (an OpenRouter key by default). "
            "Add it to your environment, or use the 'mlx'/'local' backend instead."
        )
    return openai.OpenAI(api_key=key, base_url=TRANSCRIBE_BASE_URL)


def get_video_hash(video_path):
    """Generate a SHA256 hash of the video file."""
    hasher = hashlib.sha256()
    with open(video_path, "rb") as f:
        while chunk := f.read(8192):
            hasher.update(chunk)
    return hasher.hexdigest()


def extract_audio(media_path, workdir):
    """Transcode any ffmpeg input (mp4, m4a from the browser demux, …) to
    16kHz mono 32kbps MP3 — all Whisper variants only use 16kHz mono, and an
    hour of audio stays under the hosted APIs' 25MB upload limit."""
    audio_path = os.path.join(workdir, "audio.mp3")
    (
        ffmpeg.input(media_path)
        .output(audio_path, vn=None, ac=1, ar=16000, audio_bitrate="32k")
        .run(overwrite_output=True, capture_stdout=True, capture_stderr=True)
    )
    return audio_path


def split_audio(audio_path, workdir, segment_seconds=CHUNK_SECONDS):
    """Split audio into fixed-length chunks (stream copy, no re-encode)."""
    pattern = os.path.join(workdir, "chunk_%03d.mp3")
    (
        ffmpeg.input(audio_path)
        .output(pattern, f="segment", segment_time=segment_seconds, c="copy")
        .run(overwrite_output=True, capture_stdout=True, capture_stderr=True)
    )
    return sorted(glob.glob(os.path.join(workdir, "chunk_*.mp3")))


def _probe_duration(path):
    try:
        return float(ffmpeg.probe(path)["format"]["duration"])
    except Exception:
        return None


def _segments_to_transcript(segments, offset=0.0):
    return [
        {"start": seg["start"] + offset, "end": seg["end"] + offset, "text": seg["text"]}
        for seg in segments
    ]


def _with_retries(fn, attempts=5):
    """Exponential backoff on rate limits, 5xx and connection errors."""
    for attempt in range(attempts):
        try:
            return fn()
        except (openai.RateLimitError, openai.InternalServerError, openai.APIConnectionError):
            if attempt == attempts - 1:
                raise
            time.sleep(min(2 ** attempt, 20) + random.random())


def _transcribe_file_api(client, model, path):
    with open(path, "rb") as f:
        return client.audio.transcriptions.create(
            model=model,
            file=f,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )


def _transcribe_chunk_api(client, path, chunk_duration):
    try:
        result = _with_retries(lambda: _transcribe_file_api(client, TRANSCRIBE_MODEL, path))
    except (openai.RateLimitError, openai.AuthenticationError):
        # AuthenticationError included so a dummy TRANSCRIBE_API_KEY still
        # exercises the chunked path end-to-end through the fallback.
        if TRANSCRIBE_FALLBACK != "openai":
            raise
        result = _with_retries(lambda: _transcribe_file_api(openai_client, "whisper-1", path))
    if result.segments:
        return [
            {"start": seg.start, "end": seg.end, "text": seg.text}
            for seg in result.segments
        ]
    end = chunk_duration if chunk_duration else float(CHUNK_SECONDS)
    return [{"start": 0.0, "end": end, "text": result.text}]


def _transcribe_api(audio_path, workdir, progress=None):
    """Chunk the audio and transcribe all chunks in parallel on the hosted API."""
    client = get_api_client()

    chunks = []
    for path in split_audio(audio_path, workdir):
        index = int(re.search(r"chunk_(\d+)", os.path.basename(path)).group(1))
        duration = _probe_duration(path)
        # The Whisper API rejects audio under 0.1s; a segment split can leave a
        # sub-second tail chunk that carries no speech worth keeping.
        if duration is not None and duration < 1.0:
            continue
        chunks.append((index, path, duration))

    results = {}
    completed = 0
    with ThreadPoolExecutor(max_workers=TRANSCRIBE_MAX_WORKERS) as pool:
        futures = {
            pool.submit(_transcribe_chunk_api, client, path, duration): index
            for index, path, duration in chunks
        }
        # Keyed by chunk index so ordering survives as_completed.
        for future in as_completed(futures):
            index = futures[future]
            results[index] = _segments_to_transcript(
                future.result(), index * CHUNK_SECONDS
            )
            completed += 1
            if progress:
                progress(completed, len(chunks))

    return [seg for index in sorted(results) for seg in results[index]]


def _transcribe_mlx(audio_path):
    """Local transcription on Apple Silicon's GPU via MLX (pip install mlx-whisper)."""
    try:
        import mlx_whisper
    except ImportError:
        raise RuntimeError(
            "mlx-whisper is not installed. Run: pip install -r requirements-mac.txt "
            "(Apple Silicon only), or use the 'api' or 'local' backend."
        )
    result = mlx_whisper.transcribe(audio_path, path_or_hf_repo=MLX_WHISPER_MODEL)
    return _segments_to_transcript(result["segments"])


_faster_whisper_model = None


def _transcribe_local(audio_path, progress=None):
    """Portable CPU transcription via faster-whisper (CTranslate2, int8)."""
    global _faster_whisper_model
    from faster_whisper import WhisperModel

    if _faster_whisper_model is None:
        _faster_whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, info = _faster_whisper_model.transcribe(audio_path)
    transcript = []
    for seg in segments:
        transcript.append({"start": seg.start, "end": seg.end, "text": seg.text})
        if progress and info.duration:
            progress(int(seg.end), int(info.duration))
    return transcript


def transcribe_audio(audio_path, backend, workdir, progress=None):
    if backend == "api":
        return _transcribe_api(audio_path, workdir, progress)
    if backend == "mlx":
        return _transcribe_mlx(audio_path)  # MLX reports no incremental progress
    return _transcribe_local(audio_path, progress)


def _chat(system_prompt, text):
    response = openai_client.chat.completions.create(
        model=SUMMARY_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ],
    )
    return response.choices[0].message.content.strip()


def _fmt_ts(seconds):
    seconds = int(seconds)
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def summarize_text(transcript):
    """Generates a short and a detailed summary, running API calls in parallel.
    gpt-4.1-nano's 1M-token context takes any real lecture in a single pass, so
    the transcript (already joined from the transcription chunks with correct
    timestamp offsets) is fed whole as [mm:ss]-stamped lines. Structure scales
    with video length: the section budget grows with duration."""
    stamped = "\n".join(
        f"[{_fmt_ts(seg['start'])}] {seg['text'].strip()}" for seg in transcript
    )
    n_tokens = len(tiktoken.get_encoding("cl100k_base").encode(stamped))
    if n_tokens > 800000:
        raise RuntimeError(f"Transcript too long to summarize ({n_tokens} tokens).")

    duration = transcript[-1]["end"] if transcript else 0
    # Roughly one major section per 7 minutes, clamped to a readable 3..12.
    target_sections = max(3, min(12, round(duration / 420)))

    detailed_prompt = (
        "You are summarizing a lecture or video transcript. Each transcript line is "
        "prefixed with its [mm:ss] start timestamp. Produce a structured Markdown "
        "summary with exactly this shape:\n"
        "1. A short overview paragraph, 2 to 3 sentences, with no timestamps.\n"
        f"2. About {target_sections} numbered sections that cover the whole video in "
        "order. Format every section heading as '## 1. Topic title [mm:ss]' where the "
        "timestamp is copied from the transcript line where that topic starts. Never "
        "invent timestamps, only copy stamps that appear in the transcript.\n"
        "3. Under each heading, 2 to 5 concise bullet points with the key points of "
        "that section. Do not put timestamps on bullets; at most one inline [mm:ss] "
        "stamp inside a bullet for a truly pivotal moment.\n"
        "Use timestamps sparingly overall: section headings carry them, everything "
        "else stays clean. Write with plain hyphens and commas; do not use em dashes."
    )
    short_prompt = (
        "Provide a very brief high-level summary of the following lecture in under "
        "300 words of plain prose. Ignore the [mm:ss] timestamps and do not include "
        "any. Do not use em dashes."
    )

    with ThreadPoolExecutor(max_workers=2) as pool:
        detailed_future = pool.submit(_chat, detailed_prompt, stamped)
        short_future = pool.submit(_chat, short_prompt, stamped)
        return short_future.result(), detailed_future.result()


def _window_segments(transcript, window_seconds=30, max_words=60):
    """Merge Whisper segments into ~30s / ~60-word windows. Single segments are
    a few words and embed poorly; windows also keep the index small enough for
    Upstash's per-request and monthly bandwidth limits."""
    windows = []
    texts, start, end, words = [], None, None, 0
    for seg in transcript:
        text = seg["text"].strip()
        if not text:
            continue
        if start is None:
            start = seg["start"]
        texts.append(text)
        end = seg["end"]
        words += len(text.split())
        if end - start >= window_seconds or words >= max_words:
            windows.append({"text": " ".join(texts), "start": start, "end": end})
            texts, start, end, words = [], None, None, 0
    if texts:
        windows.append({"text": " ".join(texts), "start": start, "end": end})
    return windows


def _embed(texts, dimensions):
    embeddings = []
    for i in range(0, len(texts), 2048):
        response = _with_retries(
            lambda batch=texts[i:i + 2048]: openai_client.embeddings.create(
                model=EMBEDDING_MODEL, input=batch, dimensions=dimensions
            )
        )
        embeddings.extend(item.embedding for item in response.data)
    vectors = np.array(embeddings, dtype=np.float32)
    # L2-normalise so search is a plain dot product.
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-8
    return vectors


def create_search_index(transcript, cache_key):
    """Embeds transcript windows via the OpenAI API and caches them."""
    windows = _window_segments(transcript)
    if not windows:
        print("⚠️ No text found for embedding generation.")
        return False

    vectors = _embed([w["text"] for w in windows], EMBEDDING_DIMENSIONS)
    cache.setex(
        f"search:{cache_key}",
        CACHE_TTL,
        json.dumps({
            "sentences": [w["text"] for w in windows],
            "starts": [w["start"] for w in windows],
            "ends": [w["end"] for w in windows],
            "dim": vectors.shape[1],
        }),
    )
    cache.setex(f"searchvec:{cache_key}", CACHE_TTL, vectors.tobytes())
    print(f"✅ Generated {len(windows)} window embeddings.")
    return True


# Small LRU of loaded vector arrays so repeated searches on the same video do
# not re-read the blob from Upstash (bandwidth is metered).
_INDEX_CACHE = OrderedDict()
_INDEX_CACHE_LOCK = threading.Lock()
_INDEX_CACHE_SIZE = 20


def _load_index(video_key):
    with _INDEX_CACHE_LOCK:
        if video_key in _INDEX_CACHE:
            _INDEX_CACHE.move_to_end(video_key)
            return _INDEX_CACHE[video_key]

    meta_raw = cache.get(f"search:{video_key}")
    vector_bytes = cache.get(f"searchvec:{video_key}")
    if not meta_raw or not vector_bytes:
        return None
    meta = json.loads(meta_raw)
    vectors = np.frombuffer(vector_bytes, dtype=np.float32).reshape(-1, meta["dim"])

    with _INDEX_CACHE_LOCK:
        _INDEX_CACHE[video_key] = (meta, vectors)
        while len(_INDEX_CACHE) > _INDEX_CACHE_SIZE:
            _INDEX_CACHE.popitem(last=False)
    return meta, vectors


def search_query(query, meta, vectors):
    """Ranks transcript windows against a query. Cosine similarity computed
    with explicit norms so indexes cached before L2-normalisation still work."""
    response = _with_retries(
        lambda: openai_client.embeddings.create(
            model=EMBEDDING_MODEL, input=[query], dimensions=meta["dim"]
        )
    )
    query_vector = np.array(response.data[0].embedding, dtype=np.float32)
    scores = vectors @ query_vector / (
        np.linalg.norm(vectors, axis=1) * np.linalg.norm(query_vector) + 1e-8
    )
    return scores


_UPLOAD_EXTS = {".mp4", ".m4a", ".mp3", ".wav", ".mov", ".webm", ".mkv", ".aac", ".ogg", ".flac"}


@app.route('/process_video', methods=['POST'])
def process_video():
    """Accepts a video (or browser-extracted audio) upload and queues the
    processing job. Always returns 202; the client polls /jobs/<id>."""
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded."}), 400

    backend = (request.form.get("backend") or DEFAULT_BACKEND or "").lower()
    if backend not in AVAILABLE_BACKENDS:
        return jsonify({
            "error": f"Backend '{backend}' is not available on this server. "
                     f"Available: {', '.join(AVAILABLE_BACKENDS) or 'none'}"
        }), 400

    client_hash = (request.form.get("video_hash") or "").lower()
    if client_hash and not SHA256_RE.match(client_hash):
        return jsonify({"error": "video_hash must be a 64-char hex SHA-256."}), 400

    ip = _client_ip()
    allowed, retry_after, scope = _claim_job_slot(ip)
    if not allowed:
        return _rate_limited_response(retry_after, scope)

    workdir = tempfile.mkdtemp(prefix="deeprecall-")
    try:
        upload = request.files['file']
        ext = os.path.splitext(upload.filename or "")[1].lower()
        upload_path = os.path.join(workdir, "upload" + (ext if ext in _UPLOAD_EXTS else ".bin"))
        upload.save(upload_path)

        # The server-side hash is authoritative for raw video; for audio-only
        # uploads the client's hash of the original video is just a cache key.
        sha256 = client_hash or get_video_hash(upload_path)
        video_key = f"{sha256}:{backend}"

        job_id, deduplicated = start_job(video_key, backend, upload_path, workdir)
        if deduplicated or _fully_cached(video_key):
            # Attached to a running job, or every stage is a cache hit:
            # no model money is spent, so give the slot back.
            _release_job_slot(ip)
        return jsonify({
            "job_id": job_id,
            "video_hash": video_key,
            "deduplicated": deduplicated,
        }), 202
    except Exception as e:
        _release_job_slot(ip)
        shutil.rmtree(workdir, ignore_errors=True)
        print(f"❌ Error accepting upload: {e}")
        return jsonify({"error": f"Failed to accept upload: {e}"}), 500


@app.route('/process_url', methods=['POST'])
def process_url():
    """Queues processing of a video fetched from a URL (YouTube, Google Drive,
    or a direct file link). Always 202; the client polls /jobs/<id>."""
    data = request.json or {}
    url = (data.get("url") or "").strip()
    if not url.lower().startswith(("http://", "https://")) or len(url) > 2000:
        return jsonify({"error": "Provide an http(s) URL."}), 400

    backend = (data.get("backend") or DEFAULT_BACKEND or "").lower()
    if backend not in AVAILABLE_BACKENDS:
        return jsonify({
            "error": f"Backend '{backend}' is not available on this server. "
                     f"Available: {', '.join(AVAILABLE_BACKENDS) or 'none'}"
        }), 400

    ip = _client_ip()
    allowed, retry_after, scope = _claim_job_slot(ip)
    if not allowed:
        return _rate_limited_response(retry_after, scope)

    workdir = tempfile.mkdtemp(prefix="deeprecall-")
    try:
        job_id, deduplicated = start_url_job(url, backend, workdir)
        # A URL seen before whose results are all still cached re-runs for
        # free (the pipeline skips the download and hits every cache), so it
        # should not count against the limit either.
        url_sha = hashlib.sha256(url.encode()).hexdigest()
        known_raw = cache.get(f"urlsha:url:{url_sha}:{backend}")
        known_sha = (
            known_raw.decode() if isinstance(known_raw, bytes) else known_raw
        ) if known_raw else None
        if deduplicated or (known_sha and _fully_cached(f"{known_sha}:{backend}")):
            _release_job_slot(ip)
        return jsonify({"job_id": job_id, "deduplicated": deduplicated}), 202
    except Exception as e:
        _release_job_slot(ip)
        shutil.rmtree(workdir, ignore_errors=True)
        print(f"❌ Error accepting URL: {e}")
        return jsonify({"error": f"Failed to accept URL: {e}"}), 500


@app.route('/resummarize', methods=['POST'])
def resummarize():
    """Regenerates the summary for an already-transcribed video. A single
    model call — much cheaper than an analysis — so it draws from its own,
    larger per-IP rate limit."""
    data = request.json or {}
    video_key = data.get("video_hash", "")
    if not video_key:
        return jsonify({"error": "video_hash is required."}), 400
    transcript_raw = cache.get(f"transcript:{video_key}")
    if not transcript_raw:
        return jsonify({"error": "Transcript expired. Re-process the video first."}), 404

    ip = _client_ip()
    allowed, retry_after, scope = _claim_job_slot(ip, "summary")
    if not allowed:
        return _rate_limited_response(retry_after, scope, "summary")
    try:
        transcript = json.loads(transcript_raw)
        short_summary, detailed_summary = summarize_text(transcript)
        summary = {"short": short_summary, "detailed": detailed_summary}
        cache.setex(f"summary:{video_key}", CACHE_TTL, json.dumps(summary))
        return jsonify({"summary": summary})
    except Exception as e:
        _release_job_slot(ip, "summary")
        print(f"❌ Error regenerating summary: {e}")
        return jsonify({"error": f"Failed to regenerate summary: {e}"}), 500


@app.route('/jobs/<job_id>')
def job_status(job_id):
    raw = cache.get(f"job:{job_id}")
    if not raw:
        return jsonify({"error": "Unknown or expired job."}), 404
    record = json.loads(raw)

    if record.get("status") in ("queued", "running"):
        with _jobs_lock:
            alive = job_id in _running_jobs
        if not alive:
            record.update(
                status="error",
                stage="error",
                error="processing interrupted by a server restart; "
                      "re-submit, completed stages are cached",
            )
            cache.setex(f"job:{job_id}", JOB_TTL, json.dumps(record))
    return jsonify(record)


@app.route('/cache/<sha256>')
def cache_lookup(sha256):
    sha256 = sha256.lower()
    if not SHA256_RE.match(sha256):
        return jsonify({"error": "Not a SHA-256 hash."}), 400
    backend = (request.args.get("backend") or DEFAULT_BACKEND or "").lower()
    video_key = f"{sha256}:{backend}"

    transcript_raw = cache.get(f"transcript:{video_key}")
    summary_raw = cache.get(f"summary:{video_key}")
    indexed = cache.exists(f"search:{video_key}") and cache.exists(f"searchvec:{video_key}")
    if transcript_raw and summary_raw and indexed:
        return jsonify({
            "cached": True,
            "video_hash": video_key,
            "transcript": json.loads(transcript_raw),
            "summary": json.loads(summary_raw),
        })

    job_raw = cache.get(f"jobfor:{video_key}")
    job_id = job_raw.decode() if isinstance(job_raw, bytes) else job_raw
    return jsonify({"cached": False, "job_id": job_id or None}), 404


@app.route('/search', methods=['POST'])
def search():
    """Handles search queries against the server-side embedding cache."""
    try:
        data = request.json
        print(f"📨 Incoming search request: {data.get('query')}")

        query = data.get("query", "")
        video_key = data.get("video_hash", "")

        if not query:
            return jsonify({"error": "Query is required"}), 400
        if not video_key:
            return jsonify({"error": "video_hash is required. Process a video first."}), 400

        try:
            k = int(data.get("k", 5))
        except (TypeError, ValueError):
            k = 5
        k = max(1, min(20, k))

        loaded = _load_index(video_key)
        if loaded is None:
            return jsonify({"error": "Search index expired. Please re-process the video."}), 404
        meta, vectors = loaded

        scores = search_query(query, meta, vectors)
        # Indexes cached before windowing carry no timestamps.
        starts = meta.get("starts")
        ends = meta.get("ends")
        order = np.argsort(scores)[::-1][:k]
        results = [
            {
                "text": meta["sentences"][i],
                "start": starts[i] if starts else None,
                "end": ends[i] if ends else None,
                "score": float(scores[i]),
            }
            for i in (int(x) for x in order)
        ]
        return jsonify({"results": results})
    except Exception as e:
        print(f"❌ Error handling search: {e}")
        return jsonify({"error": "Search failed."}), 500


@app.route("/health")
def health():
    redis_ok = False
    if CACHE_MODE == "redis":
        try:
            redis_ok = bool(cache.ping())
        except Exception:
            redis_ok = False
    return jsonify({
        "ok": bool(AVAILABLE_BACKENDS),
        "cache": CACHE_MODE,
        "redis": redis_ok,
        "default_backend": DEFAULT_BACKEND,
        "available_backends": list(AVAILABLE_BACKENDS),
    })


@app.route("/")
def hello_world():
    return f"<h1>DeepRecall API. Transcription backend: {DEFAULT_BACKEND}</h1>"


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
