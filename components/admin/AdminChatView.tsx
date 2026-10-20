'use client';

import * as React from 'react';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  ShieldCheck,
  Sparkles,
  Square,
  RefreshCw,
  Trash2,
  User,
  Zap,
} from 'lucide-react';

interface Step {
  tool: string;
  args: unknown;
  ok: boolean;
  error?: string;
  sql?: string;
  result?: { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean };
}

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  steps?: Step[];
  error?: boolean;
  /** Quick-report messages are never sent back to the AI (saves tokens). */
  quick?: boolean;
  meta?: { tokens: number; cached?: boolean; ageSec?: number; quick?: boolean };
}

interface Usage { usedToday: number; budget: number; remaining: number | null }

const QUICK_REPORTS: { name: string; label: string }[] = [
  { name: 'platform_summary', label: 'Summary' },
  { name: 'usage_by_model', label: 'By model' },
  { name: 'top_members', label: 'Top members' },
  { name: 'daily_trend', label: 'Daily trend' },
  { name: 'tool_failures', label: 'Tool failures' },
  { name: 'file_hotspots', label: 'File hotspots' },
  { name: 'friction_report', label: 'Rework' },
];

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

const SUGGESTION_GROUPS: { title: string; items: string[] }[] = [
  {
    title: 'Cost & models',
    items: [
      'Give me a platform summary for the last 30 days',
      'Which models cost the most per 100 changed lines?',
      'Which models have no pricing rule set?',
    ],
  },
  {
    title: 'People & teams',
    items: [
      'Who are the top 10 spenders this month and what models do they use?',
      'Which members have not synced in the last 7 days?',
      'Compare token usage across teams this month',
    ],
  },
  {
    title: 'Quality & tooling',
    items: [
      'Which agent tools fail most often?',
      'What is our abandonment and rework rate?',
      'Which files do agents edit the most?',
    ],
  },
  {
    title: 'Trends',
    items: [
      'How has daily cost trended over the last 14 days?',
      'Which weekday and hour is busiest?',
      'How much did we spend on cache reads vs fresh input?',
    ],
  },
];

// ── formatting helpers ──────────────────────────────────────────────────────

