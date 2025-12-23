// app/page.tsx
'use client';

import { useState } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface VideoChat {
  videoId: string;
  title: string; // Optional: can use URL or extract title later
  messages: Message[];
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [videos, setVideos] = useState<VideoChat[]>([]); // List of ingested videos/chats
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [currentMessages, setCurrentMessages] = useState<Message[]>([]);

  const handleProcess = async () => {
    if (!url) return;
    setLoading(true);
    setStatus('Processing video...');

    try {
      const res = await fetch('http://localhost:8000/ingest-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();
      const videoId = data.video_id;

      // Add new chat session
      setVideos(prev => [
        ...prev,
        { videoId, title: url.split('/').pop() || 'Video', messages: [] }
      ]);
      setActiveVideoId(videoId);
      setCurrentMessages([]);
      setStatus(`Ingested successfully! (${data.chunk_count} chunks)`);
      setUrl(''); // Clear input
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    if (!question.trim() || !activeVideoId) return;

    const userMessage: Message = { role: 'user', content: question };
    setCurrentMessages(prev => [...prev, userMessage]);
    setQuestion('');
    setLoading(true);

    try {
      const res = await fetch('http://localhost:8000/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          video_id: activeVideoId,
          top_k: 5
        }),
      });

      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();

      const aiMessage: Message = { role: 'assistant', content: data.response };
      setCurrentMessages(prev => [...prev, aiMessage]);

      // Update chat history in videos list
      setVideos(prev =>
        prev.map(v =>
          v.videoId === activeVideoId
            ? { ...v, messages: [...v.messages, userMessage, aiMessage] }
            : v
        )
      );
    } catch (err) {
      setCurrentMessages(prev => [
        ...prev,
        { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Failed to query'}` }
      ]);
    } finally {
      setLoading(false);
    }
  };

  // Get active chat messages
  const activeChat = videos.find(v => v.videoId === activeVideoId);

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar: List of ingested videos */}
      <aside className="w-64 bg-white border-r p-4 overflow-y-auto">
        <h2 className="text-lg font-bold mb-4">Your Videos</h2>
        {videos.length === 0 ? (
          <p className="text-gray-500">No videos processed yet.</p>
        ) : (
          <ul>
            {videos.map(video => (
              <li key={video.videoId}>
                <button
                  onClick={() => {
                    setActiveVideoId(video.videoId);
                    setCurrentMessages(video.messages);
                  }}
                  className={`w-full text-left p-2 rounded mb-2 ${
                    activeVideoId === video.videoId ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'
                  }`}
                >
                  {video.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col">
        {/* Header */}
        <header className="bg-white border-b p-4 flex items-center">
          <input
            type="text"
            placeholder="Paste YouTube URL here..."
            value={url}
            onChange={e => setUrl(e.target.value)}
            className="flex-1 p-2 border rounded mr-2"
            disabled={loading}
          />
          <button
            onClick={handleProcess}
            disabled={loading || !url.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400"
          >
            {loading ? 'Processing...' : 'Ingest'}
          </button>
        </header>

        {/* Status */}
        {status && <p className="p-4 text-center text-green-600">{status}</p>}

        {/* Chat Area */}
        <div className="flex-1 p-4 overflow-y-auto bg-gray-50">
          {!activeVideoId ? (
            <div className="text-center text-gray-500 mt-20">
              <p>Ingest a video to start chatting!</p>
            </div>
          ) : (
            <div className="space-y-4">
              {currentMessages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] p-3 rounded-lg ${
                      msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white shadow'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="text-center text-gray-500">Thinking...</div>
              )}
            </div>
          )}
        </div>

        {/* Input Area */}
        {activeVideoId && (
          <footer className="p-4 border-t bg-white">
            <div className="flex">
              <input
                type="text"
                placeholder="Ask anything about this video..."
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                className="flex-1 p-3 border rounded-l-lg focus:outline-none"
                disabled={loading}
              />
              <button
                onClick={handleSend}
                disabled={loading || !question.trim()}
                className="px-6 py-3 bg-blue-600 text-white rounded-r-lg disabled:bg-gray-400"
              >
                Send
              </button>
            </div>
          </footer>
        )}
      </main>
    </div>
  );
}