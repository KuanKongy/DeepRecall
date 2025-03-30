from flask import Flask, request, jsonify
import whisper
import openai
import os
import re
import ffmpeg
from sentence_transformers import SentenceTransformer, util

app = Flask(__name__)
openai.api_key = "YOUR_OPENAI_API_KEY"

# Load Whisper model
try:
    model = whisper.load_model("base")
    print("Whisper model loaded successfully.")
except Exception as e:
    print(f"Error loading Whisper model: {e}")
    exit(1)

# Load Sentence Transformer for search
search_model = SentenceTransformer("all-MiniLM-L6-v2")

def transcribe_audio(video_path):
    """Extracts audio from video and transcribes it using Whisper."""
    audio_path = "temp_audio.wav"
    try:
        ffmpeg.input(video_path).output(audio_path, format='wav').run(overwrite_output=True)
        print("Audio extracted successfully.")
        result = model.transcribe(audio_path)
        return result['text']
    except Exception as e:
        print(f"Error in transcription: {e}")
        return ""

def summarize_text(text):
    """Summarizes text using OpenAI GPT."""
    try:
        response = openai.ChatCompletion.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": "Summarize the following lecture transcript."},
                {"role": "user", "content": text}
            ]
        )
        return response["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"Error in summarization: {e}")
        return ""

def create_search_index(transcript):
    """Creates an embedding index for search queries."""
    sentences = re.split(r'(?<=[.!?]) +', transcript)
    embeddings = search_model.encode(sentences, convert_to_tensor=True)
    return sentences, embeddings

def search_query(query, sentences, embeddings):
    """Finds relevant segments in transcript based on search query."""
    try:
        query_embedding = search_model.encode(query, convert_to_tensor=True)
        scores = util.pytorch_cos_sim(query_embedding, embeddings)[0]
        top_match = sentences[scores.argmax().item()]
        return top_match
    except Exception as e:
        print(f"Error in search: {e}")
        return ""

@app.route('/process_video', methods=['POST'])
def process_video():
    """Handles video file upload, transcription, and summarization."""
    try:
        file = request.files['file']
        video_path = "uploaded_video.mp4"
        file.save(video_path)
        print("Video uploaded successfully.")

        transcript = transcribe_audio(video_path)
        summary = summarize_text(transcript)
        sentences, embeddings = create_search_index(transcript)

        return jsonify({"transcript": transcript, "summary": summary, "search_index": sentences, "embeddings": embeddings.tolist()})
    except Exception as e:
        print(f"Error processing video: {e}")
        return jsonify({"error": "Failed to process video."}), 500

@app.route('/search', methods=['POST'])
def search():
    """Handles search queries on transcript."""
    try:
        data = request.json
        query = data.get("query", "")
        sentences = data.get("search_index", [])
        embeddings = data.get("embeddings", [])
        if embeddings:
            import torch
            embeddings = torch.tensor(embeddings)
        result = search_query(query, sentences, embeddings)
        return jsonify({"result": result})
    except Exception as e:
        print(f"Error handling search: {e}")
        return jsonify({"error": "Search failed."}), 500

if __name__ == '__main__':
    app.run(debug=True)
