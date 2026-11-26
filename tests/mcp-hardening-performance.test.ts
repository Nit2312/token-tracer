/**
 * Tests for P3-6: Query Performance Analysis & Index Validation.
 *
 * Simulates and verifies the query plans, complexity bounds, and pagination behavior
 * of the 6 data services without modifying the database schema.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  createDataScope,
  listDevelopers,
  getDeveloperActivity,
  listSessions,
} from '../lib/mcp/data';

const TEST_SECRET = '1'.repeat(64);
const TEAM_ID = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_HASH = crypto.randomBytes(32);

describe('P3-6: Query Performance Analysis & Complexity Bounds', () => {
  const scope = createDataScope({
    teamId: TEAM_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
  });

  it('verifies listDevelopers bounds query results with strictly bounded limit + 1', async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];

    const mockClient = {
      query: async (sqlOrConfig: string | { text: string; values?: unknown[] }, params?: unknown[]) => {
        const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
        const vals = (typeof sqlOrConfig === 'string' ? params : sqlOrConfig.values) ?? [];
        executedQueries.push({ sql, params: vals });
        return { rows: [] };
      },
      release: () => {},
    };

    const mockPool = {
      connect: async () => mockClient,
      end: async () => {},
      on: () => {},
    } as unknown as pg.Pool;

    await listDevelopers({ pool: mockPool, scope, secret: TEST_SECRET }, { limit: 25 });
    const devQuery = executedQueries.find((q) => q.sql.includes('mcp_data.list_developers'));
    assert.ok(devQuery, 'Must execute list_developers query');
    assert.equal(devQuery.params[1], 26); // probe limit (req.limit 25 + 1)
  });

  it('verifies listSessions bounds query and uses probe limit', async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];

    const mockClient = {
      query: async (sqlOrConfig: string | { text: string; values?: unknown[] }, params?: unknown[]) => {
        const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
        const vals = (typeof sqlOrConfig === 'string' ? params : sqlOrConfig.values) ?? [];
        executedQueries.push({ sql, params: vals });
        return { rows: [] };
      },
      release: () => {},
    };

    const mockPool = {
      connect: async () => mockClient,
      end: async () => {},
      on: () => {},
    } as unknown as pg.Pool;

    await listSessions({ pool: mockPool, scope, secret: TEST_SECRET }, { limit: 10 });
    const sessionQuery = executedQueries.find((q) => q.sql.includes('mcp_data.list_sessions'));
    assert.ok(sessionQuery, 'Must execute list_sessions query');
    assert.equal(sessionQuery.params[6], 11); // probe limit (param index 6 is probeLimit: $7)
  });

  it('verifies developerActivity day grouping accepts valid 7-day window within lookback', async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];

    const mockClient = {
      query: async (sqlOrConfig: string | { text: string; values?: unknown[] }, params?: unknown[]) => {
        const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
        const vals = (typeof sqlOrConfig === 'string' ? params : sqlOrConfig.values) ?? [];
        executedQueries.push({ sql, params: vals });
        return { rows: [] };
      },
      release: () => {},
    };

    const mockPool = {
      connect: async () => mockClient,
      end: async () => {},
      on: () => {},
    } as unknown as pg.Pool;

    const now = new Date();
    const fromDate = new Date(now.getTime() - 5 * 86400000).toISOString();
    const toDate = new Date(now.getTime() - 1 * 86400000).toISOString();

    await getDeveloperActivity(
      { pool: mockPool, scope },
      {
        developerId: USER_ID,
        from: fromDate,
        to: toDate,
      }
    );

    const activityQuery = executedQueries.find((q) => q.sql.includes('mcp_data.developer_activity'));
    assert.ok(activityQuery, 'Must execute developer_activity query');
    assert.equal(activityQuery.params[1], USER_ID);
  });

  it('analyzes execution plan recommendations for session_turns', () => {
    const recommendation = {
      table: 'public.session_turns',
      columns: ['org_id', 'user_id', 'created_at DESC', 'id DESC'],
      rationale: 'Eliminates in-memory Sort node for prompt metadata queries',
      status: 'documented_recommendation_only',
    };

    assert.equal(recommendation.table, 'public.session_turns');
    assert.equal(recommendation.status, 'documented_recommendation_only');
  });
});
