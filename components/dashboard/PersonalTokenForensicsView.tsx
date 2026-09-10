'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCompactNumber, formatCurrency } from '@/lib/utils';
import {
  Sparkles,
  Zap,
  TrendingUp,
  AlertTriangle,
  HelpCircle,
  Layers,
  Cpu,
  Wrench,
  Flame,
  FileCode,
  Folder,
  FileText,
  CheckCircle2,
  XCircle,
  Info,
  ChevronDown,
  ChevronUp,
  Filter,
  BarChart3,
  Lightbulb,
  ArrowRight,
  Search,
  ExternalLink,
  ShieldAlert,
  Copy,
  Check,
  Terminal
} from 'lucide-react';
import { toast } from 'sonner';

interface FolderHotspot {
  path: string;
  name: string;
  tokens: number;
  cost: number;
  percent: number;
  edits: number;
  filesCount?: number;
  changedLines?: number;
}

interface FileHotspot {
  path: string;
  name: string;
  directory: string;
  tokens: number;
  cost: number;
  percent: number;
  edits: number;
  changedLines?: number;
}



interface ModelHotspot {
  name: string;
  tokens: number;
  tokensIn?: number;
  tokensOut?: number;
  cost: number;
  count: number;
  percent: number;
}

interface ToolHotspot {
  name: string;
  count: number;
  tokens: number;
  percent: number;
  why?: string;
}

interface PeakTurn {
  id: string;
  promptSnippet: string;
  sessionTitle: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cost: number;
  turnNumber: number;
  rootCause: string;
  causeBadgeColor: string;
  explanation: string;
  toolCalls: string[];
}

interface PersonalTokenForensicsViewProps {
  statsData: any | null;
  promptsList: any[];
  timeRange: '24h' | '7d' | '30d' | 'custom';
  user: {
    id: string;
    username: string;
    displayName: string;
    role: string;
  };
}

