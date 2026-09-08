import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';

export const metadata: Metadata = {
  title: 'Visualisation Dashboard — cross-agent intelligence',
  description:
    'Cross-agent intelligence dashboard for Claude Code, Codex, Cursor, OpenClaw, and Hermes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/style.css" />
        <link rel="stylesheet" href="/team/team.css" />
      </head>
      <body suppressHydrationWarning>
        <div id="impersonation-banner" className="impersonation-banner" hidden>
          <span id="impersonation-text">You are logged in as</span>
          <button id="impersonation-back-btn" className="hbtn small-btn outline-btn" style={{ background: 'rgba(0,0,0,0.15)', borderColor: 'rgba(0,0,0,0.2)', color: '#000' }}>
            Back to Super Admin
          </button>
        </div>
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
