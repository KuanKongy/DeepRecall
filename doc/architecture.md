# DeepRecall architecture

DeepRecall turns a lecture video into a transcript, two summaries and a
semantic search index. The server is an IO-bound orchestrator: the models run
on hosted APIs (or the local GPU), and everything is cached by the video's
SHA-256 so a video is only ever processed once.

## Client-side pipeline

The browser does the heavy lifting before a byte is uploaded:

1. **Hashing** — on file select the UI streams the file through `hash-wasm`
   SHA-256 in 8 MB slices (constant memory, byte-identical to the server's
   `hashlib.sha256`, so client and server agree on cache keys).
2. **Cache check** — `GET /cache/<sha256>?backend=…`. On a hit the results
   render with no upload at all; if the same video is already being processed
   the UI attaches to that running job instead.
3. **Audio extraction** — ffmpeg.wasm (single-thread core, so it works on
   GitHub Pages without COOP/COEP) demuxes the audio track with `-c:a copy`
   — no re-encode, seconds not minutes. The input `File` is mounted via
   WORKERFS, so a 1 GB video is never copied into wasm memory. A ~1-hour
   lecture uploads as a ~40 MB `.m4a` instead of 300 MB–1 GB. If the wasm
   fails to load or the demux fails, the raw video is uploaded instead (with
   a warning above ~300 MB, since the platform closes slow request bodies).
4. **Upload + polling** — the upload carries the original video's SHA-256 as
   the cache key. The server answers `202` immediately; the UI polls the job
   every 2 s and shows staged progress: hashing → extracting → uploading →
   transcribing k/n → summarizing → indexing.

The backend dropdown is built from `GET /health` (`available_backends`) and
hidden when only one backend exists. A settings popover stores a server URL
and password in `localStorage`, applied per request through an axios
interceptor — the hosted page can target a backend on your own machine at
`http://localhost:10000` (localhost is exempt from mixed-content blocking in
Chrome/Firefox).

## Processing from a URL

`POST /process_url` accepts a YouTube, Google Drive, or direct file link and
queues the same pipeline with an extra first stage, `downloading` (byte
progress). URLs a yt-dlp extractor recognises (YouTube, Drive, and many other
sites) are fetched audio-only via yt-dlp; anything else is stream-downloaded
directly with a size cap and an SSRF guard (http(s) only, and the host must
not resolve to a private address — redirects re-checked). The downloaded
file's SHA-256 becomes the cache key, so a URL-processed video and the same
file uploaded share one cache entry, and a `urlsha` mapping lets a re-submitted
URL whose results are still cached skip the download entirely. YouTube jobs
carry the video id so the UI can embed the official player (with seeking via
the IFrame API); note YouTube may bot-block datacenter IPs, so that path is
best-effort in production and reliable in local mode. The UI's "Try a demo"
button feeds a sample lecture hosted as a GitHub Release asset through this
same path.

## Server-side job pipeline

`POST /process_video` validates the request, saves the upload to a
per-request temp dir, and queues the pipeline on a small thread pool
(`JOB_WORKERS`, default 2 — two jobs ≈ 12 parallel transcription calls).
Job records are JSON in the cache with a 1 h TTL; `GET /jobs/<id>` returns
them.

- **Dedupe** — a lookup key maps video → running job, so a second upload of
  the same video attaches to the running job and its temp dir is discarded.
- **Resume** — every stage checks its cache key first (transcript, summary,
  index), so re-submitting after a crash resumes from the last completed
  stage.
- **Restart detection** — if a record says queued/running but the in-process
  registry doesn't know the id, the worker restarted; the job is marked
  failed with a message telling the client to re-submit (completed stages
  are cached).
- The uploaded video is deleted right after audio extraction (frees up to
  ~1 GB of disk per job), and stale temp dirs are swept at boot.

## Transcription backends

Selected by `TRANSCRIBE_BACKEND` or a per-request `backend` field; discovered
at boot with `importlib.util.find_spec` (no import — importing mlx_whisper
would load the MLX runtime):

- **api** — any OpenAI-compatible hosted endpoint; by default OpenRouter's
  `openai/whisper-large-v3`, which load-balances across Groq, DeepInfra and
  Together (`TRANSCRIBE_BASE_URL` / `TRANSCRIBE_MODEL` override it). Audio is
  transcoded to 16 kHz mono 32 kbps MP3 (~14 MB/hour, under the 25 MB/file
  limit), split into 10-minute chunks (stream copy) and transcribed with 6
  workers in parallel. Chunks under ~1 s are dropped (the API rejects audio
  shorter than 0.1 s) and results are keyed by chunk index so ordering
  survives out-of-order completion. Calls retry with exponential backoff on
  429/5xx; with `TRANSCRIBE_FALLBACK=openai`, a chunk that stays
  rate-limited (or fails auth) is re-run on OpenAI `whisper-1`.
- **mlx** — `mlx-whisper` on the Apple Silicon GPU (darwin/arm64 only).
- **local** — `faster-whisper` base int8 on CPU. Kept out of the server
  image (`requirements-local.txt`): ctranslate2 + onnxruntime add hundreds
  of MB, and a shared vCPU transcribes slower and dearer than the API.

## Summaries

`SUMMARY_MODEL` (default `gpt-4.1-nano`, 1 M context) writes a short and a
detailed summary in parallel, in a single pass — no map-reduce, just a hard
guard at ~800k tokens. The transcript is fed as `[mm:ss] text` lines and the
detailed prompt asks for Markdown with a closing `## Key moments` section
citing those timestamps. The UI renders both with react-markdown.

## Search index

Whisper segments are merged into ~30-second / ~60-word windows (single
segments are a few words and embed poorly), embedded with
`text-embedding-3-small` at `dimensions=512`, L2-normalised, and stored as a
float32 blob plus JSON metadata (`sentences`, `starts`, `ends`, `dim`). A
1-hour lecture is ~120 × 2 KB ≈ 240 KB — sized for a hosted Redis
free tier's per-request and monthly bandwidth limits. `POST /search`
embeds the query at the index's dimension, ranks by cosine similarity, and
returns the top k (clamped 1–20) hits with timestamps and scores. An
in-process LRU (~20 videos) keeps loaded vector arrays out of repeated
cache reads.

## Caching

`make_cache()` returns a Redis client when `REDIS_URL` is set (TLS
`rediss://` URLs work natively), otherwise an in-process `MemoryCache`
exposing the same five methods (`get`, `setex`, `exists`, `delete`, `ping`)
with values coerced to bytes on write so callers see identical types either
way. Cache keys include the backend, so a local transcript never masks an
API one. `GET /health` reports the cache mode and a live Redis ping.

## Security

- `APP_PASSWORD` gates every route except `/`, `/health` and CORS preflight;
  clients send it as `X-App-Password`, compared with `hmac.compare_digest`.
  Unset means no auth (local dev).
- `CORS_ORIGINS` is a comma-separated origin allowlist.
- `MAX_CONTENT_LENGTH` (default 2 GB) turns oversized uploads into a 413
  instead of filling the disk.

## Deployment

The Docker image is `python:3.12-slim` + ffmpeg, served by gunicorn with
**one worker** and 8 gthread threads — single-worker is deliberate: the job
registry, the memory cache and the index LRU live in process memory.
`railway.toml` points the platform healthcheck at `/health`. The frontend
reads the API base URL from `VITE_API_URL`
(`.env.production` / `.env.development`), and `scripts/dev-mac.sh` runs the
whole backend on a Mac GPU with the memory cache and no external services.