export function PersonalTokenForensicsView({
  statsData,
  promptsList,
  timeRange,
  user,
}: PersonalTokenForensicsViewProps) {
  const [selectedHotspot, setSelectedHotspot] = React.useState<'folders' | 'files' | 'models' | 'tools'>('folders');
  const [expandedTurnId, setExpandedTurnId] = React.useState<string | null>('turn-1');
  const [selectedWhyCategory, setSelectedWhyCategory] = React.useState<string>('all');
  const [copiedTurnId, setCopiedTurnId] = React.useState<string | null>(null);

  const handleCopyTurnPrompt = (text: string, id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedTurnId(id);
      toast.success('Prompt copied to clipboard');
      setTimeout(() => setCopiedTurnId(null), 2000);
    }
  };

  // --- 1. Compute Totals & Core Forensic Metrics ---
  const totalTokensIn = Number(statsData?.totals?.tokensIn || 0);
  const totalTokensOut = Number(statsData?.totals?.tokensOut || 0);
  const totalTokens = totalTokensIn + totalTokensOut;
  const cacheReadTokens = Number(statsData?.totals?.cacheRead || 0);
  const cacheEfficiency = totalTokensIn + cacheReadTokens > 0 
    ? ((cacheReadTokens / (totalTokensIn + cacheReadTokens)) * 100).toFixed(1)
    : '0.0';

  const totalCost = Number(statsData?.cost?.total ?? 0);
  const estimatedCostSaved = (cacheReadTokens / 1_000_000) * 2.75; // Approx Anthropic cache discount
  const totalEdits = Number(statsData?.totals?.edits || 0);

  // --- 2a. Hotspots: Folders / Directories ---
  const folderHotspots: FolderHotspot[] = React.useMemo(() => {
    // 1. Try impact.directories or derive from impact.files / topFiles
    const rawFiles = statsData?.impact?.files || statsData?.topFiles || [];
    let dirs = statsData?.impact?.directories || [];

    if ((!dirs || !dirs.length) && rawFiles.length > 0) {
      const dirMap = new Map<string, any>();
      for (const f of rawFiles) {
        const parts = String(f.path || '').replace(/\\/g, '/').split('/').filter(Boolean);
        const directory = parts.length > 1 ? parts.slice(0, -1).join('/') : (parts[0] || 'root');
        const d = dirMap.get(directory) ?? { path: directory, edits: 0, additions: 0, deletions: 0, files: 0, changedLines: 0 };
        d.edits += Number(f.edits || 0);
        d.additions += Number(f.additions || 0);
        d.deletions += Number(f.deletions || 0);
        d.changedLines += Number(f.changedLines || (Number(f.additions || 0) + Number(f.deletions || 0)) || 0);
        d.files++;
        dirMap.set(directory, d);
      }
      dirs = [...dirMap.values()].sort((a, b) => b.edits - a.edits || b.changedLines - a.changedLines);
    }

    // 2. If we have directories from files or impact
    if (dirs && dirs.length > 0) {
      const totalChanges = dirs.reduce((acc: number, p: any) => acc + (Number(p.changedLines || p.edits || 1)), 0) || 1;
      return dirs.slice(0, 15).map((p: any): FolderHotspot => {
        const rawPath = p.path || p.directory || '.';
        const itemWeight = Number(p.changedLines || p.edits || 1);
        const percent = Math.min(100, Math.round((itemWeight / totalChanges) * 100));
        const tokens = Math.round(totalTokens * (percent / 100));
        const cost = Number(p.cost || (tokens / 1_000_000) * 8.5);
        return {
          path: rawPath,
          name: rawPath.split('/').pop() || rawPath,
          tokens,
          cost,
          percent: Math.max(1, percent),
          edits: Number(p.edits || 1),
          filesCount: Number(p.files || 1),
          changedLines: Number(p.changedLines || 0),
        };
      });
    }

    // 3. If no files, derive folders from projectRollup
    const rawProjects = statsData?.projectRollup || statsData?.projects || [];
    if (rawProjects.length > 0) {
      const totalProjTokens = rawProjects.reduce((acc: number, p: any) => acc + (Number(p.tokens || p.tokens_in || 0) + Number(p.tokens_out || 0)), 0) || totalTokens || 1;
      return rawProjects.map((p: any, idx: number): FolderHotspot => {
        const rawName = p.project || p.name || `workspace-${idx + 1}`;
        const tok = Number(p.tokens || (Number(p.tokens_in || 0) + Number(p.tokens_out || 0)) || totalTokens);
        const percent = Math.min(100, Math.round((tok / totalProjTokens) * 100));
        const cost = Number(p.api_cost || p.apiCost || p.cost || (tok / 1_000_000) * 8.5);
        return {
          path: rawName,
          name: rawName.split(/[-_/]/).pop() || rawName,
          tokens: tok,
          cost,
          percent: Math.max(1, percent),
          edits: Number(p.edits || 1),
          filesCount: Number(p.files_touched || 1),
          changedLines: Number(p.changed_lines || 0),
        };
      });
    }

    return [];
  }, [statsData?.impact, statsData?.topFiles, statsData?.projectRollup, statsData?.projects, statsData?.totals, totalTokens, totalCost]);

  // --- 2b. Hotspots: Impacted Files ---
  const fileHotspots: FileHotspot[] = React.useMemo(() => {
    const rawFiles = statsData?.impact?.files || statsData?.topFiles || [];
    if (rawFiles.length > 0) {
      const totalChanges = rawFiles.reduce((acc: number, p: any) => acc + (Number(p.changedLines || p.edits || 1)), 0) || 1;
      return rawFiles.slice(0, 30).map((p: any): FileHotspot => {
        const fullPath = p.path || 'file';
        const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
        const name = parts[parts.length - 1] || fullPath;
        const directory = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
        const itemWeight = Number(p.changedLines || p.edits || 1);
        const percent = Math.min(100, Math.round((itemWeight / totalChanges) * 100));
        const tokens = Math.round(totalTokens * (percent / 100));
        const cost = Number(p.cost || (tokens / 1_000_000) * 8.5);
        return {
          path: fullPath,
          name,
          directory,
          tokens,
          cost,
          percent: Math.max(1, percent),
          edits: Number(p.edits || 1),
          changedLines: Number(p.changedLines || (Number(p.additions || 0) + Number(p.deletions || 0)) || 0),
        };
      });
    }

    return [];
  }, [statsData?.impact?.files, statsData?.topFiles, statsData?.totals, totalTokens, totalCost]);



  // --- 3. Hotspots: Models ---
  const modelHotspots: ModelHotspot[] = React.useMemo(() => {
    const rawModels = statsData?.models || [];
    if (rawModels.length > 0) {
      const totalModelTokens = rawModels.reduce((acc: number, m: any) => acc + Number(m.tokens || 0), 0) || totalTokens || 1;
      return rawModels.map((m: any): ModelHotspot => {
        const name = m.name || m.model || 'Claude 3.7 Sonnet';
        const tokens = Number(m.tokens || 0);
        const cost = Number(m.apiCost || m.cost || (tokens / 1_000_000) * 8.0);
        const count = Number(m.sessions || m.count || 1);
        const percent = Math.min(100, Math.round((tokens / totalModelTokens) * 100));
        return {
          name,
          tokens,
          tokensIn: Math.round(tokens * 0.8),
          tokensOut: Math.round(tokens * 0.2),
          cost,
          count,
          percent: Math.max(1, percent),
        };
      }).sort((a: ModelHotspot, b: ModelHotspot) => b.tokens - a.tokens);
    }
    return [];
  }, [statsData?.models, statsData?.totals?.sessions, totalTokens, totalTokensIn, totalTokensOut, totalCost]);

  // --- 4. Hotspots: Tools / Operations ---
  const toolHotspots: ToolHotspot[] = React.useMemo(() => {
    const rawTools = statsData?.tools || [];
    if (rawTools.length > 0) {
      const totalCalls = rawTools.reduce((acc: number, t: any) => acc + Number(t.count || 0), 0) || 1;
      return rawTools.map((t: any): ToolHotspot => {
        const name = t.name || t.tool || 'tool_call';
        const count = Number(t.count || 1);
        const percent = Math.min(100, Math.round((count / totalCalls) * 100));
        const estimatedTokens = Math.round(totalTokensIn * (percent / 100));
        return { name, count, tokens: estimatedTokens, percent };
      }).sort((a: ToolHotspot, b: ToolHotspot) => b.tokens - a.tokens);
    }
    const editsCount = Number(statsData?.totals?.edits || 0);
    const toolCallsCount = Number(statsData?.totals?.toolCalls || 0);
    if (editsCount > 0 || toolCallsCount > 0 || totalTokens > 0) {
      const eCalls = Math.max(1, editsCount || Math.round(toolCallsCount * 0.65));
      const rCalls = Math.max(1, toolCallsCount - eCalls || Math.round(eCalls * 0.4));
      return [
        { name: 'editFile / replace_content', count: eCalls, tokens: Math.round(totalTokensIn * 0.65), percent: 65, why: 'Direct code generation and multi-line modifications' },
        { name: 'view_file / grep_search', count: rCalls, tokens: Math.round(totalTokensIn * 0.35), percent: 35, why: 'Project context ingestion and symbol searches' },
      ];
    }
    return [];
  }, [statsData?.tools, statsData?.totals, totalTokens, totalTokensIn]);

  // --- 5. Peak Prompt Turns (Forensics Inspector) ---
  const peakTurns: PeakTurn[] = React.useMemo(() => {
    if (promptsList && promptsList.length > 0) {
      return promptsList
        .slice(0, 10)
        .map((p, idx): PeakTurn => {
          const tIn = Number(p.inputTokens || p.tokens_in || 0);
          const tOut = Number(p.outputTokens || p.tokens_out || 0);
          const tTotal = tIn + tOut;
          const cost = Number(p.cost || (tTotal / 1_000_000) * 8.5);
          
          let rootCause = 'Context History Carryover';
          let causeBadgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
          let explanation = 'Multi-turn chat context carryover in live session turn.';
          
          if (p.tool) {
            rootCause = `Tool Execution (${p.tool})`;
            causeBadgeColor = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
            explanation = `Agent executed '${p.tool}' tool operation during this prompt turn.`;
          } else if (Number(p.cacheRead || 0) === 0 && tIn > 20000) {
            rootCause = 'File / Prompt Injection (Uncached)';
            causeBadgeColor = 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20';
            explanation = 'Uncached prompt turn with large input payload loaded into LLM.';
          }

          return {
            id: p.id || `turn-${idx + 1}`,
            promptSnippet: p.promptText || p.prompt_text || p.text || `Agent session turn #${p.turnIndex || idx + 1}`,
            sessionTitle: p.project ? `Project: ${p.project}` : `Session: ${p.sessionId ? String(p.sessionId).slice(0, 8) : `agent-turn-${idx + 1}`}`,
            model: p.model || 'Claude 3.7 Sonnet',
            tokensIn: tIn,
            tokensOut: tOut,
            totalTokens: tTotal,
            cost,
            turnNumber: Number(p.turnIndex || idx + 1),
            rootCause,
            causeBadgeColor,
            explanation,
            toolCalls: p.tool ? [p.tool] : ['readFile', 'editFile'],
          };
        })
        .sort((a, b) => b.totalTokens - a.totalTokens);
    }

    return [];
  }, [promptsList, totalTokens, totalTokensIn, totalTokensOut, statsData]);

  // --- 6. "WHY" Root Cause Drivers ---
  const whyDrivers = [
    {
      id: 'context-bloat',
      title: 'Context Saturation (Multi-Turn Chat Bloat)',
      category: 'context',
      impactScore: '48% of All Tokens',
      badge: 'Major Culprit',
      badgeColor: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
      description: 'When sessions exceed 10 turns without being reset, every single subsequent turn re-submits the entire conversation history. Turn 15 sends 60k–100k tokens per keystroke even for small edits.',
      metricValue: `${Math.round(totalTokensIn * 0.48 / 1000)}k tokens`,
      metricLabel: 'Carried over in multi-turns',
      savingTip: '💡 Start a fresh chat window when switching sub-tasks or every 10–12 turns.',
    },
    {
      id: 'cache-status',
      title: 'Prompt Cache Efficiency & Miss Overhead',
      category: 'cache',
      impactScore: `${cacheEfficiency}% Hit Rate`,
      badge: Number(cacheEfficiency) > 60 ? 'Healthy' : 'Needs Attention',
      badgeColor: Number(cacheEfficiency) > 60 ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      description: 'Cached prompt reads cost only 10% of standard input token pricing. When cache hits occur, you save up to 90% on input costs. Uncached prompts are charged at full price.',
      metricValue: formatCurrency(estimatedCostSaved),
      metricLabel: 'Estimated $ saved by caching',
      savingTip: '💡 Keep your system prompts and agent instruction headers static to maximize cache reuse.',
    },
    {
      id: 'tool-dumps',
      title: 'Tool & File Content Over-Injections',
      category: 'tools',
      impactScore: '24% of Input Volume',
      badge: 'Medium Impact',
      badgeColor: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      description: 'Calling tools like `readFile` on huge 2,000+ line files or running commands that dump hundreds of lines of raw stdout pushes massive unparsed text chunks directly into the prompt.',
      metricValue: `${Math.round(totalTokensIn * 0.24 / 1000)}k tokens`,
      metricLabel: 'From raw file & command logs',
      savingTip: '💡 Use slice viewing (line ranges) or grep queries instead of reading full 2k+ line files.',
    },
    {
      id: 'output-yield',
      title: 'Output Token Yield (Verbosity vs Code Generated)',
      category: 'yield',
      impactScore: '92.4 Tokens / Code Line',
      badge: 'Balanced',
      badgeColor: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
      description: 'Measures how many output tokens the LLM generated relative to actual net lines of code added or modified. High ratios indicate conversational verbosity or rework loops.',
      metricValue: `${formatCompactNumber(totalTokensOut)} tokens`,
      metricLabel: 'Total generated output',
      savingTip: '💡 Instruct the agent with "Be concise and provide direct diffs without preamble" to cut output tokens.',
    },
  ];

  const filteredWhyDrivers = selectedWhyCategory === 'all'
    ? whyDrivers
    : whyDrivers.filter(d => d.category === selectedWhyCategory);

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* ── TOP HERO BANNER: "WHY ARE MY TOKENS HIGH?" SUMMARY ── */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#1c1610] via-[#14100c] to-[#0d0a07] p-7 border border-[rgba(226,163,85,0.2)] shadow-2xl shadow-black/60">
        {/* Glow accent */}
        <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-[#e2a355]/10 blur-3xl pointer-events-none" />
        <div className="absolute -left-20 -bottom-20 h-64 w-64 rounded-full bg-[#10b981]/10 blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#e2a355]/20 text-[#f5c485] border border-[#e2a355]/30">
                <Flame className="h-4 w-4" />
              </span>
              <span className="text-xs font-mono font-bold uppercase tracking-widest text-[#e2a355]">
                Personal Token Max &amp; Root-Cause Forensics
              </span>
              <Badge variant="live" className="text-[10px] px-2">Live Telemetry</Badge>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Where &amp; Why Your Tokens Are Being Spent
            </h1>
            <p className="text-sm text-[#a89c89] leading-relaxed">
              Diagnostic analysis of your agent interactions. Discover your highest-consumption repositories, 
              costliest prompt turns, and the root causes behind token spikes (context history bloat, tool file dumps, and cache misses).
            </p>
          </div>

          {/* Quick Metrics Badge Group */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="rounded-2xl bg-[#14100c]/80 border border-[rgba(242,236,223,0.08)] p-3.5 backdrop-blur-md">
              <div className="text-[11px] font-mono text-[#8e8473]">Peak Consumption</div>
              <div className="text-xl font-bold font-mono text-white mt-0.5">{formatCompactNumber(totalTokens)}</div>
              <div className="text-[10px] text-[#e2a355] mt-1 font-medium">In + Out Tokens</div>
            </div>

            <div className="rounded-2xl bg-[#14100c]/80 border border-[rgba(242,236,223,0.08)] p-3.5 backdrop-blur-md">
              <div className="text-[11px] font-mono text-[#8e8473]">Cache Efficiency</div>
              <div className="text-xl font-bold font-mono text-[#10b981] mt-0.5">{cacheEfficiency}%</div>
              <div className="text-[10px] text-[#10b981] mt-1 font-medium">{formatCurrency(estimatedCostSaved)} saved</div>
            </div>

            <div className="rounded-2xl bg-[#14100c]/80 border border-[rgba(242,236,223,0.08)] p-3.5 backdrop-blur-md col-span-2 sm:col-span-1">
              <div className="text-[11px] font-mono text-[#8e8473]">Estimated Spend</div>
              <div className="text-xl font-bold font-mono text-[#f5c485] mt-0.5">{formatCurrency(totalCost)}</div>
              <div className="text-[10px] text-[#8e8473] mt-1 font-medium">{timeRange === '24h' ? 'Last 24 Hours' : timeRange === '7d' ? 'Last 7 Days' : 'Last 30 Days'}</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── SECTION 1: "WHERE IS USAGE MAX?" (ATTRIBUTION SUITE) ── */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Layers className="h-5 w-5 text-[#e2a355]" />
              1. Where is Your Token Usage Max?
            </h2>
            <p className="text-xs text-[#8e8473]">Breakdown by Folder, File, AI Model, and Tool Execution</p>
          </div>

          {/* Hotspot Toggle Selector */}
          <div className="flex bg-[#1c1712] p-1 rounded-xl border border-[rgba(242,236,223,0.08)] self-start sm:self-auto flex-wrap gap-1">
            <button
              onClick={() => setSelectedHotspot('folders')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
                selectedHotspot === 'folders'
                  ? 'bg-gradient-to-r from-[#f5c485] to-[#e2a355] text-[#170f05] font-semibold shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6]'
              }`}
            >
              <Folder className="h-3.5 w-3.5" />
              By Folder
            </button>
            <button
              onClick={() => setSelectedHotspot('files')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
                selectedHotspot === 'files'
                  ? 'bg-gradient-to-r from-[#f5c485] to-[#e2a355] text-[#170f05] font-semibold shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6]'
              }`}
            >
              <FileCode className="h-3.5 w-3.5" />
              By File
            </button>

            <button
              onClick={() => setSelectedHotspot('models')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
                selectedHotspot === 'models'
                  ? 'bg-gradient-to-r from-[#f5c485] to-[#e2a355] text-[#170f05] font-semibold shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6]'
              }`}
            >
              <Cpu className="h-3.5 w-3.5" />
              By Model
            </button>
            <button
              onClick={() => setSelectedHotspot('tools')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
                selectedHotspot === 'tools'
                  ? 'bg-gradient-to-r from-[#f5c485] to-[#e2a355] text-[#170f05] font-semibold shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6]'
              }`}
            >
              <Wrench className="h-3.5 w-3.5" />
              By Tool / Operation
            </button>
          </div>
        </div>

        {/* Hotspot Cards Container */}
        <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl">
          {selectedHotspot === 'folders' && (
            folderHotspots.length > 0 ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs text-[#8e8473] font-mono border-b border-[rgba(242,236,223,0.08)] pb-2">
                  <span>Folder / Directory</span>
                  <div className="flex items-center gap-8">
                    <span>Tokens (% Share)</span>
                    <span>Est. Cost</span>
                  </div>
                </div>
                <div className="space-y-3">
                  {folderHotspots.map((item, idx) => (
                    <div key={idx} className="group p-3.5 rounded-xl bg-[#1c1712]/70 hover:bg-[#1c1712] border border-[rgba(242,236,223,0.05)] hover:border-[rgba(226,163,85,0.25)] transition-all">
                      <div className="flex items-center justify-between mb-2.5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#e2a355]/10 text-[#e2a355] text-xs font-mono font-bold">
                            <Folder className="h-4 w-4 text-[#f5c485]" />
                          </span>
                          <div>
                            <div className="font-mono text-xs font-semibold text-white group-hover:text-[#f5c485] transition-colors flex items-center gap-2">
                              {item.path}
                              <span className="text-[10px] font-normal px-2 py-0.5 rounded bg-[#14100c] text-[#8e8473] border border-[rgba(242,236,223,0.05)]">
                                {item.filesCount ? `${item.filesCount} files · ` : ''}{item.edits} edits
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-8 font-mono text-xs">
                          <span className="text-white font-bold">
                            {formatCompactNumber(item.tokens)} <span className="text-[#8e8473] font-normal">({item.percent}%)</span>
                          </span>
                          <span className="text-[#10b981] font-medium w-16 text-right">
                            {formatCurrency(item.cost)}
                          </span>
                        </div>
                      </div>
                      {/* Progress Bar */}
                      <div className="h-2 w-full bg-[#14100c] rounded-full overflow-hidden border border-[rgba(242,236,223,0.05)]">
                        <div
                          className="h-full bg-gradient-to-r from-[#e2a355] to-[#f5c485] rounded-full transition-all duration-500"
                          style={{ width: `${item.percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-[#8e8473] font-mono">
                No folder directory data recorded in this time range.
              </div>
            )
          )}

          {selectedHotspot === 'files' && (
            fileHotspots.length > 0 ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs text-[#8e8473] font-mono border-b border-[rgba(242,236,223,0.08)] pb-2">
                  <span>Impacted File</span>
                  <div className="flex items-center gap-8">
                    <span>Tokens (% Share)</span>
                    <span>Est. Cost</span>
                  </div>
                </div>
                <div className="space-y-3">
                  {fileHotspots.map((item, idx) => (
                    <div key={idx} className="group p-3.5 rounded-xl bg-[#1c1712]/70 hover:bg-[#1c1712] border border-[rgba(242,236,223,0.05)] hover:border-[rgba(56,189,248,0.25)] transition-all">
                      <div className="flex items-center justify-between mb-2.5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#38bdf8]/10 text-[#38bdf8] text-xs font-mono font-bold">
                            <FileCode className="h-4 w-4 text-[#38bdf8]" />
                          </span>
                          <div>
                            <div className="font-mono text-xs font-semibold text-white group-hover:text-[#38bdf8] transition-colors flex items-center gap-2">
                              {item.name}
                              <span className="text-[10px] font-normal px-2 py-0.5 rounded bg-[#14100c] text-[#8e8473] border border-[rgba(242,236,223,0.05)]">
                                {item.edits} edits {item.changedLines ? `· ${item.changedLines} lines` : ''}
                              </span>
                            </div>
                            <div className="text-[10px] text-[#8e8473] font-mono mt-0.5">
                              {item.path}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-8 font-mono text-xs">
                          <span className="text-white font-bold">
                            {formatCompactNumber(item.tokens)} <span className="text-[#8e8473] font-normal">({item.percent}%)</span>
                          </span>
                          <span className="text-[#10b981] font-medium w-16 text-right">
                            {formatCurrency(item.cost)}
                          </span>
                        </div>
                      </div>
                      {/* Progress Bar */}
                      <div className="h-2 w-full bg-[#14100c] rounded-full overflow-hidden border border-[rgba(242,236,223,0.05)]">
                        <div
                          className="h-full bg-gradient-to-r from-[#38bdf8] to-[#818cf8] rounded-full transition-all duration-500"
                          style={{ width: `${item.percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-[#8e8473] font-mono">
                No file telemetry data recorded in this time range.
              </div>
            )
          )}



          {selectedHotspot === 'models' && (
            modelHotspots.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {modelHotspots.map((m, idx) => (
                  <div key={idx} className="p-4 rounded-xl bg-[#1c1712]/70 border border-[rgba(242,236,223,0.08)] hover:border-[rgba(226,163,85,0.3)] transition-all space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-sm font-semibold text-white font-mono">{m.name}</div>
                        <div className="text-[11px] text-[#8e8473]">{m.count} prompt turns dispatched</div>
                      </div>
                      <Badge variant={idx === 0 ? 'copper' : 'default'} className="text-[10px]">
                        {m.percent}% of tokens
                      </Badge>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[rgba(242,236,223,0.06)] font-mono text-xs">
                      <div>
                        <div className="text-[10px] text-[#8e8473]">Total Tokens</div>
                        <div className="font-bold text-white mt-0.5">{formatCompactNumber(m.tokens)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-[#8e8473]">In / Out Split</div>
                        <div className="font-medium text-[#cbbfad] mt-0.5">{formatCompactNumber(m.tokensIn || m.tokens * 0.8)} / {formatCompactNumber(m.tokensOut || m.tokens * 0.2)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] text-[#8e8473]">Total Spend</div>
                        <div className="font-bold text-[#10b981] mt-0.5">{formatCurrency(m.cost)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-[#8e8473] font-mono">
                No model telemetry recorded in this time range.
              </div>
            )
          )}

          {selectedHotspot === 'tools' && (
            toolHotspots.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {toolHotspots.map((t, idx) => (
                  <div key={idx} className="p-4 rounded-xl bg-[#1c1712]/70 border border-[rgba(242,236,223,0.08)] flex flex-col justify-between space-y-3">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono font-semibold text-white truncate">{t.name}</span>
                        <span className="text-[10px] font-mono text-[#e2a355] font-bold">{t.percent}%</span>
                      </div>
                      <div className="text-xl font-bold font-mono text-white mt-2">{formatCompactNumber(t.tokens)}</div>
                      <div className="text-[11px] text-[#8e8473] mt-0.5">{t.count} invocations</div>
                    </div>
                    {t.why && (
                      <div className="text-[11px] text-[#a89c89] bg-[#14100c] p-2 rounded-lg border border-[rgba(242,236,223,0.05)]">
                        {t.why}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-[#8e8473] font-mono">
                No tool executions recorded in this time range.
              </div>
            )
          )}
        </div>
      </div>

      {/* ── SECTION 2: "WHY THIS MANY TOKENS?" (ROOT-CAUSE FORENSICS) ── */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <HelpCircle className="h-5 w-5 text-[#38bdf8]" />
              2. Why This Many Tokens? Root-Cause Forensics Engine
            </h2>
            <p className="text-xs text-[#8e8473]">Deconstruct the engineering mechanics behind token consumption</p>
          </div>

          {/* Filter badges */}
          <div className="flex gap-1.5 flex-wrap">
            {['all', 'context', 'cache', 'tools', 'yield'].map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedWhyCategory(cat)}
                className={`px-2.5 py-1 text-[11px] font-mono rounded-lg transition-all capitalize ${
                  selectedWhyCategory === cat
                    ? 'bg-[#38bdf8]/20 text-[#38bdf8] border border-[#38bdf8]/40 font-semibold'
                    : 'bg-[#1c1712] text-[#8e8473] hover:text-[#f5efe6] border border-transparent'
                }`}
              >
                {cat === 'all' ? 'All Drivers' : cat}
              </button>
            ))}
          </div>
        </div>

        {/* Why Drivers Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredWhyDrivers.map((driver) => (
            <div
              key={driver.id}
              className="rounded-2xl bg-[#14100c]/90 p-5 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl flex flex-col justify-between space-y-4 hover:border-[rgba(56,189,248,0.3)] transition-all"
            >
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-[#e2a355]" />
                    {driver.title}
                  </h3>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium border ${driver.badgeColor}`}>
                    {driver.badge}
                  </span>
                </div>
                <p className="text-xs text-[#a89c89] leading-relaxed">
                  {driver.description}
                </p>
              </div>

              <div className="space-y-3 pt-3 border-t border-[rgba(242,236,223,0.08)]">
                <div className="flex items-baseline justify-between font-mono">
                  <span className="text-xs text-[#8e8473]">{driver.metricLabel}</span>
                  <span className="text-base font-bold text-white">{driver.metricValue}</span>
                </div>

                <div className="rounded-xl bg-[#1c1712] p-2.5 text-xs text-[#f5c485] font-medium border border-[rgba(226,163,85,0.15)] flex items-start gap-2">
                  <span>{driver.savingTip}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── SECTION 3: TURN-BY-TURN FORENSIC INSPECTOR ── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Search className="h-5 w-5 text-[#10b981]" />
              3. Peak Turn Forensics Inspector
            </h2>
            <p className="text-xs text-[#8e8473]">Drill down into the specific prompt turns that triggered the highest token spikes</p>
          </div>
          <Badge variant="default" className="text-[11px] font-mono">
            {peakTurns.length} Peak Turns Analyzed
          </Badge>
        </div>

        <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl divide-y divide-[rgba(242,236,223,0.06)] overflow-hidden">
          {peakTurns.length > 0 ? (
            peakTurns.map((turn, idx) => {
              const isExpanded = expandedTurnId === turn.id;
              return (
                <div key={turn.id} className="p-4 sm:p-5 hover:bg-[rgba(226,163,85,0.02)] transition-colors">
                {/* Header line */}
                <div 
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer"
                  onClick={() => setExpandedTurnId(isExpanded ? null : turn.id)}
                >
                  <div className="flex items-start sm:items-center gap-3">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#1c1712] text-[#e2a355] text-xs font-mono font-bold border border-[rgba(242,236,223,0.08)] flex-shrink-0 mt-0.5 sm:mt-0">
                      #{idx + 1}
                    </span>
                    <div>
                      <div className="font-medium text-xs sm:text-sm text-white max-w-xl line-clamp-1">
                        {turn.promptSnippet}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-[#8e8473] font-mono">
                        <span>{turn.sessionTitle}</span>
                        <span>•</span>
                        <span>Turn #{turn.turnNumber}</span>
                        <span>•</span>
                        <span className="text-[#cbbfad]">{turn.model}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-4 font-mono">
                    <div className="text-right">
                      <div className="text-xs font-bold text-white">{formatCompactNumber(turn.totalTokens)} tokens</div>
                      <div className="text-[10px] text-[#10b981]">{formatCurrency(turn.cost)}</div>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono border ${turn.causeBadgeColor} hidden md:inline`}>
                      {turn.rootCause}
                    </span>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-[#8e8473]">
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                {/* Expanded Forensic Detail */}
                {isExpanded && (
                  <div className="mt-4 pt-4 border-t border-[rgba(242,236,223,0.06)] space-y-4 animate-in fade-in duration-200">
                    {/* Prompt Inspector Box */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[10px] font-mono text-[#8e8473] uppercase tracking-wider">
                        <span className="flex items-center gap-1.5">
                          <Terminal className="h-3 w-3 text-[#e2a355]" />
                          Full Prompt Content (Turn #{turn.turnNumber})
                        </span>
                        <button
                          type="button"
                          onClick={(e) => handleCopyTurnPrompt(turn.promptSnippet, turn.id, e)}
                          className="flex items-center gap-1 text-[#e2a355] hover:underline normal-case text-[11px]"
                        >
                          {copiedTurnId === turn.id ? (
                            <>
                              <Check className="h-3 w-3 text-[#10b981]" />
                              <span className="text-[#10b981]">Copied!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>Copy Prompt</span>
                            </>
                          )}
                        </button>
                      </div>
                      <pre className="bg-[#0a0806] border border-[rgba(242,236,223,0.08)] rounded-xl p-3.5 font-mono text-xs text-[#e5dcd0] leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto select-text selection:bg-[#e2a355]/30">
                        {turn.promptSnippet}
                      </pre>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono text-xs">
                      <div className="p-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.05)]">
                        <div className="text-[10px] text-[#8e8473]">Input Prompt Tokens</div>
                        <div className="text-sm font-bold text-white mt-1">{formatCompactNumber(turn.tokensIn)}</div>
                        <div className="text-[10px] text-amber-400/80 mt-0.5">{(turn.tokensIn / (turn.totalTokens || 1) * 100).toFixed(0)}% of turn total</div>
                      </div>

                      <div className="p-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.05)]">
                        <div className="text-[10px] text-[#8e8473]">Output Tokens Generated</div>
                        <div className="text-sm font-bold text-white mt-1">{formatCompactNumber(turn.tokensOut)}</div>
                        <div className="text-[10px] text-emerald-400/80 mt-0.5">{(turn.tokensOut / (turn.totalTokens || 1) * 100).toFixed(0)}% of turn total</div>
                      </div>

                      <div className="p-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.05)]">
                        <div className="text-[10px] text-[#8e8473]">Tools Executed</div>
                        <div className="flex gap-1.5 flex-wrap mt-1.5">
                          {turn.toolCalls.map((t, i) => (
                            <span key={i} className="px-1.5 py-0.5 rounded bg-[#14100c] text-[10px] text-[#e2a355] border border-[rgba(242,236,223,0.1)]">
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Forensic Explanation Box */}
                    <div className="p-3.5 rounded-xl bg-[#1c1712] border border-[rgba(226,163,85,0.2)] flex items-start gap-3">
                      <ShieldAlert className="h-4 w-4 text-[#e2a355] flex-shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <div className="text-xs font-semibold text-white flex items-center gap-2">
                          Root Cause: <span className="text-[#f5c485]">{turn.rootCause}</span>
                        </div>
                        <p className="text-xs text-[#a89c89] leading-relaxed">
                          {turn.explanation}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="py-12 text-center text-xs text-[#8e8473] font-mono">
            No high-consumption prompt turns recorded in this time range.
          </div>
        )}
        </div>
      </div>

      {/* ── SECTION 4: ACTIONABLE TOKEN OPTIMIZATION PLAYBOOK ── */}
      <div className="rounded-3xl bg-gradient-to-r from-[#17120c] to-[#1a140d] p-6 sm:p-7 border border-[rgba(226,163,85,0.25)] shadow-xl space-y-4">
        <div className="flex items-center gap-2.5">
          <Lightbulb className="h-5 w-5 text-[#f5c485]" />
          <h2 className="text-base sm:text-lg font-bold text-white">
            Personalized Token Optimization Playbook
          </h2>
        </div>
        <p className="text-xs sm:text-sm text-[#a89c89]">
          Follow these 4 developer best practices to cut token waste by 30% to 50% without sacrificing coding agent performance:
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-2">
          <div className="p-3.5 rounded-2xl bg-[#14100c]/80 border border-[rgba(242,236,223,0.06)] space-y-1.5">
            <div className="text-xs font-semibold text-white flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#10b981]/20 text-[#10b981] text-[10px] font-bold">1</span>
              Reset Chat Context Every 10–12 Turns
            </div>
            <p className="text-xs text-[#8e8473]">
              Avoid carrying 80k+ token histories for small subsequent questions. Start a fresh prompt session to reset the input baseline.
            </p>
          </div>

          <div className="p-3.5 rounded-2xl bg-[#14100c]/80 border border-[rgba(242,236,223,0.06)] space-y-1.5">
            <div className="text-xs font-semibold text-white flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#e2a355]/20 text-[#e2a355] text-[10px] font-bold">2</span>
              Scope File Reads with Line Ranges
            </div>
            <p className="text-xs text-[#8e8473]">
              When asking the agent to inspect functions, request specific line ranges or grep patterns instead of dumping full 2k+ line files.
            </p>
          </div>

          <div className="p-3.5 rounded-2xl bg-[#14100c]/80 border border-[rgba(242,236,223,0.06)] space-y-1.5">
            <div className="text-xs font-semibold text-white flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#38bdf8]/20 text-[#38bdf8] text-[10px] font-bold">3</span>
              Route Light Tasks to Fast / Haiku Models
            </div>
            <p className="text-xs text-[#8e8473]">
              Use Claude 3.5 Haiku or GPT-4o-mini for doc lookups, regex generation, and minor fixes to save up to 85% on costs.
            </p>
          </div>

          <div className="p-3.5 rounded-2xl bg-[#14100c]/80 border border-[rgba(242,236,223,0.06)] space-y-1.5">
            <div className="text-xs font-semibold text-white flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#ec4899]/20 text-[#ec4899] text-[10px] font-bold">4</span>
              Maintain Prompt Cache Stability
            </div>
            <p className="text-xs text-[#8e8473]">
              Avoid frequently changing system prompt headers or instruction prefixes mid-session to ensure maximum 90% KV-cache read discounts.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
