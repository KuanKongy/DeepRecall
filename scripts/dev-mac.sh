#!/usr/bin/env bash
# Run the DeepRecall backend on this Mac's GPU (MLX), no Redis needed.
# First mlx run downloads ~1.6 GB of Whisper weights to ~/.cache/huggingface.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d .venv ]; then
  python3.12 -m venv .venv 2>/dev/null || python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r requirements.txt -r requirements-mac.txt

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_API_KEY is not set (export it or put it in .env)" >&2
  exit 1
fi

# Memory cache + MLX GPU transcription; the UI at http://localhost:8080
# (npm run dev) or the hosted page pointed at http://localhost:10000.
REDIS_URL= TRANSCRIBE_BACKEND=mlx exec python app.py
