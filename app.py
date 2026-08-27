from flask import Flask, request, jsonify
from flask_cors import CORS
import openai
import os
import re
import sys
import glob
import hmac
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
import tempfile
import threading
import numpy as np
from collections import Counter, OrderedDict
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
GROQ_WHISPER_MODEL = os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")
MLX_WHISPER_MODEL = os.getenv("MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
GROQ_CHUNK_SECONDS = int(os.getenv("CHUNK_SECONDS", "600"))
GROQ_MAX_WORKERS = 6      # stays under Groq free-tier rate limits
# "openai" re-runs a chunk on whisper-1 when Groq stays rate-limited.
TRANSCRIBE_FALLBACK = os.getenv("TRANSCRIBE_FALLBACK", "").lower()

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def detect_backends():
    """Discover which transcription backends can run here. Uses find_spec, not
    a real import: importing mlx_whisper would load the MLX runtime at boot."""
    backends = []
    if os.getenv("GROQ_API_KEY"):
        backends.append("groq")
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

_requested_backend = os.getenv("TRANSCRIBE_BACKEND", "groq").lower()
DEFAULT_BACKEND = (
    _requested_backend
    if _requested_backend in AVAILABLE_BACKENDS
    else (AVAILABLE_BACKENDS[0] if AVAILABLE_BACKENDS else None)
)

APP_PASSWORD = os.getenv("APP_PASSWORD", "")


@app.before_request
def require_password():
    """Shared-password gate; an unset APP_PASSWORD disables it (local dev)."""
    if not APP_PASSWORD or request.method == "OPTIONS" or request.path in ("/", "/health"):
        return None
    if not hmac.compare_digest(request.headers.get("X-App-Password", ""), APP_PASSWORD):
        return jsonify({"error": "Unauthorized"}), 401
    return None


# ---------------------------------------------------------------------------
# Job registry. One process (gunicorn --workers 1): the pool and the running
# set live in memory, job records live in the cache so the frontend can poll.
# ---------------------------------------------------------------------------

JOB_WORKERS = int(os.getenv("JOB_WORKERS", "2"))  # 2 jobs = 12 parallel Groq calls
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


def run_pipeline(job_id, video_key, backend, upload_path, workdir):
    """The whole pipeline off-request. Every stage checks its cache key first,
    so re-submitting after a crash resumes from the last completed stage."""
    try:
        _update_job(job_id, status="running", stage="extracting", message="Extracting audio")

        transcript_raw = cache.get(f"transcript:{video_key}")
        if transcript_raw:
            transcript = json.loads(transcript_raw)
        else:
            audio_path = extract_audio(upload_path, workdir)
            if upload_path != audio_path and os.path.exists(upload_path):
                os.remove(upload_path)  # a raw video can be ~1 GB; free it now

            _update_job(job_id, stage="transcribing", message="Transcribing")

            def progress(current, total):
                _update_job(job_id, progress={"current": current, "total": total})

            transcript = transcribe_audio(audio_path, backend, workdir, progress)
            if not transcript:
                raise RuntimeError("Transcription produced no segments.")
            cache.setex(f"transcript:{video_key}", CACHE_TTL, json.dumps(transcript))

        _update_job(job_id, stage="summarizing", progress=None, message="Summarizing")
        if not cache.get(f"summary:{video_key}"):
            text_content = " ".join(seg["text"] for seg in transcript)
            short_summary, detailed_summary = summarize_text(text_content)
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
        cache.delete(f"jobfor:{video_key}")
        with _jobs_lock:
            _running_jobs.discard(job_id)


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


def get_groq_client():
    key = os.getenv("GROQ_API_KEY")
    if not key:
        raise RuntimeError(
            "GROQ_API_KEY is not set. Add it to your environment, "
            "or use the 'local'/'mlx' backend instead."
        )
    return openai.OpenAI(api_key=key, base_url="https://api.groq.com/openai/v1")


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
    hour of audio stays under Groq's 25MB upload limit."""
    audio_path = os.path.join(workdir, "audio.mp3")
    (
        ffmpeg.input(media_path)
        .output(audio_path, vn=None, ac=1, ar=16000, audio_bitrate="32k")
        .run(overwrite_output=True, capture_stdout=True, capture_stderr=True)
    )
    return audio_path


def split_audio(audio_path, workdir, segment_seconds=GROQ_CHUNK_SECONDS):
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


def _transcribe_chunk_groq(client, path, chunk_duration):
    try:
        result = _with_retries(lambda: _transcribe_file_api(client, GROQ_WHISPER_MODEL, path))
    except openai.RateLimitError:
        if TRANSCRIBE_FALLBACK != "openai":
            raise
        result = _with_retries(lambda: _transcribe_file_api(openai_client, "whisper-1", path))
    if result.segments:
        return [
            {"start": seg.start, "end": seg.end, "text": seg.text}
            for seg in result.segments
        ]
    end = chunk_duration if chunk_duration else float(GROQ_CHUNK_SECONDS)
    return [{"start": 0.0, "end": end, "text": result.text}]


def _transcribe_groq(audio_path, workdir, progress=None):
    """Chunk the audio and transcribe all chunks in parallel on Groq."""
    client = get_groq_client()

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
    with ThreadPoolExecutor(max_workers=GROQ_MAX_WORKERS) as pool:
        futures = {
            pool.submit(_transcribe_chunk_groq, client, path, duration): index
            for index, path, duration in chunks
        }
        # Keyed by chunk index so ordering survives as_completed.
        for future in as_completed(futures):
            index = futures[future]
            results[index] = _segments_to_transcript(
                future.result(), index * GROQ_CHUNK_SECONDS
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
            "(Apple Silicon only), or use the 'groq' or 'local' backend."
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
    if backend == "groq":
        return _transcribe_groq(audio_path, workdir, progress)
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


def summarize_text(text):
    """Generates a short and a detailed summary, running API calls in parallel.
    gpt-4.1-nano's 1M-token context takes any real lecture in a single pass."""
    n_tokens = len(tiktoken.get_encoding("cl100k_base").encode(text))
    if n_tokens > 800000:
        raise RuntimeError(f"Transcript too long to summarize ({n_tokens} tokens).")

    with ThreadPoolExecutor(max_workers=2) as pool:
        detailed_future = pool.submit(
            _chat,
            "Create a structured, detailed summary of the following lecture transcript. "
            "Ensure it includes all key points, organized in sections. Use bullet points where necessary.",
            text,
        )
        short_future = pool.submit(
            _chat,
            "Provide a very brief high-level summary of the following lecture in under 300 words.",
            text,
        )
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


def extract_highlights(transcript, keywords):
    """Extracts highlighted sections based on keywords."""
    return [seg for seg in transcript if any(keyword.lower() in seg['text'].lower() for keyword in keywords)]


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
        return jsonify({
            "job_id": job_id,
            "video_hash": video_key,
            "deduplicated": deduplicated,
        }), 202
    except Exception as e:
        shutil.rmtree(workdir, ignore_errors=True)
        print(f"❌ Error accepting upload: {e}")
        return jsonify({"error": f"Failed to accept upload: {e}"}), 500


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

        loaded = _load_index(video_key)
        if loaded is None:
            return jsonify({"error": "Search index expired. Please re-process the video."}), 404
        meta, vectors = loaded

        scores = search_query(query, meta, vectors)
        best = int(np.argmax(scores))
        return jsonify({"result": meta["sentences"][best]})
    except Exception as e:
        print(f"❌ Error handling search: {e}")
        return jsonify({"error": "Search failed."}), 500


@app.route('/highlights', methods=['POST'])
def highlights():
    """Extracts highlighted segments based on keywords."""
    try:
        data = request.json
        transcript = data.get("transcript", [])
        keywords = data.get("keywords", [])
        highlights = extract_highlights(transcript, keywords)
        return jsonify({"highlights": highlights})
    except Exception as e:
        print(f"Error extracting highlights: {e}")
        return jsonify({"error": "Failed to extract highlights."}), 500


@app.route('/common', methods=['POST'])
def common():
    """Extracts common keywords"""
    try:
        data = request.json
        transcript = data.get("transcript", [])
        words = " ".join(seg['text'] for seg in transcript).lower().split()
        common_words = Counter(words).most_common(5)
        return jsonify({"Common keywords": common_words})
    except Exception as e:
        print(f"Error extracting commons: {e}")
        return jsonify({"error": "Failed to extract commons."}), 500


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
    return f"<h1>DeepRecall API — transcription backend: {DEFAULT_BACKEND}</h1>"


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
