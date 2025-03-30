# Project Description

DeepRecall is a Flask-based AI API that turns videos into structured, searchable knowledge by transcribing, summarizing, and indexing content with state-of-the-art machine learning models. Whether you're analyzing lecture recordings, meetings, or educational content, DeepRecall helps you find key moments instantly with semantic search and caching.

## Project info

**URL**: https://www.youtube.com/watch?v=F3tVI8lyPAw

## 🛠 How We Built It
### Backend (Flask-based RESTful API):
- Flask & Flask-CORS for API development.
- OpenAI Whisper for speech-to-text transcription.
- GPT-4 for summarization.
- Sentence Transformers for semantic search with cosine similarity.
- Redis caching to store transcripts & summaries.
- FFmpeg for extracting audio from video files.
- PyTorch for handling embeddings and search.

## Dependencies: 
- You need to download python3.10
- Put into terminal: pip3.10 flask openai-whisper openai ffmpeg-python sentence-transformers torch redis tiktoken flask_caching hashlib

## To Run
Put into terminal: python3.10 app.py