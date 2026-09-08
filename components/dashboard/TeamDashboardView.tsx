'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCompactNumber, formatCurrency } from '@/lib/utils';
import { 
  Users, 
  Sparkles, 
  Activity, 
  Zap, 
  Coins, 
  Clock, 
  Search, 
  ChevronRight, 
  GitBranch, 
  SlidersHorizontal,
  RefreshCw,
  LogOut,
  Folder,
  FileCode,
  Key,
  DollarSign,
  AlertTriangle,
  ArrowUpRight,
  Shield,
  Layers,
  CheckCircle2,
  Copy,
  Terminal,
  X,
  AlertCircle,
  Bug,
  ChevronDown,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  RotateCcw,
  Cpu,
  BarChart3,
  FileText,
  Settings,
  HelpCircle,
  TrendingUp,
  Filter,
  Plus,
  UserPlus,
  Radio,
  Server,
  Calendar,
  CalendarDays,
  Check,
  Edit2,
  Trash2,
  Lock,
  Eye,
  EyeOff,
  UserCheck,
  UserX,
  ShieldAlert,
  ExternalLink,
  MoreVertical
} from 'lucide-react';
import { toast } from 'sonner';

interface TeamDashboardProps {
  session: {
    userId: string;
    username: string;
    displayName: string;
    role: string;
    teamId?: string | null;
  };
}

