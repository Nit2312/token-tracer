/**
 * Team admin dashboard page (/team).
 * Features custom filters (Member, Token Usage Range, AI Agent Source),
 * Model Pricing Rates Management ($/1M tokens), API cost recalculation,
 * vertical sidebar, and deep analytics.
 */
import type { Metadata } from 'next';
import Script from 'next/script';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionFromCookie } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Team Analytics — Visualisation Dashboard',
  description: 'Comprehensive team agent analytics — member token logs, custom model pricing, API cost recalculation, and scorecards.',
};

export default async function TeamDashboardPage() {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());

  if (!session || (session.role !== 'admin' && session.role !== 'superadmin' && session.role !== 'user')) {
    redirect('/');
  }

  return (
    <div suppressHydrationWarning>
      <Script src="/impersonation.js" strategy="afterInteractive" />
      {/* Shown only until the cookie session check resolves, so a slow
          network never flashes the legacy password-login screen below
          in front of an already-authenticated user. */}
      <div id="boot-loading" className="boot-loading" aria-busy="true" suppressHydrationWarning>
        <div className="tt-loader" role="status">
          <div className="tt-loader-orbit" aria-hidden="true">
            <div className="tt-loader-ring" />
            <div className="tt-loader-ring tt-loader-ring--inner" />
            <div className="tt-loader-core">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
                <circle cx="12" cy="12" r="4" />
              </svg>
            </div>
            <i className="tt-loader-token t1" />
            <i className="tt-loader-token t2" />
            <i className="tt-loader-token t3" />
          </div>
          <p className="tt-loader-label">Tracing <em>team</em> tokens…</p>
        </div>
      </div>

      <div id="login-screen" className="team-login" hidden suppressHydrationWarning>
        <form id="login-form">
          <h1>Team analytics</h1>
          <p className="muted">Admin login — personal dashboard is at <code>/</code></p>
          <label>
            Password
            <input id="login-password" type="password" autoComplete="current-password" required />
          </label>
          <button type="submit" className="hbtn primary" id="login-submit">Sign in</button>
          <p id="login-error" className="error" role="alert" aria-live="assertive" hidden></p>
        </form>
      </div>

      <div id="app" hidden className="team-app-layout">
        {/* Mobile-only topbar: shown under 880px, hosts the hamburger toggle */}
        <div className="mobile-topbar">
          <button type="button" id="team-nav-toggle" className="mobile-nav-toggle" aria-label="Toggle menu" aria-expanded="false" aria-controls="team-sidebar-nav">
            <span></span><span></span><span></span>
          </button>
          <div className="wordmark">
            <h1>team</h1>
          </div>
          <div className="mobile-topbar-spacer" />
        </div>
        <div id="team-nav-overlay" className="nav-overlay"></div>

        {/* Left Vertical Sidebar */}
        <aside className="team-sidebar" id="team-sidebar-nav">
          <div className="sidebar-brand">
            <div className="wordmark">
              <h1>team</h1>
              <span className="eyebrow">Analytics</span>
            </div>
          </div>

          <div className="sidebar-team-select">
            <label className="muted">Current Team</label>
            <select id="team-select" aria-label="Team"></select>
          </div>

          <nav className="team-sidebar-nav" id="team-tabs" role="tablist" aria-label="Team analytics sections">
            <button type="button" id="tabbtn-overview" className="tab-btn active" data-tab="tab-overview" data-title="Overview & Stats" role="tab" aria-selected="true" aria-controls="tab-overview" tabIndex={0}>
              <span className="nav-icon" aria-hidden="true">📊</span> Overview & Stats
            </button>
            <button type="button" id="tabbtn-prompts" className="tab-btn" data-tab="tab-prompts" data-title="Prompts & Trajectories" role="tab" aria-selected="false" aria-controls="tab-prompts" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">📝</span> Prompt Explorer
            </button>
            <button type="button" id="tabbtn-members" className="tab-btn" data-tab="tab-members" data-title="Member Token Logs" role="tab" aria-selected="false" aria-controls="tab-members" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">👥</span> Member Token Logs
            </button>
            <button type="button" id="tabbtn-deep-dive" className="tab-btn" data-tab="tab-deep-dive" data-title="Deep-Dive Token Analysis" role="tab" aria-selected="false" aria-controls="tab-deep-dive" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">🔬</span> Deep-Dive Analysis
            </button>
            <button type="button" id="tabbtn-projects" className="tab-btn" data-tab="tab-projects" data-title="Projects & Repos" role="tab" aria-selected="false" aria-controls="tab-projects" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">📁</span> Projects & Repos
            </button>
            <button type="button" id="tabbtn-files" className="tab-btn" data-tab="tab-files" data-title="Code Impact Map" role="tab" aria-selected="false" aria-controls="tab-files" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">📄</span> Code Impact Map
            </button>
            <button type="button" id="tabbtn-logs" className="tab-btn" data-tab="tab-logs" data-title="Session Logs" role="tab" aria-selected="false" aria-controls="tab-logs" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">📜</span> Session Logs
            </button>
            <button type="button" id="tabbtn-pricing" className="tab-btn" data-tab="tab-pricing" data-title="Model Pricing" role="tab" aria-selected="false" aria-controls="tab-pricing" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">💲</span> Model Pricing Rates
            </button>
            <button type="button" id="tabbtn-settings" className="tab-btn" data-tab="tab-settings" data-title="Manage Members" role="tab" aria-selected="false" aria-controls="tab-settings" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">⚙️</span> Manage Members
            </button>
          </nav>

          <div className="sidebar-footer">
            <button type="button" id="team-profile-btn" className="hbtn sidebar-profile-btn" title="Account & Profile Settings">
              <span className="profile-btn-icon" aria-hidden="true">👤</span>
              <span id="team-admin-name" className="sidebar-user-name">Profile</span>
            </button>
            <div className="sidebar-footer-links">
              <a href="/" className="sidebar-link">← Personal Dashboard</a>
              <button id="team-logout-btn" className="hbtn sidebar-logout-btn">Sign out</button>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <div className="team-main-wrapper">
          {/* Header Controls & Filters */}
          <header className="team-header">
            <div className="team-header-top">
              <h1 id="team-page-title" className="team-page-title">Overview &amp; Stats</h1>
            </div>
            <div className="header-filters-row">
              {/* Date Presets */}
              <div id="range-presets" className="range-presets" role="tablist"></div>

              {/* Mobile-only collapsible trigger for the remaining filters */}
              <button
                type="button"
                id="filters-toggle"
                className="hbtn filters-toggle-btn"
                aria-expanded="false"
                aria-controls="filters-more"
              >
                <span aria-hidden="true">⚙️</span> Filters
                <span id="filters-badge" className="filters-badge" hidden>0</span>
              </button>

              <div id="filters-more" className="filters-more">
                <div className="filters-more-grid">
                  <label className="filter-label">From <input id="range-from" type="date" /></label>
                  <label className="filter-label">To <input id="range-to" type="date" /></label>

                  {/* Member Filter (Multi-Select) */}
                  <div className="filter-label-group" id="global-member-filter-group">
                    <span className="filter-group-title">Member</span>
                    <div className="multi-member-picker" id="global-member-picker-wrap">
                      <button
                        type="button"
                        id="global-member-picker-btn"
                        className="filter-picker-btn"
                        aria-expanded="false"
                      >
                        <span id="global-member-picker-label">👥 All Members</span>
                        <span style={{ fontSize: '9px', opacity: 0.7 }}>▼</span>
                      </button>

                      <div id="global-member-dropdown" className="member-dropdown-popover" style={{ left: 0, right: 'auto' }} hidden>
                        <div className="member-dropdown-header">
                          <input
                            type="text"
                            id="global-member-search"
                            placeholder="Search members…"
                            className="search-input"
                            style={{ width: '100%', fontSize: '12px', padding: '5px 8px', boxSizing: 'border-box' }}
                          />
                          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                            <button type="button" id="global-select-all-btn" className="hbtn" style={{ fontSize: '11px', padding: '3px 8px', flex: 1 }}>Select All</button>
                            <button type="button" id="global-clear-all-btn" className="hbtn" style={{ fontSize: '11px', padding: '3px 8px', flex: 1 }}>Clear</button>
                          </div>
                        </div>
                        <div id="global-member-checkbox-list" className="member-checkbox-list" style={{ maxHeight: '220px', overflowY: 'auto', padding: '6px 0' }}></div>
                      </div>
                    </div>
                  </div>

                  {/* Source Filter */}
                  <label className="filter-label">AI Tool
                    <select id="global-source-filter">
                      <option value="all">All Tools</option>
                      <option value="cursor">Cursor</option>
                      <option value="claude-code">Claude Code</option>
                      <option value="codex">Codex</option>
                    </select>
                  </label>

                  {/* Token Usage Range Filter */}
                  <label className="filter-label filter-label-wide">Min Tokens
                    <select id="global-min-tokens-filter">
                      <option value="0">All Usage (0+)</option>
                      <option value="10000">&gt; 10k Tokens</option>
                      <option value="100000">&gt; 100k Tokens</option>
                      <option value="1000000">&gt; 1M Tokens</option>
                      <option value="10000000">&gt; 10M Tokens</option>
                    </select>
                  </label>
                </div>

                <button id="refresh" className="hbtn primary" title="Refresh stats">↻ Apply Filters</button>
              </div>
            </div>
          </header>

          <main className="team-main">
            <div id="app-error" className="app-error" role="alert" aria-live="assertive" hidden></div>
            <div id="data-loading" className="data-loading" hidden aria-busy="true"></div>
            <div id="app-loading" className="app-loading" hidden aria-busy="true">
              <div className="app-loading-hero">
                <div className="tt-loader" role="status">
                  <div className="tt-loader-orbit" aria-hidden="true">
                    <div className="tt-loader-ring" />
                    <div className="tt-loader-ring tt-loader-ring--inner" />
                    <div className="tt-loader-core">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
                        <circle cx="12" cy="12" r="4" />
                      </svg>
                    </div>
                    <i className="tt-loader-token t1" />
                    <i className="tt-loader-token t2" />
                    <i className="tt-loader-token t3" />
                  </div>
                  <p className="tt-loader-label">Gathering <em>analytics</em>…</p>
                </div>
              </div>
              <div className="skeleton-cards" aria-hidden="true">
                <div className="skeleton-stat"><div className="skeleton" /><div className="skeleton" /></div>
                <div className="skeleton-stat"><div className="skeleton" /><div className="skeleton" /></div>
                <div className="skeleton-stat"><div className="skeleton" /><div className="skeleton" /></div>
                <div className="skeleton-stat"><div className="skeleton" /><div className="skeleton" /></div>
                <div className="skeleton-stat"><div className="skeleton" /><div className="skeleton" /></div>
                <div className="skeleton-stat"><div className="skeleton" /><div className="skeleton" /></div>
              </div>
              <div className="grid-2" aria-hidden="true">
                <div className="skeleton-panel">
                  <div className="skeleton skeleton-title" />
                  <div className="skeleton skeleton-row" />
                  <div className="skeleton skeleton-row" />
                  <div className="skeleton skeleton-row" />
                </div>
                <div className="skeleton-panel">
                  <div className="skeleton skeleton-title" />
                  <div className="skeleton skeleton-row" style={{ height: '160px' }} />
                </div>
              </div>
              <span className="visually-hidden">Loading team analytics…</span>
            </div>
            <div id="app-content">

              {/* TAB 1: OVERVIEW & KEY STATS */}
              <section id="tab-overview" className="tab-content active" role="tabpanel" aria-labelledby="tabbtn-overview">
                <div className="cards" id="totals"></div>

                <section className="panel" id="at-risk-panel" hidden>
                  <h2>⚠️ At-Risk Members</h2>
                  <div id="at-risk"></div>
                </section>

                <div className="grid-2">
                  <section className="panel">
                    <h2>Member Token & Cost Summary</h2>
                    <div id="leaderboard" className="table-wrap"></div>
                  </section>
                  <section className="panel">
                    <h2>AI Tools & Accounts Distribution</h2>
                    <div id="by-source"></div>
                  </section>
                </div>

                <div className="grid-2">
                  <section className="panel">
                    <h2>Daily Token Flow</h2>
                    <div id="by-day"></div>
                  </section>
                  <section className="panel">
                    <h2>Top Tools Called</h2>
                    <div id="top-tools"></div>
                  </section>
                </div>

                <section className="panel">
                  <h2>Activity Rhythm</h2>
                  <div id="activity-rhythm"></div>
                </section>
              </section>

              {/* TAB: PROMPTS & TRAJECTORIES */}
              <section id="tab-prompts" className="tab-content" role="tabpanel" aria-labelledby="tabbtn-prompts" hidden>
                <div className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Prompt Trajectories</h2>
                      <span className="muted">Recent AI coding agent prompts, models, and token metrics</span>
                    </div>
                  </div>
                  <div id="prompts-table" className="table-wrap"></div>
                  <div className="pagination" style={{ display: 'flex', gap: '12px', marginTop: '16px', justifyContent: 'center', alignItems: 'center' }}>
                    <button id="prompts-prev-btn" className="hbtn small-btn">&larr; Previous</button>
                    <span id="prompts-page-info" style={{ alignSelf: 'center', fontSize: '13px' }}>Page 1 of 1</span>
                    <button id="prompts-next-btn" className="hbtn small-btn">Next &rarr;</button>
                  </div>
                </div>
              </section>

              {/* TAB 4: MEMBER DEEP DIVE & FILES */}
              <section id="tab-members" className="tab-content" role="tabpanel" aria-labelledby="tabbtn-members" hidden>
                <div className="panel-head">
                  <div>
                    <h2>Per-Member Drilldown</h2>
                    <span className="muted">Token, project, model, and edit activity by member</span>
                  </div>
                  <div className="filter-group">
                    <button type="button" id="collapse-all-members" className="hbtn hbtn-sm">
                      Collapse all
                    </button>
                    <button type="button" id="expand-all-members" className="hbtn hbtn-sm">
                      Expand all
                    </button>
                    <label className="member-filter-label" htmlFor="member-filter-select">Member</label>
                    <select id="member-filter-select" aria-label="Filter by member"></select>
                  </div>
                </div>
                <div id="member-drilldown-cards"></div>
              </section>

              {/* TAB: DEEP-DIVE TOKEN ANALYSIS */}
              <section id="tab-deep-dive" className="tab-content" role="tabpanel" aria-labelledby="tabbtn-deep-dive" hidden>
                <div className="panel" style={{ padding: '24px' }}>
                  <div className="panel-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', borderBottom: '1px solid var(--border)', paddingBottom: '16px', marginBottom: '16px' }}>
                    <div>
                      <h2 style={{ fontSize: '20px', margin: '0 0 4px 0' }}>🔬 Deep-Dive Token Analysis</h2>
                      <span className="muted" style={{ fontSize: '12.5px' }}>
                        Multi-dimensional breakdown across selected developers, repositories, models, cache efficiencies, files &amp; runaway sessions.
                      </span>
                    </div>

                    {/* Multi-Member Selector Toolbar */}
                    <div className="deep-dive-toolbar" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <div className="multi-member-picker" id="dd-member-picker-wrap">
                        <button type="button" id="dd-member-picker-btn" className="hbtn" aria-expanded="false" style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '220px', justifyContent: 'space-between' }}>
                          <span id="dd-member-picker-label">👥 Select Members (All)</span>
                          <span style={{ fontSize: '10px' }}>▼</span>
                        </button>

                        <div id="dd-member-dropdown" className="member-dropdown-popover" hidden>
                          <div className="member-dropdown-header">
                            <input type="text" id="dd-member-search" placeholder="Search members…" className="search-input" style={{ width: '100%', fontSize: '12px', padding: '5px 8px', boxSizing: 'border-box' }} />
                            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                              <button type="button" id="dd-select-all-btn" className="hbtn" style={{ fontSize: '11px', padding: '3px 8px', flex: 1 }}>Select All</button>
                              <button type="button" id="dd-clear-all-btn" className="hbtn" style={{ fontSize: '11px', padding: '3px 8px', flex: 1 }}>Clear</button>
                            </div>
                          </div>
                          <div id="dd-member-checkbox-list" className="member-checkbox-list" style={{ maxHeight: '220px', overflowY: 'auto', padding: '6px 0' }}></div>
                        </div>
                      </div>

                      <button type="button" id="dd-apply-btn" className="hbtn primary">Analyze Selection</button>
                      <button type="button" id="dd-refresh-btn" className="hbtn" title="Refresh data">🔄</button>
                    </div>
                  </div>

                  {/* Selected member chips bar */}
                  <div id="dd-selected-chips-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px', alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: '11.5px', fontWeight: 600 }}>Active Selection:</span>
                    <div id="dd-selected-chips-list" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}></div>
                  </div>

                  {/* Loading State */}
                  <div id="dd-tab-loading" className="data-loading" hidden aria-busy="true" style={{ padding: '40px', textAlign: 'center' }}>
                    <p className="muted">Analyzing token usage across selected members &amp; repositories…</p>
                  </div>

                  {/* Main Content View */}
                  <div id="dd-tab-content">
                    {/* Stat Cards KPI Row */}
                    <div className="kpi-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '14px', marginBottom: '24px' }}>
                      <div className="kpi-card kpi-card--accent-purple">
                        <div className="kpi-body">
                          <div className="kpi-label">Total Volume &amp; Spend</div>
                          <div className="kpi-value" id="dd-kpi-tokens">—</div>
                          <span className="kpi-sub" id="dd-kpi-cost">—</span>
                        </div>
                      </div>
                      <div className="kpi-card kpi-card--accent-blue">
                        <div className="kpi-body">
                          <div className="kpi-label">Context vs Output</div>
                          <div className="kpi-value" id="dd-kpi-in-out">—</div>
                          <span className="kpi-sub" id="dd-kpi-cache">—</span>
                        </div>
                      </div>
                      <div className="kpi-card kpi-card--accent-green">
                        <div className="kpi-body">
                          <div className="kpi-label">Activity &amp; Sessions</div>
                          <div className="kpi-value" id="dd-kpi-sessions">—</div>
                          <span className="kpi-sub" id="dd-kpi-avg">—</span>
                        </div>
                      </div>
                      <div className="kpi-card kpi-card--accent-yellow">
                        <div className="kpi-body">
                          <div className="kpi-label">Code Impact &amp; Loops</div>
                          <div className="kpi-value" id="dd-kpi-edits">—</div>
                          <span className="kpi-sub" id="dd-kpi-tools">—</span>
                        </div>
                      </div>
                    </div>

                    {/* Multi-Member Comparison Table */}
                    <div id="dd-member-comparison-section" className="panel-card" style={{ marginBottom: '24px', background: 'var(--surface-overlay, #151928)', border: '1px solid var(--border)' }} hidden>
                      <div className="panel-card-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                        <span className="panel-card-title" style={{ fontWeight: 600, fontSize: '14px' }}>👥 Selected Members Usage Comparison</span>
                        <span style={{ fontSize: '11.5px', color: 'var(--muted)', display: 'block', marginTop: '2px' }}>
                          Side-by-side volume, cost, code impact, and loop comparison across selected members
                        </span>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Member</th>
                              <th>Sessions</th>
                              <th>In / Out Tokens</th>
                              <th>Total Tokens</th>
                              <th>Share</th>
                              <th>API Cost</th>
                              <th>Edits / Lines</th>
                              <th>Loops / Errs</th>
                            </tr>
                          </thead>
                          <tbody id="dd-member-comparison-tbody"></tbody>
                        </table>
                      </div>
                    </div>

                    {/* Two-Column: Projects & Models */}
                    <div className="analytics-two-col" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '20px', marginBottom: '24px' }}>
                      <div className="panel-card" style={{ background: 'var(--surface-overlay, #151928)', border: '1px solid var(--border)' }}>
                        <div className="panel-card-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                          <span className="panel-card-title" style={{ fontWeight: 600, fontSize: '14px' }}>📁 Projects &amp; Repositories Burn</span>
                          <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block' }}>Where tokens were spent</span>
                        </div>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Project</th>
                                <th>Tools</th>
                                <th>Sessions</th>
                                <th>Volume</th>
                                <th>Share</th>
                                <th>Cost</th>
                              </tr>
                            </thead>
                            <tbody id="dd-projects-tbody"></tbody>
                          </table>
                        </div>
                      </div>

                      <div className="panel-card" style={{ background: 'var(--surface-overlay, #151928)', border: '1px solid var(--border)' }}>
                        <div className="panel-card-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                          <span className="panel-card-title" style={{ fontWeight: 600, fontSize: '14px' }}>🤖 Models &amp; Cache Efficiency</span>
                          <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block' }}>Model context &amp; cache hit rates</span>
                        </div>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Model</th>
                                <th>Source</th>
                                <th>Sessions</th>
                                <th>Cache Hit %</th>
                                <th>Tokens</th>
                                <th>Cost</th>
                              </tr>
                            </thead>
                            <tbody id="dd-models-tbody"></tbody>
                          </table>
                        </div>
                      </div>
                    </div>

                    {/* Top 25 Heavy & Runaway Sessions */}
                    <div className="panel-card" style={{ marginBottom: '24px', background: 'var(--surface-overlay, #151928)', border: '1px solid var(--border)' }}>
                      <div className="panel-card-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                        <span className="panel-card-title" style={{ fontWeight: 600, fontSize: '14px' }}>🔥 Top Heavy &amp; Runaway Sessions</span>
                        <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block' }}>Highest volume single coding sessions</span>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Session &amp; Time</th>
                              <th>Member</th>
                              <th>Project &amp; Model</th>
                              <th>Total Tokens</th>
                              <th>Cost</th>
                              <th>Status / Loops</th>
                            </tr>
                          </thead>
                          <tbody id="dd-sessions-tbody"></tbody>
                        </table>
                      </div>
                    </div>

                    {/* Two-Column: Hotspot Files & Daily Timeline */}
                    <div className="analytics-two-col" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '20px' }}>
                      <div className="panel-card" style={{ background: 'var(--surface-overlay, #151928)', border: '1px solid var(--border)' }}>
                        <div className="panel-card-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                          <span className="panel-card-title" style={{ fontWeight: 600, fontSize: '14px' }}>📄 Hotspot Files Touched</span>
                          <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block' }}>Most edited code files</span>
                        </div>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>File Path</th>
                                <th>Edits</th>
                                <th>Add / Del</th>
                                <th>Changed Lines</th>
                              </tr>
                            </thead>
                            <tbody id="dd-files-tbody"></tbody>
                          </table>
                        </div>
                      </div>

                      <div className="panel-card" style={{ background: 'var(--surface-overlay, #151928)', border: '1px solid var(--border)' }}>
                        <div className="panel-card-header" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                          <span className="panel-card-title" style={{ fontWeight: 600, fontSize: '14px' }}>📅 Daily Activity Timeline</span>
                          <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block' }}>Day-by-day burn velocity</span>
                        </div>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Date</th>
                                <th>Sessions</th>
                                <th>Tokens</th>
                                <th>Cost</th>
                                <th>Edits</th>
                              </tr>
                            </thead>
                            <tbody id="dd-timeline-tbody"></tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* TAB 5: PROJECTS & WORKSPACES */}
              <section id="tab-projects" className="tab-content" role="tabpanel" aria-labelledby="tabbtn-projects" hidden>
                <div className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Projects & Workspaces</h2>
                      <span className="muted">Which accounts and members worked on which repositories</span>
                    </div>
                  </div>
                  <div id="projects-table" className="table-wrap"></div>
                </div>
              </section>

              {/* TAB 6: FILE IMPACT RISK MAP */}
              <section id="tab-files" className="tab-content" role="tabpanel" aria-labelledby="tabbtn-files" hidden>
                <div className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Code Impact Map</h2>
                      <span className="muted">Most-modified paths, line diffs, and contributor counts</span>
                    </div>
                  </div>
                  <div id="top-files" className="table-wrap"></div>
                </div>
              </section>

              {/* TAB 7: SESSION ACTIVITY LOGS */}
              <section id="tab-logs" className="tab-content" role="tabpanel" aria-labelledby="tabbtn-logs" hidden>
                <div className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Session Activity Logs</h2>
                      <span className="muted">Recent agent sessions across the team</span>
                    </div>
                  </div>
                  <div id="session-logs-table" className="table-wrap"></div>
                </div>
              </section>

              {/* TAB 8: MODEL PRICING RATES */}
              <section id="tab-pricing" className="tab-content" role="tabpanel" aria-labelledby="tabbtn-pricing" hidden>
                <div className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Model Pricing</h2>
                      <span className="muted">Custom LLM rates in $ per million tokens</span>
                    </div>
                    <div className="inline-actions">
                      <button id="recalculate-costs-btn" className="hbtn hbtn-accent">
                        Recalculate costs
                      </button>
                      <button id="add-pricing-btn" className="hbtn primary">+ Add pricing rule</button>
                    </div>
                  </div>
                  <p className="panel-intro">
                    Configure pricing rules, then recalculate to refresh estimated costs across member sessions.
                  </p>
                  <div id="model-pricing-table" className="table-wrap"></div>

                  <div className="panel-subsection">
                    <div className="panel-head panel-head-tight">
                      <div>
                        <h2>Member Model Usage</h2>
                        <span className="muted">Spend breakdown by model for each team member</span>
                      </div>
                    </div>
                    <div id="member-models-table" className="table-wrap"></div>
                  </div>
                </div>
              </section>

              {/* TAB 9: SETTINGS & MEMBER KEYS */}
              <section id="tab-settings" className="tab-content" role="tabpanel" aria-labelledby="tabbtn-settings" hidden>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Team Members & API Keys</h2>
                      <span className="muted">Manage members, roles, and ingest keys</span>
                    </div>
                    <div className="inline-actions">
                      <button id="trigger-sync-all-btn" className="hbtn hbtn-accent">
                        Sync all members
                      </button>
                      <button id="link-member-btn" className="hbtn">Link existing</button>
                      <button id="add-member-btn" className="hbtn primary">+ Add member</button>
                    </div>
                  </div>
                  <div id="members" className="table-wrap"></div>
                  <div id="new-member-banner" className="credentials-banner" hidden>
                    <div className="credentials-head">
                      <div className="credentials-badge">🎉 User Created Successfully</div>
                      <button type="button" id="close-credentials-banner" className="hbtn small-btn">✕ Dismiss</button>
                    </div>

                    <div className="credentials-grid">
                      <div className="credential-item">
                        <span className="credential-label">Username</span>
                        <div className="credential-val-row">
                          <code id="cred-username" className="cred-code">—</code>
                          <button type="button" className="hbtn small-btn copy-field-btn" data-target="cred-username">Copy</button>
                        </div>
                      </div>

                      <div className="credential-item">
                        <span className="credential-label">Temporary Password</span>
                        <div className="credential-val-row">
                          <code id="cred-password" className="cred-code cred-password">—</code>
                          <button type="button" className="hbtn small-btn copy-field-btn" data-target="cred-password">Copy</button>
                        </div>
                      </div>

                      <div className="credential-item">
                        <span className="credential-label">API Key</span>
                        <div className="credential-val-row">
                          <code id="cred-apikey" className="cred-code">—</code>
                          <button type="button" className="hbtn small-btn copy-field-btn" data-target="cred-apikey">Copy</button>
                        </div>
                      </div>

                      <div className="credential-item">
                        <span className="credential-label">Assigned Workspaces</span>
                        <div className="credential-val-row">
                          <span id="cred-teams" className="cred-teams-badge">—</span>
                        </div>
                      </div>
                    </div>

                    <div className="credentials-commands">
                      <div className="cmd-box">
                        <div className="cmd-box-head">
                          <span>🍎 <strong>macOS / Linux Setup Command</strong></span>
                          <button type="button" className="hbtn small-btn copy-field-btn" data-target="cred-cmd-mac">Copy Mac Command</button>
                        </div>
                        <pre id="cred-cmd-mac" className="cmd-pre">—</pre>
                      </div>

                      <div className="cmd-box">
                        <div className="cmd-box-head">
                          <span>🪟 <strong>Windows PowerShell Setup Command</strong></span>
                          <button type="button" className="hbtn small-btn copy-field-btn" data-target="cred-cmd-win">Copy Windows Command</button>
                        </div>
                        <pre id="cred-cmd-win" className="cmd-pre">—</pre>
                      </div>
                    </div>

                    <div className="credentials-foot">
                      <button type="button" id="copy-all-credentials-btn" className="hbtn hbtn-accent">📋 Copy All Onboarding Details</button>
                      <span className="muted" style={{ fontSize: '11.5px' }}>Share these credentials and one-line setup command with the developer.</span>
                    </div>
                  </div>
                  <p id="new-key" className="key-banner" hidden></p>
                </section>

                 {/* Daemon Releases Panel */}
                 <section className="panel" style={{ marginTop: '24px' }}>
                   <div className="panel-head">
                     <div>
                       <h2>🔄 Daemon Releases</h2>
                       <span className="muted">
                         Publish and manage auto-update releases for the background sync daemon.
                         {' '}Developers&apos; daemons check for updates every 24 hours and self-update automatically.
                       </span>
                     </div>
                     <span id="daemon-latest-version-badge" className="source-tag" style={{ alignSelf: 'center' }}>Loading…</span>
                   </div>

                   {/* Publish Release Form */}
                   <form id="publish-release-form" style={{ margin: '16px 0 20px', display: 'grid', gap: '12px' }}>
                     <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)' }}>
                       PUBLISH NEW RELEASE
                     </h3>
                     <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 2fr auto', gap: '8px', alignItems: 'end' }}>
                       <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                         Version <input id="release-version" placeholder="e.g. 1.2.0" required style={{ fontSize: '13px' }} />
                       </label>
                       <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                         Download URL (HTTPS) <input id="release-url" type="url" placeholder="https://your-domain.com/sync-daemon.mjs" required style={{ fontSize: '13px' }} />
                       </label>
                       <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                         SHA-256 Checksum <input id="release-sha256" placeholder="64-char hex — run: shasum -a 256 sync-daemon.mjs" required style={{ fontSize: '13px', fontFamily: 'monospace' }} />
                       </label>
                       <button type="submit" id="publish-release-submit" className="hbtn primary" style={{ whiteSpace: 'nowrap' }}>
                         Publish Release
                       </button>
                     </div>
                     <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                       <input id="release-mandatory" type="checkbox" />
                       <span>Mandatory update — daemons will skip syncing until they update</span>
                     </label>
                     <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                       Release Notes (optional)
                       <input id="release-notes" placeholder="What changed in this release?" style={{ fontSize: '13px' }} />
                     </label>
                     <p id="publish-release-error" className="error" role="alert" hidden></p>
                   </form>

                   {/* Releases List */}
                   <div id="daemon-releases-list" className="table-wrap"></div>

                   <p className="muted" style={{ marginTop: '14px', fontSize: '11px' }}>
                     💡 <strong>CI/CD tip:</strong> After building, compute the SHA-256 with{' '}
                     <code>shasum -a 256 sync-daemon.mjs | cut -d&apos; &apos; -f1</code> (macOS/Linux) or{' '}
                     <code>Get-FileHash sync-daemon.mjs -Algorithm SHA256</code> (Windows), then POST to{' '}
                     <code>POST /api/internal/releases</code> with your admin session cookie.
                   </p>
                 </section>
              </section>

            </div>
          </main>
        </div>
      </div>

      {/* Add Member Dialog */}
      <dialog id="add-member-dialog">
        <form method="dialog" id="add-member-form">
          <h3>Add User &amp; Team Member</h3>
          <p className="muted" style={{ margin: '0 0 14px 0', fontSize: '12px' }}>
            Creates a complete user account and API key. Automatically assigned to this team and the Independent workspace.
          </p>
          
          <label>Display name
            <input id="member-name" required placeholder="e.g. Alex Smith" autoComplete="off" />
          </label>

          <label>Username <span className="muted" style={{ fontWeight: 'normal', fontSize: '11px' }}>(optional)</span>
            <input id="member-username" placeholder="Leave blank to auto-generate (e.g. alex.smith)" autoComplete="off" />
          </label>

          <label>Temporary Password <span className="muted" style={{ fontWeight: 'normal', fontSize: '11px' }}>(optional)</span>
            <input id="member-password" type="text" placeholder="Leave blank to auto-generate secure password" autoComplete="off" />
          </label>

          <label>Role
            <select id="member-role">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>

          <div className="form-hint-box" style={{ background: 'rgba(99, 102, 241, 0.08)', border: '1px solid rgba(99, 102, 241, 0.25)', borderRadius: '6px', padding: '8px 12px', fontSize: '11.5px', color: 'var(--text-muted, #94a3b8)', margin: '8px 0 14px 0' }}>
            👥 <strong>Default Workspaces:</strong> This user will be linked to <span id="add-member-team-hint" style={{ color: '#fff', fontWeight: 600 }}>this team</span> and <code style={{ color: '#818cf8' }}>Independent</code> by default.
          </div>

          <menu>
            <button type="button" id="cancel-member" className="hbtn">Cancel</button>
            <button type="submit" id="add-member-submit" className="hbtn primary">Create User + Key</button>
          </menu>
        </form>
      </dialog>

      {/* Edit Member Dialog */}
      <dialog id="edit-member-dialog">
        <form method="dialog" id="edit-member-form">
          <h3>Edit team member</h3>
          <input type="hidden" id="edit-member-id" />
          <label>Display name<input id="edit-member-name" required /></label>
          <label>Role
            <select id="edit-member-role">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <menu>
            <button type="button" id="cancel-edit-member" className="hbtn">Cancel</button>
            <button type="submit" className="hbtn primary">Save Changes</button>
          </menu>
        </form>
      </dialog>

      {/* Link Member Dialog */}
      <dialog id="link-member-dialog">
        <form method="dialog" id="link-member-form">
          <h3>Link existing member</h3>
          <label>Select Member
            <select id="link-member-select" required>
              <option value="">— select member —</option>
            </select>
          </label>
          <menu>
            <button type="button" id="cancel-link-member" className="hbtn">Cancel</button>
            <button type="submit" className="hbtn primary">Link to Team</button>
          </menu>
        </form>
      </dialog>

      {/* Add Model Pricing Dialog */}
      <dialog id="add-pricing-dialog">
        <form method="dialog" id="add-pricing-form">
          <h3>Add / Update Model Pricing Rule</h3>
          <label>Model Pattern / Name
            <input id="pricing-model-pattern" required placeholder="e.g. claude-3-5-sonnet or deepseek-r1" />
          </label>
          <label>Input Tokens Cost ($ per 1 Million tokens)
            <input id="pricing-cost-in" type="number" step="0.01" min="0" required placeholder="e.g. 3.00" />
          </label>
          <label>Output Tokens Cost ($ per 1 Million tokens)
            <input id="pricing-cost-out" type="number" step="0.01" min="0" required placeholder="e.g. 15.00" />
          </label>
          <label>Cache Read Tokens Cost ($ per 1 Million tokens)
            <input id="pricing-cost-cache" type="number" step="0.01" min="0" required placeholder="e.g. 0.30" />
          </label>
          <menu>
            <button type="button" id="cancel-pricing" className="hbtn">Cancel</button>
            <button type="submit" className="hbtn primary">Save Pricing Rule</button>
          </menu>
        </form>
      </dialog>

      {/* Team Admin Profile Dialog */}
      <dialog id="team-profile-dialog" aria-labelledby="team-profile-title">
        <form method="dialog" id="team-profile-form" noValidate>
          <div className="profile-modal-header">
            <div className="profile-modal-title-row">
              <span className="profile-icon" aria-hidden="true">👤</span>
              <h3 id="team-profile-title">Admin Account &amp; Profile</h3>
            </div>
            <p className="profile-modal-sub">Manage your display name and update your administrator login password.</p>
          </div>

          <div className="profile-info-card">
            <div className="profile-info-row">
              <span className="profile-info-label">Username:</span>
              <code id="team-profile-username-val" className="profile-code-pill">—</code>
            </div>
            <div className="profile-info-row">
              <span className="profile-info-label">Account Role:</span>
              <span id="team-profile-role-val" className="badge-pill">Team Admin</span>
            </div>
            <div className="profile-info-row">
              <span className="profile-info-label">Assigned Workspaces:</span>
              <span id="team-profile-teams-val" className="profile-teams-list">—</span>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="team-profile-display-name">
              <strong>Display Name</strong>
              <span className="field-hint">Visible across the team dashboard and admin logs</span>
            </label>
            <input
              id="team-profile-display-name"
              type="text"
              required
              minLength={2}
              placeholder="e.g. Sarah Jenkins"
              autoComplete="name"
            />
          </div>

          <div className="profile-password-section">
            <div className="password-section-title">
              <span>Change Password</span>
              <span className="field-hint">(Leave blank to keep current password)</span>
            </div>
            <div className="form-group">
              <label htmlFor="team-profile-current-password">Current Password</label>
              <input
                id="team-profile-current-password"
                type="password"
                placeholder="Enter current password"
                autoComplete="current-password"
              />
            </div>
            <div className="password-fields-grid">
              <div className="form-group">
                <label htmlFor="team-profile-new-password">New Password</label>
                <input
                  id="team-profile-new-password"
                  type="password"
                  minLength={6}
                  placeholder="Min 6 characters"
                  autoComplete="new-password"
                />
              </div>
              <div className="form-group">
                <label htmlFor="team-profile-confirm-password">Confirm New Password</label>
                <input
                  id="team-profile-confirm-password"
                  type="password"
                  placeholder="Repeat new password"
                  autoComplete="new-password"
                />
              </div>
            </div>
          </div>

          <div id="team-profile-error-msg" className="dialog-error" hidden />

          <menu className="dialog-actions">
            <button type="button" id="cancel-team-profile-btn" className="hbtn">Cancel</button>
            <button type="submit" id="save-team-profile-btn" className="hbtn primary">Save Changes</button>
          </menu>
        </form>
      </dialog>

      {/* Team Member Token Deep-Dive Modal */}
      <dialog id="team-whale-drilldown-dialog" className="tt-modal" style={{ maxWidth: '960px', width: '92vw', maxHeight: '90vh' }}>
        <div className="dialog-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '12px' }}>
          <div>
            <h3 id="twdd-title" style={{ margin: 0, fontSize: '18px' }}>👤 Member Token Deep Dive</h3>
            <span id="twdd-subtitle" className="muted" style={{ fontSize: '12px' }}>Where was this member&apos;s token usage spent?</span>
          </div>
          <button type="button" id="twdd-close-btn" className="hbtn" style={{ fontSize: '14px', padding: '4px 10px' }}>✕</button>
        </div>

        <div id="twdd-body" className="dialog-body" style={{ overflowY: 'auto', maxHeight: 'calc(90vh - 120px)', padding: '16px 0' }}>
          <div id="twdd-loading" className="muted" style={{ textAlign: 'center', padding: '40px' }}>
            Loading deep-dive token usage analytics…
          </div>
          <div id="twdd-content" hidden>
            {/* Top Stat Cards */}
            <div className="kpi-row" style={{ marginBottom: '16px' }}>
              <div className="kpi-card kpi-card--accent-blue">
                <div className="kpi-body">
                  <div className="kpi-label">Total Burn</div>
                  <div className="kpi-value" id="twdd-stat-tokens">—</div>
                  <span className="kpi-sub" id="twdd-stat-cost">—</span>
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-body">
                  <div className="kpi-label">Input / Output</div>
                  <div className="kpi-value" id="twdd-stat-in-out">—</div>
                  <span className="kpi-sub" id="twdd-stat-cache">—</span>
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-body">
                  <div className="kpi-label">Sessions / Active Days</div>
                  <div className="kpi-value" id="twdd-stat-sessions">—</div>
                  <span className="kpi-sub" id="twdd-stat-avg">—</span>
                </div>
              </div>
              <div className="kpi-card kpi-card--accent-purple">
                <div className="kpi-body">
                  <div className="kpi-label">Code Impact</div>
                  <div className="kpi-value" id="twdd-stat-edits">—</div>
                  <span className="kpi-sub" id="twdd-stat-lines">—</span>
                </div>
              </div>
            </div>

            {/* Dimension 1: Projects & Repositories */}
            <div className="panel" style={{ marginBottom: '16px' }}>
              <div className="panel-head">
                <div>
                  <h3>📁 Workspaces &amp; Repositories</h3>
                  <span className="muted">Which repositories absorbed this developer&apos;s tokens</span>
                </div>
              </div>
              <div className="table-wrap">
                <table id="twdd-projects-table">
                  <thead>
                    <tr>
                      <th>Project / Workspace</th>
                      <th>Tools Used</th>
                      <th>Sessions</th>
                      <th>Tokens In / Out</th>
                      <th>Total Tokens</th>
                      <th>Share (% Burn)</th>
                      <th>Est. Cost</th>
                    </tr>
                  </thead>
                  <tbody id="twdd-projects-tbody"></tbody>
                </table>
              </div>
            </div>

            {/* Dimension 2: Models & Cache Hit Ratio */}
            <div className="panel" style={{ marginBottom: '16px' }}>
              <div className="panel-head">
                <div>
                  <h3>🤖 LLM Models &amp; Cache Efficiency</h3>
                  <span className="muted">Model breakdown, caching efficiency &amp; API costs</span>
                </div>
              </div>
              <div className="table-wrap">
                <table id="twdd-models-table">
                  <thead>
                    <tr>
                      <th>Model Pattern</th>
                      <th>Agent Tool</th>
                      <th>Sessions</th>
                      <th>Tokens In / Out</th>
                      <th>Cache Hit %</th>
                      <th>Total Tokens</th>
                      <th>API Cost</th>
                    </tr>
                  </thead>
                  <tbody id="twdd-models-tbody"></tbody>
                </table>
              </div>
            </div>

            {/* Dimension 3: Top Heavy Sessions */}
            <div className="panel" style={{ marginBottom: '16px' }}>
              <div className="panel-head">
                <div>
                  <h3>⚡ Top Heavy Sessions &amp; Anomalies</h3>
                  <span className="muted">Sessions with highest context window or runaway loops</span>
                </div>
              </div>
              <div className="table-wrap">
                <table id="twdd-sessions-table">
                  <thead>
                    <tr>
                      <th>Session ID / Timestamp</th>
                      <th>Project</th>
                      <th>Tool &amp; Model</th>
                      <th>Tokens (In / Out / Cache)</th>
                      <th>Cost</th>
                      <th>Health / Loops</th>
                      <th style={{ textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody id="twdd-sessions-tbody"></tbody>
                </table>
              </div>
            </div>

            {/* Dimension 4: Hotspot Files */}
            <div className="panel" style={{ marginBottom: '16px' }}>
              <div className="panel-head">
                <div>
                  <h3>📄 Hotspot Code Files</h3>
                  <span className="muted">Most-edited paths and diff volume</span>
                </div>
              </div>
              <div className="table-wrap">
                <table id="twdd-files-table">
                  <thead>
                    <tr>
                      <th>File Path</th>
                      <th>Edits Count</th>
                      <th>Lines Changed</th>
                    </tr>
                  </thead>
                  <tbody id="twdd-files-tbody"></tbody>
                </table>
              </div>
            </div>

            {/* Dimension 5: Daily Token Burn Timeline */}
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>📈 Daily Token Burn Timeline</h3>
                  <span className="muted">Daily spike and burst activity</span>
                </div>
              </div>
              <div id="twdd-timeline-chart" style={{ padding: '12px 16px' }}></div>
            </div>
          </div>
        </div>
      </dialog>

      <Script src="/toast.js" strategy="afterInteractive" />
      <Script src="/loader.js" strategy="afterInteractive" />
      <Script src="/team/app.js" strategy="afterInteractive" />
    </div>
  );
}
