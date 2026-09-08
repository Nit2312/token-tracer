import React from 'react';

interface ResearchQuestionBannerProps {
  category: string;
  categoryColor?: string;
  question: string;
  hypothesis: string;
  formula?: string;
  badge?: string;
}

export default function ResearchQuestionBanner({
  category,
  categoryColor = '#e2a355',
  question,
  hypothesis,
  formula,
  badge = 'SUPERADMIN RESEARCH SUITE',
}: ResearchQuestionBannerProps) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-border p-6 shadow-xl"
      style={{
        background: 'linear-gradient(135deg, rgba(226, 163, 85, 0.07) 0%, rgba(20, 16, 12, 0.95) 60%, rgba(13, 10, 7, 1) 100%)',
        boxShadow: '0 10px 30px -10px rgba(0, 0, 0, 0.5)',
      }}
    >
      {/* Background ambient glow circle */}
      <div
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full blur-3xl opacity-20"
        style={{ backgroundColor: categoryColor }}
      />

      <div className="relative z-10 flex flex-col gap-3">
        {/* Top Badges Row */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center rounded-md px-2.5 py-0.5 text-[10.5px] font-mono font-semibold uppercase tracking-wider"
              style={{
                backgroundColor: `${categoryColor}15`,
                color: categoryColor,
                border: `1px solid ${categoryColor}35`,
              }}
            >
              {category}
            </span>
            <span className="text-[11px] font-mono text-muted">•</span>
            <span className="text-[11px] font-mono text-ink-2 font-medium tracking-wide uppercase">
              {badge}
            </span>
          </div>

          {formula && (
            <div className="flex items-center gap-1.5 rounded-lg bg-raised/80 px-2.5 py-1 border border-border/70 backdrop-blur-sm">
              <span className="text-[10px] text-muted uppercase font-mono">Formula:</span>
              <code className="text-[11px] font-mono text-brand font-semibold">{formula}</code>
            </div>
          )}
        </div>

        {/* Primary Research Question */}
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-ink font-display leading-snug">
          {question}
        </h1>

        {/* Hypothesis & Context */}
        <p className="max-w-4xl text-xs sm:text-sm text-muted leading-relaxed font-body">
          <span className="font-semibold text-ink-2">Hypothesis / Context: </span>
          {hypothesis}
        </p>
      </div>
    </div>
  );
}
