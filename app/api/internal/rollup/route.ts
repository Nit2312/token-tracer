/**
 * Internal cron endpoint — nightly rollup.
 * Called by Vercel Cron (see vercel.json) or superadmin one-click trigger.
 * Protected by CRON_SECRET or superadmin session cookie.
 */
import { NextRequest, NextResponse } from 'next/server';
import { queryCol, setDocById, batchWrite } from '@/lib/team/db';
import { cronSecret } from '@/lib/team/env';
import { runResearchRollup } from '@/lib/team/research';
import { getSessionFromCookie } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function isCronAuthorized(req: NextRequest): boolean {
  const cookieHeader = req.headers.get('cookie') || '';
  const session = getSessionFromCookie(cookieHeader);
  if (session && session.role === 'superadmin') return true;

  const secret = cronSecret();
  if (!secret) return false;
  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${secret}`) return true;
  const cronHeader = req.headers.get('x-cron-secret');
  return cronHeader === secret;
}

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return runRollup();
}

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return runRollup();
}

async function runRollup(): Promise<NextResponse> {
  const startedAt = Date.now();
  const errors: string[] = [];

  try {
    const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
    const [sessions, events] = await Promise.all([
      queryCol<any>('sync_sessions'),
      queryCol<any>('ingest_events'),
    ]);

    const yesterdaySessions = sessions.filter((s: any) => {
      const ts = s.ended_at || s.started_at || s.synced_at;
      return ts && String(ts).slice(0, 10) === yesterday;
    });

    // 1. daily_org_usage
    const orgUsageMap = new Map<string, {
      day: string;
      org_id: string;
      tool: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      list_price_cost: number;
      actual_cost: number;
      session_count: number;
    }>();

    for (const s of yesterdaySessions) {
      const day = yesterday;
      const org_id = s.team_id || 'unassigned';
      const tool = s.source || 'unknown';
      const model = s.model || 'unknown';
      const key = `${day}_${org_id}_${tool}_${model}`;

      if (!orgUsageMap.has(key)) {
        orgUsageMap.set(key, {
          day, org_id, tool, model,
          input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_write_tokens: 0,
          list_price_cost: 0, actual_cost: 0,
          session_count: 0,
        });
      }
      const row = orgUsageMap.get(key)!;
      row.input_tokens += Number(s.tokens_in || 0);
      row.output_tokens += Number(s.tokens_out || 0);
      row.cache_read_tokens += Number(s.tokens_cache_read || 0);
      row.cache_write_tokens += Number(s.tokens_cache_write || 0);
      const cost = Number(s.api_cost || 0);
      row.list_price_cost += cost;
      row.actual_cost += cost;
      row.session_count += 1;
    }

    const orgUsageOps = Array.from(orgUsageMap.entries()).map(([id, data]) => ({
      type: 'set' as const,
      col: 'daily_org_usage',
      id,
      data,
      merge: true,
    }));
    if (orgUsageOps.length) await batchWrite(orgUsageOps);

    // 2. daily_pipeline_health
    const yesterdayEvents = events.filter((e: any) => e.created_at && String(e.created_at).slice(0, 10) === yesterday);
    const healthMap = new Map<string, {
      day: string;
      daemon_id: string;
      org_id: string;
      last_heartbeat: string | null;
      batches_received: number;
      batches_failed: number;
      avg_ingestion_lag_seconds: number;
      parse_errors: number;
      sanitize_errors: number;
    }>();

    for (const ie of yesterdayEvents) {
      const daemon_id = ie.member_id || 'unknown';
      const org_id = ie.team_id || 'unassigned';
      const key = `${yesterday}_${daemon_id}`;

      if (!healthMap.has(key)) {
        healthMap.set(key, {
          day: yesterday,
          daemon_id,
          org_id,
          last_heartbeat: null,
          batches_received: 0,
          batches_failed: 0,
          avg_ingestion_lag_seconds: 0,
          parse_errors: 0,
          sanitize_errors: 0,
        });
      }
      const row = healthMap.get(key)!;
      if (!row.last_heartbeat || (ie.created_at && ie.created_at > row.last_heartbeat)) {
        row.last_heartbeat = ie.created_at;
      }
      if (ie.status === 'ok') row.batches_received += 1;
      else row.batches_failed += 1;
    }

    const healthOps = Array.from(healthMap.entries()).map(([id, data]) => ({
      type: 'set' as const,
      col: 'daily_pipeline_health',
      id,
      data,
      merge: true,
    }));
    if (healthOps.length) await batchWrite(healthOps);

    // 3. daily_behavior_rollup
    const behaviorMap = new Map<string, {
      day: string;
      org_id: string;
      tool: string;
      rework_loop_count: number;
      tool_error_count: number;
      total_turns: number;
    }>();

    for (const s of yesterdaySessions) {
      const org_id = s.team_id || 'unassigned';
      const tool = s.source || 'unknown';
      const key = `${yesterday}_${org_id}_${tool}`;

      if (!behaviorMap.has(key)) {
        behaviorMap.set(key, {
          day: yesterday,
          org_id,
          tool,
          rework_loop_count: 0,
          tool_error_count: 0,
          total_turns: 0,
        });
      }
      const row = behaviorMap.get(key)!;
      row.rework_loop_count += Number(s.rework_loops || 0);
      row.tool_error_count += Number(s.tool_errors || 0);
      row.total_turns += Number(s.tool_calls || 0);
    }

    const behaviorOps = Array.from(behaviorMap.entries()).map(([id, data]) => ({
      type: 'set' as const,
      col: 'daily_behavior_rollup',
      id,
      data,
      merge: true,
    }));
    if (behaviorOps.length) await batchWrite(behaviorOps);

    // Also run research rollup
    await runResearchRollup();
  } catch (err: any) {
    errors.push(err.message);
  }

  const elapsed = Date.now() - startedAt;

  if (errors.length > 0) {
    return NextResponse.json({
      ok: false,
      elapsed_ms: elapsed,
      errors,
    }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    elapsed_ms: elapsed,
  });
}
