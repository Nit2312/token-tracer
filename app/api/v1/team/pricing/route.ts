import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizedTeamId } from '@/lib/auth';
import { queryCol, setDocById, deleteDocById, newUuid } from '@/lib/team/db';
import { recalculateTeamCosts } from '@/lib/team/stats';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const rawTeamId = req.nextUrl.searchParams.get('teamId');
    const teamId = getAuthorizedTeamId(req, rawTeamId);
    if (!teamId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const isUuid = (val: string | null | undefined): boolean =>
      Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

    if (!isUuid(teamId)) {
      return NextResponse.json({ pricing: [] });
    }

    const pricingDocs = await queryCol<any>('model_pricing', [
      { type: 'where', field: 'team_id', op: '==', value: teamId },
    ]);
    pricingDocs.sort((a, b) => String(a.model_pattern).localeCompare(String(b.model_pattern)));

    return NextResponse.json({
      pricing: pricingDocs.map(p => ({
        id: p.id,
        model_pattern: p.model_pattern,
        cost_in_per_m: p.cost_in_per_m,
        cost_out_per_m: p.cost_out_per_m,
        cost_cache_read_per_m: p.cost_cache_read_per_m,
        created_at: p.created_at,
      })),
    });
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

    const pattern = String(modelPattern).trim().toLowerCase();

    // Check if rule already exists for this team & pattern
    const existing = await queryCol<any>('model_pricing', [
      { type: 'where', field: 'team_id', op: '==', value: teamId },
      { type: 'where', field: 'model_pattern', op: '==', value: pattern },
      { type: 'limit', n: 1 },
    ]);

    const id = existing[0]?.id || newUuid();
    const item = {
      id,
      team_id: teamId,
      model_pattern: pattern,
      cost_in_per_m: Number(costInPerM || 0),
      cost_out_per_m: Number(costOutPerM || 0),
      cost_cache_read_per_m: Number(costCacheReadPerM || 0),
      created_at: existing[0]?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await setDocById('model_pricing', id, item, true);

    // Automatically recalculate costs for all synced sessions of this team
    const recalc = await recalculateTeamCosts(teamId, true);

    return NextResponse.json({ item, recalc }, { status: 201 });
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

    await deleteDocById('model_pricing', id);
    await recalculateTeamCosts(teamId, true);
    return NextResponse.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[team/pricing DELETE error]', err);
    return NextResponse.json({ error: String((err as Error).message || err) }, { status: 500 });
  }
}
