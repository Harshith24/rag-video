import type { Metadata } from 'next';
import './globals.css'; // <--- Imports the CSS above

export const metadata: Metadata = {
  title: 'Video Chat',
  description: 'Chat with your videos',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}