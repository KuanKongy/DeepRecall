from flask import Flask, request, jsonify
from flask_cors import CORS
import whisper
import openai
import os
import re
import ffmpeg
import torch
import redis
import hashlib
import tiktoken
import json
import numpy as np
from flask_caching import Cache
from sentence_transformers import SentenceTransformer, util


app = Flask(__name__)
CORS(app)


# Redis Cache Configuration
# app.config['CACHE_TYPE'] = 'redis'
# app.config['CACHE_REDIS_HOST'] = 'localhost'
# app.config['CACHE_REDIS_PORT'] = 6379
# app.config['CACHE_REDIS_DB'] = 0
# app.config['CACHE_REDIS_URL'] = 'redis://localhost:6379/0'
# cache = Cache(app)
#redis_client = redis.Redis(host='localhost', port=6379, db=0)
redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
redis_client = redis.from_url(redis_url)
app.config['CACHE_TYPE'] = 'redis'
app.config['CACHE_REDIS_URL'] = redis_url
cache = Cache(app)


# Load OpenAI API key
openai.api_key = os.getenv("OPENAI_API_KEY")
if not openai.api_key:
    raise ValueError("Missing OpenAI API key! Set OPENAI_API_KEY in your environment.")


# Load Whisper model
try:
    model = whisper.load_model("base")
    print("Whisper model loaded successfully.")
except Exception as e:
    print(f"Error loading Whisper model: {e}")
    exit(1)


# Load Sentence Transformer for search
search_model = SentenceTransformer("all-MiniLM-L6-v2")


def get_video_hash(video_path):
    """Generate a SHA256 hash of the video file."""
    hasher = hashlib.sha256()
    with open(video_path, "rb") as f:
        while chunk := f.read(8192):
            hasher.update(chunk)
    return hasher.hexdigest()


def transcribe_audio_with_timestamps(video_path):
    """Extracts audio from video and transcribes it using Whisper with timestamps."""
    audio_path = "temp_audio.wav"
    try:
        ffmpeg.input(video_path).output(audio_path, format='wav').run(overwrite_output=True)
        result = model.transcribe(audio_path, word_timestamps=True)
        segments = result['segments']
        transcript = [{"start": seg['start'], "end": seg['end'], "text": seg['text']} for seg in segments]
        return transcript
    except Exception as e:
        print(f"Error in transcription: {e}")
        return []


def split_text_by_sentences(text, max_tokens=5000):
    """Splits text into chunks of ~5000 tokens, breaking at sentence boundaries."""
    enc = tiktoken.encoding_for_model("gpt-4")
    sentences = text.split(". ")  # Split by sentence
    chunks = []
    current_chunk = []
    current_tokens = 0

    for sentence in sentences:
        sentence_tokens = len(enc.encode(sentence))  # Count tokens in sentence
        if current_tokens + sentence_tokens > max_tokens:
            chunks.append(" ".join(current_chunk))  # Store current chunk
            current_chunk = []
            current_tokens = 0
        current_chunk.append(sentence)
        current_tokens += sentence_tokens

    if current_chunk:
        chunks.append(" ".join(current_chunk))  # Add last chunk

    return chunks


def summarize_text(text):
    """Generates both a short and detailed summary from text chunks."""
    client = openai.OpenAI(api_key=openai.api_key)

    # Step 1: Split into chunks (~5000 tokens each, at sentence boundaries)
    chunks = split_text_by_sentences(text, max_tokens=5000)
    chunk_summaries = []

    for chunk in chunks:
        try:
            response = client.chat.completions.create(
                model="gpt-4",
                messages=[
                    {"role": "system", "content": "Summarize the following lecture transcript while preserving key details."},
                    {"role": "user", "content": chunk}
                ]
            )
            summary = response.choices[0].message.content.strip()
            chunk_summaries.append(summary)
        except Exception as e:
            print(f"Error summarizing chunk: {e}")
            chunk_summaries.append("")

    combined_text = " ".join(chunk_summaries)

    # Step 2: Generate structured detailed summary
    try:
        detailed_response = client.chat.completions.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": 
                 "Create a structured, detailed summary of the following lecture transcript. "
                 "Ensure it includes all key points, organized in sections. Use bullet points where necessary."},
                {"role": "user", "content": combined_text}
            ]
        )
        detailed_summary = detailed_response.choices[0].message.content.strip()
    except Exception as e:
        print(f"Error generating detailed summary: {e}")
        detailed_summary = "Detailed summary unavailable."

    # Step 3: Generate short summary
    try:
        short_response = client.chat.completions.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": 
                 "Provide a very brief high-level summary of the following lecture in under 300 words."},
                {"role": "user", "content": combined_text}
            ]
        )
        short_summary = short_response.choices[0].message.content.strip()
    except Exception as e:
        print(f"Error generating short summary: {e}")
        short_summary = "Short summary unavailable."

    return short_summary, detailed_summary