export function TeamDashboardView({ session }: TeamDashboardProps) {
  const [activeTab, setActiveTab] = React.useState<'overview' | 'daily' | 'developers' | 'prompts' | 'daemon' | 'pricing'>('overview');
  const [timeRange, setTimeRange] = React.useState<'today' | '7d' | '14d' | '30d' | 'all' | 'custom'>('7d');
  const [customFrom, setCustomFrom] = React.useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = React.useState<string>(() => new Date().toISOString().slice(0, 10));
  const [showCustomDatePicker, setShowCustomDatePicker] = React.useState(false);

  // Global Multi-Select Developer State
  const [isDevDropdownOpen, setIsDevDropdownOpen] = React.useState(false);
  const [devDropdownSearch, setDevDropdownSearch] = React.useState('');
  const devDropdownRef = React.useRef<HTMLDivElement>(null);

  const [teams, setTeams] = React.useState<any[]>([]);
  const [selectedTeamId, setSelectedTeamId] = React.useState<string>(session.teamId || '');
  const [selectedGlobalMemberIds, setSelectedGlobalMemberIds] = React.useState<string[]>([]);
  const [stats, setStats] = React.useState<any | null>(null);
  const [members, setMembers] = React.useState<any[]>([]);
  const [dbPrompts, setDbPrompts] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  const toggleGlobalMemberId = (id: string) => {
    setSelectedGlobalMemberIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  const selectAllGlobalMembers = () => {
    setSelectedGlobalMemberIds([]);
  };
  
  // Modals state
  const [showAddPricingModal, setShowAddPricingModal] = React.useState(false);
  const [showInviteModal, setShowInviteModal] = React.useState(false);
  const [inspectingPrompt, setInspectingPrompt] = React.useState<any | null>(null);
  const [inspectingError, setInspectingError] = React.useState<any | null>(null);

  // User Management & Direct CRUD States for Team Admin
  const [showCreateUserModal, setShowCreateUserModal] = React.useState(false);
  const [createUserForm, setCreateUserForm] = React.useState({
    displayName: '',
    username: '',
    role: 'member',
    passwordOption: 'auto' as 'auto' | 'custom',
    customPassword: '',
  });
  const [isCreatingUser, setIsCreatingUser] = React.useState(false);
  const [createdUserResult, setCreatedUserResult] = React.useState<any | null>(null);

  const [editingMember, setEditingMember] = React.useState<any | null>(null);
  const [isUpdatingMember, setIsUpdatingMember] = React.useState(false);

  const [resetPasswordModal, setResetPasswordModal] = React.useState<any | null>(null);
  const [isResettingPassword, setIsResettingPassword] = React.useState(false);

  const [deleteMemberModal, setDeleteMemberModal] = React.useState<{ id: string; displayName: string; hardDelete: boolean } | null>(null);
  const [isDeletingMember, setIsDeletingMember] = React.useState(false);

  const [viewCliModal, setViewCliModal] = React.useState<any | null>(null);

  // New Pricing Rule Form State
  const [newPricingForm, setNewPricingForm] = React.useState({
    modelName: '',
    provider: 'Anthropic',
    inputRate: '3.00',
    outputRate: '15.00',
    cacheRate: '0.30'
  });

  // Custom Pricing Rules State
  const [pricingRulesList, setPricingRulesList] = React.useState<any[]>([]);

  // Selected developer for right-hand deep dive inspector
  const [selectedMember, setSelectedMember] = React.useState<any | null>(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [promptSearch, setPromptSearch] = React.useState('');
  const [selectedPromptModel, setSelectedPromptModel] = React.useState<string>('all');
  const [selectedPromptProject, setSelectedPromptProject] = React.useState<string>('all');
  const [dailyChartMetric, setDailyChartMetric] = React.useState<'tokens' | 'cost' | 'sessions'>('tokens');
  const [hoveredDailyIndex, setHoveredDailyIndex] = React.useState<number | null>(null);
  
  // Day-wise local developer analysis & comparison state
  const [dailySelectedMemberIds, setDailySelectedMemberIds] = React.useState<string[]>([]);
  
  const toggleDailyMember = (id: string) => {
    setDailySelectedMemberIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  const selectAllDailyMembers = (ids: string[]) => {
    setDailySelectedMemberIds(ids);
  };

  const clearDailyMembers = () => {
    setDailySelectedMemberIds([]);
  };

  // ── USER MANAGEMENT CRUD HANDLERS ──────────────────────────────────────────
  const handleCreateTeamMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createUserForm.displayName.trim()) {
      toast.error('Display Name is required');
      return;
    }
    setIsCreatingUser(true);
    try {
      const payload: any = {
        teamId: selectedTeamId,
        displayName: createUserForm.displayName.trim(),
        role: createUserForm.role,
      };
      if (createUserForm.username.trim()) {
        payload.username = createUserForm.username.trim().toLowerCase();
      }
      if (createUserForm.passwordOption === 'custom' && createUserForm.customPassword.trim()) {
        payload.password = createUserForm.customPassword.trim();
      }

      const res = await fetch('/api/v1/team/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to create user');
        return;
      }

      toast.success(`User "${data.member?.display_name || createUserForm.displayName}" created!`);
      setShowCreateUserModal(false);
      setCreatedUserResult(data);
      setCreateUserForm({
        displayName: '',
        username: '',
        role: 'member',
        passwordOption: 'auto',
        customPassword: '',
      });
      await fetchTeamData();
    } catch (err: any) {
      toast.error(err?.message || 'Error creating user');
    } finally {
      setIsCreatingUser(false);
    }
  };

  const handleUpdateTeamMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMember) return;
    setIsUpdatingMember(true);
    try {
      const res = await fetch('/api/v1/team/members', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teamId: selectedTeamId,
          id: editingMember.id,
          displayName: editingMember.displayName.trim(),
          username: editingMember.username ? editingMember.username.trim().toLowerCase() : undefined,
          role: editingMember.role,
          active: editingMember.active,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to update member');
        return;
      }
      toast.success('Team member updated successfully');
      setEditingMember(null);
      await fetchTeamData();
    } catch (err: any) {
      toast.error(err?.message || 'Error updating member');
    } finally {
      setIsUpdatingMember(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPasswordModal) return;
    setIsResettingPassword(true);
    try {
      const payload: any = {
        teamId: selectedTeamId,
        memberId: resetPasswordModal.memberId,
      };
      if (resetPasswordModal.newPasswordOption === 'custom' && resetPasswordModal.customPassword.trim()) {
        payload.newPassword = resetPasswordModal.customPassword.trim();
      }
      const res = await fetch('/api/v1/team/members/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to reset password');
        return;
      }
      setResetPasswordModal((prev: any) => ({
        ...prev,
        resultPassword: data.newPassword,
        username: data.username || prev.username,
      }));
      toast.success('Password reset successfully!');
    } catch (err: any) {
      toast.error(err?.message || 'Error resetting password');
    } finally {
      setIsResettingPassword(false);
    }
  };

  const handleDeleteTeamMember = async () => {
    if (!deleteMemberModal) return;
    setIsDeletingMember(true);
    try {
      const res = await fetch(
        `/api/v1/team/members?id=${deleteMemberModal.id}&teamId=${encodeURIComponent(selectedTeamId || '')}&hard=${deleteMemberModal.hardDelete ? 'true' : 'false'}`,
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to remove member');
        return;
      }
      toast.success(`Removed ${deleteMemberModal.displayName} from team`);
      setDeleteMemberModal(null);
      if (selectedMember?.id === deleteMemberModal.id) {
        setSelectedMember(null);
      }
      await fetchTeamData();
    } catch (err: any) {
      toast.error(err?.message || 'Error removing member');
    } finally {
      setIsDeletingMember(false);
    }
  };

  // Prompts & Logs pagination state
  const [promptPage, setPromptPage] = React.useState(1);
  const [promptPageSize, setPromptPageSize] = React.useState(10);

  // Collapsible Prompt Payloads state
  const [collapsedPromptIds, setCollapsedPromptIds] = React.useState<Record<string, boolean>>({});

  const toggleCollapsePrompt = (id: string) => {
    setCollapsedPromptIds((prev) => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const collapseAllPrompts = (promptsList: any[]) => {
    const next: Record<string, boolean> = {};
    promptsList.forEach((p: any, idx: number) => {
      next[p.id || String(idx)] = true;
    });
    setCollapsedPromptIds(next);
  };

  const expandAllPrompts = () => {
    setCollapsedPromptIds({});
  };

  // Reset prompt pagination when filters change
  React.useEffect(() => {
    setPromptPage(1);
  }, [promptSearch, selectedPromptModel, selectedPromptProject, selectedGlobalMemberIds, selectedTeamId]);

  // Handle outside click for dev dropdown
  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (devDropdownRef.current && !devDropdownRef.current.contains(e.target as Node)) {
        setIsDevDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Compute from & to dates
  const getDates = React.useCallback((range: string) => {
    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    const fromDate = new Date(now);
    if (range === 'today') {
      return { from: to, to };
    } else if (range === '7d') {
      fromDate.setDate(fromDate.getDate() - 6);
      return { from: fromDate.toISOString().slice(0, 10), to };
    } else if (range === '14d') {
      fromDate.setDate(fromDate.getDate() - 13);
      return { from: fromDate.toISOString().slice(0, 10), to };
    } else if (range === '30d') {
      fromDate.setDate(fromDate.getDate() - 29);
      return { from: fromDate.toISOString().slice(0, 10), to };
    } else if (range === 'custom') {
      return { from: customFrom || to, to: customTo || to };
    }
    return { from: '2020-01-01', to };
  }, [customFrom, customTo]);

  // Fetch teams & team data
  const fetchTeams = React.useCallback(async () => {
    try {
      const res = await fetch('/api/v1/teams');
      if (res.ok) {
        const data = await res.json();
        const teamsList = data.teams || [];
        setTeams(teamsList);
        if (!selectedTeamId && teamsList.length > 0) {
          setSelectedTeamId(teamsList[0].id);
        }
      }
    } catch {
      // ignore
    }
  }, [selectedTeamId]);

  const fetchTeamData = React.useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = getDates(timeRange);
      const teamParam = selectedTeamId ? `&teamId=${encodeURIComponent(selectedTeamId)}` : '';
      const memberParam = selectedGlobalMemberIds.length > 0 ? `&memberIds=${encodeURIComponent(selectedGlobalMemberIds.join(','))}` : '';
      
      const [statsRes, membersRes, pricingRes, promptsRes] = await Promise.all([
        fetch(`/api/v1/team/stats?from=${from}&to=${to}${teamParam}${memberParam}`),
        fetch(`/api/v1/team/members?teamId=${encodeURIComponent(selectedTeamId || '')}`),
        fetch('/api/v1/team/pricing'),
        fetch(`/api/v1/team/prompts?from=${from}&to=${to}&limit=100${teamParam}${memberParam}`)
      ]);

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data);
      }
      if (membersRes.ok) {
        const data = await membersRes.json();
        setMembers(data.members || []);
      }
      if (pricingRes.ok) {
        const data = await pricingRes.json();
        if (data.pricing && data.pricing.length > 0) {
          setPricingRulesList(data.pricing);
        } else if (data.rules && data.rules.length > 0) {
          setPricingRulesList(data.rules);
        }
      }
      if (promptsRes.ok) {
        const data = await promptsRes.json();
        setDbPrompts(data.prompts || []);
      }
    } catch (err) {
      console.error('Failed to fetch team data:', err);
    } finally {
      setLoading(false);
    }
  }, [timeRange, selectedTeamId, selectedGlobalMemberIds, getDates]);

  React.useEffect(() => {
    fetchTeams();
  }, [fetchTeams]);

  React.useEffect(() => {
    fetchTeamData();
  }, [fetchTeamData]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/me', { method: 'POST', credentials: 'same-origin' });
      await fetch('/api/v1/auth/login', { method: 'DELETE', credentials: 'same-origin' });
    } catch {
      // ignore
    }
    document.cookie = 'app_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    document.cookie = 'sa_original_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    document.cookie = 'team_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    window.location.replace('/');
  };

  const handleTriggerSync = async (memberId: string, memberName: string) => {
    try {
      const res = await fetch('/api/v1/team/members/trigger-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: memberId, team_id: selectedTeamId })
      });
      if (!res.ok) throw new Error('Sync failed to dispatch');
      toast.success(`Sync command dispatched to ${memberName}'s daemon!`);
      await fetchTeamData();
    } catch (err: any) {
      toast.error(err.message || 'Failed to trigger sync');
    }
  };

  const handleTriggerAllSync = async () => {
    try {
      toast.info('Dispatching sync command to all registered client daemons...');
      for (const m of members) {
        await fetch('/api/v1/team/members/trigger-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: m.id, team_id: selectedTeamId })
        });
      }
      toast.success('Sync signals dispatched across entire fleet!');
      await fetchTeamData();
    } catch {
      toast.error('Failed to dispatch fleet sync');
    }
  };

  const handleRecalculateCosts = async () => {
    try {
      toast.info('Recalculating historical token costs across all team telemetry...');
      const res = await fetch('/api/v1/team/recalculate', { method: 'POST' });
      if (res.ok) {
        toast.success('Historical costs recalculated successfully!');
        await fetchTeamData();
      } else {
        toast.error('Failed to recalculate costs');
      }
    } catch {
      toast.error('Network error recalculating costs');
    }
  };

  const handleAddPricingRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPricingForm.modelName) {
      toast.error('Please enter a model name');
      return;
    }
    try {
      const res = await fetch('/api/v1/team/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelPattern: newPricingForm.modelName,
          provider: newPricingForm.provider,
          inputCostPerM: Number(newPricingForm.inputRate),
          outputCostPerM: Number(newPricingForm.outputRate),
          cacheCostPerM: Number(newPricingForm.cacheRate),
        })
      });
      if (res.ok) {
        toast.success(`Pricing rule saved for ${newPricingForm.modelName}!`);
        await fetchTeamData();
      } else {
        const newRule = {
          id: String(Date.now()),
          model_pattern: newPricingForm.modelName,
          provider: newPricingForm.provider,
          input_cost_per_m: Number(newPricingForm.inputRate),
          output_cost_per_m: Number(newPricingForm.outputRate),
          cache_cost_per_m: Number(newPricingForm.cacheRate),
        };
        setPricingRulesList(prev => [newRule, ...prev]);
        toast.success(`Pricing rule added!`);
      }
    } catch {
      toast.error('Failed to save pricing rule');
    }
    setShowAddPricingModal(false);
    setNewPricingForm({
      modelName: '',
      provider: 'Anthropic',
      inputRate: '3.00',
      outputRate: '15.00',
      cacheRate: '0.30'
    });
  };

  // ── LIVE DEVELOPER ROSTER FROM DATABASE (DATE-FILTERED) ──────────────────────
  const developerRoster = React.useMemo(() => {
    if (!members.length) return [];
    
    // When global developers are selected, scope the roster strictly to those developers
    const scopedMembers = selectedGlobalMemberIds.length > 0
      ? members.filter((m: any) => selectedGlobalMemberIds.includes(m.id))
      : members;

    return scopedMembers.map((m: any) => {
      // Find date-filtered matching entry from stats.leaderboard, stats.tokenLeaderboard, or stats.scoreboard
      const matchLeaderboard = stats?.leaderboard?.find((l: any) => (l.member_id || l.id) === m.id);
      const matchToken = stats?.tokenLeaderboard?.find((tl: any) => (tl.member_id || tl.id) === m.id);
      const matchScoreboard = stats?.scoreboard?.find((s: any) => (s.member_id || s.id) === m.id);
      
      const tokIn = Number(matchLeaderboard?.tokens_in ?? matchToken?.tokens_in ?? 0);
      const tokOut = Number(matchLeaderboard?.tokens_out ?? matchToken?.tokens_out ?? 0);
      const tokCache = Number(matchLeaderboard?.tokens_cache_read ?? matchToken?.tokens_cache_read ?? 0);
      const tok = tokIn + tokOut;
      const cost = Number(matchLeaderboard?.api_cost ?? matchToken?.api_cost ?? 0);
      const tools = Number(matchLeaderboard?.tool_calls ?? matchScoreboard?.toolCalls ?? 0);
      const errs = Number(matchLeaderboard?.tool_errors ?? matchScoreboard?.toolErrors ?? 0);
      const devErrRate = tools > 0 
        ? ((errs / tools) * 100).toFixed(1) 
        : (matchScoreboard?.toolErrorRate ? (Number(matchScoreboard.toolErrorRate) * 100).toFixed(1) : '0.0');

      // Member projects for the selected date range
      const memberProjs = matchLeaderboard?.projects || stats?.memberProjects?.filter((p: any) => p.member_id === m.id) || [];
      const topProjName = memberProjs[0]?.project || m.top_project || 'default';

      // Member prompts from live database
      const memberPrompts = dbPrompts.filter((p: any) => p.userName === m.display_name || p.memberId === m.id).map((p: any) => ({
        id: p.id || String(Math.random()),
        text: p.promptText || p.text || 'User Prompt',
        response: p.response || null,
        model: p.model || 'Unknown',
        tokens: Number(p.inputTokens || 0) + Number(p.outputTokens || 0),
        cost: Number(((Number(p.inputTokens || 0) * 3 + Number(p.outputTokens || 0) * 15) / 1000000).toFixed(3)),
        time: p.createdAt ? new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'recently',
        status: p.tool ? 'Tool Executed' : 'Success',
        latency: '1.1s',
        toolName: p.tool || 'editFile',
        hasError: false,
        errorDiagnostic: null,
        project: p.project || topProjName
      }));

      // Last sync formatting
      const lastSyncRaw = m.last_sync_at || m.daemon_last_seen_at;
      let lastSeenText = 'Never';
      let lastSeenFullText = 'Never synced';
      if (lastSyncRaw) {
        const diffMinutes = Math.floor((Date.now() - new Date(lastSyncRaw).getTime()) / 60000);
        lastSeenText = diffMinutes < 1 ? 'Just now' : diffMinutes < 60 ? `${diffMinutes}m ago` : `${Math.floor(diffMinutes / 60)}h ago`;
        lastSeenFullText = new Date(lastSyncRaw).toLocaleString();
      }

      const devSessionCount = Number(matchLeaderboard?.sessions ?? matchToken?.sessions ?? matchScoreboard?.sessions ?? 0);

      return {
        id: m.id,
        displayName: m.display_name || 'Engineer',
        handle: `@${(m.username || (m.display_name || 'dev').toLowerCase().replace(/\s+/g, '-'))}`,
        username: m.username || null,
        userId: m.user_id || null,
        userRole: m.user_role || m.role || 'member',
        userActive: m.user_active !== false,
        hasUserAccount: Boolean(m.has_user_account || m.user_id),
        apiKey: m.api_key || null,
        installCommandMac: m.installCommandMac || null,
        installCommandWin: m.installCommandWin || null,
        role: m.role || 'Member',
        daemonVersion: m.daemon_version || '1.3.0',
        isLatestDaemon: (m.daemon_version || '1.3.0') === '1.3.0',
        lastSeen: lastSeenText,
        lastSeenFull: lastSeenFullText,
        totalTokens: tok,
        tokensIn: tokIn,
        tokensOut: tokOut,
        tokensCacheRead: tokCache,
        apiCost: cost,
        topProject: topProjName,
        toolCalls: tools,
        toolErrors: errs,
        toolErrorRate: Number(devErrRate),
        isFlagged: Number(devErrRate) >= 5.0,
        sessionsCount: devSessionCount,
        promptsCount: memberPrompts.length || devSessionCount,
        projects: memberProjs.map((p: any) => ({
          name: p.project,
          tokens: Number(p.tokens_in || 0) + Number(p.tokens_out || 0),
          pct: tok > 0 ? Math.round(((Number(p.tokens_in || 0) + Number(p.tokens_out || 0)) / tok) * 100) : 100
        })),
        prompts: memberPrompts
      };
    });
  }, [members, stats, dbPrompts, selectedGlobalMemberIds]);

  // ── LIVE METRIC DERIVATIONS FROM DATABASE ────────────────────────────────────
  const totals = stats?.totals || {};
  const totalTokens = Number(totals.totalTokens || (Number(totals.tokensIn || 0) + Number(totals.tokensOut || 0)) || 0);
  const totalCost = Number(totals.totalCost || totals.apiCost || stats?.cost?.total || 0);
  const totalEdits = Number(totals.totalEdits || totals.edits || 0);

  // Scoped or global tool errors and tool calls calculation
  const totalToolCalls = Number(stats?.totals?.toolCalls || stats?.totals?.tool_calls || 0);
  const totalToolErrors = Number(stats?.totals?.toolErrors || stats?.totals?.tool_errors || 0);

  const scopedToolCalls = selectedGlobalMemberIds.length > 0
    ? developerRoster.reduce((sum, d) => sum + (d.toolCalls || 0), 0)
    : (totalToolCalls > 0 ? totalToolCalls : developerRoster.reduce((sum, d) => sum + (d.toolCalls || 0), 0));

  const scopedToolErrors = selectedGlobalMemberIds.length > 0
    ? developerRoster.reduce((sum, d) => sum + (d.toolErrors || 0), 0)
    : (totalToolErrors > 0 ? totalToolErrors : developerRoster.reduce((sum, d) => sum + (d.toolErrors || 0), 0));

  const toolErrorRate = scopedToolCalls > 0 
    ? ((scopedToolErrors / scopedToolCalls) * 100).toFixed(1) 
    : (stats?.totals?.toolErrorRate 
        ? (Number(stats.totals.toolErrorRate) * 100).toFixed(1) 
        : '0.0');

  const activeSelected = React.useMemo(() => {
    if (selectedMember) {
      return developerRoster.find(d => d.id === selectedMember.id) || developerRoster[0] || null;
    }
    if (selectedGlobalMemberIds.length > 0) {
      return developerRoster.find(d => selectedGlobalMemberIds.includes(d.id)) || developerRoster[0] || null;
    }
    return developerRoster[0] || null;
  }, [selectedGlobalMemberIds, selectedMember, developerRoster]);

  const selectedGlobalMemberObjs = React.useMemo(() => {
    if (selectedGlobalMemberIds.length === 0) return [];
    return members.filter((m: any) => selectedGlobalMemberIds.includes(m.id));
  }, [selectedGlobalMemberIds, members]);

  const filteredRoster = developerRoster.filter(d => 
    !searchQuery || 
    d.displayName.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (d.username && d.username.toLowerCase().includes(searchQuery.toLowerCase())) ||
    d.topProject.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ── LIVE PROMPTS STREAM ──────────────────────────────────────────────────────
  const allPrompts = React.useMemo(() => {
    if (dbPrompts.length > 0) {
      return dbPrompts.map((p: any) => ({
        id: p.id,
        developerName: p.userName || 'Developer',
        developerHandle: `@${(p.userName || 'dev').toLowerCase().replace(/\s+/g, '-')}`,
        developerAvatar: (p.userName || 'DV').slice(0, 2).toUpperCase(),
        text: p.promptText || 'Session prompt turn',
        response: null,
        model: p.model || 'Claude 3.5 Sonnet',
        tokens: Number(p.inputTokens || 0) + Number(p.outputTokens || 0),
        cost: Number(((Number(p.inputTokens || 0) * 3 + Number(p.outputTokens || 0) * 15) / 1000000).toFixed(3)),
        time: p.createdAt ? new Date(p.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'recently',
        status: p.tool ? `Tool: ${p.tool}` : 'Success',
        latency: '1.2s',
        toolName: p.tool || 'editFile',
        hasError: false,
        errorDiagnostic: null,
        project: p.project || selectedTeamId ? 'Workspace Repo' : 'agentvis-next'
      }));
    }
    return developerRoster.flatMap(d => d.prompts.map(p => ({
      ...p,
      developerName: d.displayName,
      developerHandle: d.handle,
      developerAvatar: d.displayName.slice(0, 2).toUpperCase()
    })));
  }, [dbPrompts, developerRoster, selectedTeamId]);

  const filteredPrompts = allPrompts.filter(p => {
    const matchesSearch = !promptSearch || p.text.toLowerCase().includes(promptSearch.toLowerCase()) || p.developerName.toLowerCase().includes(promptSearch.toLowerCase());
    const matchesModel = selectedPromptModel === 'all' || p.model.toLowerCase().includes(selectedPromptModel.toLowerCase());
    const matchesProj = selectedPromptProject === 'all' || p.project.toLowerCase().includes(selectedPromptProject.toLowerCase());
    return matchesSearch && matchesModel && matchesProj;
  });

  const totalPromptPages = Math.max(1, Math.ceil(filteredPrompts.length / promptPageSize));
  const paginatedPrompts = React.useMemo(() => {
    const start = (promptPage - 1) * promptPageSize;
    return filteredPrompts.slice(start, start + promptPageSize);
  }, [filteredPrompts, promptPage, promptPageSize]);

  // ── LIVE PROJECT ROLLUP ──────────────────────────────────────────────────────
  const projectList = React.useMemo(() => {
    const rawProjects = stats?.projectRollup || stats?.projects || [];
    if (rawProjects.length > 0) {
      const maxTokens = Math.max(...rawProjects.map((p: any) => Number(p.tokens_in || 0) + Number(p.tokens_out || 0)), 1);
      return rawProjects.map((p: any) => {
        const tok = Number(p.tokens_in || 0) + Number(p.tokens_out || 0);
        return {
          name: p.project || 'Default Workspace',
          tokens: tok,
          pct: Math.max(5, Math.round((tok / maxTokens) * 100)),
          cost: formatCurrency(Number(p.api_cost || 0)),
          devs: Number(p.member_count || 1)
        };
      });
    }
    return [];
  }, [stats]);

  // ── LIVE TOOL ERROR BREAKDOWN ────────────────────────────────────────────────
  const toolBreakdown = React.useMemo(() => {
    const rawTools = stats?.topTools || [];
    if (rawTools.length > 0) {
      const maxCalls = Math.max(...rawTools.map((t: any) => Number(t.calls || 0)), 1);
      return rawTools.map((t: any) => ({
        name: t.tool_name || 'Tool',
        calls: Number(t.calls || 0),
        errors: Number(t.errors || 0),
        pct: Math.round((Number(t.calls || 0) / maxCalls) * 100),
        errPct: Number(t.calls || 0) > 0 ? ((Number(t.errors || 0) / Number(t.calls || 0)) * 100).toFixed(1) : '0.0'
      }));
    }
    return [];
  }, [stats]);

  // ── LIVE MODEL SHARE ─────────────────────────────────────────────────────────
  const modelShare = React.useMemo(() => {
    const rawModels = stats?.memberModels || [];
    if (rawModels.length > 0) {
      const map: Record<string, number> = {};
      let sum = 0;
      rawModels.forEach((m: any) => {
        const tok = Number(m.tokens_in || 0) + Number(m.tokens_out || 0);
        map[m.model] = (map[m.model] || 0) + tok;
        sum += tok;
      });
      return Object.entries(map).map(([model, tok]) => ({
        name: model,
        tokens: tok,
        pct: sum > 0 ? Math.round((tok / sum) * 100) : 0
      })).sort((a, b) => b.tokens - a.tokens);
    }
    return [];
  }, [stats]);

  // ── LIVE DAY-WISE TELEMETRY GROUPING ─────────────────────────────────────────
  const dailyUsageGrouping = React.useMemo(() => {
    const rawDaily = stats?.dailyMemberUsage || [];
    const byDayMap = new Map<string, any>();

    // Seed days from stats.byDay
    (stats?.byDay || []).forEach((d: any) => {
      byDayMap.set(d.date, {
        date: d.date,
        totalTokens: Number(d.tokens_in || 0) + Number(d.tokens_out || 0),
        tokensIn: Number(d.tokens_in || 0),
        tokensOut: Number(d.tokens_out || 0),
        apiCost: Number(d.api_cost || 0),
        sessions: Number(d.sessions || 0),
        edits: Number(d.edits || 0),
        developers: [] as any[]
      });
    });

    // Populate developer breakdowns per day
    rawDaily.forEach((r: any) => {
      const existing = byDayMap.get(r.date) || {
        date: r.date,
        totalTokens: 0,
        tokensIn: 0,
        tokensOut: 0,
        apiCost: 0,
        sessions: 0,
        edits: 0,
        developers: []
      };

      const devTok = Number(r.tokens_in || 0) + Number(r.tokens_out || 0);
      existing.developers.push({
        id: r.member_id,
        displayName: r.display_name,
        handle: `@${(r.display_name || 'dev').toLowerCase().replace(/\s+/g, '-')}`,
        tokens: devTok,
        tokensIn: Number(r.tokens_in || 0),
        tokensOut: Number(r.tokens_out || 0),
        tokensCache: Number(r.tokens_cache_read || 0),
        apiCost: Number(r.api_cost || 0),
        sessions: Number(r.sessions || 0),
        edits: Number(r.edits || 0),
        changedLines: Number(r.changed_lines || 0),
        toolCalls: Number(r.tool_calls || 0),
        toolErrors: Number(r.tool_errors || 0),
        toolErrorRate: Number(r.tool_calls || 0) > 0 ? ((Number(r.tool_errors || 0) / Number(r.tool_calls || 0)) * 100).toFixed(1) : '0.0'
      });

      // Sort developers on this day by tokens descending
      existing.developers.sort((a: any, b: any) => b.tokens - a.tokens);
      byDayMap.set(r.date, existing);
    });

    return Array.from(byDayMap.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [stats]);

  const latestDaemonCount = developerRoster.filter(d => d.isLatestDaemon).length;
  const outdatedDaemonCount = developerRoster.length - latestDaemonCount;

  return (
    <div className="flex min-h-screen bg-[#0d0a07] text-[#f5efe6] font-sans antialiased relative selection:bg-[#e2a355]/30">
      {/* 1. LEFT SIDEBAR NAVIGATION */}
      <aside className="w-64 min-w-[256px] border-r border-[rgba(242,236,223,0.08)] bg-[#14100c]/95 backdrop-blur-2xl flex flex-col justify-between p-5 sticky top-0 h-screen z-30 shadow-2xl">
        <div className="space-y-6">
          {/* Brand */}
          <div className="flex items-center gap-3 px-1 pt-1">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] shadow-lg shadow-[#e2a355]/20 font-bold">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <div className="font-mono text-base font-bold tracking-tight text-white flex items-center gap-1.5">
                Token<span className="text-[#e2a355]">Tracer</span>
              </div>
              <span className="text-[10px] font-bold tracking-wider text-[#e2a355] uppercase">Admin Intelligence</span>
            </div>
          </div>

          {/* Org Selector */}
          {teams.length > 0 && (
            <div className="px-1">
              <label className="block text-[10.5px] font-semibold text-[#8e8473] mb-1.5 uppercase tracking-wider">Active Workspace</label>
              <select
                value={selectedTeamId}
                onChange={(e) => setSelectedTeamId(e.target.value)}
                className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs font-medium text-white focus:outline-none focus:border-[#e2a355] transition-all cursor-pointer"
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Clean Top-Level Tab Navigation */}
          <nav className="space-y-1.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#8e8473] px-3 py-1">Console Views</div>
            
            <button
              onClick={() => setActiveTab('overview')}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                activeTab === 'overview'
                  ? 'bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-semibold border border-[rgba(226,163,85,0.3)] shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6] hover:bg-[#1c1712]'
              }`}
            >
              <BarChart3 className={`h-4 w-4 ${activeTab === 'overview' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
              <span>Overview Hub</span>
            </button>

            <button
              onClick={() => setActiveTab('daily')}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                activeTab === 'daily'
                  ? 'bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-semibold border border-[rgba(226,163,85,0.3)] shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6] hover:bg-[#1c1712]'
              }`}
            >
              <Calendar className={`h-4 w-4 ${activeTab === 'daily' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
              <div className="flex items-center justify-between w-full">
                <span>Day-wise Usage</span>
                {dailyUsageGrouping.length > 0 && (
                  <span className="text-[10px] bg-[#1c1712] text-[#8e8473] font-mono px-1.5 py-0.5 rounded-md">
                    {dailyUsageGrouping.length}d
                  </span>
                )}
              </div>
            </button>

            <button
              onClick={() => setActiveTab('developers')}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                activeTab === 'developers'
                  ? 'bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-semibold border border-[rgba(226,163,85,0.3)] shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6] hover:bg-[#1c1712]'
              }`}
            >
              <Users className={`h-4 w-4 ${activeTab === 'developers' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
              <div className="flex items-center justify-between w-full">
                <span>Developers Deep Dive</span>
                <span className="text-[10px] bg-[#1c1712] text-[#8e8473] font-mono px-1.5 py-0.5 rounded-md">
                  {developerRoster.length}
                </span>
              </div>
            </button>

            <button
              onClick={() => setActiveTab('prompts')}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                activeTab === 'prompts'
                  ? 'bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-semibold border border-[rgba(226,163,85,0.3)] shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6] hover:bg-[#1c1712]'
              }`}
            >
              <FileText className={`h-4 w-4 ${activeTab === 'prompts' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
              <div className="flex items-center justify-between w-full">
                <span>Prompts &amp; Logs</span>
                {allPrompts.length > 0 && (
                  <span className="text-[10px] bg-[#1c1712] text-[#8e8473] font-mono px-1.5 py-0.5 rounded-md">
                    {allPrompts.length}
                  </span>
                )}
              </div>
            </button>

            <button
              onClick={() => setActiveTab('daemon')}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                activeTab === 'daemon'
                  ? 'bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-semibold border border-[rgba(226,163,85,0.3)] shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6] hover:bg-[#1c1712]'
              }`}
            >
              <Radio className={`h-4 w-4 ${activeTab === 'daemon' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
              <div className="flex items-center justify-between w-full">
                <span>Daemon Fleet &amp; Sync</span>
                {outdatedDaemonCount > 0 && (
                  <span className="text-[10px] bg-amber-500/20 text-amber-400 font-mono px-1.5 py-0.5 rounded-md">
                    {outdatedDaemonCount}
                  </span>
                )}
              </div>
            </button>

            <button
              onClick={() => setActiveTab('pricing')}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                activeTab === 'pricing'
                  ? 'bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-semibold border border-[rgba(226,163,85,0.3)] shadow-sm'
                  : 'text-[#8e8473] hover:text-[#f5efe6] hover:bg-[#1c1712]'
              }`}
            >
              <DollarSign className={`h-4 w-4 ${activeTab === 'pricing' ? 'text-[#e2a355]' : 'text-[#8e8473]'}`} />
              <span>Pricing &amp; Config</span>
            </button>
          </nav>

          {/* Quick Actions */}
          <div className="pt-2 space-y-2">
            <Button
              onClick={() => setShowCreateUserModal(true)}
              className="w-full bg-gradient-to-r from-[#e2a355] to-[#f5c485] hover:brightness-110 text-[#170f05] font-bold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20 flex items-center justify-center gap-2"
            >
              <UserPlus className="h-3.5 w-3.5" />
              + Add Team Member
            </Button>
            <Button
              onClick={() => setShowInviteModal(true)}
              variant="outline"
              className="w-full bg-[#1c1712] hover:bg-[rgba(226,163,85,0.15)] text-[#f5c485] border border-[rgba(226,163,85,0.3)] text-xs font-semibold rounded-xl flex items-center justify-center gap-2"
            >
              <Terminal className="h-3.5 w-3.5 text-[#e2a355]" />
              Quick Daemon Link
            </Button>
          </div>
        </div>

        {/* Sidebar Footer */}
        <div className="pt-4 border-t border-[rgba(242,236,223,0.08)] space-y-3">
          <a
            href="/"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-[#8e8473] hover:text-[#f5efe6] hover:bg-[#1c1712] transition-colors"
          >
            <span>←</span> Switch to Personal View
          </a>
          
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)]">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(226,163,85,0.15)] text-[#f5c485] text-xs font-bold font-mono">
              {(session.displayName || 'AD').slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-[#cbbfad] truncate">
                {session.displayName || session.username}
              </div>
              <div className="text-[10px] text-[#e2a355] font-mono">Admin Role</div>
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

      {/* 2. MAIN ADMIN WORKSPACE */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Sticky Clean Header with Global Multi-Select Developer Selector and Date presets */}
        <header className="sticky top-0 z-20 border-b border-[rgba(242,236,223,0.08)] bg-[#14100c]/85 backdrop-blur-xl px-8 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold font-mono tracking-tight text-white flex items-center gap-2">
              <span>Admin</span>
              <span className="text-[#e2a355]">
                {activeTab === 'overview' && 'Overview Hub'}
                {activeTab === 'daily' && 'Day-wise Usage & Velocity'}
                {activeTab === 'developers' && 'Developer Directory'}
                {activeTab === 'prompts' && 'Prompt Inspector & Logs'}
                {activeTab === 'daemon' && 'Daemon Fleet & Sync'}
                {activeTab === 'pricing' && 'Pricing & Cost Governance'}
              </span>
            </h1>

            {/* CUSTOM POLISHED GLOBAL MULTI-SELECT DEVELOPER DROPDOWN */}
            <div className="relative" ref={devDropdownRef}>
              <button
                onClick={() => setIsDevDropdownOpen(!isDevDropdownOpen)}
                className="flex items-center gap-2.5 bg-[#1c1712] hover:bg-[#231d17] border border-[rgba(242,236,223,0.12)] hover:border-[#e2a355]/40 rounded-xl px-3 py-1.5 shadow-sm transition-all text-xs font-mono"
              >
                <div className="flex h-5 w-5 items-center justify-center rounded-md bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-bold text-[10px]">
                  {selectedGlobalMemberIds.length === 1 && selectedGlobalMemberObjs[0] ? (
                    selectedGlobalMemberObjs[0].display_name.slice(0, 2).toUpperCase()
                  ) : (
                    <Users className="h-3 w-3" />
                  )}
                </div>
                <span className="text-xs font-medium text-white max-w-[170px] truncate">
                  {selectedGlobalMemberIds.length === 0
                    ? `All Developers (${members.length})`
                    : selectedGlobalMemberIds.length === 1
                    ? selectedGlobalMemberObjs[0]?.display_name || '1 Developer'
                    : `${selectedGlobalMemberIds.length} Developers Selected`}
                </span>
                {selectedGlobalMemberIds.length > 1 && (
                  <span className="px-1.5 py-0.2 rounded-full bg-[#e2a355]/20 text-[#f5c485] text-[10px] font-bold font-mono">
                    {selectedGlobalMemberIds.length}
                  </span>
                )}
                <ChevronDown className={`h-3.5 w-3.5 text-[#8e8473] transition-transform duration-200 ${isDevDropdownOpen ? 'rotate-180 text-[#e2a355]' : ''}`} />
              </button>

              {isDevDropdownOpen && (
                <div className="absolute left-0 mt-2 w-80 rounded-2xl bg-[#14100c] border border-[rgba(242,236,223,0.12)] shadow-2xl backdrop-blur-2xl p-2 z-50 animate-fadeIn space-y-1.5">
                  <div className="p-1">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[#8e8473]" />
                      <input
                        type="text"
                        placeholder="Search developer..."
                        value={devDropdownSearch}
                        onChange={(e) => setDevDropdownSearch(e.target.value)}
                        className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.08)] rounded-xl pl-8 pr-2.5 py-1.5 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] font-mono"
                        autoFocus
                      />
                    </div>
                  </div>

                  {/* Multi-select Header Controls */}
                  <div className="flex items-center justify-between px-2 pt-0.5 text-[11px] font-mono text-[#8e8473] border-b border-[rgba(242,236,223,0.06)] pb-1.5">
                    <span>Select developers to filter:</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={selectAllGlobalMembers}
                        className="text-[#e2a355] hover:underline font-medium"
                      >
                        All
                      </button>
                      <span>•</span>
                      <button
                        onClick={() => setSelectedGlobalMemberIds([])}
                        className="text-[#8e8473] hover:text-white"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  <div className="max-h-64 overflow-y-auto space-y-1 pr-1 font-mono text-xs">
                    {/* Option for All Developers */}
                    <button
                      onClick={() => {
                        selectAllGlobalMembers();
                      }}
                      className={`w-full flex items-center justify-between p-2 rounded-xl transition-all ${
                        selectedGlobalMemberIds.length === 0
                          ? 'bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-semibold border border-[rgba(226,163,85,0.3)]'
                          : 'text-[#cbbfad] hover:bg-[#1c1712] hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#1c1712] text-[#8e8473]">
                          <Users className="h-3.5 w-3.5" />
                        </div>
                        <span>All Developers ({members.length})</span>
                      </div>
                      {selectedGlobalMemberIds.length === 0 && <CheckCircle2 className="h-3.5 w-3.5 text-[#e2a355]" />}
                    </button>

                    {/* Developer Checkbox List */}
                    {members
                      .filter((m: any) => !devDropdownSearch || m.display_name.toLowerCase().includes(devDropdownSearch.toLowerCase()))
                      .map((m: any) => {
                        const isSelected = selectedGlobalMemberIds.includes(m.id);
                        return (
                          <button
                            key={m.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleGlobalMemberId(m.id);
                            }}
                            className={`w-full flex items-center justify-between p-2 rounded-xl transition-all ${
                              isSelected
                                ? 'bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-semibold border border-[rgba(226,163,85,0.3)]'
                                : 'text-[#cbbfad] hover:bg-[#1c1712] hover:text-white'
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition-all ${
                                isSelected 
                                  ? 'bg-[#e2a355] border-[#e2a355] text-[#14100c]' 
                                  : 'border-[rgba(242,236,223,0.2)] bg-[#1c1712]'
                              }`}>
                                {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                              </div>
                              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-[10px]">
                                {m.display_name.slice(0, 2).toUpperCase()}
                              </div>
                              <div className="text-left truncate">
                                <div className="truncate font-medium">{m.display_name}</div>
                                <div className="text-[10px] text-[#8e8473]">{m.role || 'Member'}</div>
                              </div>
                            </div>
                            {isSelected && <span className="text-[10px] text-[#e2a355] font-mono shrink-0">Selected</span>}
                          </button>
                        );
                      })}
                  </div>

                  <div className="pt-1.5 border-t border-[rgba(242,236,223,0.06)] flex justify-end">
                    <button
                      onClick={() => setIsDevDropdownOpen(false)}
                      className="px-3 py-1 bg-[#1c1712] hover:bg-[rgba(226,163,85,0.2)] hover:text-[#f5c485] border border-[rgba(242,236,223,0.1)] rounded-lg text-xs font-mono text-white transition-all"
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* Time range presets */}
            <div className="flex bg-[#1c1712] p-1 rounded-xl border border-[rgba(242,236,223,0.08)] items-center">
              {(activeTab === 'daily' 
                ? (['7d', '14d', '30d', 'all'] as const)
                : (['today', '7d', '30d', 'all'] as const)
              ).map((r) => (
                <button
                  key={r}
                  onClick={() => setTimeRange(r)}
                  className={`px-3 py-1 text-xs font-medium rounded-lg transition-all ${
                    timeRange === r 
                      ? 'bg-[rgba(226,163,85,0.2)] text-[#f5c485] font-semibold' 
                      : 'text-[#8e8473] hover:text-[#f5efe6]'
                  }`}
                >
                  {r === 'today' ? 'Today' : r === '7d' ? 'Last 7 Days' : r === '14d' ? '14 Days' : r === '30d' ? '30 Days' : 'All Time'}
                </button>
              ))}

              {/* Custom Date Range Trigger */}
              <button
                onClick={() => setShowCustomDatePicker(true)}
                className={`px-3 py-1 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
                  timeRange === 'custom'
                    ? 'bg-[rgba(226,163,85,0.2)] text-[#f5c485] font-semibold'
                    : 'text-[#8e8473] hover:text-[#f5efe6]'
                }`}
              >
                <Calendar className="h-3 w-3" />
                <span>{timeRange === 'custom' ? `${customFrom} → ${customTo}` : 'Custom'}</span>
              </button>
            </div>

            <Button
              size="sm"
              onClick={() => setShowCreateUserModal(true)}
              className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] hover:brightness-110 text-[#170f05] font-bold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20 flex items-center gap-1.5"
            >
              <UserPlus className="h-3.5 w-3.5" />
              + Add Member
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchTeamData()}
              className="text-xs border-[rgba(242,236,223,0.1)] text-[#8e8473] hover:text-white"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
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

        <div className="p-8 space-y-8 max-w-[1700px] w-full mx-auto">
          {/* Active Global Developer Filter Notification Banner */}
          {selectedGlobalMemberIds.length > 0 && (
            <div className="p-4 rounded-2xl bg-[rgba(226,163,85,0.1)] border border-[rgba(226,163,85,0.25)] flex items-center justify-between flex-wrap gap-3 shadow-lg animate-fadeIn">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs font-mono">
                    {selectedGlobalMemberIds.length}
                  </div>
                  <span className="text-xs font-bold text-white font-mono">
                    Filtered to {selectedGlobalMemberIds.length} Developer{selectedGlobalMemberIds.length > 1 ? 's' : ''}:
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {selectedGlobalMemberObjs.map((m: any) => (
                    <span 
                      key={m.id} 
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#1c1712] border border-[rgba(226,163,85,0.3)] text-xs font-mono text-[#f5c485]"
                    >
                      <span>{m.display_name}</span>
                      <button 
                        onClick={() => toggleGlobalMemberId(m.id)}
                        className="text-[#8e8473] hover:text-red-400 text-xs ml-0.5"
                        title="Remove developer from filter"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={selectAllGlobalMembers}
                  className="h-7 text-xs border-[rgba(226,163,85,0.3)] text-[#f5c485] hover:bg-[rgba(226,163,85,0.15)] font-mono"
                >
                  ✕ Show All Team Members
                </Button>
              </div>
            </div>
          )}
          {activeTab === 'overview' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Top 4 Spacious KPI Metric Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                {/* 1. Total Token Burn */}
                <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl relative overflow-hidden group">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider">Total Token Burn</div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-bold font-mono text-white">{formatCompactNumber(totalTokens)}</span>
                    <span className="text-xs font-semibold text-emerald-400 font-mono">Live DB</span>
                  </div>
                  {/* Glowing Copper Sparkline */}
                  <div className="mt-4 h-9 w-full flex items-end">
                    <svg className="w-full h-8 overflow-visible" viewBox="0 0 100 24" preserveAspectRatio="none">
                      <path d="M0,20 Q15,5 30,16 T60,8 T90,14 T100,4" fill="none" stroke="#e2a355" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  </div>
                </div>

                {/* 2. AI Spend */}
                <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider">AI Cost / Spend</div>
                  <div className="mt-2 text-3xl font-bold font-mono text-[#f5c485]">
                    {formatCurrency(totalCost)}
                  </div>
                  <div className="mt-4 h-9 w-full flex items-end">
                    <svg className="w-full h-8 overflow-visible" viewBox="0 0 100 24" preserveAspectRatio="none">
                      <path d="M0,18 Q20,12 40,16 T70,6 T100,10" fill="none" stroke="#f5c485" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  </div>
                </div>

                {/* 3. Active Developers */}
                <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider">Active Developers</div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-bold font-mono text-white">
                      {selectedGlobalMemberIds.length === 0 ? developerRoster.length : selectedGlobalMemberIds.length}
                    </span>
                    <span className="text-xs text-emerald-400 font-mono">selected</span>
                  </div>
                  <div className="mt-4 h-9 w-full flex items-end">
                    <svg className="w-full h-8 overflow-visible" viewBox="0 0 100 24" preserveAspectRatio="none">
                      <path d="M0,15 Q25,8 50,14 T75,4 T100,12" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  </div>
                </div>

                {/* 4. Tool Error Rate */}
                <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider">Tool Error Rate</div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-bold font-mono text-white">{toolErrorRate}%</span>
                    <span className="text-xs text-emerald-400 font-mono">{Number(toolErrorRate) < 5 ? 'Nominal' : 'Alert'}</span>
                  </div>
                  <div className="mt-4 h-9 w-full flex items-end">
                    <svg className="w-full h-8 overflow-visible" viewBox="0 0 100 24" preserveAspectRatio="none">
                      <path d="M0,8 Q25,16 50,12 T75,20 T100,10" fill="none" stroke="#e2a355" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  </div>
                </div>
              </div>

              {/* ⚠️ AT-RISK MEMBERS (Overview Hub Callout) */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-mono font-bold text-sm tracking-wide text-white">
                    <span className="text-amber-400">⚠️</span>
                    <span className="text-[#f5efe6]">AT-RISK MEMBERS</span>
                    {stats?.atRisk && stats.atRisk.length > 0 && (
                      <span className="ml-2 text-[10px] bg-amber-500/20 text-amber-300 font-mono px-2 py-0.5 rounded-md">
                        {stats.atRisk.length} flagged
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] font-mono text-[#8e8473]">
                    Telemetry anomalies vs. team average
                  </span>
                </div>

                {stats?.atRisk && stats.atRisk.length > 0 ? (
                  <div className="space-y-4 pt-1">
                    {stats.atRisk.map((m: any, idx: number) => (
                      <div 
                        key={m.member_id || idx} 
                        className={`space-y-1.5 ${idx > 0 ? 'pt-4 border-t border-[rgba(242,236,223,0.06)]' : ''}`}
                      >
                        <div className="font-mono text-xs">
                          <span className="font-bold text-white">{m.display_name}</span>{' '}
                          <span className="text-[#8e8473]">({m.sessions} {m.sessions === 1 ? 'session' : 'sessions'})</span>
                        </div>
                        <div className="space-y-1 pl-3 font-mono text-xs text-[#cbbfad]">
                          {m.reasons.map((r: string, rIdx: number) => (
                            <div key={rIdx} className="flex items-start gap-2">
                              <span className="text-[#8e8473]">•</span>
                              <span>{r}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-2 text-xs font-mono text-[#8e8473]">
                    No at-risk behavior detected across team members for this time window.
                  </div>
                )}
              </div>

              {/* Main Body Grid: Developer Token Usage (Left 60%) & Project Distribution (Right 40%) */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Left (7/12 - 58%): Developer Token Usage Ranking */}
                <div className="lg:col-span-7 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-bold font-mono text-white flex items-center gap-2">
                        <Users className="h-4 w-4 text-[#e2a355]" />
                        <span>Developer Token Usage</span>
                      </h3>
                      <p className="text-xs text-[#8e8473]">
                        Ranked by token consumption for {timeRange === 'today' ? 'Today' : timeRange === '7d' ? 'Last 7 Days' : timeRange === '30d' ? '30 Days' : 'All Time'} (Descending)
                      </p>
                    </div>
                    <span className="text-xs font-mono text-[#8e8473] bg-[#1c1712] px-2.5 py-1 rounded-lg border border-[rgba(242,236,223,0.06)]">
                      {developerRoster.length} {developerRoster.length === 1 ? 'Engineer' : 'Engineers'}
                    </span>
                  </div>

                  <div className="space-y-3.5 pt-1 max-h-[580px] overflow-y-auto pr-1">
                    {developerRoster.length > 0 ? (
                      [...developerRoster]
                        .sort((a, b) => b.totalTokens - a.totalTokens)
                        .map((dev: any, index: number) => {
                          const maxTok = Math.max(...developerRoster.map((d: any) => d.totalTokens), 1);
                          const barPct = Math.max(3, Math.round((dev.totalTokens / maxTok) * 100));
                          const isTop3 = index < 3;

                          return (
                            <div 
                              key={dev.id}
                              onClick={() => {
                                setSelectedMember(dev);
                                setActiveTab('developers');
                              }}
                              className="p-4 rounded-xl bg-[#1c1712]/70 border border-[rgba(242,236,223,0.06)] hover:border-[#e2a355]/40 hover:bg-[#1c1712] transition-all cursor-pointer group"
                            >
                              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                                <div className="flex items-center gap-3">
                                  {/* Rank Number */}
                                  <div className={`flex h-6 w-6 items-center justify-center rounded-lg text-xs font-mono font-bold ${
                                    index === 0
                                      ? 'bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] shadow-md shadow-[#e2a355]/30'
                                      : index === 1
                                      ? 'bg-slate-300 text-slate-900'
                                      : index === 2
                                      ? 'bg-amber-700/80 text-amber-100'
                                      : 'bg-[#14100c] text-[#8e8473] border border-[rgba(242,236,223,0.08)]'
                                  }`}>
                                    {index + 1}
                                  </div>

                                  {/* Avatar & Name */}
                                  <div className="flex items-center gap-2.5">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[rgba(226,163,85,0.12)] text-[#f5c485] font-bold text-xs font-mono border border-[rgba(226,163,85,0.2)]">
                                      {dev.displayName.slice(0, 2).toUpperCase()}
                                    </div>
                                    <div>
                                      <div className="font-semibold text-white text-sm flex items-center gap-1.5 group-hover:text-[#f5c485] transition-colors">
                                        <span>{dev.displayName}</span>
                                        <span className="text-[11px] font-mono text-[#8e8473] font-normal">{dev.handle}</span>
                                      </div>
                                      <div className="text-[10.5px] text-[#8e8473] font-mono">
                                        Repo: <span className="text-[#cbbfad]">{dev.topProject}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                <div className="flex items-center gap-4 font-mono text-right">
                                  <div>
                                    <div className="text-sm font-bold text-white flex items-center justify-end gap-1.5">
                                      <span>{formatCompactNumber(dev.totalTokens)}</span>
                                      <span className="text-[11px] font-normal text-[#8e8473]">tokens</span>
                                    </div>
                                    <div className="text-[11px] font-semibold text-[#f5c485]">
                                      {formatCurrency(dev.apiCost)}
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Visual Progress Bar */}
                              <div className="h-2 w-full rounded-full bg-[#0d0a07] overflow-hidden mt-1">
                                <div 
                                  className={`h-full rounded-full transition-all duration-500 ${
                                    isTop3
                                      ? 'bg-gradient-to-r from-[#e2a355] via-[#f5c485] to-[#e2a355]'
                                      : 'bg-gradient-to-r from-[#8e8473] to-[#cbbfad]'
                                  }`} 
                                  style={{ width: `${barPct}%` }} 
                                />
                              </div>
                            </div>
                          );
                        })
                    ) : (
                      <div className="p-8 text-center text-xs font-mono text-[#8e8473] bg-[#1c1712]/40 rounded-xl border border-dashed border-[rgba(242,236,223,0.1)]">
                        No developer telemetry recorded for this timeframe.
                      </div>
                    )}
                  </div>
                </div>

                {/* Right (5/12 - 42%): Project Token Distribution */}
                <div className="lg:col-span-5 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 flex flex-col justify-between space-y-6">
                  <div>
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-bold font-mono text-white flex items-center gap-2">
                        <Folder className="h-4 w-4 text-[#e2a355]" />
                        <span>Project Token Distribution</span>
                      </h3>
                      <span className="text-xs font-mono text-[#8e8473]">
                        {projectList.length} {projectList.length === 1 ? 'Repo' : 'Repos'}
                      </span>
                    </div>
                    <p className="text-xs text-[#8e8473] mt-1">
                      Token consumption across repositories from sync sessions
                    </p>
                  </div>

                  <div className="space-y-3.5 pt-1 max-h-[520px] overflow-y-auto pr-1">
                    {projectList.length > 0 ? (
                      projectList.map((repo: any) => (
                        <div key={repo.name} className="p-3.5 rounded-xl bg-[#1c1712]/70 border border-[rgba(242,236,223,0.06)] hover:border-[#e2a355]/40 transition-all">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <Folder className="h-3.5 w-3.5 text-[#e2a355] shrink-0" />
                              <span className="font-mono text-xs font-semibold text-white truncate">{repo.name}</span>
                            </div>
                            <div className="flex items-center gap-2.5 font-mono text-xs shrink-0">
                              <span className="text-[#f5c485] font-semibold">{repo.cost}</span>
                              <span className="text-[#8e8473]">{formatCompactNumber(repo.tokens)} tok</span>
                            </div>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-[#0d0a07] overflow-hidden">
                            <div 
                              className="h-full bg-gradient-to-r from-[#e2a355] to-[#f5c485] rounded-full transition-all duration-500" 
                              style={{ width: `${repo.pct}%` }} 
                            />
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="p-8 text-center text-xs font-mono text-[#8e8473] bg-[#1c1712]/40 rounded-xl border border-dashed border-[rgba(242,236,223,0.1)]">
                        No projects recorded for this time window.
                      </div>
                    )}
                  </div>

                  <div className="p-3 rounded-xl bg-[rgba(226,163,85,0.08)] border border-[rgba(226,163,85,0.2)] text-xs font-mono text-[#cbbfad]">
                    💡 Click any developer on the left to drill into their specific commit logs and prompt trajectory.
                  </div>
                </div>
              </div>

              {/* Bottom Section: Recent High-Impact Sessions */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold font-mono text-white">Recent Activity &amp; Prompt Trajectories</h3>
                  <button 
                    onClick={() => setActiveTab('prompts')}
                    className="text-xs font-mono text-[#e2a355] hover:underline flex items-center gap-1"
                  >
                    View All Prompts ({allPrompts.length}) <ArrowUpRight className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-[rgba(242,236,223,0.08)] text-[#8e8473] uppercase font-mono">
                        <th className="py-3 px-3">Developer</th>
                        <th className="py-3 px-3">Project / Prompt</th>
                        <th className="py-3 px-3">Model</th>
                        <th className="py-3 px-3">Tokens</th>
                        <th className="py-3 px-3">Cost</th>
                        <th className="py-3 px-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(242,236,223,0.05)] font-mono">
                      {allPrompts.length > 0 ? (
                        allPrompts.slice(0, 5).map((p: any, i: number) => (
                          <tr key={i} className="hover:bg-[rgba(226,163,85,0.04)] transition-all">
                            <td className="py-3 px-3 font-semibold text-white">{p.developerName}</td>
                            <td className="py-3 px-3 text-[#cbbfad] truncate max-w-xs">{p.text}</td>
                            <td className="py-3 px-3"><span className="text-[#e2a355] bg-[#e2a355]/10 px-2 py-0.5 rounded-md">{p.model}</span></td>
                            <td className="py-3 px-3 text-[#cbbfad]">{formatCompactNumber(p.tokens)}</td>
                            <td className="py-3 px-3 text-[#f5c485] font-semibold">{formatCurrency(p.cost)}</td>
                            <td className="py-3 px-3 text-right">
                              <button
                                onClick={() => setInspectingPrompt(p)}
                                className="text-xs text-[#e2a355] hover:underline flex items-center gap-1 justify-end ml-auto"
                              >
                                Inspect ↗
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-[#8e8473]">
                            No activity logged in database for this time window.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 2: DAY-WISE USAGE & VELOCITY
             ========================================================================= */}
          {activeTab === 'daily' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Top 4 Range Metric Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                {/* 1. Total Range Tokens */}
                <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl relative overflow-hidden group">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider flex items-center justify-between">
                    <span>Range Token Burn</span>
                    <Calendar className="h-4 w-4 text-[#e2a355]" />
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-bold font-mono text-white">{formatCompactNumber(totalTokens)}</span>
                    <span className="text-xs font-semibold text-emerald-400 font-mono">
                      {dailyUsageGrouping.length} days active
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-[#8e8473] font-mono">
                    Timeframe: <strong className="text-[#cbbfad]">{timeRange === '7d' ? 'Last 7 Days' : timeRange === '14d' ? 'Last 14 Days' : timeRange === '30d' ? '30 Days' : timeRange === 'custom' ? `${customFrom} to ${customTo}` : 'All Time'}</strong>
                  </div>
                </div>

                {/* 2. Daily Average */}
                <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider flex items-center justify-between">
                    <span>Daily Average Burn</span>
                    <TrendingUp className="h-4 w-4 text-[#f5c485]" />
                  </div>
                  <div className="mt-2 text-3xl font-bold font-mono text-[#f5c485]">
                    {dailyUsageGrouping.length > 0 
                      ? formatCompactNumber(Math.round(totalTokens / dailyUsageGrouping.length)) 
                      : '0'} <span className="text-sm font-normal text-[#8e8473]">/ day</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[#8e8473] font-mono">
                    Avg Spend: <strong className="text-white">{formatCurrency(dailyUsageGrouping.length > 0 ? totalCost / dailyUsageGrouping.length : 0)} / day</strong>
                  </div>
                </div>

                {/* 3. Peak Day Spike */}
                <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider flex items-center justify-between">
                    <span>Peak Day Spike</span>
                    <Zap className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div className="mt-2 text-2xl font-bold font-mono text-white truncate">
                    {stats?.activity?.busiestDay 
                      ? `${formatCompactNumber(Number(stats.activity.busiestDay.tokensIn) + Number(stats.activity.busiestDay.tokensOut))} tok`
                      : 'None'}
                  </div>
                  <div className="mt-1 text-[11px] text-emerald-400 font-mono">
                    {stats?.activity?.busiestDay?.date || 'No peak recorded'} ({stats?.activity?.busiestDay?.sessions || 0} sessions)
                  </div>
                </div>

                {/* 4. Active Engineers in Range */}
                <div className="rounded-2xl bg-[#14100c]/90 p-6 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl relative overflow-hidden">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider flex items-center justify-between">
                    <span>Active Engineers</span>
                    <Users className="h-4 w-4 text-[#e2a355]" />
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-bold font-mono text-white">
                      {selectedGlobalMemberIds.length === 0 ? developerRoster.length : selectedGlobalMemberIds.length}
                    </span>
                    <span className="text-xs text-emerald-400 font-mono">in range</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[#8e8473] font-mono">
                    Total AI Spend: <strong className="text-[#f5c485]">{formatCurrency(totalCost)}</strong>
                  </div>
                </div>
              </div>

              {/* Interactive Time Series Graph with Multi-Developer Colored Curves */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-7 space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div>
                    <h3 className="text-base font-bold font-mono text-white flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-[#e2a355]" />
                      <span>Daily Telemetry Velocity — Multi-Developer Time Series</span>
                    </h3>
                    <p className="text-xs text-[#8e8473]">
                      Chronological day-over-day trajectory across {dailyUsageGrouping.length} active recorded {dailyUsageGrouping.length === 1 ? 'day' : 'days'}
                    </p>
                  </div>

                  {/* Metric Switcher Pills */}
                  <div className="flex items-center gap-1.5 p-1 bg-[#1c1712] rounded-xl border border-[rgba(242,236,223,0.08)] font-mono text-xs">
                    <button
                      onClick={() => setDailyChartMetric('tokens')}
                      className={`px-3 py-1 rounded-lg transition-all ${
                        dailyChartMetric === 'tokens'
                          ? 'bg-[rgba(226,163,85,0.2)] text-[#f5c485] font-semibold shadow-sm'
                          : 'text-[#8e8473] hover:text-white'
                      }`}
                    >
                      Token Burn
                    </button>
                    <button
                      onClick={() => setDailyChartMetric('cost')}
                      className={`px-3 py-1 rounded-lg transition-all ${
                        dailyChartMetric === 'cost'
                          ? 'bg-[rgba(226,163,85,0.2)] text-[#f5c485] font-semibold shadow-sm'
                          : 'text-[#8e8473] hover:text-white'
                      }`}
                    >
                      AI Spend ($)
                    </button>
                    <button
                      onClick={() => setDailyChartMetric('sessions')}
                      className={`px-3 py-1 rounded-lg transition-all ${
                        dailyChartMetric === 'sessions'
                          ? 'bg-[rgba(226,163,85,0.2)] text-[#f5c485] font-semibold shadow-sm'
                          : 'text-[#8e8473] hover:text-white'
                      }`}
                    >
                      Sessions
                    </button>
                  </div>
                </div>

                {dailyUsageGrouping.length > 0 ? (
                  (() => {
                    const DEV_PALETTE = [
                      { stroke: '#e2a355', fill: 'rgba(226,163,85,0.12)', name: 'Copper' },
                      { stroke: '#38bdf8', fill: 'rgba(56,189,248,0.12)', name: 'Sky Blue' },
                      { stroke: '#34d399', fill: 'rgba(52,211,153,0.12)', name: 'Emerald' },
                      { stroke: '#c084fc', fill: 'rgba(192,132,252,0.12)', name: 'Purple' },
                      { stroke: '#f87171', fill: 'rgba(248,113,113,0.12)', name: 'Coral' },
                      { stroke: '#fbbf24', fill: 'rgba(251,191,36,0.12)', name: 'Amber' },
                      { stroke: '#818cf8', fill: 'rgba(129,140,248,0.12)', name: 'Indigo' },
                      { stroke: '#f472b6', fill: 'rgba(244,114,182,0.12)', name: 'Pink' },
                    ];

                    // Sort chronologically (left to right = oldest to newest)
                    const chronoData = [...dailyUsageGrouping].sort((a, b) => a.date.localeCompare(b.date));
                    
                    // Collect all active developers across the entire dataset
                    const devMap = new Map<string, { id: string; name: string; totalTokens: number; totalCost: number; totalSessions: number }>();
                    chronoData.forEach((d) => {
                      (d.developers || []).forEach((dev: any) => {
                        const cur = devMap.get(dev.id) || { id: dev.id, name: dev.displayName, totalTokens: 0, totalCost: 0, totalSessions: 0 };
                        cur.totalTokens += Number(dev.tokens || 0);
                        cur.totalCost += Number(dev.apiCost || 0);
                        cur.totalSessions += Number(dev.sessions || 0);
                        devMap.set(dev.id, cur);
                      });
                    });
                    developerRoster.forEach((d) => {
                      if (!devMap.has(d.id)) {
                        devMap.set(d.id, {
                          id: d.id,
                          name: d.displayName,
                          totalTokens: d.totalTokens,
                          totalCost: d.apiCost,
                          totalSessions: d.sessionsCount
                        });
                      }
                    });
                    const allAvailableDailyDevs = Array.from(devMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);

                    // Effective developers to compare:
                    // 1. If dailySelectedMemberIds is set locally on this page -> use dailySelectedMemberIds
                    // 2. Otherwise if selectedGlobalMemberIds is set globally -> use selectedGlobalMemberIds
                    // 3. Otherwise -> compare all available active developers
                    const effectiveDailyDevIds = dailySelectedMemberIds.length > 0 
                      ? dailySelectedMemberIds 
                      : selectedGlobalMemberIds;

                    // Identify compared developers
                    let comparedDevs: { id: string; name: string; color: typeof DEV_PALETTE[0]; totalTokens: number; totalCost: number; totalSessions: number }[] = [];

                    if (effectiveDailyDevIds.length > 0) {
                      comparedDevs = effectiveDailyDevIds.map((id, idx) => {
                        const mem = members.find((m: any) => m.id === id) || allAvailableDailyDevs.find((m) => m.id === id);
                        const devName = mem?.display_name || mem?.name || 'Developer';
                        let devTok = 0;
                        let devCost = 0;
                        let devSess = 0;
                        chronoData.forEach((d) => {
                          const match = (d.developers || []).find((x: any) => x.id === id);
                          if (match) {
                            devTok += Number(match.tokens || 0);
                            devCost += Number(match.apiCost || 0);
                            devSess += Number(match.sessions || 0);
                          }
                        });
                        return {
                          id,
                          name: devName,
                          color: DEV_PALETTE[idx % DEV_PALETTE.length],
                          totalTokens: devTok,
                          totalCost: devCost,
                          totalSessions: devSess
                        };
                      });
                    } else {
                      comparedDevs = allAvailableDailyDevs.slice(0, 8).map((d, idx) => ({
                        ...d,
                        color: DEV_PALETTE[idx % DEV_PALETTE.length]
                      }));
                    }

                    const isMultiDevComparison = comparedDevs.length > 1;

                    const getDevMetricVal = (day: any, devId: string) => {
                      const devRec = (day.developers || []).find((x: any) => x.id === devId);
                      if (!devRec) return 0;
                      if (dailyChartMetric === 'cost') return Number(devRec.apiCost || 0);
                      if (dailyChartMetric === 'sessions') return Number(devRec.sessions || 0);
                      return Number(devRec.tokens || 0);
                    };

                    const getDayMetricVal = (d: any) => {
                      if (dailyChartMetric === 'cost') return Number(d.apiCost || 0);
                      if (dailyChartMetric === 'sessions') return Number(d.sessions || 0);
                      return Number(d.totalTokens || 0);
                    };

                    // Compute max value across active points
                    let maxVal = 1;
                    if (isMultiDevComparison) {
                      const allVals: number[] = [];
                      chronoData.forEach((d) => {
                        comparedDevs.forEach((dev) => {
                          allVals.push(getDevMetricVal(d, dev.id));
                        });
                      });
                      maxVal = Math.max(...allVals, 1);
                    } else {
                      maxVal = Math.max(...chronoData.map(getDayMetricVal), 1);
                    }

                    const width = 1000;
                    const height = 250;
                    const padTop = 20;
                    const padBottom = 35;
                    const padLeft = 60;
                    const padRight = 30;
                    const innerW = width - padLeft - padRight;
                    const innerH = height - padTop - padBottom;

                    // Build series per developer
                    const devSeriesList = comparedDevs.map((dev) => {
                      const points = chronoData.map((d, i) => {
                        const val = getDevMetricVal(d, dev.id);
                        const x = chronoData.length === 1 
                          ? padLeft + innerW / 2 
                          : padLeft + (i * innerW) / (chronoData.length - 1);
                        const y = padTop + innerH - (val / maxVal) * innerH;
                        const rawDev = (d.developers || []).find((x: any) => x.id === dev.id);
                        return { x, y, val, date: d.date, rawDev, index: i };
                      });

                      let linePath = `M ${points[0].x} ${points[0].y}`;
                      if (points.length === 1) {
                        linePath = `M ${points[0].x - 40} ${points[0].y} L ${points[0].x + 40} ${points[0].y}`;
                      } else {
                        for (let i = 0; i < points.length - 1; i++) {
                          const p0 = points[i];
                          const p1 = points[i + 1];
                          const cx1 = p0.x + (p1.x - p0.x) / 2;
                          const cy1 = p0.y;
                          const cx2 = p0.x + (p1.x - p0.x) / 2;
                          const cy2 = p1.y;
                          linePath += ` C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p1.x} ${p1.y}`;
                        }
                      }

                      const lastPt = points[points.length - 1];
                      const firstPt = points[0];
                      const areaPath = points.length === 1
                        ? `M ${firstPt.x - 40} ${firstPt.y} L ${firstPt.x + 40} ${lastPt.y} L ${firstPt.x + 40} ${padTop + innerH} L ${firstPt.x - 40} ${padTop + innerH} Z`
                        : `${linePath} L ${lastPt.x} ${padTop + innerH} L ${firstPt.x} ${padTop + innerH} Z`;

                      return {
                        dev,
                        points,
                        linePath,
                        areaPath
                      };
                    });

                    // Aggregate Team Points (used if single dev or team total)
                    const teamPoints = chronoData.map((d, i) => {
                      const x = chronoData.length === 1 
                        ? padLeft + innerW / 2 
                        : padLeft + (i * innerW) / (chronoData.length - 1);
                      const val = getDayMetricVal(d);
                      const y = padTop + innerH - (val / maxVal) * innerH;
                      return { x, y, val, data: d, index: i };
                    });

                    let teamLinePath = `M ${teamPoints[0].x} ${teamPoints[0].y}`;
                    if (teamPoints.length === 1) {
                      teamLinePath = `M ${teamPoints[0].x - 40} ${teamPoints[0].y} L ${teamPoints[0].x + 40} ${teamPoints[0].y}`;
                    } else {
                      for (let i = 0; i < teamPoints.length - 1; i++) {
                        const p0 = teamPoints[i];
                        const p1 = teamPoints[i + 1];
                        const cx1 = p0.x + (p1.x - p0.x) / 2;
                        const cy1 = p0.y;
                        const cx2 = p0.x + (p1.x - p0.x) / 2;
                        const cy2 = p1.y;
                        teamLinePath += ` C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p1.x} ${p1.y}`;
                      }
                    }

                    const lastTeamPt = teamPoints[teamPoints.length - 1];
                    const firstTeamPt = teamPoints[0];
                    const teamAreaPath = teamPoints.length === 1
                      ? `M ${firstTeamPt.x - 40} ${firstTeamPt.y} L ${firstTeamPt.x + 40} ${lastTeamPt.y} L ${firstTeamPt.x + 40} ${padTop + innerH} L ${firstTeamPt.x - 40} ${padTop + innerH} Z`
                      : `${teamLinePath} L ${lastTeamPt.x} ${padTop + innerH} L ${firstTeamPt.x} ${padTop + innerH} Z`;

                    const activeHoverDay = hoveredDailyIndex !== null ? chronoData[hoveredDailyIndex] : null;
                    const activeHoverX = hoveredDailyIndex !== null 
                      ? (chronoData.length === 1 ? padLeft + innerW / 2 : padLeft + (hoveredDailyIndex * innerW) / (chronoData.length - 1))
                      : null;

                    return (
                      <div className="space-y-4">
                        {/* Interactive Developer Selection Bar for Day-Wise Analysis */}
                        <div className="p-4 rounded-xl bg-[#14100c] border border-[rgba(242,236,223,0.06)] space-y-3">
                          <div className="flex items-center justify-between flex-wrap gap-2.5">
                            <div className="flex items-center gap-2">
                              <Users className="h-4 w-4 text-[#e2a355]" />
                              <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                                Developer Comparison Filter
                              </span>
                              {dailySelectedMemberIds.length > 0 ? (
                                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-mono font-semibold bg-[#e2a355]/20 text-[#f5c485] border border-[#e2a355]/30">
                                  {dailySelectedMemberIds.length} selected
                                </span>
                              ) : selectedGlobalMemberIds.length > 0 ? (
                                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-mono text-[#8e8473] bg-[#1c1712] border border-[rgba(242,236,223,0.08)]">
                                  Using global filter ({selectedGlobalMemberIds.length})
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full text-[10.5px] font-mono text-[#8e8473] bg-[#1c1712] border border-[rgba(242,236,223,0.08)]">
                                  Comparing all active ({allAvailableDailyDevs.length})
                                </span>
                              )}
                            </div>

                            {/* Quick Presets */}
                            <div className="flex items-center gap-1.5 text-xs font-mono">
                              <button
                                type="button"
                                onClick={() => selectAllDailyMembers(allAvailableDailyDevs.map(d => d.id))}
                                className="px-2.5 py-1 rounded-lg bg-[#1c1712] hover:bg-[#251e18] text-[#cbbfad] hover:text-white border border-[rgba(242,236,223,0.08)] transition-all text-[11px]"
                              >
                                Select All
                              </button>
                              <button
                                type="button"
                                onClick={() => selectAllDailyMembers(allAvailableDailyDevs.slice(0, 3).map(d => d.id))}
                                className="px-2.5 py-1 rounded-lg bg-[#1c1712] hover:bg-[#251e18] text-[#cbbfad] hover:text-white border border-[rgba(242,236,223,0.08)] transition-all text-[11px]"
                              >
                                Top 3
                              </button>
                              <button
                                type="button"
                                onClick={() => selectAllDailyMembers(allAvailableDailyDevs.slice(0, 5).map(d => d.id))}
                                className="px-2.5 py-1 rounded-lg bg-[#1c1712] hover:bg-[#251e18] text-[#cbbfad] hover:text-white border border-[rgba(242,236,223,0.08)] transition-all text-[11px]"
                              >
                                Top 5
                              </button>
                              {dailySelectedMemberIds.length > 0 && (
                                <button
                                  type="button"
                                  onClick={clearDailyMembers}
                                  className="px-2.5 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-all flex items-center gap-1 text-[11px]"
                                >
                                  <RotateCcw className="h-3 w-3" /> Reset
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Developer Multi-Select Toggle Chips */}
                          <div className="flex items-center gap-2 flex-wrap pt-0.5">
                            {allAvailableDailyDevs.map((dev, idx) => {
                              const isSelected = effectiveDailyDevIds.includes(dev.id);
                              const assignedColor = DEV_PALETTE[idx % DEV_PALETTE.length];

                              return (
                                <button
                                  key={dev.id}
                                  type="button"
                                  onClick={() => toggleDailyMember(dev.id)}
                                  className={`flex items-center gap-2 px-3 py-1.5 rounded-xl font-mono text-xs transition-all border select-none cursor-pointer ${
                                    isSelected
                                      ? 'bg-[#1c1712] text-white shadow-md'
                                      : 'bg-[#14100c]/60 border-[rgba(242,236,223,0.06)] text-[#8e8473] hover:text-[#cbbfad] hover:border-[rgba(242,236,223,0.15)] opacity-60'
                                  }`}
                                  style={{
                                    borderColor: isSelected ? assignedColor.stroke : undefined,
                                    boxShadow: isSelected ? `0 0 10px ${assignedColor.stroke}25` : undefined
                                  }}
                                >
                                  <span
                                    className={`w-2.5 h-2.5 rounded-full shrink-0 transition-transform ${isSelected ? 'scale-110 ring-2 ring-white/20' : 'opacity-40'}`}
                                    style={{ backgroundColor: assignedColor.stroke }}
                                  />
                                  <span className="font-semibold">{dev.name}</span>
                                  <span className={`text-[10.5px] ${isSelected ? 'text-[#f5c485]' : 'text-[#8e8473]'}`}>
                                    {dailyChartMetric === 'cost'
                                      ? formatCurrency(dev.totalCost)
                                      : dailyChartMetric === 'sessions'
                                      ? `${dev.totalSessions}s`
                                      : `${formatCompactNumber(dev.totalTokens)} tok`}
                                  </span>
                                  {isSelected && (
                                    <span className="text-[10.5px] text-emerald-400 font-bold ml-0.5">✓</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* Interactive SVG Chart Canvas */}
                        <div className="relative w-full h-[270px] bg-[#0d0a07] border border-[rgba(242,236,223,0.06)] rounded-2xl p-2 overflow-hidden shadow-inner">
                          <svg
                            viewBox={`0 0 ${width} ${height}`}
                            className="w-full h-full overflow-visible"
                            preserveAspectRatio="none"
                          >
                            <defs>
                              <linearGradient id="singleDevGlow" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#e2a355" stopOpacity="0.45" />
                                <stop offset="50%" stopColor="#e2a355" stopOpacity="0.12" />
                                <stop offset="100%" stopColor="#e2a355" stopOpacity="0.0" />
                              </linearGradient>
                              <filter id="nodeGlow" x="-50%" y="-50%" width="200%" height="200%">
                                <feGaussianBlur stdDeviation="3" result="blur" />
                                <feMerge>
                                  <feMergeNode in="blur" />
                                  <feMergeNode in="SourceGraphic" />
                                </feMerge>
                              </filter>
                            </defs>

                            {/* Horizontal Reference Gridlines */}
                            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                              const yPos = padTop + innerH - ratio * innerH;
                              const refVal = maxVal * ratio;
                              const label = dailyChartMetric === 'cost'
                                ? formatCurrency(refVal)
                                : dailyChartMetric === 'sessions'
                                ? Math.round(refVal).toString()
                                : formatCompactNumber(refVal);

                              return (
                                <g key={ratio}>
                                  <line
                                    x1={padLeft}
                                    y1={yPos}
                                    x2={width - padRight}
                                    y2={yPos}
                                    stroke="rgba(242,236,223,0.06)"
                                    strokeDasharray="4 4"
                                    strokeWidth="1"
                                  />
                                  <text
                                    x={padLeft - 8}
                                    y={yPos + 3}
                                    textAnchor="end"
                                    fill="#8e8473"
                                    fontSize="10"
                                    fontFamily="monospace"
                                  >
                                    {label}
                                  </text>
                                </g>
                              );
                            })}

                            {/* Single Dev Area Fill (Only when 1 dev or aggregate is plotted) */}
                            {!isMultiDevComparison && (
                              <>
                                <path d={teamAreaPath} fill="url(#singleDevGlow)" />
                                <path
                                  d={teamLinePath}
                                  fill="none"
                                  stroke="#e2a355"
                                  strokeWidth="3"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </>
                            )}

                            {/* Multi-Developer Colored Line Curves */}
                            {isMultiDevComparison && devSeriesList.map((series) => (
                              <path
                                key={series.dev.id}
                                d={series.linePath}
                                fill="none"
                                stroke={series.dev.color.stroke}
                                strokeWidth="2.75"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="transition-all duration-300"
                              />
                            ))}

                            {/* Vertical Guide Line on Hover */}
                            {activeHoverX !== null && (
                              <line
                                x1={activeHoverX}
                                y1={padTop}
                                x2={activeHoverX}
                                y2={padTop + innerH}
                                stroke="#f5c485"
                                strokeWidth="1.5"
                                strokeDasharray="3 3"
                              />
                            )}

                            {/* Multi-Developer Data Point Nodes */}
                            {chronoData.map((d, i) => {
                              const isHovered = hoveredDailyIndex === i;
                              const xPos = chronoData.length === 1 
                                ? padLeft + innerW / 2 
                                : padLeft + (i * innerW) / (chronoData.length - 1);
                              const dateLabel = new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

                              return (
                                <g 
                                  key={i} 
                                  className="cursor-pointer group"
                                  onMouseEnter={() => setHoveredDailyIndex(i)}
                                  onMouseLeave={() => setHoveredDailyIndex(null)}
                                >
                                  {/* Hover Column Hit Target */}
                                  <rect
                                    x={xPos - 15}
                                    y={padTop}
                                    width={30}
                                    height={innerH}
                                    fill="transparent"
                                  />

                                  {/* Individual developer dots on this day */}
                                  {isMultiDevComparison ? (
                                    devSeriesList.map((series) => {
                                      const pt = series.points[i];
                                      return (
                                        <g key={series.dev.id}>
                                          {isHovered && (
                                            <circle
                                              cx={pt.x}
                                              cy={pt.y}
                                              r="8"
                                              fill={series.dev.color.stroke}
                                              fillOpacity="0.3"
                                              filter="url(#nodeGlow)"
                                            />
                                          )}
                                          <circle
                                            cx={pt.x}
                                            cy={pt.y}
                                            r={isHovered ? 5.5 : 3.5}
                                            fill={isHovered ? '#fff' : series.dev.color.stroke}
                                            stroke="#14100c"
                                            strokeWidth="2"
                                            className="transition-all duration-150"
                                          />
                                        </g>
                                      );
                                    })
                                  ) : (
                                    <g>
                                      {isHovered && (
                                        <circle
                                          cx={xPos}
                                          cy={teamPoints[i].y}
                                          r="10"
                                          fill="#e2a355"
                                          fillOpacity="0.3"
                                          filter="url(#nodeGlow)"
                                        />
                                      )}
                                      <circle
                                        cx={xPos}
                                        cy={teamPoints[i].y}
                                        r={isHovered ? 6 : 4}
                                        fill={isHovered ? '#fff' : '#e2a355'}
                                        stroke="#14100c"
                                        strokeWidth="2"
                                        className="transition-all duration-150"
                                      />
                                    </g>
                                  )}

                                  {/* X-Axis Date Label */}
                                  <text
                                    x={xPos}
                                    y={height - 10}
                                    textAnchor="middle"
                                    fill={isHovered ? '#f5c485' : '#8e8473'}
                                    fontSize="10"
                                    fontWeight={isHovered ? 'bold' : 'normal'}
                                    fontFamily="monospace"
                                  >
                                    {dateLabel}
                                  </text>
                                </g>
                              );
                            })}
                          </svg>

                          {/* Hover Tooltip Overlay Card with Multi-Developer Breakdown */}
                          {activeHoverDay && (
                            <div 
                              className="absolute top-3 right-3 p-4 rounded-xl bg-[#14100c]/95 border border-[rgba(226,163,85,0.3)] shadow-2xl backdrop-blur-xl font-mono text-xs space-y-2 z-20 pointer-events-none animate-fadeIn min-w-[240px]"
                            >
                              <div className="flex items-center justify-between gap-3 text-white font-bold pb-1.5 border-b border-[rgba(242,236,223,0.08)]">
                                <span>{activeHoverDay.date}</span>
                                <span className="text-[#8e8473] font-normal text-[10px]">
                                  {new Date(`${activeHoverDay.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short' })}
                                </span>
                              </div>

                              {/* Multi-Developer Metric Rows */}
                              {isMultiDevComparison ? (
                                <div className="space-y-1.5 py-0.5">
                                  {comparedDevs.map((dev) => {
                                    const val = getDevMetricVal(activeHoverDay, dev.id);
                                    return (
                                      <div key={dev.id} className="flex items-center justify-between gap-3 text-xs">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dev.color.stroke }} />
                                          <span className="text-[#cbbfad] truncate max-w-[120px]">{dev.name}:</span>
                                        </div>
                                        <strong className="text-white shrink-0">
                                          {dailyChartMetric === 'cost' 
                                            ? formatCurrency(val) 
                                            : dailyChartMetric === 'sessions' 
                                            ? `${val} sess` 
                                            : `${formatCompactNumber(val)} tok`}
                                        </strong>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="space-y-1 text-xs">
                                  <div className="flex items-center justify-between gap-4 text-[#cbbfad]">
                                    <span>Token Burn:</span>
                                    <strong className="text-white">{formatCompactNumber(activeHoverDay.totalTokens)} tokens</strong>
                                  </div>
                                  <div className="flex items-center justify-between gap-4 text-[#cbbfad]">
                                    <span>AI Spend:</span>
                                    <strong className="text-[#f5c485]">{formatCurrency(activeHoverDay.apiCost)}</strong>
                                  </div>
                                  <div className="flex items-center justify-between gap-4 text-[#cbbfad]">
                                    <span>Sessions:</span>
                                    <strong className="text-emerald-400">{activeHoverDay.sessions}</strong>
                                  </div>
                                </div>
                              )}

                              <div className="pt-1.5 border-t border-[rgba(242,236,223,0.08)] flex items-center justify-between text-[10.5px] text-[#8e8473]">
                                <span>Day Aggregate:</span>
                                <strong className="text-[#f5c485]">
                                  {formatCompactNumber(activeHoverDay.totalTokens)} tok ({formatCurrency(activeHoverDay.apiCost)})
                                </strong>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Chart Subtitle Bar */}
                        <div className="flex items-center justify-between flex-wrap gap-2 text-xs font-mono text-[#8e8473] pt-1 px-1">
                          <div className="flex items-center gap-2">
                            <span>Showing chronological progression for <strong>{timeRange === '7d' ? '7 days' : timeRange === '14d' ? '14 days' : timeRange === '30d' ? '30 days' : timeRange === 'custom' ? `${customFrom} to ${customTo}` : 'all time'}</strong></span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-[#cbbfad]">💡 Select developers in the global header to compare specific curves</span>
                          </div>
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div className="p-8 text-center text-xs font-mono text-[#8e8473] bg-[#1c1712]/40 rounded-xl border border-dashed border-[rgba(242,236,223,0.1)]">
                    No time series data recorded for this range.
                  </div>
                )}
              </div>

              {/* Comprehensive Day-by-Day Activity Feed & Developer Matrix */}
              <div className="space-y-6">
                <div>
                  <h3 className="text-base font-bold font-mono text-white flex items-center gap-2">
                    <Users className="h-4 w-4 text-[#e2a355]" />
                    <span>Day-by-Day Developer Activity Breakdown</span>
                  </h3>
                  <p className="text-xs text-[#8e8473]">
                    Detailed developer token telemetry, edits, and costs recorded on each individual day
                  </p>
                </div>

                {dailyUsageGrouping.length > 0 ? (
                  dailyUsageGrouping.map((day: any) => (
                    <div 
                      key={day.date} 
                      className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4"
                    >
                      {/* Day Header Row */}
                      <div className="flex items-center justify-between pb-4 border-b border-[rgba(242,236,223,0.08)] flex-wrap gap-3 font-mono">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[rgba(226,163,85,0.15)] text-[#f5c485] font-bold text-xs">
                            <Calendar className="h-5 w-5" />
                          </div>
                          <div>
                            <div className="text-base font-bold text-white flex items-center gap-2">
                              <span>{day.date}</span>
                              <span className="text-xs text-[#8e8473] font-normal font-sans">
                                ({new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long' })})
                              </span>
                            </div>
                            <div className="text-xs text-[#8e8473]">
                              {day.developers.length} {day.developers.length === 1 ? 'Engineer contributed' : 'Engineers contributed'} • {day.sessions} total sessions
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 text-xs">
                          <div className="p-2 px-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)]">
                            <span className="text-[#8e8473]">Day Tokens: </span>
                            <span className="text-white font-bold">{formatCompactNumber(day.totalTokens)}</span>
                          </div>
                          <div className="p-2 px-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)]">
                            <span className="text-[#8e8473]">Day Cost: </span>
                            <span className="text-[#f5c485] font-bold">{formatCurrency(day.apiCost)}</span>
                          </div>
                          <div className="p-2 px-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)]">
                            <span className="text-[#8e8473]">Edits: </span>
                            <span className="text-emerald-400 font-bold">{day.edits}</span>
                          </div>
                        </div>
                      </div>

                      {/* Developer Cards for this specific day */}
                      <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                        <table className="w-full text-left text-xs font-mono">
                          <thead>
                            <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712] text-[#8e8473]">
                              <th className="py-3 px-4">Developer</th>
                              <th className="py-3 px-4">Tokens Burned</th>
                              <th className="py-3 px-4">Tokens In / Out</th>
                              <th className="py-3 px-4">AI Spend</th>
                              <th className="py-3 px-4">Edits</th>
                              <th className="py-3 px-4">Tool Calls</th>
                              <th className="py-3 px-4 text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                            {(() => {
                              const effectiveDevIds = dailySelectedMemberIds.length > 0 
                                ? dailySelectedMemberIds 
                                : selectedGlobalMemberIds;
                              const displayedDevs = effectiveDevIds.length > 0
                                ? day.developers.filter((dev: any) => effectiveDevIds.includes(dev.id))
                                : day.developers;

                              return displayedDevs.length > 0 ? (
                                displayedDevs.map((dev: any) => (
                                <tr key={dev.id} className="hover:bg-[rgba(226,163,85,0.04)] transition-all">
                                  <td className="py-3.5 px-4">
                                    <div className="flex items-center gap-2.5">
                                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[rgba(226,163,85,0.12)] text-[#f5c485] font-bold text-xs">
                                        {dev.displayName.slice(0, 2).toUpperCase()}
                                      </div>
                                      <div>
                                        <div className="font-semibold text-white">{dev.displayName}</div>
                                        <div className="text-[10.5px] text-[#8e8473]">{dev.handle}</div>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="py-3.5 px-4 font-bold text-white">
                                    {formatCompactNumber(dev.tokens)}
                                  </td>
                                  <td className="py-3.5 px-4 text-[#cbbfad]">
                                    {formatCompactNumber(dev.tokensIn)} in / {formatCompactNumber(dev.tokensOut)} out
                                  </td>
                                  <td className="py-3.5 px-4 font-semibold text-[#f5c485]">
                                    {formatCurrency(dev.apiCost)}
                                  </td>
                                  <td className="py-3.5 px-4 text-[#cbbfad]">
                                    {dev.edits} edits ({dev.changedLines} lines)
                                  </td>
                                  <td className="py-3.5 px-4">
                                    <span className={dev.toolErrors > 0 ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'}>
                                      {dev.toolCalls} calls ({dev.toolErrors} errs)
                                    </span>
                                  </td>
                                  <td className="py-3.5 px-4 text-right">
                                    <button
                                      onClick={() => {
                                        setSelectedGlobalMemberIds([dev.id]);
                                        setActiveTab('prompts');
                                      }}
                                      className="text-xs text-[#e2a355] hover:underline"
                                    >
                                      Inspect Prompts ↗
                                    </button>
                                  </td>
                                </tr>
                              ))
                            ) : (
                              <tr>
                                <td colSpan={7} className="py-6 text-center text-[#8e8473]">
                                  No activity recorded for selected developer(s) on this date.
                                </td>
                              </tr>
                            );
                            })()}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-12 text-center text-sm font-mono text-[#8e8473] bg-[#14100c]/60 rounded-2xl border border-[rgba(242,236,223,0.08)]">
                    No day-by-day telemetry recorded for this timeframe.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 3: DEVELOPERS DIRECTORY & DEEP DIVE (CLEAN & FOCUSED)
             ========================================================================= */}
          {activeTab === 'developers' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 animate-fadeIn">
              {/* Left (45%): Team Members & Usage List */}
              <div className="lg:col-span-5 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-bold font-mono text-white">Team Developers</h3>
                    <span className="text-xs text-[#8e8473] font-mono">{developerRoster.length} registered members</span>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => setShowCreateUserModal(true)}
                    className="h-8 bg-gradient-to-r from-[#e2a355] to-[#f5c485] hover:brightness-110 text-[#170f05] font-bold text-xs rounded-xl shadow-md shadow-[#e2a355]/20 flex items-center gap-1.5"
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    + Add Member
                  </Button>
                </div>

                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-[#8e8473]" />
                  <input
                    type="text"
                    placeholder="Search developer, @username, or repo..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] transition-all"
                  />
                </div>

                <div className="space-y-3 pt-2 max-h-[700px] overflow-y-auto">
                  {filteredRoster.map((dev: any) => {
                    const isSelected = activeSelected?.id === dev.id;
                    const isDevAdmin = dev.role === 'admin' || dev.userRole === 'admin';
                    return (
                      <div
                        key={dev.id}
                        onClick={() => setSelectedMember(dev)}
                        className={`p-4 rounded-xl border cursor-pointer transition-all ${
                          isSelected
                            ? 'bg-[rgba(226,163,85,0.12)] border-[#e2a355] shadow-lg shadow-[#e2a355]/10'
                            : 'bg-[#1c1712]/80 border-[rgba(242,236,223,0.06)] hover:border-[#e2a355]/40 hover:bg-[#1c1712]'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs font-mono shadow-sm">
                              {dev.displayName.slice(0, 2).toUpperCase()}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-white text-sm">{dev.displayName}</span>
                                {isDevAdmin ? (
                                  <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                    Admin
                                  </span>
                                ) : (
                                  <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-[#8e8473]/15 text-[#cbbfad] border border-[rgba(242,236,223,0.08)]">
                                    Dev
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-[#8e8473] font-mono flex items-center gap-1.5">
                                <span>{dev.handle}</span>
                                {dev.hasUserAccount ? (
                                  <span className={`inline-flex items-center gap-1 ${dev.userActive ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    • {dev.userActive ? 'Active' : 'Inactive'}
                                  </span>
                                ) : (
                                  <span className="text-[#8e8473]">• CLI Key</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="text-right font-mono">
                            <div className="text-sm font-bold text-[#f5c485]">{formatCompactNumber(dev.totalTokens)}</div>
                            <div className="text-[11px] text-[#8e8473]">{formatCurrency(dev.apiCost)}</div>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-[rgba(242,236,223,0.06)] text-[11px] font-mono">
                          <span className="text-[#8e8473]">
                            Top Project: <span className="text-[#cbbfad]">{dev.topProject}</span>
                          </span>
                          <div className="flex items-center gap-1">
                            {/* Quick Action Icons */}
                            <button
                              title="Edit Member"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingMember({
                                  id: dev.id,
                                  displayName: dev.displayName,
                                  username: dev.username || (dev.displayName || '').toLowerCase().replace(/\s+/g, '.'),
                                  role: dev.role || 'member',
                                  active: dev.userActive !== false,
                                });
                              }}
                              className="p-1.5 text-[#8e8473] hover:text-[#f5c485] hover:bg-[#251f18] rounded-lg transition-colors"
                            >
                              <Edit2 className="h-3 w-3" />
                            </button>

                            <button
                              title="Reset Password"
                              onClick={(e) => {
                                e.stopPropagation();
                                setResetPasswordModal({
                                  memberId: dev.id,
                                  displayName: dev.displayName,
                                  username: dev.username || (dev.displayName || '').toLowerCase().replace(/\s+/g, '.'),
                                  newPasswordOption: 'auto',
                                  customPassword: '',
                                  resultPassword: '',
                                });
                              }}
                              className="p-1.5 text-[#8e8473] hover:text-[#f5c485] hover:bg-[#251f18] rounded-lg transition-colors"
                            >
                              <Lock className="h-3 w-3" />
                            </button>

                            <button
                              title="CLI Token & Command"
                              onClick={(e) => {
                                e.stopPropagation();
                                setViewCliModal(dev);
                              }}
                              className="p-1.5 text-[#8e8473] hover:text-emerald-400 hover:bg-[#251f18] rounded-lg transition-colors"
                            >
                              <Key className="h-3 w-3" />
                            </button>

                            <button
                              title="Remove from Team"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteMemberModal({
                                  id: dev.id,
                                  displayName: dev.displayName,
                                  hardDelete: false,
                                });
                              }}
                              className="p-1.5 text-[#8e8473] hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right (55%): Selected Developer Deep Dive Card */}
              <div className="lg:col-span-7 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-7 space-y-6">
                {activeSelected ? (
                  <>
                    {/* Header Profile Card */}
                    <div className="p-5 rounded-2xl bg-gradient-to-br from-[#1c1712] to-[#14100c] border border-[rgba(226,163,85,0.2)] shadow-lg space-y-4">
                      <div className="flex items-center justify-between flex-wrap gap-4">
                        <div className="flex items-center gap-4">
                          <div className="relative">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-base font-mono shadow-md">
                              {activeSelected.displayName.slice(0, 2).toUpperCase()}
                            </div>
                            <span className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full bg-emerald-500 border-2 border-[#14100c]" />
                          </div>
                          <div>
                            <h3 className="text-lg font-bold text-white flex items-center gap-2">
                              <span>{activeSelected.displayName}</span>
                              <span className="text-xs font-mono font-normal text-[#8e8473]">{activeSelected.handle}</span>
                              {activeSelected.role === 'admin' && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                  Team Admin
                                </span>
                              )}
                            </h3>
                            <div className="flex items-center gap-3 text-xs font-mono text-[#8e8473] mt-1 flex-wrap">
                              <span>Web User: <strong className="text-white">{activeSelected.username || 'Not configured'}</strong></span>
                              <span>•</span>
                              <span>Status: <strong className={activeSelected.userActive ? 'text-emerald-400' : 'text-rose-400'}>{activeSelected.userActive ? 'Active' : 'Deactivated'}</strong></span>
                              <span>•</span>
                              <span>Top Repo: <strong className="text-[#f5c485]">{activeSelected.topProject}</strong></span>
                            </div>
                          </div>
                        </div>

                        <Button
                          size="sm"
                          onClick={() => {
                            setSelectedGlobalMemberIds([activeSelected.id]);
                            setActiveTab('prompts');
                          }}
                          className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-semibold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20 flex items-center gap-1.5"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          Inspect Developer Prompts ↗
                        </Button>
                      </div>

                      {/* Admin Controls Action Toolbar */}
                      <div className="pt-3 border-t border-[rgba(242,236,223,0.06)] flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingMember({
                              id: activeSelected.id,
                              displayName: activeSelected.displayName,
                              username: activeSelected.username || (activeSelected.displayName || '').toLowerCase().replace(/\s+/g, '.'),
                              role: activeSelected.role || 'member',
                              active: activeSelected.userActive !== false,
                            })}
                            className="h-7 text-xs border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-white hover:bg-[#251f18]"
                          >
                            <Edit2 className="h-3 w-3 mr-1 text-[#e2a355]" />
                            Edit Profile
                          </Button>

                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setResetPasswordModal({
                              memberId: activeSelected.id,
                              displayName: activeSelected.displayName,
                              username: activeSelected.username || (activeSelected.displayName || '').toLowerCase().replace(/\s+/g, '.'),
                              newPasswordOption: 'auto',
                              customPassword: '',
                              resultPassword: '',
                            })}
                            className="h-7 text-xs border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-white hover:bg-[#251f18]"
                          >
                            <Lock className="h-3 w-3 mr-1 text-[#e2a355]" />
                            Reset Password
                          </Button>

                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setViewCliModal(activeSelected)}
                            className="h-7 text-xs border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-emerald-400 hover:bg-[#251f18]"
                          >
                            <Key className="h-3 w-3 mr-1 text-emerald-400" />
                            CLI Setup &amp; Key
                          </Button>
                        </div>

                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteMemberModal({
                            id: activeSelected.id,
                            displayName: activeSelected.displayName,
                            hardDelete: false,
                          })}
                          className="h-7 text-xs text-[#8e8473] hover:text-rose-400 hover:bg-rose-500/10"
                        >
                          <Trash2 className="h-3 w-3 mr-1" />
                          Remove Member
                        </Button>
                      </div>
                    </div>

                    {/* Developer KPI Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <div className="p-4 rounded-xl bg-[#1c1712]/80 border border-[rgba(242,236,223,0.06)]">
                        <div className="text-[10px] font-mono text-[#8e8473] uppercase">Total Tokens</div>
                        <div className="text-xl font-bold font-mono text-white mt-1">{formatCompactNumber(activeSelected.totalTokens)}</div>
                      </div>
                      <div className="p-4 rounded-xl bg-[#1c1712]/80 border border-[rgba(242,236,223,0.06)]">
                        <div className="text-[10px] font-mono text-[#8e8473] uppercase">Prompts / Turns</div>
                        <div className="text-xl font-bold font-mono text-white mt-1">{activeSelected.promptsCount}</div>
                      </div>
                      <div className="p-4 rounded-xl bg-[#1c1712]/80 border border-[rgba(242,236,223,0.06)]">
                        <div className="text-[10px] font-mono text-[#8e8473] uppercase">Top Project</div>
                        <div className="text-xs font-bold font-mono text-[#f5c485] mt-1 truncate">{activeSelected.topProject}</div>
                      </div>
                      <div className="p-4 rounded-xl bg-[#1c1712]/80 border border-[rgba(242,236,223,0.06)]">
                        <div className="text-[10px] font-mono text-[#8e8473] uppercase">Total Cost</div>
                        <div className="text-xl font-bold font-mono text-[#e2a355] mt-1">{formatCurrency(activeSelected.apiCost)}</div>
                      </div>
                    </div>

                    {/* Recent Prompts & Trajectory for this Developer */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold font-mono text-white">Prompts &amp; Activity Trajectory</h4>
                        <span className="text-xs font-mono text-[#8e8473]">{activeSelected.prompts.length} recorded</span>
                      </div>

                      <div className="space-y-3 max-h-[400px] overflow-y-auto">
                        {activeSelected.prompts.length > 0 ? (
                          activeSelected.prompts.map((p: any) => (
                            <div key={p.id} className="p-4 rounded-xl bg-[#1c1712]/90 border border-[rgba(242,236,223,0.08)] space-y-3">
                              <div className="flex items-center justify-between text-xs font-mono">
                                <div className="flex items-center gap-2">
                                  <span className="bg-[#e2a355]/15 text-[#f5c485] px-2 py-0.5 rounded-md font-semibold">{p.model}</span>
                                  <span className="text-[#8e8473]">{formatCompactNumber(p.tokens)} tokens</span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <span className="text-[#f5c485] font-semibold">${p.cost}</span>
                                  <button
                                    onClick={() => setInspectingPrompt({ ...p, developerName: activeSelected.displayName, developerAvatar: activeSelected.displayName.slice(0, 2).toUpperCase() })}
                                    className="text-xs text-[#e2a355] hover:underline"
                                  >
                                    Expand ↗
                                  </button>
                                </div>
                              </div>

                              <div className="p-3 rounded-lg bg-[#0d0a07] border border-[rgba(242,236,223,0.05)] text-xs font-mono text-[#cbbfad] leading-relaxed">
                                &gt; {p.text}
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="p-6 text-center text-xs font-mono text-[#8e8473] bg-[#1c1712]/50 rounded-xl">
                            No prompt turns recorded yet for {activeSelected.displayName}.
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="p-12 text-center text-sm font-mono text-[#8e8473]">
                    Select a developer to view their profile.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 3: PROMPT INSPECTOR & LIVE AUDIT LOGS
             ========================================================================= */}
          {activeTab === 'prompts' && (
            <div className="space-y-6 animate-fadeIn">
              {/* Top Filter & Pagination Controls Bar */}
              <div className="p-5 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-4 flex-1 min-w-[280px]">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-[#8e8473]" />
                    <input
                      type="text"
                      placeholder="Search prompt contents or code keywords..."
                      value={promptSearch}
                      onChange={(e) => setPromptSearch(e.target.value)}
                      className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl pl-10 pr-4 py-2 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] transition-all font-mono"
                    />
                  </div>

                  <select
                    value={selectedPromptModel}
                    onChange={(e) => setSelectedPromptModel(e.target.value)}
                    className="bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355] font-mono cursor-pointer"
                  >
                    <option value="all">All Models</option>
                    {modelShare.map((m: any, idx: number) => (
                      <option key={idx} value={m.name}>{m.name}</option>
                    ))}
                  </select>

                  <div className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)] font-mono text-xs text-[#8e8473]">
                    <span>Total:</span>
                    <strong className="text-[#f5c485]">{filteredPrompts.length}</strong>
                  </div>
                </div>

                {/* Batch Collapse / Expand Controls */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => collapseAllPrompts(paginatedPrompts)}
                    className="h-8 text-xs font-mono border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-[#f5c485] hover:bg-[#1c1712]"
                    title="Collapse all prompts on current page"
                  >
                    <ChevronDown className="h-3.5 w-3.5 mr-1 text-[#e2a355] -rotate-90" />
                    Collapse Page
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => collapseAllPrompts(filteredPrompts)}
                    className="h-8 text-xs font-mono border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-[#f5c485] hover:bg-[#1c1712]"
                    title="Collapse all prompts across all pages"
                  >
                    <ChevronDown className="h-3.5 w-3.5 mr-1 text-[#e2a355] -rotate-90" />
                    Collapse All
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={expandAllPrompts}
                    className="h-8 text-xs font-mono border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-[#f5c485] hover:bg-[#1c1712]"
                  >
                    <ChevronDown className="h-3.5 w-3.5 mr-1 text-[#e2a355]" />
                    Expand All
                  </Button>
                </div>
              </div>

              {/* Prompt Stream List (Paginated) */}
              <div className="space-y-4">
                {paginatedPrompts.length > 0 ? (
                  paginatedPrompts.map((p: any, idx: number) => {
                    const promptKey = p.id || `prompt-${(promptPage - 1) * promptPageSize + idx}`;
                    const isCollapsed = Boolean(collapsedPromptIds[promptKey]);

                    return (
                      <div key={idx} className="p-6 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl space-y-4">
                        <div className="flex items-center justify-between flex-wrap gap-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs font-mono">
                              {p.developerAvatar}
                            </div>
                            <div>
                              <div className="font-semibold text-white text-sm">{p.developerName}</div>
                              <div className="text-[11px] text-[#8e8473] font-mono">{p.developerHandle}</div>
                            </div>
                            <span className="px-2.5 py-1 rounded-md bg-[#1c1712] border border-[rgba(242,236,223,0.06)] text-xs font-mono text-[#cbbfad]">
                              📁 {p.project}
                            </span>
                            <span className="px-2.5 py-1 rounded-md bg-[#e2a355]/10 text-[#f5c485] text-xs font-mono font-semibold">
                              🤖 {p.model}
                            </span>
                          </div>

                          <div className="flex items-center gap-3 font-mono text-xs">
                            <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              {p.status}
                            </span>
                            <span className="text-[#f5c485] font-semibold">{formatCompactNumber(p.tokens)} tokens (${p.cost})</span>
                            <span className="text-[#8e8473] flex items-center gap-1"><Clock className="h-3 w-3" /> {p.time}</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setInspectingPrompt(p)}
                              className="h-7 text-xs text-[#e2a355] hover:bg-[#e2a355]/10"
                            >
                              Inspect ↗
                            </Button>
                          </div>
                        </div>

                        {/* Collapsible Prompt Payload Box */}
                        <div className="rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.06)] overflow-hidden transition-all">
                          <button
                            type="button"
                            onClick={() => toggleCollapsePrompt(promptKey)}
                            className="w-full px-4 py-2.5 bg-[#14100c]/80 hover:bg-[#1c1712] flex items-center justify-between border-b border-[rgba(242,236,223,0.04)] text-left select-none transition-all group"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <ChevronDown className={`h-3.5 w-3.5 text-[#e2a355] transition-transform duration-200 shrink-0 ${isCollapsed ? '-rotate-90 text-[#8e8473]' : ''}`} />
                              <span className="text-[10.5px] text-[#8e8473] group-hover:text-white uppercase font-mono font-bold tracking-wider shrink-0">
                                Prompt Payload
                              </span>
                              {isCollapsed && (
                                <span className="text-xs font-mono text-[#cbbfad] truncate opacity-60">
                                  — {p.text.slice(0, 90)}...
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] font-mono text-[#e2a355] group-hover:text-[#f5c485] shrink-0 ml-2">
                              {isCollapsed ? 'Expand ▾' : 'Collapse ▴'}
                            </span>
                          </button>

                          {!isCollapsed && (
                            <div className="p-4 text-xs font-mono text-[#f5efe6] leading-relaxed whitespace-pre-wrap animate-fadeIn">
                              {p.text}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="p-12 text-center text-sm font-mono text-[#8e8473] bg-[#14100c]/60 rounded-2xl border border-[rgba(242,236,223,0.08)]">
                    No prompt logs match the selected filter.
                  </div>
                )}
              </div>

              {/* Bottom Pagination Navigation Bar */}
              {filteredPrompts.length > 0 && (
                <div className="p-4 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl flex items-center justify-between flex-wrap gap-4 font-mono text-xs">
                  <div className="flex items-center gap-3 text-[#8e8473] flex-wrap">
                    <span>
                      Showing <strong className="text-white font-bold">{Math.min((promptPage - 1) * promptPageSize + 1, filteredPrompts.length)}</strong>–
                      <strong className="text-white font-bold">{Math.min(promptPage * promptPageSize, filteredPrompts.length)}</strong> of{' '}
                      <strong className="text-[#f5c485] font-bold">{filteredPrompts.length}</strong> prompts
                    </span>
                    <span className="text-[rgba(242,236,223,0.2)]">|</span>
                    <div className="flex items-center gap-1.5">
                      <span>Per page:</span>
                      <select
                        value={promptPageSize}
                        onChange={(e) => {
                          setPromptPageSize(Number(e.target.value));
                          setPromptPage(1);
                        }}
                        className="bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-[#e2a355] cursor-pointer"
                      >
                        <option value={5}>5</option>
                        <option value={10}>10</option>
                        <option value={20}>20</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                      </select>
                    </div>
                  </div>

                  {/* Navigation Buttons */}
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPromptPage(1)}
                      disabled={promptPage <= 1}
                      className="h-8 px-2.5 text-xs font-mono border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed bg-[#1c1712]"
                      title="First Page"
                    >
                      <ChevronsLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPromptPage((p) => Math.max(1, p - 1))}
                      disabled={promptPage <= 1}
                      className="h-8 px-3 text-xs font-mono border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed bg-[#1c1712]"
                    >
                      <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Prev
                    </Button>

                    {/* Page Number Chips */}
                    <div className="flex items-center gap-1 px-1">
                      {Array.from({ length: totalPromptPages }, (_, idx) => idx + 1)
                        .filter((p) => p === 1 || p === totalPromptPages || Math.abs(p - promptPage) <= 2)
                        .reduce((acc: (number | string)[], p, idx, arr) => {
                          if (idx > 0 && p - (arr[idx - 1] as number) > 1) {
                            acc.push('...');
                          }
                          acc.push(p);
                          return acc;
                        }, [])
                        .map((item, idx) => {
                          if (item === '...') {
                            return (
                              <span key={`ellipsis-${idx}`} className="px-1 text-[#8e8473]">
                                ...
                              </span>
                            );
                          }
                          const isCurrent = item === promptPage;
                          return (
                            <button
                              key={item}
                              onClick={() => setPromptPage(item as number)}
                              className={`h-8 min-w-[32px] px-2 rounded-lg text-xs font-mono font-semibold transition-all ${
                                isCurrent
                                  ? 'bg-[#e2a355] text-[#170f05] shadow-md'
                                  : 'bg-[#1c1712] hover:bg-[#251e18] text-[#cbbfad] hover:text-white border border-[rgba(242,236,223,0.08)]'
                              }`}
                            >
                              {item}
                            </button>
                          );
                        })}
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPromptPage((p) => Math.min(totalPromptPages, p + 1))}
                      disabled={promptPage >= totalPromptPages}
                      className="h-8 px-3 text-xs font-mono border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed bg-[#1c1712]"
                    >
                      Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPromptPage(totalPromptPages)}
                      disabled={promptPage >= totalPromptPages}
                      className="h-8 px-2.5 text-xs font-mono border-[rgba(242,236,223,0.1)] text-[#cbbfad] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed bg-[#1c1712]"
                      title="Last Page"
                    >
                      <ChevronsRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              VIEW 4: DEDICATED DAEMON FLEET & SYNC TELEMETRY
             ========================================================================= */}
          {activeTab === 'daemon' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Top Daemon Fleet Metrics */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                <div className="p-6 rounded-2xl bg-[#14100c]/90 border border-emerald-500/20 shadow-xl backdrop-blur-xl">
                  <div className="text-xs font-mono text-emerald-400 uppercase tracking-wider flex items-center justify-between">
                    <span>Fleet Sync Status</span>
                    <Radio className="h-4 w-4 text-emerald-400 animate-pulse" />
                  </div>
                  <div className="mt-2 text-3xl font-bold font-mono text-white">
                    {latestDaemonCount} / {developerRoster.length}
                  </div>
                  <div className="mt-1 text-[11px] text-emerald-300 font-mono">Running latest v1.3.0 binary</div>
                </div>

                <div className="p-6 rounded-2xl bg-[#14100c]/90 border border-amber-500/20 shadow-xl backdrop-blur-xl">
                  <div className="text-xs font-mono text-amber-400 uppercase tracking-wider flex items-center justify-between">
                    <span>Outdated Daemons</span>
                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                  </div>
                  <div className="mt-2 text-3xl font-bold font-mono text-white">{outdatedDaemonCount}</div>
                  <div className="mt-1 text-[11px] text-amber-300 font-mono">Running legacy client versions</div>
                </div>

                <div className="p-6 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider">Sync Coverage</div>
                  <div className="mt-2 text-3xl font-bold font-mono text-white">
                    {developerRoster.length > 0 ? Math.round((latestDaemonCount / developerRoster.length) * 100) : 100}%
                  </div>
                  <div className="mt-1 text-[11px] text-[#8e8473] font-mono">Team-wide daemon health</div>
                </div>

                <div className="p-6 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl flex flex-col justify-between">
                  <div className="text-xs font-mono text-[#8e8473] uppercase tracking-wider">Batch Operations</div>
                  <Button
                    onClick={handleTriggerAllSync}
                    className="w-full bg-gradient-to-r from-[#e2a355] to-[#f5c485] hover:brightness-110 text-[#170f05] font-bold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20 flex items-center justify-center gap-2 mt-2"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Force Sync All Daemons
                  </Button>
                </div>
              </div>

              {/* Daemon Table */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div>
                    <h3 className="text-base font-bold font-mono text-white">Client Daemon Fleet &amp; Heartbeat Telemetry</h3>
                    <p className="text-xs text-[#8e8473]">Live daemon sync status and remote trigger commands per developer</p>
                  </div>

                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText('npm i -g @agentvis/token-tracer@latest');
                        toast.success('Update command copied to clipboard!');
                      }}
                      className="text-xs border-[rgba(226,163,85,0.3)] text-[#f5c485] hover:bg-[rgba(226,163,85,0.1)] flex items-center gap-2"
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy CLI Update Command
                    </Button>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                  <table className="w-full text-left text-xs font-mono">
                    <thead>
                      <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712] text-[#8e8473]">
                        <th className="py-3 px-4">Developer</th>
                        <th className="py-3 px-4">Role</th>
                        <th className="py-3 px-4">Daemon Version</th>
                        <th className="py-3 px-4">Last Sync Heartbeat</th>
                        <th className="py-3 px-4">Sync Status</th>
                        <th className="py-3 px-4 text-right">Remote Trigger</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                      {developerRoster.map((dev: any) => (
                        <tr key={dev.id} className="hover:bg-[rgba(226,163,85,0.04)]">
                          <td className="py-3.5 px-4 font-semibold text-white">{dev.displayName}</td>
                          <td className="py-3.5 px-4 text-[#8e8473]">{dev.role}</td>
                          <td className="py-3.5 px-4">
                            <span className={`px-2 py-0.5 rounded-md ${dev.isLatestDaemon ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                              v{dev.daemonVersion} {dev.isLatestDaemon ? '(Latest)' : '(Outdated)'}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-[#cbbfad]">{dev.lastSeenFull}</td>
                          <td className="py-3.5 px-4">
                            <span className={`inline-flex items-center gap-1.5 ${dev.lastSeen !== 'Never' ? 'text-emerald-400' : 'text-[#8e8473]'}`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${dev.lastSeen !== 'Never' ? 'bg-emerald-400 animate-pulse' : 'bg-[#8e8473]'}`} />
                              {dev.lastSeen}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleTriggerSync(dev.id, dev.displayName)}
                              className="h-7 text-xs border-[#e2a355]/30 text-[#f5c485] hover:bg-[#e2a355]/20"
                            >
                              <RefreshCw className="h-3 w-3 mr-1" /> Force Sync
                            </Button>
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
              VIEW 5: MODEL PRICING & COST GOVERNANCE
             ========================================================================= */}
          {activeTab === 'pricing' && (
            <div className="space-y-8 animate-fadeIn">
              {/* Header & Controls */}
              <div className="p-6 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl flex items-center justify-between flex-wrap gap-4">
                <div>
                  <h3 className="text-lg font-bold font-mono text-white">Model Pricing Matrix &amp; Cost Governance</h3>
                  <p className="text-xs text-[#8e8473]">Configure per-token rates ($/1M tokens) and run retroactive cost recalculations</p>
                </div>

                <div className="flex items-center gap-3">
                  <Button
                    onClick={() => setShowAddPricingModal(true)}
                    className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] hover:brightness-110 text-[#170f05] font-semibold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20 flex items-center gap-2"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Custom Model Pricing
                  </Button>

                  <Button
                    onClick={handleRecalculateCosts}
                    variant="outline"
                    className="border-[rgba(226,163,85,0.3)] text-[#f5c485] hover:bg-[rgba(226,163,85,0.1)] text-xs rounded-xl flex items-center gap-2"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    Recalculate Historical Costs
                  </Button>
                </div>
              </div>

              {/* Pricing Rules Table */}
              <div className="rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-4">
                <div className="overflow-x-auto rounded-xl border border-[rgba(242,236,223,0.06)]">
                  <table className="w-full text-left text-xs font-mono">
                    <thead>
                      <tr className="border-b border-[rgba(242,236,223,0.08)] bg-[#1c1712] text-[#8e8473]">
                        <th className="py-3 px-4">Model Pattern / Name</th>
                        <th className="py-3 px-4">Provider</th>
                        <th className="py-3 px-4">Input ($/1M)</th>
                        <th className="py-3 px-4">Output ($/1M)</th>
                        <th className="py-3 px-4">Cached ($/1M)</th>
                        <th className="py-3 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(242,236,223,0.05)]">
                      {pricingRulesList.length > 0 ? (
                        pricingRulesList.map((m: any, idx: number) => (
                          <tr key={idx} className="hover:bg-[rgba(226,163,85,0.04)]">
                            <td className="py-3.5 px-4 font-bold text-white">{m.model_pattern || m.name}</td>
                            <td className="py-3.5 px-4 text-[#8e8473]">{m.provider || 'Anthropic'}</td>
                            <td className="py-3.5 px-4 text-[#f5c485] font-semibold">${Number(m.input_cost_per_m || m.inRate?.replace('$', '') || 3.00).toFixed(2)}</td>
                            <td className="py-3.5 px-4 text-[#f5c485] font-semibold">${Number(m.output_cost_per_m || m.outRate?.replace('$', '') || 15.00).toFixed(2)}</td>
                            <td className="py-3.5 px-4 text-[#cbbfad]">${Number(m.cache_cost_per_m || m.cacheRate?.replace('$', '') || 0.30).toFixed(2)}</td>
                            <td className="py-3.5 px-4">
                              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-md text-[11px]">
                                Active
                              </span>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-[#8e8473]">
                            Default model pricing matrix active. Click "Add Custom Model Pricing" to add custom rates.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Bottom Row: Project Cost Allocations & Budget Guardrails */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-6 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-3">
                  <h4 className="text-sm font-bold font-mono text-white">Project Token Cost Allocations</h4>
                  <div className="space-y-2.5 font-mono text-xs pt-2">
                    {projectList.length > 0 ? (
                      projectList.map((p: any, idx: number) => (
                        <div key={idx} className="flex justify-between py-2 border-b border-[rgba(242,236,223,0.05)]">
                          <span className="text-[#cbbfad]">{p.name}</span>
                          <span className="text-[#f5c485] font-bold">{p.cost}</span>
                        </div>
                      ))
                    ) : (
                      <div className="py-3 text-center text-[#8e8473]">No project allocations yet</div>
                    )}
                  </div>
                </div>

                <div className="lg:col-span-6 rounded-2xl bg-[#14100c]/90 border border-[rgba(242,236,223,0.08)] shadow-xl backdrop-blur-xl p-6 space-y-3">
                  <h4 className="text-sm font-bold font-mono text-white">Monthly Budget Guardrails</h4>
                  <p className="text-xs text-[#8e8473]">Live spend vs monthly target cap</p>
                  <div className="pt-3">
                    <div className="flex justify-between text-xs font-mono mb-2">
                      <span className="text-white font-semibold">{formatCurrency(totalCost)} spent</span>
                      <span className="text-[#8e8473]">$250.00 target cap</span>
                    </div>
                    <div className="h-2.5 w-full rounded-full bg-[#0d0a07] overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-[#e2a355] to-[#f5c485]" style={{ width: `${Math.min(100, Math.round((totalCost / 250) * 100))}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </main>

      {/* =========================================================================
          MODALS & DRAWERS
         ========================================================================= */}

      {/* 1. Create Team User / Member Modal */}
      {showCreateUserModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
          <div className="w-full max-w-lg rounded-2xl bg-[#14100c] border border-[rgba(226,163,85,0.3)] shadow-2xl p-7 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] shadow-md">
                  <UserPlus className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold font-mono text-white">Create New Team Member</h3>
                  <p className="text-[11px] text-[#8e8473]">Provisions developer profile, web login, and CLI token</p>
                </div>
              </div>
              <button onClick={() => setShowCreateUserModal(false)} className="text-[#8e8473] hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateTeamMember} className="space-y-4">
              <div>
                <label className="block text-xs font-mono text-[#8e8473] mb-1">
                  Full Name / Display Name <span className="text-[#e2a355]">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Sarah Connor"
                  value={createUserForm.displayName}
                  onChange={(e) => {
                    const name = e.target.value;
                    const autoUsername = name.toLowerCase().replace(/[^a-z0-9]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
                    setCreateUserForm((prev) => ({
                      ...prev,
                      displayName: name,
                      username: prev.username === '' || prev.username === autoUsername.slice(0, -1) ? autoUsername : prev.username
                    }));
                  }}
                  className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] transition-all"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-mono text-[#8e8473] mb-1">
                    Username
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. sarah.connor"
                    value={createUserForm.username}
                    onChange={(e) => setCreateUserForm({ ...createUserForm, username: e.target.value })}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3.5 py-2 text-xs font-mono text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] transition-all"
                  />
                  <span className="text-[10px] text-[#8e8473] font-mono mt-1 block">Leave empty to auto-generate</span>
                </div>

                <div>
                  <label className="block text-xs font-mono text-[#8e8473] mb-1">
                    Team Role
                  </label>
                  <select
                    value={createUserForm.role}
                    onChange={(e) => setCreateUserForm({ ...createUserForm, role: e.target.value })}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#e2a355] transition-all"
                  >
                    <option value="member">Developer (Member)</option>
                    <option value="admin">Team Administrator</option>
                  </select>
                </div>
              </div>

              {/* Password configuration */}
              <div className="space-y-2 pt-1">
                <label className="block text-xs font-mono text-[#8e8473]">Web Login Password</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCreateUserForm({ ...createUserForm, passwordOption: 'auto', customPassword: '' })}
                    className={`py-2 px-3 rounded-xl border text-xs font-mono transition-all text-left ${
                      createUserForm.passwordOption === 'auto'
                        ? 'bg-[rgba(226,163,85,0.15)] border-[#e2a355] text-[#f5c485]'
                        : 'bg-[#1c1712] border-[rgba(242,236,223,0.06)] text-[#8e8473] hover:border-[#e2a355]/30'
                    }`}
                  >
                    <div className="font-semibold text-white">⚡ Auto-Generate</div>
                    <div className="text-[10px] text-[#8e8473]">Secure random password</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCreateUserForm({ ...createUserForm, passwordOption: 'custom' })}
                    className={`py-2 px-3 rounded-xl border text-xs font-mono transition-all text-left ${
                      createUserForm.passwordOption === 'custom'
                        ? 'bg-[rgba(226,163,85,0.15)] border-[#e2a355] text-[#f5c485]'
                        : 'bg-[#1c1712] border-[rgba(242,236,223,0.06)] text-[#8e8473] hover:border-[#e2a355]/30'
                    }`}
                  >
                    <div className="font-semibold text-white">🔑 Set Custom</div>
                    <div className="text-[10px] text-[#8e8473]">Custom password</div>
                  </button>
                </div>

                {createUserForm.passwordOption === 'custom' && (
                  <div className="pt-2 animate-fadeIn">
                    <input
                      type="password"
                      placeholder="Enter password (min 6 characters)"
                      value={createUserForm.customPassword}
                      onChange={(e) => setCreateUserForm({ ...createUserForm, customPassword: e.target.value })}
                      className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3.5 py-2 text-xs font-mono text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355] transition-all"
                    />
                  </div>
                )}
              </div>

              <div className="p-3 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.06)] text-[11px] font-mono text-[#8e8473] space-y-1">
                <div>✓ Creates web dashboard login credentials</div>
                <div>✓ Provisions CLI daemon token &amp; curl install command</div>
                <div>✓ Links developer to this team workspace automatically</div>
              </div>

              <div className="pt-3 flex items-center justify-end gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCreateUserModal(false)}
                  className="text-xs text-[#8e8473]"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isCreatingUser}
                  size="sm"
                  className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] hover:brightness-110 text-[#170f05] font-bold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20 flex items-center gap-1.5"
                >
                  {isCreatingUser ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      Creating Member...
                    </>
                  ) : (
                    <>
                      <UserPlus className="h-3.5 w-3.5" />
                      Create Member &amp; Generate Token
                    </>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. User Created Success Modal */}
      {createdUserResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-xl rounded-2xl bg-[#14100c] border border-emerald-500/30 shadow-2xl p-7 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold font-mono text-white">Team Member Created Successfully!</h3>
                  <p className="text-[11px] text-[#8e8473]">Share the credentials and installation command below with the engineer</p>
                </div>
              </div>
              <button onClick={() => setCreatedUserResult(null)} className="text-[#8e8473] hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Credentials Card */}
            <div className="p-4 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.08)] space-y-3">
              <div className="text-xs font-bold font-mono text-[#f5c485] uppercase tracking-wider">Web Portal Credentials</div>
              
              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-2.5 rounded-lg bg-[#0d0a07] border border-[rgba(242,236,223,0.05)]">
                  <span className="text-[#8e8473] block text-[10px]">Username</span>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-white font-bold">{createdUserResult.user?.username || createdUserResult.member?.display_name}</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(createdUserResult.user?.username || '');
                        toast.success('Username copied!');
                      }}
                      className="text-[#e2a355] hover:text-[#f5c485]"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-[#0d0a07] border border-[rgba(242,236,223,0.05)]">
                  <span className="text-[#8e8473] block text-[10px]">Temporary Password</span>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-emerald-400 font-bold font-mono">{createdUserResult.tempPassword || '(Set by admin)'}</span>
                    {createdUserResult.tempPassword && (
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(createdUserResult.tempPassword);
                          toast.success('Password copied!');
                        }}
                        className="text-emerald-400 hover:text-emerald-300"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* One-Line CLI Install Commands */}
            <div className="space-y-3">
              <div className="text-xs font-bold font-mono text-[#f5c485] uppercase tracking-wider flex items-center justify-between">
                <span>CLI Daemon Setup Commands</span>
                <span className="text-[10px] text-[#8e8473] normal-case">Includes auto-linked sync token</span>
              </div>

              {/* macOS / Linux */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-mono text-[#8e8473]">
                  <span>macOS &amp; Linux (Terminal)</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(createdUserResult.installCommandMac || '');
                      toast.success('macOS/Linux curl command copied!');
                    }}
                    className="text-[#e2a355] hover:underline flex items-center gap-1"
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <div className="p-3 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] font-mono text-xs text-[#cbbfad] overflow-x-auto whitespace-nowrap">
                  {createdUserResult.installCommandMac}
                </div>
              </div>

              {/* Windows PowerShell */}
              {createdUserResult.installCommandWin && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] font-mono text-[#8e8473]">
                    <span>Windows (PowerShell)</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(createdUserResult.installCommandWin || '');
                        toast.success('Windows PowerShell command copied!');
                      }}
                      className="text-[#e2a355] hover:underline flex items-center gap-1"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  </div>
                  <div className="p-3 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] font-mono text-xs text-[#cbbfad] overflow-x-auto whitespace-nowrap">
                    {createdUserResult.installCommandWin}
                  </div>
                </div>
              )}
            </div>

            <div className="pt-2 flex justify-end">
              <Button
                size="sm"
                onClick={() => setCreatedUserResult(null)}
                className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20"
              >
                Done &amp; Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Edit Team Member Modal */}
      {editingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#14100c] border border-[rgba(226,163,85,0.3)] shadow-2xl p-6 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[rgba(226,163,85,0.15)] text-[#f5c485]">
                  <Edit2 className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold font-mono text-white">Edit Team Member</h3>
                  <p className="text-[11px] text-[#8e8473]">Update profile and role</p>
                </div>
              </div>
              <button onClick={() => setEditingMember(null)} className="text-[#8e8473] hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleUpdateTeamMember} className="space-y-4">
              <div>
                <label className="block text-xs font-mono text-[#8e8473] mb-1">
                  Full Name / Display Name <span className="text-[#e2a355]">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={editingMember.displayName}
                  onChange={(e) => setEditingMember({ ...editingMember, displayName: e.target.value })}
                  className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3.5 py-2 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-mono text-[#8e8473] mb-1">Username</label>
                  <input
                    type="text"
                    value={editingMember.username || ''}
                    onChange={(e) => setEditingMember({ ...editingMember, username: e.target.value })}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-mono text-[#8e8473] mb-1">Team Role</label>
                  <select
                    value={editingMember.role || 'member'}
                    onChange={(e) => setEditingMember({ ...editingMember, role: e.target.value })}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#e2a355]"
                  >
                    <option value="member">Developer (Member)</option>
                    <option value="admin">Team Administrator</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-mono text-[#8e8473] mb-1">Account Status</label>
                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setEditingMember({ ...editingMember, active: true })}
                    className={`flex-1 py-2 px-3 rounded-xl border text-xs font-mono text-center transition-all ${
                      editingMember.active !== false
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 font-bold'
                        : 'bg-[#1c1712] border-[rgba(242,236,223,0.06)] text-[#8e8473]'
                    }`}
                  >
                    ✓ Active
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingMember({ ...editingMember, active: false })}
                    className={`flex-1 py-2 px-3 rounded-xl border text-xs font-mono text-center transition-all ${
                      editingMember.active === false
                        ? 'bg-rose-500/15 border-rose-500/40 text-rose-400 font-bold'
                        : 'bg-[#1c1712] border-[rgba(242,236,223,0.06)] text-[#8e8473]'
                    }`}
                  >
                    ✕ Deactivated
                  </button>
                </div>
              </div>

              <div className="pt-3 flex items-center justify-end gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingMember(null)}
                  className="text-xs text-[#8e8473]"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isUpdatingMember}
                  size="sm"
                  className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20"
                >
                  {isUpdatingMember ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 4. Reset Password Modal */}
      {resetPasswordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#14100c] border border-[rgba(226,163,85,0.3)] shadow-2xl p-6 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[rgba(226,163,85,0.15)] text-[#f5c485]">
                  <Lock className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold font-mono text-white">Reset Password</h3>
                  <p className="text-[11px] text-[#8e8473]">For {resetPasswordModal.displayName} (@{resetPasswordModal.username})</p>
                </div>
              </div>
              <button onClick={() => setResetPasswordModal(null)} className="text-[#8e8473] hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {resetPasswordModal.resultPassword ? (
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-3">
                <div className="text-xs font-bold font-mono text-emerald-400">Password Reset Successful!</div>
                <p className="text-xs text-[#cbbfad]">New temporary password for @{resetPasswordModal.username}:</p>
                <div className="p-3 rounded-lg bg-[#0d0a07] border border-emerald-500/20 flex items-center justify-between font-mono text-sm font-bold text-emerald-300">
                  <span>{resetPasswordModal.resultPassword}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      navigator.clipboard.writeText(resetPasswordModal.resultPassword);
                      toast.success('New password copied!');
                    }}
                    className="h-7 text-xs text-emerald-400 hover:bg-emerald-500/20"
                  >
                    <Copy className="h-3.5 w-3.5 mr-1" /> Copy
                  </Button>
                </div>
                <div className="pt-2 flex justify-end">
                  <Button size="sm" onClick={() => setResetPasswordModal(null)} className="bg-[#1c1712] text-white text-xs">
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-xs font-mono text-[#8e8473]">Password Option</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setResetPasswordModal({ ...resetPasswordModal, newPasswordOption: 'auto', customPassword: '' })}
                      className={`py-2 px-3 rounded-xl border text-xs font-mono text-left transition-all ${
                        resetPasswordModal.newPasswordOption === 'auto'
                          ? 'bg-[rgba(226,163,85,0.15)] border-[#e2a355] text-[#f5c485]'
                          : 'bg-[#1c1712] border-[rgba(242,236,223,0.06)] text-[#8e8473]'
                      }`}
                    >
                      <div className="font-semibold text-white">⚡ Auto-Generate</div>
                      <div className="text-[10px] text-[#8e8473]">Random temporary key</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setResetPasswordModal({ ...resetPasswordModal, newPasswordOption: 'custom' })}
                      className={`py-2 px-3 rounded-xl border text-xs font-mono text-left transition-all ${
                        resetPasswordModal.newPasswordOption === 'custom'
                          ? 'bg-[rgba(226,163,85,0.15)] border-[#e2a355] text-[#f5c485]'
                          : 'bg-[#1c1712] border-[rgba(242,236,223,0.06)] text-[#8e8473]'
                      }`}
                    >
                      <div className="font-semibold text-white">🔑 Set Custom</div>
                      <div className="text-[10px] text-[#8e8473]">Enter new password</div>
                    </button>
                  </div>

                  {resetPasswordModal.newPasswordOption === 'custom' && (
                    <div className="pt-2 animate-fadeIn">
                      <input
                        type="password"
                        placeholder="Enter new password (min 6 characters)"
                        value={resetPasswordModal.customPassword}
                        onChange={(e) => setResetPasswordModal({ ...resetPasswordModal, customPassword: e.target.value })}
                        className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3.5 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#e2a355]"
                      />
                    </div>
                  )}
                </div>

                <div className="pt-3 flex items-center justify-end gap-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setResetPasswordModal(null)}
                    className="text-xs text-[#8e8473]"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={isResettingPassword}
                    size="sm"
                    className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20"
                  >
                    {isResettingPassword ? 'Resetting...' : 'Confirm Reset Password'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* 5. Delete / Remove Member Confirmation Modal */}
      {deleteMemberModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#14100c] border border-rose-500/30 shadow-2xl p-6 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-500/15 text-rose-400 border border-rose-500/30">
                  <Trash2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold font-mono text-white">Remove Team Member</h3>
                  <p className="text-[11px] text-[#8e8473]">Confirm removal from workspace</p>
                </div>
              </div>
              <button onClick={() => setDeleteMemberModal(null)} className="text-[#8e8473] hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-xs text-[#cbbfad] leading-relaxed">
              Are you sure you want to remove <strong className="text-white">{deleteMemberModal.displayName}</strong> from this team workspace?
            </p>

            <label className="flex items-start gap-2.5 p-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)] cursor-pointer text-xs font-mono">
              <input
                type="checkbox"
                checked={deleteMemberModal.hardDelete}
                onChange={(e) => setDeleteMemberModal({ ...deleteMemberModal, hardDelete: e.target.checked })}
                className="mt-0.5 rounded border-[rgba(242,236,223,0.2)] text-[#e2a355] focus:ring-0"
              />
              <span className="text-[#8e8473]">
                Hard-delete associated user login account &amp; daemon sync tokens as well.
              </span>
            </label>

            <div className="pt-2 flex items-center justify-end gap-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDeleteMemberModal(null)}
                className="text-xs text-[#8e8473]"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={isDeletingMember}
                onClick={handleDeleteTeamMember}
                className="bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-rose-600/20"
              >
                {isDeletingMember ? 'Removing...' : 'Yes, Remove Member'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 6. View CLI Key & Installation Snippet Modal */}
      {viewCliModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-lg rounded-2xl bg-[#14100c] border border-[rgba(226,163,85,0.3)] shadow-2xl p-6 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <Key className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold font-mono text-white">CLI Daemon Setup for {viewCliModal.displayName}</h3>
                  <p className="text-[11px] text-[#8e8473]">Daemon synchronization command &amp; token</p>
                </div>
              </div>
              <button onClick={() => setViewCliModal(null)} className="text-[#8e8473] hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* macOS / Linux */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-mono text-[#8e8473]">
                  <span>macOS &amp; Linux (Terminal)</span>
                  <button
                    onClick={() => {
                      const cmd = viewCliModal.installCommandMac || `curl -fsSL https://token-tracer-three.vercel.app/install.sh | bash -s -- --key ${viewCliModal.apiKey || 'YOUR_KEY'}`;
                      navigator.clipboard.writeText(cmd);
                      toast.success('macOS/Linux install command copied!');
                    }}
                    className="text-[#e2a355] hover:underline flex items-center gap-1"
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <div className="p-3 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] font-mono text-xs text-[#cbbfad] overflow-x-auto whitespace-nowrap">
                  {viewCliModal.installCommandMac || `curl -fsSL https://token-tracer-three.vercel.app/install.sh | bash -s -- --key ${viewCliModal.apiKey || 'YOUR_KEY'}`}
                </div>
              </div>

              {/* Windows PowerShell */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-mono text-[#8e8473]">
                  <span>Windows (PowerShell)</span>
                  <button
                    onClick={() => {
                      const cmd = viewCliModal.installCommandWin || `$ApiKey="${viewCliModal.apiKey || 'YOUR_KEY'}"; iex (irm https://token-tracer-three.vercel.app/install.ps1)`;
                      navigator.clipboard.writeText(cmd);
                      toast.success('Windows install command copied!');
                    }}
                    className="text-[#e2a355] hover:underline flex items-center gap-1"
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <div className="p-3 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] font-mono text-xs text-[#cbbfad] overflow-x-auto whitespace-nowrap">
                  {viewCliModal.installCommandWin || `$ApiKey="${viewCliModal.apiKey || 'YOUR_KEY'}"; iex (irm https://token-tracer-three.vercel.app/install.ps1)`}
                </div>
              </div>

              {/* Quick CLI login link */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-mono text-[#8e8473]">
                  <span>NPM Package Daemon Link</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(`npx token-tracer link --team ${selectedTeamId || 'default'}`);
                      toast.success('NPM link command copied!');
                    }}
                    className="text-[#e2a355] hover:underline flex items-center gap-1"
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <div className="p-3 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] font-mono text-xs text-[#f5c485] overflow-x-auto whitespace-nowrap">
                  npx token-tracer link --team {selectedTeamId || 'default'}
                </div>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <Button size="sm" onClick={() => setViewCliModal(null)} className="bg-[#1c1712] text-white text-xs">
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Add Custom Pricing Modal */}
      {showAddPricingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#14100c] border border-[rgba(226,163,85,0.3)] shadow-2xl p-6 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold font-mono text-white flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-[#e2a355]" />
                Configure Model Pricing
              </h3>
              <button onClick={() => setShowAddPricingModal(false)} className="text-[#8e8473] hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleAddPricingRule} className="space-y-4">
              <div>
                <label className="block text-xs font-mono text-[#8e8473] mb-1">Model Name / Identifier</label>
                <input
                  type="text"
                  placeholder="e.g. Claude 3.7 Sonnet or deepseek-r1"
                  value={newPricingForm.modelName}
                  onChange={(e) => setNewPricingForm({ ...newPricingForm, modelName: e.target.value })}
                  className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white placeholder-[#8e8473] focus:outline-none focus:border-[#e2a355]"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-[#8e8473] mb-1">Provider</label>
                <select
                  value={newPricingForm.provider}
                  onChange={(e) => setNewPricingForm({ ...newPricingForm, provider: e.target.value })}
                  className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#e2a355]"
                >
                  <option value="Anthropic">Anthropic</option>
                  <option value="OpenAI">OpenAI</option>
                  <option value="Google">Google</option>
                  <option value="DeepSeek">DeepSeek</option>
                  <option value="Meta">Meta / Ollama</option>
                </select>
              </div>

              <div className="grid grid-cols-3 gap-3 font-mono text-xs">
                <div>
                  <label className="block text-[10.5px] text-[#8e8473] mb-1">Input $/1M</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newPricingForm.inputRate}
                    onChange={(e) => setNewPricingForm({ ...newPricingForm, inputRate: e.target.value })}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-2.5 py-1.5 text-white"
                  />
                </div>
                <div>
                  <label className="block text-[10.5px] text-[#8e8473] mb-1">Output $/1M</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newPricingForm.outputRate}
                    onChange={(e) => setNewPricingForm({ ...newPricingForm, outputRate: e.target.value })}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-2.5 py-1.5 text-white"
                  />
                </div>
                <div>
                  <label className="block text-[10.5px] text-[#8e8473] mb-1">Cache $/1M</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newPricingForm.cacheRate}
                    onChange={(e) => setNewPricingForm({ ...newPricingForm, cacheRate: e.target.value })}
                    className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-2.5 py-1.5 text-white"
                  />
                </div>
              </div>

              <div className="pt-3 flex items-center justify-end gap-3">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowAddPricingModal(false)} className="text-xs text-[#8e8473]">
                  Cancel
                </Button>
                <Button type="submit" size="sm" className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-semibold text-xs">
                  Save Pricing Rule
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 8. Invite Developer Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#14100c] border border-[rgba(226,163,85,0.3)] shadow-2xl p-6 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold font-mono text-white flex items-center gap-2">
                <Terminal className="h-5 w-5 text-[#e2a355]" />
                Quick Daemon Workspace Link
              </h3>
              <button onClick={() => setShowInviteModal(false)} className="text-[#8e8473] hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-[#cbbfad] leading-relaxed">
              Developers can connect their local client daemon to this workspace using the command below:
            </p>

            <div className="p-3.5 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.08)] flex items-center justify-between">
              <code className="text-xs font-mono text-[#f5c485] truncate">
                npx token-tracer link --team {selectedTeamId || 'default'}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  navigator.clipboard.writeText(`npx token-tracer link --team ${selectedTeamId || 'default'}`);
                  toast.success('Join command copied to clipboard!');
                }}
                className="h-7 text-xs text-[#e2a355] hover:bg-[#e2a355]/10 shrink-0 ml-2"
              >
                <Copy className="h-3.5 w-3.5 mr-1" /> Copy
              </Button>
            </div>

            <div className="text-[11px] text-[#8e8473] font-mono">
              ✓ Instant daemon pairing • ✓ Real-time token telemetry • ✓ Zero manual key configs
            </div>

            <div className="pt-2 flex justify-end">
              <Button size="sm" onClick={() => setShowInviteModal(false)} className="bg-[#1c1712] text-white text-xs">
                Done
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Prompt Inspector Full Modal */}
      {inspectingPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-[#14100c] border border-[rgba(226,163,85,0.3)] shadow-2xl p-7 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs font-mono">
                  {inspectingPrompt.developerAvatar}
                </div>
                <div>
                  <h3 className="text-base font-bold font-mono text-white">{inspectingPrompt.developerName}</h3>
                  <div className="text-[11px] text-[#8e8473] font-mono">{inspectingPrompt.project} • {inspectingPrompt.model}</div>
                </div>
              </div>
              <button onClick={() => setInspectingPrompt(null)} className="text-[#8e8473] hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Metrics Bar */}
            <div className="grid grid-cols-3 gap-3 p-3 rounded-xl bg-[#1c1712] border border-[rgba(242,236,223,0.06)] font-mono text-xs text-center">
              <div>
                <span className="text-[#8e8473] block text-[10px]">Tokens Consumed</span>
                <span className="text-[#f5c485] font-bold">{formatCompactNumber(inspectingPrompt.tokens)}</span>
              </div>
              <div>
                <span className="text-[#8e8473] block text-[10px]">Estimated Cost</span>
                <span className="text-[#e2a355] font-bold">${inspectingPrompt.cost}</span>
              </div>
              <div>
                <span className="text-[#8e8473] block text-[10px]">Timestamp</span>
                <span className="text-white font-bold">{inspectingPrompt.time || 'recently'}</span>
              </div>
            </div>

            {/* Prompt Content */}
            <div className="space-y-2">
              <span className="text-xs font-bold font-mono text-[#8e8473] uppercase">Full Developer Prompt</span>
              <div className="p-4 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.06)] text-xs font-mono text-[#f5efe6] leading-relaxed whitespace-pre-wrap">
                {inspectingPrompt.text}
              </div>
            </div>

            {/* AI Response Preview */}
            <div className="space-y-2">
              <span className="text-xs font-bold font-mono text-[#8e8473] uppercase">AI Response / Tool Output</span>
              <div className="p-4 rounded-xl bg-[#0d0a07] border border-[rgba(242,236,223,0.06)] text-xs font-mono text-emerald-300 leading-relaxed whitespace-pre-wrap">
                {inspectingPrompt.response || 'Session logged from live sync daemon.'}
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <Button size="sm" onClick={() => setInspectingPrompt(null)} className="bg-[#1c1712] text-white text-xs">
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Custom Date Range Modal */}
      {showCustomDatePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#14100c] border border-[rgba(226,163,85,0.3)] shadow-2xl p-6 space-y-5 animate-scaleUp">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[rgba(226,163,85,0.15)] text-[#f5c485]">
                  <Calendar className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold font-mono text-white">Custom Date Range</h3>
                  <p className="text-[11px] text-[#8e8473]">Filter telemetry for an exact duration</p>
                </div>
              </div>
              <button onClick={() => setShowCustomDatePicker(false)} className="text-[#8e8473] hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Quick Presets */}
            <div className="space-y-2">
              <label className="text-xs font-mono text-[#8e8473]">Quick Presets</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'Last 7 Days', days: 7 },
                  { label: 'Last 14 Days', days: 14 },
                  { label: 'Last 30 Days', days: 30 },
                  { label: 'Last 60 Days', days: 60 },
                  { label: 'Last 90 Days', days: 90 },
                  { label: 'Past Year', days: 365 },
                ].map((p) => (
                  <button
                    key={p.days}
                    type="button"
                    onClick={() => {
                      const to = new Date().toISOString().slice(0, 10);
                      const d = new Date();
                      d.setDate(d.getDate() - (p.days - 1));
                      const from = d.toISOString().slice(0, 10);
                      setCustomFrom(from);
                      setCustomTo(to);
                    }}
                    className="p-2 rounded-xl bg-[#1c1712] hover:bg-[#251f18] border border-[rgba(242,236,223,0.06)] hover:border-[#e2a355]/30 text-xs font-mono text-[#cbbfad] transition-all"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Date Inputs */}
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <label className="block text-xs font-mono text-[#8e8473] mb-1.5 uppercase">From Date</label>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#e2a355] transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-[#8e8473] mb-1.5 uppercase">To Date</label>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="w-full bg-[#1c1712] border border-[rgba(242,236,223,0.1)] rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#e2a355] transition-all"
                />
              </div>
            </div>

            <div className="pt-3 flex items-center justify-end gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCustomDatePicker(false)}
                className="text-xs text-[#8e8473]"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setTimeRange('custom');
                  setShowCustomDatePicker(false);
                  fetchTeamData();
                  toast.success(`Date range applied: ${customFrom} to ${customTo}`);
                }}
                className="bg-gradient-to-r from-[#e2a355] to-[#f5c485] text-[#170f05] font-bold text-xs rounded-xl shadow-lg shadow-[#e2a355]/20"
              >
                Apply Date Range
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
