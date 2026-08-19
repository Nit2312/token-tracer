/**
 * Superadmin Model Pricing Management API
 *
 * GET    /api/admin/pricing         → list all pricing rules (global + per-team) & system defaults
 * POST   /api/admin/pricing         → create or update a pricing rule (global or team-specific)
 * DELETE /api/admin/pricing?id=uuid → delete a pricing rule
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { queryCol, setDocById, deleteDocById, newUuid } from '@/lib/team/db';
import { recalculateAllCosts, recalculateTeamCosts } from '@/lib/team/stats';
import { recordAuditEvent } from '@/lib/team/audit';

export const dynamic = 'force-dynamic';

function requireSuperadmin(req: NextRequest): boolean {
  const session = getSessionFromCookie(req.headers.get('cookie'));
  return session?.role === 'superadmin';
}

const DEFAULT_SYSTEM_RULES = [
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
];

export async function GET(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });

  try {
    const pricingDocs = await queryCol<any>('model_pricing');
    const teamDocs = await queryCol<any>('teams');
    const teamById = new Map(teamDocs.map((t: any) => [t.id, t]));

    const pricing = pricingDocs.map((mp: any) => ({
      ...mp,
      team_name: mp.team_id ? (teamById.get(mp.team_id)?.name || mp.team_id) : null,
    })).sort((a: any, b: any) => {
      if (!a.team_id && b.team_id) return -1;
      if (a.team_id && !b.team_id) return 1;
      return String(a.model_pattern).localeCompare(String(b.model_pattern));
    });

    const teams = teamDocs.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

    return NextResponse.json({ pricing, teams, defaultRules: DEFAULT_SYSTEM_RULES });
  } catch (err: any) {
    console.error('[admin/pricing GET error]', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  const actorSession = getSessionFromCookie(req.headers.get('cookie'));

  try {
    const body = await req.json();
    const { id, teamId, modelPattern, costInPerM, costOutPerM, costCacheReadPerM, syncRecalc } = body;

    const pattern = String(modelPattern || '').trim();
    if (!pattern) return NextResponse.json({ error: 'modelPattern is required' }, { status: 400 });

    const costIn = parseFloat(costInPerM) || 0;
    const costOut = parseFloat(costOutPerM) || 0;
    const costCache = parseFloat(costCacheReadPerM) || 0;
    const finalTeamId = (!teamId || teamId === 'global' || teamId === '') ? null : teamId;

    const ruleId = id || newUuid();
    const ruleDoc = {
      id: ruleId,
      team_id: finalTeamId,
      model_pattern: pattern,
      cost_in_per_m: costIn,
      cost_out_per_m: costOut,
      cost_cache_read_per_m: costCache,
      created_at: new Date().toISOString(),
    };
    await setDocById('model_pricing', ruleId, ruleDoc, true);

    let recalcStats = null;
    if (syncRecalc !== false) {
      if (finalTeamId) {
        recalcStats = await recalculateTeamCosts(finalTeamId, true);
      } else {
        recalcStats = await recalculateAllCosts(true);
      }
    }

    await recordAuditEvent({
      actorUserId: actorSession?.userId,
      actorUsername: actorSession?.username,
      action: id ? 'pricing.update' : 'pricing.create',
      targetType: 'model_pricing',
      targetId: ruleId,
      metadata: { teamId: finalTeamId, modelPattern: pattern, costIn, costOut, costCache },
    });

    return NextResponse.json({ ok: true, rule: ruleDoc, recalculated: recalcStats }, { status: 201 });
  } catch (err: any) {
    console.error('[admin/pricing POST error]', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!requireSuperadmin(req)) return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  const actorSession = getSessionFromCookie(req.headers.get('cookie'));

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  try {
    const { getDocById } = await import('@/lib/team/db');
    const ruleDoc = await getDocById('model_pricing', id) as any;
    const teamId = ruleDoc?.team_id || null;

    await deleteDocById('model_pricing', id);

    if (teamId) {
      await recalculateTeamCosts(teamId, true);
    } else {
      await recalculateAllCosts(true);
    }

    await recordAuditEvent({
      actorUserId: actorSession?.userId,
      actorUsername: actorSession?.username,
      action: 'pricing.delete',
      targetType: 'model_pricing',
      targetId: id,
      metadata: { teamId, modelPattern: ruleDoc?.model_pattern ?? null },
    });

    return NextResponse.json({ ok: true, deleted: true });
  } catch (err: any) {
    console.error('[admin/pricing DELETE error]', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
