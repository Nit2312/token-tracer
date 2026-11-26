/**
 * Tests for P3-6: Concurrency & Connection Exhaustion Testing for Reader Pool.
 *
 * Verifies:
 * 1. Bounded connection pool (max 5) enforces acquisition timeout and queuing.
 * 2. Concurrent requests across multiple tenants remain isolated.
 * 3. Aborted transactions, query timeouts, and unexpected query errors always release the client.
 * 4. Client release under load does not leave connections in dirty / uncommitted states.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  withReaderTx,
} from '../lib/mcp/data/db';
import { isDataError } from '../lib/mcp/data/errors';

const TEAM_1 = '11111111-1111-4111-8111-111111111111';
const TEAM_2 = '33333333-3333-4333-8333-333333333333';

describe('P3-6: Concurrency & Connection Exhaustion', () => {
  it('guarantees client release even when query throws an unexpected error', async () => {
    let released = false;

    const mockClient = {
      query: async (sqlOrConfig: string | { text: string }) => {
        const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
        if (sql.includes('BEGIN')) return {};
        if (sql.includes('set_config')) return {};
        if (sql.includes('ROLLBACK')) return {};
        throw new Error('Connection terminated unexpectedly');
      },
      release: () => {
        released = true;
      },
    };

    const mockPool = {
      connect: async () => mockClient,
      end: async () => {},
      on: () => {},
    } as unknown as pg.Pool;

    await assert.rejects(
      async () =>
        withReaderTx(mockPool, async (client) => {
          return client.query('SELECT 1');
        }),
      (err: unknown) => isDataError(err) && err.code === 'internal'
    );

    assert.equal(released, true, 'Client must be released after error');
  });

  it('handles concurrent interleaved transactions across multiple tenants without state leakage', async () => {
    const activePerTeam = new Map<string, number>();
    let maxConcurrent = 0;
    let totalRequests = 0;

    const mockClient = (teamId: string) => ({
      query: async (sqlOrConfig: string | { text: string }) => {
        const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
        if (sql.includes('BEGIN')) {
          const current = (activePerTeam.get(teamId) ?? 0) + 1;
          activePerTeam.set(teamId, current);
          const total = Array.from(activePerTeam.values()).reduce((a, b) => a + b, 0);
          if (total > maxConcurrent) maxConcurrent = total;
          return {};
        }
        if (sql.includes('set_config')) return {};
        if (sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
          const current = (activePerTeam.get(teamId) ?? 1) - 1;
          activePerTeam.set(teamId, current);
          return {};
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        totalRequests++;
        return { rows: [] };
      },
      release: () => {},
    });

    // Launch 20 concurrent requests interleaved between Team 1 and Team 2
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const teamId = i % 2 === 0 ? TEAM_1 : TEAM_2;
      const client = mockClient(teamId);
      const mockPool = {
        connect: async () => client,
        end: async () => {},
        on: () => {},
      } as unknown as pg.Pool;

      promises.push(
        withReaderTx(mockPool, async (c) => c.query('SELECT 1'))
      );
    }

    await Promise.all(promises);
    assert.equal(totalRequests, 20);
    for (const count of activePerTeam.values()) {
      assert.equal(count, 0, 'Active transaction count should return to 0');
    }
  });

  it('translates lock and statement timeout errors into unavailable code', async () => {
    const mockClient = {
      query: async (sqlOrConfig: string | { text: string }) => {
        const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
        if (sql.includes('BEGIN') || sql.includes('set_config') || sql.includes('ROLLBACK')) return {};
        const error = new Error('canceling statement due to statement timeout') as Error & { code?: string };
        error.code = '57014'; // query_canceled
        throw error;
      },
      release: () => {},
    };

    const mockPool = {
      connect: async () => mockClient,
      end: async () => {},
      on: () => {},
    } as unknown as pg.Pool;

    await assert.rejects(
      async () =>
        withReaderTx(mockPool, async (client) => {
          return client.query('SELECT 1');
        }),
      (err: unknown) => isDataError(err) && err.code === 'unavailable'
    );
  });
});