const isNumeric = (v: unknown): boolean =>
  typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim()));

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (isNumeric(v)) {
    const n = Number(v);
    if (Number.isInteger(n)) return n.toLocaleString();
    return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  return s;
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

function downloadCsv(name: string, columns: string[], rows: Record<string, unknown>[]) {
  const blob = new Blob([toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Markdown (no raw HTML is ever injected) ──────────────────────────────────

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i} className="font-semibold text-white">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i} className="rounded bg-[#0d0a07] px-1.5 py-0.5 text-[0.85em] text-[#f5c485]">{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++;
      out.push(<pre key={out.length} className="my-2 overflow-x-auto rounded-lg border border-[rgba(242,236,223,0.08)] bg-[#0d0a07] p-3 text-xs text-[#cbbfad]">{code.join('\n')}</pre>);
      continue;
    }

    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      out.push(
        <div key={out.length} className="my-3 overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.08)]">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-[#1c1712] text-[#8e8473]">
                {header.map((h, j) => <th key={j} className={`px-3 py-2 font-semibold ${rows.length && isNumeric((rows[0][j] || '').replace(/[$,%]/g, '')) ? 'text-right' : ''}`}>{inline(h)}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
              {rows.map((r, j) => (
                <tr key={j} className="hover:bg-[rgba(226,163,85,0.04)]">
                  {r.map((c, k) => <td key={k} className={`px-3 py-2 text-[#e8dfd0] ${isNumeric(c.replace(/[$,%]/g, '')) ? 'text-right tabular-nums' : ''}`}>{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*([-*•])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•])\s+/, ''));
      out.push(<ul key={out.length} className="my-2 list-disc space-y-1 pl-5">{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push(<ol key={out.length} className="my-2 list-decimal space-y-1 pl-5">{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>);
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(<div key={out.length} className={`mt-3 mb-1 font-semibold text-white ${h[1].length <= 2 ? 'text-[15px]' : 'text-sm'}`}>{inline(h[2])}</div>);
      i++;
      continue;
    }

    if (line.trim()) out.push(<p key={out.length} className="my-1.5">{inline(line)}</p>);
    i++;
  }
  return <div className="text-sm leading-relaxed text-[#e8dfd0]">{out}</div>;
}

// ── result visualisation ────────────────────────────────────────────────────

/** Horizontal bars for "label + numbers" results, with a picker when there are several metrics. */
function MiniBars({ step, hint = '' }: { step: Step; hint?: string }) {
  const r = step.result;
  const labelCol = r?.columns[0];
  const metricCols = React.useMemo(
    () => (r && labelCol ? r.columns.slice(1).filter((c) => r.rows.every((row) => isNumeric(row[c]))) : []),
    [r, labelCol],
  );
  const [picked, setPicked] = React.useState<string | null>(null);
  if (!r || !labelCol || r.rows.length < 2 || r.rows.length > 12 || metricCols.length === 0) return null;
  if (isNumeric(r.rows[0][labelCol])) return null;
  // Default to the metric the answer talks about (column name mentioned in the text), else the first one.
  const lowerHint = hint.toLowerCase();
  const hinted = metricCols.find((c) => lowerHint.includes(c.toLowerCase()) || lowerHint.includes(c.replace(/_/g, ' ').toLowerCase()));
  const valCol = picked && metricCols.includes(picked) ? picked : hinted ?? metricCols[0];
  const max = Math.max(...r.rows.map((row) => Math.abs(Number(row[valCol]))), 1e-9);
  return (
    <div className="mt-3 rounded-xl border border-[rgba(242,236,223,0.08)] bg-[#14100c] p-3" data-testid="chat-chart">
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-[#8e8473]">
        <span>{valCol.replace(/_/g, ' ')} by {labelCol.replace(/_/g, ' ')}</span>
        {metricCols.length > 1 && (
          <select
            value={valCol}
            onChange={(e) => setPicked(e.target.value)}
            aria-label="Chart metric"
            className="rounded-md border border-[rgba(242,236,223,0.1)] bg-[#1c1712] px-2 py-1 text-[11px] normal-case tracking-normal text-[#cbbfad] focus:outline-none"
          >
            {metricCols.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
          </select>
        )}
      </div>
      <div className="space-y-1.5">
        {r.rows.map((row, i) => (
          <div key={i} className="grid grid-cols-[minmax(80px,200px)_1fr_auto] items-center gap-3 text-xs">
            <span className="truncate text-[#cbbfad]" title={String(row[labelCol])}>{fmtCell(row[labelCol])}</span>
            <div className="h-2 rounded-full bg-[#0d0a07]">
              <div className="h-full rounded-full bg-gradient-to-r from-[#e2a355] to-[#f5c485]" style={{ width: `${Math.max(2, (Math.abs(Number(row[valCol])) / max) * 100)}%` }} />
            </div>
            <span className="tabular-nums text-white">{fmtCell(row[valCol])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepView({ step, defaultOpen = false }: { step: Step; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const r = step.result;
  return (
    <div className="rounded-xl border border-[rgba(242,236,223,0.08)] bg-[#0d0a07] text-xs" data-testid="chat-step">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[#cbbfad] hover:text-white" aria-expanded={open}>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="font-mono font-semibold text-[#f5c485]">{step.tool}</span>
        <span className={step.ok ? 'text-emerald-400' : 'text-red-400'}>
          {step.ok ? `${r?.rowCount ?? 0} row${r?.rowCount === 1 ? '' : 's'}${r?.truncated ? ' (capped at 200)' : ''}` : 'failed'}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          {step.error && <div className="text-red-400">{step.error}</div>}
          {step.sql && <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-[#14100c] p-2.5 text-[11px] text-[#8e8473]">{step.sql}</pre>}
          {r && r.rows.length > 0 && (
            <>
              <div className="max-h-72 overflow-auto rounded-lg border border-[rgba(242,236,223,0.06)]">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-[#1c1712] text-[#8e8473]">
                    <tr>{r.columns.map((c) => <th key={c} className={`whitespace-nowrap px-2.5 py-1.5 ${isNumeric(r.rows[0][c]) ? 'text-right' : ''}`}>{c}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                    {r.rows.slice(0, 100).map((row, i) => (
                      <tr key={i} className="hover:bg-[rgba(226,163,85,0.04)]">
                        {r.columns.map((c) => <td key={c} className={`whitespace-nowrap px-2.5 py-1.5 text-[#cbbfad] ${isNumeric(row[c]) ? 'text-right tabular-nums' : ''}`}>{fmtCell(row[c])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button onClick={() => downloadCsv(step.tool, r.columns, r.rows)} className="inline-flex items-center gap-1.5 text-[#8e8473] hover:text-white">
                <Download className="h-3.5 w-3.5" /> Download CSV ({r.rows.length} rows)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch { /* clipboard unavailable */ }
      }}
      className="inline-flex items-center gap-1 text-[11px] text-[#8e8473] hover:text-white"
      aria-label="Copy answer"
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />} {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return (
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${role === 'assistant' ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400' : 'border-[rgba(226,163,85,0.3)] bg-[rgba(226,163,85,0.15)] text-[#f5c485]'}`}>
      {role === 'assistant' ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
    </div>
  );
}

export function AdminChatView() {
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState('');
  const [liveSteps, setLiveSteps] = React.useState<Step[]>([]);
  const endRef = React.useRef<HTMLDivElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy, status, liveSteps]);

  // Auto-grow the textarea up to ~6 lines.
  React.useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [input]);

  const stop = () => abortRef.current?.abort();

  const [usage, setUsage] = React.useState<Usage | null>(null);
  const refreshUsage = React.useCallback(async () => {
    try {
      const r = await fetch('/api/admin/chat');
      if (r.ok) setUsage(await r.json());
    } catch { /* meter is informational */ }
  }, []);
  React.useEffect(() => { refreshUsage(); }, [refreshUsage]);

  // Only real conversation goes to the AI: no errors, and never the (large) quick-report tables.
  const aiHistory = (list: Msg[]) => list.filter((m) => !m.error && !m.quick).map((m) => ({ role: m.role, content: m.content }));

  /** Shared streaming runner for AI questions and quick reports. */
  const run = async (payload: Record<string, unknown>, next: Msg[], opts: { quick?: boolean; statusText: string }) => {
    setMessages(next);
    setBusy(true);
    setStatus(opts.statusText);
    setLiveSteps([]);

    const controller = new AbortController();
    abortRef.current = controller;
    const collected: Step[] = [];

    try {
      const res = await fetch('/api/admin/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalReply: string | null = null;
      let meta: Msg['meta'];
      let errorText: string | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let evt: { type: string; text?: string; step?: Step; reply?: string; error?: string; usage?: { total: number }; cached?: boolean; ageSec?: number; quick?: boolean };
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === 'status' && evt.text) setStatus(evt.text);
          else if (evt.type === 'step' && evt.step) {
            collected.push(evt.step);
            setLiveSteps([...collected]);
          } else if (evt.type === 'final') {
            finalReply = evt.reply ?? '';
            meta = { tokens: evt.usage?.total ?? 0, cached: evt.cached, ageSec: evt.ageSec, quick: evt.quick };
          } else if (evt.type === 'error') errorText = evt.error ?? 'Something went wrong.';
        }
      }

      if (errorText) throw new Error(errorText);
      setMessages([...next, { role: 'assistant', content: finalReply ?? 'No answer was returned.', steps: collected, meta, quick: opts.quick }]);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setMessages([...next, { role: 'assistant', content: 'Stopped.', steps: collected, error: true }]);
      } else {
        setMessages([...next, { role: 'assistant', content: (err as Error).message, error: true }]);
      }
    } finally {
      setBusy(false);
      setStatus('');
      setLiveSteps([]);
      abortRef.current = null;
      taRef.current?.focus();
      refreshUsage();
    }
  };

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    setInput('');
    const next: Msg[] = [...messages, { role: 'user', content }];
    await run({ messages: aiHistory(next) }, next, { statusText: 'Thinking…' });
  };

  /** Re-ask the same question ignoring the 10-minute answer cache. */
  const rerunFresh = async (assistantIndex: number) => {
    if (busy) return;
    const next = messages.slice(0, assistantIndex);
    await run({ messages: aiHistory(next), fresh: true }, next, { statusText: 'Thinking…' });
  };

  /** Prebuilt report: plain SQL, no AI, no tokens. */
  const quick = async (name: string, label: string) => {
    if (busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: `⚡ ${label} (last 30 days)`, quick: true }];
    await run({ quick: { name, days: 30 } }, next, { quick: true, statusText: `Running ${label.toLowerCase()}…` });
  };

  const visibleSteps = (steps?: Step[]) => (steps || []).filter((s) => s.tool !== 'get_schema');
  const lastChartStep = (steps?: Step[]) => [...visibleSteps(steps)].reverse().find((s) => s.ok);

  return (
    <div className="flex h-[calc(100vh-12rem)] min-h-[460px] animate-fadeIn flex-col font-mono">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-500/25 bg-gradient-to-r from-[rgba(16,185,129,0.12)] via-[#14100c] to-[rgba(226,163,85,0.08)] px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-emerald-500/20 p-2 text-emerald-400"><Sparkles className="h-5 w-5" /></div>
          <div>
            <h2 className="text-base font-bold text-white">Ask the Data</h2>
            <p className="text-[11px] text-[#8e8473]">Answers come from live, read-only database queries — expand a step to see the SQL.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {usage && (
            <span
              className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px] ${usage.budget > 0 && usage.usedToday >= usage.budget ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-[rgba(242,236,223,0.1)] text-[#cbbfad]'}`}
              title={usage.budget > 0 ? `AI tokens used today (UTC). Daily budget ${usage.budget.toLocaleString()}. Quick reports and cached answers cost nothing.` : 'AI tokens used today. No daily budget set.'}
              data-testid="chat-usage"
            >
              <Zap className="h-3.5 w-3.5 text-[#e2a355]" />
              AI tokens today: {fmtTokens(usage.usedToday)}{usage.budget > 0 ? ` / ${fmtTokens(usage.budget)}` : ''}
              {usage.budget > 0 && (
                <span className="h-1.5 w-12 overflow-hidden rounded-full bg-[#0d0a07]">
                  <span className="block h-full rounded-full bg-[#e2a355]" style={{ width: `${Math.min(100, (usage.usedToday / usage.budget) * 100)}%` }} />
                </span>
              )}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300" title="Prompt text, credentials, API keys, audit logs and raw event payloads are blocked at the database level. Conversations are not saved in your browser.">
            <ShieldCheck className="h-3.5 w-3.5" /> Read-only · private fields excluded
          </span>
          {messages.length > 0 && !busy && (
            <button onClick={() => setMessages([])} className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(242,236,223,0.1)] px-2.5 py-1 text-[11px] text-[#cbbfad] hover:text-white">
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Conversation */}
      <div className="flex-1 space-y-5 overflow-y-auto rounded-2xl border border-[rgba(242,236,223,0.08)] bg-[#14100c]/90 p-4" aria-live="polite">
        {messages.length === 0 && !busy && (
          <div className="mx-auto flex h-full max-w-4xl flex-col justify-center gap-5">
            <div className="text-center">
              <p className="text-sm text-white">What would you like to know?</p>
              <p className="mt-1 text-xs text-[#8e8473]">Ask in plain English. Pick a starter or type your own question below.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {SUGGESTION_GROUPS.map((g) => (
                <div key={g.title} className="rounded-xl border border-[rgba(242,236,223,0.08)] bg-[#1c1712]/60 p-3">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#e2a355]">{g.title}</div>
                  <div className="space-y-1.5">
                    {g.items.map((s) => (
                      <button key={s} onClick={() => send(s)} className="block w-full rounded-lg px-2.5 py-2 text-left text-xs text-[#cbbfad] transition-colors hover:bg-[rgba(226,163,85,0.08)] hover:text-white">
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          const chart = m.role === 'assistant' && !m.error ? lastChartStep(m.steps) : undefined;
          const steps = visibleSteps(m.steps);
          return (
            <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`} data-testid={`chat-msg-${m.role}`}>
              <Avatar role={m.role} />
              <div className="min-w-0 max-w-[88%]">
                <div className={`rounded-2xl px-4 py-3 ${
                  m.role === 'user'
                    ? 'border border-[rgba(226,163,85,0.3)] bg-[rgba(226,163,85,0.14)] text-sm text-white'
                    : m.error
                      ? 'border border-red-500/30 bg-red-500/10 text-sm text-red-300'
                      : 'border border-[rgba(242,236,223,0.08)] bg-[#1c1712]'
                }`}>
                  {m.role === 'assistant' && !m.error ? <Markdown text={m.content} /> : <div className="whitespace-pre-wrap break-words">{m.content}</div>}
                  {chart && <MiniBars step={chart} hint={m.content} />}
                </div>
                {m.role === 'assistant' && !m.error && (
                  <div className="mt-1.5 flex items-center gap-3 px-1">
                    <CopyButton text={m.content} />
                    {steps.length > 0 && <span className="text-[11px] text-[#8e8473]">{steps.length} quer{steps.length === 1 ? 'y' : 'ies'} run</span>}
                    {m.meta && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-[#8e8473]" data-testid="chat-tokens">
                        <Zap className="h-3 w-3 text-[#e2a355]" />
                        {m.meta.quick ? 'no AI tokens' : m.meta.cached ? `cached${m.meta.ageSec ? ` (${Math.max(1, Math.round(m.meta.ageSec / 60))}m old)` : ''} · 0 tokens` : `${m.meta.tokens.toLocaleString()} tokens`}
                      </span>
                    )}
                    {m.meta?.cached && (
                      <button onClick={() => rerunFresh(i)} disabled={busy} className="inline-flex items-center gap-1 text-[11px] text-[#8e8473] hover:text-white disabled:opacity-40">
                        <RefreshCw className="h-3 w-3" /> Re-run fresh
                      </button>
                    )}
                  </div>
                )}
                {steps.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {steps.map((s, j) => <StepView key={j} step={s} defaultOpen={m.role === 'assistant' && !m.meta?.quick && j === steps.length - 1} />)}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {busy && (
          <div className="flex gap-3">
            <Avatar role="assistant" />
            <div className="min-w-0 max-w-[88%] space-y-2">
              <div className="inline-flex items-center gap-2 rounded-2xl border border-[rgba(242,236,223,0.08)] bg-[#1c1712] px-4 py-3 text-xs text-[#cbbfad]">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
                <span data-testid="chat-status">{status || 'Working…'}</span>
              </div>
              {liveSteps.map((s, j) => <StepView key={j} step={s} />)}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="chat-quick">
        <span className="mr-1 inline-flex items-center gap-1 text-[11px] text-[#8e8473]"><Zap className="h-3 w-3 text-[#e2a355]" /> Quick reports · no AI tokens</span>
        {QUICK_REPORTS.map((q) => (
          <button
            key={q.name}
            onClick={() => quick(q.name, q.label)}
            disabled={busy}
            className="rounded-lg border border-[rgba(242,236,223,0.1)] bg-[#1c1712] px-2.5 py-1 text-[11px] text-[#cbbfad] transition-colors hover:border-[rgba(226,163,85,0.4)] hover:text-white disabled:opacity-40"
          >
            {q.label}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="mt-2">
        <div className="flex items-end gap-2 rounded-2xl border border-[rgba(242,236,223,0.1)] bg-[#1c1712] p-2 focus-within:border-[#e2a355]">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); } }}
            rows={1}
            maxLength={4000}
            disabled={busy}
            placeholder="Ask a question about your data…"
            aria-label="Ask a question about your data"
            data-testid="chat-input"
            className="max-h-36 flex-1 resize-none bg-transparent px-3 py-2 text-sm text-white placeholder-[#8e8473] focus:outline-none disabled:opacity-60"
          />
          {busy ? (
            <button type="button" onClick={stop} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/20 text-red-300 hover:bg-red-500/30" aria-label="Stop generating" title="Stop">
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Send">
              <ArrowUp className="h-5 w-5" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex justify-between px-2 text-[10.5px] text-[#8e8473]">
          <span>Enter to send · Shift+Enter for a new line</span>
          {input.length > 3000 && <span>{input.length}/4000</span>}
        </div>
      </form>
    </div>
  );
}
