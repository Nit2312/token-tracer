import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId } from '@/lib/auth';
import { query } from '@/lib/team/db';
import { recalculateTeamCosts } from '@/lib/team/stats';

import defaultPricingData from '@/lib/pricing.json';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const rawTeamId = req.nextUrl.searchParams.get('teamId') || req.nextUrl.searchParams.get('team_id');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const isUuid = (val: string | null | undefined): boolean =>
      Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

    let customPricing: any[] = [];
    if (isUuid(teamId)) {
      const { rows } = await query(
        'SELECT id, model_pattern, cost_in_per_m, cost_out_per_m, cost_cache_read_per_m, created_at FROM model_pricing WHERE team_id = $1 OR team_id IS NULL ORDER BY (team_id IS NOT NULL) DESC, model_pattern',
        [teamId],
      );
      customPricing = rows;
    }

    // Default models from lib/pricing.json
    const defaultModels = (defaultPricingData.models || []).map((m: any) => ({
      id: m.id,
      model_pattern: m.label || m.id,
      provider: m.id.startsWith('claude') ? 'Anthropic' : m.id.startsWith('gpt') || m.id.startsWith('o1') || m.id.startsWith('o3') ? 'OpenAI' : m.id.startsWith('gemini') ? 'Google' : m.id.startsWith('deepseek') ? 'DeepSeek' : 'Standard',
      cost_in_per_m: m.input,
      cost_out_per_m: m.output,
      cost_cache_read_per_m: m.cacheRead ?? (m.input * 0.1),
      isDefault: true
    }));

    // Merge: custom pricing overrides take precedence
    const customPatternSet = new Set(customPricing.map((p) => p.model_pattern.toLowerCase()));
    const merged = [
      ...customPricing.map((p) => ({ ...p, isDefault: false })),
      ...defaultModels.filter((d) => !customPatternSet.has(d.model_pattern.toLowerCase()) && !customPatternSet.has(d.id.toLowerCase()))
    ];

    return NextResponse.json({ pricing: merged });
  } catch (err) {
    console.error('[team/pricing GET error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const rawTeamId = body.teamId ? String(body.teamId) : null;
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const { modelPattern, costInPerM, costOutPerM, costCacheReadPerM } = body;
    if (!modelPattern) {
      return NextResponse.json({ error: 'modelPattern required' }, { status: 400 });
    }

    const { rows } = await query(
      `INSERT INTO model_pricing (team_id, model_pattern, cost_in_per_m, cost_out_per_m, cost_cache_read_per_m)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (team_id, model_pattern) DO UPDATE SET
         cost_in_per_m = EXCLUDED.cost_in_per_m,
         cost_out_per_m = EXCLUDED.cost_out_per_m,
         cost_cache_read_per_m = EXCLUDED.cost_cache_read_per_m
       RETURNING id, model_pattern, cost_in_per_m, cost_out_per_m, cost_cache_read_per_m`,
      [
        teamId,
        String(modelPattern).trim().toLowerCase(),
        Number(costInPerM || 0),
        Number(costOutPerM || 0),
        Number(costCacheReadPerM || 0),
      ],
    );

    // Automatically recalculate costs for all synced sessions of this team
    const recalc = await recalculateTeamCosts(teamId, true);

    return NextResponse.json({ item: rows[0], recalc }, { status: 201 });
  } catch (err) {
    console.error('[team/pricing POST error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const { rowCount } = await query('DELETE FROM model_pricing WHERE id = $1 AND team_id = $2', [id, teamId]);
    if (rowCount && rowCount > 0) {
      await recalculateTeamCosts(teamId, true);
    }
    return NextResponse.json({ ok: true, deleted: (rowCount || 0) > 0 });
  } catch (err) {
    console.error('[team/pricing DELETE error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}

