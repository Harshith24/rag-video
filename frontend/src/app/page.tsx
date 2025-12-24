'use client';

import { useState, useRef, useEffect } from 'react';

// --- Interfaces ---
interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatSession {
  id: string;          // Backend Video ID
  uniqueId: string;    // Frontend Session ID
  title: string;       // User friendly title
  messages: Message[];
}

export default function Home() {
  // --- State ---
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Inputs
  const [urlInput, setUrlInput] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [questionInput, setQuestionInput] = useState('');
  
  // Status
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');

  // Auto-scroll
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeChat = sessions.find(s => s.uniqueId === activeSessionId);

  // --- Handlers ---
  // 1. Load sidebar list from backend on mount
  useEffect(() => {
    fetchVideosFromDB();
  }, []);

  const fetchVideosFromDB = async () => {
    try {
      const res = await fetch('http://localhost:8000/list-videos');
      if (!res.ok) {
        console.error("Failed to fetch videos:", res.statusText);
        return;
      }
      const data = await res.json();
      // Ensure data is an array
      if (!Array.isArray(data)) {
        console.error("Expected array but got:", data);
        setSessions([]);
        return;
      }
      // Map DB rows to our session format
      const loadedSessions = data.map((v: any) => ({
        id: v.url, 
        uniqueId: v.url, 
        title: v.description, // DB description becomes sidebar title
        messages: []
      }));
      setSessions(loadedSessions);
    } catch (err) {
      console.error("Failed to load history", err);
      setSessions([]);
    }
  };

  const handleIngest = async () => {
    if (!urlInput) return;
    setLoading(true);
    setStatusText('Downloading and processing...');

    try {
      const res = await fetch('http://localhost:8000/ingest-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          url: urlInput,
          description: titleInput || `Video ${sessions.length + 1}`
        }),
      });

      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();
      const videoUrl = data.video_url;

      const newSession: ChatSession = {
        id: videoUrl,
        uniqueId: videoUrl,
        title: data.video_description || titleInput || `Video ${sessions.length + 1}`,
        messages: []
      };

      setSessions([newSession, ...sessions]);
      setActiveSessionId(videoUrl);
      
      // Cleanup
      setUrlInput('');
      setTitleInput('');
      setStatusText('');
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    if (!questionInput.trim() || !activeChat) return;

    const currentQ = questionInput;
    setQuestionInput(''); // Clear input
    
    // 1. Add User Message to UI
    addMessageToSession(activeChat.uniqueId, { role: 'user', content: currentQ });
    setLoading(true);

    try {
      const res = await fetch('http://localhost:8000/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: currentQ,
          video_url: activeChat.id,
          top_k: 8
        }),
      });

      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      // 2. Add AI Response to UI
      addMessageToSession(activeChat.uniqueId, { role: 'assistant', content: data.response });

    } catch (err) {
      addMessageToSession(activeChat.uniqueId, { role: 'assistant', content: "Error: Failed to get response." });
    } finally {
      setLoading(false);
    }
  };

  const addMessageToSession = (uniqueId: string, msg: Message) => {
    setSessions(prev => prev.map(s => 
      s.uniqueId === uniqueId 
        ? { ...s, messages: [...s.messages, msg] } 
        : s
    ));
  };

  const handleDelete = (e: React.MouseEvent, uniqueId: string) => {
    e.stopPropagation();
    setSessions(prev => prev.filter(s => s.uniqueId !== uniqueId));
    if (activeSessionId === uniqueId) setActiveSessionId(null);
  };

  // --- Render ---
  return (
    <div className="app-container">
      
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="new-chat-btn-container">
          <button className="new-chat-btn" onClick={() => setActiveSessionId(null)}>
            + New Video Chat
          </button>
        </div>
        <ul className="history-list">
          {sessions.map(chat => (
            <li 
              key={chat.uniqueId} 
              className={`history-item ${activeSessionId === chat.uniqueId ? 'active' : ''}`}
              onClick={() => setActiveSessionId(chat.uniqueId)}
            >
              <span>{chat.title}</span>
              <button className="delete-btn" onClick={(e) => handleDelete(e, chat.uniqueId)}>×</button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        
        {/* VIEW 1: Create New Chat */}
        {!activeSessionId && (
          <div className="empty-state">
            <div className="ingest-card">
              <h2>Setup New Chat</h2>
              
              <div className="form-group">
                <label>Chat Name (Optional)</label>
                <input 
                  type="text" 
                  className="form-input"
                  placeholder="e.g. Cooking Tutorial"
                  value={titleInput}
                  onChange={e => setTitleInput(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>YouTube URL</label>
                <input 
                  type="text" 
                  className="form-input"
                  placeholder="https://youtube.com/..."
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                />
              </div>

              {statusText && <p style={{color: '#3b82f6', textAlign: 'center'}}>{statusText}</p>}

              <button 
                className="primary-btn"
                onClick={handleIngest}
                disabled={loading || !urlInput}
              >
                {loading ? 'Processing...' : 'Start Chat'}
              </button>
            </div>
          </div>
        )}

        {/* VIEW 2: Active Chat */}
        {activeSessionId && activeChat && (
          <>
            <header className="chat-header">
              <h3>{activeChat.title}</h3>
              <small style={{color: '#888'}}>ID: {activeChat.id}</small>
            </header>

            <div className="chat-messages">
              {activeChat.messages.length === 0 && (
                <div style={{textAlign: 'center', color: '#888', marginTop: '50px'}}>
                  Ask a question to begin.
                </div>
              )}
              
              {activeChat.messages.map((msg, i) => (
                <div key={i} className={`message-row ${msg.role}`}>
                  <div className={`bubble ${msg.role}`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              
              {loading && <div style={{textAlign: 'center', color: '#888'}}>Thinking...</div>}
              <div ref={messagesEndRef} />
            </div>

            <footer className="chat-input-area">
              <input
                className="form-input"
                placeholder="Type your question..."
                value={questionInput}
                onChange={e => setQuestionInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                disabled={loading}
              />
              <button 
                className="primary-btn" 
                style={{width: 'auto', marginTop: 0}}
                onClick={handleSend}
                disabled={loading}
              >
                Send
              </button>
            </footer>
          </>
        )}

      </main>
    </div>
  );
}