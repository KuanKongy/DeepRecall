FROM python:3.10.2-slim as base

WORKDIR /app

COPY . .

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    python -m pip install --no-cache-dir -r requirements.txt && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

EXPOSE 10000

ENV PYTHONUNBUFFERED=1

CMD ["python", "app.py"]