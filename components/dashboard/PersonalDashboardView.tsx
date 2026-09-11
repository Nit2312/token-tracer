'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCompactNumber, formatCurrency } from '@/lib/utils';
import { 
  Sparkles, 
  Activity, 
  Zap, 
  Clock, 
  Coins, 
  Search, 
  ChevronRight, 
  GitBranch, 
  SlidersHorizontal,
  ArrowUpRight,
  ArrowDownRight,
  LogOut,
  User,
  Flame,
  Layers,
  HelpCircle,
  BarChart3,
  Calendar,
  Terminal,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  FileCode,
  FileText,
  RefreshCw,
  Trash2,
  X,
  AlertTriangle
} from 'lucide-react';
import { toast } from 'sonner';
import { PersonalTokenForensicsView } from '@/components/dashboard/PersonalTokenForensicsView';

interface PersonalDashboardProps {
  user: {
    id: string;
    username: string;
    displayName: string;
    role: string;
  };
}

export function PersonalDashboardView({ user }: PersonalDashboardProps) {
  const [activeTab, setActiveTab] = React.useState<'overview' | 'forensics'>('overview');
  const [timeRange, setTimeRange] = React.useState<'24h' | '7d' | '30d' | 'custom'>('7d');
  const formatLocalDate = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const [customFrom, setCustomFrom] = React.useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return formatLocalDate(d);
  });
  const [customTo, setCustomTo] = React.useState(() => formatLocalDate(new Date()));
  const [lastSyncedAt, setLastSyncedAt] = React.useState<string>('Just now');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [selectedPrompt, setSelectedPrompt] = React.useState<any | null>(null);
  const [statsData, setStatsData] = React.useState<any | null>(null);
  const [promptsList, setPromptsList] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [hoveredVelocityIndex, setHoveredVelocityIndex] = React.useState<number | null>(null);
  const [expandedPromptId, setExpandedPromptId] = React.useState<string | null>(null);
  const [copiedPromptId, setCopiedPromptId] = React.useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = React.useState(0);
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  // Admin-only prompt deletion
  const isAdmin = user.role === 'admin' || user.role === 'superadmin';
  const [deletingPrompt, setDeletingPrompt] = React.useState<any | null>(null);
  const [isDeletingPrompt, setIsDeletingPrompt] = React.useState(false);

  const handleDeletePrompt = async (promptToDelete: any) => {
    if (!promptToDelete) return;
    setIsDeletingPrompt(true);
    try {
      const res = await fetch('/api/v1/team/prompts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: promptToDelete.id,
          sessionId: promptToDelete.sessionId,
          turnIndex: promptToDelete.turnIndex,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete prompt');
      }
      toast.success('Prompt deleted successfully');
      setPromptsList((prev) =>
        prev.filter((p) => {
          if (promptToDelete.id && String(p.id) === String(promptToDelete.id)) return false;
          if (promptToDelete.sessionId && String(p.sessionId) === String(promptToDelete.sessionId)) {
            if (promptToDelete.turnIndex !== undefined && p.turnIndex === promptToDelete.turnIndex) {
              return false;
            }
          }
          return true;
        })
      );
      setDeletingPrompt(null);
      handleManualRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Error deleting prompt');
    } finally {
      setIsDeletingPrompt(false);
    }
  };

  const handleManualRefresh = () => {
    setIsRefreshing(true);
    setRefreshTrigger(prev => prev + 1);
  };

  const handleCopyPrompt = (text: string, id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedPromptId(id);
      toast.success('Prompt copied to clipboard');
      setTimeout(() => setCopiedPromptId(null), 2000);
    }
  };

  // Helper to compute from & to local date strings
  const getRangeDates = React.useCallback((range: '24h' | '7d' | '30d' | 'custom') => {
    const now = new Date();
    const to = formatLocalDate(now);
    if (range === 'custom') {
      return {
        from: customFrom || to,
        to: customTo || to,
      };
    }
    const fromDate = new Date(now);
    if (range === '24h') {
      return { from: to, to };
    } else if (range === '7d') {
      fromDate.setDate(fromDate.getDate() - 6);
      return { from: formatLocalDate(fromDate), to };
    } else {
      fromDate.setDate(fromDate.getDate() - 29);
      return { from: formatLocalDate(fromDate), to };
    }
  }, [customFrom, customTo]);

  // Fetch real statistics on time range change or manual refresh trigger
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const { from, to } = getRangeDates(timeRange);

    async function loadData() {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const timestamp = Date.now();
        const [statsRes, promptsRes] = await Promise.all([
          fetch(`/api/stats?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}&_t=${timestamp}`, {
            cache: 'no-store',
            headers: {
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Pragma': 'no-cache',
            },
          }),
          fetch(`/api/v1/team/prompts?from=${from}&to=${to}&limit=50&_t=${timestamp}`, {
            cache: 'no-store',
            headers: {
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Pragma': 'no-cache',
            },
          }),
        ]);

        if (!cancelled) {
          if (statsRes.ok) {
            const sData = await statsRes.json();
            setStatsData(sData);
          } else {
            setStatsData(null);
          }
        }

        if (!cancelled) {
          if (promptsRes.ok) {
            const pData = await promptsRes.json();
            setPromptsList(pData.prompts || []);
          } else {
            setPromptsList([]);
          }
        }
        if (!cancelled) {
          setLastSyncedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        }
      } catch (err) {
        console.warn('Live personal stats fetch failed:', err);
        if (!cancelled) {
          setStatsData(null);
          setPromptsList([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setIsRefreshing(false);
        }
      }
    }

    loadData();

    // Auto-poll every 15s to automatically catch background daemon syncs
    const pollInterval = setInterval(() => {
      loadData();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, [timeRange, getRangeDates, refreshTrigger]);

  // Derived KPI metrics based strictly on live stats
  const totalTokensIn = Number(statsData?.totals?.tokensIn || 0);
  const totalTokensOut = Number(statsData?.totals?.tokensOut || 0);
  const totalTokens = totalTokensIn + totalTokensOut;
  const cacheRead = Number(statsData?.totals?.cacheRead || 0);
  const cacheEfficiency = totalTokensIn + cacheRead > 0 ? ((cacheRead / (totalTokensIn + cacheRead)) * 100).toFixed(1) : '0.0';
  const totalCost = Number(statsData?.cost?.total ?? 0);
  const edits = Number(statsData?.totals?.edits || 0);

  // Per-day sparklines based strictly on live data
  const sparklineTokens = statsData?.perDay?.length 
    ? statsData.perDay.map((d: any) => Number(d.tokensIn || 0) + Number(d.tokensOut || 0))
    : [0, 0, 0, 0, 0];

  const sparklineCache = statsData?.perDay?.length 
    ? statsData.perDay.map((d: any) => {
        const inTok = Number(d.tokensIn || 0);
        const cTok = Number(d.tokensCache || 0);
        return inTok + cTok > 0 ? Math.round((cTok / (inTok + cTok)) * 100) : 0;
      })
    : [0, 0, 0, 0, 0];

  const sparklineEdits = statsData?.perDay?.length 
    ? statsData.perDay.map((d: any) => Number(d.edits || 0))
    : [0, 0, 0, 0, 0];

  const sparklineSpend = statsData?.perDay?.length 
    ? statsData.perDay.map((d: any) => Number(d.apiCost || 0))
    : [0, 0, 0, 0, 0];

  const kpis = [
    {
      title: 'Token Usage',
      value: formatCompactNumber(totalTokens),
      unit: 'Tokens',
      delta: `${timeRange === '24h' ? '24 Hours' : timeRange === '7d' ? '7 Days' : 'Selected Range'}`,
      isPositive: true,
      sparkline: sparklineTokens,
      color: '#e2a355',
    },
    {
      title: 'Cache Hit Rate',
      value: `${cacheEfficiency}%`,
      unit: 'Efficiency',
      delta: `${formatCompactNumber(cacheRead)} cached tokens`,
      isPositive: true,
      sparkline: sparklineCache,
      color: '#10b981',
    },
    {
      title: 'Code Edits',
      value: formatCompactNumber(edits),
      unit: 'Edits',
      delta: `${statsData?.totals?.filesTouched || 0} files touched`,
      isPositive: true,
      sparkline: sparklineEdits,
      color: '#3b82f6',
    },
    {
      title: 'Estimated Spend',
      value: formatCurrency(totalCost),
      unit: 'USD',
      delta: `${statsData?.totals?.sessions || 0} agent sessions`,
      isPositive: true,
      sparkline: sparklineSpend,
      color: '#f5c485',
    },
  ];

  // Token Velocity dynamic chart calculation
  const velocityPoints = React.useMemo(() => {
    if (timeRange === '24h') {
      if (statsData?.hourly?.length) {
        return statsData.hourly.map((h: any) => ({
          label: h.label,
          tokensIn: Number(h.tokensIn || 0),
          tokensOut: Number(h.tokensOut || 0),
          tokensCache: Number(h.tokensCache || 0),
        }));
      }
      return Array.from({ length: 24 }, (_, i) => ({
        label: `${String(i).padStart(2, '0')}:00`,
        tokensIn: 0,
        tokensOut: 0,
        tokensCache: 0,
      }));
    } else {
      if (statsData?.perDay?.length) {
        return statsData.perDay.map((d: any) => ({
          label: d.date?.slice(5) || d.date,
          tokensIn: Number(d.tokensIn || 0),
          tokensOut: Number(d.tokensOut || 0),
          tokensCache: Number(d.tokensCache || 0),
        }));
      }
      return [];
    }
  }, [timeRange, statsData]);

  const maxVelocityToken = React.useMemo(() => {
    if (!velocityPoints.length) return 100;
    const maxVal = Math.max(
      ...velocityPoints.map((p: any) => Math.max(p.tokensIn, p.tokensOut, p.tokensCache))
    );
    return maxVal > 0 ? maxVal : 100;
  }, [velocityPoints]);

  const hasVelocityData = React.useMemo(() => {
    return velocityPoints.some((p: any) => p.tokensIn > 0 || p.tokensOut > 0 || p.tokensCache > 0);
  }, [velocityPoints]);

  // Monotone Cubic Spline (Fritsch-Carlson) generator to prevent overshoot below baseline
  const generateSvgSpline = React.useCallback((pts: { x: number; y: number }[], baselineY = 175) => {
    const n = pts.length;
    if (n === 0) return '';
    if (n === 1) return `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    if (n === 2) return `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;

    // 1. Calculate secants (delta)
    const dx: number[] = [];
    const dy: number[] = [];
    const delta: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const diffX = pts[i + 1].x - pts[i].x;
      const diffY = pts[i + 1].y - pts[i].y;
      dx.push(diffX);
      dy.push(diffY);
      delta.push(diffX === 0 ? 0 : diffY / diffX);
    }

    // 2. Initialize tangents
    const m: number[] = Array(n).fill(0);
    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (delta[i - 1] * delta[i] <= 0) {
        m[i] = 0;
      } else {
        m[i] = (delta[i - 1] + delta[i]) / 2;
      }
    }

    // 3. Fritsch-Carlson adjustments to prevent overshoot
    for (let i = 0; i < n - 1; i++) {
      if (delta[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
      } else {
        const alpha = m[i] / delta[i];
        const beta = m[i + 1] / delta[i];
        const dist = alpha * alpha + beta * beta;
        if (dist > 9) {
          const tau = 3 / Math.sqrt(dist);
          m[i] = tau * alpha * delta[i];
          m[i + 1] = tau * beta * delta[i];
        }
      }
    }

    // 4. Build SVG path with cubic bezier control points clamped to baseline
    let path = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const h = dx[i];
      const cp1x = p1.x + h / 3;
      let cp1y = p1.y + (m[i] * h) / 3;
      const cp2x = p2.x - h / 3;
      let cp2y = p2.y - (m[i + 1] * h) / 3;

      // Strict clamp so the spline never dips below baseline or above top margin
      cp1y = Math.min(baselineY, Math.max(15, cp1y));
      cp2y = Math.min(baselineY, Math.max(15, cp2y));

      path += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return path;
  }, []);

  const velocitySvg = React.useMemo(() => {
    if (!velocityPoints.length) return null;
    const count = velocityPoints.length;
    const chartW = 700;
    const chartH = 145;
    const baselineY = 175;

    const ptsIn = velocityPoints.map((p: any, idx: number) => ({
      x: (idx / Math.max(1, count - 1)) * chartW,
      y: hasVelocityData ? baselineY - (p.tokensIn / maxVelocityToken) * chartH : baselineY,
      val: p.tokensIn,
      label: p.label,
    }));

    const ptsOut = velocityPoints.map((p: any, idx: number) => ({
      x: (idx / Math.max(1, count - 1)) * chartW,
      y: hasVelocityData ? baselineY - (p.tokensOut / maxVelocityToken) * chartH : baselineY,
      val: p.tokensOut,
      label: p.label,
    }));

    const ptsCache = velocityPoints.map((p: any, idx: number) => ({
      x: (idx / Math.max(1, count - 1)) * chartW,
      y: hasVelocityData ? baselineY - (p.tokensCache / maxVelocityToken) * chartH : baselineY,
      val: p.tokensCache,
      label: p.label,
    }));

    const pathIn = generateSvgSpline(ptsIn, baselineY);
    const pathOut = generateSvgSpline(ptsOut, baselineY);
    const pathCache = generateSvgSpline(ptsCache, baselineY);

    const areaIn = `${pathIn} L ${chartW},${baselineY} L 0,${baselineY} Z`;
    const areaOut = `${pathOut} L ${chartW},${baselineY} L 0,${baselineY} Z`;

    const peakIn = ptsIn.reduce((m: any, p: any) => (p.val > (m?.val || 0) ? p : m), null);
    const peakOut = ptsOut.reduce((m: any, p: any) => (p.val > (m?.val || 0) ? p : m), null);

    return {
      pathIn,
      pathOut,
      pathCache,
      areaIn,
      areaOut,
      peakIn,
      peakOut,
      ptsIn,
      ptsOut,
      ptsCache,
    };
  }, [velocityPoints, maxVelocityToken, hasVelocityData, generateSvgSpline]);

  const prompts = React.useMemo(() => {
    if (!promptsList.length) return [];
    return promptsList.map((p, i) => {
      const tIn = Number(p.inputTokens || p.tokens_in || 0);
      const tOut = Number(p.outputTokens || p.tokens_out || 0);
      const total = tIn + tOut;
      const cRead = Number(p.cacheRead || p.tokens_cache_read || 0);
      const cWrite = Number(p.cacheWrite || p.tokens_cache_write || 0);
      const cost = Number(p.cost || (total / 1_000_000) * 8.5);
      const createdDate = p.createdAt ? new Date(p.createdAt) : null;
      return {
        id: String(p.id || p.sessionId || `p-${i}`),
        sessionId: p.sessionId ? String(p.sessionId) : `session-${i + 1}`,
        turnIndex: Number(p.turnIndex || i + 1),
        text: p.promptText || p.prompt_text || p.text || 'Agent interaction turn',
        category: p.project || 'General',
        model: p.model || 'Claude 3.7 Sonnet',
        tool: p.tool || null,
        inputTokens: tIn,
        outputTokens: tOut,
        cacheRead: cRead,
        cacheWrite: cWrite,
        totalTokens: total,
        cost,
        createdAt: createdDate && !isNaN(createdDate.getTime())
          ? createdDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
          : null,
      };
    });
  }, [promptsList]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/me', { method: 'POST', credentials: 'same-origin' });
      await fetch('/api/auth/login', { method: 'DELETE', credentials: 'same-origin' });
    } catch {
      // ignore
    }
    document.cookie = 'app_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    document.cookie = 'sa_original_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    document.cookie = 'team_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    window.location.replace('/');
  };

  const filteredPrompts = React.useMemo(() => {
    return prompts.filter(p => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        p.text.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.model.toLowerCase().includes(q) ||
        (p.tool && p.tool.toLowerCase().includes(q))
      );
    });
  }, [prompts, searchQuery]);

  return (
    <div className="min-h-screen bg-[#0d0a07] text-[#f5efe6] font-sans antialiased relative selection:bg-[#e2a355]/30">
      {/* Ambient background glow orbs */}
      <div className="ambient-glow-backdrop" aria-hidden="true">
        <div className="ambient-orb ambient-orb-1" />
        <div className="ambient-orb ambient-orb-2" />
        <div className="ambient-orb ambient-orb-3" />
      </div>

      {/* Top Header */}
      <header className="sticky top-0 z-40 border-b border-[rgba(242,236,223,0.08)] bg-[#14100c]/80 backdrop-blur-xl px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] shadow-lg shadow-[#e2a355]/20 font-bold">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
                <circle cx="12" cy="12" r="4" />
              </svg>
            </div>
            <div>
              <div className="font-mono text-base font-bold tracking-tight text-white flex items-center gap-2">
                token<span className="text-[#e2a355]">tracer</span>
                <Badge variant="live" className="text-[10px] px-2 py-0.2">Live Agent</Badge>
              </div>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div role="tablist" className="hidden md:flex items-center gap-1 bg-[#1c1712] p-1 rounded-xl border border-[rgba(242,236,223,0.08)]">
            <button
              onClick={() => setActiveTab('overview')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                activeTab === 'overview'
                  ? 'bg-[#14100c] text-white shadow-sm font-semibold border border-[rgba(242,236,223,0.12)]'
                  : 'text-[#8e8473] hover:text-[#f5efe6]'
              }`}
            >
              <Zap className={`h-3.5 w-3.5 ${activeTab === 'overview' ? 'text-[#e2a355]' : ''}`} />
              Overview &amp; Velocity
            </button>
            <button
              onClick={() => setActiveTab('forensics')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                activeTab === 'forensics'
                  ? 'bg-[#14100c] text-white shadow-sm font-semibold border border-[rgba(226,163,85,0.3)]'
                  : 'text-[#8e8473] hover:text-[#f5efe6]'
              }`}
            >
              <Flame className={`h-3.5 w-3.5 ${activeTab === 'forensics' ? 'text-[#e2a355]' : ''}`} />
              Token Max &amp; Why Forensics
              <span className="flex h-2 w-2 rounded-full bg-[#e2a355] animate-pulse" />
            </button>
          </div>
        </div>

        {/* Header Controls */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {/* Last Sync Indicator Line */}
          {/* Last Sync Indicator Line with Manual Refresh Button */}
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)] text-[11px] font-mono text-[#8e8473]">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span>Last sync: <span className="text-white font-medium">{lastSyncedAt}</span></span>
            <button
              type="button"
              title="Force refresh live data from database"
              onClick={handleManualRefresh}
              disabled={isRefreshing || loading}
              className="ml-1 p-1 rounded hover:bg-[#14100c] text-[#e2a355] hover:text-white transition-all disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${isRefreshing || loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Time range selector */}
          <div className="flex bg-[#1c1712] p-1 rounded-xl border border-[rgba(242,236,223,0.08)]">
            {(['24h', '7d', '30d', 'custom'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-3 py-1 text-xs font-medium rounded-lg transition-all capitalize ${
                  timeRange === r 
                    ? 'bg-gradient-to-r from-[#f5c485] to-[#e2a355] text-[#170f05] font-semibold shadow-sm' 
                    : 'text-[#8e8473] hover:text-[#f5efe6]'
                }`}
              >
                {r === '24h' ? 'Last 24 hours' : r === '7d' ? '7 Days' : r === '30d' ? '30 Days' : 'Custom'}
              </button>
            ))}
          </div>

          {/* Custom Date Range Selector */}
          {timeRange === 'custom' && (
            <div className="flex items-center gap-2 bg-[#1c1712] px-3 py-1 rounded-xl border border-[rgba(226,163,85,0.3)] shadow-sm animate-in fade-in text-xs font-mono">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="bg-transparent text-white focus:outline-none text-[11px] cursor-pointer"
                title="Start Date"
              />
              <span className="text-[#e2a355] font-bold">→</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="bg-transparent text-white focus:outline-none text-[11px] cursor-pointer"
                title="End Date"
              />
            </div>
          )}

          <div className="h-5 w-px bg-[rgba(242,236,223,0.1)]" />

          {/* User Profile / Logout */}
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(226,163,85,0.15)] text-[#f5c485] border border-[rgba(226,163,85,0.3)] text-xs font-bold font-mono">
              {user.displayName?.slice(0, 2).toUpperCase() || 'ME'}
            </div>
            <span className="text-xs font-medium text-[#cbbfad] hidden sm:inline">{user.displayName || user.username}</span>
            <Button size="icon" variant="ghost" className="h-8 w-8 text-[#8e8473] hover:text-[#f5efe6]" onClick={handleLogout} title="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Mobile Nav Switcher */}
      <div className="md:hidden border-b border-[rgba(242,236,223,0.08)] bg-[#14100c] px-4 py-2 flex items-center gap-2">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-lg ${
            activeTab === 'overview' ? 'bg-[#1c1712] text-white font-semibold' : 'text-[#8e8473]'
          }`}
        >
          <Zap className="h-3.5 w-3.5" />
          Overview
        </button>
        <button
          onClick={() => setActiveTab('forensics')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-lg ${
            activeTab === 'forensics' ? 'bg-[#1c1712] text-white font-semibold' : 'text-[#8e8473]'
          }`}
        >
          <Flame className="h-3.5 w-3.5 text-[#e2a355]" />
          Token Max &amp; Why
        </button>
      </div>

      {/* Main Content Area */}
      <main className="max-w-[1440px] mx-auto p-6 space-y-6 relative z-10">
        {activeTab === 'forensics' ? (
          <PersonalTokenForensicsView
            statsData={statsData}
            promptsList={promptsList}
            timeRange={timeRange}
            user={user}
          />
        ) : (
          <>
            {/* 1. TOP KPI STAT CARDS */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {kpis.map((kpi, idx) => (
            <div 
              key={idx}
              className="group relative rounded-2xl bg-[#14100c]/90 p-5 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl hover:border-[rgba(242,236,223,0.2)] hover:-translate-y-1 transition-all duration-300"
            >
              <div className="flex items-center justify-between text-xs font-mono uppercase tracking-wider text-[#8e8473]">
                <span>{kpi.title}</span>
                <span className="text-xs opacity-60 group-hover:opacity-100 transition-opacity">•••</span>
              </div>
              
              <div className="mt-3 flex items-baseline justify-between">
                <div>
                  <span className="text-3xl font-bold font-mono text-white tracking-tight">{kpi.value}</span>
                  <span className="ml-1.5 text-xs text-[#8e8473] font-medium">{kpi.unit}</span>
                </div>
                
                {/* Embedded Mini Sparkline SVG */}
                <div className="w-20 h-8 flex items-end flex-shrink-0" style={{ width: '80px', height: '32px', minWidth: '80px', minHeight: '32px' }}>
                  <svg className="w-full h-full" style={{ width: '80px', height: '32px', display: 'block' }} viewBox="0 0 100 40" preserveAspectRatio="none">
                    <polyline
                      fill="none"
                      stroke={kpi.color}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={kpi.sparkline.map((val: number, i: number) => `${(i / Math.max(1, kpi.sparkline.length - 1)) * 100},${40 - (val / 140) * 35}`).join(' ')}
                    />
                  </svg>
                </div>
              </div>

              <div className="mt-2 flex items-center gap-1 text-[11px] font-medium text-[#10b981]">
                <ArrowUpRight className="h-3 w-3" />
                <span>{kpi.delta}</span>
              </div>
            </div>
          ))}
        </div>

        {/* 2. MIDDLE ROW: TOKEN VELOCITY & DEVELOPMENT ACTIVITY */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Token Velocity Chart */}
          <div className="lg:col-span-7 rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">Token Velocity</h3>
                <p className="text-xs text-[#8e8473]">Token throughput and cache recycling over time</p>
              </div>
              <div className="flex items-center gap-4 text-xs font-mono">
                <span className="flex items-center gap-1.5 text-[#e2a355]">
                  <span className="h-2 w-2 rounded-full bg-[#e2a355]" /> Tokens In
                </span>
                <span className="flex items-center gap-1.5 text-[#ec4899]">
                  <span className="h-2 w-2 rounded-full bg-[#ec4899]" /> Tokens Out
                </span>
                <span className="flex items-center gap-1.5 text-[#10b981]">
                  <span className="h-2 w-2 rounded-full bg-[#10b981]" /> Cache Read Savings
                </span>
              </div>
            </div>

            {/* Custom Glowing Spline Area Chart (SVG Canvas) with Interactive Scrubbing */}
            <div 
              className="relative h-64 w-full pt-4 cursor-crosshair group" 
              style={{ height: '260px', width: '100%' }}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const relX = e.clientX - rect.left;
                const ratio = Math.max(0, Math.min(1, relX / rect.width));
                const count = velocityPoints.length;
                if (count > 0) {
                  const idx = Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
                  setHoveredVelocityIndex(idx);
                }
              }}
              onMouseLeave={() => setHoveredVelocityIndex(null)}
            >
              {/* Floating Glassmorphism Tooltip */}
              {hoveredVelocityIndex !== null && velocityPoints[hoveredVelocityIndex] && (
                <div 
                  className="absolute pointer-events-none z-30 transition-all duration-75 bg-[#17120c]/95 backdrop-blur-xl px-3.5 py-2.5 rounded-xl border border-[rgba(226,163,85,0.3)] shadow-2xl shadow-black/90 font-mono text-xs min-w-[200px]"
                  style={{
                    left: `${Math.min(75, Math.max(25, (hoveredVelocityIndex / Math.max(1, velocityPoints.length - 1)) * 100))}%`,
                    top: '12px',
                    transform: 'translateX(-50%)',
                  }}
                >
                  <div className="flex items-center justify-between border-b border-[rgba(242,236,223,0.08)] pb-1.5 mb-2">
                    <span className="font-bold text-white flex items-center gap-1.5 text-[11px]">
                      <Clock className="h-3.5 w-3.5 text-[#e2a355]" />
                      {timeRange === '24h' 
                        ? `${velocityPoints[hoveredVelocityIndex].label} – ${String((hoveredVelocityIndex + 1) % 24).padStart(2, '0')}:00` 
                        : velocityPoints[hoveredVelocityIndex].label}
                    </span>
                    <span className="text-[10px] text-[#8e8473]">
                      {timeRange === '24h' ? 'Local Time' : 'Daily Telemetry'}
                    </span>
                  </div>
                  <div className="space-y-1 text-[11px]">
                    <div className="flex items-center justify-between text-[#e2a355]">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-[#e2a355]" /> In:
                      </span>
                      <span className="font-bold text-white">{formatCompactNumber(velocityPoints[hoveredVelocityIndex].tokensIn)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[#ec4899]">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-[#ec4899]" /> Out:
                      </span>
                      <span className="font-bold text-white">{formatCompactNumber(velocityPoints[hoveredVelocityIndex].tokensOut)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[#10b981]">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-[#10b981]" /> Cached:
                      </span>
                      <span className="font-bold text-white">{formatCompactNumber(velocityPoints[hoveredVelocityIndex].tokensCache)}</span>
                    </div>
                  </div>
                </div>
              )}

              <svg className="w-full h-full" style={{ width: '100%', height: '100%', display: 'block' }} viewBox="0 0 700 200" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="gradient-in" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#e2a355" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#e2a355" stopOpacity="0.0" />
                  </linearGradient>
                  <linearGradient id="gradient-out" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ec4899" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#ec4899" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Grid guidelines */}
                <line x1="0" y1="45" x2="700" y2="45" stroke="rgba(242,236,223,0.05)" strokeDasharray="4 4" />
                <line x1="0" y1="90" x2="700" y2="90" stroke="rgba(242,236,223,0.05)" strokeDasharray="4 4" />
                <line x1="0" y1="135" x2="700" y2="135" stroke="rgba(242,236,223,0.05)" strokeDasharray="4 4" />
                <line x1="0" y1="175" x2="700" y2="175" stroke="rgba(242,236,223,0.08)" />

                {hasVelocityData && velocitySvg ? (
                  <>
                    {/* Tokens In Spline Area */}
                    <path
                      d={velocitySvg.areaIn}
                      fill="url(#gradient-in)"
                    />
                    <path
                      d={velocitySvg.pathIn}
                      fill="none"
                      stroke="#e2a355"
                      strokeWidth="2.8"
                      strokeLinecap="round"
                      className="filter drop-shadow-[0_0_8px_rgba(226,163,85,0.6)]"
                    />

                    {/* Tokens Out Spline Area */}
                    <path
                      d={velocitySvg.areaOut}
                      fill="url(#gradient-out)"
                    />
                    <path
                      d={velocitySvg.pathOut}
                      fill="none"
                      stroke="#ec4899"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      className="filter drop-shadow-[0_0_8px_rgba(236,72,153,0.5)]"
                    />

                    {/* Cache Read Savings Spline */}
                    <path
                      d={velocitySvg.pathCache}
                      fill="none"
                      stroke="#10b981"
                      strokeWidth="1.8"
                      strokeDasharray="4 3"
                      className="filter drop-shadow-[0_0_6px_rgba(16,185,129,0.5)]"
                    />

                    {/* Static Peak Highlights (when not hovered) */}
                    {hoveredVelocityIndex === null && (
                      <>
                        {velocitySvg.peakIn && velocitySvg.peakIn.val > 0 && (
                          <circle
                            cx={velocitySvg.peakIn.x}
                            cy={velocitySvg.peakIn.y}
                            r="4.5"
                            fill="#f5c485"
                            className="animate-pulse"
                          />
                        )}
                        {velocitySvg.peakOut && velocitySvg.peakOut.val > 0 && (
                          <circle
                            cx={velocitySvg.peakOut.x}
                            cy={velocitySvg.peakOut.y}
                            r="3.5"
                            fill="#ec4899"
                          />
                        )}
                      </>
                    )}

                    {/* Interactive Crosshair & Scrubbing Marker */}
                    {hoveredVelocityIndex !== null && velocitySvg.ptsIn[hoveredVelocityIndex] && (
                      <g>
                        <line
                          x1={velocitySvg.ptsIn[hoveredVelocityIndex].x}
                          y1="10"
                          x2={velocitySvg.ptsIn[hoveredVelocityIndex].x}
                          y2="175"
                          stroke="#e2a355"
                          strokeWidth="1.5"
                          strokeDasharray="3 3"
                          opacity="0.8"
                        />
                        <circle
                          cx={velocitySvg.ptsIn[hoveredVelocityIndex].x}
                          cy={velocitySvg.ptsIn[hoveredVelocityIndex].y}
                          r="5.5"
                          fill="#f5c485"
                          stroke="#14100c"
                          strokeWidth="2"
                          className="animate-ping opacity-75"
                        />
                        <circle
                          cx={velocitySvg.ptsIn[hoveredVelocityIndex].x}
                          cy={velocitySvg.ptsIn[hoveredVelocityIndex].y}
                          r="5"
                          fill="#f5c485"
                          stroke="#14100c"
                          strokeWidth="1.5"
                        />
                        {velocitySvg.ptsOut[hoveredVelocityIndex] && (
                          <circle
                            cx={velocitySvg.ptsOut[hoveredVelocityIndex].x}
                            cy={velocitySvg.ptsOut[hoveredVelocityIndex].y}
                            r="4"
                            fill="#ec4899"
                            stroke="#14100c"
                            strokeWidth="1.5"
                          />
                        )}
                        {velocitySvg.ptsCache[hoveredVelocityIndex] && (
                          <circle
                            cx={velocitySvg.ptsCache[hoveredVelocityIndex].x}
                            cy={velocitySvg.ptsCache[hoveredVelocityIndex].y}
                            r="3.5"
                            fill="#10b981"
                            stroke="#14100c"
                            strokeWidth="1"
                          />
                        )}
                      </g>
                    )}
                  </>
                ) : (
                  <text x="350" y="110" textAnchor="middle" fill="#8e8473" fontSize="12" fontFamily="monospace">
                    No token throughput recorded in this range
                  </text>
                )}
              </svg>

              {/* Mathematically Aligned X-Axis (Zero Overflow) */}
              <div className="relative h-6 w-full text-[10px] text-[#8e8473] font-mono mt-2 pt-2 border-t border-[rgba(242,236,223,0.06)] overflow-hidden">
                {timeRange === '24h' ? (
                  [
                    { idx: 0, label: '00:00', align: 'left' },
                    { idx: 4, label: '04:00', align: 'center' },
                    { idx: 8, label: '08:00', align: 'center' },
                    { idx: 12, label: '12:00', align: 'center' },
                    { idx: 16, label: '16:00', align: 'center' },
                    { idx: 20, label: '20:00', align: 'center' },
                    { idx: 23, label: '23:59', align: 'right' },
                  ].map((t) => (
                    <span
                      key={t.idx}
                      className={`absolute transform ${
                        t.align === 'left' ? 'left-0 text-left' :
                        t.align === 'right' ? 'right-0 text-right' :
                        '-translate-x-1/2 text-center'
                      } ${hoveredVelocityIndex === t.idx ? 'text-[#e2a355] font-bold' : ''}`}
                      style={t.align === 'center' ? { left: `${(t.idx / 23) * 100}%` } : undefined}
                    >
                      {t.label}
                    </span>
                  ))
                ) : (
                  velocityPoints.length > 0 && (() => {
                    const len = velocityPoints.length;
                    const indices = [
                      0,
                      Math.floor(len * 0.25),
                      Math.floor(len * 0.5),
                      Math.floor(len * 0.75),
                      len - 1
                    ].filter((val, i, arr) => arr.indexOf(val) === i);
                    return indices.map((idx, i) => (
                      <span
                        key={idx}
                        className={`absolute transform ${
                          i === 0 ? 'left-0 text-left' :
                          i === indices.length - 1 ? 'right-0 text-right' :
                          '-translate-x-1/2 text-center'
                        } ${hoveredVelocityIndex === idx ? 'text-[#e2a355] font-bold' : ''}`}
                        style={i > 0 && i < indices.length - 1 ? { left: `${(idx / Math.max(1, len - 1)) * 100}%` } : undefined}
                      >
                        {velocityPoints[idx]?.label}
                      </span>
                    ));
                  })()
                )}
              </div>
            </div>
          </div>

          {/* Development Activity Matrix (Punchcard) */}
          <div className="lg:col-span-5 rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-white">Development Activity</h3>
                <Badge variant="copper" className="text-[10px]">
                  {statsData?.records?.peakHour?.hour != null && statsData?.records?.peakHour?.n > 0 
                    ? `Peak: ${String(statsData.records.peakHour.hour).padStart(2, '0')}:00` 
                    : 'No peak activity'}
                </Badge>
              </div>
              <p className="text-xs text-[#8e8473] mb-4">Coding activity rhythm by day of week &amp; time of day</p>

              {/* Matrix Heat Bubbles */}
              <div className="space-y-2 font-mono text-[11px]">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, dIdx) => {
                  const dow = dIdx === 6 ? 0 : dIdx + 1;
                  return (
                    <div key={day} className="flex items-center gap-2">
                      <span className="w-8 text-[#8e8473] text-[10px]">{day}</span>
                      <div className="flex-1 grid grid-cols-12 gap-1.5">
                        {Array.from({ length: 12 }).map((_, hIdx) => {
                          const h = hIdx * 2;
                          const rawVal = statsData?.punch?.[dow] ? (statsData.punch[dow][h] + statsData.punch[dow][h + 1]) : 0;
                          const intensity = rawVal > 0 
                            ? Math.min(4, Math.max(1, Math.ceil(rawVal / 2)))
                            : 0;
                          const cellStyles = [
                            'bg-[rgba(242,236,223,0.03)] border-[rgba(242,236,223,0.04)]',
                            'bg-[#4d3818]/60 border-[#e2a355]/20',
                            'bg-[#7d5822]/80 border-[#e2a355]/30',
                            'bg-[#b17d31] border-[#f5c485]/40',
                            'bg-[#e2a355] border-[#f5c485] shadow-sm shadow-[#e2a355]/30',
                          ];
                          return (
                            <div 
                              key={hIdx}
                              title={`${day} ${String(h).padStart(2, '0')}:00–${String(h + 2).padStart(2, '0')}:00: ${rawVal} sessions`}
                              className={`h-3.5 rounded-sm border ${cellStyles[intensity]} hover:ring-2 hover:ring-[#f5c485] transition-all cursor-pointer`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pt-4 mt-4 border-t border-[rgba(242,236,223,0.08)] flex items-center justify-between text-xs text-[#8e8473]">
              <span>Active <b>{statsData?.records?.activeDays ?? 0} days</b> in range</span>
              <span className="text-[#e2a355] font-semibold">Streak: {statsData?.records?.streak ?? 0} days 🔥</span>
            </div>
          </div>
        </div>

        {/* 3. DAY-WISE USAGE & VELOCITY BREAKDOWN */}
        <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[#e2a355]" /> Day-Wise Token &amp; Activity Breakdown
              </h3>
              <p className="text-xs text-[#8e8473]">Daily token throughput, prompt cache utilization, and estimated cost tracking</p>
            </div>
            <div className="flex items-center gap-2 font-mono text-xs text-[#8e8473]">
              <span>Range: <b className="text-white">{timeRange === '24h' ? '24 Hours' : timeRange === '7d' ? 'Last 7 Days' : 'Last 30 Days'}</b></span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[rgba(242,236,223,0.08)] text-[#8e8473] font-mono uppercase tracking-wider">
                  <th className="pb-3 font-medium">Date</th>
                  <th className="pb-3 font-medium text-right">Tokens In</th>
                  <th className="pb-3 font-medium text-right">Tokens Out</th>
                  <th className="pb-3 font-medium text-right">Cache Hit Tokens</th>
                  <th className="pb-3 font-medium text-right">Cache Efficiency</th>
                  <th className="pb-3 font-medium text-right">Edits / Tool Calls</th>
                  <th className="pb-3 font-medium text-right">Est. Cost</th>
                  <th className="pb-3 font-medium text-right">Total Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgba(242,236,223,0.05)] font-mono">
                {(() => {
                  let rows = statsData?.perDay && statsData.perDay.length > 0 ? [...statsData.perDay].reverse() : [];
                  const sumTokens = rows.reduce((acc: number, d: any) => acc + Number(d.tokensIn || 0) + Number(d.tokensOut || 0), 0);
                  if (sumTokens === 0 && totalTokens > 0) {
                    const todayStr = formatLocalDate(new Date());
                    rows = [{
                      date: todayStr,
                      tokensIn: totalTokensIn,
                      tokensOut: totalTokensOut,
                      tokensCache: cacheRead,
                      apiCost: totalCost,
                      edits: edits,
                      toolCalls: Number(statsData?.totals?.toolCalls || 0),
                    }];
                  }
                  return rows.map((day: any, idx: number) => {
                    const tIn = Number(day.tokensIn || 0);
                    const tOut = Number(day.tokensOut || 0);
                    const total = tIn + tOut;
                    const cache = Number(day.tokensCache || 0);
                    const cacheRate = (tIn + cache > 0) ? ((cache / (tIn + cache)) * 100).toFixed(1) : '0.0';
                    const cost = Number(day.apiCost || (total / 1_000_000) * 8.5);
                    const dayEdits = Number(day.edits || 0);
                    const tools = Number(day.toolCalls || 0);
                    return (
                      <tr key={idx} className="hover:bg-[rgba(226,163,85,0.04)] transition-colors">
                        <td className="py-3 text-white font-medium">
                          {day.date}
                        </td>
                        <td className="py-3 text-right text-[#cbbfad]">
                          {formatCompactNumber(tIn)}
                        </td>
                        <td className="py-3 text-right text-[#ec4899]">
                          {formatCompactNumber(tOut)}
                        </td>
                        <td className="py-3 text-right text-[#10b981]">
                          {formatCompactNumber(cache)}
                        </td>
                        <td className="py-3 text-right">
                          <span className="px-2 py-0.5 rounded bg-[#1c1712] text-[11px] text-[#10b981] border border-[rgba(16,185,129,0.2)]">
                            {cacheRate}%
                          </span>
                        </td>
                        <td className="py-3 text-right text-[#8e8473]">
                          {dayEdits} edits <span className="text-[rgba(242,236,223,0.3)]">/</span> {tools} calls
                        </td>
                        <td className="py-3 text-right text-[#f5c485] font-semibold">
                          {formatCurrency(cost)}
                        </td>
                        <td className="py-3 text-right text-white font-bold">
                          {formatCompactNumber(total)}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>

        {/* 4. BOTTOM ROW: PROMPT EXPLORER & CODE IMPACT MAP */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Prompt Trajectories Explorer */}
          <div className="lg:col-span-7 rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl space-y-4 flex flex-col justify-between">
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Terminal className="h-4 w-4 text-[#e2a355]" />
                      Prompt Trajectories Explorer
                    </h3>
                    <span className="px-2 py-0.5 rounded-full bg-[#1c1712] text-[10px] font-mono text-[#e2a355] border border-[rgba(242,236,223,0.08)]">
                      {filteredPrompts.length} Prompts
                    </span>
                  </div>
                  <p className="text-xs text-[#8e8473]">Inspect full developer prompts, token splits, cache efficiency & cost per turn</p>
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8e8473]" />
                    <input
                      type="text"
                      placeholder="Search prompts…"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="bg-[#1c1712] pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[rgba(242,236,223,0.08)] text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] w-48"
                    />
                  </div>
                </div>
              </div>

              {/* Developer Prompt Cards */}
              <div className="space-y-3 max-h-[580px] overflow-y-auto pr-1">
                {filteredPrompts.length > 0 ? (
                  filteredPrompts.map((p, idx) => {
                    const isExpanded = expandedPromptId === p.id;
                    const isCopied = copiedPromptId === p.id;

                    return (
                      <div
                        key={p.id}
                        className={`rounded-xl border transition-all duration-200 overflow-hidden ${
                          isExpanded 
                            ? 'bg-[#18130e] border-[#e2a355]/40 shadow-md ring-1 ring-[#e2a355]/20' 
                            : 'bg-[#1c1712]/70 hover:bg-[#1c1712] border-[rgba(242,236,223,0.06)] hover:border-[rgba(226,163,85,0.25)]'
                        }`}
                      >
                        {/* Prompt Card Header */}
                        <div 
                          className="p-3.5 cursor-pointer flex flex-col gap-2.5"
                          onClick={() => setExpandedPromptId(isExpanded ? null : p.id)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="flex h-5 items-center justify-center rounded bg-[#14100c] px-1.5 text-[10px] font-mono font-bold text-[#e2a355] border border-[rgba(242,236,223,0.08)]">
                                #{idx + 1}
                              </span>
                              <span className="px-2 py-0.5 rounded bg-[#14100c] text-[10px] font-mono text-[#cbbfad] border border-[rgba(242,236,223,0.06)]">
                                {p.model}
                              </span>
                              {p.tool && (
                                <span className="px-2 py-0.5 rounded bg-[#38bdf8]/10 text-[10px] font-mono text-[#38bdf8] border border-[#38bdf8]/20">
                                  tool: {p.tool}
                                </span>
                              )}
                              {p.createdAt && (
                                <span className="text-[10px] font-mono text-[#8e8473]">
                                  {p.createdAt}
                                </span>
                              )}
                            </div>

                            {/* Token Pill Badges */}
                            <div className="flex items-center gap-2 font-mono text-[11px]">
                              <span className="text-white font-bold">
                                {formatCompactNumber(p.totalTokens)} tok
                              </span>
                              <span className="text-[#10b981] font-semibold">
                                {formatCurrency(p.cost)}
                              </span>
                              <button
                                type="button"
                                title="Copy prompt text"
                                onClick={(e) => handleCopyPrompt(p.text, p.id, e)}
                                className="p-1 rounded hover:bg-[#14100c] text-[#8e8473] hover:text-[#f5efe6] transition-colors ml-1"
                              >
                                {isCopied ? <Check className="h-3.5 w-3.5 text-[#10b981]" /> : <Copy className="h-3.5 w-3.5" />}
                              </button>
                              {isAdmin && (
                                <button
                                  type="button"
                                  title="Delete prompt (Admin Only)"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDeletingPrompt(p);
                                  }}
                                  className="p-1 rounded hover:bg-rose-500/15 text-[#8e8473] hover:text-rose-400 transition-colors ml-1"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                className="p-1 text-[#8e8473] hover:text-white transition-colors"
                              >
                                {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                          </div>

                          {/* Collapsed vs Expanded Text Preview */}
                          {!isExpanded ? (
                            <p className="text-xs text-[#cbbfad] line-clamp-2 leading-relaxed font-sans pr-2">
                              {p.text}
                            </p>
                          ) : null}
                        </div>

                        {/* Expanded Full Prompt Body */}
                        {isExpanded && (
                          <div className="px-3.5 pb-3.5 space-y-3 border-t border-[rgba(242,236,223,0.06)] pt-3 animate-in fade-in duration-150">
                            {/* Full Prompt View Area */}
                            <div className="relative group">
                              <div className="flex items-center justify-between pb-1.5 text-[10px] font-mono text-[#8e8473] uppercase tracking-wider">
                                <span>Developer Prompt Content</span>
                                <button
                                  type="button"
                                  onClick={(e) => handleCopyPrompt(p.text, p.id, e)}
                                  className="flex items-center gap-1 text-[#e2a355] hover:underline normal-case text-[11px]"
                                >
                                  {isCopied ? (
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
                                {p.text}
                              </pre>
                            </div>

                            {/* Token Detail Bar */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 font-mono text-[11px]">
                              <div className="p-2 rounded-lg bg-[#14100c] border border-[rgba(242,236,223,0.05)]">
                                <div className="text-[9px] text-[#8e8473]">Input Tokens</div>
                                <div className="font-bold text-amber-400 mt-0.5">{formatCompactNumber(p.inputTokens)}</div>
                              </div>
                              <div className="p-2 rounded-lg bg-[#14100c] border border-[rgba(242,236,223,0.05)]">
                                <div className="text-[9px] text-[#8e8473]">Output Tokens</div>
                                <div className="font-bold text-emerald-400 mt-0.5">{formatCompactNumber(p.outputTokens)}</div>
                              </div>
                              <div className="p-2 rounded-lg bg-[#14100c] border border-[rgba(242,236,223,0.05)]">
                                <div className="text-[9px] text-[#8e8473]">Cache Read</div>
                                <div className="font-bold text-[#38bdf8] mt-0.5">{formatCompactNumber(p.cacheRead)}</div>
                              </div>
                              <div className="p-2 rounded-lg bg-[#14100c] border border-[rgba(242,236,223,0.05)]">
                                <div className="text-[9px] text-[#8e8473]">Est. Turn Cost</div>
                                <div className="font-bold text-[#10b981] mt-0.5">{formatCurrency(p.cost)}</div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="py-12 text-center text-xs text-[#8e8473] font-mono">
                    No prompt trajectories recorded in this time range.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Code Impact Map */}
          <div className="lg:col-span-5 rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-[#e2a355]" /> Code Impact Map
                </h3>
                <Badge variant="default" className="text-[10px]">
                  {statsData?.impact?.files?.length || 0} {(statsData?.impact?.files?.length || 0) === 1 ? 'Module' : 'Modules'} Affected
                </Badge>
              </div>
              <p className="text-xs text-[#8e8473] mb-4">Files and components modified by AI agent sessions</p>

              {/* Dynamic Modern Impact Grid */}
              {statsData?.impact?.files?.length > 0 ? (
                <div className="grid grid-cols-2 gap-2.5">
                  {statsData.impact.files.slice(0, 6).map((f: any, idx: number) => {
                    const maxLines = Math.max(...statsData.impact.files.map((item: any) => Number(item.changedLines || item.edits || 1)), 1);
                    const score = f.riskScore || Math.min(100, Math.round(((Number(f.changedLines || f.edits || 1)) / maxLines) * 100));
                    const isHigh = score >= 70;
                    const isMed = score >= 40 && score < 70;
                    return (
                      <div 
                        key={idx}
                        className="p-3 rounded-xl bg-[#1c1712]/70 hover:bg-[#1c1712] border border-[rgba(242,236,223,0.06)] hover:border-[rgba(226,163,85,0.3)] transition-all flex flex-col justify-between group cursor-pointer"
                      >
                        <div>
                          <div className="text-xs font-mono font-semibold text-white group-hover:text-[#f5c485] transition-colors truncate">
                            {f.path || f.directory || 'module'}
                          </div>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-[10px] text-[#8e8473] font-mono">+{f.additions || 0} / -{f.deletions || 0}</span>
                            <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded ${
                              isHigh ? 'text-amber-400 bg-amber-500/10' :
                              isMed ? 'text-[#f5c485] bg-[#e2a355]/10' :
                              'text-[#8e8473] bg-[rgba(242,236,223,0.04)]'
                            }`}>
                              {score}% volume
                            </span>
                          </div>
                        </div>
                        <div className="mt-2.5 h-1.5 w-full bg-[#14100c] rounded-full overflow-hidden border border-[rgba(242,236,223,0.05)]">
                          <div 
                            className="h-full bg-gradient-to-r from-[#e2a355] to-[#f5c485] rounded-full transition-all duration-500"
                            style={{ width: `${score}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-10 flex flex-col items-center justify-center text-center p-6 border border-dashed border-[rgba(242,236,223,0.08)] rounded-xl bg-[#1c1712]/30 space-y-2">
                  <GitBranch className="h-6 w-6 text-[#8e8473] opacity-60" />
                  <span className="text-xs font-semibold text-white">No modified files recorded</span>
                  <span className="text-[11px] text-[#8e8473] max-w-xs">
                    Files and components modified during AI agent coding sessions will appear here.
                  </span>
                </div>
              )}
            </div>

            <div className="pt-4 mt-4 border-t border-[rgba(242,236,223,0.08)] flex items-center justify-between text-xs text-[#8e8473]">
              <span>Last synchronized <b>{lastSyncedAt}</b></span>
              <span className="text-[#10b981] font-medium">
                {(statsData?.impact?.files?.length || 0) > 0 ? 'Telemetry synced' : 'All systems green'}
              </span>
            </div>
          </div>
        </div>
      </>
    )}

    {/* Admin Delete Single Prompt Modal */}
    {deletingPrompt && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
        <div className="w-full max-w-lg rounded-2xl bg-[#14100c] border border-rose-500/40 shadow-2xl shadow-rose-950/40 p-6 space-y-5">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-rose-500/15 border border-rose-500/30 text-rose-400">
              <Trash2 className="h-5 w-5" />
            </div>
            <div className="space-y-1 flex-1">
              <h3 className="text-base font-bold font-mono text-white">Permanently Delete Prompt?</h3>
              <p className="text-xs text-[#8e8473]">
                Admin Action: This prompt text and its token telemetry will be permanently removed from database records.
              </p>
            </div>
            <button
              onClick={() => setDeletingPrompt(null)}
              className="text-[#8e8473] hover:text-white transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] p-4 space-y-3 font-mono text-xs">
            <div className="flex items-center justify-between text-[#cbbfad]">
              <span className="font-bold text-white">{deletingPrompt.model}</span>
              <span className="text-[#f5c485]">{formatCompactNumber(deletingPrompt.totalTokens)} tokens</span>
            </div>

            <div className="p-3 rounded-lg bg-[#14100c] border border-[rgba(242,236,223,0.04)] text-[#cbbfad] text-[11px] leading-relaxed line-clamp-3">
              &ldquo;{deletingPrompt.text}&rdquo;
            </div>

            <div className="flex items-center justify-between text-[11px] text-[#8e8473]">
              <span>{deletingPrompt.createdAt || 'Recently recorded'}</span>
              <span className="text-[#10b981]">{formatCurrency(deletingPrompt.cost)}</span>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeletingPrompt(null)}
              disabled={isDeletingPrompt}
              className="text-xs font-mono text-[#8e8473] hover:text-white"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => handleDeletePrompt(deletingPrompt)}
              disabled={isDeletingPrompt}
              className="bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs font-mono rounded-xl shadow-lg shadow-rose-900/30 flex items-center gap-1.5"
            >
              {isDeletingPrompt ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  Confirm Delete
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    )}
  </main>
</div>
);
}
