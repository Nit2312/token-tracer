/**
 * GET /api/v1/update-check
 *
 * Called by the sync daemon before every sync cycle (at most once per 24 h).
 * Authenticates via Bearer API key, records the daemon's current version,
 * and returns update info if a newer active release exists.
 *
 * Request headers:
 *   Authorization: Bearer <api_key>
 *   X-Daemon-Version: 1.0.0
 *
 * Response 200:
 *   {
 *     current: string,        // version the daemon sent
 *     latest: string,         // latest active release version
 *     url: string,            // download URL for the latest daemon binary
 *     sha256: string,         // hex SHA-256 of the file at `url`
 *     mandatory: boolean,     // if true, daemon must update before syncing
 *     updateAvailable: boolean
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import { memberFromAuthHeader } from '@/lib/team/auth';
import { query } from '@/lib/team/db';
import { publicError } from '@/lib/security/errors';

export const dynamic = 'force-dynamic';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Daemon-Version',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  try {
    // 1. Authenticate
    const member = await memberFromAuthHeader(req.headers.get('authorization'));
    if (!member) {
      return NextResponse.json(
        { error: 'invalid API key' },
        { status: 401, headers: corsHeaders },
      );
    }

    // 2. Read current daemon version from the request header
    const currentVersion = (req.headers.get('x-daemon-version') || '').trim() || null;

    // 3. Update member's daemon_version and daemon_last_seen_at in DB
    if (currentVersion) {
      await query(
        `UPDATE members
            SET daemon_version = $1, daemon_last_seen_at = now()
          WHERE id = $2`,
        [currentVersion, member.member_id],
      );
    }

    // 4. Fetch the latest active release
    const { rows } = await query<{
      version: string;
      download_url: string;
      sha256: string;
      mandatory: boolean;
    }>(
      `SELECT version, download_url, sha256, mandatory
         FROM daemon_releases
        WHERE active = true
        ORDER BY released_at DESC
        LIMIT 1`,
    );

    if (!rows.length) {
      // No release record yet — tell the daemon it's up-to-date
      return NextResponse.json(
        {
          current: currentVersion,
          latest: currentVersion,
          url: null,
          sha256: null,
          mandatory: false,
          updateAvailable: false,
        },
        { headers: corsHeaders },
      );
    }

    const latest = rows[0];
    const updateAvailable =
      !!currentVersion && compareVersions(latest.version, currentVersion) > 0;

    return NextResponse.json(
      {
        current: currentVersion,
        latest: latest.version,
        url: latest.download_url,
        sha256: latest.sha256,
        mandatory: latest.mandatory,
        updateAvailable,
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    console.error('[update-check GET error]', err);
    return NextResponse.json(
      { error: publicError(err) },
      { status: 500, headers: corsHeaders },
    );
  }
}

/**
 * Compare two semver-like strings (e.g. "1.2.3").
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
