'use client';

import { useState } from 'react';

interface Props { consentToken: string; clientName: string; destination: string; loopback: boolean; userName: string; teamName: string; allTeams?: boolean }

/**
 * Posts the decision with fetch (the site CSP has form-action 'self', which would block a form post that redirects to the client) and then
 * navigates to the URL the SERVER built from the client's registered redirect URI. All values are rendered as text by React (escaped);
 * clientName is attacker-controlled (dynamic client registration) and must never be injected as HTML.
 */
export default function ConsentForm({ consentToken, clientName, destination, loopback, userName, teamName, allTeams }: Props) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'deny') {
    setBusy(decision); setError(null);
    try {
      const res = await fetch('/oauth/decision', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: consentToken, decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.redirect === 'string') { window.location.assign(data.redirect); return; }
      if (data.error === 'login_required') { window.location.reload(); return; } // the page then asks for a fresh sign-in
      setError(typeof data.error_description === 'string' ? data.error_description : 'Something went wrong. Reload the page and try again.');
    } catch {
      setError('Network error. Try again.');
    }
    setBusy(null);
  }

  return (
    <div className="login-page">
      <div className="login-card" style={{ maxWidth: 520 }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Authorize access</h1>
        <p style={{ marginBottom: 12 }}>
          <strong>{clientName}</strong> is asking to connect to Token Tracer as <strong>{userName}</strong> for {allTeams ? <strong>all teams</strong> : <>the team <strong>{teamName}</strong></>}.
        </p>
        <p style={{ marginBottom: 6 }}>If you approve, it will be able to <strong>read</strong>:</p>
        <ul style={{ margin: '0 0 12px 20px' }}>
          <li>{allTeams ? 'the developers and their activity (tokens, cost, sessions) of every team, one team at a time' : 'your team\'s developers and their activity (tokens, cost, sessions)'}</li>
          <li>session details (which tools were used and how often, edits, errors)</li>
          <li>prompt metadata only: when it was sent, its length, its category (for example bug fix or refactor), and whether it contains code, a file path or an error trace</li>
        </ul>
        <p style={{ marginBottom: 12 }}>It cannot read the text of any prompt, or any file contents or file names. It cannot change or delete anything. Granting and revoking access is recorded in the audit log. You can revoke access at any time.</p>
        <p style={{ marginBottom: 12 }}>The result will be sent to: <strong>{destination}</strong></p>
        {loopback && (
          <p role="alert" style={{ marginBottom: 12, padding: 10, border: '1px solid currentColor', borderRadius: 8 }}>
            This connection returns to a program on your own computer. Only approve if you just started it yourself (for example Claude Code).
          </p>
        )}
        <p style={{ marginBottom: 16, opacity: 0.8 }}>The application name was chosen by whoever registered it and is not verified. Approve only if you started this connection.</p>
        {error && <p role="alert" style={{ marginBottom: 12 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 12 }}>
          <button type="button" disabled={busy !== null} onClick={() => decide('approve')} style={{ padding: '10px 20px', borderRadius: 8, border: 0, fontWeight: 650, color: 'var(--brand-ink)', background: 'linear-gradient(160deg, var(--brand-hi), var(--brand))', cursor: busy !== null ? 'not-allowed' : 'pointer', opacity: busy !== null ? 0.85 : 1 }}>{busy === 'approve' ? 'Approving…' : 'Approve'}</button>
          <button type="button" disabled={busy !== null} onClick={() => decide('deny')} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>{busy === 'deny' ? 'Denying…' : 'Deny'}</button>
        </div>
      </div>
    </div>
  );
}
