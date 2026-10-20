/**
 * POST /api/admin/chat  { messages: [{role: 'user'|'assistant', content}] }
 * Superadmin-only analyst chatbot backed by Groq + read-only analytic tools.
 * Responds with a newline-delimited JSON stream:
 *   {"type":"status","text":"..."}   progress
 *   {"type":"step","step":{...}}     a tool call + its result rows
 *   {"type":"final","reply":"..."}   the answer
 *   {"type":"error","error":"..."}   failure
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { groqApiKey } from '@/lib/team/env';
import { GroqConfigError, runAnalystChat, type ChatStep, type ChatTurn } from '@/lib/admin/chat/groq';
import { clientIp, rateLimit } from '@/lib/security/request';
import { recordAuditEvent } from '@/lib/team/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_HISTORY = 16;
const MAX_MESSAGE_CHARS = 4000;

function friendlyError(err: unknown): string {
  if (err instanceof GroqConfigError) return err.message;
  const status = (err as { status?: number }).status;
  if (status === 429) return 'Groq rate limit reached. Wait a moment and try again.';
  if (status === 401) return 'Groq rejected the API key. Check GROQ_API_KEY.';
  if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') return 'The request timed out. Try a narrower question.';
  return 'The analyst could not complete that request. Try rephrasing or narrowing the question.';
}

export async function POST(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  if (!session || session.role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const ip = clientIp(req);
  const rl = rateLimit(`chat:${session.userId}:${ip}`, 20, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${rl.retryAfterSec}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  if (!groqApiKey()) {
    return NextResponse.json({ error: 'GROQ_API_KEY is not configured on the server.' }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  // Only plain user/assistant text is accepted from the client: it cannot inject system or tool messages.
  const history: ChatTurn[] = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((m: { role?: unknown; content?: unknown }) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .map((m: { role: 'user' | 'assistant'; content: string }) => ({ role: m.role, content: String(m.content).slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY);

  if (!history.length || history[history.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'Send at least one user message.' }, { status: 400 });
  }

  const question = history[history.length - 1].content;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          // client went away
        }
      };
      let steps: ChatStep[] = [];
      let outcome: 'ok' | 'error' = 'ok';
      try {
        const result = await runAnalystChat(history, (e) => send(e), req.signal);
        steps = result.steps;
        send({ type: 'final', reply: result.reply });
      } catch (err) {
        outcome = 'error';
        if (!(err instanceof GroqConfigError)) console.error('[admin/chat error]', err);
        send({ type: 'error', error: friendlyError(err) });
      } finally {
        // Audit trail: what was asked and which queries ran (never the result rows).
        await recordAuditEvent({
          actorUserId: session.userId.length === 36 ? session.userId : null,
          actorUsername: session.username,
          action: 'chat.query',
          metadata: {
            ip,
            outcome,
            question: question.slice(0, 300),
            tools: steps.map((s) => ({ tool: s.tool, ok: s.ok, rows: s.result?.rowCount ?? 0, sql: s.sql?.slice(0, 600) })),
          },
        });
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
