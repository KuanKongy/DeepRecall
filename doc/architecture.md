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
hidden when only one backend exists. The API base URL is baked in at build
time (`VITE_API_URL`) — it's a public value, not a secret.

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

### Playback of URL sources

The server never stores media, so the player points the `<video>` element at
the original URL. Many file hosts (GitHub Releases included) serve videos as
`application/octet-stream` with `nosniff` and `Content-Disposition:
attachment`, which browsers refuse to play inline — the element stalls or
errors while transcription (done server-side) works fine. `GET
/media/by-url?url=…` fixes this: a storage-free streaming proxy that re-emits
the bytes with a real video content-type, `inline` disposition, and Range
passthrough so seeking works. It reuses the download path's SSRF guard, only
serves URLs whose `urlsha` cache entry proves they were processed here (so it
is not an open proxy, and access expires with the 24 h cache), and caps
concurrent streams (`MEDIA_PROXY_STREAMS`, default 3) because each stream
pins one gunicorn thread. The frontend tries the original URL first and
switches to the proxy on a media error or when no data has arrived shortly
after mount (some hosts stall forever without firing an error); if the proxy
also fails it shows a "can't be played in the browser" note in the player
slot. yt-dlp-fetched sources (Drive etc.) are audio-only server-side and land
on that note by design; YouTube keeps the iframe player.

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

## Measured performance

One full run per backend on the same test video, CS50x 2024 Lecture 1 - C
(youtube.com/watch?v=cwtpLIWylAw, 2:27:41 = 8861 s), measured 2026-09-09 on
an Apple M1 Pro (16 GB, macOS 26.5) running `python app.py`. Per-stage
seconds come from the job record's `timings` field, which `run_pipeline`
fills in as each stage completes. Downloading is the audio-only yt-dlp fetch
and extracting is the ffmpeg transcode to 16 kHz mono mp3; both are roughly
constant across backends, so the spread is almost entirely transcription.

- **api** (OpenRouter `whisper-large-v3`, 10-minute chunks, 6 workers,
  Upstash Redis over TLS): download 60 s, extract 22 s, transcribe 43 s
  (208x realtime), summarize 8 s, index 2 s. Total 2 m 15 s, 66x realtime
  end to end.
- **mlx** (`whisper-large-v3-turbo` on the M1 Pro GPU, one unchunked call
  that includes loading the model): download 22 s, extract 22 s, transcribe
  7 m 38 s (19x realtime), summarize 9 s, index 1 s. Total 8 m 32 s.
- **local** (faster-whisper `base` int8 on CPU): download 20 s, extract
  23 s, transcribe 5 m 58 s (25x realtime), summarize 8 s, index 2 s.
  Total 6 m 49 s.

Re-submitting the same URL and backend right after takes 2.6 s end to end:
the `urlsha` pointer plus the fully-cached check skip the download and every
stage resolves to a cache hit, so the remaining time is mostly Upstash round
trips.

These numbers compare speed, not accuracy. Each backend runs a different
Whisper model, which is why `local` beats `mlx` here: `base` is a far
smaller model than `large-v3-turbo` and pays for it in transcript quality.
Download time is network-dependent (20-60 s across these runs), and the
`api` figure depends on where OpenRouter routes the chunks that day.

## Caching

`make_cache()` returns a Redis client when `REDIS_URL` is set (TLS
`rediss://` URLs work natively), otherwise an in-process `MemoryCache`
exposing the same five methods (`get`, `setex`, `exists`, `delete`, `ping`)
with values coerced to bytes on write so callers see identical types either
way. Cache keys include the backend, so a local transcript never masks an
API one. Setting `REDIS_SUFFIX` appends `:suffix` to every key, letting a
test or staging run share the production Redis without reading or writing
its entries (the benchmark above ran against the live instance this way).
`GET /health` reports the cache mode and a live Redis ping.

## Abuse limits

The app is open — no accounts, no password. Spend is bounded instead:

- A per-IP rate limit — a burst window and a daily cap — on the endpoints
  that cost model money, with two separate buckets: analyses (defaults 6/hour
  and 12/day, `RATE_LIMIT_JOBS_PER_HOUR` / `RATE_LIMIT_JOBS_PER_DAY`) cover
  `/process_video` and `/process_url`, while `/resummarize` draws from its own
  2x-larger allowance (defaults 12/hour and 24/day,
  `RATE_LIMIT_SUMMARIES_PER_HOUR` / `RATE_LIMIT_SUMMARIES_PER_DAY`) — a
  regeneration is a single gpt-4.1-nano call, ~30x cheaper than a
  transcription-dominated analysis, so analyses remain ~95% of worst-case
  spend. Only requests that actually spend model money consume a slot:
  attaching to an already-running job or re-processing a video whose
  transcript, summary and search index are all still cached releases the
  slot. A 429 carries `retry_after` seconds and a Retry-After header, and
  the UI tells the user how long to wait; searches and polling are
  unlimited. In-memory, which is correct under the single-worker
  deployment; the client IP comes from `X-Forwarded-For` behind the
  platform proxy.
- Videos longer than `MAX_DURATION_SECONDS` (default 3 h) are rejected after
  audio extraction, and yt-dlp filters them out before downloading.
- `MAX_CONTENT_LENGTH` (default 2 GB) turns oversized uploads into a 413
  instead of filling the disk; `CORS_ORIGINS` is a comma-separated browser
  origin allowlist.
- The final backstop is provider-side: OpenRouter is prepaid (spend stops at
  the credit balance) and OpenAI supports a monthly budget cap.

## Deployment

The Docker image is `python:3.12-slim` + ffmpeg, served by gunicorn with
**one worker** and 8 gthread threads — single-worker is deliberate: the job
registry, the memory cache and the index LRU live in process memory.
`railway.toml` points the platform healthcheck at `/health`. The frontend
reads the API base URL from `VITE_API_URL`
(`.env.production` / `.env.development`), and `scripts/dev-mac.sh` runs the
whole backend on a Mac GPU with the memory cache and no external services.
