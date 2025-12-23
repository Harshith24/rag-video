# Modified app.py (only showing the updated /ingest endpoint and relevant imports; replace in your existing app.py)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import subprocess
import whisper
import ollama
import os
from sqlalchemy import text
from langchain_community.document_loaders import TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
import psycopg2 as pg
import json
import uvicorn

app = FastAPI()

# Allow CORS for your frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

config_file_path = './config.json'
try:
    with open(config_file_path, 'r', encoding='utf-8') as file:
        config_data = json.load(file)

except FileNotFoundError:
    print(f"Error: The file '{config_file_path}' was not found.")
    config_data = {} 
except json.JSONDecodeError:
    print("Error: Failed to decode JSON from the file. Check file formatting.")
    config_data = {}

try:
    conn = pg.connect(
        user=config_data.get('database')['user'],
        password=config_data.get('database')['password'],
        host=config_data.get('database')['host'], 
        port=config_data.get('database')['port']         
    )
except pg.OperationalError as e:
    print(f"An error occurred: {e}")


class VideoURL(BaseModel):
    url: str

class Query(BaseModel):
    question: str
    video_id: str
    top_k: int = 5

@app.post("/query")
async def query_rag(data: Query):
    try:
        # Embed the question
        emb_response = ollama.embeddings(
            model='nomic-embed-text',
            prompt=data.question
        )
        query_emb = emb_response['embedding']  # This is a list of floats

        # Retrieve top-k chunks (cast query_emb to vector)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT chunk_text, embedding <=> %s::vector AS distance
                FROM video_chunks
                WHERE video_id = %s
                ORDER BY embedding <=> %s::vector
                LIMIT %s
            """, (query_emb, data.video_id, query_emb, data.top_k))
            
            results = cur.fetchall()

        if not results:
            return {"response": "No relevant chunks found for this video.", "sources": []}

        # Extract text and prepare context
        context = []
        sources = []
        for row in results:
            chunk_text = row[0]
            distance = row[1]
            context.append(chunk_text)
            sources.append({"text": chunk_text, "similarity": 1 - distance})

        # Build prompt
        context_str = "\n\n".join(context)
        prompt = f"""You are an expert at answering questions about video content.
Use ONLY the provided context from the video transcript. Be accurate, concise, and reference timestamps if relevant.

Context:
{context_str}

Question: {data.question}

Answer:"""

        response = ollama.generate(
            model=config_data.get("model")["name"],
            prompt=prompt,
            options={"temperature": 0.7}
        )['response']

        return {
            "response": response.strip(),
            "sources": sources
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Query failed: {str(e)}")

@app.post("/ingest-video")
async def ingest_video(data: VideoURL):
    try:
        # Generate unique video_id (use URL hash or random)
        video_id = data.url.split('v=')[-1] if 'youtube' in data.url else f"video_{os.urandom(4).hex()}"
        
        mp4_path = f"{video_id}.mp4"
        mp3_path = f"{video_id}.mp3"
        transcript_path = f"{video_id}_transcript.txt"

        # Step 1: Download video with yt-dlp
        subprocess.run(['yt-dlp', '--no-check-certificate', data.url, '-o', mp4_path], check=True)

        # Step 2: Extract audio with FFmpeg
        subprocess.run(['ffmpeg', '-i', mp4_path, '-q:a', '0', '-map', 'a', mp3_path], check=True)

        # Step 3: Transcribe with Whisper
        model = whisper.load_model("base")  # or "base" for faster testing
        result = model.transcribe(mp3_path, verbose=False)

        # Write transcript with timestamps to file
        with open(transcript_path, "w") as f:
            for segment in result['segments']:
                f.write(f"[{segment['start']}-{segment['end']}s]: {segment['text']}\n")

        # Step 4: Chunk with LangChain
        loader = TextLoader(transcript_path)
        text_documents = loader.load()

        text_splitter = RecursiveCharacterTextSplitter(chunk_size=2000, chunk_overlap=20)
        documents = text_splitter.split_documents(text_documents)

        # Step 5: Embed and store in PG-vector
        with conn.cursor() as cur: 
            for doc in documents:
                emb = ollama.embeddings(model='nomic-embed-text', prompt=doc.page_content)['embedding']
                cur.execute("""
                    INSERT INTO video_chunks (video_id, chunk_text, embedding)
                    VALUES (%s, %s, %s)
                """, (video_id, doc.page_content, emb))
            conn.commit()

        # Cleanup files
        for path in [mp4_path, mp3_path, transcript_path]:
            if os.path.exists(path):
                os.remove(path)

        return {
            "status": "success",
            "video_id": video_id,
            "chunk_count": len(documents),
            "message": "Video processed, transcribed, chunked, and ingested into database."
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == '__main__':
    uvicorn.run(app, host="0.0.0.0", port=8000)