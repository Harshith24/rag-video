# app.py - Final version with video_description, separate audio/visual chunks, LLaVA for frame descriptions,
# and fixed yt-dlp download with binary

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import subprocess
import whisper
import ollama
import os
from langchain_community.document_loaders import TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
import psycopg2 as pg
from pathlib import Path
import json
import uvicorn
import shutil
import easyocr

app = FastAPI()
ocr_reader = easyocr.Reader(['en'], gpu=False)

# Allow CORS for your frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # Update if your frontend port changes
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load database config
config_file_path = './config.json'
try:
    with open(config_file_path, 'r', encoding='utf-8') as file:
        config_data = json.load(file)
except (FileNotFoundError, json.JSONDecodeError):
    config_data = {}

# Database connection
try:
    conn = pg.connect(
        user=config_data.get('database', {}).get('user'),
        password=config_data.get('database', {}).get('password'),
        host=config_data.get('database', {}).get('host', 'localhost'),
        port=config_data.get('database', {}).get('port', 5432),
        dbname=config_data.get('database', {}).get('database', 'video_chunks')
    )
except pg.OperationalError as e:
    print(f"Database connection error: {e}")
    raise

class VideoURL(BaseModel):
    url: str
    description: str = ""  # Optional user-provided description

class Query(BaseModel):
    question: str
    video_url: str
    top_k: int = 8

@app.get("/list-videos")
async def list_videos():
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT video_url, video_description 
                FROM video_chunks 
                ORDER BY video_description ASC
            """)
            rows = cur.fetchall()
            return [{"url": row[0], "description": row[1] or "No description"} for row in rows]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/ingest-video")
async def ingest_video(data: VideoURL):
    try:
        video_url = data.url.strip()
        if not video_url:
            raise HTTPException(status_code=400, detail="URL is required")

        user_description = data.description.strip() or f"Video from {video_url.split('?')[0]}"

        video_id = video_url.split('v=')[-1] if 'youtube' in video_url else f"video_{os.urandom(4).hex()}"
        mp4_path = f"{video_id}.mp4"
        transcript_path = f"{video_id}_transcript.txt"
        frames_dir = f"frames_{video_id}"
        Path(frames_dir).mkdir(exist_ok=True)

        # Download video (using your working yt-dlp binary)
        subprocess.run([
            './yt-dlp_macos',
            '--no-check-certificate',
            '-f', 'bestvideo+bestaudio/best',
            '--merge-output-format', 'mp4',
            '--remux-video', 'mp4',
            video_url,
            '-o', mp4_path
        ], check=True)

        # Extract frames every 10 seconds
        subprocess.run([
            'ffmpeg', '-i', mp4_path,
            '-vf', 'fps=1/10',
            f'{frames_dir}/frame_%04d.png'
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        # Transcribe audio
        whisper_model = whisper.load_model("base")
        result = whisper_model.transcribe(mp4_path, verbose=False)

        # Write transcript
        with open(transcript_path, "w") as f:
            for seg in result['segments']:
                f.write(f"[{seg['start']:.1f}-{seg['end']:.1f}s]: {seg['text'].strip()}\n")

        # Chunk audio transcript
        loader = TextLoader(transcript_path)
        docs = loader.load()
        splitter = RecursiveCharacterTextSplitter(chunk_size=2000, chunk_overlap=20)
        audio_chunks = splitter.split_documents(docs)

        # Process frames with EasyOCR
        frame_files = sorted(Path(frames_dir).glob("frame_*.png"))
        visual_chunks = []

        for i, frame_path in enumerate(frame_files):
            timestamp = i * 10  # seconds

            # OCR
            ocr_result = ocr_reader.readtext(str(frame_path))
            ocr_text = " ".join([text for _, text, _ in ocr_result])  # Extract all detected text

            full_visual_text = f"[Frame at {timestamp}s]\nOCR text: {ocr_text}"

            # Embed
            emb = ollama.embeddings(model='nomic-embed-text', prompt=full_visual_text)['embedding']

            visual_chunks.append({
                'chunk_text': full_visual_text,
                'embedding': emb,
                'image_path': str(frame_path),
                'timestamp_start': timestamp,
                'timestamp_end': timestamp + 10
            })

        # Store in DB
        with conn.cursor() as cur:
            # Audio chunks
            for chunk in audio_chunks:
                emb = ollama.embeddings(model='nomic-embed-text', prompt=chunk.page_content)['embedding']
                cur.execute("""
                    INSERT INTO video_chunks (video_url, video_description, chunk_type, chunk_text, embedding, timestamp_start, timestamp_end)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                """, (video_url, user_description, 'audio', chunk.page_content, emb, None, None))

            # Visual chunks (OCR only)
            for v_chunk in visual_chunks:
                cur.execute("""
                    INSERT INTO video_chunks (video_url, video_description, chunk_type, chunk_text, embedding, image_path, timestamp_start, timestamp_end)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    video_url, user_description, 'visual', v_chunk['chunk_text'], v_chunk['embedding'],
                    v_chunk['image_path'], v_chunk['timestamp_start'], v_chunk['timestamp_end']
                ))

            conn.commit()

        # Cleanup
        shutil.rmtree(frames_dir)
        os.remove(mp4_path)
        os.remove(transcript_path)

        return {
            "status": "success",
            "video_url": video_url,
            "video_description": user_description,
            "audio_chunks": len(audio_chunks),
            "visual_chunks": len(frame_files),
            "message": "Video ingested with audio transcript and OCR from frames!"
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")

@app.post("/query")
async def query_rag(data: Query):
    try:
        q_emb = ollama.embeddings(model='nomic-embed-text', prompt=data.question)['embedding']

        with conn.cursor() as cur:
            # Top-k audio chunks
            cur.execute("""
                SELECT chunk_text
                FROM video_chunks
                WHERE video_url = %s AND chunk_type = 'audio'
                ORDER BY embedding <=> %s::vector
                LIMIT %s
            """, (data.video_url, q_emb, data.top_k))
            audio_results = [row[0] for row in cur.fetchall()]

            # Top-k visual chunks (OCR text)
            cur.execute("""
                SELECT chunk_text, image_path
                FROM video_chunks
                WHERE video_url = %s AND chunk_type = 'visual'
                ORDER BY embedding <=> %s::vector
                LIMIT %s
            """, (data.video_url, q_emb, data.top_k))
            visual_results = cur.fetchall()

        # Combine context
        context_parts = [f"[Audio]: {text}" for text in audio_results]
        image_paths = []  # Not used for generation (no LLaVA)
        for text, img_path in visual_results:
            context_parts.append(f"[Visual OCR]: {text}")

        context = "\n\n".join(context_parts)

        prompt = f"""You are an expert on this video. Use the audio transcript and OCR-extracted text from frames to answer accurately.

Context:
{context}

Question: {data.question}

Answer:"""

        # Generate with text LLM
        response = ollama.generate(
            model='mistral',
            prompt=prompt
        )['response']

        return {
            "response": response.strip(),
            "audio_retrieved": len(audio_results),
            "visual_retrieved": len(visual_results)
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Query failed: {str(e)}")


if __name__ == '__main__':
    uvicorn.run(app, host="0.0.0.0", port=8000)