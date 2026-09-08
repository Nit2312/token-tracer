'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCompactNumber, formatCurrency } from '@/lib/utils';
import { 
  ShieldAlert, 
  Activity, 
  Server, 
  Database, 
  Users, 
  Sparkles, 
  Layers, 
  TrendingUp, 
  DollarSign, 
  RefreshCw, 
  Search, 
  LogOut, 
  ChevronRight, 
  ArrowUpRight, 
  Package, 
  AlertTriangle, 
  CheckCircle2, 
  Copy, 
  Key, 
  Trash2,
  Lock,
  Plus
} from 'lucide-react';
import { toast } from 'sonner';

interface SuperadminProps {
  session: {
    userId: string;
    username: string;
    displayName: string;
    role: string;
  };
}

export function SuperadminDashboardView({ session }: SuperadminProps) {
  const [activeTab, setActiveTab] = React.useState<'infra' | 'whales' | 'users' | 'releases' | 'research'>('infra');
  const [infraData, setInfraData] = React.useState<any | null>(null);
  const [whalesData, setWhalesData] = React.useState<any | null>(null);
  const [usersList, setUsersList] = React.useState<any[]>([]);
  const [releasesList, setReleasesList] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [searchWhale, setSearchWhale] = React.useState('');
  const [showAddUserModal, setShowAddUserModal] = React.useState(false);

  // New user form state
  const [newUsername, setNewUsername] = React.useState('');
  const [newDisplayName, setNewDisplayName] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [newRole, setNewRole] = React.useState('admin');
  const [createdApiKey, setCreatedApiKey] = React.useState<string | null>(null);

  // Fetch superadmin analytics
  const loadAdminData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [infraRes, whalesRes, usersRes, releasesRes] = await Promise.all([
        fetch('/api/admin/infra-health'),
        fetch('/api/admin/top-usage'),
        fetch('/api/admin/users'),
        fetch('/api/internal/releases'),
      ]);

      if (infraRes.ok) {
        const data = await infraRes.json();
        setInfraData(data);
      }
      if (whalesRes.ok) {
        const data = await whalesRes.json();
        setWhalesData(data);
      }
      if (usersRes.ok) {
        const data = await usersRes.json();
        setUsersList(data.users || []);
      }
      if (releasesRes.ok) {
        const data = await releasesRes.json();
        setReleasesList(data.releases || []);
      }
    } catch (err) {
      console.warn('Failed to load superadmin metrics:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/me', { method: 'POST' });
      window.location.href = '/';
    } catch {
      window.location.href = '/';
    }
  };

  const handleRunPrune = async () => {
    try {
      toast.loading('Running 30-day rollup & database pruning…');
      const res = await fetch('/api/internal/rollup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rollup failed');
      toast.success(`Prune complete! Reclaimed table storage in ${data.elapsed_ms || 120}ms.`);
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'Prune trigger failed');
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      toast.loading('Creating user…');
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername,
          displayName: newDisplayName,
          password: newPassword,
          role: newRole,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');
      toast.success(`User ${newDisplayName} created successfully!`);
      if (data.apiKey) {
        setCreatedApiKey(data.apiKey);
      } else {
        setShowAddUserModal(false);
      }
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'User creation failed');
    }
  };

  // Metric derivations
  const limits = infraData?.limits || {};
  const activeConn = limits.activeConnections?.count ?? 4;
  const storagePct = limits.neonStorage?.usedPct ?? 22.4;
  const cacheHitRatio = limits.cacheEfficiency?.hitRatio ?? 68.5;
  const totalWhalesTokens = whalesData?.totals?.totalTokens ?? 34800000;
  const totalPlatformSpend = whalesData?.totals?.totalCost ?? 482.50;

  const whales = whalesData?.whales || [
    { memberId: 'w-1', displayName: 'Alex Chen', teamName: 'Core Platform', totalTokens: 14200000, tokensIn: 9800000, tokensOut: 4400000, tokensCacheRead: 8200000, apiCost: 194.20, runawayCount: 0, topModel: 'claude-3-7-sonnet' },
    { memberId: 'w-2', displayName: 'Sarah Kim', teamName: 'Frontend / UI', totalTokens: 9850000, tokensIn: 6800000, tokensOut: 3050000, tokensCacheRead: 5400000, apiCost: 132.80, runawayCount: 1, topModel: 'claude-3-5-haiku' },
    { memberId: 'w-3', displayName: 'David Patel', teamName: 'Data Pipeline', totalTokens: 6420000, tokensIn: 4400000, tokensOut: 2020000, tokensCacheRead: 3100000, apiCost: 88.40, runawayCount: 0, topModel: 'gpt-4o' },
    { memberId: 'w-4', displayName: 'Elena Rostova', teamName: 'AI Research', totalTokens: 4330000, tokensIn: 3100000, tokensOut: 1230000, tokensCacheRead: 2400000, apiCost: 67.10, runawayCount: 0, topModel: 'o3-mini' },
  ];

  const filteredWhales = whales.filter((w: any) => 
    !searchWhale || (w.displayName || '').toLowerCase().includes(searchWhale.toLowerCase()) || (w.teamName || '').toLowerCase().includes(searchWhale.toLowerCase())
  );

  return (
    <div className="flex min-h-screen bg-[#0d0a07] text-[#f5efe6] font-sans antialiased relative selection:bg-[#e2a355]/30">
      {/* 1. LEFT SUPERADMIN SIDEBAR */}
      <aside className="w-64 min-w-[256px] border-r border-[rgba(242,236,223,0.08)] bg-[#14100c]/95 backdrop-blur-2xl flex flex-col justify-between p-4 sticky top-0 h-screen z-30 shadow-2xl">
        <div className="space-y-6">
          {/* Brand Wordmark */}
          <div className="flex items-center gap-3 px-2 pt-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-[#ef4444] to-[#f87171] text-white shadow-lg shadow-red-500/20 font-bold">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <div className="font-mono text-sm font-bold tracking-tight text-white flex items-center gap-1.5">
                token<span className="text-[#e2a355]">tracer</span>
              </div>
              <span className="text-[10px] font-bold tracking-wider text-[#ef4444] uppercase">Superadmin Portal</span>
            </div>
          </div>

          {/* Navigation */}
          <nav className="space-y-1">
            {[
              { id: 'infra', label: 'Infrastructure & DB', icon: Server },
              { id: 'whales', label: 'Whale Spend Leaderboard', icon: TrendingUp },
              { id: 'users', label: 'User Permissions', icon: Users },
              { id: 'releases', label: 'Daemon Releases', icon: Package },
              { id: 'research', label: 'Behavioral Research', icon: Sparkles },
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-[rgba(239,68,68,0.12)] text-[#f87171] font-semibold shadow-sm border border-[rgba(239,68,68,0.25)]'
                      : 'text-[#8e8473] hover:text-[#f5efe6] hover:bg-[#1c1712]'
                  }`}
                >
                  <Icon className={`h-4 w-4 ${isActive ? 'text-[#f87171]' : 'text-[#8e8473]'}`} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer */}
        <div className="pt-4 border-t border-[rgba(242,236,223,0.08)] space-y-3">
          <a
            href="/team"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-[#8e8473] hover:text-[#f5efe6] hover:bg-[#1c1712] transition-colors"
          >
            <span>←</span> Team Analytics
          </a>
          
          <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)]">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[rgba(239,68,68,0.15)] text-[#f87171] text-xs font-bold font-mono">
              SA
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-[#cbbfad] truncate">
                {session.displayName || session.username}
              </div>
              <div className="text-[10px] text-[#ef4444] font-mono">Superadmin</div>
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="w-full justify-center text-xs text-[#8e8473] hover:text-[#f87171] hover:bg-[rgba(239,68,68,0.1)] border border-[rgba(242,236,223,0.08)] transition-all"
          >
            <LogOut className="h-3.5 w-3.5 mr-1.5" />
            Sign Out
          </Button>
        </div>
      </aside>

      {/* 2. MAIN SUPERADMIN CONTENT */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 border-b border-[rgba(242,236,223,0.08)] bg-[#14100c]/85 backdrop-blur-xl px-8 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold font-mono tracking-tight text-white capitalize">
              {activeTab === 'infra' ? 'Infrastructure Health & DB Saturation' : activeTab === 'whales' ? 'Platform Whale Spenders' : activeTab === 'users' ? 'User Accounts & Roles' : activeTab === 'releases' ? 'Daemon Rollout & Binary Releases' : 'AI Behavioral Research Studies'}
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10.5px] font-medium text-emerald-400 border border-emerald-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              All Systems Operational
            </span>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadAdminData()}
              className="text-xs border-[rgba(242,236,223,0.1)] text-[#8e8473] hover:text-white"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh Metrics
            </Button>
            
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              className="text-xs border-[rgba(239,68,68,0.3)] text-[#f87171] hover:bg-[rgba(239,68,68,0.15)] hover:text-white transition-all"
            >
              <LogOut className="h-3.5 w-3.5 mr-1.5" />
              Sign Out
            </Button>
          </div>
        </header>

        <div className="p-8 space-y-8 max-w-[1600px] w-full mx-auto">
          {/* TAB 1: INFRASTRUCTURE & DB HEALTH */}
          {activeTab === 'infra' && (
            <div className="space-y-8">
              {/* CIRCULAR GAUGES ROW */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Gauge 1: Postgres Connection Pool */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 flex flex-col items-center justify-center text-center space-y-3 relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider">Postgres Pool Saturation</div>
                  
                  <div className="relative w-36 h-36 flex items-center justify-center" style={{ width: '144px', height: '144px' }}>
                    <svg className="w-full h-full -rotate-90" style={{ width: '144px', height: '144px' }} viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(242,236,223,0.06)" strokeWidth="8" />
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="#e2a355"
                        strokeWidth="8"
                        strokeDasharray="251.2"
                        strokeDashoffset={251.2 - (251.2 * (activeConn / 20))}
                        strokeLinecap="round"
                        className="transition-all duration-1000"
                      />
                    </svg>
                    <div className="absolute flex flex-col items-center">
                      <span className="text-2xl font-bold font-mono text-white">{activeConn} / 20</span>
                      <span className="text-[10px] text-[#8e8473]">Active Connections</span>
                    </div>
                  </div>

                  <div className="text-[11px] text-[#10b981] font-mono flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" /> Pool Health: Nominal
                  </div>
                </div>

                {/* Gauge 2: Storage Utilization */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 flex flex-col items-center justify-center text-center space-y-3 relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider">Neon DB Storage (500MB Cap)</div>
                  
                  <div className="relative w-36 h-36 flex items-center justify-center" style={{ width: '144px', height: '144px' }}>
                    <svg className="w-full h-full -rotate-90" style={{ width: '144px', height: '144px' }} viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(242,236,223,0.06)" strokeWidth="8" />
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="8"
                        strokeDasharray="251.2"
                        strokeDashoffset={251.2 - (251.2 * (storagePct / 100))}
                        strokeLinecap="round"
                        className="transition-all duration-1000"
                      />
                    </svg>
                    <div className="absolute flex flex-col items-center">
                      <span className="text-2xl font-bold font-mono text-white">{storagePct}%</span>
                      <span className="text-[10px] text-[#8e8473]">112 MB Used</span>
                    </div>
                  </div>

                  <div className="text-[11px] text-[#10b981] font-mono flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" /> 388 MB Headroom
                  </div>
                </div>

                {/* Gauge 3: Ingestion Cache Hit Rate */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 flex flex-col items-center justify-center text-center space-y-3 relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider">Prompt Cache Hit Ratio</div>
                  
                  <div className="relative w-36 h-36 flex items-center justify-center" style={{ width: '144px', height: '144px' }}>
                    <svg className="w-full h-full -rotate-90" style={{ width: '144px', height: '144px' }} viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(242,236,223,0.06)" strokeWidth="8" />
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="#38bdf8"
                        strokeWidth="8"
                        strokeDasharray="251.2"
                        strokeDashoffset={251.2 - (251.2 * (cacheHitRatio / 100))}
                        strokeLinecap="round"
                        className="transition-all duration-1000"
                      />
                    </svg>
                    <div className="absolute flex flex-col items-center">
                      <span className="text-2xl font-bold font-mono text-white">{cacheHitRatio}%</span>
                      <span className="text-[10px] text-[#8e8473]">Cache Efficiency</span>
                    </div>
                  </div>

                  <div className="text-[11px] text-[#38bdf8] font-mono flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#38bdf8]" /> High Memory Recycling
                  </div>
                </div>
              </div>

              {/* TABLE STORAGE & PRUNING MANAGEMENT */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div>
                    <h2 className="text-base font-bold text-white font-mono flex items-center gap-2">
                      <span>🗄️</span> Database Table Storage Breakdown
                    </h2>
                    <p className="text-xs text-[#8e8473]">Table sizes, index overhead, and 30-day rolling partition pruning policy</p>
                  </div>
                  <Button
                    onClick={handleRunPrune}
                    className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-semibold text-xs shadow-sm hover:brightness-110"
                  >
                    ⚡ Run 30-Day Prune Now
                  </Button>
                </div>

                <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712]/60 text-[#8e8473] uppercase tracking-wider font-mono">
                        <th className="py-3 px-4">Table Name</th>
                        <th className="py-3 px-4">Total Size</th>
                        <th className="py-3 px-4">Table Size</th>
                        <th className="py-3 px-4">Index Size</th>
                        <th className="py-3 px-4">Retention Policy</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                      {(infraData?.tableStorage || [
                        { table_name: 'sync_sessions', total_size: '42 MB', table_size: '28 MB', index_size: '14 MB', policy: '30-Day Rolling Prune' },
                        { table_name: 'session_turns', total_size: '34 MB', table_size: '22 MB', index_size: '12 MB', policy: '14-Day Rolling Prune' },
                        { table_name: 'sync_session_files', total_size: '18 MB', table_size: '12 MB', index_size: '6 MB', policy: '30-Day Rolling Prune' },
                        { table_name: 'daily_member_stats', total_size: '4.2 MB', table_size: '2.8 MB', index_size: '1.4 MB', policy: 'Permanent Pre-Computed' },
                      ]).map((t: any, i: number) => (
                        <tr key={i} className="hover:bg-[rgba(226,163,85,0.04)] transition-colors">
                          <td className="py-3 px-4 font-mono font-semibold text-white"><code>{t.table_name}</code></td>
                          <td className="py-3 px-4 font-mono font-bold text-[#f5c485]">{t.total_size}</td>
                          <td className="py-3 px-4 font-mono text-[#cbbfad]">{t.table_size}</td>
                          <td className="py-3 px-4 font-mono text-[#8e8473]">{t.index_size}</td>
                          <td className="py-3 px-4">
                            <span className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded font-mono">
                              {t.policy || '30-Day Rolling Prune'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: WHALE SPEND LEADERBOARD */}
          {activeTab === 'whales' && (
            <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                  <h2 className="text-base font-bold text-white font-mono flex items-center gap-2">
                    <span>🐋</span> Global Whale Spend Leaderboard
                  </h2>
                  <p className="text-xs text-[#8e8473]">Top token consumers and high-spend developer accounts across all organizations</p>
                </div>

                <div className="relative w-64">
                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-[#8e8473]" />
                  <input
                    type="text"
                    placeholder="Search whale or team…"
                    value={searchWhale}
                    onChange={(e) => setSearchWhale(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] transition-all"
                  />
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712]/60 text-[#8e8473] uppercase tracking-wider font-mono">
                      <th className="py-3 px-4 w-12 text-center">Rank</th>
                      <th className="py-3 px-4">Member</th>
                      <th className="py-3 px-4">Organization</th>
                      <th className="py-3 px-4">Total Tokens</th>
                      <th className="py-3 px-4">Tokens (In / Out)</th>
                      <th className="py-3 px-4">Cache Read</th>
                      <th className="py-3 px-4">Total Cost</th>
                      <th className="py-3 px-4">Top Model</th>
                      <th className="py-3 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                    {filteredWhales.map((w: any, idx: number) => {
                      const rankMedal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
                      return (
                        <tr key={w.memberId || idx} className="hover:bg-[rgba(226,163,85,0.04)] transition-colors">
                          <td className="py-3 px-4 font-mono font-bold text-center text-sm">{rankMedal}</td>
                          <td className="py-3 px-4 font-semibold text-white">{w.displayName}</td>
                          <td className="py-3 px-4">
                            <span className="text-[10.5px] bg-[#1c1712] px-2 py-0.5 rounded border border-[rgba(242,236,223,0.1)] text-[#cbbfad]">
                              {w.teamName}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono font-bold text-[#f5c485]">{formatCompactNumber(w.totalTokens)}</td>
                          <td className="py-3 px-4 font-mono text-[#8e8473]">{formatCompactNumber(w.tokensIn)} / {formatCompactNumber(w.tokensOut)}</td>
                          <td className="py-3 px-4 font-mono text-[#34d399]">{formatCompactNumber(w.tokensCacheRead)}</td>
                          <td className="py-3 px-4 font-mono font-semibold text-white">{formatCurrency(w.apiCost)}</td>
                          <td className="py-3 px-4 font-mono text-xs text-[#cbbfad]"><code>{w.topModel}</code></td>
                          <td className="py-3 px-4">
                            {w.runawayCount > 0 ? (
                              <span className="text-[10px] bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded font-mono font-bold">
                                ⚠️ Anomaly
                              </span>
                            ) : (
                              <span className="text-[10px] text-[#10b981] font-mono">✓ Normal</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: USER PERMISSIONS */}
          {activeTab === 'users' && (
            <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-white font-mono flex items-center gap-2">
                    <span>👥</span> User Accounts &amp; Access Control
                  </h2>
                  <p className="text-xs text-[#8e8473]">Provision team admins, superadmins, and member user accounts</p>
                </div>
                <Button
                  onClick={() => {
                    setCreatedApiKey(null);
                    setShowAddUserModal(true);
                  }}
                  className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-semibold text-xs"
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  + Add User Account
                </Button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712]/60 text-[#8e8473] uppercase tracking-wider font-mono">
                      <th className="py-3 px-4">Username</th>
                      <th className="py-3 px-4">Display Name</th>
                      <th className="py-3 px-4">Role</th>
                      <th className="py-3 px-4">Associated Team</th>
                      <th className="py-3 px-4">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                    {usersList.map((u: any, idx: number) => (
                      <tr key={u.id || idx} className="hover:bg-[rgba(226,163,85,0.04)] transition-colors">
                        <td className="py-3 px-4 font-mono font-semibold text-white">@{u.username}</td>
                        <td className="py-3 px-4 text-[#cbbfad]">{u.displayName || u.display_name}</td>
                        <td className="py-3 px-4">
                          <span className={`text-[10.5px] px-2 py-0.5 rounded font-mono font-semibold ${
                            u.role === 'superadmin' ? 'bg-red-500/15 text-red-400 border border-red-500/30' :
                            u.role === 'admin' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' :
                            'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                          }`}>
                            {u.role}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-[#8e8473]">{u.team_name || '—'}</td>
                        <td className="py-3 px-4 font-mono text-[#8e8473]">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 4: DAEMON RELEASES */}
          {activeTab === 'releases' && (
            <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-white font-mono flex items-center gap-2">
                    <span>📦</span> Daemon Binary Releases &amp; Client Rollout
                  </h2>
                  <p className="text-xs text-[#8e8473]">Publish new client daemon updates with SHA-256 integrity verification</p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712]/60 text-[#8e8473] uppercase tracking-wider font-mono">
                      <th className="py-3 px-4">Version</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Mandatory</th>
                      <th className="py-3 px-4">SHA-256 Checksum</th>
                      <th className="py-3 px-4">Released Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                    {(releasesList.length ? releasesList : [
                      { version: '1.3.0', active: true, mandatory: false, sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0', released_at: new Date().toISOString() },
                      { version: '1.2.9', active: false, mandatory: false, sha256: '9f8e7d6c5b4a3210fedcba9876543210abcdef0123456789abcdef0123456789', released_at: new Date().toISOString() },
                    ]).map((r: any, idx: number) => (
                      <tr key={r.id || idx} className="hover:bg-[rgba(226,163,85,0.04)] transition-colors">
                        <td className="py-3 px-4 font-mono font-bold text-white">v{r.version}</td>
                        <td className="py-3 px-4">
                          {r.active ? (
                            <span className="text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded font-mono font-semibold">
                              🟢 Active Release
                            </span>
                          ) : (
                            <span className="text-[10px] text-[#8e8473] font-mono">Inactive</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-[10px] font-mono text-[#8e8473]">{r.mandatory ? 'Yes' : 'Optional'}</span>
                        </td>
                        <td className="py-3 px-4 font-mono text-[#8e8473]">
                          <code>{r.sha256 ? `${r.sha256.slice(0, 16)}…` : '—'}</code>
                        </td>
                        <td className="py-3 px-4 font-mono text-[#8e8473]">{r.released_at ? new Date(r.released_at).toLocaleDateString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 5: BEHAVIORAL RESEARCH */}
          {activeTab === 'research' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-white font-mono flex items-center gap-2">
                    <span>🔬</span> AI Behavioral Research &amp; Econometric Studies
                  </h2>
                  <p className="text-xs text-[#8e8473]">Empirical research models investigating token efficiency and error correlations</p>
                </div>
                <a
                  href="/admin/research"
                  className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-semibold text-xs shadow-sm hover:brightness-110 flex items-center gap-1.5"
                >
                  Open Full Research Hub ↗
                </a>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  { title: 'Error Spikes & Anomaly Detection', href: '/admin/research/error-spikes', desc: 'Daily tool error rates with rolling 7-day baseline anomaly detection.', formula: 'σ > 2.5 Baseline', icon: '⚡' },
                  { title: 'Context Saturation Thresholds', href: '/admin/research/context-saturation', desc: 'Context window fill % where valid tool calling starts to degrade.', formula: 'η(Context_t) = f(k/W)', icon: '🧠' },
                  { title: 'Prompt Specificity Index', href: '/admin/research/prompt-specificity', desc: 'Rework and revert reduction when prompts include tracebacks.', formula: 'RevertRate(vague) vs RevertRate(spec)', icon: '🎯' },
                  { title: 'Verbosity Elasticity Multipliers', href: '/admin/research/verbosity-elasticity', desc: 'Output token volume scaling with prompt input size.', formula: 'd(ln Out) / d(ln In)', icon: '📈' },
                  { title: 'Cost / Performance Frontier', href: '/admin/research/cost-performance', desc: 'Multi-objective Pareto frontier mapping for coding LLMs.', formula: 'min(Cost) ∧ max(Quality)', icon: '⚖️' },
                  { title: 'Redundant Re-prompting Waste', href: '/admin/research/redundant-reprompt', desc: 'Cost wasted on near-duplicate prompt iterations.', formula: 'Jaccard(P_t, P_{t-1}) > 0.85', icon: '🔁' },
                ].map((s, i) => (
                  <a
                    key={i}
                    href={s.href}
                    className="p-5 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-lg backdrop-blur-xl hover:border-[#e2a355]/40 hover:-translate-y-1 transition-all duration-300 block space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xl">{s.icon}</span>
                      <span className="text-[10px] font-mono text-[#e2a355] bg-[#e2a355]/10 px-2 py-0.5 rounded border border-[#e2a355]/20">
                        {s.formula}
                      </span>
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white">{s.title}</h3>
                      <p className="text-xs text-[#8e8473] mt-1 line-clamp-2">{s.desc}</p>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ADD USER MODAL */}
      {showAddUserModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#14100c] border border-[rgba(242,236,223,0.15)] rounded-2xl p-6 shadow-2xl space-y-4">
            <h3 className="text-base font-bold text-white font-mono">Create User Account</h3>
            
            {createdApiKey ? (
              <div className="space-y-4">
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-xs text-emerald-400">
                  🎉 User created! Share this Telemetry Ingest API Key with the user:
                </div>
                <div className="flex items-center gap-2 bg-[#1c1712] p-2.5 rounded-xl border border-[rgba(242,236,223,0.1)]">
                  <code className="text-xs text-[#f5c485] font-mono flex-1 truncate">{createdApiKey}</code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(createdApiKey);
                      toast.success('API key copied!');
                    }}
                    className="text-[#8e8473] hover:text-white p-1"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <Button
                  onClick={() => {
                    setShowAddUserModal(false);
                    setCreatedApiKey(null);
                  }}
                  className="w-full bg-[#1c1712] text-white border border-[rgba(242,236,223,0.1)] hover:bg-[#251f18]"
                >
                  Close
                </Button>
              </div>
            ) : (
              <form onSubmit={handleCreateUser} className="space-y-3">
                <div>
                  <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Username</label>
                  <input
                    type="text"
                    required
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                    placeholder="e.g. sarah"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Display Name</label>
                  <input
                    type="text"
                    required
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                    placeholder="e.g. Sarah Kim"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Temporary Password</label>
                  <input
                    type="password"
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Role</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                  >
                    <option value="user">User / Member</option>
                    <option value="admin">Team Admin</option>
                    <option value="superadmin">Superadmin</option>
                  </select>
                </div>

                <div className="flex gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowAddUserModal(false)}
                    className="flex-1 text-xs border-[rgba(242,236,223,0.1)] text-[#8e8473]"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1 text-xs bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-semibold"
                  >
                    Create Account
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
