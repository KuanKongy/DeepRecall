from flask import Flask, request, jsonify
from flask_cors import CORS  # Import CORS
import whisper
import openai
import os
import re
import ffmpeg
import torch
from sentence_transformers import SentenceTransformer, util

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# OR use:
# CORS(app, origins=["http://localhost:5173"])  # Restrict to your frontend only

# Load OpenAI API key securely
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

def summarize_text(text):
    """Summarizes text using OpenAI GPT."""
    try:
        client = openai.OpenAI(api_key=openai.api_key)
        response = client.chat.completions.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": "Summarize the following lecture transcript."},
                {"role": "user", "content": text}
            ]
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"Error in summarization: {e}")
        return ""

def create_search_index(transcript):
    """Creates an embedding index for search queries."""
    sentences = [seg['text'] for seg in transcript]

    if not sentences:
        print("⚠️ No sentences found for embedding generation.")
        return [], None  # Return None instead of an empty tensor

    try:
        embeddings = search_model.encode(sentences, convert_to_tensor=True)
        print(f"✅ Generated {len(embeddings)} embeddings.")
        return sentences, embeddings
    except Exception as e:
        print(f"❌ Error generating embeddings: {e}")
        return sentences, None  # Return None to indicate failure


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

        transcript = transcribe_audio_with_timestamps(video_path)
        
        if not transcript:
            return jsonify({"error": "Failed to transcribe video."}), 500

        summary = summarize_text(" ".join([seg['text'] for seg in transcript]))

        sentences, embeddings = create_search_index(transcript)

        if embeddings is None:
            print("❌ Failed to generate embeddings.")
            return jsonify({"error": "Failed to generate embeddings."}), 500

        return jsonify({
            "transcript": transcript,
            "summary": summary,
            "search_index": sentences,
            "embeddings": embeddings.tolist()  # Convert tensor to list
        })
    except Exception as e:
        print(f"❌ Error processing video: {e}")
        return jsonify({"error": "Failed to process video."}), 500



@app.route('/search', methods=['POST'])
def search():
    """Handles search queries on transcript."""
    try:
        data = request.json
        print(f"📨 Incoming search request: {data}")  # Debugging log

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

if __name__ == '__main__':
    app.run(debug=True)
