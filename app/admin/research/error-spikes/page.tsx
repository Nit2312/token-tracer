'use client';

import { useMemo, useState } from 'react';
import FilterBar from '@/components/admin/research/FilterBar';
import StatTile from '@/components/admin/research/StatTile';
import DrilldownTable from '@/components/admin/research/DrilldownTable';
import LineSeries, { type LineSeriesPoint } from '@/components/admin/research/charts/LineSeries';
import { useErrorSpikes } from '@/lib/admin/research/queries';
import { useResearchFilters } from '@/lib/admin/research/useResearchFilters';

interface DrilldownRow {
  sessionId: string;
  toolName: string;
  toolArgsSummary: string | null;
  createdAt: string;
  model: string;
  tool: string;
  promptText: string | null;
}

import ResearchQuestionBanner from '@/components/admin/research/ResearchQuestionBanner';

export default function ErrorSpikesPage() {
  const { filters } = useResearchFilters();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const { data, isLoading, error } = useErrorSpikes(filters, selectedDay);

  const points: LineSeriesPoint[] = useMemo(
    () =>
      (data?.series ?? []).map((r) => ({
        x: String(r.day).slice(5, 10),
        y: Number(r.errorRate),
        isFlagged: r.isSpike,
      })),
    [data],
  );

  const spikeCount = data?.series.filter((r) => r.isSpike).length ?? 0;
  const latest = data?.series[data.series.length - 1];

  const rawDayFor = (label: string) => data?.series.find((r) => String(r.day).slice(5, 10) === label)?.day ?? null;

  return (
    <div className="flex flex-col gap-6">
      <ResearchQuestionBanner
        category="Operational Health & Tool Diagnostics"
        categoryColor="#ef4444"
        question="Why did tool failure rates spike on specific dates, and which tool arguments or prompt payloads triggered anomalous breakdowns?"
        hypothesis="Spikes exceeding 2.5σ baseline indicate model context confusion, deprecated tool interfaces, or fragile multi-file edit loops that require immediate admin intervention."
        formula="σ > 2.5 Baseline"
      />

      <FilterBar showOrg />

      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
          {(error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Latest error rate" value={latest ? `${(latest.errorRate * 100).toFixed(1)}%` : '—'} />
        <StatTile
          label="Spike days in range"
          value={String(spikeCount)}
          delta={spikeCount > 0 ? 'above 2σ baseline' : undefined}
          deltaGood={false}
        />
        <StatTile label="Total assistant turns" value={String(data?.series.reduce((s, r) => s + r.totalTurns, 0) ?? 0)} />
      </div>

      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 text-sm font-medium text-ink">Daily tool-error rate</div>
        {isLoading ? (
          <div className="h-64 animate-pulse rounded bg-wash" />
        ) : (
          <LineSeries
            data={points}
            yLabel="Error rate"
            yFormat={(v) => `${(v * 100).toFixed(0)}%`}
            onPointClick={(p) => setSelectedDay(rawDayFor(p.x))}
          />
        )}
        <div className="mt-2 text-xs text-muted">Click a point to drill into the tool calls behind that day.</div>
      </div>

      {selectedDay && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium text-ink">Drill-down — {selectedDay}</div>
            <button type="button" onClick={() => setSelectedDay(null)} className="text-xs text-muted hover:text-ink">
              Clear
            </button>
          </div>
          <DrilldownTable<DrilldownRow>
            columns={[
              { key: 'toolName', label: 'Tool' },
              { key: 'toolArgsSummary', label: 'Args' },
              { key: 'model', label: 'Model' },
              { key: 'sessionId', label: 'Session' },
              { key: 'createdAt', label: 'At', render: (r) => new Date(r.createdAt).toLocaleTimeString() },
            ]}
            rows={(data?.drilldown as DrilldownRow[] | null) ?? []}
            emptyLabel="No failing tool calls recorded for this day."
          />
        </div>
      )}
    </div>
  );
}
