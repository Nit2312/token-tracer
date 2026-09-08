'use client';

import FilterBar from '@/components/admin/research/FilterBar';
import StatTile from '@/components/admin/research/StatTile';
import DrilldownTable from '@/components/admin/research/DrilldownTable';
import { useRedundantReprompt } from '@/lib/admin/research/queries';
import { useResearchFilters } from '@/lib/admin/research/useResearchFilters';
import ResearchQuestionBanner from '@/components/admin/research/ResearchQuestionBanner';

interface ReprompEvent {
  sessionId: string;
  turnIndex: number;
  similarityScore: number;
  costWasted: number;
  tool: string;
  model: string;
  userName: string;
  projectName: string;
  promptText: string | null;
  prevPromptText: string | null;
}

export default function RedundantRepromptPage() {
  const { filters } = useResearchFilters();
  const { data, isLoading, error } = useRedundantReprompt(filters);

  return (
    <div className="flex flex-col gap-6">
      <ResearchQuestionBanner
        category="Compute Waste & Developer Frustration"
        categoryColor="#f59e0b"
        question="How much token spend and compute time is wasted on near-duplicate developer re-prompts?"
        hypothesis="When developer prompts fail to elicit changes, users re-send ≥85% identical prompts with minor punctuation changes, burning avoidable inference tokens."
        formula="Jaccard(P_t, P_{t-1}) ≥ 0.85"
      />

      <FilterBar showOrg />

      {error && (
        <div className="rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
          {(error as Error).message}
        </div>
      )}

      {isLoading ? (
        <div className="h-24 animate-pulse rounded bg-wash" />
      ) : data?.pilotOnly ? (
        <div className="rounded-md border border-brand-dim bg-brand-dim/40 px-4 py-3 text-sm text-ink">
          This study runs for a single pilot org at a time (similarity scoring is expensive to run
          broadly).{' '}
          {data.eligibleOrg && !data.eligibleOrg.startsWith('None configured')
            ? <>Set the <span className="font-mono">org</span> filter above to <span className="font-mono">{data.eligibleOrg}</span> to see it.</>
            : 'No pilot org is configured — set ENABLE_REPROMPT_ANALYSIS_ORG_ID.'}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatTile label="Redundant re-prompt events" value={String(data?.events?.length ?? 0)} />
            <StatTile
              label="Total cost wasted"
              value={`$${((data?.events as ReprompEvent[] | undefined)?.reduce((s, e) => s + Number(e.costWasted || 0), 0) ?? 0).toFixed(4)}`}
            />
          </div>
          <DrilldownTable<ReprompEvent>
            columns={[
              { key: 'userName', label: 'User' },
              { key: 'projectName', label: 'Project' },
              { key: 'similarityScore', label: 'Similarity', render: (r) => `${(r.similarityScore * 100).toFixed(0)}%` },
              { key: 'costWasted', label: 'Cost wasted', render: (r) => `$${Number(r.costWasted).toFixed(4)}` },
              { key: 'promptText', label: 'Prompt', render: (r) => (r.promptText ?? '—').slice(0, 60) },
            ]}
            rows={(data?.events as ReprompEvent[]) ?? []}
            emptyLabel="No redundant re-prompts found in this range."
          />
        </>
      )}
    </div>
  );
}
