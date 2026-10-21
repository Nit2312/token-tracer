/**
 * Superadmin-only analyst chatbot backed by Groq + read-only analytic tools.
 *
 * GET  /api/admin/chat → { usedToday, budget, remaining }   (AI tokens; quick reports cost none)
 * POST /api/admin/chat
 *   { messages: [{role, content}], fresh?: boolean }          ask the AI (cached answers cost 0 tokens)
 *   { quick: { name, days? } }                                 run a prebuilt report with NO AI at all
 * Responds with newline-delimited JSON:
 *   {"type":"status","text":"..."}                 progress
 *   {"type":"step","step":{...}}                   a query + its result rows
 *   {"type":"final","reply":"...","usage":{...},"cached"?:true,"quick"?:true}
 *   {"type":"error","error":"..."}
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { groqApiKey } from '@/lib/team/env';
import { GroqConfigError, runAnalystChat, type ChatStep, type ChatTurn, type TokenUsage } from '@/lib/admin/chat/groq';
import { REPORTS, REPORT_TITLES, clampDays, executeTool, quickMarkdown, type ReportName } from '@/lib/admin/chat/tools';
import { cacheGet, cacheSet } from '@/lib/admin/chat/cache';
import { addUsage, dailyBudget, usedToday, withTimeout } from '@/lib/admin/chat/usage';
import { clientIp, rateLimit } from '@/lib/security/request';
import { recordAuditEvent } from '@/lib/team/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_HISTORY = 12;
const MAX_MESSAGE_CHARS = 2000;
const ZERO_USAGE: TokenUsage = { prompt: 0, completion: 0, total: 0, calls: 0 };

function friendlyError(err: unknown): string {
  if (err instanceof GroqConfigError) return err.message;
  const status = (err as { status?: number }).status;
  if (status === 429) return 'Groq rate limit reached. Wait a moment and try again, or use a Quick report (no AI tokens).';
  if (status === 401) return 'Groq rejected the API key. Check GROQ_API_KEY.';
  if (status === 404) return 'The configured Groq model is not available. Set GROQ_MODEL to a model your key can use.';
  if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') return 'The request timed out. Try a narrower question.';
  return 'The analyst could not complete that request. Try rephrasing or narrowing the question.';
}

function superadmin(req: NextRequest) {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  return session && session.role === 'superadmin' ? session : null;
}

export async function GET(req: NextRequest) {
  if (!superadmin(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const [{ tokens, requests }, budget] = [await withTimeout(usedToday(), 5000, { tokens: 0, requests: 0 }), dailyBudget()];
  return NextResponse.json({ usedToday: tokens, requestsToday: requests, budget, remaining: budget > 0 ? Math.max(0, budget - tokens) : null });
}

export async function POST(req: NextRequest) {
  const session = superadmin(req);
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const ip = clientIp(req);
  const rl = rateLimit(`chat:${session.userId}:${ip}`, 20, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${rl.retryAfterSec}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const body = await req.json().catch(() => null);
  const encoder = new TextEncoder();
  const actorUserId = session.userId.length === 36 ? session.userId : null;

  const streamResponse = (run: (send: (obj: unknown) => void) => Promise<{ steps: ChatStep[]; outcome: 'ok' | 'error'; audit: Record<string, unknown> }>) =>
    new Response(
      new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
            } catch {
              // client went away
            }
          };
          let result: { steps: ChatStep[]; outcome: 'ok' | 'error'; audit: Record<string, unknown> } = { steps: [], outcome: 'error', audit: {} };
          try {
            result = await run(send);
          } catch (err) {
            if (!(err instanceof GroqConfigError)) console.error('[admin/chat error]', err);
            send({ type: 'error', error: friendlyError(err) });
          } finally {
            // Audit trail: what was asked and which queries ran (never the result rows).
            await withTimeout(recordAuditEvent({
              actorUserId,
              actorUsername: session.username,
              action: 'chat.query',
              metadata: {
                ip,
                outcome: result.outcome,
                ...result.audit,
                tools: result.steps.map((s) => ({ tool: s.tool, ok: s.ok, rows: s.result?.rowCount ?? 0, sql: s.sql?.slice(0, 600) })),
              },
            }), 5000, undefined);
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      }),
      {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
        },
      },
    );

  // ── Quick report: pure SQL, zero AI tokens ─────────────────────────────────
  if (body?.quick && typeof body.quick === 'object') {
    const name = String(body.quick.name || '') as ReportName;
    if (!(REPORTS as readonly string[]).includes(name)) return NextResponse.json({ error: 'Unknown report.' }, { status: 400 });
    const days = clampDays(body.quick.days);
    return streamResponse(async (send) => {
      send({ type: 'status', text: `Running ${REPORT_TITLES[name].toLowerCase()}…` });
      const outcome = await executeTool(name, { days, limit: 10 });
      const step: ChatStep = { tool: name, args: { days }, ok: outcome.ok, error: outcome.error, sql: outcome.sql, result: outcome.result };
      if (!outcome.ok || !outcome.result) {
        send({ type: 'error', error: outcome.error || 'The report failed.' });
        return { steps: [step], outcome: 'error', audit: { quick: name } };
      }
      send({ type: 'step', step });
      send({ type: 'final', reply: quickMarkdown(name, days, outcome.result), usage: ZERO_USAGE, quick: true });
      return { steps: [step], outcome: 'ok', audit: { quick: name, days } };
    });
  }

  // ── AI question ────────────────────────────────────────────────────────────
  // Only plain user/assistant text is accepted from the client: it cannot inject system or tool messages.
  const history: ChatTurn[] = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((m: { role?: unknown; content?: unknown }) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .map((m: { role: 'user' | 'assistant'; content: string }) => ({ role: m.role, content: String(m.content).slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY);

  if (!history.length || history[history.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'Send at least one user message.' }, { status: 400 });
  }
  const question = history[history.length - 1].content;
  const fresh = body?.fresh === true;

  // Repeat of a standalone question: replay the stored answer for 0 tokens.
  if (history.length === 1 && !fresh) {
    const hit = cacheGet(question);
    if (hit) {
      return streamResponse(async (send) => {
        for (const step of hit.steps) if (step.tool !== 'get_schema') send({ type: 'step', step });
        send({ type: 'final', reply: hit.reply, usage: ZERO_USAGE, cached: true, ageSec: hit.ageSec });
        return { steps: hit.steps, outcome: 'ok', audit: { question: question.slice(0, 300), cached: true } };
      });
    }
  }

  if (!groqApiKey()) return NextResponse.json({ error: 'GROQ_API_KEY is not configured on the server.' }, { status: 503 });

  const budget = dailyBudget();
  if (budget > 0) {
    // Fail open: if the usage table is slow to answer, do not block the user's question.
    const { tokens } = await withTimeout(usedToday(), 4000, { tokens: 0, requests: 0 });
    if (tokens >= budget) {
      return NextResponse.json(
        { error: `Daily AI token budget reached (${budget.toLocaleString()} tokens). Quick reports still work and cost nothing; the budget resets at 00:00 UTC.`, budgetExceeded: true },
        { status: 429 },
      );
    }
  }

  return streamResponse(async (send) => {
    const result = await runAnalystChat(history, (e) => send(e), req.signal);
    await withTimeout(addUsage(result.usage.total), 4000, undefined);
    if (history.length === 1) cacheSet(question, result.reply, result.steps);
    send({ type: 'final', reply: result.reply, usage: result.usage });
    return {
      steps: result.steps,
      outcome: 'ok',
      audit: { question: question.slice(0, 300), tokens: result.usage.total, modelCalls: result.usage.calls, fresh },
    };
  });
}
