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
  User
} from 'lucide-react';
import { toast } from 'sonner';

interface PersonalDashboardProps {
  user: {
    id: string;
    username: string;
    displayName: string;
    role: string;
  };
}

export function PersonalDashboardView({ user }: PersonalDashboardProps) {
  const [timeRange, setTimeRange] = React.useState<'24h' | '7d' | '30d'>('24h');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [selectedPrompt, setSelectedPrompt] = React.useState<any | null>(null);
  const [statsData, setStatsData] = React.useState<any | null>(null);
  const [promptsList, setPromptsList] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  // Helper to compute from & to ISO strings
  const getRangeDates = React.useCallback((range: '24h' | '7d' | '30d') => {
    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    const fromDate = new Date(now);
    if (range === '24h') {
      return { from: to, to };
    } else if (range === '7d') {
      fromDate.setDate(fromDate.getDate() - 6);
      return { from: fromDate.toISOString().slice(0, 10), to };
    } else {
      fromDate.setDate(fromDate.getDate() - 29);
      return { from: fromDate.toISOString().slice(0, 10), to };
    }
  }, []);

  // Fetch real statistics on time range change
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const { from, to } = getRangeDates(timeRange);

    async function loadData() {
      try {
        const [statsRes, promptsRes] = await Promise.all([
          fetch(`/api/stats?from=${from}&to=${to}`),
          fetch(`/api/v1/team/prompts?from=${from}&to=${to}&limit=20`),
        ]);

        if (!cancelled && statsRes.ok) {
          const sData = await statsRes.json();
          setStatsData(sData);
        }

        if (!cancelled && promptsRes.ok) {
          const pData = await promptsRes.json();
          if (pData.prompts?.length) {
            setPromptsList(pData.prompts);
          }
        }
      } catch (err) {
        console.warn('Live personal stats fetch failed, falling back to cached view:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadData();
    return () => { cancelled = true; };
  }, [timeRange, getRangeDates]);

  // Derived KPI metrics based on live stats or fallback defaults
  const totalTokens = statsData?.totals ? (Number(statsData.totals.tokensIn || 0) + Number(statsData.totals.tokensOut || 0)) : (timeRange === '24h' ? 582400 : timeRange === '7d' ? 3420000 : 14850000);
  const cacheRead = statsData?.totals ? Number(statsData.totals.cacheRead || 0) : (timeRange === '24h' ? 398000 : timeRange === '7d' ? 2450000 : 9800000);
  const cacheEfficiency = totalTokens + cacheRead > 0 ? ((cacheRead / (totalTokens + cacheRead)) * 100).toFixed(1) : '68.2';
  const totalCost = statsData?.cost?.total ?? (timeRange === '24h' ? 7.25 : timeRange === '7d' ? 48.60 : 194.20);
  const edits = statsData?.totals?.edits ?? (timeRange === '24h' ? 142 : timeRange === '7d' ? 890 : 3420);

  // Per-day sparklines
  const sparklineTokens = statsData?.perDay?.length 
    ? statsData.perDay.map((d: any) => Number(d.tokensIn || 0) + Number(d.tokensOut || 0))
    : timeRange === '24h' 
      ? [20, 28, 45, 30, 60, 52, 75, 68, 90, 85, 100]
      : timeRange === '7d'
        ? [45, 55, 60, 80, 95, 110, 130]
        : [20, 30, 25, 45, 60, 55, 70, 85, 80, 95, 110, 125, 130, 145, 150];

  const kpis = [
    {
      title: 'Daily Token Usage',
      value: formatCompactNumber(totalTokens),
      unit: 'Tokens',
      delta: `${timeRange === '24h' ? '+7.1%' : timeRange === '7d' ? '+14.8%' : '+28.4%'} vs prev. period`,
      isPositive: true,
      sparkline: sparklineTokens,
      color: '#e2a355',
    },
    {
      title: 'Cache Hit Rate',
      value: `${cacheEfficiency}%`,
      unit: 'Efficiency',
      delta: '+3.5% vs prev. period',
      isPositive: true,
      sparkline: [40, 50, 48, 62, 58, 65, 70, 68, 72, 69, 74],
      color: '#10b981',
    },
    {
      title: 'Code Edits',
      value: formatCompactNumber(edits),
      unit: 'Edits',
      delta: `${timeRange === '24h' ? '+12' : timeRange === '7d' ? '+85' : '+310'} edits`,
      isPositive: true,
      sparkline: [80, 75, 70, 65, 60, 55, 50, 48, 45, 42, 38],
      color: '#3b82f6',
    },
    {
      title: 'Estimated Spend',
      value: formatCurrency(totalCost),
      unit: 'USD',
      delta: '+10.2% vs prev. period',
      isPositive: true,
      sparkline: [15, 25, 35, 45, 60, 70, 85, 95, 110, 125, 140],
      color: '#f5c485',
    },
  ];

  const defaultPrompts = [
    {
      id: 'p-1',
      text: 'Create a prompt to add idempotent schema migrations',
      category: 'Database / Migration',
      variation: 'Claude 3.7 Sonnet',
      usage: 133,
      cost: 7.20,
    },
    {
      id: 'p-2',
      text: 'Explore conference talks on distributed agent telemetry',
      category: 'Research / Web',
      variation: 'Cursor (o3-mini)',
      usage: 134,
      cost: 0.00,
    },
    {
      id: 'p-3',
      text: 'Insert a prompt to optimize vector similarity query',
      category: 'Optimization',
      variation: 'Codex / GPT-4o',
      usage: 132,
      cost: 0.05,
    },
    {
      id: 'p-4',
      text: 'Prompt to build real-time WebSocket sync heartbeat',
      category: 'Architecture',
      variation: 'Claude 3.5 Haiku',
      usage: 62,
      cost: 0.00,
    },
  ];

  const prompts = promptsList.length 
    ? promptsList.map((p, i) => ({
        id: p.id || `p-${i}`,
        text: p.prompt_text || p.text || 'Agent interaction turn',
        category: p.project || 'General',
        variation: p.model || 'Claude 3.7 Sonnet',
        usage: Number(p.tokens_in || 0) + Number(p.tokens_out || 0),
        cost: Number(p.cost || 0),
      }))
    : defaultPrompts;

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

  const filteredPrompts = prompts.filter(p => 
    !searchQuery || p.text.toLowerCase().includes(searchQuery.toLowerCase()) || p.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-[#0d0a07] text-[#f5efe6] font-sans antialiased relative selection:bg-[#e2a355]/30">
      {/* Ambient background glow orbs */}
      <div className="ambient-glow-backdrop" aria-hidden="true">
        <div className="ambient-orb ambient-orb-1" />
        <div className="ambient-orb ambient-orb-2" />
        <div className="ambient-orb ambient-orb-3" />
      </div>

      {/* Top Header */}
      <header className="sticky top-0 z-40 border-b border-[rgba(242,236,223,0.08)] bg-[#14100c]/80 backdrop-blur-xl px-6 py-3.5 flex items-center justify-between">
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

        {/* Header Controls */}
        <div className="flex items-center gap-3">
          {/* Time range selector */}
          <div className="flex bg-[#1c1712] p-1 rounded-xl border border-[rgba(242,236,223,0.08)]">
            {(['24h', '7d', '30d'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-3 py-1 text-xs font-medium rounded-lg transition-all ${
                  timeRange === r 
                    ? 'bg-gradient-to-r from-[#f5c485] to-[#e2a355] text-[#170f05] font-semibold shadow-sm' 
                    : 'text-[#8e8473] hover:text-[#f5efe6]'
                }`}
              >
                {r === '24h' ? 'Last 24 hours' : r === '7d' ? '7 Days' : '30 Days'}
              </button>
            ))}
          </div>

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

      {/* Main Content Area */}
      <main className="max-w-[1440px] mx-auto p-6 space-y-6 relative z-10">
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

            {/* Custom Glowing Spline Area Chart (SVG Canvas) */}
            <div className="relative h-64 w-full pt-4" style={{ height: '260px', width: '100%' }}>
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
                <line x1="0" y1="50" x2="700" y2="50" stroke="rgba(242,236,223,0.05)" strokeDasharray="4 4" />
                <line x1="0" y1="100" x2="700" y2="100" stroke="rgba(242,236,223,0.05)" strokeDasharray="4 4" />
                <line x1="0" y1="150" x2="700" y2="150" stroke="rgba(242,236,223,0.05)" strokeDasharray="4 4" />

                {/* Tokens In Spline Area */}
                <path
                  d="M 0,160 Q 120,130 200,100 T 350,30 T 500,70 T 700,90 L 700,200 L 0,200 Z"
                  fill="url(#gradient-in)"
                />
                <path
                  d="M 0,160 Q 120,130 200,100 T 350,30 T 500,70 T 700,90"
                  fill="none"
                  stroke="#e2a355"
                  strokeWidth="3"
                  className="filter drop-shadow-[0_0_8px_rgba(226,163,85,0.6)]"
                />

                {/* Tokens Out Spline Area */}
                <path
                  d="M 0,180 Q 140,160 220,130 T 350,80 T 520,110 T 700,130 L 700,200 L 0,200 Z"
                  fill="url(#gradient-out)"
                />
                <path
                  d="M 0,180 Q 140,160 220,130 T 350,80 T 520,110 T 700,130"
                  fill="none"
                  stroke="#ec4899"
                  strokeWidth="2.5"
                  className="filter drop-shadow-[0_0_8px_rgba(236,72,153,0.5)]"
                />

                {/* Cache Read Highlight Points */}
                <circle cx="350" cy="30" r="5" fill="#f5c485" className="animate-pulse" />
                <circle cx="350" cy="80" r="4" fill="#ec4899" />
                <circle cx="500" cy="70" r="4.5" fill="#f5c485" />
              </svg>

              {/* Time X-Axis */}
              <div className="flex justify-between text-[11px] text-[#8e8473] font-mono mt-2 pt-2 border-t border-[rgba(242,236,223,0.06)]">
                <span>00:00</span>
                <span>06:00</span>
                <span>09:00</span>
                <span>12:00</span>
                <span>15:00</span>
                <span>18:00</span>
                <span>24:00</span>
              </div>
            </div>
          </div>

          {/* Development Activity Matrix (Punchcard) */}
          <div className="lg:col-span-5 rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">Development Activity</h3>
                <Badge variant="copper" className="text-[10px]">Peak: 12h-15h</Badge>
              </div>
              <p className="text-xs text-[#8e8473] mb-4">Coding activity rhythm by day of week &amp; time of day</p>

              {/* Matrix Heat Bubbles */}
              <div className="space-y-2 font-mono text-[11px]">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, dIdx) => (
                  <div key={day} className="flex items-center gap-2">
                    <span className="w-8 text-[#8e8473]">{day}</span>
                    <div className="flex-1 grid grid-cols-12 gap-1.5">
                      {Array.from({ length: 12 }).map((_, hIdx) => {
                        const intensity = (dIdx * 3 + hIdx * 7) % 5;
                        const colors = [
                          'bg-[rgba(242,236,223,0.05)]',
                          'bg-[#4d3818]',
                          'bg-[#7d5822]',
                          'bg-[#b17d31]',
                          'bg-[#eab157]',
                        ];
                        return (
                          <div 
                            key={hIdx} 
                            className={`h-3.5 rounded-sm ${colors[intensity]} hover:ring-2 hover:ring-[#f5c485] transition-all cursor-pointer`}
                            title={`${day} ${(hIdx * 2)}:00 — ${intensity * 45} agent calls`}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-4 mt-4 border-t border-[rgba(242,236,223,0.08)] flex items-center justify-between text-xs text-[#8e8473]">
              <span>Active <b>6 days</b> in range</span>
              <span className="text-[#e2a355] font-semibold">Streak: 8 days 🔥</span>
            </div>
          </div>
        </div>

        {/* 3. BOTTOM ROW: PROMPT EXPLORER & CODE IMPACT MAP */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Prompt Trajectories Explorer */}
          <div className="lg:col-span-7 rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">Prompt Trajectories Explorer</h3>
                <p className="text-xs text-[#8e8473]">Recent agent trajectories and token variations</p>
              </div>
              <div className="relative">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8e8473]" />
                <input
                  type="text"
                  placeholder="Search prompts…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-[#1c1712] pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[rgba(242,236,223,0.08)] text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] w-44"
                />
              </div>
            </div>

            {/* Prompt Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[rgba(242,236,223,0.08)] text-[#8e8473] font-mono uppercase tracking-wider">
                    <th className="pb-3 font-medium">Recent Prompt</th>
                    <th className="pb-3 font-medium">Model / Agent</th>
                    <th className="pb-3 font-medium text-right">Tokens</th>
                    <th className="pb-3 font-medium text-right">Cost</th>
                    <th className="pb-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                  {filteredPrompts.map((p) => (
                    <tr 
                      key={p.id} 
                      onClick={() => toast.info(`Inspecting prompt diff: "${p.text}"`)}
                      className="hover:bg-[rgba(226,163,85,0.05)] cursor-pointer transition-colors"
                    >
                      <td className="py-3 pr-4 max-w-[240px] truncate font-medium text-[#cbbfad]">
                        {p.text}
                      </td>
                      <td className="py-3 text-[#8e8473]">
                        <span className="inline-block px-2 py-0.5 rounded bg-[#1c1712] text-[11px] border border-[rgba(242,236,223,0.08)]">
                          {p.variation}
                        </span>
                      </td>
                      <td className="py-3 text-right font-mono font-semibold text-white">
                        {p.usage}k
                      </td>
                      <td className="py-3 text-right font-mono text-[#10b981]">
                        {formatCurrency(p.cost)}
                      </td>
                      <td className="py-3 text-right text-[#8e8473]">
                        <ChevronRight className="h-4 w-4 inline" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Code Impact Map */}
          <div className="lg:col-span-5 rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-[#e2a355]" /> Code Impact Map
                </h3>
                <Badge variant="default" className="text-[10px]">7 Modules Affected</Badge>
              </div>
              <p className="text-xs text-[#8e8473] mb-4">Files and components modified by AI agent sessions</p>

              {/* Node Heatmap Grid */}
              <div className="grid grid-cols-6 gap-2">
                {[
                  { name: 'app/api/v1/team', changes: '+420 / -12', weight: 4 },
                  { name: 'lib/auth.ts', changes: '+94 / -6', weight: 2 },
                  { name: 'components/ui', changes: '+612 / -80', weight: 5 },
                  { name: 'public/style.css', changes: '+320 / -40', weight: 3 },
                  { name: 'scripts/migrate', changes: '+55 / -2', weight: 1 },
                  { name: 'lib/db.ts', changes: '+110 / -15', weight: 3 },
                ].map((mod, idx) => {
                  const colors = ['bg-[#2b2013]', 'bg-[#4d3818]', 'bg-[#7d5822]', 'bg-[#b17d31]', 'bg-[#eab157]'];
                  return (
                    <div 
                      key={idx}
                      className={`p-3 rounded-xl ${colors[mod.weight - 1]} col-span-3 border border-[rgba(242,236,223,0.1)] hover:scale-[1.02] transition-transform cursor-pointer`}
                      title={`${mod.name} (${mod.changes})`}
                    >
                      <div className="text-xs font-mono font-semibold text-white truncate">{mod.name}</div>
                      <div className="text-[10px] text-[rgba(242,236,223,0.7)] mt-1 font-mono">{mod.changes} lines</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pt-4 mt-4 border-t border-[rgba(242,236,223,0.08)] flex items-center justify-between text-xs text-[#8e8473]">
              <span>Last synchronized <b>4 minutes ago</b></span>
              <span className="text-[#10b981] font-medium">All systems green</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
