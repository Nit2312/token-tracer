import type { Metadata } from 'next';
import Link from 'next/link';
import Script from 'next/script';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionFromCookie } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Admin — Token Tracer',
  description: 'Superadmin user management dashboard.',
};

export default async function AdminPage() {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());

  if (!session || session.role !== 'superadmin') {
    redirect('/');
  }

  return (
    <div suppressHydrationWarning>
      <Script src="/impersonation.js" strategy="afterInteractive" />
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
          <p className="tt-loader-label">Loading <em>admin</em>…</p>
        </div>
      </div>

      <div id="admin-app" className="admin-app" hidden>
        {/* Mobile-only topbar */}
        <div className="mobile-topbar">
          <button type="button" id="admin-nav-toggle" className="mobile-nav-toggle" aria-label="Toggle menu" aria-expanded="false" aria-controls="admin-sidebar-nav">
            <span></span><span></span><span></span>
          </button>
          <div className="wordmark"><h1>admin</h1></div>
          <div className="mobile-topbar-spacer" />
        </div>
        <div id="admin-nav-overlay" className="nav-overlay"></div>

        <aside className="admin-sidebar" id="admin-sidebar-nav">
          <div className="sidebar-brand">
            <div className="wordmark">
              <h1>admin</h1>
              <span className="eyebrow">Superadmin</span>
            </div>
          </div>
          <nav className="admin-sidebar-nav" role="tablist" aria-label="Admin sections">
            <button type="button" id="tabbtn-users" className="tab-btn active" data-tab="tab-users" role="tab" aria-selected="true" aria-controls="tab-users" tabIndex={0}>
              <span className="nav-icon" aria-hidden="true">👥</span> Users
            </button>
            <button type="button" id="tabbtn-members" className="tab-btn" data-tab="tab-members" role="tab" aria-selected="false" aria-controls="tab-members" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">🔗</span> Members
            </button>
            <button type="button" id="tabbtn-teams" className="tab-btn" data-tab="tab-teams" role="tab" aria-selected="false" aria-controls="tab-teams" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">🛡️</span> Teams
            </button>
            <button type="button" id="tabbtn-pricing" className="tab-btn" data-tab="tab-pricing" role="tab" aria-selected="false" aria-controls="tab-pricing" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">💲</span> Model Pricing
            </button>
            <button type="button" id="tabbtn-releases" className="tab-btn" data-tab="tab-releases" role="tab" aria-selected="false" aria-controls="tab-releases" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">🔄</span> Daemon Releases
            </button>
            <div className="sidebar-nav-divider" aria-hidden="true" />

            <button type="button" id="tabbtn-pipeline" className="tab-btn" data-tab="tab-pipeline" role="tab" aria-selected="false" aria-controls="tab-pipeline" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">🩺</span> Pipeline Health
            </button>
            <button type="button" id="tabbtn-cost" className="tab-btn" data-tab="tab-cost" role="tab" aria-selected="false" aria-controls="tab-cost" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">💰</span> Cost Intelligence
            </button>
            <button type="button" id="tabbtn-usage" className="tab-btn" data-tab="tab-usage" role="tab" aria-selected="false" aria-controls="tab-usage" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">📈</span> Usage &amp; Growth
            </button>
            <a href="/admin/research" id="tabbtn-research" className="tab-btn">
              <span className="nav-icon" aria-hidden="true">🔍</span> Research Analytics
            </a>
            <button type="button" id="tabbtn-prompts" className="tab-btn" data-tab="tab-prompts" role="tab" aria-selected="false" aria-controls="tab-prompts" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">📝</span> Prompt Explorer
            </button>
            <button type="button" id="tabbtn-audit" className="tab-btn" data-tab="tab-audit" role="tab" aria-selected="false" aria-controls="tab-audit" tabIndex={-1}>
              <span className="nav-icon" aria-hidden="true">🕵️</span> Audit Log
            </button>
          </nav>
          <div className="sidebar-footer">
            <button type="button" id="admin-profile-btn" className="hbtn sidebar-profile-btn" title="Account &amp; Profile Settings">
              <span className="profile-btn-icon" aria-hidden="true">👤</span>
              <span id="admin-user-name" className="muted">Profile</span>
            </button>
            <div className="sidebar-footer-links">
              <button id="admin-logout-btn" className="hbtn" title="Sign out">Sign out</button>
            </div>
          </div>
        </aside>

        <main className="admin-content">
          <div id="data-loading" className="data-loading" hidden aria-busy="true"></div>

          {/* Users tab */}
          <div id="tab-users" className="admin-tab active-tab" role="tabpanel" aria-labelledby="tabbtn-users">
            <div className="admin-tab-header">
              <div>
                <h2>Users</h2>
                <span className="admin-tab-sub">Accounts, roles, and member links</span>
              </div>
              <div className="admin-header-actions">
                <button type="button" className="hbtn migrate-btn" id="migrate-btn" hidden>Run database migration</button>
                <button type="button" className="hbtn primary" id="create-user-btn">+ Add user</button>
              </div>
            </div>

            <div id="user-form-wrap" className="user-form-wrap" hidden>
              <form id="user-form" className="user-form" noValidate>
                <h3 id="user-form-title">Add User</h3>
                <input type="hidden" id="uf-id" />
                <div className="form-grid">
                  <div className="form-field">
                    <label htmlFor="uf-username">Username</label>
                    <input id="uf-username" type="text" placeholder="e.g. raxit" required />
                  </div>
                  <div className="form-field">
                    <label htmlFor="uf-displayname">Display Name</label>
                    <input id="uf-displayname" type="text" placeholder="e.g. Raxit Patel" required />
                  </div>
                  <div className="form-field">
                    <label htmlFor="uf-password">Password <span className="muted">(leave blank when editing to keep current)</span></label>
                    <input id="uf-password" type="password" placeholder="temporary password" autoComplete="new-password" />
                  </div>
                  <div className="form-field">
                    <label htmlFor="uf-role">Role</label>
                    <select id="uf-role">
                      <option value="user">User (personal dashboard)</option>
                      <option value="admin">Admin (team dashboard)</option>
                      <option value="superadmin">Superadmin</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="uf-member">Linked Member (for sync API key)</label>
                    <select id="uf-member">
                      <option value="">— none (Independent) —</option>
                    </select>
                  </div>
                  <div className="form-field" id="field-uf-team" hidden>
                    <label htmlFor="uf-team">Linked Team (for Admins)</label>
                    <select id="uf-team">
                      <option value="">— none —</option>
                      <option value="new">— create new team —</option>
                    </select>
                  </div>
                  <div className="form-field" id="field-uf-new-team" hidden>
                    <label htmlFor="uf-new-team">New Team Name</label>
                    <input id="uf-new-team" type="text" placeholder="e.g. India Developers" />
                  </div>
                  <div className="form-field full-width" id="field-uf-teams" style={{ gridColumn: '1 / -1' }}>
                    <label>Assigned Teams (Multi-Team Membership)</label>
                    <div id="uf-teams-checkboxes" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px', marginTop: '6px', background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {/* Populated dynamically */}
                    </div>
                  </div>
                </div>
                <div className="form-actions">
                  <button type="submit" className="hbtn primary" id="uf-submit">Save</button>
                  <button type="button" className="hbtn" id="uf-cancel">Cancel</button>
                  <p id="uf-error" className="error" role="alert" aria-live="assertive" hidden />
                </div>
              </form>
            </div>

            <div className="admin-filters" style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="text" id="filter-user-input" placeholder="Search name or username..." style={{ flex: '1', minWidth: '200px', maxWidth: '300px', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--page)', color: 'var(--ink)', fontSize: '13px' }} />
              <select id="filter-team-select" style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--page)', color: 'var(--ink)', fontSize: '13px', minWidth: '150px' }}>
                <option value="">All Teams</option>
                {/* Populated dynamically */}
              </select>
              <select id="filter-status-select" style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--page)', color: 'var(--ink)', fontSize: '13px', minWidth: '150px' }}>
                <option value="">All Statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>

            <div className="admin-table-wrap">
              <table className="admin-table" id="users-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Teams</th>
                    <th>Sessions</th>
                    <th>Last Login</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody id="users-tbody" aria-busy="true">
                  {[0, 1, 2, 3].map((i) => (
                    <tr key={i} aria-hidden="true">
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j}><div className="skeleton" style={{ height: '14px', width: j === 0 ? '80%' : '60%' }} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div id="new-password-banner" className="new-password-banner" hidden>
              <strong>New password:</strong>
              <code id="new-password-value" />
              <span className="muted">— copy it now, it won&apos;t be shown again.</span>
              <button type="button" className="hbtn" id="new-password-copy">Copy</button>
              <button type="button" className="hbtn" id="new-password-close">×</button>
            </div>
          </div>

          {/* Members tab */}
          <div id="tab-members" className="admin-tab" role="tabpanel" aria-labelledby="tabbtn-members" hidden>
            <div className="admin-tab-header">
              <div>
                <h2>Unlinked Members</h2>
                <span className="admin-tab-sub">Members not yet connected to a user account</span>
              </div>
              <div className="admin-header-actions">
                <button type="button" className="hbtn primary" id="create-member-btn">+ Add member</button>
              </div>
            </div>

            <div id="member-form-wrap" className="user-form-wrap" hidden>
              <form id="member-form" className="user-form" noValidate>
                <h3 id="member-form-title">Edit Member</h3>
                <input type="hidden" id="mf-id" />
                <div className="form-grid">
                  <div className="form-field">
                    <label htmlFor="mf-displayname">Display Name</label>
                    <input id="mf-displayname" type="text" placeholder="e.g. John Doe" required />
                  </div>
                  <div className="form-field full-width" id="field-mf-teams" style={{ gridColumn: '1 / -1' }}>
                    <label>Assigned Teams</label>
                    <div id="mf-teams-checkboxes" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px', marginTop: '6px', background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {/* Populated dynamically */}
                    </div>
                  </div>
                </div>
                <div className="form-actions">
                  <button type="submit" className="hbtn primary" id="mf-submit">Save</button>
                  <button type="button" className="hbtn" id="mf-cancel">Cancel</button>
                  <p id="mf-error" className="error" role="alert" aria-live="assertive" hidden />
                </div>
              </form>
            </div>

            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr><th>Display Name</th><th>Teams</th><th>Status</th><th>Actions</th></tr>
                </thead>
                <tbody id="members-tbody" aria-busy="true">
                  {[0, 1, 2].map((i) => (
                    <tr key={i} aria-hidden="true">
                      {Array.from({ length: 4 }).map((_, j) => (
                        <td key={j}><div className="skeleton" style={{ height: '14px', width: j === 0 ? '80%' : '60%' }} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Teams tab */}
          <div id="tab-teams" className="admin-tab" role="tabpanel" aria-labelledby="tabbtn-teams" hidden>
            <div className="admin-tab-header">
              <div>
                <h2>Teams</h2>
                <span className="admin-tab-sub">Manage team names and organizations</span>
              </div>
              <div className="admin-header-actions">
                <button type="button" className="hbtn primary" id="create-team-btn">+ Add team</button>
              </div>
            </div>

            <div id="team-form-wrap" className="user-form-wrap" hidden>
              <form id="team-form" className="user-form" noValidate>
                <h3 id="team-form-title">Add Team</h3>
                <input type="hidden" id="tf-id" />
                <div className="form-grid">
                  <div className="form-field">
                    <label htmlFor="tf-name">Team Name</label>
                    <input id="tf-name" type="text" placeholder="e.g. India Developers" required />
                  </div>
                </div>
                <div className="form-actions">
                  <button type="submit" className="hbtn primary" id="tf-submit">Save</button>
                  <button type="button" className="hbtn" id="tf-cancel">Cancel</button>
                  <p id="tf-error" className="error" role="alert" aria-live="assertive" hidden />
                </div>
              </form>
            </div>

            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Team Name</th>
                    <th>Members Count</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody id="teams-tbody" aria-busy="true">
                  {[0, 1, 2].map((i) => (
                    <tr key={i} aria-hidden="true">
                      {Array.from({ length: 3 }).map((_, j) => (
                        <td key={j}><div className="skeleton" style={{ height: '14px', width: j === 0 ? '80%' : '60%' }} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Model Pricing tab */}
          <div id="tab-pricing" className="admin-tab" role="tabpanel" aria-labelledby="tabbtn-pricing" hidden>
            <div className="admin-tab-header">
              <div>
                <h2>Model Pricing &amp; Rates</h2>
                <span className="admin-tab-sub">Configure global or team-specific LLM pricing ($/1M tokens) and synchronize across all teams and members</span>
              </div>
              <div className="admin-header-actions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button type="button" className="hbtn hbtn-accent" id="sync-all-btn" title="Sync pricing, recalculate historical session costs, and broadcast daemon sync across all teams">
                  <span className="sync-icon">🔄</span> Sync for All Teams &amp; Members
                </button>
                <button type="button" className="hbtn primary" id="create-pricing-btn">+ Add pricing rule</button>
              </div>
            </div>

            <div id="pricing-form-wrap" className="user-form-wrap" hidden>
              <form id="pricing-form" className="user-form" noValidate>
                <h3 id="pricing-form-title">Add Pricing Rule</h3>
                <input type="hidden" id="pf-id" />

                <div className="preset-pill-bar" style={{ marginBottom: '16px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: '12px', marginRight: '4px' }}>Quick Presets:</span>
                  <button type="button" className="preset-pill" data-pattern="claude-3-7-sonnet" data-in="3.0" data-out="15.0" data-cache="0.3">Claude 3.7 Sonnet</button>
                  <button type="button" className="preset-pill" data-pattern="claude-3-5-sonnet" data-in="3.0" data-out="15.0" data-cache="0.3">Claude 3.5 Sonnet</button>
                  <button type="button" className="preset-pill" data-pattern="claude-3-5-haiku" data-in="0.8" data-out="4.0" data-cache="0.08">Claude 3.5 Haiku</button>
                  <button type="button" className="preset-pill" data-pattern="gpt-4o" data-in="2.5" data-out="10.0" data-cache="1.25">GPT-4o</button>
                  <button type="button" className="preset-pill" data-pattern="gpt-4o-mini" data-in="0.15" data-out="0.6" data-cache="0.075">GPT-4o Mini</button>
                  <button type="button" className="preset-pill" data-pattern="o1" data-in="15.0" data-out="60.0" data-cache="7.5">o1</button>
                  <button type="button" className="preset-pill" data-pattern="o3-mini" data-in="1.1" data-out="4.4" data-cache="0.55">o3-mini</button>
                  <button type="button" className="preset-pill" data-pattern="deepseek-r1" data-in="0.55" data-out="2.19" data-cache="0.14">DeepSeek R1</button>
                  <button type="button" className="preset-pill" data-pattern="deepseek-v3" data-in="0.14" data-out="0.28" data-cache="0.014">DeepSeek V3</button>
                </div>

                <div className="form-grid">
                  <div className="form-field">
                    <label htmlFor="pf-team">Scope / Target Team</label>
                    <select id="pf-team">
                      <option value="global">🌐 Global (Applies to all teams &amp; members)</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="pf-pattern">Model Pattern / Identifier</label>
                    <input id="pf-pattern" type="text" placeholder="e.g. claude-3-7-sonnet or gpt-4o" required />
                  </div>
                  <div className="form-field">
                    <label htmlFor="pf-cost-in">Cost In ($ / 1M tokens)</label>
                    <input id="pf-cost-in" type="number" step="0.0001" min="0" placeholder="e.g. 3.00" required />
                  </div>
                  <div className="form-field">
                    <label htmlFor="pf-cost-out">Cost Out ($ / 1M tokens)</label>
                    <input id="pf-cost-out" type="number" step="0.0001" min="0" placeholder="e.g. 15.00" required />
                  </div>
                  <div className="form-field">
                    <label htmlFor="pf-cost-cache">Cache Read Cost ($ / 1M tokens)</label>
                    <input id="pf-cost-cache" type="number" step="0.0001" min="0" placeholder="e.g. 0.30" required />
                  </div>
                </div>

                <div className="form-actions">
                  <button type="submit" className="hbtn primary" id="pf-submit">Save Pricing Rule</button>
                  <button type="button" className="hbtn" id="pf-cancel">Cancel</button>
                  <p id="pf-error" className="error" role="alert" aria-live="assertive" hidden />
                </div>
              </form>
            </div>

            <div className="admin-table-wrap">
              <div className="admin-table-title" style={{ padding: '12px 16px', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Active Custom Pricing Overrides</span>
                <span id="pricing-count-badge" className="team-badge" style={{ fontSize: '11px', background: 'rgba(255,255,255,0.08)', padding: '2px 8px', borderRadius: '12px' }}>0 rules</span>
              </div>
              <table className="admin-table" id="pricing-table">
                <thead>
                  <tr>
                    <th>Model Pattern</th>
                    <th>Scope / Team</th>
                    <th>Input ($/1M)</th>
                    <th>Output ($/1M)</th>
                    <th>Cache Read ($/1M)</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody id="pricing-tbody" aria-busy="true">
                  {[0, 1, 2].map((i) => (
                    <tr key={i} aria-hidden="true">
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j}><div className="skeleton" style={{ height: '14px', width: j === 0 ? '70%' : '50%' }} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="admin-table-wrap" style={{ marginTop: '24px' }}>
              <div className="admin-table-title" style={{ padding: '12px 16px', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span>System Baseline Reference Rates</span>
                  <span className="muted" style={{ fontSize: '12px', marginLeft: '8px', fontWeight: 400 }}>Built-in fallbacks when no custom override is set</span>
                </div>
              </div>
              <table className="admin-table" id="default-pricing-table">
                <thead>
                  <tr>
                    <th>Model Name / Pattern</th>
                    <th>Default Input ($/1M)</th>
                    <th>Default Output ($/1M)</th>
                    <th>Default Cache Read ($/1M)</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="default-pricing-tbody">
                  {/* Populated dynamically */}
                </tbody>
              </table>
            </div>
          </div>

          {/* Daemon Releases tab */}
          <div id="tab-releases" className="admin-tab" role="tabpanel" aria-labelledby="tabbtn-releases" hidden>
            <div className="admin-tab-header">
              <div>
                <h2>🔄 Daemon Auto-Update Releases</h2>
                <span className="admin-tab-sub">Publish and manage client daemon releases. Daemons pull version updates automatically every 24 hours.</span>
              </div>
              <span id="daemon-latest-version-badge" className="source-tag" style={{ alignSelf: 'center' }}>Loading…</span>
            </div>

            {/* Publish Release Form */}
            <div className="panel" style={{ padding: '20px', marginBottom: '20px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '12px' }}>
              <form id="publish-release-form" style={{ display: 'grid', gap: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)' }}>PUBLISH NEW DAEMON VERSION</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 2fr auto', gap: '12px', alignItems: 'end' }}>
                  <div className="form-field" style={{ margin: 0 }}>
                    <label htmlFor="release-version">Version</label>
                    <input id="release-version" placeholder="e.g. 1.2.0" required style={{ width: '100%' }} />
                  </div>
                  <div className="form-field" style={{ margin: 0 }}>
                    <label htmlFor="release-url">Download URL (HTTPS)</label>
                    <input id="release-url" type="url" placeholder="https://token-tracer-three.vercel.app/sync-daemon.mjs" required style={{ width: '100%' }} />
                  </div>
                  <div className="form-field" style={{ margin: 0 }}>
                    <label htmlFor="release-sha256">SHA-256 Checksum</label>
                    <input id="release-sha256" placeholder="64-char hex string" required style={{ width: '100%', fontFamily: 'monospace' }} />
                  </div>
                  <button type="submit" id="publish-release-submit" className="hbtn primary" style={{ height: '42px', whiteSpace: 'nowrap' }}>
                    Publish Release
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                    <input id="release-mandatory" type="checkbox" style={{ width: '16px', height: '16px' }} />
                    <span>Mandatory update — daemons will skip syncing until they update</span>
                  </label>
                </div>
                <div className="form-field">
                  <label htmlFor="release-notes">Release Notes / Changelog (optional)</label>
                  <input id="release-notes" placeholder="e.g. Fixed Windows service file lock issue during self-update" style={{ width: '100%' }} />
                </div>
                <p id="publish-release-error" className="error" role="alert" hidden></p>
              </form>
            </div>

            {/* Releases Table */}
            <div className="panel" style={{ padding: '0', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
              <div id="daemon-releases-list" className="table-wrap">
                {/* Populated dynamically */}
              </div>
            </div>

            <p className="muted" style={{ marginTop: '14px', fontSize: '11.5px', padding: '0 8px' }}>
              💡 <strong>CI/CD Integration:</strong> After checking in daemon code, compute the SHA-256 with <code>shasum -a 256 public/sync-daemon.mjs</code> and POST to <code>/api/internal/releases</code>.
            </p>
          </div>


          {/* ═══════════════════════════════════════════════════
              SUPERADMIN ANALYTICS TABS
              ═══════════════════════════════════════════════════ */}

          {/* ── Pipeline Health tab ── */}
          <div id="tab-pipeline" className="admin-tab" role="tabpanel" aria-labelledby="tabbtn-pipeline" hidden>
            <div className="admin-tab-header">
              <div>
                <h2>Pipeline Health</h2>
                <span className="admin-tab-sub">Live daemon status, ingestion lag &amp; batch failure rates</span>
              </div>
              <div className="admin-header-actions">
                <div id="pipeline-health-indicator" className="health-indicator">
                  <span className="health-indicator-dot" id="pipeline-health-dot" />
                  <span id="pipeline-health-label" className="health-indicator-label">Checking…</span>
                </div>
                <select id="pipeline-range-select" className="range-select" aria-label="Date range">
                  <option value="7d">Last 7 days</option>
                  <option value="14d">Last 14 days</option>
                  <option value="30d">Last 30 days</option>
                </select>
              </div>
            </div>

            {/* KPI row */}
            <div className="kpi-row" id="pipeline-stat-cards">
              <div className="kpi-card">
                <div className="kpi-icon kpi-icon--green">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2.5"/></svg>
                </div>
                <div className="kpi-body">
                  <div className="kpi-label">Active (24h)</div>
                  <div className="kpi-value" id="pipeline-active-24h">—</div>
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-icon kpi-icon--amber">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 10h6M10 7v6"/></svg>
                </div>
                <div className="kpi-body">
                  <div className="kpi-label">Total Daemons</div>
                  <div className="kpi-value" id="pipeline-total-known">—</div>
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-icon kpi-icon--blue">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18"><ellipse cx="10" cy="6" rx="7" ry="2.5"/><path d="M3 6v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M3 10v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-4"/></svg>
                </div>
                <div className="kpi-body">
                  <div className="kpi-label">DB Tables</div>
                  <div className="kpi-value" id="pipeline-table-count">—</div>
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-icon kpi-icon--purple">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18"><polyline points="2,15 6,9 10,12 14,6 18,10"/></svg>
                </div>
                <div className="kpi-body">
                  <div className="kpi-label">Avg Lag (s)</div>
                  <div className="kpi-value" id="pipeline-avg-lag">—</div>
                </div>
              </div>
            </div>

            {/* Two-column: Daemon grid | Lag + Failure */}
            <div className="analytics-two-col">
              <div className="analytics-col-main">
                <div className="panel-card">
                  <div className="panel-card-header">
                    <span className="panel-card-title">Daemon Status</span>
                    <span className="panel-card-badge" id="daemon-count-badge"></span>
                  </div>
                  <div id="daemon-grid" className="daemon-grid-new" aria-label="Daemon status grid"></div>
                </div>
              </div>
              <div className="analytics-col-side">
                <div className="panel-card">
                  <div className="panel-card-header">
                    <span className="panel-card-title">Ingestion Lag</span>
                    <span style={{fontSize:'11px', color:'var(--muted)'}}>avg seconds/day</span>
                  </div>
                  <div id="lag-chart-wrap" className="chart-container" style={{height:'150px'}}>
                    <svg id="lag-chart" className="analytics-chart" preserveAspectRatio="none" aria-label="Ingestion lag chart" />
                    <div id="lag-tooltip" className="chart-tooltip" hidden />
                  </div>
                </div>
                <div className="panel-card" style={{marginTop:'14px'}}>
                  <div className="panel-card-header">
                    <span className="panel-card-title">Failure Rates</span>
                  </div>
                  <div id="failure-rate-list" className="failure-rate-list"></div>
                </div>
              </div>
            </div>
          </div>

          {/* ── Cost Intelligence tab ── */}
          <div id="tab-cost" className="admin-tab" role="tabpanel" aria-labelledby="tabbtn-cost" hidden>
            <div className="admin-tab-header">
              <div>
                <h2>Cost Intelligence</h2>
                <span className="admin-tab-sub">Platform-wide spend, cache savings &amp; org-level breakdown</span>
              </div>
              <div className="admin-header-actions">
                <select id="cost-range-select" className="range-select" aria-label="Date range" defaultValue="30d">
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="60d">Last 60 days</option>
                  <option value="90d">Last 90 days</option>
                </select>
              </div>
            </div>

            {/* KPI row */}
            <div className="kpi-row" id="cost-stat-cards">
              <div className="kpi-card kpi-card--accent-green">
                <div className="kpi-body">
                  <div className="kpi-label">Total Spend</div>
                  <div className="kpi-value" id="cost-total-actual">—</div>
                  <div className="kpi-sub" id="cost-per-session-avg"></div>
                </div>
              </div>
              <div className="kpi-card kpi-card--accent-amber">
                <div className="kpi-body">
                  <div className="kpi-label">List Price</div>
                  <div className="kpi-value" id="cost-total-list">—</div>
                  <div className="kpi-sub" style={{opacity:0.5}}>before discounts</div>
                </div>
              </div>
              <div className="kpi-card kpi-card--accent-teal">
                <div className="kpi-body">
                  <div className="kpi-label">Cache Savings</div>
                  <div className="kpi-value" id="cost-total-cache-savings">—</div>
                  <div className="kpi-sub" style={{opacity:0.5}}>est. from reads</div>
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-body">
                  <div className="kpi-label">Sessions</div>
                  <div className="kpi-value" id="cost-total-sessions">—</div>
                </div>
              </div>
            </div>

            {/* Cost trend (full width) */}
            <div className="panel-card" style={{marginBottom:'16px'}}>
              <div className="panel-card-header">
                <span className="panel-card-title">Spend Over Time</span>
                <div className="chart-legend-inline">
                  <span className="cli-dot" style={{background:'#fbbf24'}} />List Price&nbsp;&nbsp;
                  <span className="cli-dot" style={{background:'#34d399'}} />Actual Cost
                </div>
              </div>
              <div id="cost-chart-wrap" className="chart-container" style={{height:'210px'}}>
                <svg id="cost-trend-chart" className="analytics-chart" preserveAspectRatio="none" aria-label="Cost trend chart" />
                <div id="cost-tooltip" className="chart-tooltip" hidden />
              </div>
            </div>

            {/* Two-column: Top orgs | Cache + Override */}
            <div className="analytics-two-col">
              <div className="analytics-col-main">
                <div className="panel-card">
                  <div className="panel-card-header">
                    <span className="panel-card-title">Top Orgs by Spend</span>
                  </div>
                  <div id="top-orgs-list" className="top-orgs-list"></div>
                </div>
              </div>
              <div className="analytics-col-side">
                <div className="panel-card">
                  <div className="panel-card-header">
                    <span className="panel-card-title">Cache Savings / Day</span>
                  </div>
                  <div id="cache-chart-wrap" className="chart-container" style={{height:'140px'}}>
                    <svg id="cache-savings-chart" className="analytics-chart" preserveAspectRatio="none" aria-label="Cache savings chart" />
                  </div>
                </div>
                <div className="panel-card" style={{marginTop:'14px'}}>
                  <div className="panel-card-header">
                    <span className="panel-card-title">Override Audit</span>
                    <span style={{fontSize:'11px', color:'var(--muted)'}}>custom pricing</span>
                  </div>
                  <div id="override-audit-list" className="override-list"></div>
                </div>
              </div>
            </div>
          </div>

          {/* ── Usage & Growth tab ── */}
          <div id="tab-usage" className="admin-tab" role="tabpanel" aria-labelledby="tabbtn-usage" hidden>
            <div className="admin-tab-header">
              <div>
                <h2>Usage &amp; Growth</h2>
                <span className="admin-tab-sub">Token trends, model distribution &amp; platform growth</span>
              </div>
              <div className="admin-header-actions">
                <select id="usage-range-select" className="range-select" aria-label="Date range" defaultValue="30d">
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="60d">Last 60 days</option>
                  <option value="90d">Last 90 days</option>
                </select>
              </div>
            </div>

            {/* KPI row */}
            <div className="kpi-row" id="usage-stat-cards">
              <div className="kpi-card kpi-card--accent-green">
                <div className="kpi-body">
                  <div className="kpi-label">Active (24h)</div>
                  <div className="kpi-value" id="usage-active-24h">—</div>
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-body">
                  <div className="kpi-label">Active (7d)</div>
                  <div className="kpi-value" id="usage-active-7d">—</div>
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-body">
                  <div className="kpi-label">Registered</div>
                  <div className="kpi-value" id="usage-total-registered">—</div>
                </div>
              </div>
              <div className="kpi-card kpi-card--accent-blue">
                <div className="kpi-body">
                  <div className="kpi-label">Total Tokens</div>
                  <div className="kpi-value" id="usage-total-tokens">—</div>
                </div>
              </div>
            </div>

            {/* Token trend (full width) */}
            <div className="panel-card" style={{marginBottom:'16px'}}>
              <div className="panel-card-header">
                <span className="panel-card-title">Token Volume by Tool</span>
                <div id="tool-legend" className="chart-legend-inline"></div>
              </div>
              <div id="token-trend-wrap" className="chart-container" style={{height:'220px'}}>
                <svg id="token-trend-chart" className="analytics-chart" preserveAspectRatio="none" aria-label="Token trend chart" />
                <div id="token-tooltip" className="chart-tooltip" hidden />
              </div>
            </div>

            {/* Two-column: Model mix | Daily summary */}
            <div className="analytics-two-col">
              <div className="analytics-col-main">
                <div className="panel-card">
                  <div className="panel-card-header">
                    <span className="panel-card-title">Model Mix</span>
                    <span style={{fontSize:'11px', color:'var(--muted)'}}>by total tokens</span>
                  </div>
                  <div id="model-punchcard-wrap" className="model-leaderboard"></div>
                </div>
              </div>
              <div className="analytics-col-side">
                <div className="panel-card">
                  <div className="panel-card-header">
                    <span className="panel-card-title">Daily Summary</span>
                  </div>
                  <div id="daily-summary-list" className="daily-summary-list"></div>
                </div>
              </div>
            </div>
          </div>

          {/* Prompt Explorer Tab */}
          <div id="tab-prompts" className="admin-tab" role="tabpanel" aria-labelledby="tabbtn-prompts" hidden>
            <div className="admin-section-header">
              <div>
                <h2 className="admin-section-title">Prompt Explorer</h2>
                <p className="admin-section-desc">Search, filter, and inspect user prompt trajectories with cache and token metrics.</p>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button type="button" id="prompts-refresh-btn" className="btn btn-secondary">🔄 Refresh</button>
              </div>
            </div>

            {/* Daemon Upgrade Alert Banner */}
            <div className="new-password-banner" style={{ marginBottom: '16px', border: '1px solid rgba(96,165,250,0.3)', background: 'rgba(96,165,250,0.03)', padding: '12px 16px', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--brand)', marginBottom: '4px' }}>💡 How to collect full prompt texts from developers:</div>
              <p className="muted" style={{ fontSize: '12px', margin: '0 0 10px', lineHeight: 1.5 }}>
                Some historical data was synced using older daemon versions which only report token counts (visualized as fallback labels). 
                To collect full sanitized prompt texts, developers must update to the latest daemon. Instruct them to run the following command on their machine:
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: '4px' }}>macOS / Linux (Bash)</div>
                  <code style={{ fontSize: '11px', wordBreak: 'break-all', display: 'block' }}>curl -fsSL https://token-tracer-three.vercel.app/install.sh | bash -s -- --key &lt;ApiKey&gt;</code>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Windows (PowerShell)</div>
                  <code style={{ fontSize: '11px', wordBreak: 'break-all', display: 'block' }}>$ApiKey="&lt;ApiKey&gt;"; iex (irm https://token-tracer-three.vercel.app/install.ps1)</code>
                </div>
              </div>
            </div>

            {/* Filter bar */}
            <div className="panel-card research-filter-bar" style={{ padding: '14px', display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center', marginBottom: '16px', overflow: 'visible' }}>
              <div className="form-field" style={{ margin: 0, minWidth: '160px' }}>
                <label htmlFor="prompt-org-select" style={{ fontSize: '11px', marginBottom: '4px' }}>Organization</label>
                <select id="prompt-org-select">
                  <option value="">— All Orgs —</option>
                </select>
              </div>
              <div className="form-field" style={{ margin: 0, minWidth: '180px', position: 'relative' }}>
                <label style={{ fontSize: '11px', marginBottom: '4px' }}>Developers</label>
                <button type="button" id="prompt-member-multiselect-btn" style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--ink)', padding: '6px 10px', borderRadius: 'var(--radius-sm)', outline: 'none', fontSize: '13px', width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', height: '30px' }}>
                  <span id="prompt-member-multiselect-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }}>All Developers</span>
                  <span style={{ fontSize: '8px', color: 'var(--muted)' }}>▼</span>
                </button>
                <div id="prompt-member-multiselect-dropdown" className="panel-card" style={{ display: 'none', position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000, maxHeight: '200px', overflowY: 'auto', padding: '8px', marginTop: '4px', background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>
                  {/* Dynamic checkbox elements will be rendered here */}
                </div>
              </div>
              <div className="form-field" style={{ margin: 0, minWidth: '110px' }}>
                <label htmlFor="prompt-range-select" style={{ fontSize: '11px', marginBottom: '4px' }}>Time Range</label>
                <select id="prompt-range-select" defaultValue="30d">
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="60d">Last 60 days</option>
                  <option value="90d">Last 90 days</option>
                </select>
              </div>
              <div className="form-field" style={{ margin: 0, minWidth: '110px' }}>
                <label htmlFor="prompt-tool-select" style={{ fontSize: '11px', marginBottom: '4px' }}>Tool</label>
                <select id="prompt-tool-select">
                  <option value="">— All Tools —</option>
                  <option value="claude_code">Claude Code</option>
                  <option value="cursor">Cursor</option>
                  <option value="codex">Codex</option>
                </select>
              </div>
              <div className="form-field" style={{ margin: 0, flex: 1, minWidth: '200px' }}>
                <label htmlFor="prompt-search-input" style={{ fontSize: '11px', marginBottom: '4px' }}>Search Prompts</label>
                <input type="text" id="prompt-search-input" placeholder="Search keywords..." style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--ink)', padding: '6px 10px', borderRadius: 'var(--radius-sm)', outline: 'none', fontSize: '13px', width: '100%' }} />
              </div>
            </div>

            {/* Stats summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '16px' }}>
              <div className="panel-card" style={{ padding: '16px' }}>
                <h4 style={{ margin: '0 0 4px', fontSize: '12px', color: 'var(--muted)', textTransform: 'uppercase' }}>Prompts Matching</h4>
                <div style={{ fontSize: '24px', fontWeight: 700 }} id="prompt-stat-count">0</div>
              </div>
              <div className="panel-card" style={{ padding: '16px' }}>
                <h4 style={{ margin: '0 0 4px', fontSize: '12px', color: 'var(--muted)', textTransform: 'uppercase' }}>Total Input Tokens</h4>
                <div style={{ fontSize: '24px', fontWeight: 700 }} id="prompt-stat-input">0</div>
              </div>
              <div className="panel-card" style={{ padding: '16px' }}>
                <h4 style={{ margin: '0 0 4px', fontSize: '12px', color: 'var(--muted)', textTransform: 'uppercase' }}>Total Output Tokens</h4>
                <div style={{ fontSize: '24px', fontWeight: 700 }} id="prompt-stat-output">0</div>
              </div>
              <div className="panel-card" style={{ padding: '16px' }}>
                <h4 style={{ margin: '0 0 4px', fontSize: '12px', color: 'var(--muted)', textTransform: 'uppercase' }}>Cache Read Ratio</h4>
                <div style={{ fontSize: '24px', fontWeight: 700 }} id="prompt-stat-cache">0%</div>
              </div>
            </div>

            {/* List Table */}
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Session ID</th>
                    <th>Developer</th>
                    <th>Project</th>
                    <th>Tool</th>
                    <th>Model</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Cache Read</th>
                    <th>Cache Write</th>
                    <th>Date</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="prompt-explorer-tbody">
                  <tr><td colSpan={11} style={{ textAlign: 'center', padding: '30px' }} className="muted">Loading prompts...</td></tr>
                </tbody>
              </table>
            </div>
            
            {/* Pagination Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', flexWrap: 'wrap', gap: '12px' }}>
              <span className="muted" id="prompts-pagination-info" style={{ fontSize: '13px' }}>Showing 0-0 of 0 prompts</span>
              <div style={{ display: 'flex', gap: '8px' }} id="prompts-pagination-buttons">
                <button type="button" id="prompts-prev-btn" className="preset-pill" style={{ padding: '6px 12px' }}>◀ Previous</button>
                <button type="button" id="prompts-next-btn" className="preset-pill" style={{ padding: '6px 12px' }}>Next ▶</button>
              </div>
            </div>
          </div>

          {/* Audit Log Tab */}
          <div id="tab-audit" className="admin-tab" role="tabpanel" aria-labelledby="tabbtn-audit" hidden>
            <div className="admin-section-header">
              <div>
                <h2 className="admin-section-title">Audit Log</h2>
                <p className="admin-section-desc">
                  Read-only record of sensitive superadmin actions — impersonation, user creation, password resets, and pricing changes.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <select id="audit-action-filter" className="range-select" aria-label="Filter by action">
                  <option value="">All actions</option>
                  <option value="impersonate.start">Impersonation started</option>
                  <option value="impersonate.end">Impersonation ended</option>
                  <option value="user.create">User created</option>
                  <option value="user.reset-password">Password reset</option>
                  <option value="pricing.create">Pricing rule created</option>
                  <option value="pricing.update">Pricing rule updated</option>
                  <option value="pricing.delete">Pricing rule deleted</option>
                </select>
                <button type="button" id="audit-refresh-btn" className="btn btn-secondary">🔄 Refresh</button>
              </div>
            </div>
            <div id="audit-log-table" className="table-wrap"></div>
          </div>

        </main>
      </div>

      {/* ── Impersonate Dialog ── */}
      <dialog id="impersonate-dialog" aria-labelledby="impersonate-dialog-title">
        <form method="dialog" id="impersonate-form" noValidate>
          <h2 id="impersonate-dialog-title" style={{ margin: '0 0 10px', fontSize: '20px', fontWeight: '600', color: 'var(--ink)' }}>Login as User?</h2>
          <p id="impersonate-dialog-desc" style={{ fontSize: '13px', lineHeight: '1.5', marginTop: '10px', color: 'var(--ink)' }}>
            You are about to log in as <strong id="impersonate-target-name"></strong> (<span id="impersonate-target-role" className="role-badge"></span>).
            <br/><br/>
            You will see their exact dashboard and analytics as if you were them. You can return to your superadmin account at any time using the banner at the top of the screen.
          </p>
          <div id="impersonate-error-msg" className="dialog-error" hidden style={{ color: 'var(--critical)', marginTop: '10px' }} />
          <menu className="dialog-actions" style={{ marginTop: '20px' }}>
            <button type="button" className="hbtn outline-btn" id="impersonate-cancel-btn">Cancel</button>
            <button type="submit" className="hbtn primary" id="impersonate-confirm-btn">Login as User</button>
          </menu>
        </form>
      </dialog>

      {/* Superadmin Profile Dialog */}
      <dialog id="admin-profile-dialog" aria-labelledby="admin-profile-title">
        <form method="dialog" id="admin-profile-form" noValidate>
          <div className="profile-modal-header">
            <div className="profile-modal-title-row">
              <span className="profile-icon" aria-hidden="true">👤</span>
              <h3 id="admin-profile-title">Superadmin Account &amp; Profile</h3>
            </div>
            <p className="profile-modal-sub">Manage your display name and update your superadmin login credentials.</p>
          </div>

          <div className="profile-info-card">
            <div className="profile-info-row">
              <span className="profile-info-label">Username:</span>
              <code id="admin-profile-username-val" className="profile-code-pill">—</code>
            </div>
            <div className="profile-info-row">
              <span className="profile-info-label">Account Role:</span>
              <span id="admin-profile-role-val" className="badge-pill">Superadmin</span>
            </div>
          </div>

          {/* BUG-09: Shown by JS when logged in as the static 'superadmin' account */}
          <div
            id="admin-profile-static-note"
            hidden
            style={{
              background: 'rgba(251, 191, 36, 0.12)',
              border: '1px solid rgba(251, 191, 36, 0.35)',
              borderRadius: '6px',
              padding: '10px 14px',
              fontSize: '12.5px',
              color: 'var(--muted)',
              marginBottom: '12px',
            }}
          >
            ⚠️ The static <code>superadmin</code> account cannot update its display name or
            password here. Those are controlled by the <code>SUPERADMIN_PASSWORD</code> environment
            variable on the server.
          </div>

          <div className="form-group">
            <label htmlFor="admin-profile-display-name">
              <strong>Display Name</strong>
              <span className="field-hint">Visible across the superadmin control panel</span>
            </label>
            <input
              id="admin-profile-display-name"
              type="text"
              required
              minLength={2}
              placeholder="e.g. System Admin"
              autoComplete="name"
            />
          </div>

          <div className="profile-password-section">
            <div className="password-section-title">
              <span>Change Password</span>
              <span className="field-hint">(Leave blank to keep current password)</span>
            </div>
            <div className="form-group">
              <label htmlFor="admin-profile-current-password">Current Password</label>
              <input
                id="admin-profile-current-password"
                type="password"
                placeholder="Enter current password"
                autoComplete="current-password"
              />
            </div>
            <div className="password-fields-grid">
              <div className="form-group">
                <label htmlFor="admin-profile-new-password">New Password</label>
                <input
                  id="admin-profile-new-password"
                  type="password"
                  minLength={6}
                  placeholder="Min 6 characters"
                  autoComplete="new-password"
                />
              </div>
              <div className="form-group">
                <label htmlFor="admin-profile-confirm-password">Confirm New Password</label>
                <input
                  id="admin-profile-confirm-password"
                  type="password"
                  placeholder="Repeat new password"
                  autoComplete="new-password"
                />
              </div>
            </div>
          </div>

          <div id="admin-profile-error-msg" className="dialog-error" hidden />

          <menu className="dialog-actions">
            <button type="button" id="cancel-admin-profile-btn" className="hbtn">Cancel</button>
            <button type="submit" id="save-admin-profile-btn" className="hbtn primary">Save Changes</button>
          </menu>
        </form>
      </dialog>

      <Script src="/toast.js" strategy="afterInteractive" />
      <Script src="/loader.js" strategy="afterInteractive" />
      <Script src="/admin/admin.js" strategy="afterInteractive" />
      <Script src="/admin/prompts.js" strategy="afterInteractive" />
    </div>
  );
}
