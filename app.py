from flask import Flask, request, jsonify
from flask_cors import CORS
import openai
import os
import glob
import ffmpeg
import redis
import hashlib
import tiktoken
import json
import tempfile
import numpy as np
from collections import Counter
from concurrent.futures import ThreadPoolExecutor


app = Flask(__name__)
CORS(app)


redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
redis_client = redis.from_url(redis_url)

CACHE_TTL = 86400


# Load OpenAI API key
openai.api_key = os.getenv("OPENAI_API_KEY")
if not openai.api_key:
    raise ValueError("Missing OpenAI API key! Set OPENAI_API_KEY in your environment.")

openai_client = openai.OpenAI(api_key=openai.api_key)

SUMMARY_MODEL = "gpt-4o-mini"
EMBEDDING_MODEL = "text-embedding-3-small"
GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"
GROQ_CHUNK_SECONDS = 600  # 10-minute chunks transcribed in parallel
GROQ_MAX_WORKERS = 6      # stays under Groq free-tier rate limits

# Transcription backend: "groq" (API, fastest), "mlx" (Apple Silicon GPU),
# "local" (faster-whisper on CPU). Overridable per request via the "backend"
# form field on /process_video.
DEFAULT_BACKEND = os.getenv("TRANSCRIBE_BACKEND", "groq").lower()
VALID_BACKENDS = ("groq", "mlx", "local")


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


