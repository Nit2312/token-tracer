import 'server-only';
/**
 * Short-lived cache of finished answers for single-question conversations. Repeating a question
 * within the TTL costs zero AI tokens. Answers are at most TTL old; "Re-run" bypasses it.
 */
import type { ChatStep } from './groq';

interface Entry {
  reply: string;
  steps: ChatStep[];
  at: number;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 60;
const store = new Map<string, Entry>();

const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function cacheGet(question: string): (Entry & { ageSec: number }) | null {
  const key = norm(question);
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    store.delete(key);
    return null;
  }
  return { ...e, ageSec: Math.round((Date.now() - e.at) / 1000) };
}

export function cacheSet(question: string, reply: string, steps: ChatStep[]): void {
  if (!steps.some((s) => s.ok)) return; // only cache answers backed by real query results
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(norm(question), { reply, steps, at: Date.now() });
}