def create_search_index(transcript):
    """Creates an embedding index for search queries."""
    sentences = [seg['text'] for seg in transcript]

    if not sentences:
        print("⚠️ No sentences found for embedding generation.")
        return [], None

    try:
        embeddings = search_model.encode(sentences, convert_to_tensor=True)
        print(f"✅ Generated {len(embeddings)} embeddings.")
        return sentences, embeddings
    except Exception as e:
        print(f"❌ Error generating embeddings: {e}")
        return sentences, None


def search_query(query, sentences, embeddings):
    """Finds relevant segments in transcript based on search query."""
    try:
        if embeddings.shape[0] == 0:
            return "No matching results found."

        query_embedding = search_model.encode(query, convert_to_tensor=True)

        device = "cuda" if torch.cuda.is_available() else "cpu"
        embeddings = embeddings.to(device)
        query_embedding = query_embedding.to(device)

        scores = util.pytorch_cos_sim(query_embedding, embeddings)[0]
        top_match = sentences[scores.argmax().item()]
        return top_match
    except Exception as e:
        print(f"Error in search: {e}")
        return "Search encountered an error."


def extract_highlights(transcript, keywords):
    """Extracts highlighted sections based on keywords."""
    return [seg for seg in transcript if any(keyword.lower() in seg['text'].lower() for keyword in keywords)]


@app.route('/process_video', methods=['POST'])
def process_video():
    """Handles video file upload, transcription with timestamps, and summarization."""
    try:
        file = request.files['file']
        video_path = "uploaded_video.mp4"
        file.save(video_path)
        print("✅ Video uploaded successfully.")

        # Generate a unique hash for the video
        video_hash = get_video_hash(video_path)
        
        # Check if transcription is cached
        cached_transcript = redis_client.get(f"transcript:{video_hash}")
        
        if cached_transcript:
            print("✅ Using cached transcription from Redis.")
            transcript = eval(cached_transcript.decode('utf-8'))
        else:
            transcript = transcribe_audio_with_timestamps(video_path)
            if not transcript:
                return jsonify({"error": "Failed to transcribe video."}), 500
            redis_client.setex(f"transcript:{video_hash}", 3600, str(transcript))

        text_content = " ".join([seg['text'] for seg in transcript])
        
        # Check if summary is cached
        cached_summary = redis_client.get(f"summary:{video_hash}")
        
        if cached_summary:
            print("✅ Using cached summary from Redis.")
            summary = eval(cached_summary.decode('utf-8'))
        else:
            short_summary, detailed_summary = summarize_text(text_content)
            summary = {"short": short_summary, "detailed": detailed_summary}
            redis_client.setex(f"summary:{video_hash}", 3600, str(summary))

        sentences, embeddings = create_search_index(transcript)

        if embeddings is None:
            print("❌ Failed to generate embeddings.")
            return jsonify({"error": "Failed to generate embeddings."}), 500

        return jsonify({
            "transcript": transcript,
            "summary": summary,
            "search_index": sentences,
            "embeddings": embeddings.tolist()
        })
    except Exception as e:
        print(f"❌ Error processing video: {e}")
        return jsonify({"error": "Failed to process video."}), 500


@app.route('/search', methods=['POST'])
def search():
    """Handles search queries on transcript."""
    try:
        data = request.json
        print(f"📨 Incoming search request: {data}")

        query = data.get("query", "")
        sentences = data.get("search_index", [])
        embeddings = data.get("embeddings", [])

        if not query:
            return jsonify({"error": "Query is required"}), 400

        if not sentences:
            return jsonify({"error": "No transcript sentences found."}), 400

        if not embeddings:
            print("❌ No embeddings found. Returning error.")
            return jsonify({"error": "Embeddings missing from request."}), 400

        embeddings = torch.tensor(embeddings)

        result = search_query(query, sentences, embeddings)
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
        keywords = data.get("keywords", [])
        split = transcript.split()
        Counter = Counter(split)
        common = Counter.most_common(5)
        return jsonify({"Common keywords": common})
    except Exception as e:
        print(f"Error extracting commons: {e}")
        return jsonify({"error": "Failed to extract commons."}), 500


if __name__ == '__main__':
    app.run(debug=True)