def extract_audio(video_path, workdir):
    """Extract 16kHz mono 32kbps MP3 — all Whisper variants only use 16kHz mono,
    and an hour of audio stays under Groq's 25MB upload limit."""
    audio_path = os.path.join(workdir, "audio.mp3")
    (
        ffmpeg.input(video_path)
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


def _segments_to_transcript(segments, offset=0.0):
    return [
        {"start": seg["start"] + offset, "end": seg["end"] + offset, "text": seg["text"]}
        for seg in segments
    ]


def _transcribe_groq(audio_path, workdir):
    """Chunk the audio and transcribe all chunks in parallel on Groq."""
    client = get_groq_client()
    chunk_paths = split_audio(audio_path, workdir)

    def transcribe_chunk(index_and_path):
        index, path = index_and_path
        with open(path, "rb") as f:
            result = client.audio.transcriptions.create(
                model=GROQ_WHISPER_MODEL,
                file=f,
                response_format="verbose_json",
            )
        offset = index * GROQ_CHUNK_SECONDS
        if result.segments:
            segments = [
                {"start": seg.start, "end": seg.end, "text": seg.text}
                for seg in result.segments
            ]
        else:
            segments = [{"start": 0.0, "end": float(GROQ_CHUNK_SECONDS), "text": result.text}]
        return _segments_to_transcript(segments, offset)

    with ThreadPoolExecutor(max_workers=GROQ_MAX_WORKERS) as pool:
        chunk_transcripts = list(pool.map(transcribe_chunk, enumerate(chunk_paths)))

    return [seg for chunk in chunk_transcripts for seg in chunk]


def _transcribe_mlx(audio_path):
    """Local transcription on Apple Silicon's GPU via MLX (pip install mlx-whisper)."""
    try:
        import mlx_whisper
    except ImportError:
        raise RuntimeError(
            "mlx-whisper is not installed. Run: pip install -r requirements-mac.txt "
            "(Apple Silicon only), or use the 'groq' or 'local' backend."
        )
    result = mlx_whisper.transcribe(
        audio_path, path_or_hf_repo="mlx-community/whisper-large-v3-turbo"
    )
    return _segments_to_transcript(result["segments"])


_faster_whisper_model = None


def _transcribe_local(audio_path):
    """Portable CPU transcription via faster-whisper (CTranslate2, int8)."""
    global _faster_whisper_model
    from faster_whisper import WhisperModel

    if _faster_whisper_model is None:
        _faster_whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _info = _faster_whisper_model.transcribe(audio_path)
    return [{"start": seg.start, "end": seg.end, "text": seg.text} for seg in segments]


def transcribe_audio_with_timestamps(video_path, backend, workdir):
    """Extracts audio from video and transcribes it with the selected backend."""
    audio_path = extract_audio(video_path, workdir)
    if backend == "groq":
        return _transcribe_groq(audio_path, workdir)
    if backend == "mlx":
        return _transcribe_mlx(audio_path)
    return _transcribe_local(audio_path)


def split_text_by_sentences(text, max_tokens=50000):
    """Splits text into token-bounded chunks, breaking at sentence boundaries."""
    enc = tiktoken.get_encoding("cl100k_base")
    sentences = text.split(". ")
    chunks = []
    current_chunk = []
    current_tokens = 0

    for sentence in sentences:
        sentence_tokens = len(enc.encode(sentence))
        if current_tokens + sentence_tokens > max_tokens:
            chunks.append(" ".join(current_chunk))
            current_chunk = []
            current_tokens = 0
        current_chunk.append(sentence)
        current_tokens += sentence_tokens

    if current_chunk:
        chunks.append(" ".join(current_chunk))

    return chunks


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
    """Generates a short and a detailed summary, running API calls in parallel."""
    enc = tiktoken.get_encoding("cl100k_base")

    # gpt-4o-mini fits ~128k tokens, so a normal lecture goes through in one pass;
    # only map-reduce transcripts that genuinely exceed the context window.
    if len(enc.encode(text)) > 100000:
        chunks = split_text_by_sentences(text, max_tokens=50000)
        with ThreadPoolExecutor(max_workers=4) as pool:
            chunk_summaries = list(
                pool.map(
                    lambda chunk: _chat(
                        "Summarize the following lecture transcript while preserving key details.",
                        chunk,
                    ),
                    chunks,
                )
            )
        source = " ".join(chunk_summaries)
    else:
        source = text

    with ThreadPoolExecutor(max_workers=2) as pool:
        detailed_future = pool.submit(
            _chat,
            "Create a structured, detailed summary of the following lecture transcript. "
            "Ensure it includes all key points, organized in sections. Use bullet points where necessary.",
            source,
        )
        short_future = pool.submit(
            _chat,
            "Provide a very brief high-level summary of the following lecture in under 300 words.",
            source,
        )
        try:
            detailed_summary = detailed_future.result()
        except Exception as e:
            print(f"Error generating detailed summary: {e}")
            detailed_summary = "Detailed summary unavailable."
        try:
            short_summary = short_future.result()
        except Exception as e:
            print(f"Error generating short summary: {e}")
            short_summary = "Short summary unavailable."

    return short_summary, detailed_summary


def create_search_index(transcript, cache_key):
    """Embeds transcript sentences via the OpenAI API and caches them in Redis."""
    sentences = [seg["text"] for seg in transcript if seg["text"].strip()]
    if not sentences:
        print("⚠️ No sentences found for embedding generation.")
        return False

    embeddings = []
    for i in range(0, len(sentences), 2048):
        response = openai_client.embeddings.create(
            model=EMBEDDING_MODEL, input=sentences[i:i + 2048]
        )
        embeddings.extend(item.embedding for item in response.data)

    vectors = np.array(embeddings, dtype=np.float32)
    redis_client.setex(
        f"search:{cache_key}",
        CACHE_TTL,
        json.dumps({"sentences": sentences, "dim": vectors.shape[1]}),
    )
    redis_client.setex(f"searchvec:{cache_key}", CACHE_TTL, vectors.tobytes())
    print(f"✅ Generated {len(sentences)} embeddings.")
    return True


def search_query(query, sentences, vectors):
    """Finds the most relevant transcript sentence for a query via cosine similarity."""
    response = openai_client.embeddings.create(model=EMBEDDING_MODEL, input=[query])
    query_vector = np.array(response.data[0].embedding, dtype=np.float32)

    scores = vectors @ query_vector / (
        np.linalg.norm(vectors, axis=1) * np.linalg.norm(query_vector) + 1e-8
    )
    return sentences[int(np.argmax(scores))]


def extract_highlights(transcript, keywords):
    """Extracts highlighted sections based on keywords."""
    return [seg for seg in transcript if any(keyword.lower() in seg['text'].lower() for keyword in keywords)]


@app.route('/process_video', methods=['POST'])
def process_video():
    """Handles video file upload, transcription with timestamps, and summarization."""
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded."}), 400

    backend = (request.form.get("backend") or DEFAULT_BACKEND).lower()
    if backend not in VALID_BACKENDS:
        return jsonify({"error": f"Unknown backend '{backend}'. Valid: {', '.join(VALID_BACKENDS)}"}), 400

    try:
        with tempfile.TemporaryDirectory() as workdir:
            video_path = os.path.join(workdir, "upload.mp4")
            request.files['file'].save(video_path)
            print(f"✅ Video uploaded successfully. Backend: {backend}")

            # Cache keys include the backend so a local transcript never masks an API one
            video_key = f"{get_video_hash(video_path)}:{backend}"

            cached_transcript = redis_client.get(f"transcript:{video_key}")
            if cached_transcript:
                print("✅ Using cached transcription from Redis.")
                transcript = json.loads(cached_transcript)
            else:
                transcript = transcribe_audio_with_timestamps(video_path, backend, workdir)
                if not transcript:
                    return jsonify({"error": "Failed to transcribe video."}), 500
                redis_client.setex(f"transcript:{video_key}", CACHE_TTL, json.dumps(transcript))

        text_content = " ".join(seg['text'] for seg in transcript)

        cached_summary = redis_client.get(f"summary:{video_key}")
        if cached_summary:
            print("✅ Using cached summary from Redis.")
            summary = json.loads(cached_summary)
        else:
            short_summary, detailed_summary = summarize_text(text_content)
            summary = {"short": short_summary, "detailed": detailed_summary}
            redis_client.setex(f"summary:{video_key}", CACHE_TTL, json.dumps(summary))

        if not redis_client.exists(f"searchvec:{video_key}"):
            if not create_search_index(transcript, video_key):
                return jsonify({"error": "Failed to generate embeddings."}), 500

        return jsonify({
            "transcript": transcript,
            "summary": summary,
            "video_hash": video_key,
        })
    except Exception as e:
        print(f"❌ Error processing video: {e}")
        return jsonify({"error": f"Failed to process video: {e}"}), 500


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

        meta = redis_client.get(f"search:{video_key}")
        vector_bytes = redis_client.get(f"searchvec:{video_key}")
        if not meta or not vector_bytes:
            return jsonify({"error": "Search index expired. Please re-process the video."}), 404

        meta = json.loads(meta)
        vectors = np.frombuffer(vector_bytes, dtype=np.float32).reshape(-1, meta["dim"])

        result = search_query(query, meta["sentences"], vectors)
        return jsonify({"result": result})
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


@app.route("/")
def hello_world():
    return f"<h1>DeepRecall API — transcription backend: {DEFAULT_BACKEND}</h1>"


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
