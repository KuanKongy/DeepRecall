FROM python:3.10.2-slim as base

WORKDIR /app

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN python -m pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 10000

ENV PYTHONUNBUFFERED=1

CMD ["sh", "-c", "gunicorn -b 0.0.0.0:${PORT:-10000} --threads 8 --timeout 600 app:app"]
