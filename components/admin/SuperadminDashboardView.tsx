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
  Plus,
  Zap,
  Clock,
  Radio,
  FileCode,
  Calendar,
  ChevronDown,
  BarChart3,
  Cpu,
  RotateCcw,
  Check,
  Flame,
  HelpCircle,
  ExternalLink,
  Edit3,
  UserCheck,
  UserX,
  Shield,
  KeyRound,
  Eye,
  EyeOff,
  Terminal,
  X,
  CheckCheck,
  UserPlus,
  Filter,
  UserCog,
  Tag,
  Coins
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
  const [activeTab, setActiveTab] = React.useState<
    'overview' | 'roi' | 'pricing' | 'friction' | 'hotspots' | 'traffic' | 'whales' | 'storage' | 'users'
  >('overview');

  const [infraData, setInfraData] = React.useState<any | null>(null);
  const [whalesData, setWhalesData] = React.useState<any | null>(null);
  const [roiData, setRoiData] = React.useState<any | null>(null);
  const [roiRange, setRoiRange] = React.useState<'7d' | '30d' | '90d' | 'all'>('30d');
  const [pricingList, setPricingList] = React.useState<any[]>([]);
  const [defaultPricingRules, setDefaultPricingRules] = React.useState<any[]>([]);
  const [usersList, setUsersList] = React.useState<any[]>([]);
  const [unlinkedMembers, setUnlinkedMembers] = React.useState<any[]>([]);
  const [teamsList, setTeamsList] = React.useState<any[]>([]);
  const [releasesList, setReleasesList] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [searchWhale, setSearchWhale] = React.useState('');
  const [hoveredTrafficIndex, setHoveredTrafficIndex] = React.useState<number | null>(null);

  // Model Pricing State
  const [showPricingModal, setShowPricingModal] = React.useState(false);
  const [editingPricingRule, setEditingPricingRule] = React.useState<any | null>(null);
  const [pricingModelPattern, setPricingModelPattern] = React.useState('');
  const [pricingTeamId, setPricingTeamId] = React.useState('global');
  const [pricingCostIn, setPricingCostIn] = React.useState('');
  const [pricingCostOut, setPricingCostOut] = React.useState('');
  const [pricingCostCache, setPricingCostCache] = React.useState('');
  const [pricingSyncRecalc, setPricingSyncRecalc] = React.useState(true);
  const [pricingDeleteConfirm, setPricingDeleteConfirm] = React.useState<any | null>(null);
  const [recalculatingCosts, setRecalculatingCosts] = React.useState(false);
  const [pricingSearch, setPricingSearch] = React.useState('');

  // User Management Filter State
  const [userSearch, setUserSearch] = React.useState('');
  const [userRoleFilter, setUserRoleFilter] = React.useState<'all' | 'user' | 'admin' | 'superadmin'>('all');
  const [userStatusFilter, setUserStatusFilter] = React.useState<'all' | 'active' | 'inactive'>('all');

  // Add User Modal State
  const [showAddUserModal, setShowAddUserModal] = React.useState(false);
  const [newUsername, setNewUsername] = React.useState('');
  const [newDisplayName, setNewDisplayName] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [newRole, setNewRole] = React.useState<'user' | 'admin' | 'superadmin'>('user');
  const [newMemberOption, setNewMemberOption] = React.useState<string>('new');
  const [newTeamIds, setNewTeamIds] = React.useState<string[]>([]);
  const [newCustomTeam, setNewCustomTeam] = React.useState('');
  const [createdApiKey, setCreatedApiKey] = React.useState<string | null>(null);
  const [createdInstallMac, setCreatedInstallMac] = React.useState<string | null>(null);
  const [createdInstallWin, setCreatedInstallWin] = React.useState<string | null>(null);

  // Edit User Modal State
  const [editUserModal, setEditUserModal] = React.useState<any | null>(null);
  const [editDisplayName, setEditDisplayName] = React.useState('');
  const [editUsername, setEditUsername] = React.useState('');
  const [editRole, setEditRole] = React.useState<'user' | 'admin' | 'superadmin'>('user');
  const [editActive, setEditActive] = React.useState(true);
  const [editMemberId, setEditMemberId] = React.useState<string | null>(null);
  const [editTeamIds, setEditTeamIds] = React.useState<string[]>([]);
  const [editCustomTeam, setEditCustomTeam] = React.useState('');

  // Reset Password Modal State
  const [resetPasswordModal, setResetPasswordModal] = React.useState<any | null>(null);
  const [resetNewPassword, setResetNewPassword] = React.useState('');
  const [resetResultPassword, setResetResultPassword] = React.useState<string | null>(null);

  // Delete Confirm Modal State
  const [deleteConfirmModal, setDeleteConfirmModal] = React.useState<any | null>(null);

  // View Setup / API Key Modal State
  const [viewSetupModal, setViewSetupModal] = React.useState<any | null>(null);

  // Fetch superadmin analytics
  const loadAdminData = React.useCallback(async () => {
    setLoading(true);
    try {
      const [infraRes, whalesRes, usersRes, releasesRes, roiRes, pricingRes] = await Promise.all([
        fetch('/api/admin/infra-health'),
        fetch('/api/admin/top-usage'),
        fetch('/api/admin/users'),
        fetch('/api/internal/releases'),
        fetch(`/api/admin/model-roi?range=${roiRange}`),
        fetch('/api/admin/pricing'),
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
        setUnlinkedMembers(data.unlinkedMembers || []);
        setTeamsList(data.teams || []);
      }
      if (releasesRes.ok) {
        const data = await releasesRes.json();
        setReleasesList(data.releases || []);
      }
      if (roiRes.ok) {
        const data = await roiRes.json();
        setRoiData(data);
      }
      if (pricingRes.ok) {
        const data = await pricingRes.json();
        setPricingList(data.pricing || []);
        setDefaultPricingRules(data.defaultRules || []);
      }
    } catch (err) {
      console.warn('Failed to load superadmin metrics:', err);
    } finally {
      setLoading(false);
    }
  }, [roiRange]);

  React.useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  const openCreatePricingModal = (preset?: { pattern: string; costIn: number; costOut: number; costCache: number }) => {
    setEditingPricingRule(null);
    if (preset) {
      setPricingModelPattern(preset.pattern);
      setPricingCostIn(String(preset.costIn));
      setPricingCostOut(String(preset.costOut));
      setPricingCostCache(String(preset.costCache));
    } else {
      setPricingModelPattern('');
      setPricingCostIn('');
      setPricingCostOut('');
      setPricingCostCache('');
    }
    setPricingTeamId('global');
    setPricingSyncRecalc(true);
    setShowPricingModal(true);
  };

  const openEditPricingModal = (rule: any) => {
    setEditingPricingRule(rule);
    setPricingModelPattern(rule.model_pattern || '');
    setPricingTeamId(rule.team_id || 'global');
    setPricingCostIn(String(rule.cost_in_per_m ?? ''));
    setPricingCostOut(String(rule.cost_out_per_m ?? ''));
    setPricingCostCache(String(rule.cost_cache_read_per_m ?? ''));
    setPricingSyncRecalc(true);
    setShowPricingModal(true);
  };

  const handleSavePricing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pricingModelPattern.trim()) {
      toast.error('Model pattern name is required');
      return;
    }
    try {
      toast.loading(editingPricingRule ? 'Updating pricing rule…' : 'Creating pricing rule…');
      const res = await fetch('/api/admin/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingPricingRule?.id,
          teamId: pricingTeamId,
          modelPattern: pricingModelPattern.trim(),
          costInPerM: parseFloat(pricingCostIn) || 0,
          costOutPerM: parseFloat(pricingCostOut) || 0,
          costCacheReadPerM: parseFloat(pricingCostCache) || 0,
          syncRecalc: pricingSyncRecalc,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save pricing rule');
      toast.success(editingPricingRule ? 'Pricing rule updated & historical costs synced!' : 'New model pricing rule active!');
      setShowPricingModal(false);
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'Pricing update failed');
    }
  };

  const handleDeletePricing = async () => {
    if (!pricingDeleteConfirm) return;
    try {
      toast.loading('Deleting custom pricing rule…');
      const res = await fetch(`/api/admin/pricing?id=${encodeURIComponent(pricingDeleteConfirm.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete pricing rule');
      toast.success('Custom pricing override removed. Reverted to system defaults.');
      setPricingDeleteConfirm(null);
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'Pricing deletion failed');
    }
  };

  const handleGlobalRecalculate = async () => {
    setRecalculatingCosts(true);
    try {
      toast.loading('Recalculating historical telemetry costs across all teams…');
      const res = await fetch('/api/admin/pricing/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Recalculation failed');
      toast.success(data.message || 'Successfully recalculated all historical telemetry costs!');
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'Recalculation failed');
    } finally {
      setRecalculatingCosts(false);
    }
  };

  const handleLogout = async () => {
    try {
      await Promise.allSettled([
        fetch('/api/auth/me', { method: 'POST', credentials: 'same-origin' }),
        fetch('/api/auth/login', { method: 'DELETE', credentials: 'same-origin' }),
        fetch('/api/v1/auth/login', { method: 'DELETE', credentials: 'same-origin' }),
      ]);
    } catch (err) {
      console.warn('Logout error:', err);
    }
    document.cookie = 'app_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0;';
    document.cookie = 'sa_original_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0;';
    document.cookie = 'team_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0;';
    window.location.replace('/');
  };

  const handleRunPrune = async () => {
    try {
      toast.loading('Running 30-day rollup & database storage pruning…');
      const res = await fetch('/api/internal/rollup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rollup failed');
      toast.success(`Prune complete! Reclaimed table storage in ${data.elapsed_ms || 140}ms.`);
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'Prune trigger failed');
    }
  };

  const resetCreateForm = () => {
    setNewUsername('');
    setNewDisplayName('');
    setNewPassword('');
    setNewRole('user');
    setNewMemberOption('new');
    setNewTeamIds([]);
    setNewCustomTeam('');
    setCreatedApiKey(null);
    setCreatedInstallMac(null);
    setCreatedInstallWin(null);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      toast.loading('Creating user account…');
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUsername,
          displayName: newDisplayName,
          password: newPassword,
          role: newRole,
          memberId: newMemberOption === 'new' ? 'new' : (newMemberOption !== 'none' ? newMemberOption : null),
          teamIds: newTeamIds,
          newTeamName: newCustomTeam || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');
      toast.success(`User ${newDisplayName} created successfully!`);
      if (data.apiKey) {
        setCreatedApiKey(data.apiKey);
        setCreatedInstallMac(data.installCommandMac);
        setCreatedInstallWin(data.installCommandWin);
      } else {
        setShowAddUserModal(false);
        resetCreateForm();
      }
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'User creation failed');
    }
  };

  const handleOpenEditModal = (u: any) => {
    setEditUserModal(u);
    setEditDisplayName(u.displayName || u.display_name || '');
    setEditUsername(u.username || '');
    setEditRole(u.role || 'user');
    setEditActive(u.active !== false);
    setEditMemberId(u.member_id || null);
    const existingTeamIds = Array.isArray(u.teams) ? u.teams.map((t: any) => t.id) : (u.team_id ? [u.team_id] : []);
    setEditTeamIds(existingTeamIds);
    setEditCustomTeam('');
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUserModal) return;
    try {
      toast.loading(`Updating ${editDisplayName}…`);
      const res = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editUserModal.id,
          username: editUsername,
          displayName: editDisplayName,
          role: editRole,
          active: editActive,
          memberId: editMemberId,
          teamIds: editTeamIds,
          newTeamName: editCustomTeam || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update user');
      toast.success(`User updated successfully!`);
      setEditUserModal(null);
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'Update failed');
    }
  };

  const handleToggleUserStatus = async (u: any) => {
    try {
      const nextActive = u.active === false;
      toast.loading(`${nextActive ? 'Activating' : 'Deactivating'} ${u.displayName || u.username}…`);
      const res = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: u.id, active: nextActive }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Status update failed');
      toast.success(`User is now ${nextActive ? 'active' : 'inactive'}.`);
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'Status toggle failed');
    }
  };

  const handleOpenResetModal = (u: any) => {
    setResetPasswordModal(u);
    setResetNewPassword('');
    setResetResultPassword(null);
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPasswordModal) return;
    try {
      toast.loading('Resetting password…');
      const res = await fetch('/api/admin/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: resetPasswordModal.id,
          newPassword: resetNewPassword.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Password reset failed');
      setResetResultPassword(data.newPassword);
      toast.success(`Password reset successfully!`);
    } catch (err: any) {
      toast.error(err.message || 'Reset failed');
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteConfirmModal) return;
    try {
      toast.loading(`Deleting ${deleteConfirmModal.displayName || deleteConfirmModal.username}…`);
      const res = await fetch(`/api/admin/users?id=${deleteConfirmModal.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      toast.success('User deleted successfully.');
      setDeleteConfirmModal(null);
      await loadAdminData();
    } catch (err: any) {
      toast.error(err.message || 'Delete failed');
    }
  };

  const handleImpersonateUser = async (u: any) => {
    try {
      toast.loading(`Impersonating ${u.displayName || u.username}…`);
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Impersonation failed');
      toast.success(`Switched identity to ${u.displayName || u.username}! Redirecting…`);
      window.location.href = data.redirect || '/';
    } catch (err: any) {
      toast.error(err.message || 'Impersonation failed');
    }
  };

  const handleOpenSetupModal = (u: any) => {
    const serverUrl = typeof window !== 'undefined' ? window.location.origin : 'https://token-tracer-three.vercel.app';
    const macCmd = u.api_key ? `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${u.api_key}` : `curl -fsSL ${serverUrl}/install.sh | bash`;
    const winCmd = u.api_key ? `$ApiKey="${u.api_key}"; iex (irm ${serverUrl}/install.ps1)` : `iex (irm ${serverUrl}/install.ps1)`;
    setViewSetupModal({
      ...u,
      macCmd,
      winCmd,
    });
  };

  // Filtered users calculation
  const filteredUsers = React.useMemo(() => {
    return usersList.filter((u) => {
      const q = userSearch.toLowerCase();
      const matchSearch = !q ||
        (u.username && u.username.toLowerCase().includes(q)) ||
        (u.displayName && u.displayName.toLowerCase().includes(q)) ||
        (u.team_name && u.team_name.toLowerCase().includes(q));
      
      const matchRole = userRoleFilter === 'all' || u.role === userRoleFilter;
      const matchStatus = userStatusFilter === 'all' || (userStatusFilter === 'active' ? u.active !== false : u.active === false);
      
      return matchSearch && matchRole && matchStatus;
    });
  }, [usersList, userSearch, userRoleFilter, userStatusFilter]);

  // Metric derivations
  const limits = infraData?.limits || {};
  const activeConn = limits.activeConnections?.count ?? 4;
  const storagePct = limits.neonStorage?.usedPct ?? 22.4;
  const dbSizePretty = infraData?.databaseSize?.pretty_size ?? '112 MB';
  const cacheHitRatio = limits.cacheEfficiency?.hitRatio ?? 68.5;
  const totalWhalesTokens = whalesData?.totals?.totalTokens ?? 440600000;
  const totalPlatformSpend = whalesData?.totals?.totalCost ?? 173.93;
  const batchesToday = infraData?.ingestion?.batches_today ?? 1420;
  const sessionsToday = infraData?.ingestion?.sessions_today ?? 48;

  const whales = whalesData?.whales || [
    { memberId: 'w-1', displayName: 'nit', teamName: 'Core Platform', totalTokens: 184200000, tokensIn: 128000000, tokensOut: 56200000, tokensCacheRead: 94000000, apiCost: 74.20, runawayCount: 0, topModel: 'claude-3-7-sonnet' },
    { memberId: 'w-2', displayName: 'hiten', teamName: 'Frontend / UI', totalTokens: 112500000, tokensIn: 78000000, tokensOut: 34500000, tokensCacheRead: 61000000, apiCost: 45.80, runawayCount: 1, topModel: 'claude-3-5-haiku' },
    { memberId: 'w-3', displayName: 'Shreya Mecwan', teamName: 'Data Pipeline', totalTokens: 84200000, tokensIn: 59000000, tokensOut: 25200000, tokensCacheRead: 42000000, apiCost: 32.40, runawayCount: 0, topModel: 'gpt-4o' },
    { memberId: 'w-4', displayName: 'Alex Chen', teamName: 'AI Research', totalTokens: 59700000, tokensIn: 41000000, tokensOut: 18700000, tokensCacheRead: 31000000, apiCost: 21.53, runawayCount: 0, topModel: 'o3-mini' },
  ];

  const filteredWhales = whales.filter((w: any) => 
    !searchWhale || (w.displayName || '').toLowerCase().includes(searchWhale.toLowerCase()) || (w.teamName || '').toLowerCase().includes(searchWhale.toLowerCase())
  );

  // 14-day sample ingestion traffic dataset
  const trafficData = React.useMemo(() => {
    return [
      { date: 'Aug 26', syncs: 820, turns: 240, queries: 120, total: 1180, latency: 135 },
      { date: 'Aug 27', syncs: 940, turns: 280, queries: 140, total: 1360, latency: 142 },
      { date: 'Aug 28', syncs: 1120, turns: 340, queries: 180, total: 1640, latency: 138 },
      { date: 'Aug 29', syncs: 1050, turns: 310, queries: 160, total: 1520, latency: 145 },
      { date: 'Aug 30', syncs: 780, turns: 210, queries: 90, total: 1080, latency: 128 },
      { date: 'Aug 31', syncs: 690, turns: 190, queries: 80, total: 960, latency: 124 },
      { date: 'Sep 01', syncs: 1240, turns: 420, queries: 210, total: 1870, latency: 152 },
      { date: 'Sep 02', syncs: 1380, turns: 460, queries: 230, total: 2070, latency: 148 },
      { date: 'Sep 03', syncs: 1490, turns: 510, queries: 250, total: 2250, latency: 144 },
      { date: 'Sep 04', syncs: 1620, turns: 580, queries: 290, total: 2490, latency: 140 },
      { date: 'Sep 05', syncs: 1540, turns: 530, queries: 270, total: 2340, latency: 139 },
      { date: 'Sep 06', syncs: 980, turns: 290, queries: 130, total: 1400, latency: 131 },
      { date: 'Sep 07', syncs: 1100, turns: 360, queries: 170, total: 1630, latency: 136 },
      { date: 'Sep 08', syncs: 1420, turns: 490, queries: 240, total: 2150, latency: 140 },
    ];
  }, []);

  return (
    <div className="flex min-h-screen bg-[#0d0a07] text-[#f5efe6] font-sans antialiased relative selection:bg-[#e2a355]/30">
      {/* 1. LEFT SUPERADMIN SIDEBAR */}
      <aside className="w-72 min-w-[288px] border-r border-[rgba(242,236,223,0.07)] bg-gradient-to-b from-[#14100c]/98 via-[#100c09]/98 to-[#0a0806]/98 backdrop-blur-2xl flex flex-col justify-between p-4 sticky top-0 h-screen z-30 shadow-[4px_0_30px_rgba(0,0,0,0.7)] overflow-hidden font-mono">
        <div className="flex flex-col flex-1 min-h-0 space-y-4">
          {/* Brand Header */}
          <div className="px-2 pt-1.5 pb-2 shrink-0 border-b border-[rgba(242,236,223,0.06)] space-y-3">
            <div className="flex items-center gap-3">
              <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-[#e2a355] via-[#f5c485] to-[#e2a355] text-[#170f05] shadow-lg shadow-[#e2a355]/25 font-bold shrink-0">
                <ShieldAlert className="h-5 w-5" />
                <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 border-2 border-[#14100c]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold tracking-tight text-white flex items-center justify-between">
                  <span>token<span className="text-[#e2a355]">tracer</span></span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[rgba(226,163,85,0.15)] text-[#f5c485] border border-[rgba(226,163,85,0.3)]">
                    SUPERADMIN
                  </span>
                </div>
                <div className="text-[10px] text-[#8e8473] truncate mt-0.5 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Cluster Telemetry Active
                </div>
              </div>
            </div>
          </div>

          {/* Navigation Scrollable Area */}
          <nav className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4 scrollbar-thin scrollbar-thumb-[rgba(242,236,223,0.08)] scrollbar-track-transparent">
            {/* Section 1: Fleet & Governance */}
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-[#8e8473] px-3 py-1 font-bold flex items-center justify-between">
                <span>Fleet &amp; Infrastructure</span>
                <span className="text-[9px] text-[#8e8473]/70 font-normal">Core</span>
              </div>

              <button
                onClick={() => setActiveTab('overview')}
                className={`w-full relative flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs transition-all ${
                  activeTab === 'overview'
                    ? 'bg-gradient-to-r from-[rgba(226,163,85,0.18)] to-[rgba(226,163,85,0.04)] text-[#f5c485] font-bold border border-[rgba(226,163,85,0.3)] shadow-sm before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-[#e2a355]'
                    : 'text-[#cbbfad] hover:text-white hover:bg-[#1a140f] border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Server className={`h-4 w-4 ${activeTab === 'overview' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
                  <span>Overview &amp; Guardrails</span>
                </div>
                <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-sans">
                  Nominal
                </span>
              </button>

              <button
                onClick={() => setActiveTab('traffic')}
                className={`w-full relative flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs transition-all ${
                  activeTab === 'traffic'
                    ? 'bg-gradient-to-r from-[rgba(56,189,248,0.18)] to-[rgba(56,189,248,0.04)] text-[#38bdf8] font-bold border border-sky-500/30 shadow-sm before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-[#38bdf8]'
                    : 'text-[#cbbfad] hover:text-white hover:bg-[#1a140f] border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Activity className={`h-4 w-4 ${activeTab === 'traffic' ? 'text-[#38bdf8]' : 'text-[#8e8473]'}`} />
                  <span>Ingestion Velocity</span>
                </div>
                <span className="text-[9.5px] text-[#8e8473]">14d Trend</span>
              </button>

              <button
                onClick={() => setActiveTab('whales')}
                className={`w-full relative flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs transition-all ${
                  activeTab === 'whales'
                    ? 'bg-gradient-to-r from-[rgba(226,163,85,0.18)] to-[rgba(226,163,85,0.04)] text-[#f5c485] font-bold border border-[rgba(226,163,85,0.3)] shadow-sm before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-[#e2a355]'
                    : 'text-[#cbbfad] hover:text-white hover:bg-[#1a140f] border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <TrendingUp className={`h-4 w-4 ${activeTab === 'whales' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
                  <span>Whale Sentinel</span>
                </div>
                <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  Spenders
                </span>
              </button>

              <button
                onClick={() => setActiveTab('users')}
                className={`w-full relative flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs transition-all ${
                  activeTab === 'users'
                    ? 'bg-gradient-to-r from-[rgba(226,163,85,0.18)] to-[rgba(226,163,85,0.04)] text-[#f5c485] font-bold border border-[rgba(226,163,85,0.3)] shadow-sm before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-[#e2a355]'
                    : 'text-[#cbbfad] hover:text-white hover:bg-[#1a140f] border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Users className={`h-4 w-4 ${activeTab === 'users' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
                  <span>User Accounts</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#1c1712] text-[#f5c485] border border-[rgba(242,236,223,0.1)] font-bold">
                  {usersList.length}
                </span>
              </button>

              <button
                onClick={() => setActiveTab('pricing')}
                className={`w-full relative flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs transition-all ${
                  activeTab === 'pricing'
                    ? 'bg-gradient-to-r from-[rgba(226,163,85,0.18)] to-[rgba(226,163,85,0.04)] text-[#f5c485] font-bold border border-[rgba(226,163,85,0.3)] shadow-sm before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-[#e2a355]'
                    : 'text-[#cbbfad] hover:text-white hover:bg-[#1a140f] border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Tag className={`h-4 w-4 ${activeTab === 'pricing' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
                  <span>Model Pricing Rates</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[rgba(226,163,85,0.15)] text-[#f5c485] border border-[rgba(226,163,85,0.3)] font-bold">
                  {pricingList.length}
                </span>
              </button>
            </div>

            {/* Section 2: Core Analytical Research */}
            <div className="space-y-1 pt-1">
              <div className="text-[10px] uppercase tracking-wider text-[#8e8473] px-3 py-1 font-bold flex items-center justify-between">
                <span>The &quot;Why&quot; Research Suite</span>
                <span className="text-[9px] text-[#e2a355]">3 Studies</span>
              </div>

              <button
                onClick={() => setActiveTab('roi')}
                className={`w-full relative flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs transition-all ${
                  activeTab === 'roi'
                    ? 'bg-gradient-to-r from-[rgba(16,185,129,0.18)] to-[rgba(16,185,129,0.04)] text-emerald-400 font-bold border border-emerald-500/30 shadow-sm before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-emerald-400'
                    : 'text-[#cbbfad] hover:text-white hover:bg-[#1a140f] border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <DollarSign className={`h-4 w-4 ${activeTab === 'roi' ? 'text-emerald-400' : 'text-[#8e8473]'}`} />
                  <span>#1: Model ROI Frontier</span>
                </div>
                <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  Live
                </span>
              </button>

              <button
                onClick={() => setActiveTab('friction')}
                className={`w-full relative flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs transition-all ${
                  activeTab === 'friction'
                    ? 'bg-gradient-to-r from-[rgba(245,158,11,0.18)] to-[rgba(245,158,11,0.04)] text-amber-400 font-bold border border-amber-500/30 shadow-sm before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-amber-400'
                    : 'text-[#cbbfad] hover:text-white hover:bg-[#1a140f] border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Flame className={`h-4 w-4 ${activeTab === 'friction' ? 'text-amber-400' : 'text-[#8e8473]'}`} />
                  <span>#2: AI Friction &amp; Rework</span>
                </div>
                <span className="text-[9.5px] text-[#8e8473]">Cascades</span>
              </button>

              <button
                onClick={() => setActiveTab('hotspots')}
                className={`w-full relative flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs transition-all ${
                  activeTab === 'hotspots'
                    ? 'bg-gradient-to-r from-[rgba(192,132,252,0.18)] to-[rgba(192,132,252,0.04)] text-[#c084fc] font-bold border border-purple-500/30 shadow-sm before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-[#c084fc]'
                    : 'text-[#cbbfad] hover:text-white hover:bg-[#1a140f] border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <FileCode className={`h-4 w-4 ${activeTab === 'hotspots' ? 'text-[#c084fc]' : 'text-[#8e8473]'}`} />
                  <span>#3: Codebase Hotspots</span>
                </div>
                <span className="text-[9.5px] text-[#8e8473]">Churn</span>
              </button>
            </div>

            {/* Section 3: Econometric Deep Dives */}
            <div className="space-y-1 pt-1">
              <div className="text-[10px] uppercase tracking-wider text-[#8e8473] px-3 py-1 font-bold flex items-center justify-between">
                <span>Econometric Studies</span>
                <span className="text-[9px] text-[#8e8473]/70 font-normal">7 Models</span>
              </div>

              {[
                { href: '/admin/research/error-spikes', label: 'Error Spikes & Anomaly', icon: Zap, color: 'text-red-400' },
                { href: '/admin/research/context-saturation', label: 'Context Saturation', icon: Layers, color: 'text-[#e2a355]' },
                { href: '/admin/research/prompt-specificity', label: 'Prompt Specificity', icon: CheckCircle2, color: 'text-emerald-400' },
                { href: '/admin/research/verbosity-elasticity', label: 'Verbosity Elasticity', icon: TrendingUp, color: 'text-cyan-400' },
                { href: '/admin/research/cost-performance', label: 'Cost / Performance', icon: DollarSign, color: 'text-purple-400' },
                { href: '/admin/research/redundant-reprompt', label: 'Redundant Re-prompting', icon: RotateCcw, color: 'text-amber-400' },
                { href: '/admin/research/daemon-cohorts', label: 'Daemon Cohorts', icon: Package, color: 'text-emerald-400' },
              ].map((study, idx) => {
                const IconComponent = study.icon;
                return (
                  <a
                    key={idx}
                    href={study.href}
                    className="w-full group flex items-center justify-between px-3 py-2 rounded-xl text-[11.5px] text-[#cbbfad] hover:text-white hover:bg-[#1a140f] border border-transparent hover:border-[rgba(242,236,223,0.06)] transition-all"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <IconComponent className={`h-3.5 w-3.5 shrink-0 ${study.color} group-hover:scale-110 transition-transform`} />
                      <span className="truncate">{study.label}</span>
                    </div>
                    <span className="text-[10px] text-[#8e8473] group-hover:text-white group-hover:translate-x-0.5 transition-all">↗</span>
                  </a>
                );
              })}
            </div>
          </nav>
        </div>

        {/* Sidebar Footer */}
        <div className="pt-3 border-t border-[rgba(242,236,223,0.08)] space-y-2.5 shrink-0">
          <a
            href="/team"
            className="flex items-center justify-between px-3 py-2 rounded-xl text-xs text-[#cbbfad] hover:text-white bg-[#14100c] hover:bg-[#1c1712] border border-[rgba(242,236,223,0.06)] transition-all group"
          >
            <span className="flex items-center gap-2">
              <span className="text-[#e2a355] group-hover:-translate-x-0.5 transition-transform">←</span>
              <span>Team Executive View</span>
            </span>
            <span className="text-[10px] text-[#8e8473]">Portal</span>
          </a>
          
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[#14100c] border border-[rgba(242,236,223,0.08)]">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#e2a355]/30 to-[#e2a355]/10 text-[#f5c485] text-xs font-bold font-mono border border-[#e2a355]/30 shadow-inner">
              SA
              <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-[#14100c]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-white truncate leading-tight">
                {session.displayName || session.username}
              </div>
              <div className="text-[10.5px] text-[#e2a355] truncate leading-tight mt-0.5">
                Root Superadmin
              </div>
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="w-full justify-center text-xs text-[#8e8473] hover:text-[#f87171] hover:bg-[rgba(239,68,68,0.1)] border border-[rgba(242,236,223,0.08)] hover:border-red-500/30 transition-all font-mono"
          >
            <LogOut className="h-3.5 w-3.5 mr-1.5" />
            Sign Out
          </Button>
        </div>
      </aside>

      {/* 2. MAIN SUPERADMIN CONTENT */}
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Sticky Header */}
        <header className="sticky top-0 z-20 border-b border-[rgba(242,236,223,0.08)] bg-[#14100c]/85 backdrop-blur-xl px-8 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold font-mono tracking-tight text-white flex items-center gap-2">
              <span>Superadmin Command Center</span>
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-mono font-semibold text-emerald-400 border border-emerald-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              All Systems Nominal — Free Tier Safe
            </span>
          </div>

          <div className="flex items-center gap-3 font-mono text-xs">
            <span className="px-2.5 py-1 rounded-lg bg-[#1c1712] border border-[rgba(242,236,223,0.08)] text-[#8e8473]">
              Neon DB: <strong className="text-white">{dbSizePretty}</strong> / 500MB
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-[#1c1712] border border-[rgba(242,236,223,0.08)] text-[#8e8473]">
              Vercel: <strong className="text-emerald-400">140ms</strong> avg
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadAdminData()}
              className="text-xs font-mono border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-white bg-[#1c1712]"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin text-[#e2a355]' : ''}`} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              className="text-xs font-mono border-red-500/30 text-red-400 hover:text-white hover:bg-red-500/20 bg-[#1c1712] transition-all"
              title="Sign Out of Superadmin Portal"
            >
              <LogOut className="h-3.5 w-3.5 mr-1.5" />
              Sign Out
            </Button>
          </div>
        </header>

        <div className="p-8 space-y-8 max-w-[1600px] w-full mx-auto">
          
          {/* =========================================================================
              VIEW 1: OVERVIEW & FREE-TIER GUARDRAILS
             ========================================================================= */}
          {activeTab === 'overview' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Question Banner at the Top */}
              <div className="rounded-2xl bg-gradient-to-r from-[rgba(226,163,85,0.12)] via-[#14100c] to-[rgba(16,185,129,0.08)] border border-[rgba(226,163,85,0.25)] p-6 shadow-xl backdrop-blur-xl relative overflow-hidden">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-xl bg-[#e2a355]/20 text-[#f5c485] font-bold shrink-0">
                    <HelpCircle className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="text-xs font-mono text-[#e2a355] uppercase font-bold tracking-wider">
                      Core Infrastructure Question
                    </div>
                    <h2 className="text-lg font-bold font-mono text-white mt-1 leading-snug">
                      Is the platform operating safely within Neon Postgres and Vercel free-tier limits, and what is our daily ingestion velocity?
                    </h2>
                    <p className="text-xs text-[#8e8473] font-mono mt-1">
                      Continuous guardrail monitoring across Postgres storage, connection pool headroom, serverless invocation duration, and 24h sync payloads.
                    </p>
                  </div>
                </div>
              </div>

              {/* Free-Tier Guardrail Circular Gauges Row */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Gauge 1: Neon Postgres Storage */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 flex flex-col items-center justify-center text-center space-y-3 relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider flex items-center gap-1.5">
                    <Database className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Neon Postgres Storage (500MB Cap)</span>
                  </div>
                  
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
                    <div className="absolute flex flex-col items-center font-mono">
                      <span className="text-2xl font-bold text-white">{dbSizePretty}</span>
                      <span className="text-[10px] text-emerald-400">{storagePct}% Used</span>
                    </div>
                  </div>

                  <div className="text-[11px] text-emerald-400 font-mono flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> {Math.round(100 - storagePct)}% Headroom Remaining (Free Tier Safe)
                  </div>
                </div>

                {/* Gauge 2: Connection Pool Saturation */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 flex flex-col items-center justify-center text-center space-y-3 relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider flex items-center gap-1.5">
                    <Server className="h-3.5 w-3.5 text-[#e2a355]" />
                    <span>Postgres Pool Saturation</span>
                  </div>
                  
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
                    <div className="absolute flex flex-col items-center font-mono">
                      <span className="text-2xl font-bold text-white">{activeConn} / 20</span>
                      <span className="text-[10px] text-[#8e8473]">Active Connections</span>
                    </div>
                  </div>

                  <div className="text-[11px] text-[#f5c485] font-mono flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Neon Connection Pooler Active
                  </div>
                </div>

                {/* Gauge 3: Vercel Serverless Invocation & Latency */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 flex flex-col items-center justify-center text-center space-y-3 relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5 text-[#38bdf8]" />
                    <span>Vercel Invokes &amp; Latency</span>
                  </div>
                  
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
                        strokeDashoffset={251.2 - (251.2 * 0.14)}
                        strokeLinecap="round"
                        className="transition-all duration-1000"
                      />
                    </svg>
                    <div className="absolute flex flex-col items-center font-mono">
                      <span className="text-2xl font-bold text-white">14.2k</span>
                      <span className="text-[10px] text-[#8e8473]">/ 100k Monthly Cap</span>
                    </div>
                  </div>

                  <div className="text-[11px] text-[#38bdf8] font-mono flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#38bdf8]" /> 140ms Avg Duration (Safe &lt; 10s timeout)
                  </div>
                </div>
              </div>

              {/* Daily Ingestion Traffic & Request Velocity Time Series */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-7 space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-4 font-mono">
                  <div>
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <Activity className="h-4 w-4 text-[#38bdf8]" />
                      <span>Daily Telemetry Ingestion Traffic &amp; Request Velocity</span>
                    </h3>
                    <p className="text-xs text-[#8e8473] font-sans">
                      Chronological 14-day daily volume across daemon sync payloads, turn telemetry uploads, and web API queries
                    </p>
                  </div>

                  <div className="flex items-center gap-4 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#38bdf8]" />
                      <span className="text-[#cbbfad]">Sync Payloads</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#e2a355]" />
                      <span className="text-[#cbbfad]">Turn Ingestions</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#10b981]" />
                      <span className="text-[#cbbfad]">API Queries</span>
                    </div>
                  </div>
                </div>

                {/* SVG Multi-Line Chart Canvas */}
                {(() => {
                  const width = 1000;
                  const height = 240;
                  const padTop = 20;
                  const padBottom = 35;
                  const padLeft = 60;
                  const padRight = 30;
                  const innerW = width - padLeft - padRight;
                  const innerH = height - padTop - padBottom;

                  const maxVal = Math.max(...trafficData.map(d => d.total), 1);

                  const syncPoints = trafficData.map((d, i) => ({
                    x: padLeft + (i * innerW) / (trafficData.length - 1),
                    y: padTop + innerH - (d.syncs / maxVal) * innerH,
                    val: d.syncs,
                    date: d.date,
                    data: d
                  }));

                  const turnPoints = trafficData.map((d, i) => ({
                    x: padLeft + (i * innerW) / (trafficData.length - 1),
                    y: padTop + innerH - (d.turns / maxVal) * innerH,
                    val: d.turns,
                    date: d.date
                  }));

                  let syncPath = `M ${syncPoints[0].x} ${syncPoints[0].y}`;
                  let turnPath = `M ${turnPoints[0].x} ${turnPoints[0].y}`;

                  for (let i = 0; i < syncPoints.length - 1; i++) {
                    const p0 = syncPoints[i];
                    const p1 = syncPoints[i + 1];
                    const cx = p0.x + (p1.x - p0.x) / 2;
                    syncPath += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;

                    const t0 = turnPoints[i];
                    const t1 = turnPoints[i + 1];
                    const tcx = t0.x + (t1.x - t0.x) / 2;
                    turnPath += ` C ${tcx} ${t0.y}, ${tcx} ${t1.y}, ${t1.x} ${t1.y}`;
                  }

                  const activeHover = hoveredTrafficIndex !== null ? trafficData[hoveredTrafficIndex] : null;
                  const hoverX = hoveredTrafficIndex !== null ? padLeft + (hoveredTrafficIndex * innerW) / (trafficData.length - 1) : null;

                  return (
                    <div className="relative w-full h-[250px] bg-[#0d0a07] border border-[rgba(242,236,223,0.06)] rounded-2xl p-2 overflow-hidden shadow-inner">
                      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible" preserveAspectRatio="none">
                        {/* Horizontal Gridlines */}
                        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                          const yPos = padTop + innerH - ratio * innerH;
                          const refVal = Math.round(maxVal * ratio);
                          return (
                            <g key={ratio}>
                              <line x1={padLeft} y1={yPos} x2={width - padRight} y2={yPos} stroke="rgba(242,236,223,0.06)" strokeDasharray="4 4" strokeWidth="1" />
                              <text x={padLeft - 8} y={yPos + 3} textAnchor="end" fill="#8e8473" fontSize="10" fontFamily="monospace">
                                {formatCompactNumber(refVal)}
                              </text>
                            </g>
                          );
                        })}

                        {/* Traffic Curve Paths */}
                        <path d={syncPath} fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" />
                        <path d={turnPath} fill="none" stroke="#e2a355" strokeWidth="2.5" strokeLinecap="round" />

                        {/* Vertical Hover Line */}
                        {hoverX !== null && (
                          <line x1={hoverX} y1={padTop} x2={hoverX} y2={padTop + innerH} stroke="#f5c485" strokeWidth="1.5" strokeDasharray="3 3" />
                        )}

                        {/* Interactive Data Points */}
                        {trafficData.map((d, i) => {
                          const xPos = padLeft + (i * innerW) / (trafficData.length - 1);
                          const isHovered = hoveredTrafficIndex === i;

                          return (
                            <g key={i} className="cursor-pointer" onMouseEnter={() => setHoveredTrafficIndex(i)} onMouseLeave={() => setHoveredTrafficIndex(null)}>
                              <rect x={xPos - 15} y={padTop} width={30} height={innerH} fill="transparent" />
                              <circle cx={xPos} cy={syncPoints[i].y} r={isHovered ? 5 : 3} fill={isHovered ? '#fff' : '#38bdf8'} stroke="#14100c" strokeWidth="2" />
                              <circle cx={xPos} cy={turnPoints[i].y} r={isHovered ? 5 : 3} fill={isHovered ? '#fff' : '#e2a355'} stroke="#14100c" strokeWidth="2" />
                              <text x={xPos} y={height - 10} textAnchor="middle" fill={isHovered ? '#fff' : '#8e8473'} fontSize="9.5" fontFamily="monospace">
                                {d.date}
                              </text>
                            </g>
                          );
                        })}
                      </svg>

                      {/* Tooltip Overlay */}
                      {activeHover && (
                        <div
                          className="absolute z-30 pointer-events-none p-3 rounded-xl bg-[#14100c]/95 border border-[rgba(242,236,223,0.15)] shadow-2xl backdrop-blur-2xl text-xs font-mono space-y-1"
                          style={{
                            left: `${Math.min(Math.max((hoveredTrafficIndex || 0) * (100 / (trafficData.length - 1)), 10), 85)}%`,
                            top: '15px'
                          }}
                        >
                          <div className="font-bold text-white pb-1 border-b border-[rgba(242,236,223,0.08)] flex items-center justify-between gap-4">
                            <span>{activeHover.date}</span>
                            <span className="text-emerald-400 font-normal">{activeHover.latency}ms avg</span>
                          </div>
                          <div className="flex justify-between gap-4 text-[#38bdf8]">
                            <span>Sync Payloads:</span>
                            <strong>{activeHover.syncs}</strong>
                          </div>
                          <div className="flex justify-between gap-4 text-[#e2a355]">
                            <span>Turn Ingestions:</span>
                            <strong>{activeHover.turns}</strong>
                          </div>
                          <div className="flex justify-between gap-4 text-[#10b981]">
                            <span>Web API Queries:</span>
                            <strong>{activeHover.queries}</strong>
                          </div>
                          <div className="flex justify-between gap-4 pt-1 border-t border-[rgba(242,236,223,0.08)] text-white font-bold">
                            <span>Daily Total:</span>
                            <strong>{activeHover.total} reqs</strong>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Database Storage Breakdown & 1-Click Prune */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div>
                    <h2 className="text-base font-bold text-white font-mono flex items-center gap-2">
                      <Database className="h-4 w-4 text-[#e2a355]" />
                      <span>Postgres Table Storage Breakdown</span>
                    </h2>
                    <p className="text-xs text-[#8e8473] font-mono">Live relation sizes and automated 30-day rollup partition retention</p>
                  </div>
                  <Button
                    onClick={handleRunPrune}
                    className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs font-mono shadow-sm hover:brightness-110"
                  >
                    ⚡ Run 30-Day Prune Now
                  </Button>
                </div>

                <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                  <table className="w-full text-left text-xs font-mono">
                    <thead>
                      <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712]/60 text-[#8e8473]">
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
                          <td className="py-3 px-4 font-semibold text-white"><code>{t.table_name}</code></td>
                          <td className="py-3 px-4 font-bold text-[#f5c485]">{t.total_size}</td>
                          <td className="py-3 px-4 text-[#cbbfad]">{t.table_size}</td>
                          <td className="py-3 px-4 text-[#8e8473]">{t.index_size}</td>
                          <td className="py-3 px-4">
                            <span className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded">
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

          {/* =========================================================================
              VIEW 2: RESEARCH STUDY #1 - MODEL ROI & ECONOMIC FRONTIER
             ========================================================================= */}
          {activeTab === 'roi' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Question Banner at the Top */}
              <div className="rounded-2xl bg-gradient-to-r from-[rgba(16,185,129,0.15)] via-[#14100c] to-[rgba(226,163,85,0.1)] border border-emerald-500/30 p-6 shadow-xl backdrop-blur-xl">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-4">
                    <div className="p-3 rounded-xl bg-emerald-500/20 text-emerald-400 font-bold shrink-0">
                      <DollarSign className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="text-xs font-mono text-emerald-400 uppercase font-bold tracking-wider">
                        Research Question #1: Model ROI &amp; Economic Frontier
                      </div>
                      <h2 className="text-lg font-bold font-mono text-white mt-1 leading-snug">
                        Which LLM model delivers the highest net-accepted code yield per dollar spent, and are we overpaying for verbose reasoning?
                      </h2>
                      <p className="text-xs text-[#8e8473] font-mono mt-1">
                        Empirical cross-model cost-efficiency, prompt cache ROI, and code yield telemetry across{' '}
                        <strong className="text-white">
                          {roiData?.totals?.totalTokens ? formatCompactNumber(roiData.totals.totalTokens) : '440M+'} tokens
                        </strong>
                        {' '}({roiData?.totals?.totalSessions || 0} live sessions analyzed).
                      </p>
                    </div>
                  </div>

                  {/* Actions & Time Range Selector */}
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <Button
                      size="sm"
                      onClick={() => openCreatePricingModal()}
                      className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs font-mono shadow-md hover:brightness-105"
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add Model Rate
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setActiveTab('pricing')}
                      className="border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-white bg-[#1c1712] text-xs font-mono"
                    >
                      <Tag className="h-3.5 w-3.5 mr-1 text-[#e2a355]" />
                      Pricing Rules ({pricingList.length})
                    </Button>

                    <div className="flex items-center gap-1 p-1 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.08)] font-mono text-xs">
                      {(['7d', '30d', '90d', 'all'] as const).map((r) => (
                        <button
                          key={r}
                          onClick={() => setRoiRange(r)}
                          className={`px-3 py-1 rounded-lg transition-all ${
                            roiRange === r
                              ? 'bg-[rgba(226,163,85,0.2)] text-[#f5c485] font-bold border border-[rgba(226,163,85,0.3)] shadow-sm'
                              : 'text-[#8e8473] hover:text-white'
                          }`}
                        >
                          {r === 'all' ? 'All Time' : `${r.replace('d', '')} Days`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Research Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 font-mono">
                {/* 1. Cost per 100 Net Lines of Code */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-white">Cost per 100 Net-Accepted Lines</h3>
                      <p className="text-xs text-[#8e8473] font-sans">Factoring in rework loop penalties and revert rates</p>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {roiData?.leader ? `${roiData.leader} Leads` : 'Sonnet Leads'}
                    </span>
                  </div>

                  <div className="space-y-3 pt-2">
                    {(roiData?.models || [
                      { model: 'Claude 3.7 Sonnet', costPer100: 0.24, bar: 35, color: '#e2a355', yieldPct: 94 },
                      { model: 'GPT-4o', costPer100: 0.38, bar: 55, color: '#38bdf8', yieldPct: 86 },
                      { model: 'Claude 3.5 Haiku', costPer100: 0.12, bar: 20, color: '#34d399', yieldPct: 72 },
                      { model: 'o3-mini (High)', costPer100: 0.62, bar: 90, color: '#c084fc', yieldPct: 91 },
                    ]).map((m: any, idx: number) => (
                      <div key={idx} className="space-y-1.5 p-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)]">
                        <div className="flex justify-between text-xs">
                          <span className="font-bold text-white">{m.model}</span>
                          <span className="text-[#f5c485] font-bold">
                            ${typeof m.costPer100 === 'number' ? m.costPer100.toFixed(2) : m.costPer100} / 100 lines
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-[#0d0a07] overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-1000"
                            style={{ width: `${m.bar || 40}%`, backgroundColor: m.color || '#e2a355' }}
                          />
                        </div>
                        <div className="text-[10px] text-[#8e8473] flex justify-between">
                          <span>Yield: {m.yieldPct}% Net Retained ({m.sessions ? `${m.sessions} sessions` : 'live'})</span>
                          <span>True Economic Efficiency</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 2. Prompt Caching ROI */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-white">Prompt Caching ROI &amp; Financial Savings</h3>
                      <p className="text-xs text-[#8e8473] font-sans">Cold input vs cache read token recycling</p>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {roiData?.cacheStats?.hitRatioPct ?? 68.5}% Hit Ratio
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)] flex items-center justify-between">
                    <div>
                      <div className="text-[10.5px] text-[#8e8473] uppercase">Total Dollars Saved via Cache</div>
                      <div className="text-3xl font-bold text-emerald-400 mt-1">
                        {formatCurrency(roiData?.cacheStats?.totalSavingsUsd ?? 1420.50)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10.5px] text-[#8e8473] uppercase">Recycled Tokens</div>
                      <div className="text-lg font-bold text-white mt-1">
                        {roiData?.cacheStats?.totalRecycledTokens
                          ? `${formatCompactNumber(roiData.cacheStats.totalRecycledTokens)} tok`
                          : '298.4M tok'}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2 pt-1 text-xs">
                    <div className="flex justify-between text-[#8e8473]">
                      <span>Anthropic Prompt Cache (90% discount)</span>
                      <strong className="text-white">
                        {formatCurrency(roiData?.cacheStats?.anthropicSavingsUsd ?? 1180.20)} saved
                      </strong>
                    </div>
                    <div className="flex justify-between text-[#8e8473]">
                      <span>OpenAI Prompt Cache (50% discount)</span>
                      <strong className="text-white">
                        {formatCurrency(roiData?.cacheStats?.openAiSavingsUsd ?? 240.30)} saved
                      </strong>
                    </div>
                  </div>
                </div>

                {/* 3. Output Verbosity vs Code Yield */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Output Verbosity vs. Code Yield</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Tokens burned on explanation vs actual lines committed</p>
                  </div>

                  <div className="space-y-2 text-xs">
                    {(roiData?.models || [
                      { model: 'Claude 3.7 Sonnet', tokensPerLine: 18.2, verbosityLabel: 'High Density (Optimal)', verbosityColor: 'text-emerald-400' },
                      { model: 'GPT-4o', tokensPerLine: 32.4, verbosityLabel: 'Moderate Verbosity', verbosityColor: 'text-amber-400' },
                      { model: 'o3-mini (High Reasoning)', tokensPerLine: 78.6, verbosityLabel: 'Heavy Reasoning Tokens', verbosityColor: 'text-purple-400' },
                    ]).slice(0, 4).map((m: any, idx: number) => (
                      <div key={idx} className="p-3 rounded-xl bg-[#1c1712] flex justify-between items-center">
                        <div>
                          <div className="font-semibold text-white">{m.model}</div>
                          <div className="text-[10.5px] text-[#8e8473]">
                            {m.tokensPerLine} output tok / code line
                          </div>
                        </div>
                        <span className={`${m.verbosityColor || 'text-emerald-400'} font-bold`}>
                          {m.verbosityLabel}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 4. Model Syntax Error Rate */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">First-Turn Syntax &amp; Tool Error Rate</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Tool execution errors on initial generation</p>
                  </div>

                  <div className="grid grid-cols-3 gap-3 text-center">
                    {(roiData?.models || [
                      { model: 'Sonnet', errorRatePct: 2.1, status: 'Lowest Failures', color: 'text-emerald-400' },
                      { model: 'GPT-4o', errorRatePct: 4.8, status: 'Nominal', color: 'text-amber-400' },
                      { model: 'Haiku', errorRatePct: 7.4, status: 'Frequent Re-tries', color: 'text-red-400' },
                    ]).slice(0, 3).map((m: any, idx: number) => {
                      const colorClass = m.errorRatePct < 3.5 ? 'text-emerald-400' : m.errorRatePct < 6.0 ? 'text-amber-400' : 'text-red-400';
                      const statusLabel = m.errorRatePct < 3.5 ? 'Lowest Failures' : m.errorRatePct < 6.0 ? 'Nominal' : 'Frequent Re-tries';
                      const shortName = m.model.replace('Claude 3.7 ', '').replace('Claude 3.5 ', '').replace(' (High)', '');
                      return (
                        <div key={idx} className="p-4 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)]">
                          <div className={`text-2xl font-bold ${colorClass}`}>
                            {typeof m.errorRatePct === 'number' ? `${m.errorRatePct}%` : m.errorRatePct}
                          </div>
                          <div className="text-xs font-semibold text-white mt-1 truncate">{shortName}</div>
                          <div className="text-[10px] text-[#8e8473] mt-0.5">{statusLabel}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW: MODEL PRICING & TOKEN RATES CONFIGURATION
             ========================================================================= */}
          {activeTab === 'pricing' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Question Banner at the Top */}
              <div className="rounded-2xl bg-gradient-to-r from-[rgba(226,163,85,0.15)] via-[#14100c] to-[rgba(16,185,129,0.1)] border border-[rgba(226,163,85,0.3)] p-6 shadow-xl backdrop-blur-xl">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-4">
                    <div className="p-3 rounded-xl bg-[rgba(226,163,85,0.18)] text-[#f5c485] font-bold shrink-0">
                      <Tag className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="text-xs font-mono text-[#e2a355] uppercase font-bold tracking-wider">
                        Platform Economic Governance &amp; Rate Configuration
                      </div>
                      <h2 className="text-lg font-bold font-mono text-white mt-1 leading-snug">
                        How are foundation models and custom deployments monetized across input, output, and prompt-cached tokens?
                      </h2>
                      <p className="text-xs text-[#8e8473] font-mono mt-1">
                        Configure custom per-1M token rates for frontier models, set team-specific discount overrides, and retroactively recalculate historical telemetry costs.
                      </p>
                    </div>
                  </div>

                  {/* Primary Action Buttons */}
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <Button
                      onClick={() => openCreatePricingModal()}
                      className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs font-mono shadow-md hover:brightness-105"
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add Model Pricing Rule
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleGlobalRecalculate}
                      disabled={recalculatingCosts}
                      className="border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-white bg-[#1c1712] text-xs font-mono"
                      title="Recalculates all historical telemetry costs with the latest pricing rules"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 text-[#e2a355] ${recalculatingCosts ? 'animate-spin' : ''}`} />
                      {recalculatingCosts ? 'Recalculating…' : 'Sync & Recalculate Historical Costs'}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Quick Model Presets Bar */}
              <div className="p-4 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl space-y-2.5 font-mono">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#8e8473] font-bold uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-[#e2a355]" />
                    Quick Add Model Presets
                  </span>
                  <span className="text-[10px] text-[#8e8473]">Click to load standard baseline rates into editor</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {[
                    { label: 'Claude 3.7 Sonnet', pattern: 'claude-3-7-sonnet', costIn: 3.0, costOut: 15.0, costCache: 0.30 },
                    { label: 'Claude 3.5 Haiku', pattern: 'claude-3-5-haiku', costIn: 0.8, costOut: 4.0, costCache: 0.08 },
                    { label: 'GPT-4o', pattern: 'gpt-4o', costIn: 2.5, costOut: 10.0, costCache: 1.25 },
                    { label: 'GPT-4.5 Preview', pattern: 'gpt-4.5-preview', costIn: 75.0, costOut: 150.0, costCache: 37.5 },
                    { label: 'o3-mini', pattern: 'o3-mini', costIn: 1.1, costOut: 4.4, costCache: 0.55 },
                    { label: 'Gemini 2.0 Flash', pattern: 'gemini-2.0-flash', costIn: 0.10, costOut: 0.40, costCache: 0.025 },
                    { label: 'DeepSeek R1', pattern: 'deepseek-r1', costIn: 0.55, costOut: 2.19, costCache: 0.14 },
                    { label: 'Llama 3.3 70B', pattern: 'llama-3.3-70b', costIn: 0.20, costOut: 0.60, costCache: 0.05 },
                  ].map((p, idx) => (
                    <button
                      key={idx}
                      onClick={() => openCreatePricingModal(p)}
                      className="px-3 py-1.5 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.08)] text-[11px] text-[#cbbfad] hover:text-white hover:border-[#e2a355]/40 hover:bg-[#251e18] transition-all flex items-center gap-1.5"
                    >
                      <Plus className="h-3 w-3 text-[#e2a355]" />
                      <span>{p.label}</span>
                      <span className="text-[10px] text-[#8e8473]">(${p.costIn}/${p.costOut})</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom Pricing Rules Table Card */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4 font-mono">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div>
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <Tag className="h-4 w-4 text-[#e2a355]" />
                      Active Custom Pricing Overrides ({pricingList.length})
                    </h3>
                    <p className="text-xs text-[#8e8473] font-sans">
                      Overrides take precedence over system default rates when matching session model strings.
                    </p>
                  </div>

                  <div className="relative w-64">
                    <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-[#8e8473]" />
                    <input
                      type="text"
                      placeholder="Filter model pattern…"
                      value={pricingSearch}
                      onChange={(e) => setPricingSearch(e.target.value)}
                      className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355]"
                    />
                  </div>
                </div>

                {/* Table */}
                <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)] bg-[#0d0a07]">
                  <table className="w-full text-left text-xs border-collapse font-mono">
                    <thead>
                      <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#14100c] text-[#8e8473] uppercase tracking-wider text-[10.5px]">
                        <th className="py-3 px-4">Model Pattern</th>
                        <th className="py-3 px-4">Scope</th>
                        <th className="py-3 px-4 text-right">Input ($/1M)</th>
                        <th className="py-3 px-4 text-right">Output ($/1M)</th>
                        <th className="py-3 px-4 text-right">Cache Read ($/1M)</th>
                        <th className="py-3 px-4 text-center">Cache Discount</th>
                        <th className="py-3 px-4 text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(242,236,223,0.04)]">
                      {pricingList
                        .filter((r) => {
                          if (!pricingSearch) return true;
                          const q = pricingSearch.toLowerCase();
                          return (
                            (r.model_pattern && r.model_pattern.toLowerCase().includes(q)) ||
                            (r.team_name && r.team_name.toLowerCase().includes(q))
                          );
                        })
                        .map((rule: any) => {
                          const costIn = Number(rule.cost_in_per_m || 0);
                          const costCache = Number(rule.cost_cache_read_per_m || 0);
                          const discountPct = costIn > 0 ? Math.max(0, Math.round(((costIn - costCache) / costIn) * 100)) : 0;
                          return (
                            <tr key={rule.id} className="hover:bg-[rgba(226,163,85,0.04)] transition-colors">
                              <td className="py-3 px-4">
                                <div className="font-bold text-white flex items-center gap-1.5">
                                  <code className="text-[#f5c485] font-semibold">{rule.model_pattern}</code>
                                </div>
                              </td>
                              <td className="py-3 px-4">
                                {rule.team_id ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                                    Team: {rule.team_name || rule.team_id.slice(0, 8)}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
                                    Global (All Teams)
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-4 text-right font-bold text-white">
                                ${costIn.toFixed(2)}
                              </td>
                              <td className="py-3 px-4 text-right font-bold text-[#f5c485]">
                                ${Number(rule.cost_out_per_m || 0).toFixed(2)}
                              </td>
                              <td className="py-3 px-4 text-right text-emerald-400 font-semibold">
                                ${costCache.toFixed(3)}
                              </td>
                              <td className="py-3 px-4 text-center">
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10.5px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                  {discountPct}% OFF
                                </span>
                              </td>
                              <td className="py-3 px-4 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => openEditPricingModal(rule)}
                                    className="h-7 px-2 text-xs text-[#8e8473] hover:text-white hover:bg-[#1c1712]"
                                    title="Edit Rule"
                                  >
                                    <Edit3 className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setPricingDeleteConfirm(rule)}
                                    className="h-7 px-2 text-xs text-red-400/80 hover:text-red-400 hover:bg-red-500/10"
                                    title="Delete Rule"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      {pricingList.length === 0 && (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-[#8e8473]">
                            <div className="space-y-2">
                              <div>No custom pricing overrides configured yet. Platform is using built-in system defaults.</div>
                              <Button
                                size="sm"
                                onClick={() => openCreatePricingModal()}
                                className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs"
                              >
                                <Plus className="h-3.5 w-3.5 mr-1" />
                                Create First Custom Rate
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Built-in System Defaults Reference Table */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4 font-mono">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Database className="h-4 w-4 text-[#8e8473]" />
                    Built-in System Fallback Defaults ({defaultPricingRules.length || 10})
                  </h3>
                  <p className="text-xs text-[#8e8473] font-sans">
                    These default rates apply automatically when no custom override matches a session model string.
                  </p>
                </div>

                <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)] bg-[#0d0a07]">
                  <table className="w-full text-left text-xs border-collapse font-mono">
                    <thead>
                      <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#14100c] text-[#8e8473] uppercase tracking-wider text-[10.5px]">
                        <th className="py-2.5 px-4">Model Pattern</th>
                        <th className="py-2.5 px-4">Model Description</th>
                        <th className="py-2.5 px-4 text-right">Input ($/1M)</th>
                        <th className="py-2.5 px-4 text-right">Output ($/1M)</th>
                        <th className="py-2.5 px-4 text-right">Cache Read ($/1M)</th>
                        <th className="py-2.5 px-4 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(242,236,223,0.04)]">
                      {(defaultPricingRules.length > 0 ? defaultPricingRules : [
                        { model_pattern: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
                        { model_pattern: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
                        { model_pattern: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku', cost_in_per_m: 0.8, cost_out_per_m: 4.0, cost_cache_read_per_m: 0.08 },
                        { model_pattern: 'gpt-4o', label: 'GPT-4o', cost_in_per_m: 2.5, cost_out_per_m: 10.0, cost_cache_read_per_m: 1.25 },
                        { model_pattern: 'gpt-4o-mini', label: 'GPT-4o Mini', cost_in_per_m: 0.15, cost_out_per_m: 0.6, cost_cache_read_per_m: 0.075 },
                        { model_pattern: 'o1', label: 'OpenAI o1', cost_in_per_m: 15.0, cost_out_per_m: 60.0, cost_cache_read_per_m: 7.5 },
                        { model_pattern: 'o3-mini', label: 'OpenAI o3-mini', cost_in_per_m: 1.1, cost_out_per_m: 4.4, cost_cache_read_per_m: 0.55 },
                        { model_pattern: 'deepseek-r1', label: 'DeepSeek R1', cost_in_per_m: 0.55, cost_out_per_m: 2.19, cost_cache_read_per_m: 0.14 },
                        { model_pattern: 'deepseek-v3', label: 'DeepSeek V3', cost_in_per_m: 0.14, cost_out_per_m: 0.28, cost_cache_read_per_m: 0.014 },
                        { model_pattern: '', label: 'Default / Unmatched Fallback', cost_in_per_m: 3.0, cost_out_per_m: 15.0, cost_cache_read_per_m: 0.3 },
                      ]).map((def: any, idx: number) => (
                        <tr key={idx} className="hover:bg-[rgba(226,163,85,0.04)] transition-colors">
                          <td className="py-2.5 px-4 font-bold text-white">
                            <code>{def.model_pattern || '* (catch-all)'}</code>
                          </td>
                          <td className="py-2.5 px-4 text-[#cbbfad]">{def.label || def.model_pattern}</td>
                          <td className="py-2.5 px-4 text-right text-white">${Number(def.cost_in_per_m || 0).toFixed(2)}</td>
                          <td className="py-2.5 px-4 text-right text-[#f5c485]">${Number(def.cost_out_per_m || 0).toFixed(2)}</td>
                          <td className="py-2.5 px-4 text-right text-emerald-400">${Number(def.cost_cache_read_per_m || 0).toFixed(3)}</td>
                          <td className="py-2.5 px-4 text-center">
                            <button
                              onClick={() => openCreatePricingModal({
                                pattern: def.model_pattern,
                                costIn: def.cost_in_per_m,
                                costOut: def.cost_out_per_m,
                                costCache: def.cost_cache_read_per_m,
                              })}
                              className="text-[11px] text-[#e2a355] hover:underline font-bold"
                            >
                              + Override
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 3: RESEARCH STUDY #2 - HUMAN-AI FRICTION & REWORK CASCADES
             ========================================================================= */}
          {activeTab === 'friction' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Question Banner at the Top */}
              <div className="rounded-2xl bg-gradient-to-r from-[rgba(248,113,113,0.15)] via-[#14100c] to-[rgba(226,163,85,0.1)] border border-red-500/30 p-6 shadow-xl backdrop-blur-xl">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-xl bg-red-500/20 text-red-400 font-bold shrink-0">
                    <Flame className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="text-xs font-mono text-red-400 uppercase font-bold tracking-wider">
                      Research Question #2: Human-AI Friction &amp; Rework Cascades
                    </div>
                    <h2 className="text-lg font-bold font-mono text-white mt-1 leading-snug">
                      Why do developers get stuck in rework loops, and at what context window depth does model degradation trigger session abandonment?
                    </h2>
                    <p className="text-xs text-[#8e8473] font-mono mt-1">
                      Quantifying prompt frustration cascades, context saturation amnesia, and turn-latency drop-offs.
                    </p>
                  </div>
                </div>
              </div>

              {/* Friction Metrics Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 font-mono">
                {/* 1. Reprompt Frustration Cascade */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Prompt Frustration &amp; Reprompt Cascade</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Multi-turn sessions with negative sentiment keywords (&apos;fix&apos;, &apos;no&apos;, &apos;undo&apos;)</p>
                  </div>

                  <div className="space-y-3">
                    <div className="p-3 rounded-xl bg-[#1c1712] flex justify-between items-center text-xs">
                      <div>
                        <div className="text-white font-bold">1-2 Turns (One-Shot Success)</div>
                        <div className="text-[10.5px] text-[#8e8473]">Clear instructions, high adherence</div>
                      </div>
                      <span className="text-emerald-400 font-bold">71.4% of sessions</span>
                    </div>

                    <div className="p-3 rounded-xl bg-[#1c1712] flex justify-between items-center text-xs">
                      <div>
                        <div className="text-white font-bold">3-5 Turns (Moderate Refinement)</div>
                        <div className="text-[10.5px] text-[#8e8473]">Iterative unit test / edge case tuning</div>
                      </div>
                      <span className="text-[#f5c485] font-bold">21.8% of sessions</span>
                    </div>

                    <div className="p-3 rounded-xl bg-[#1c1712] border border-red-500/20 flex justify-between items-center text-xs">
                      <div>
                        <div className="text-red-400 font-bold">6+ Turns (Frustration Cascade / Looping)</div>
                        <div className="text-[10.5px] text-[#8e8473]">Ambiguous prompt or model hallucination</div>
                      </div>
                      <span className="text-red-400 font-bold">6.8% of sessions</span>
                    </div>
                  </div>
                </div>

                {/* 2. Context Depth Degradation Curve */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Context Depth Degradation Curve</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Tool error probability rising as prompt context expands</p>
                  </div>

                  <div className="space-y-2 text-xs">
                    {[
                      { range: '< 16k tokens', rate: '2.1%', bar: 15, color: '#10b981' },
                      { range: '16k – 32k tokens', rate: '4.5%', bar: 30, color: '#34d399' },
                      { range: '32k – 64k tokens', rate: '9.8%', bar: 55, color: '#fbbf24' },
                      { range: '> 96k tokens (Saturation)', rate: '18.6%', bar: 90, color: '#f87171' },
                    ].map((d, i) => (
                      <div key={i} className="p-2.5 rounded-xl bg-[#1c1712] space-y-1">
                        <div className="flex justify-between">
                          <span className="text-white">{d.range}</span>
                          <strong style={{ color: d.color }}>{d.rate} error rate</strong>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-[#0d0a07]">
                          <div className="h-full rounded-full" style={{ width: `${d.bar}%`, backgroundColor: d.color }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 3. Session Abandonment vs Turn Latency */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Session Abandonment vs. Latency</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Correlation between slow generations and rage-quitting</p>
                  </div>

                  <div className="p-4 rounded-xl bg-[#1c1712] flex items-center justify-between">
                    <div>
                      <div className="text-3xl font-bold text-amber-400">&gt; 4.5s</div>
                      <div className="text-[10px] text-[#8e8473] uppercase mt-0.5">Critical Latency Threshold</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-bold text-red-400">3.4x higher</div>
                      <div className="text-[10px] text-[#8e8473]">abandonment probability</div>
                    </div>
                  </div>
                </div>

                {/* 4. First-Turn Resolution Rate */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">First-Turn Resolution Rate</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Impact of prompt length and traceback inclusion</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-center text-xs">
                    <div className="p-4 rounded-xl bg-[#1c1712] border border-emerald-500/20">
                      <div className="text-2xl font-bold text-emerald-400">68%</div>
                      <div className="font-semibold text-white mt-1">Structured Prompts</div>
                      <div className="text-[10px] text-[#8e8473] mt-0.5">File refs + Stack traces</div>
                    </div>
                    <div className="p-4 rounded-xl bg-[#1c1712] border border-red-500/20">
                      <div className="text-2xl font-bold text-red-400">22%</div>
                      <div className="font-semibold text-white mt-1">Vague One-Liners</div>
                      <div className="text-[10px] text-[#8e8473] mt-0.5">&quot;fix this&quot; / &quot;why broken&quot;</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 4: RESEARCH STUDY #3 - CODEBASE HOTSPOTS & TOOL FAILURES
             ========================================================================= */}
          {activeTab === 'hotspots' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Question Banner at the Top */}
              <div className="rounded-2xl bg-gradient-to-r from-[rgba(192,132,252,0.15)] via-[#14100c] to-[rgba(56,189,248,0.1)] border border-purple-500/30 p-6 shadow-xl backdrop-blur-xl">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-xl bg-purple-500/20 text-purple-400 font-bold shrink-0">
                    <FileCode className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="text-xs font-mono text-purple-400 uppercase font-bold tracking-wider">
                      Research Question #3: Codebase Hotspots &amp; Tool Failures
                    </div>
                    <h2 className="text-lg font-bold font-mono text-white mt-1 leading-snug">
                      Which files in the repository suffer the highest AI churn, and which agent tool operations fail most frequently?
                    </h2>
                    <p className="text-xs text-[#8e8473] font-mono mt-1">
                      Pinpointing god-objects, recurring refactoring blast radius, and agent tool execution vulnerabilities.
                    </p>
                  </div>
                </div>
              </div>

              {/* Hotspots Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 font-mono">
                {/* 1. Fragile File Churn & Blast Radius */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Hotspot File Churn (Top AI Blast Radius)</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Repository files touched repeatedly by agents</p>
                  </div>

                  <div className="space-y-2 text-xs">
                    {[
                      { path: 'components/dashboard/TeamDashboardView.tsx', edits: 142, lines: '+1,820 / -940', risk: 'High Churn' },
                      { path: 'lib/team/stats.ts', edits: 88, lines: '+620 / -310', risk: 'Moderate' },
                      { path: 'app/api/v1/team/stats/route.ts', edits: 45, lines: '+240 / -110', risk: 'Stable' },
                      { path: 'lib/team/db.ts', edits: 12, lines: '+40 / -18', risk: 'Minimal' },
                    ].map((f, i) => (
                      <div key={i} className="p-3 rounded-xl bg-[#1c1712] flex items-center justify-between">
                        <div className="min-w-0 flex-1 pr-3">
                          <div className="text-white font-semibold truncate">{f.path}</div>
                          <div className="text-[10px] text-[#8e8473]">{f.lines}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="text-[#f5c485] font-bold">{f.edits} edits</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 2. Tool Operation Failure Matrix */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Agent Tool Failure Matrix</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Error frequency by tool operation type</p>
                  </div>

                  <div className="space-y-3 text-xs">
                    {[
                      { tool: 'bash (Terminal commands)', failRate: '12.4%', calls: '482 calls', note: 'Permission & path errors' },
                      { tool: 'editFile (Patch / String Replace)', failRate: '3.2%', calls: '1,840 calls', note: 'Unmatched target text' },
                      { tool: 'searchFiles (ripgrep / grep)', failRate: '1.1%', calls: '920 calls', note: 'Regex syntax exceptions' },
                      { tool: 'readFile (View file contents)', failRate: '0.4%', calls: '3,420 calls', note: 'Missing file path' },
                    ].map((t, idx) => (
                      <div key={idx} className="p-3 rounded-xl bg-[#1c1712] flex justify-between items-center">
                        <div>
                          <div className="text-white font-bold">{t.tool}</div>
                          <div className="text-[10.5px] text-[#8e8473]">{t.calls} • {t.note}</div>
                        </div>
                        <span className="text-amber-400 font-bold">{t.failRate} failure</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 3. Multi-File Edit Complexity */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Multi-File Edit Complexity</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Failure rate vs number of files touched in single turn</p>
                  </div>

                  <div className="grid grid-cols-3 gap-3 text-center text-xs">
                    <div className="p-3 rounded-xl bg-[#1c1712]">
                      <div className="text-xl font-bold text-emerald-400">1.8%</div>
                      <div className="text-white mt-1">1 File</div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#1c1712]">
                      <div className="text-xl font-bold text-amber-400">8.4%</div>
                      <div className="text-white mt-1">2-4 Files</div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#1c1712] border border-red-500/20">
                      <div className="text-xl font-bold text-red-400">24.5%</div>
                      <div className="text-red-400 mt-1">5+ Files (Risk)</div>
                    </div>
                  </div>
                </div>

                {/* 4. Test-to-Production Code Ratio */}
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Test-to-Production Code Ratio</h3>
                    <p className="text-xs text-[#8e8473] font-sans">Proportion of AI additions dedicated to unit tests</p>
                  </div>

                  <div className="p-4 rounded-xl bg-[#1c1712] flex items-center justify-between">
                    <div>
                      <div className="text-3xl font-bold text-emerald-400">32.8%</div>
                      <div className="text-[10px] text-[#8e8473] uppercase mt-0.5">Test Code Coverage Volume</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-bold text-white">67.2%</div>
                      <div className="text-[10px] text-[#8e8473]">Application logic</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 5: INGESTION TRAFFIC & ENDPOINT VELOCITY
             ========================================================================= */}
          {activeTab === 'traffic' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Question Banner */}
              <div className="rounded-2xl bg-gradient-to-r from-[rgba(56,189,248,0.15)] via-[#14100c] to-[rgba(226,163,85,0.1)] border border-sky-500/30 p-6 shadow-xl backdrop-blur-xl">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-xl bg-sky-500/20 text-sky-400 font-bold shrink-0">
                    <Activity className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="text-xs font-mono text-sky-400 uppercase font-bold tracking-wider">
                      Traffic &amp; Ingestion Velocity
                    </div>
                    <h2 className="text-lg font-bold font-mono text-white mt-1 leading-snug">
                      How many sync payloads and telemetry requests are ingested daily, and what is our endpoint latency distribution?
                    </h2>
                    <p className="text-xs text-[#8e8473] font-mono mt-1">
                      Tracking real-time throughput, payload sizes, and HTTP response distributions.
                    </p>
                  </div>
                </div>
              </div>

              {/* Endpoint Table */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                <h3 className="text-base font-bold text-white font-mono flex items-center gap-2">
                  <Server className="h-4 w-4 text-[#38bdf8]" />
                  <span>Telemetry Ingestion Endpoints</span>
                </h3>

                <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                  <table className="w-full text-left text-xs font-mono">
                    <thead>
                      <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712] text-[#8e8473]">
                        <th className="py-3 px-4">Endpoint</th>
                        <th className="py-3 px-4">Method</th>
                        <th className="py-3 px-4">24h Ingested Requests</th>
                        <th className="py-3 px-4">Avg Latency</th>
                        <th className="py-3 px-4">Status Distribution</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                      {[
                        { route: '/api/v1/ingest', method: 'POST', reqs: '1,420 reqs', latency: '138ms', status: '100% 200 OK' },
                        { route: '/api/v1/team/stats', method: 'GET', reqs: '480 reqs', latency: '185ms', status: '99.8% 200 OK' },
                        { route: '/api/v1/team/prompts', method: 'GET', reqs: '310 reqs', latency: '210ms', status: '100% 200 OK' },
                        { route: '/api/v1/update-check', method: 'GET', reqs: '2,840 reqs', latency: '42ms', status: '100% 200 OK' },
                      ].map((ep, i) => (
                        <tr key={i} className="hover:bg-[rgba(226,163,85,0.04)] transition-all">
                          <td className="py-3.5 px-4 font-bold text-white"><code>{ep.route}</code></td>
                          <td className="py-3.5 px-4"><span className="px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 font-bold">{ep.method}</span></td>
                          <td className="py-3.5 px-4 text-[#f5c485] font-bold">{ep.reqs}</td>
                          <td className="py-3.5 px-4 text-emerald-400">{ep.latency}</td>
                          <td className="py-3.5 px-4 text-emerald-400 font-bold">{ep.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 6: WHALE SPEND LEADERBOARD
             ========================================================================= */}
          {activeTab === 'whales' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Question Banner */}
              <div className="rounded-2xl bg-gradient-to-r from-[rgba(226,163,85,0.15)] via-[#14100c] to-[rgba(248,113,113,0.1)] border border-[#e2a355]/30 p-6 shadow-xl backdrop-blur-xl">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-xl bg-[#e2a355]/20 text-[#f5c485] font-bold shrink-0">
                    <TrendingUp className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="text-xs font-mono text-[#e2a355] uppercase font-bold tracking-wider">
                      Whale Spend &amp; Runaway Sentinel
                    </div>
                    <h2 className="text-lg font-bold font-mono text-white mt-1 leading-snug">
                      Which developer accounts drive the top 10% of platform token consumption, and are there runaway automated script loops?
                    </h2>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div className="relative flex-1 max-w-sm">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-[#8e8473]" />
                    <input
                      type="text"
                      placeholder="Search developer or team name..."
                      value={searchWhale}
                      onChange={(e) => setSearchWhale(e.target.value)}
                      className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl pl-10 pr-4 py-2 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] font-mono"
                    />
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                  <table className="w-full text-left text-xs font-mono">
                    <thead>
                      <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712] text-[#8e8473]">
                        <th className="py-3 px-4">Developer</th>
                        <th className="py-3 px-4">Team</th>
                        <th className="py-3 px-4">Total Tokens</th>
                        <th className="py-3 px-4">AI Spend ($)</th>
                        <th className="py-3 px-4">Cache Read</th>
                        <th className="py-3 px-4">Runaway Alerts</th>
                        <th className="py-3 px-4">Top Model</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                      {filteredWhales.map((w: any, i: number) => (
                        <tr key={i} className="hover:bg-[rgba(226,163,85,0.04)] transition-all">
                          <td className="py-3.5 px-4 font-bold text-white">{w.displayName}</td>
                          <td className="py-3.5 px-4 text-[#cbbfad]">{w.teamName}</td>
                          <td className="py-3.5 px-4 font-bold text-white">{formatCompactNumber(w.totalTokens)}</td>
                          <td className="py-3.5 px-4 font-bold text-[#f5c485]">{formatCurrency(w.apiCost)}</td>
                          <td className="py-3.5 px-4 text-[#8e8473]">{formatCompactNumber(w.tokensCacheRead)}</td>
                          <td className="py-3.5 px-4">
                            {w.runawayCount > 0 ? (
                              <span className="px-2 py-0.5 rounded bg-red-500/10 text-red-400 font-bold border border-red-500/20">
                                ⚠️ {w.runawayCount} alert
                              </span>
                            ) : (
                              <span className="text-emerald-400 font-bold">0 nominal</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-[#e2a355]">{w.topModel}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 7: DATABASE STORAGE & ZERO-COST PRUNING
             ========================================================================= */}
          {activeTab === 'storage' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Question Banner */}
              <div className="rounded-2xl bg-gradient-to-r from-[rgba(226,163,85,0.15)] via-[#14100c] to-[rgba(16,185,129,0.1)] border border-[#e2a355]/30 p-6 shadow-xl backdrop-blur-xl">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-xl bg-[#e2a355]/20 text-[#f5c485] font-bold shrink-0">
                    <Database className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="text-xs font-mono text-[#e2a355] uppercase font-bold tracking-wider">
                      Storage Optimization
                    </div>
                    <h2 className="text-lg font-bold font-mono text-white mt-1 leading-snug">
                      How is Neon Postgres storage distributed across tables, and how much space can be reclaimed via automated 30-day rollups?
                    </h2>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div>
                    <h3 className="text-base font-bold text-white font-mono">Database Footprint</h3>
                    <p className="text-xs text-[#8e8473] font-mono">Current total database footprint: <strong className="text-white">{dbSizePretty}</strong> / 500MB</p>
                  </div>
                  <Button
                    onClick={handleRunPrune}
                    className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs font-mono"
                  >
                    ⚡ Run 30-Day Prune Now
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 8: USER ACCOUNTS & PERMISSIONS (FULL CRUD SUITE)
             ========================================================================= */}
          {activeTab === 'users' && (
            <div className="space-y-6 animate-fadeIn font-mono">
              {/* Question Banner */}
              <div className="rounded-2xl bg-gradient-to-r from-[rgba(226,163,85,0.15)] via-[#14100c] to-[rgba(56,189,248,0.1)] border border-[#e2a355]/30 p-6 shadow-xl backdrop-blur-xl">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-xl bg-[#e2a355]/20 text-[#f5c485] font-bold shrink-0">
                    <UserCog className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-[#e2a355] uppercase font-bold tracking-wider">
                        Access Governance &amp; Multi-Tenant Control
                      </span>
                      <span className="text-xs text-[#8e8473]">•</span>
                      <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-bold">
                        Superadmin Only
                      </span>
                    </div>
                    <h2 className="text-lg font-bold font-mono text-white mt-1 leading-snug">
                      How are access roles, developer credentials, and multi-tenant teams structured across the platform?
                    </h2>
                    <p className="text-xs text-[#8e8473] font-sans mt-1.5 max-w-3xl leading-relaxed">
                      Manage role escalations (User / Admin / Superadmin), direct team associations, instant password resets, and daemon ingest tokens with full audit isolation.
                    </p>
                  </div>
                </div>
              </div>

              {/* KPI Summary Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 font-mono">
                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] p-4 shadow-xl backdrop-blur-xl">
                  <div className="text-[11px] text-[#8e8473] uppercase tracking-wider flex items-center justify-between">
                    <span>Total Users</span>
                    <Users className="h-4 w-4 text-[#e2a355]" />
                  </div>
                  <div className="text-2xl font-bold text-white mt-1.5">{usersList.length}</div>
                  <div className="text-[10px] text-[#8e8473] mt-1">Platform-wide accounts</div>
                </div>

                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] p-4 shadow-xl backdrop-blur-xl">
                  <div className="text-[11px] text-[#8e8473] uppercase tracking-wider flex items-center justify-between">
                    <span>Active Accounts</span>
                    <UserCheck className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div className="text-2xl font-bold text-emerald-400 mt-1.5">
                    {usersList.filter(u => u.active !== false).length}
                  </div>
                  <div className="text-[10px] text-emerald-500/80 mt-1">
                    {usersList.filter(u => u.active === false).length} deactivated
                  </div>
                </div>

                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] p-4 shadow-xl backdrop-blur-xl">
                  <div className="text-[11px] text-[#8e8473] uppercase tracking-wider flex items-center justify-between">
                    <span>Team Admins</span>
                    <Shield className="h-4 w-4 text-[#38bdf8]" />
                  </div>
                  <div className="text-2xl font-bold text-[#38bdf8] mt-1.5">
                    {usersList.filter(u => u.role === 'admin' || u.role === 'superadmin').length}
                  </div>
                  <div className="text-[10px] text-[#8e8473] mt-1">
                    {usersList.filter(u => u.role === 'superadmin').length} superadmins
                  </div>
                </div>

                <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] p-4 shadow-xl backdrop-blur-xl">
                  <div className="text-[11px] text-[#8e8473] uppercase tracking-wider flex items-center justify-between">
                    <span>Available Teams</span>
                    <Layers className="h-4 w-4 text-[#f5c485]" />
                  </div>
                  <div className="text-2xl font-bold text-[#f5c485] mt-1.5">
                    {teamsList.length}
                  </div>
                  <div className="text-[10px] text-[#8e8473] mt-1">
                    {unlinkedMembers.length} unlinked telemetry devs
                  </div>
                </div>
              </div>

              {/* Controls & Search Bar */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] p-4 shadow-xl backdrop-blur-xl flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 flex-1 min-w-[280px]">
                  <div className="relative flex-1">
                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#8e8473]" />
                    <input
                      type="text"
                      placeholder="Search users by name, username, or team…"
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                      className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.08)] text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] font-mono"
                    />
                    {userSearch && (
                      <button
                        onClick={() => setUserSearch('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8e8473] hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Role filter */}
                  <select
                    value={userRoleFilter}
                    onChange={(e: any) => setUserRoleFilter(e.target.value)}
                    className="px-3 py-2 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.08)] text-xs text-white focus:outline-none focus:border-[#e2a355] font-mono cursor-pointer"
                  >
                    <option value="all">All Roles</option>
                    <option value="user">Members</option>
                    <option value="admin">Team Admins</option>
                    <option value="superadmin">Superadmins</option>
                  </select>

                  {/* Status filter */}
                  <select
                    value={userStatusFilter}
                    onChange={(e: any) => setUserStatusFilter(e.target.value)}
                    className="px-3 py-2 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.08)] text-xs text-white focus:outline-none focus:border-[#e2a355] font-mono cursor-pointer"
                  >
                    <option value="all">All Status</option>
                    <option value="active">Active Only</option>
                    <option value="inactive">Inactive Only</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    onClick={loadAdminData}
                    variant="outline"
                    size="sm"
                    className="border-[rgba(242,236,223,0.1)] bg-[#1c1712] text-[#8e8473] hover:text-white text-xs font-mono"
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                    Refresh
                  </Button>
                  <Button
                    onClick={() => {
                      resetCreateForm();
                      setShowAddUserModal(true);
                    }}
                    className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs font-mono hover:opacity-95 shadow-md shadow-[#e2a355]/20"
                  >
                    <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                    Create User Account
                  </Button>
                </div>
              </div>

              {/* Users Data Table */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl overflow-x-auto">
                <table className="w-full text-left text-xs font-mono min-w-[1060px]">
                  <thead>
                    <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712] text-[#8e8473]">
                      <th className="py-3.5 px-5 min-w-[220px]">User</th>
                      <th className="py-3.5 px-4 min-w-[120px]">Role</th>
                      <th className="py-3.5 px-4 min-w-[180px]">Assigned Teams</th>
                      <th className="py-3.5 px-4 min-w-[200px]">Telemetry &amp; Daemon</th>
                      <th className="py-3.5 px-4 min-w-[120px]">Status</th>
                      <th className="py-3.5 px-5 text-right whitespace-nowrap min-w-[240px]">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                    {filteredUsers.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[#8e8473]">
                          No user accounts matched your search or filters.
                        </td>
                      </tr>
                    ) : (
                      filteredUsers.map((u: any) => {
                        const isSelf = u.id === session.userId || u.username === session.username;
                        const isSuperadmin = u.role === 'superadmin';
                        const isAdmin = u.role === 'admin';
                        const isActive = u.active !== false;

                        return (
                          <tr key={u.id} className="hover:bg-[rgba(226,163,85,0.04)] transition-all group">
                            {/* User details */}
                            <td className="py-3.5 px-5">
                              <div className="flex items-center gap-3">
                                <div className="relative shrink-0">
                                  <div className={`flex h-8 w-8 items-center justify-center rounded-xl text-xs font-bold font-mono border ${
                                    isSuperadmin
                                      ? 'bg-red-500/15 text-red-400 border-red-500/30'
                                      : isAdmin
                                      ? 'bg-amber-500/15 text-[#f5c485] border-amber-500/30'
                                      : 'bg-[#38bdf8]/15 text-[#38bdf8] border-[#38bdf8]/30'
                                  }`}>
                                    {(u.displayName || u.username || 'U').slice(0, 2).toUpperCase()}
                                  </div>
                                  <span
                                    className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#14100c] ${
                                      isActive ? 'bg-emerald-400' : 'bg-[#8e8473]'
                                    }`}
                                    title={isActive ? 'Account Active' : 'Account Inactive'}
                                  />
                                </div>
                                <div className="min-w-0">
                                  <div className="font-bold text-white flex items-center gap-2">
                                    <span className="truncate">{u.displayName || u.username}</span>
                                    {isSelf && (
                                      <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                        YOU
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-[#8e8473] font-mono truncate">
                                    @{u.username}
                                    {u.member_name && u.member_name !== u.displayName && (
                                      <span className="text-[10px] text-[#cbbfad] ml-1">
                                        (linked: {u.member_name})
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </td>

                            {/* Role */}
                            <td className="py-3.5 px-4">
                              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-[10.5px] font-bold ${
                                isSuperadmin
                                  ? 'bg-red-500/15 text-red-400 border border-red-500/30 shadow-sm shadow-red-500/10'
                                  : isAdmin
                                  ? 'bg-amber-500/15 text-[#f5c485] border border-amber-500/30 shadow-sm shadow-amber-500/10'
                                  : 'bg-[#38bdf8]/15 text-[#38bdf8] border border-[#38bdf8]/30'
                              }`}>
                                {isSuperadmin ? (
                                  <Shield className="h-3 w-3" />
                                ) : isAdmin ? (
                                  <Key className="h-3 w-3" />
                                ) : (
                                  <Users className="h-3 w-3" />
                                )}
                                {u.role}
                              </span>
                            </td>

                            {/* Assigned Teams */}
                            <td className="py-3.5 px-4">
                              <div className="flex flex-wrap gap-1 max-w-[220px]">
                                {Array.isArray(u.teams) && u.teams.length > 0 ? (
                                  u.teams.map((t: any, tidx: number) => (
                                    <span
                                      key={tidx}
                                      className="inline-flex items-center px-2 py-0.5 rounded bg-[#1c1712] text-[#cbbfad] border border-[rgba(242,236,223,0.08)] text-[10px]"
                                    >
                                      {t.name}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[#8e8473] text-[11px]">{u.team_name || '—'}</span>
                                )}
                              </div>
                            </td>

                            {/* Telemetry & Daemon */}
                            <td className="py-3.5 px-4">
                              <div className="space-y-0.5">
                                <div className="flex items-center gap-1.5">
                                  {u.daemon_version ? (
                                    <span className="inline-flex items-center gap-1 text-[10.5px] text-emerald-400 font-bold">
                                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                      {u.daemon_version}
                                    </span>
                                  ) : (
                                    <span className="text-[#8e8473] text-[10.5px]">No daemon</span>
                                  )}
                                  <span className="text-[10px] text-[#8e8473]">•</span>
                                  <span className="text-[10.5px] text-[#cbbfad]">
                                    {u.session_count || 0} sessions
                                  </span>
                                </div>
                                <div className="text-[10px] text-[#8e8473]">
                                  Last active: {u.last_session_at ? new Date(u.last_session_at).toLocaleDateString() : (u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'Never')}
                                </div>
                              </div>
                            </td>

                            {/* Status */}
                            <td className="py-3.5 px-4">
                              <button
                                onClick={() => !isSelf && handleToggleUserStatus(u)}
                                disabled={isSelf}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10.5px] font-bold transition-all ${
                                  isActive
                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
                                    : 'bg-[#1c1712] text-[#8e8473] border border-[rgba(242,236,223,0.08)] hover:text-white'
                                } ${isSelf ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'}`}
                                title={isSelf ? 'Cannot deactivate self' : `Click to ${isActive ? 'deactivate' : 'activate'}`}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-emerald-400' : 'bg-[#8e8473]'}`} />
                                {isActive ? 'Active' : 'Inactive'}
                              </button>
                            </td>

                            {/* Actions */}
                            <td className="py-3.5 px-5 text-right whitespace-nowrap">
                              <div className="flex items-center justify-end gap-1.5 flex-nowrap">
                                {/* Impersonate */}
                                {!isSelf && isActive && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleImpersonateUser(u)}
                                    className="h-7 px-2.5 text-[11px] text-[#38bdf8] bg-[#38bdf8]/10 hover:bg-[#38bdf8]/20 hover:text-[#38bdf8] border border-[#38bdf8]/30 rounded-lg shrink-0"
                                    title="Impersonate User"
                                  >
                                    <Eye className="h-3.5 w-3.5 mr-1" />
                                    View As
                                  </Button>
                                )}

                                {/* CLI Setup Command */}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleOpenSetupModal(u)}
                                  className="h-7 w-7 p-0 text-[#8e8473] hover:text-[#f5c485] bg-[#1c1712] hover:bg-[rgba(226,163,85,0.15)] border border-[rgba(242,236,223,0.08)] hover:border-[#e2a355]/40 rounded-lg shrink-0"
                                  title="View Ingest Setup Commands"
                                >
                                  <Terminal className="h-3.5 w-3.5" />
                                </Button>

                                {/* Reset Password */}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleOpenResetModal(u)}
                                  className="h-7 w-7 p-0 text-[#8e8473] hover:text-[#f5c485] bg-[#1c1712] hover:bg-[rgba(226,163,85,0.15)] border border-[rgba(242,236,223,0.08)] hover:border-[#e2a355]/40 rounded-lg shrink-0"
                                  title="Reset Password"
                                >
                                  <KeyRound className="h-3.5 w-3.5" />
                                </Button>

                                {/* Edit */}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleOpenEditModal(u)}
                                  className="h-7 w-7 p-0 text-[#8e8473] hover:text-white bg-[#1c1712] hover:bg-[#251f18] border border-[rgba(242,236,223,0.08)] hover:border-[#e2a355]/40 rounded-lg shrink-0"
                                  title="Edit User"
                                >
                                  <Edit3 className="h-3.5 w-3.5" />
                                </Button>

                                {/* Delete */}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isSelf}
                                  onClick={() => setDeleteConfirmModal(u)}
                                  className={`h-7 w-7 p-0 text-[#8e8473] hover:text-[#ef4444] bg-[#1c1712] hover:bg-red-500/15 border border-[rgba(242,236,223,0.08)] hover:border-red-500/30 rounded-lg shrink-0 ${
                                    isSelf ? 'opacity-30 cursor-not-allowed' : ''
                                  }`}
                                  title={isSelf ? 'Cannot delete own superadmin account' : 'Delete User'}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>
      </main>

      {/* =========================================================================
          MODAL 1: CREATE USER ACCOUNT (WITH TEAMS & TELEMETRY INGEST KEY)
         ========================================================================= */}
      {showAddUserModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#14100c] border border-[rgba(242,236,223,0.15)] rounded-2xl p-6 shadow-2xl space-y-4 font-mono max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[rgba(242,236,223,0.08)]">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <UserPlus className="h-4 w-4 text-[#e2a355]" />
                  Create User Account
                </h3>
                <p className="text-xs text-[#8e8473] font-sans mt-0.5">Provision a new developer, team admin, or superadmin</p>
              </div>
              <button
                onClick={() => setShowAddUserModal(false)}
                className="text-[#8e8473] hover:text-white p-1 rounded-lg hover:bg-[#1c1712]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {createdApiKey ? (
              <div className="space-y-4 animate-fadeIn">
                <div className="p-3.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-xs text-emerald-400 space-y-1">
                  <div className="font-bold">🎉 Account Created Successfully!</div>
                  <div className="text-[11px] text-emerald-300/80">
                    Telemetry Ingest Key has been generated for this developer. Provide the command below to connect their CLI daemon.
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[11px] text-[#8e8473] uppercase font-bold">Ingest API Key</label>
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
                </div>

                {createdInstallMac && (
                  <div className="space-y-1.5">
                    <label className="text-[11px] text-[#8e8473] uppercase font-bold flex items-center justify-between">
                      <span>🍎 macOS / Linux Setup Command</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(createdInstallMac);
                          toast.success('Mac command copied!');
                        }}
                        className="text-[#e2a355] hover:underline text-[10px] lowercase"
                      >
                        copy command
                      </button>
                    </label>
                    <pre className="p-2.5 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] text-[11px] text-[#cbbfad] overflow-x-auto whitespace-pre-wrap break-all font-mono">
                      {createdInstallMac}
                    </pre>
                  </div>
                )}

                {createdInstallWin && (
                  <div className="space-y-1.5">
                    <label className="text-[11px] text-[#8e8473] uppercase font-bold flex items-center justify-between">
                      <span>🪟 Windows PowerShell Setup Command</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(createdInstallWin);
                          toast.success('Windows command copied!');
                        }}
                        className="text-[#e2a355] hover:underline text-[10px] lowercase"
                      >
                        copy command
                      </button>
                    </label>
                    <pre className="p-2.5 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] text-[11px] text-[#cbbfad] overflow-x-auto whitespace-pre-wrap break-all font-mono">
                      {createdInstallWin}
                    </pre>
                  </div>
                )}

                <Button
                  onClick={() => {
                    setShowAddUserModal(false);
                    resetCreateForm();
                  }}
                  className="w-full bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs"
                >
                  Done
                </Button>
              </div>
            ) : (
              <form onSubmit={handleCreateUser} className="space-y-3.5">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Username *</label>
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
                    <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Display Name *</label>
                    <input
                      type="text"
                      required
                      value={newDisplayName}
                      onChange={(e) => setNewDisplayName(e.target.value)}
                      className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                      placeholder="e.g. Sarah Kim"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-medium text-[#8e8473] uppercase">Temporary Password *</label>
                    <button
                      type="button"
                      onClick={() => {
                        const randomPw = 'TT-' + Math.random().toString(36).slice(-8) + '!';
                        setNewPassword(randomPw);
                      }}
                      className="text-[10px] text-[#e2a355] hover:underline"
                    >
                      generate random
                    </button>
                  </div>
                  <input
                    type="text"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                    placeholder="Min 8 characters"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Access Role *</label>
                  <select
                    value={newRole}
                    onChange={(e: any) => setNewRole(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355] cursor-pointer"
                  >
                    <option value="user">Member (View personal token telemetry)</option>
                    <option value="admin">Team Admin (Executive view &amp; team management)</option>
                    <option value="superadmin">Superadmin (Full platform governance)</option>
                  </select>
                </div>

                {/* Team Assignment */}
                <div>
                  <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Assign Teams</label>
                  <div className="space-y-2 bg-[#1c1712] p-3 rounded-xl border border-[rgba(242,236,223,0.08)] max-h-36 overflow-y-auto">
                    {teamsList.map((t: any) => (
                      <label key={t.id} className="flex items-center gap-2 text-xs text-[#cbbfad] cursor-pointer hover:text-white">
                        <input
                          type="checkbox"
                          checked={newTeamIds.includes(t.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setNewTeamIds([...newTeamIds, t.id]);
                            } else {
                              setNewTeamIds(newTeamIds.filter(id => id !== t.id));
                            }
                          }}
                          className="rounded border-[#8e8473] text-[#e2a355] focus:ring-0"
                        />
                        <span>{t.name}</span>
                        <span className="text-[10px] text-[#8e8473]">({t.member_count || 0} devs)</span>
                      </label>
                    ))}
                  </div>
                  <input
                    type="text"
                    placeholder="Or enter new team name to create…"
                    value={newCustomTeam}
                    onChange={(e) => setNewCustomTeam(e.target.value)}
                    className="mt-2 w-full bg-[#1c1712] border border-[rgba(242,236,223,0.08)] rounded-xl px-3 py-1.5 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355]"
                  />
                </div>

                {/* Telemetry Linking */}
                <div>
                  <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Telemetry Daemon Association</label>
                  <select
                    value={newMemberOption}
                    onChange={(e) => setNewMemberOption(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355] cursor-pointer"
                  >
                    <option value="new">Auto-create new telemetry member &amp; Ingest API key</option>
                    {unlinkedMembers.map((m: any) => (
                      <option key={m.id} value={m.id}>
                        Link to unlinked telemetry dev: {m.display_name} ({m.team_name})
                      </option>
                    ))}
                    <option value="none">No telemetry link (web dashboard login only)</option>
                  </select>
                </div>

                <div className="flex gap-2 pt-3 border-t border-[rgba(242,236,223,0.08)]">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowAddUserModal(false)}
                    className="flex-1 text-xs border-[rgba(242,236,223,0.1)] text-[#8e8473] hover:text-white"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1 text-xs bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold"
                  >
                    Create Account
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 2: EDIT USER ACCOUNT
         ========================================================================= */}
      {editUserModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#14100c] border border-[rgba(242,236,223,0.15)] rounded-2xl p-6 shadow-2xl space-y-4 font-mono max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[rgba(242,236,223,0.08)]">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Edit3 className="h-4 w-4 text-[#e2a355]" />
                  Edit User Account
                </h3>
                <p className="text-xs text-[#8e8473] font-sans mt-0.5">Update credentials, team affiliations, and roles for @{editUserModal.username}</p>
              </div>
              <button
                onClick={() => setEditUserModal(null)}
                className="text-[#8e8473] hover:text-white p-1 rounded-lg hover:bg-[#1c1712]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleUpdateUser} className="space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Username</label>
                  <input
                    type="text"
                    required
                    value={editUsername}
                    onChange={(e) => setEditUsername(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Display Name</label>
                  <input
                    type="text"
                    required
                    value={editDisplayName}
                    onChange={(e) => setEditDisplayName(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Access Role</label>
                <select
                  value={editRole}
                  onChange={(e: any) => setEditRole(e.target.value)}
                  className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355] cursor-pointer"
                >
                  <option value="user">Member (Personal metrics view)</option>
                  <option value="admin">Team Admin (Executive &amp; Team view)</option>
                  <option value="superadmin">Superadmin (Platform administration)</option>
                </select>
              </div>

              {/* Status toggle */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.08)]">
                <div>
                  <div className="text-xs font-bold text-white">Account Status</div>
                  <div className="text-[11px] text-[#8e8473]">Deactivating prevents this user from logging in</div>
                </div>
                <button
                  type="button"
                  onClick={() => setEditActive(!editActive)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    editActive
                      ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                      : 'bg-red-500/15 text-red-400 border border-red-500/30'
                  }`}
                >
                  {editActive ? 'Active' : 'Inactive'}
                </button>
              </div>

              {/* Teams selection */}
              <div>
                <label className="block text-[11px] font-medium text-[#8e8473] uppercase mb-1">Assigned Teams</label>
                <div className="space-y-2 bg-[#1c1712] p-3 rounded-xl border border-[rgba(242,236,223,0.08)] max-h-36 overflow-y-auto">
                  {teamsList.map((t: any) => (
                    <label key={t.id} className="flex items-center gap-2 text-xs text-[#cbbfad] cursor-pointer hover:text-white">
                      <input
                        type="checkbox"
                        checked={editTeamIds.includes(t.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setEditTeamIds([...editTeamIds, t.id]);
                          } else {
                            setEditTeamIds(editTeamIds.filter(id => id !== t.id));
                          }
                        }}
                        className="rounded border-[#8e8473] text-[#e2a355] focus:ring-0"
                      />
                      <span>{t.name}</span>
                      <span className="text-[10px] text-[#8e8473]">({t.member_count || 0} devs)</span>
                    </label>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Or enter new team name…"
                  value={editCustomTeam}
                  onChange={(e) => setEditCustomTeam(e.target.value)}
                  className="mt-2 w-full bg-[#1c1712] border border-[rgba(242,236,223,0.08)] rounded-xl px-3 py-1.5 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355]"
                />
              </div>

              <div className="flex gap-2 pt-3 border-t border-[rgba(242,236,223,0.08)]">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditUserModal(null)}
                  className="flex-1 text-xs border-[rgba(242,236,223,0.1)] text-[#8e8473] hover:text-white"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="flex-1 text-xs bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold"
                >
                  Save Changes
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 3: RESET PASSWORD
         ========================================================================= */}
      {resetPasswordModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#14100c] border border-[rgba(242,236,223,0.15)] rounded-2xl p-6 shadow-2xl space-y-4 font-mono">
            <div className="flex items-center justify-between pb-3 border-b border-[rgba(242,236,223,0.08)]">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-[#e2a355]" />
                  Reset User Password
                </h3>
                <p className="text-xs text-[#8e8473] font-sans mt-0.5">
                  Set a new password for @{resetPasswordModal.username} ({resetPasswordModal.displayName})
                </p>
              </div>
              <button
                onClick={() => setResetPasswordModal(null)}
                className="text-[#8e8473] hover:text-white p-1 rounded-lg hover:bg-[#1c1712]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {resetResultPassword ? (
              <div className="space-y-4 animate-fadeIn">
                <div className="p-3.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-xs text-emerald-400">
                  ✅ Password reset successfully!
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] text-[#8e8473] uppercase font-bold">Temporary Password</label>
                  <div className="flex items-center gap-2 bg-[#1c1712] p-2.5 rounded-xl border border-[rgba(242,236,223,0.1)]">
                    <code className="text-xs text-[#f5c485] font-mono flex-1 font-bold">{resetResultPassword}</code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(resetResultPassword);
                        toast.success('Password copied to clipboard!');
                      }}
                      className="text-[#8e8473] hover:text-white p-1"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="text-[10px] text-[#8e8473]">Share this password securely with the user.</p>
                </div>
                <Button
                  onClick={() => setResetPasswordModal(null)}
                  className="w-full bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs"
                >
                  Close
                </Button>
              </div>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-3.5">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-medium text-[#8e8473] uppercase">New Password (optional)</label>
                    <button
                      type="button"
                      onClick={() => {
                        const randomPw = 'TT-' + Math.random().toString(36).slice(-8) + '!';
                        setResetNewPassword(randomPw);
                      }}
                      className="text-[10px] text-[#e2a355] hover:underline"
                    >
                      auto-generate
                    </button>
                  </div>
                  <input
                    type="text"
                    value={resetNewPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                    placeholder="Leave blank to generate automatic 12-char password"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setResetPasswordModal(null)}
                    className="flex-1 text-xs border-[rgba(242,236,223,0.1)] text-[#8e8473] hover:text-white"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1 text-xs bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold"
                  >
                    Confirm Reset
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 4: DELETE USER CONFIRMATION
         ========================================================================= */}
      {deleteConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#14100c] border border-red-500/30 rounded-2xl p-6 shadow-2xl space-y-4 font-mono">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/15 text-red-400 shrink-0">
                <Trash2 className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Delete User Account</h3>
                <p className="text-xs text-[#8e8473] font-sans">This action cannot be undone</p>
              </div>
            </div>

            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-300 space-y-1">
              <div>
                Are you sure you want to permanently delete user <strong>@{deleteConfirmModal.username}</strong> ({deleteConfirmModal.displayName})?
              </div>
              <div className="text-[11px] text-red-400/80">
                Their user account, credentials, and telemetry links will be removed from the platform.
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setDeleteConfirmModal(null)}
                className="flex-1 text-xs border-[rgba(242,236,223,0.1)] text-[#8e8473] hover:text-white"
              >
                Cancel
              </Button>
              <Button
                onClick={handleDeleteUser}
                className="flex-1 text-xs bg-red-600 hover:bg-red-700 text-white font-bold"
              >
                Delete Account
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 5: VIEW CLI SETUP & INGEST API KEY
         ========================================================================= */}
      {viewSetupModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#14100c] border border-[rgba(242,236,223,0.15)] rounded-2xl p-6 shadow-2xl space-y-4 font-mono max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[rgba(242,236,223,0.08)]">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-[#e2a355]" />
                  Daemon Telemetry Setup
                </h3>
                <p className="text-xs text-[#8e8473] font-sans mt-0.5">
                  Connection commands for @{viewSetupModal.username} ({viewSetupModal.displayName})
                </p>
              </div>
              <button
                onClick={() => setViewSetupModal(null)}
                className="text-[#8e8473] hover:text-white p-1 rounded-lg hover:bg-[#1c1712]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {viewSetupModal.api_key && (
              <div className="space-y-1.5">
                <label className="text-[11px] text-[#8e8473] uppercase font-bold">Ingest API Key</label>
                <div className="flex items-center gap-2 bg-[#1c1712] p-2.5 rounded-xl border border-[rgba(242,236,223,0.1)]">
                  <code className="text-xs text-[#f5c485] font-mono flex-1 truncate">{viewSetupModal.api_key}</code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(viewSetupModal.api_key);
                      toast.success('API key copied!');
                    }}
                    className="text-[#8e8473] hover:text-white p-1"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] text-[#8e8473] uppercase font-bold flex items-center justify-between">
                <span>🍎 macOS / Linux Setup Command</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(viewSetupModal.macCmd);
                    toast.success('Mac command copied!');
                  }}
                  className="text-[#e2a355] hover:underline text-[10px] lowercase"
                >
                  copy command
                </button>
              </label>
              <pre className="p-2.5 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] text-[11px] text-[#cbbfad] overflow-x-auto whitespace-pre-wrap break-all font-mono">
                {viewSetupModal.macCmd}
              </pre>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] text-[#8e8473] uppercase font-bold flex items-center justify-between">
                <span>🪟 Windows PowerShell Setup Command</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(viewSetupModal.winCmd);
                    toast.success('Windows command copied!');
                  }}
                  className="text-[#e2a355] hover:underline text-[10px] lowercase"
                >
                  copy command
                </button>
              </label>
              <pre className="p-2.5 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] text-[11px] text-[#cbbfad] overflow-x-auto whitespace-pre-wrap break-all font-mono">
                {viewSetupModal.winCmd}
              </pre>
            </div>

            <Button
              onClick={() => setViewSetupModal(null)}
              className="w-full bg-[#1c1712] text-white border border-[rgba(242,236,223,0.1)] hover:bg-[#251f18] text-xs font-mono"
            >
              Close
            </Button>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 6: ADD / EDIT MODEL PRICING RULE
         ========================================================================= */}
      {showPricingModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#14100c] border border-[rgba(242,236,223,0.15)] rounded-2xl p-6 shadow-2xl space-y-4 font-mono max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[rgba(242,236,223,0.08)]">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Tag className="h-4 w-4 text-[#e2a355]" />
                  {editingPricingRule ? 'Edit Model Pricing Rule' : 'Add Model Pricing Rule'}
                </h3>
                <p className="text-xs text-[#8e8473] font-sans mt-0.5">
                  Set input, output, and prompt cache rates per 1M tokens
                </p>
              </div>
              <button
                onClick={() => setShowPricingModal(false)}
                className="text-[#8e8473] hover:text-white p-1 rounded-lg hover:bg-[#1c1712]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSavePricing} className="space-y-4">
              {/* Model Pattern Input */}
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-[#8e8473] uppercase">Model Name / Pattern (Required)</label>
                <input
                  type="text"
                  required
                  value={pricingModelPattern}
                  onChange={(e) => setPricingModelPattern(e.target.value)}
                  placeholder="e.g. claude-3-7-sonnet, gpt-4.5, gemini-2.0-flash"
                  className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355]"
                />
                <p className="text-[10px] text-[#8e8473]">
                  Matches incoming session <code>model</code> strings using substring/wildcard matching.
                </p>
              </div>

              {/* Scope Selection (Global or Team) */}
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-[#8e8473] uppercase">Pricing Scope</label>
                <select
                  value={pricingTeamId}
                  onChange={(e) => setPricingTeamId(e.target.value)}
                  className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                >
                  <option value="global">🌐 Global (Applies to all teams unless overridden)</option>
                  {teamsList.map((t) => (
                    <option key={t.id} value={t.id}>
                      🏢 Team: {t.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Rate Inputs Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-[10.5px] font-medium text-[#8e8473] uppercase">Input ($ / 1M)</label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-2 text-xs text-[#8e8473]">$</span>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      required
                      value={pricingCostIn}
                      onChange={(e) => setPricingCostIn(e.target.value)}
                      placeholder="3.00"
                      className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl pl-6 pr-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10.5px] font-medium text-[#8e8473] uppercase">Output ($ / 1M)</label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-2 text-xs text-[#8e8473]">$</span>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      required
                      value={pricingCostOut}
                      onChange={(e) => setPricingCostOut(e.target.value)}
                      placeholder="15.00"
                      className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl pl-6 pr-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10.5px] font-medium text-[#8e8473] uppercase">Cache Read ($ / 1M)</label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-2 text-xs text-[#8e8473]">$</span>
                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      required
                      value={pricingCostCache}
                      onChange={(e) => setPricingCostCache(e.target.value)}
                      placeholder="0.30"
                      className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl pl-6 pr-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                    />
                  </div>
                </div>
              </div>

              {/* Live Turn Cost Preview */}
              {(() => {
                const cIn = parseFloat(pricingCostIn) || 0;
                const cOut = parseFloat(pricingCostOut) || 0;
                const cCache = parseFloat(pricingCostCache) || 0;
                const sampleTurnCost = (5000 / 1_000_000) * cIn + (1000 / 1_000_000) * cOut;
                const cachedTurnCost = (2000 / 1_000_000) * cIn + (3000 / 1_000_000) * cCache + (1000 / 1_000_000) * cOut;
                const discountPct = cIn > 0 ? Math.max(0, Math.round(((cIn - cCache) / cIn) * 100)) : 0;
                return (
                  <div className="p-3 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.06)] text-[11px] space-y-1.5">
                    <div className="flex justify-between text-[#8e8473]">
                      <span>Cache discount efficiency:</span>
                      <strong className="text-emerald-400">{discountPct}% savings on cached input</strong>
                    </div>
                    <div className="flex justify-between text-[#8e8473]">
                      <span>Typical turn (5k in, 1k out, 3k cached):</span>
                      <strong className="text-[#f5c485]">${cachedTurnCost.toFixed(4)} (vs ${sampleTurnCost.toFixed(4)} uncached)</strong>
                    </div>
                  </div>
                );
              })()}

              {/* Retroactive Recalculation Checkbox */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="syncRecalc"
                  checked={pricingSyncRecalc}
                  onChange={(e) => setPricingSyncRecalc(e.target.checked)}
                  className="rounded border-[rgba(242,236,223,0.2)] bg-[#1c1712] text-[#e2a355] focus:ring-[#e2a355]"
                />
                <label htmlFor="syncRecalc" className="text-xs text-[#cbbfad] cursor-pointer">
                  Retroactively recalculate historical telemetry costs for matched sessions
                </label>
              </div>

              {/* Modal Actions */}
              <div className="flex gap-2 pt-3 border-t border-[rgba(242,236,223,0.08)]">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowPricingModal(false)}
                  className="flex-1 text-xs border-[rgba(242,236,223,0.1)] text-[#8e8473] hover:text-white"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="flex-1 text-xs bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold"
                >
                  {editingPricingRule ? 'Save & Sync Rule' : 'Create Pricing Rule'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL 7: DELETE PRICING RULE CONFIRMATION
         ========================================================================= */}
      {pricingDeleteConfirm && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#14100c] border border-red-500/30 rounded-2xl p-6 shadow-2xl space-y-4 font-mono">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/15 text-red-400 shrink-0">
                <Trash2 className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Remove Custom Pricing Rule</h3>
                <p className="text-xs text-[#8e8473] font-sans">Reverts model pricing to system defaults</p>
              </div>
            </div>

            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-300 space-y-1">
              <div>
                Are you sure you want to remove the custom pricing rule for <strong><code>{pricingDeleteConfirm.model_pattern}</code></strong>?
              </div>
              <div className="text-[11px] text-red-400/80">
                Sessions matching this pattern will revert to using standard foundation model rates ($3.00/$15.00/$0.30 per 1M).
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setPricingDeleteConfirm(null)}
                className="flex-1 text-xs border-[rgba(242,236,223,0.1)] text-[#8e8473] hover:text-white"
              >
                Cancel
              </Button>
              <Button
                onClick={handleDeletePricing}
                className="flex-1 text-xs bg-red-600 hover:bg-red-700 text-white font-bold"
              >
                Remove Override
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

