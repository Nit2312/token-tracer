'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import FilterBar from '@/components/admin/research/FilterBar';
import ChartTooltip from '@/components/admin/research/charts/ChartTooltip';
import { useCostPerformanceFrontier } from '@/lib/admin/research/queries';
import { useResearchFilters } from '@/lib/admin/research/useResearchFilters';
import ResearchQuestionBanner from '@/components/admin/research/ResearchQuestionBanner';

interface OutcomePoint {
  model: string;
  avgCost: number;
  successRate: number;
  sessionCount: number;
  isPareto?: boolean;
}

export default function CostPerformancePage() {
  const { filters } = useResearchFilters();
  const [intent, setIntent] = useState<string | null>(null);
  const { data, isLoading, error } = useCostPerformanceFrontier(filters, intent);

  const grouped = useMemo(() => (data as Record<string, OutcomePoint[]> | undefined) ?? {}, [data]);
  const intents = useMemo(() => Object.keys(grouped), [grouped]);
  const activeIntent = intent ?? intents[0] ?? null;
  const points = activeIntent ? grouped[activeIntent] ?? [] : [];

  const frontier = points.filter((p) => p.isPareto);
  const dominated = points.filter((p) => !p.isPareto);

  return (
    <div className="flex flex-col gap-6">
      <ResearchQuestionBanner
        category="Pareto Economics & Model Selection"
        categoryColor="#a855f7"
        question="Which LLM delivers the highest code yield per dollar spent on the multi-objective Pareto efficiency frontier?"
        hypothesis="Models on the Pareto frontier maximize code acceptance rate per $1.00 token spend, while dominated models waste up to 45% budget without improving solution correctness."
        formula="min(Cost) ∧ max(Quality)"
      />

      <FilterBar />

      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
          {(error as Error).message}
        </div>
      )}

      <select
        value={activeIntent ?? ''}
        onChange={(e) => setIntent(e.target.value || null)}
        className="w-fit rounded-md border border-border bg-page px-2 py-1 text-xs text-ink"
      >
        {intents.map((i) => (
          <option key={i} value={i}>
            {i}
          </option>
        ))}
      </select>

      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 text-sm font-medium text-ink">Cost vs. success rate — {activeIntent ?? '—'}</div>
        {isLoading ? (
          <div className="h-72 animate-pulse rounded bg-wash" />
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" strokeDasharray="0" />
                <XAxis
                  type="number"
                  dataKey="avgCost"
                  name="Avg cost"
                  tick={{ fill: 'var(--muted)', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--grid)' }}
                  tickFormatter={(v) => `$${v.toFixed(3)}`}
                />
                <YAxis
                  type="number"
                  dataKey="successRate"
                  name="Success rate"
                  domain={[0, 1]}
                  tick={{ fill: 'var(--muted)', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--border)' }}
                  content={({ active, payload }) => {
                    const p = payload?.[0]?.payload as OutcomePoint | undefined;
                    if (!p) return null;
                    return (
                      <ChartTooltip
                        active={active}
                        title={p.model}
                        rows={[
                          { label: 'Avg cost', value: `$${p.avgCost.toFixed(4)}` },
                          { label: 'Success rate', value: `${(p.successRate * 100).toFixed(1)}%` },
                          { label: 'Sessions', value: String(p.sessionCount) },
                          {
                            label: 'Frontier',
                            value: p.isPareto ? 'yes' : 'no',
                            color: p.isPareto ? 'var(--good)' : 'var(--muted)',
                          },
                        ]}
                      />
                    );
                  }}
                />
                <Scatter data={dominated} fill="var(--muted)" fillOpacity={0.5} r={5} isAnimationActive={false} />
                <Scatter data={frontier} fill="var(--good)" r={6} isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="mt-2 flex items-center gap-4 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--good)' }} />
            On frontier ({frontier.length})
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--muted)' }} />
            Dominated ({dominated.length})
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Avg cost</th>
              <th className="px-3 py-2 font-medium">Success rate</th>
              <th className="px-3 py-2 font-medium">Sessions</th>
              <th className="px-3 py-2 font-medium">Frontier</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {[...frontier, ...dominated].map((p, i) => (
              <tr key={i} className="text-ink">
                <td className="px-3 py-2 font-mono">{p.model}</td>
                <td className="px-3 py-2 font-mono tabular-nums">${p.avgCost.toFixed(4)}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{(p.successRate * 100).toFixed(1)}%</td>
                <td className="px-3 py-2 font-mono tabular-nums">{p.sessionCount}</td>
                <td className="px-3 py-2">{p.isPareto ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
