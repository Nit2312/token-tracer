/**
 * Superadmin Model Pricing Management API
 *
 * GET    /api/admin/pricing         → list all pricing rules (global + per-team) & system defaults
 * POST   /api/admin/pricing         → create or update a pricing rule (global or team-specific)
 * DELETE /api/admin/pricing?id=uuid → delete a pricing rule
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { recalculateAllCosts, recalculateTeamCosts } from '@/lib/team/stats';
import { recordAuditEvent } from '@/lib/team/audit';
import { publicError } from '@/lib/security/errors';

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
  if (!requireSuperadmin(req)) {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }

  try {
    const { rows: pricing } = await query(`
      SELECT 
        mp.id, 
        mp.team_id, 
        mp.model_pattern, 
        mp.cost_in_per_m, 
        mp.cost_out_per_m, 
        mp.cost_cache_read_per_m, 
        mp.created_at,
        t.name AS team_name
      FROM model_pricing mp
      LEFT JOIN teams t ON t.id = mp.team_id
      ORDER BY (mp.team_id IS NOT NULL) ASC, mp.model_pattern ASC
    `);

    const { rows: teams } = await query(`
      SELECT id, name FROM teams ORDER BY name ASC
    `);

    return NextResponse.json({
      pricing,
      teams,
      defaultRules: DEFAULT_SYSTEM_RULES,
    });
  } catch (err: any) {
    console.error('[admin/pricing GET error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!requireSuperadmin(req)) {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }
  const actorSession = getSessionFromCookie(req.headers.get('cookie'));

  try {
    const body = await req.json();
    const { id, teamId, modelPattern, costInPerM, costOutPerM, costCacheReadPerM, syncRecalc } = body;

    const pattern = String(modelPattern || '').trim();
    if (!pattern) {
      return NextResponse.json({ error: 'modelPattern is required' }, { status: 400 });
    }

    const costIn = parseFloat(costInPerM) || 0;
    const costOut = parseFloat(costOutPerM) || 0;
    const costCache = parseFloat(costCacheReadPerM) || 0;
    const finalTeamId = (!teamId || teamId === 'global' || teamId === '') ? null : teamId;

    let savedRule;
    if (id) {
      const { rows } = await query(`
        UPDATE model_pricing
        SET team_id = $2,
            model_pattern = $3,
            cost_in_per_m = $4,
            cost_out_per_m = $5,
            cost_cache_read_per_m = $6
        WHERE id = $1
        RETURNING *
      `, [id, finalTeamId, pattern, costIn, costOut, costCache]);
      savedRule = rows[0];
    } else {
      if (finalTeamId) {
        const { rows } = await query(`
          INSERT INTO model_pricing (team_id, model_pattern, cost_in_per_m, cost_out_per_m, cost_cache_read_per_m)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (team_id, LOWER(model_pattern))
          DO UPDATE SET
            cost_in_per_m = EXCLUDED.cost_in_per_m,
            cost_out_per_m = EXCLUDED.cost_out_per_m,
            cost_cache_read_per_m = EXCLUDED.cost_cache_read_per_m
          RETURNING *
        `, [finalTeamId, pattern, costIn, costOut, costCache]);
        savedRule = rows[0];
      } else {
        const { rows } = await query(`
          INSERT INTO model_pricing (team_id, model_pattern, cost_in_per_m, cost_out_per_m, cost_cache_read_per_m)
          VALUES (NULL, $1, $2, $3, $4)
          ON CONFLICT (LOWER(model_pattern)) WHERE team_id IS NULL
          DO UPDATE SET
            cost_in_per_m = EXCLUDED.cost_in_per_m,
            cost_out_per_m = EXCLUDED.cost_out_per_m,
            cost_cache_read_per_m = EXCLUDED.cost_cache_read_per_m
          RETURNING *
        `, [pattern, costIn, costOut, costCache]);
        savedRule = rows[0];
      }
    }

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
      targetId: savedRule?.id ?? null,
      metadata: { teamId: finalTeamId, modelPattern: pattern, costIn, costOut, costCache },
    });

    return NextResponse.json({
      ok: true,
      rule: savedRule,
      recalculated: recalcStats,
    }, { status: 201 });
  } catch (err: any) {
    console.error('[admin/pricing POST error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!requireSuperadmin(req)) {
    return NextResponse.json({ error: 'superadmin access required' }, { status: 403 });
  }
  const actorSession = getSessionFromCookie(req.headers.get('cookie'));

  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  try {
    const { rows } = await query('SELECT team_id, model_pattern FROM model_pricing WHERE id = $1', [id]);
    const teamId = rows[0]?.team_id || null;

    const { rowCount } = await query('DELETE FROM model_pricing WHERE id = $1', [id]);

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
      metadata: { teamId, modelPattern: rows[0]?.model_pattern ?? null },
    });

    return NextResponse.json({ ok: true, deleted: (rowCount || 0) > 0 });
  } catch (err: any) {
    console.error('[admin/pricing DELETE error]', err);
    return NextResponse.json({ error: publicError(err) }, { status: 500 });
  }
}
