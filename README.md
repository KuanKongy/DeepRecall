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
| `APP_PASSWORD` | Optional shared password (clients send `X-App-Password`) |
| `CORS_ORIGINS` | Comma-separated origin allowlist |

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
The hosted UI can also target a Mac backend: set the server URL to
`http://localhost:10000` in the UI settings.
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
- **Frontend**: `cd frontend && npm run deploy` publishes to GitHub Pages.
  `frontend/.env.production` holds the Railway domain.

## Local Docker

`docker compose up --build` runs the API plus a local Redis
(`compose.yaml` + `redis-docker-compose.yaml`).
