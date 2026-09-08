'use client';

import FilterBar from '@/components/admin/research/FilterBar';
import Heatmap, { type HeatmapCell } from '@/components/admin/research/charts/Heatmap';
import { usePromptSpecificity } from '@/lib/admin/research/queries';
import { useResearchFilters } from '@/lib/admin/research/useResearchFilters';
import ResearchQuestionBanner from '@/components/admin/research/ResearchQuestionBanner';

interface SpecificityRow {
  tier: 'vague' | 'partial' | 'specific';
  complexityBucket: string;
  sampleSize: number;
  avgTokensPerLine: number;
  reworkRate: number;
  revertRate: number;
}

const TIER_ORDER = ['vague', 'partial', 'specific'];
const COMPLEXITY_ORDER = ['Low Complexity', 'Medium Complexity', 'High Complexity'];

export default function PromptSpecificityPage() {
  const { filters } = useResearchFilters();
  const { data, isLoading, error } = usePromptSpecificity(filters);
  const rows = (data as SpecificityRow[] | undefined) ?? [];

  const reworkCells: HeatmapCell[] = rows.map((r) => ({
    row: r.tier,
    col: r.complexityBucket,
    value: r.reworkRate,
    sampleSize: r.sampleSize,
  }));
  const revertCells: HeatmapCell[] = rows.map((r) => ({
    row: r.tier,
    col: r.complexityBucket,
    value: r.revertRate,
    sampleSize: r.sampleSize,
  }));

  return (
    <div className="flex flex-col gap-6">
      <ResearchQuestionBanner
        category="Prompt Engineering & Human Friction"
        categoryColor="#10b981"
        question="How much does prompt specificity (code snippets, stack traces, file paths) reduce developer rework and turn cascades?"
        hypothesis="Prompts with explicit stack traces and file targets achieve 73% first-turn resolution and reduce multi-turn rework loops by 3.8x compared to ambiguous instructions."
        formula="RevertRate(vague) vs RevertRate(specific)"
      />

      <FilterBar showOrg />

      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
          {(error as Error).message}
        </div>
      )}

      <p className="max-w-2xl text-sm text-muted">
        Does a specific prompt (code block, file path, or traceback present) lead to less rework and
        fewer reverts than a vague one — and does that hold as task complexity increases?
      </p>

      {isLoading ? (
        <div className="h-48 animate-pulse rounded bg-wash" />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="mb-3 text-sm font-medium text-ink">Rework rate</div>
            <Heatmap rows={TIER_ORDER} cols={COMPLEXITY_ORDER} cells={reworkCells} valueLabel="Rework rate" />
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="mb-3 text-sm font-medium text-ink">Revert rate</div>
            <Heatmap rows={TIER_ORDER} cols={COMPLEXITY_ORDER} cells={revertCells} valueLabel="Revert rate" />
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">Complexity</th>
              <th className="px-3 py-2 font-medium">Samples</th>
              <th className="px-3 py-2 font-medium">Avg tokens / line</th>
              <th className="px-3 py-2 font-medium">Rework rate</th>
              <th className="px-3 py-2 font-medium">Revert rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i} className="text-ink">
                <td className="px-3 py-2 font-mono">{r.tier}</td>
                <td className="px-3 py-2 font-mono">{r.complexityBucket}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{r.sampleSize}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{r.avgTokensPerLine.toFixed(1)}</td>
                <td className="px-3 py-2 font-mono tabular-nums">{(r.reworkRate * 100).toFixed(1)}%</td>
                <td className="px-3 py-2 font-mono tabular-nums">{(r.revertRate * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
