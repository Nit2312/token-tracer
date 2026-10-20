import 'server-only';
/** Daily AI-token accounting and budget for the analyst chat. Quick reports never touch this. */
import { getPool } from '@/lib/team/db';
import { loadEnv } from '@/lib/team/env';

let ready: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!ready) {
    ready = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS chat_usage (
           day      DATE PRIMARY KEY,
           tokens   BIGINT NOT NULL DEFAULT 0,
           requests INT NOT NULL DEFAULT 0
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

/** Max AI tokens per UTC day (0 = unlimited). Set CHAT_DAILY_TOKEN_BUDGET to change it. */
export function dailyBudget(): number {
  loadEnv();
  const n = Number(process.env.CHAT_DAILY_TOKEN_BUDGET);
  return Number.isFinite(n) && n >= 0 && process.env.CHAT_DAILY_TOKEN_BUDGET !== undefined && process.env.CHAT_DAILY_TOKEN_BUDGET !== '' ? n : 300_000;
}

export async function usedToday(): Promise<{ tokens: number; requests: number }> {
  try {
    await ensureTable();
    const { rows } = await getPool().query("SELECT tokens, requests FROM chat_usage WHERE day = (now() AT TIME ZONE 'utc')::date");
    return { tokens: Number(rows[0]?.tokens || 0), requests: Number(rows[0]?.requests || 0) };
  } catch (err) {
    console.error('[chat-usage read error]', (err as Error).message);
    return { tokens: 0, requests: 0 };
  }
}

export async function addUsage(tokens: number): Promise<void> {
  if (!tokens) return;
  try {
    await ensureTable();
    await getPool().query(
      `INSERT INTO chat_usage (day, tokens, requests) VALUES ((now() AT TIME ZONE 'utc')::date, $1, 1)
       ON CONFLICT (day) DO UPDATE SET tokens = chat_usage.tokens + EXCLUDED.tokens, requests = chat_usage.requests + 1`,
      [Math.round(tokens)],
    );
  } catch (err) {
    console.error('[chat-usage write error]', (err as Error).message);
  }
}
