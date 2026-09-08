'use client';

import * as React from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCompactNumber, formatCurrency } from '@/lib/utils';
import { Sparkles, Terminal, Activity, FileCode, Clock, ShieldCheck, Copy, Check } from 'lucide-react';
import confetti from 'canvas-confetti';
import { toast } from 'sonner';

export interface MemberDetailData {
  id: string;
  name: string;
  role: string;
  team: string;
  totalTokens: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  apiCost: number;
  sessionsCount: number;
  editsCount: number;
  linesDiff: number;
  daemonVersion?: string;
  lastSeen?: string;
  topTools?: { tool: string; calls: number }[];
  recentSessions?: { id: string; time: string; tokens: number; cost: number; source: string; status: string }[];
}

interface MemberDetailSheetProps {
  member: MemberDetailData | null;
  isOpen: boolean;
  onClose: () => void;
}

export function MemberDetailSheet({ member, isOpen, onClose }: MemberDetailSheetProps) {
  const [copiedKey, setCopiedKey] = React.useState(false);

  if (!member) return null;

  const handleCopyId = () => {
    navigator.clipboard.writeText(member.id);
    setCopiedKey(true);
    toast.success('Member ID copied to clipboard');
    confetti({ particleCount: 25, spread: 45, origin: { y: 0.7 } });
    setTimeout(() => setCopiedKey(false), 2000);
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl bg-[var(--surface)] text-[var(--ink)]">
        <SheetHeader>
          <div className="flex items-center justify-between pr-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--brand-dim)] text-lg font-bold text-[var(--brand-hi)] border border-[rgba(226,163,85,0.3)] shadow-inner">
                {member.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <SheetTitle className="text-lg flex items-center gap-2">
                  {member.name}
                  <Badge variant="copper" className="text-[10px]">{member.role}</Badge>
                </SheetTitle>
                <SheetDescription className="flex items-center gap-2 mt-0.5">
                  <span>{member.team}</span>
                  <span>•</span>
                  <span className="font-mono text-[11px] text-[var(--muted)]">ID: {member.id.slice(0, 8)}...</span>
                </SheetDescription>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={handleCopyId} className="h-7 text-xs gap-1.5">
              {copiedKey ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedKey ? 'Copied' : 'Copy ID'}
            </Button>
          </div>
        </SheetHeader>

        {/* Live Status & Daemon Badge */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--raised)] p-3 border border-[var(--border)]">
          <div className="flex items-center gap-2 text-xs">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
            </span>
            <span className="font-medium text-emerald-400">Live Agent Daemon</span>
            <span className="text-[var(--muted)]">v{member.daemonVersion || '0.2.2'}</span>
          </div>
          <div className="text-[11px] text-[var(--muted)] flex items-center gap-1 font-mono">
            <Clock className="h-3 w-3" />
            Last active {member.lastSeen || 'just now'}
          </div>
        </div>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-3 gap-2.5 mb-6">
          <div className="rounded-xl bg-[var(--raised)] p-3 border border-[var(--border)]">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Total Tokens</div>
            <div className="mt-1 text-lg font-bold font-mono text-[var(--brand-hi)]">
              {formatCompactNumber(member.totalTokens)}
            </div>
            <div className="text-[10px] text-[var(--muted)] mt-0.5">
              {formatCompactNumber(member.tokensIn)} In / {formatCompactNumber(member.tokensOut)} Out
            </div>
          </div>

          <div className="rounded-xl bg-[var(--raised)] p-3 border border-[var(--border)]">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">API Spend</div>
            <div className="mt-1 text-lg font-bold font-mono text-emerald-400">
              {formatCurrency(member.apiCost)}
            </div>
            <div className="text-[10px] text-[var(--muted)] mt-0.5">
              Cache saved {formatCompactNumber(member.tokensCacheRead)}
            </div>
          </div>

          <div className="rounded-xl bg-[var(--raised)] p-3 border border-[var(--border)]">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Executions</div>
            <div className="mt-1 text-lg font-bold font-mono text-[var(--ink)]">
              {member.sessionsCount}
            </div>
            <div className="text-[10px] text-[var(--muted)] mt-0.5">
              {member.editsCount} code edits
            </div>
          </div>
        </div>

        {/* Token Distribution Bar */}
        <div className="mb-6 rounded-xl bg-[var(--raised)] p-4 border border-[var(--border)]">
          <div className="flex items-center justify-between text-xs font-semibold mb-2">
            <span className="flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 text-[var(--brand)]" /> Token Flow Composition</span>
            <span className="font-mono text-[11px] text-[var(--muted)]">{((member.tokensCacheRead / Math.max(1, member.totalTokens)) * 100).toFixed(0)}% Cache Efficiency</span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-black/40 overflow-hidden flex">
            <div style={{ width: `${Math.max(5, (member.tokensIn / Math.max(1, member.totalTokens)) * 100)}%` }} className="bg-blue-500" title="Input Tokens" />
            <div style={{ width: `${Math.max(5, (member.tokensOut / Math.max(1, member.totalTokens)) * 100)}%` }} className="bg-pink-500" title="Output Tokens" />
            <div style={{ width: `${Math.max(5, (member.tokensCacheRead / Math.max(1, member.totalTokens)) * 100)}%` }} className="bg-emerald-500" title="Cache-Read" />
          </div>
          <div className="flex items-center justify-between mt-2.5 text-[11px] text-[var(--muted)] font-mono">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500 inline-block" /> In: {formatCompactNumber(member.tokensIn)}</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-pink-500 inline-block" /> Out: {formatCompactNumber(member.tokensOut)}</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" /> Cache: {formatCompactNumber(member.tokensCacheRead)}</span>
          </div>
        </div>

        {/* Top Tools Called */}
        <div className="mb-6">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2.5 flex items-center gap-1.5">
            <Terminal className="h-3.5 w-3.5 text-[var(--brand)]" /> Top Agent Tools Invoked
          </h4>
          <div className="space-y-1.5">
            {(member.topTools || [
              { tool: 'read_file', calls: 342 },
              { tool: 'edit_file', calls: 189 },
              { tool: 'run_command', calls: 94 },
              { tool: 'search_web', calls: 31 },
            ]).map((t, idx) => (
              <div key={idx} className="flex items-center justify-between rounded-lg bg-[var(--wash)] px-3 py-2 text-xs border border-[var(--border)]">
                <span className="font-mono text-[var(--ink-2)]">{t.tool}</span>
                <span className="font-mono font-semibold text-[var(--brand-hi)]">{t.calls} calls</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="mt-8 pt-4 border-t border-[var(--border)] flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close Inspector
          </Button>
          <Button variant="primary" size="sm" onClick={() => toast.info(`Viewing full session trajectories for ${member.name}`)}>
            View All Prompts →
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
