# DeepRecall

DeepRecall turns lecture videos into searchable knowledge. Upload a video
(MP4/MOV/WebM/MKV) or paste a YouTube, Google Drive, or direct file link and it
transcribes the audio, writes a short and a detailed summary with clickable
key moments, and builds a semantic search index over the transcript — cached
by the video's SHA-256 so a video is only ever processed once. The UI is
phone-friendly, syncs the transcript with playback, and exports .txt/.srt.

The server is a thin orchestrator: transcription runs on OpenRouter
(`whisper-large-v3`, routed across Groq/DeepInfra/Together), or locally via
MLX (Apple Silicon GPU) or faster-whisper (CPU); summaries and embeddings use the OpenAI API; the cache is
Redis (Upstash in production) with an in-process fallback for local dev.

## Architecture

- `app.py` — Flask API served by gunicorn (Docker, deployed on Railway)
- `frontend/` — React/Vite UI, deployed to GitHub Pages from the `gh-pages` branch
- Cache — Upstash Redis via `REDIS_URL`; without it, an in-memory cache

## Configuration

Copy `.env.sample` to `.env` and fill in:

| Variable | Meaning |
|---|---|
| `OPENAI_API_KEY` | Required — summaries and embeddings |
| `TRANSCRIBE_API_KEY` | OpenRouter key — enables the hosted `api` backend |
| `TRANSCRIBE_BACKEND` | `api` (default), `mlx`, or `local` |
| `TRANSCRIBE_BASE_URL` / `TRANSCRIBE_MODEL` | Optional: any OpenAI-compatible transcription endpoint |
| `SUMMARY_MODEL` | Chat model for summaries (default `gpt-4.1-nano`) |
| `REDIS_URL` | Optional; `rediss://…` from Upstash. Unset = memory cache |
| `REDIS_SUFFIX` | Optional; appended to every cache key so test runs can share the production Redis |
| `TRANSCRIBE_MAX_WORKERS` | Parallel chunk uploads per job on the `api` backend (default 6) |
| `MLX_VAD_GAP_SECONDS` | `mlx` backend cuts clips only inside silences at least this long (default 5) |
| `LOCAL_CPU_THREADS` | CPU threads for the `local` backend (default 0 = CTranslate2 default) |
| `RATE_LIMIT_JOBS_PER_HOUR` / `RATE_LIMIT_JOBS_PER_DAY` | Per-IP analyses (defaults 10/hour, 20/day; 0 disables) |
| `MAX_DURATION_SECONDS` | Longest accepted video (default 10800 = 3 h) |
| `CORS_ORIGINS` | Comma-separated origin allowlist (include the custom Pages domain) |

`GET /health` reports the active cache and which backends are available.

## Run locally (hosted API backend)

```sh
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
TRANSCRIBE_BACKEND=api python app.py        # http://127.0.0.1:10000
cd frontend && npm install && npm run dev    # http://localhost:8080
```

No `REDIS_URL` needed — results cache in process.

## Run on your Mac with the GPU (MLX)

```sh
pip install -r requirements.txt -r requirements-mac.txt   # Apple Silicon only
TRANSCRIBE_BACKEND=mlx python app.py
```

The first run downloads ~1.6 GB of Whisper weights to `~/.cache/huggingface`.
Use the local UI against it: `cd frontend && npm run dev`.
The quickest Mac GPU setup is the helper script, which creates `.venv`,
installs both requirements files, loads `.env`, and starts the backend in MLX
mode with the in-memory cache:

```sh
./scripts/dev-mac.sh
```

## Deploy

- **API**: Railway builds the root `Dockerfile` on push (`railway.toml` sets the
  `/health` healthcheck). Set the variables above in the Railway service, plus
  `REDIS_URL` from an Upstash Redis database in the same region.
- **Frontend**: pushed changes under `frontend/` deploy to GitHub Pages
  automatically via GitHub Actions (`.github/workflows/deploy-pages.yml`).
  The API URL comes from `frontend/.env.production`, or from a repo Actions
  variable `VITE_API_URL` if set.

## Local Docker (everything in one command)

```sh
docker compose up --build
```

Starts the whole stack: the UI at http://localhost:8080, the API at
http://localhost:10000, and a Redis cache. Only `OPENAI_API_KEY` and
`TRANSCRIBE_API_KEY` need to be set in `.env`.
