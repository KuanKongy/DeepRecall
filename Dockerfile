FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN python -m pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 10000

ENV PYTHONUNBUFFERED=1

# --workers 1 is deliberate: the in-process job registry and MemoryCache assume
# a single process. Concurrency comes from gthread threads.
CMD ["sh", "-c", "gunicorn -b 0.0.0.0:${PORT:-10000} --workers 1 --worker-class gthread --threads 8 --timeout 600 --graceful-timeout 30 app:app"]
