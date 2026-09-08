'use client';

import FilterBar from '@/components/admin/research/FilterBar';
import Histogram, { type HistogramBar } from '@/components/admin/research/charts/Histogram';
import { useDaemonCohorts } from '@/lib/admin/research/queries';
import { useResearchFilters } from '@/lib/admin/research/useResearchFilters';
import ResearchQuestionBanner from '@/components/admin/research/ResearchQuestionBanner';

export default function DaemonCohortsPage() {
  const { filters } = useResearchFilters();
  const { data, isLoading, error } = useDaemonCohorts(filters);
  const cohorts = data?.cohorts ?? [];

  const bars: HistogramBar[] = cohorts.map((c) => ({
    bucket: c.daemonVersion,
    value: c.errorRate,
    sampleSize: c.sessionCount,
  }));

  return (
    <div className="flex flex-col gap-6">
      <ResearchQuestionBanner
        category="Daemon Reliability & Sync Health"
        categoryColor="#34d399"
        question="Are specific daemon versions or client environments causing disproportionate telemetry sync errors?"
        hypothesis="Daemon updates with altered heartbeat protocols or socket timeouts can trigger batch retry storms, consuming Vercel invocation budgets."
        formula="ErrRate(Cohort_v) vs Cohort_{v-1}"
      />

      <FilterBar showOrg toolOptions={[]} />

      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
          {(error as Error).message}
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 text-sm font-medium text-ink">Error rate by daemon version</div>
        {isLoading ? <div className="h-64 animate-pulse rounded bg-wash" /> : <Histogram data={bars} valueLabel="Error rate" />}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Daemon version</th>
              <th className="px-3 py-2 font-medium">Sessions</th>
              <th className="px-3 py-2 font-medium">Error rate</th>
              <th className="px-3 py-2 font-medium">First seen</th>
              <th className="px-3 py-2 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {cohorts.map((c, i) => (
              <tr key={i} className="text-ink">
                <td className="px-3 py-2 font-mono">{c.daemonVersion}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{c.sessionCount}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{(c.errorRate * 100).toFixed(1)}%</td>
                <td className="px-3 py-2 font-mono">{new Date(c.firstSeen).toLocaleDateString()}</td>
                <td className="px-3 py-2 font-mono">{new Date(c.lastSeen).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
