'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';
import FilterBar from '@/components/admin/research/FilterBar';
import ChartTooltip from '@/components/admin/research/charts/ChartTooltip';
import { useVerbosityElasticity } from '@/lib/admin/research/queries';
import { useResearchFilters } from '@/lib/admin/research/useResearchFilters';
import ResearchQuestionBanner from '@/components/admin/research/ResearchQuestionBanner';

interface Stat {
  model: string;
  intentCategory: string;
  slope: number;
  intercept: number;
  r2: number;
  sampleSize: number;
}
interface Point {
  model: string;
  intentCategory: string;
  x: number;
  y: number;
  filesTouched: number;
}

export default function VerbosityElasticityPage() {
  const { filters } = useResearchFilters();
  const [intent, setIntent] = useState<string | null>(null);
  const { data, isLoading, error } = useVerbosityElasticity(filters, intent);

  const stats = useMemo(() => (data?.stats as Stat[] | undefined) ?? [], [data]);
  const points = (data?.points as Point[] | undefined) ?? [];
  const intents = useMemo(() => [...new Set(stats.map((s) => s.intentCategory))], [stats]);

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const models = useMemo(() => [...new Set(stats.map((s) => s.model))], [stats]);
  const activeModel = selectedModel ?? models[0] ?? null;

  const filteredPoints = points.filter((p) => p.model === activeModel && (!intent || p.intentCategory === intent));
  const activeStat = stats.find((s) => s.model === activeModel && (!intent || s.intentCategory === intent));

  const regressionLine = useMemo(() => {
    if (!activeStat || !filteredPoints.length || activeStat.slope == null || activeStat.intercept == null) return [];
    const xs = filteredPoints.map((p) => p.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    return [
      { x: minX, yLine: activeStat.slope * minX + activeStat.intercept },
      { x: maxX, yLine: activeStat.slope * maxX + activeStat.intercept },
    ];
  }, [activeStat, filteredPoints]);

  return (
    <div className="flex flex-col gap-6">
      <ResearchQuestionBanner
        category="Token Elasticity & Output Verbosity"
        categoryColor="#38bdf8"
        question="How does token output volume scale relative to input context across models and task types?"
        hypothesis="Certain models exhibit super-linear verbosity growth on simple bug-fixes, inflating output costs without generating net usable code changes."
        formula="d(ln Tokens_out) / d(ln Tokens_in)"
      />

      <FilterBar />

      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
          {(error as Error).message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={activeModel ?? ''}
          onChange={(e) => setSelectedModel(e.target.value || null)}
          className="rounded-md border border-border bg-page px-2 py-1 text-xs text-ink"
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          value={intent ?? ''}
          onChange={(e) => setIntent(e.target.value || null)}
          className="rounded-md border border-border bg-page px-2 py-1 text-xs text-ink"
        >
          <option value="">All intents</option>
          {intents.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium text-ink">Input vs. output tokens — {activeModel ?? '—'}</div>
          {activeStat && (
            <div className="text-xs text-muted">
              slope {activeStat.slope != null ? activeStat.slope.toFixed(2) : '—'} · R² {activeStat.r2 != null ? activeStat.r2.toFixed(2) : '—'} · n={activeStat.sampleSize}
            </div>
          )}
        </div>
        {isLoading ? (
          <div className="h-72 animate-pulse rounded bg-wash" />
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer>
              <ComposedChart margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" strokeDasharray="0" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="Input tokens"
                  tick={{ fill: 'var(--muted)', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--grid)' }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="Output tokens"
                  tick={{ fill: 'var(--muted)', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--border)' }}
                  content={({ active, payload }) => {
                    const p = payload?.[0]?.payload as Point | undefined;
                    if (!p || !('filesTouched' in p)) return null;
                    return (
                      <ChartTooltip
                        active={active}
                        rows={[
                          { label: 'Input tokens', value: String(p.x) },
                          { label: 'Output tokens', value: String(p.y), color: 'var(--brand)' },
                          { label: 'Files touched', value: String(p.filesTouched) },
                        ]}
                      />
                    );
                  }}
                />
                <Scatter data={filteredPoints} fill="var(--brand)" fillOpacity={0.5} r={3} isAnimationActive={false} />
                <Line
                  data={regressionLine}
                  dataKey="yLine"
                  stroke="var(--critical)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  legendType="none"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <span className="inline-block h-0.5 w-3 rounded" style={{ background: 'var(--critical)' }} />
          Fitted regression line
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Intent</th>
              <th className="px-3 py-2 font-medium">Slope</th>
              <th className="px-3 py-2 font-medium">R²</th>
              <th className="px-3 py-2 font-medium">Samples</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {stats.map((s, i) => (
              <tr key={i} className="text-ink">
                <td className="px-3 py-2 font-mono">{s.model}</td>
                <td className="px-3 py-2 font-mono">{s.intentCategory}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{s.slope != null ? s.slope.toFixed(3) : '—'}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{s.r2 != null ? s.r2.toFixed(3) : '—'}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{s.sampleSize}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
