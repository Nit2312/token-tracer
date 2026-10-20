import { NextRequest, NextResponse } from 'next/server';
import { cronSecret } from '@/lib/team/env';
import { safeEqual } from '@/lib/security/request';
import { runResearchRollup } from '@/lib/team/research';

function isCronAuthorized(req: NextRequest): boolean {
  const secret = cronSecret();
  if (!secret) return false; // CRON_SECRET not set → deny
  const auth = req.headers.get('authorization');
  if (safeEqual(auth, `Bearer ${secret}`)) return true;
  // Also allow direct header for Vercel Cron
  const cronHeader = req.headers.get('x-cron-secret');
  return safeEqual(cronHeader, secret);
}

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return executeRollup();
}

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return executeRollup();
}

async function executeRollup(): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    await runResearchRollup();
    return NextResponse.json({
      success: true,
      durationMs: Date.now() - startedAt,
      message: 'Research analytics rollup completed successfully'
    });
  } catch (err: any) {
    console.error('[research-rollup-error]', err);
    return NextResponse.json({
      success: false,
      error: err.message || String(err)
    }, { status: 500 });
  }
}
