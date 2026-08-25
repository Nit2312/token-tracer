/**
 * Platform-wide Token Whale and Deep-Dive Usage Analysis (Firestore backend).
 * Computes multi-dimensional breakdowns (Projects, Tools, Models, Sessions, Files, Timelines)
 * for both Team Admin and Superadmin scopes.
 */
import { queryCol, getDocById } from '@/lib/team/db';
import { statsCache } from '@/lib/team/cache';

export interface WhaleFilterOptions {
  range?: string | null; // '7d' | '30d' | '90d' | 'all'
  teamId?: string | null;
  minTokens?: number | null;
  search?: string | null;
  limit?: number;
}

export interface MemberDeepDiveOptions {
  range?: string | null;
  from?: string | null;
  to?: string | null;
  source?: string | null;
  model?: string | null;
  teamId?: string | null;
}

function effIn(s: any): number {
  const ti = Number(s.tokens_in || 0);
  const tc = Number(s.tool_calls || 0);
  const ed = Number(s.edits || 0);
  const cl = Number(s.changed_lines || 0);
  if (ti === 0 && (tc + ed) > 0) return Math.max(500, (tc + ed) * 350 + cl * 10);
  return ti;
}

function effOut(s: any): number {
  const to = Number(s.tokens_out || 0);
  const tc = Number(s.tool_calls || 0);
  const ed = Number(s.edits || 0);
  const cl = Number(s.changed_lines || 0);
  if (to === 0 && (tc + ed) > 0) return Math.max(200, (tc + ed) * 150 + cl * 5);
  return to;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

function getSessionTimestamp(s: any): string | null {
  return s.ended_at || s.started_at || s.synced_at || null;
}

function isWithinRange(ts: string | null, range: string | null, from: string | null, to: string | null): boolean {
  if (!ts) return false;
  const dateStr = String(ts).slice(0, 10);
  const time = new Date(ts).getTime();
  if (isNaN(time)) return false;

  if (range && range !== 'all') {
    const match = range.match(/^(\d+)d$/);
    const days = match ? Number(match[1]) : 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    if (time < cutoff) return false;
  }

  if (from && dateStr < from.slice(0, 10)) return false;
  if (to && dateStr > to.slice(0, 10)) return false;

  return true;
}

/**
 * Fetch platform-wide token spenders (Whales) across all teams or filtered by team.
 */
export async function getPlatformWhales(options: WhaleFilterOptions = {}) {
  const range = options.range || 'all';
  const teamId = options.teamId && options.teamId !== 'all' ? options.teamId : null;
  const minTokens = Number(options.minTokens) || 0;
  const search = (options.search || '').trim().toLowerCase();
  const limit = options.limit || 100;

  const cacheKey = `whale_analysis_fs_${range}_${teamId || 'all'}_${minTokens}_${search}_${limit}`;

  return statsCache.getOrSet(cacheKey, 45, async () => {
    const constraints: Parameters<typeof queryCol>[1] = [];
    if (teamId) {
      constraints.push({ type: 'where', field: 'team_id', op: '==', value: teamId });
    }

    const [allSessions, membersList, teamsList] = await Promise.all([
      queryCol<any>('sync_sessions', constraints),
      queryCol<any>('members'),
      queryCol<any>('teams'),
    ]);

    const memberById = new Map(membersList.map((m: any) => [m.id, m]));
    const teamById = new Map(teamsList.map((t: any) => [t.id, t]));

    // Filter sessions by date range
    const sessions = allSessions.filter((s) => {
      const ts = getSessionTimestamp(s);
      return isWithinRange(ts, range, null, null);
    });

    // 1. Group sessions by member
    const memberStatsMap = new Map<string, any>();
    const memberProjectsMap = new Map<string, Map<string, { tokens: number; cost: number }>>();
    const memberModelsMap = new Map<string, Map<string, number>>();
    const memberSourcesMap = new Map<string, Map<string, number>>();

    let globalTokIn = 0;
    let globalTokOut = 0;
    let globalCacheRead = 0;
    let globalCost = 0;

    const globalProjectsMap = new Map<string, { tokens: number; cost: number; sessions: number }>();
    const globalModelsMap = new Map<string, { tokens: number; cost: number; sessions: number }>();

    for (const s of sessions) {
      const mid = String(s.member_id || 'unknown');
      const tin = effIn(s);
      const tout = effOut(s);
      const totTok = tin + tout;
      const cost = Number(s.api_cost || 0);
      const cacheRead = Number(s.tokens_cache_read || 0);
      const cacheWrite = Number(s.tokens_cache_write || 0);
      const edits = Number(s.edits || 0);
      const lines = Number(s.changed_lines || 0);
      const tools = Number(s.tool_calls || 0);
      const errors = Number(s.tool_errors || 0);
      const rework = Number(s.rework_loops || 0);
      const isRunaway = totTok > 5000000 || errors > 15 || rework > 5;
      const ts = getSessionTimestamp(s);

      globalTokIn += tin;
      globalTokOut += tout;
      globalCacheRead += cacheRead;
      globalCost += cost;

      const project = s.agent || 'default';
      const model = s.model || 'default';
      const source = s.source || 'cursor';

      // Global rollups
      if (!globalProjectsMap.has(project)) globalProjectsMap.set(project, { tokens: 0, cost: 0, sessions: 0 });
      const gp = globalProjectsMap.get(project)!;
      gp.tokens += totTok;
      gp.cost += cost;
      gp.sessions += 1;

      if (!globalModelsMap.has(model)) globalModelsMap.set(model, { tokens: 0, cost: 0, sessions: 0 });
      const gm = globalModelsMap.get(model)!;
      gm.tokens += totTok;
      gm.cost += cost;
      gm.sessions += 1;

      // Member stats
      if (!memberStatsMap.has(mid)) {
        const mem = memberById.get(mid);
        const tm = teamById.get(s.team_id);
        memberStatsMap.set(mid, {
          member_id: mid,
          display_name: mem?.display_name || 'Unknown Member',
          team_id: s.team_id,
          team_name: tm?.name || 'Independent',
          sessions_count: 0,
          tokens_in: 0,
          tokens_out: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          total_tokens: 0,
          api_cost: 0,
          edits: 0,
          changed_lines: 0,
          tool_calls: 0,
          tool_errors: 0,
          rework_loops: 0,
          runaway_count: 0,
          first_active: ts,
          last_active: ts,
        });
        memberProjectsMap.set(mid, new Map());
        memberModelsMap.set(mid, new Map());
        memberSourcesMap.set(mid, new Map());
      }

      const ms = memberStatsMap.get(mid)!;
      ms.sessions_count += 1;
      ms.tokens_in += tin;
      ms.tokens_out += tout;
      ms.tokens_cache_read += cacheRead;
      ms.tokens_cache_write += cacheWrite;
      ms.total_tokens += totTok;
      ms.api_cost += cost;
      ms.edits += edits;
      ms.changed_lines += lines;
      ms.tool_calls += tools;
      ms.tool_errors += errors;
      ms.rework_loops += rework;
      if (isRunaway) ms.runaway_count += 1;

      if (ts) {
        if (!ms.first_active || ts < ms.first_active) ms.first_active = ts;
        if (!ms.last_active || ts > ms.last_active) ms.last_active = ts;
      }

      // Member top break-downs
      const mp = memberProjectsMap.get(mid)!;
      if (!mp.has(project)) mp.set(project, { tokens: 0, cost: 0 });
      const mpEntry = mp.get(project)!;
      mpEntry.tokens += totTok;
      mpEntry.cost += cost;

      const mm = memberModelsMap.get(mid)!;
      mm.set(model, (mm.get(model) || 0) + totTok);

      const msrc = memberSourcesMap.get(mid)!;
      msrc.set(source, (msrc.get(source) || 0) + totTok);
    }

    let whales = Array.from(memberStatsMap.values()).map((row) => {
      const mid = row.member_id;
      const mp = memberProjectsMap.get(mid)!;
      const mm = memberModelsMap.get(mid)!;
      const msrc = memberSourcesMap.get(mid)!;

      let topProjName = 'none';
      let topProjTok = 0;
      let topProjCost = 0;
      for (const [pname, pdata] of mp.entries()) {
        if (pdata.tokens >= topProjTok) {
          topProjName = pname;
          topProjTok = pdata.tokens;
          topProjCost = pdata.cost;
        }
      }

      let topModName = 'default';
      let topModTok = -1;
      for (const [mname, mtok] of mm.entries()) {
        if (mtok > topModTok) {
          topModName = mname;
          topModTok = mtok;
        }
      }

      let topSrcName = 'cursor';
      let topSrcTok = -1;
      for (const [sname, stok] of msrc.entries()) {
        if (stok > topSrcTok) {
          topSrcName = sname;
          topSrcTok = stok;
        }
      }

      const totalTok = row.total_tokens;
      const projPct = totalTok > 0 ? (topProjTok / totalTok) * 100 : 0;

      return {
        memberId: row.member_id,
        displayName: row.display_name,
        teamId: row.team_id,
        teamName: row.team_name,
        sessionsCount: row.sessions_count,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        tokensCacheRead: row.tokens_cache_read,
        tokensCacheWrite: row.tokens_cache_write,
        totalTokens: totalTok,
        apiCost: row.api_cost,
        edits: row.edits,
        changedLines: row.changed_lines,
        toolCalls: row.tool_calls,
        toolErrors: row.tool_errors,
        reworkLoops: row.rework_loops,
        runawayCount: row.runaway_count,
        firstActive: row.first_active,
        lastActive: row.last_active,
        topProject: {
          name: topProjName,
          tokens: topProjTok,
          cost: topProjCost,
          percentage: projPct,
        },
        topModel: topModName,
        topSource: topSrcName,
        avgTokensPerSession: row.sessions_count > 0 ? Math.round(totalTok / row.sessions_count) : 0,
      };
    });

    whales.sort((a, b) => b.totalTokens - a.totalTokens);

    if (minTokens > 0) {
      whales = whales.filter((w) => w.totalTokens >= minTokens);
    }
    if (search) {
      whales = whales.filter((w) =>
        w.displayName.toLowerCase().includes(search) ||
        w.teamName.toLowerCase().includes(search) ||
        w.topProject.name.toLowerCase().includes(search) ||
        w.topModel.toLowerCase().includes(search)
      );
    }

    const topProjectsGlobal = Array.from(globalProjectsMap.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);

    const topModelsGlobal = Array.from(globalModelsMap.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);

    const extremeSessions = [...sessions]
      .map((s) => {
        const mem = memberById.get(s.member_id);
        const tm = teamById.get(s.team_id);
        const tin = effIn(s);
        const tout = effOut(s);
        const totTok = tin + tout;
        return {
          docId: s.id,
          sessionId: s.session_id,
          memberId: s.member_id,
          memberName: mem?.display_name || 'Unknown',
          teamName: tm?.name || 'Independent',
          project: s.agent || 'default',
          source: s.source || 'cursor',
          model: s.model || 'default',
          tokensIn: tin,
          tokensOut: tout,
          tokensCacheRead: Number(s.tokens_cache_read || 0),
          totalTokens: totTok,
          apiCost: Number(s.api_cost || 0),
          toolCalls: Number(s.tool_calls || 0),
          toolErrors: Number(s.tool_errors || 0),
          reworkLoops: Number(s.rework_loops || 0),
          startedAt: s.started_at,
          endedAt: s.ended_at,
          syncedAt: s.synced_at,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens || b.apiCost - a.apiCost)
      .slice(0, 10);

    return {
      whales: whales.slice(0, limit),
      totalWhales: whales.length,
      totals: {
        totalTokens: globalTokIn + globalTokOut,
        tokensIn: globalTokIn,
        tokensOut: globalTokOut,
        tokensCacheRead: globalCacheRead,
        totalCost: globalCost,
        totalSessions: sessions.length,
      },
      topProjectsGlobal,
      topModelsGlobal,
      extremeSessions,
    };
  });
}

/**
 * Deep-dive analysis for single or multiple team members (or entire team):
 * Returns the multi-dimensional breakdown (Projects, Tools, Models, Top Heavy Sessions, Files, Daily Timeline, Member Comparisons).
 */
export async function buildMemberUsageDeepDive(
  memberInput: string | string[],
  options: MemberDeepDiveOptions = {}
) {
  const { range = 'all', from = null, to = null, source = null, model = null, teamId = null } = options;

  let memberIds: string[] = [];
  if (Array.isArray(memberInput)) {
    memberIds = memberInput.map((id) => String(id).trim()).filter(Boolean);
  } else if (typeof memberInput === 'string') {
    memberIds = memberInput.split(',').map((id) => id.trim()).filter(Boolean);
  }

  const isAll = memberIds.includes('all') || memberIds.length === 0;
  const sortedIdsKey = isAll ? 'all' : [...memberIds].sort().join('_');
  const cacheKey = `member_deep_dive_fs_${sortedIdsKey}_${teamId || 'any'}_${range}_${from || ''}_${to || ''}_${source || ''}_${model || ''}`;

  return statsCache.getOrSet(cacheKey, 300, async () => {
    // 1. Fetch Member(s) & Team metadata
    const [allMembers, allTeams, teamMemberDocs] = await Promise.all([
      queryCol<any>('members'),
      queryCol<any>('teams'),
      teamId ? queryCol<any>('team_members', [{ type: 'where', field: 'team_id', op: '==', value: teamId }]) : Promise.resolve([]),
    ]);

    const memberMap = new Map(allMembers.map((m: any) => [m.id, m]));
    const teamMap = new Map(allTeams.map((t: any) => [t.id, t]));

    let targetMemberIds: string[] = [];
    if (isAll && teamId) {
      targetMemberIds = teamMemberDocs.map((tm: any) => tm.member_id);
    } else if (isAll) {
      targetMemberIds = allMembers.map((m: any) => m.id);
    } else {
      targetMemberIds = memberIds;
    }

    const memberRows = targetMemberIds.map((mid) => memberMap.get(mid)).filter(Boolean);
    if (!memberRows.length && !isAll) {
      return null;
    }

    const isMulti = memberRows.length > 1 || isAll;
    const firstRow = memberRows[0] || {};
    const teamDoc = teamId ? teamMap.get(teamId) : (firstRow.team_id ? teamMap.get(firstRow.team_id) : null);

    const member = {
      id: isAll ? 'all' : memberRows.map((r: any) => r.id).join(','),
      displayName: isAll
        ? `All Team Members (${memberRows.length})`
        : memberRows.length === 1
        ? firstRow.display_name
        : `${memberRows.length} Members (${memberRows.slice(0, 3).map((r: any) => r.display_name).join(', ')}${memberRows.length > 3 ? '…' : ''})`,
      teamId: teamId || firstRow.team_id,
      teamName: teamDoc?.name || 'Independent',
      createdAt: firstRow.created_at,
      isMulti,
      count: memberRows.length,
      selectedMembers: memberRows.map((r: any) => ({ id: r.id, displayName: r.display_name })),
    };

    // 2. Fetch sessions
    const sessionConstraints: Parameters<typeof queryCol>[1] = [];
    if (teamId) {
      sessionConstraints.push({ type: 'where', field: 'team_id', op: '==', value: teamId });
    } else if (targetMemberIds.length === 1) {
      sessionConstraints.push({ type: 'where', field: 'member_id', op: '==', value: targetMemberIds[0] });
    }

    const rawSessions = await queryCol<any>('sync_sessions', sessionConstraints);

    // Apply filtering
    const memberIdSet = new Set(targetMemberIds);
    const sessions = rawSessions.filter((s) => {
      if (!isAll && !memberIdSet.has(s.member_id)) return false;
      if (source && source !== 'all' && s.source !== source) return false;
      if (model && model !== 'all' && s.model !== model) return false;
      const ts = getSessionTimestamp(s);
      return isWithinRange(ts, range, from, to);
    });

    // 3. Aggregate totals and multi-dimensional metrics
    let tokensIn = 0;
    let tokensOut = 0;
    let tokensCacheRead = 0;
    let tokensCacheWrite = 0;
    let totalCost = 0;
    let edits = 0;
    let changedLines = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let reworkLoops = 0;
    let runawayCount = 0;
    const activeDaysSet = new Set<string>();

    const projectsMap = new Map<string, any>();
    const toolsMap = new Map<string, any>();
    const modelsMap = new Map<string, any>();
    const timelineMap = new Map<string, any>();
    const memberBreakdownMap = new Map<string, any>();

    for (const s of sessions) {
      const tin = effIn(s);
      const tout = effOut(s);
      const totTok = tin + tout;
      const cost = Number(s.api_cost || 0);
      const cr = Number(s.tokens_cache_read || 0);
      const cw = Number(s.tokens_cache_write || 0);
      const ed = Number(s.edits || 0);
      const cl = Number(s.changed_lines || 0);
      const tc = Number(s.tool_calls || 0);
      const te = Number(s.tool_errors || 0);
      const rl = Number(s.rework_loops || 0);
      const isRunaway = totTok > 5000000 || te > 15 || rl > 5;
      const ts = getSessionTimestamp(s);
      const dateStr = ts ? String(ts).slice(0, 10) : '';

      tokensIn += tin;
      tokensOut += tout;
      tokensCacheRead += cr;
      tokensCacheWrite += cw;
      totalCost += cost;
      edits += ed;
      changedLines += cl;
      toolCalls += tc;
      toolErrors += te;
      reworkLoops += rl;
      if (isRunaway) runawayCount += 1;
      if (dateStr) activeDaysSet.add(dateStr);

      const proj = s.agent || 'default';
      const src = s.source || 'cursor';
      const mod = s.model || 'default';
      const mid = s.member_id;

      // Project breakdown
      if (!projectsMap.has(proj)) {
        projectsMap.set(proj, {
          project: proj,
          sources: new Set<string>(),
          models: new Set<string>(),
          sessions: 0,
          tokens_in: 0,
          tokens_out: 0,
          tokens_cache_read: 0,
          total_tokens: 0,
          api_cost: 0,
          edits: 0,
          changed_lines: 0,
          last_active: ts,
        });
      }
      const pr = projectsMap.get(proj)!;
      pr.sources.add(src);
      pr.models.add(mod);
      pr.sessions += 1;
      pr.tokens_in += tin;
      pr.tokens_out += tout;
      pr.tokens_cache_read += cr;
      pr.total_tokens += totTok;
      pr.api_cost += cost;
      pr.edits += ed;
      pr.changed_lines += cl;
      if (ts && (!pr.last_active || ts > pr.last_active)) pr.last_active = ts;

      // Tool breakdown
      if (!toolsMap.has(src)) {
        toolsMap.set(src, {
          source: src,
          sessions: 0,
          tokens_in: 0,
          tokens_out: 0,
          tokens_cache_read: 0,
          total_tokens: 0,
          api_cost: 0,
        });
      }
      const tr = toolsMap.get(src)!;
      tr.sessions += 1;
      tr.tokens_in += tin;
      tr.tokens_out += tout;
      tr.tokens_cache_read += cr;
      tr.total_tokens += totTok;
      tr.api_cost += cost;

      // Model breakdown
      const modelKey = `${mod}::${src}`;
      if (!modelsMap.has(modelKey)) {
        modelsMap.set(modelKey, {
          model: mod,
          source: src,
          sessions: 0,
          tokens_in: 0,
          tokens_out: 0,
          tokens_cache_read: 0,
          total_tokens: 0,
          api_cost: 0,
        });
      }
      const mr = modelsMap.get(modelKey)!;
      mr.sessions += 1;
      mr.tokens_in += tin;
      mr.tokens_out += tout;
      mr.tokens_cache_read += cr;
      mr.total_tokens += totTok;
      mr.api_cost += cost;

      // Timeline breakdown
      if (dateStr) {
        if (!timelineMap.has(dateStr)) {
          timelineMap.set(dateStr, {
            day: dateStr,
            sessions: 0,
            tokens_in: 0,
            tokens_out: 0,
            tokens_cache_read: 0,
            total_tokens: 0,
            api_cost: 0,
            edits: 0,
          });
        }
        const dlr = timelineMap.get(dateStr)!;
        dlr.sessions += 1;
        dlr.tokens_in += tin;
        dlr.tokens_out += tout;
        dlr.tokens_cache_read += cr;
        dlr.total_tokens += totTok;
        dlr.api_cost += cost;
        dlr.edits += ed;
      }

      // Member comparison breakdown
      if (isMulti && mid) {
        if (!memberBreakdownMap.has(mid)) {
          const mem = memberMap.get(mid);
          memberBreakdownMap.set(mid, {
            member_id: mid,
            display_name: mem?.display_name || 'Unknown Member',
            sessions: 0,
            tokens_in: 0,
            tokens_out: 0,
            tokens_cache_read: 0,
            total_tokens: 0,
            api_cost: 0,
            edits: 0,
            changed_lines: 0,
            tool_calls: 0,
            tool_errors: 0,
            rework_loops: 0,
          });
        }
        const mbr = memberBreakdownMap.get(mid)!;
        mbr.sessions += 1;
        mbr.tokens_in += tin;
        mbr.tokens_out += tout;
        mbr.tokens_cache_read += cr;
        mbr.total_tokens += totTok;
        mbr.api_cost += cost;
        mbr.edits += ed;
        mbr.changed_lines += cl;
        mbr.tool_calls += tc;
        mbr.tool_errors += te;
        mbr.rework_loops += rl;
      }
    }

    const totalMemberTokens = tokensIn + tokensOut;

    // 4. Fetch heavy session files
    const sortedHeavySessions = [...sessions]
      .sort((a, b) => (effIn(b) + effOut(b)) - (effIn(a) + effOut(a)))
      .slice(0, 100);

    const heavySessionIds = sortedHeavySessions.map((s) => s.id).filter(Boolean);
    let allSessionFiles: any[] = [];
    if (heavySessionIds.length) {
      for (const chunk of chunkArray(heavySessionIds, 30)) {
        const files = await queryCol('sync_session_files', [
          { type: 'where', field: 'sync_session_id', op: 'in', value: chunk },
        ]);
        allSessionFiles.push(...files);
      }
    }

    const filesMap = new Map<string, any>();
    for (const f of allSessionFiles) {
      const p = f.path;
      if (!filesMap.has(p)) {
        filesMap.set(p, { path: p, edits: 0, additions: 0, deletions: 0, changed_lines: 0 });
      }
      const fe = filesMap.get(p)!;
      fe.edits += Number(f.edits || 0);
      fe.additions += Number(f.additions || 0);
      fe.deletions += Number(f.deletions || 0);
      fe.changed_lines += Number(f.additions || 0) + Number(f.deletions || 0);
    }

    const topFiles = Array.from(filesMap.values())
      .sort((a, b) => b.changed_lines - a.changed_lines || b.edits - a.edits)
      .slice(0, 20);

    // Top sessions
    const topSessions = sortedHeavySessions.slice(0, 25).map((s) => {
      const mem = memberMap.get(s.member_id);
      const tin = effIn(s);
      const tout = effOut(s);
      const totTok = tin + tout;
      const te = Number(s.tool_errors || 0);
      const rl = Number(s.rework_loops || 0);
      const isRunaway = totTok > 5000000 || te > 15 || rl > 5;
      return {
        docId: s.id,
        sessionId: s.session_id,
        memberId: s.member_id,
        memberName: mem?.display_name || 'Unknown Member',
        project: s.agent || 'default',
        source: s.source || 'cursor',
        model: s.model || 'default',
        tokensIn: tin,
        tokensOut: tout,
        tokensCacheRead: Number(s.tokens_cache_read || 0),
        tokensCacheWrite: Number(s.tokens_cache_write || 0),
        totalTokens: totTok,
        apiCost: Number(s.api_cost || 0),
        edits: Number(s.edits || 0),
        changedLines: Number(s.changed_lines || 0),
        toolCalls: Number(s.tool_calls || 0),
        toolErrors: te,
        reworkLoops: rl,
        isRunaway,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        syncedAt: s.synced_at,
      };
    });

    return {
      member,
      totals: {
        totalTokens: totalMemberTokens,
        tokensIn,
        tokensOut,
        tokensCacheRead,
        tokensCacheWrite,
        totalCost,
        sessionCount: sessions.length,
        activeDays: activeDaysSet.size,
        edits,
        changedLines,
        toolCalls,
        toolErrors,
        reworkLoops,
        runawaySessionsCount: runawayCount,
        avgTokensPerSession: sessions.length > 0 ? Math.round(totalMemberTokens / sessions.length) : 0,
        avgCostPerSession: sessions.length > 0 ? totalCost / sessions.length : 0,
      },
      memberComparisons: Array.from(memberBreakdownMap.values())
        .map((mb) => ({
          ...mb,
          percentage: totalMemberTokens > 0 ? (mb.total_tokens / totalMemberTokens) * 100 : 0,
        }))
        .sort((a, b) => b.total_tokens - a.total_tokens),
      projects: Array.from(projectsMap.values())
        .map((p) => ({
          project: p.project,
          sources: Array.from(p.sources),
          models: Array.from(p.models),
          sessions: p.sessions,
          tokensIn: p.tokens_in,
          tokensOut: p.tokens_out,
          tokensCacheRead: p.tokens_cache_read,
          totalTokens: p.total_tokens,
          apiCost: p.api_cost,
          edits: p.edits,
          changedLines: p.changed_lines,
          lastActive: p.last_active,
          percentage: totalMemberTokens > 0 ? (p.total_tokens / totalMemberTokens) * 100 : 0,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
      tools: Array.from(toolsMap.values())
        .map((t) => ({
          source: t.source,
          sessions: t.sessions,
          tokensIn: t.tokens_in,
          tokensOut: t.tokens_out,
          tokensCacheRead: t.tokens_cache_read,
          totalTokens: t.total_tokens,
          apiCost: t.api_cost,
          percentage: totalMemberTokens > 0 ? (t.total_tokens / totalMemberTokens) * 100 : 0,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
      models: Array.from(modelsMap.values())
        .map((m) => {
          const tin = m.tokens_in;
          const cr = m.tokens_cache_read;
          const denom = tin + cr;
          const cacheHitRate = denom > 0 ? (cr / denom) * 100 : 0;
          return {
            model: m.model,
            source: m.source,
            sessions: m.sessions,
            tokensIn: tin,
            tokensOut: m.tokens_out,
            tokensCacheRead: cr,
            totalTokens: m.total_tokens,
            apiCost: m.api_cost,
            cacheHitRate,
            percentage: totalMemberTokens > 0 ? (m.total_tokens / totalMemberTokens) * 100 : 0,
          };
        })
        .sort((a, b) => b.totalTokens - a.totalTokens),
      topSessions,
      topFiles,
      dailyTimeline: Array.from(timelineMap.values())
        .map((d) => ({
          day: d.day,
          sessions: d.sessions,
          tokensIn: d.tokens_in,
          tokensOut: d.tokens_out,
          tokensCacheRead: d.tokens_cache_read,
          totalTokens: d.total_tokens,
          apiCost: d.api_cost,
          edits: d.edits,
        }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    };
  });
}
