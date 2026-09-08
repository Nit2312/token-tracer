import Link from 'next/link';

interface StudyCard {
  href: string;
  title: string;
  desc: string;
  tag: string;
  formula: string;
  icon: string;
  accent: string;
}

const STUDIES: StudyCard[] = [
  {
    href: '/admin/research/error-spikes',
    title: 'Error Spikes & Anomaly Detection',
    desc: 'Daily tool-error-rate trend with rolling 7-day baseline anomaly detection and per-tool root-cause drill-down.',
    tag: 'Operational Health',
    formula: 'σ > 2.5 Baseline',
    icon: '⚡',
    accent: '#ef4444',
  },
  {
    href: '/admin/research/context-saturation',
    title: 'Context Saturation Thresholds',
    desc: 'Empirical analysis of context window fill % where tool-error rate and valid-tool-call rate begin degrading per model.',
    tag: 'Context Efficiency',
    formula: 'η(Context_t) = f(k/W)',
    icon: '🧠',
    accent: '#e2a355',
  },
  {
    href: '/admin/research/prompt-specificity',
    title: 'Prompt Specificity → Efficiency Index',
    desc: 'Quantifies rework and code revert rates for highly specific prompts (code blocks, traceback, file refs) vs vague prompts.',
    tag: 'Prompt Engineering',
    formula: 'RevertRate(vague) vs RevertRate(spec)',
    icon: '🎯',
    accent: '#10b981',
  },
  {
    href: '/admin/research/verbosity-elasticity',
    title: 'Verbosity Elasticity Multipliers',
    desc: 'Measures how output token volume scales with input size across models and task intents (bug fix, refactor, greenfield).',
    tag: 'Cost Elasticity',
    formula: 'd(ln Tokens_out) / d(ln Tokens_in)',
    icon: '📈',
    accent: '#38bdf8',
  },
  {
    href: '/admin/research/cost-performance',
    title: 'Cost / Performance Pareto Frontier',
    desc: 'Maps LLMs onto a multi-objective cost vs task completion success-rate frontier across engineering workloads.',
    tag: 'Pareto Optimization',
    formula: 'min(Cost) ∧ max(Quality)',
    icon: '⚖️',
    accent: '#a855f7',
  },
  {
    href: '/admin/research/redundant-reprompt',
    title: 'Redundant Re-prompting Waste',
    desc: 'Identifies near-duplicate re-prompting patterns and quantifies avoidable token and compute expenditure.',
    tag: 'Waste Reduction',
    formula: 'Jaccard(P_t, P_{t-1}) > 0.85',
    icon: '🔁',
    accent: '#f59e0b',
  },
  {
    href: '/admin/research/daemon-cohorts',
    title: 'Daemon Cohort Regressions',
    desc: 'Cross-version comparison of agent sync health and error rates grouped by client daemon release version.',
    tag: 'Daemon Reliability',
    formula: 'ErrRate(Cohort_v) vs Cohort_{v-1}',
    icon: '📦',
    accent: '#34d399',
  },
];

export default function ResearchOverviewPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-ink font-display flex items-center gap-2">
          <span>🔬</span> AI Behavioral Research & Econometric Studies
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Empirical behavioral studies across real-world developer agent sessions. Explore how context volume,
          prompt specificity, and model selection affect token efficiency, cost frontiers, and code quality.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {STUDIES.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group relative flex flex-col justify-between overflow-hidden rounded-xl border border-border bg-surface/90 p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-brand/40 hover:shadow-xl hover:shadow-black/40"
            style={{
              background: 'radial-gradient(140% 120% at 50% 0%, rgba(226, 163, 85, 0.04), transparent 75%), var(--surface)',
            }}
          >
            {/* Top Row: Icon, Title & Tag */}
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised border border-border text-lg shadow-sm">
                  {s.icon}
                </span>
                <span
                  className="inline-flex items-center rounded-md px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider"
                  style={{
                    backgroundColor: `${s.accent}15`,
                    color: s.accent,
                    border: `1px solid ${s.accent}30`,
                  }}
                >
                  {s.tag}
                </span>
              </div>

              <h2 className="text-base font-semibold text-ink group-hover:text-brand-hi transition-colors">
                {s.title}
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-muted line-clamp-3">
                {s.desc}
              </p>
            </div>

            {/* Bottom Row: Mathematical Formula Pill & Arrow */}
            <div className="mt-5 flex items-center justify-between pt-3 border-t border-border/60">
              <code className="text-[10px] font-mono text-ink-2 bg-raised/80 px-2 py-0.5 rounded border border-border/80">
                {s.formula}
              </code>
              <span className="text-xs font-semibold text-brand opacity-0 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-1">
                Explore Study →
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
