// app/layout.tsx
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';  // If you have global styles (create this file if needed)

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Video Audio RAG',
  description: 'Ask questions about your videos using local AI',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {/* Optional: Add a global header or nav here */}
        <header style={{ padding: '1rem', background: '#f0f0f0', textAlign: 'center' }}>
          <h1>Video Audio RAG</h1>
          <p>Enter a video URL, process it, and ask questions!</p>
        </header>

        {/* Main content (your page.tsx will go here) */}
        <main style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
          {children}
        </main>

        {/* Optional footer */}
        <footer style={{ padding: '1rem', textAlign: 'center', borderTop: '1px solid #ccc' }}>
          <p>Powered by FastAPI + Ollama + Next.js • Local & Private</p>
        </footer>
      </body>
    </html>
  );
}