'use client';

import { useMemo } from 'react';
import FilterBar from '@/components/admin/research/FilterBar';
import Histogram, { type HistogramBar } from '@/components/admin/research/charts/Histogram';
import ScatterPlot, { type ScatterPoint } from '@/components/admin/research/charts/ScatterPlot';
import { useContextSaturation } from '@/lib/admin/research/queries';
import { useResearchFilters } from '@/lib/admin/research/useResearchFilters';
import ResearchQuestionBanner from '@/components/admin/research/ResearchQuestionBanner';

export default function ContextSaturationPage() {
  const { filters } = useResearchFilters();
  const { data, isLoading, error } = useContextSaturation(filters);

  const models = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.model))], [data]);

  return (
    <div className="flex flex-col gap-6">
      <ResearchQuestionBanner
        category="Context Efficiency & Attentional Degradation"
        categoryColor="#e2a355"
        question="At what % of a model's context window does tool execution reliability and reasoning accuracy begin degrading?"
        hypothesis="As context fill approaches 60-80%, prompt attentional dilution causes a 2.4x surge in parameter misconfigurations and hallucinations. Finding model-specific inflection thresholds prevents high-cost failure cascades."
        formula="η(Context_t) = f(k / WindowSize)"
      />

      <FilterBar />

      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
          {(error as Error).message}
        </div>
      )}

      {isLoading ? (
        <div className="h-64 animate-pulse rounded bg-wash" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {models.map((model) => {
            const bars: HistogramBar[] = (data?.rows ?? [])
              .filter((r) => r.model === model)
              .sort((a, b) => a.fillBucket - b.fillBucket)
              .map((r) => ({
                bucket: `${r.fillBucket * 10}–${r.fillBucket * 10 + 10}%`,
                value: r.toolErrorRate,
                sampleSize: r.sampleSize,
              }));
            const inflection = data?.inflectionPoints[model];

            return (
              <div key={model} className="rounded-lg border border-border bg-surface p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-sm font-medium text-ink">{model}</div>
                  {inflection != null && (
                    <span className="rounded-full bg-critical/10 px-2 py-0.5 text-xs text-critical">
                      Inflection at {inflection * 10}% fill
                    </span>
                  )}
                </div>
                <Histogram data={bars} valueLabel="Tool error rate" />
              </div>
            );
          })}
          {models.length === 0 && (
            <div className="rounded-md border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
              No turns with context-fill data for this range.
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 text-sm font-medium text-ink">Turn-level sample (fill % vs outcome)</div>
        <div className="mb-3 text-xs text-muted">
          Sampled turns per model, ordered by context fill — a denser cluster of red near the right
          edge means errors concentrate near the context ceiling, not just at high fill on average.
        </div>
        {isLoading ? (
          <div className="h-72 animate-pulse rounded bg-wash" />
        ) : (
          <ScatterPlot
            data={
              (data?.scatter ?? []).map(
                (s): ScatterPoint => ({
                  x: s.fillPct * 100,
                  y: s.turnIndex,
                  isError: s.toolErrorFlag,
                  label: `${s.model} · ${s.sessionId.slice(0, 8)}…`,
                }),
              )
            }
            xLabel="Context fill %"
            yLabel="Turn index"
            xFormat={(v) => `${v.toFixed(0)}%`}
          />
        )}
      </div>
    </div>
  );
}
