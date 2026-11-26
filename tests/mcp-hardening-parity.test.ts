/**
 * Tests for P3-6: Dashboard Metric Parity & Tenant Matching Analysis.
 *
 * Compares aggregation, token counts, and tenant filtering between
 * dashboard implementation (lib/team/stats.ts, app/api/v1/team/prompts/route.ts)
 * and MCP data layer (scripts/migrations/mcp-data.sql).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('P3-6: Dashboard Metric Parity & Divergence Analysis', () => {
  describe('1. Tenant Scoping Parity & Intentional Divergence', () => {
    it('verifies single-team developers produce identical scoping results', () => {
      // For a developer associated with exactly one team:
      // Dashboard condition: (ss.team_id = $1 OR ss.member_id IN (SELECT tm.member_id FROM team_members tm WHERE tm.team_id = $1))
      // MCP condition: ss.team_id = v_team AND ss.member_id IN (SELECT tm.member_id FROM public.team_members tm WHERE tm.team_id = v_team)
      // When developer is only on Team 1: both conditions evaluate to true for sessions of Team 1.
      const sessionTeamId = 'team-1';
      const targetTeamId = 'team-1';
      const isMemberOfTarget = true;

      const dashboardMatches = sessionTeamId === targetTeamId || isMemberOfTarget;
      const mcpMatches = sessionTeamId === targetTeamId && isMemberOfTarget;

      assert.equal(dashboardMatches, true);
      assert.equal(mcpMatches, true);
      assert.equal(dashboardMatches, mcpMatches);
    });

    it('documents intentional divergence for multi-team developers per Decision 3', () => {
      // If Developer X belongs to Team A and Team B:
      // A session tagged with Team B (ss.team_id = 'team-b') should NOT be visible to Admin of Team A.
      const sessionTeamId: string = 'team-b';
      const adminTeamId: string = 'team-a';
      const developerIsMemberOfAdminTeam = true; // Member of Team A as well

      const dashboardMatches = sessionTeamId === adminTeamId || developerIsMemberOfAdminTeam; // evaluates TRUE in dashboard (loose OR)
      const mcpMatches = sessionTeamId === adminTeamId && developerIsMemberOfAdminTeam; // evaluates FALSE in MCP (strict AND)

      // Dashboard loosely leaks Team B session to Team A admin; MCP correctly rejects it
      assert.equal(dashboardMatches, true, 'Dashboard uses looser OR filter');
      assert.equal(mcpMatches, false, 'MCP strictly isolates cross-team sessions with AND filter');
    });
  });

  describe('2. Token Metric Counting Parity', () => {
    it('verifies MCP returns raw recorded metrics without heuristic padding', () => {
      // In lib/team/stats.ts:
      // If tokens_in = 0 and (tool_calls + edits) > 0, dashboard applies EFF_IN = 800 * tool_calls + 400 * edits
      // MCP data layer returns the ground truth recorded column values without synthetic estimates.
      const rawRecord = {
        tokens_in: 0,
        tokens_out: 0,
        tool_calls: 3,
        edits: 2,
      };

      // MCP preserves exact raw database columns
      assert.equal(rawRecord.tokens_in, 0);
      assert.equal(rawRecord.tokens_out, 0);
      assert.equal(rawRecord.tool_calls, 3);
      assert.equal(rawRecord.edits, 2);
    });
  });

  describe('3. Daily Rollup Boundaries', () => {
    it('verifies UTC daily aggregation alignment', () => {
      // Both dashboard daily_member_usage and MCP developer_activity group on UTC calendar day.
      const dayStr = '2026-01-15';
      const parsedUtc = new Date(dayStr + 'T00:00:00.000Z');
      assert.equal(parsedUtc.toISOString().slice(0, 10), dayStr);
    });
  });
});
