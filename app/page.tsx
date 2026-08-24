import type { Metadata } from 'next';
import Script from 'next/script';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionFromCookie } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Visualisation Dashboard',
  description: 'Personal token tracing and visualization dashboard.',
};

export default async function LoginPage() {
  const cookieStore = await cookies();
  const session = getSessionFromCookie(cookieStore.toString());

  if (session) {
    if (session.role === 'admin') {
      redirect('/team');
    }
    if (session.role === 'superadmin') {
      redirect('/admin');
    }
  }

  // If there is no session, render the sign-in form
  if (!session) {
    return (
      <div suppressHydrationWarning>
        <div className="login-page" id="login-page">
          <div className="login-glow" aria-hidden="true" />
          <div className="login-card" id="login-card">
            <div className="login-brand">
              <div className="login-mark" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
                  <circle cx="12" cy="12" r="4" />
                </svg>
              </div>
              <div className="wordmark">
                <h1>token<span>tracer</span></h1>
              </div>
              <p className="login-tagline">Sign in to your analytics workspace</p>
            </div>

            <form id="login-form" autoComplete="on" noValidate>
              <div className="login-field" id="field-displayname" hidden>
                <label htmlFor="login-displayname">Display Name</label>
                <input
                  id="login-displayname"
                  name="displayName"
                  type="text"
                  placeholder="your name"
                />
              </div>
              <div className="login-field" id="field-role" hidden>
                <label htmlFor="login-role">Account Type</label>
                <select id="login-role" name="role" style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--wash)', color: 'var(--ink)' }}>
                  <option value="user">Member (View Personal Metrics)</option>
                  <option value="admin">Team Admin (Manage a Team)</option>
                </select>
              </div>
              <div className="login-field" id="field-teamname" hidden>
                <label htmlFor="login-teamname">Team Name</label>
                <input
                  id="login-teamname"
                  name="teamName"
                  type="text"
                  placeholder="e.g. Paymore"
                />
              </div>
              <div className="login-field">
                <label htmlFor="login-username">Username</label>
                <input
                  id="login-username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  placeholder="your username"
                  required
                  autoFocus
                />
              </div>
              <div className="login-field">
                <label htmlFor="login-password">Password</label>
                <div className="login-password-wrap">
                  <input
                    id="login-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    required
                  />
                  <button
                    type="button"
                    id="login-password-toggle"
                    className="login-password-toggle"
                    aria-label="Show password"
                    aria-pressed="false"
                  >
                    <svg className="eye-open" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <svg className="eye-closed" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...({ hidden: true } as any)}>
                      <path d="M3 3l18 18" />
                      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                      <path d="M9.4 5.1A10.3 10.3 0 0 1 12 5c6.5 0 10 7 10 7a18.4 18.4 0 0 1-2.2 3.2" />
                      <path d="M6.7 6.7C4.2 8.4 2.7 11 2.7 11S6.2 18 12 18c1.1 0 2.1-.2 3-.5" />
                    </svg>
                  </button>
                </div>
              </div>
              <button type="submit" className="login-submit" id="login-submit">
                <span className="login-submit-spinner" aria-hidden="true" />
                <span className="login-submit-label">Sign in</span>
              </button>
              <div id="login-error" className="login-error" role="alert" aria-live="assertive" hidden>
                <span aria-hidden="true">!</span>
                <span id="login-error-text"></span>
              </div>
            </form>
            <div style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: 'var(--muted)' }}>
              <a href="#" id="auth-mode-toggle" style={{ color: 'var(--brand)', textDecoration: 'none', fontWeight: '500' }}>
                Don't have an account? Sign up
              </a>
            </div>
            <div id="signup-success-wrap" className="signup-success-wrap" hidden style={{ marginTop: '16px', padding: '16px', borderRadius: '12px', background: 'var(--raised)', border: '1px solid var(--border)' }}>
              <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', color: 'var(--brand)' }}>Signup Successful!</h3>
              <p className="muted" style={{ fontSize: '12.5px', margin: '0 0 12px 0' }}>Your member account is created. Copy your API Key and setup command now to start tracking your tokens:</p>
              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)', fontSize: '12px', marginBottom: '16px' }}>
                <div style={{ wordBreak: 'break-all', marginBottom: '8px' }}><strong>API Key:</strong> <code id="su-api-key" style={{ color: 'var(--brand-hi)', userSelect: 'all', fontWeight: 'bold' }}></code></div>
                <div style={{ marginTop: '8px' }}><strong>🍎 Mac Command:</strong><br/><pre id="su-cmd-mac" style={{ background: 'rgba(0,0,0,0.4)', padding: '6px', borderRadius: '4px', overflowX: 'auto', margin: '4px 0 0 0', fontFamily: 'monospace', userSelect: 'all', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}></pre></div>
                <div style={{ marginTop: '8px' }}><strong>🪟 Windows Command:</strong><br/><pre id="su-cmd-win" style={{ background: 'rgba(0,0,0,0.4)', padding: '6px', borderRadius: '4px', overflowX: 'auto', margin: '4px 0 0 0', fontFamily: 'monospace', userSelect: 'all', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}></pre></div>
              </div>
              <button type="button" className="login-submit" id="su-continue-btn" style={{ width: '100%', cursor: 'pointer' }}>
                Continue to Dashboard
              </button>
            </div>
          </div>
          <p className="login-footer">Token usage analytics for AI coding agents</p>
        </div>

        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var form = document.getElementById('login-form');
            var errEl = document.getElementById('login-error');
            var errText = document.getElementById('login-error-text');
            var btn = document.getElementById('login-submit');
            var pwInput = document.getElementById('login-password');
            var pwToggle = document.getElementById('login-password-toggle');
            if (!form) return;

            var mode = 'login';
            var modeToggle = document.getElementById('auth-mode-toggle');
            var taglineEl = document.querySelector('.login-brand .login-tagline');
            var submitLabel = document.querySelector('#login-submit .login-submit-label');
            var fieldDisplayName = document.getElementById('field-displayname');
            var fieldRole = document.getElementById('field-role');
            var fieldTeamName = document.getElementById('field-teamname');
            var inputRole = document.getElementById('login-role');
            var successWrap = document.getElementById('signup-success-wrap');
            var continueBtn = document.getElementById('su-continue-btn');
            
            var usernameInput = document.getElementById('login-username');
            var displayNameInput = document.getElementById('login-displayname');
            var teamNameInput = document.getElementById('login-teamname');

            if (pwToggle) {
              var eyeOpen = pwToggle.querySelector('.eye-open');
              var eyeClosed = pwToggle.querySelector('.eye-closed');
              pwToggle.addEventListener('click', function() {
                var show = pwInput.type === 'password';
                pwInput.type = show ? 'text' : 'password';
                pwToggle.setAttribute('aria-pressed', String(show));
                pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
                if (eyeOpen) eyeOpen.hidden = show;
                if (eyeClosed) eyeClosed.hidden = !show;
              });
            }

            if (modeToggle) {
              modeToggle.addEventListener('click', function(e) {
                e.preventDefault();
                errEl.hidden = true;
                if (mode === 'login') {
                  mode = 'signup';
                  modeToggle.textContent = 'Already have an account? Sign in';
                  if (taglineEl) taglineEl.textContent = 'Create a free user or admin account';
                  if (submitLabel) submitLabel.textContent = 'Sign up';
                  if (fieldDisplayName) fieldDisplayName.hidden = false;
                  if (fieldRole) fieldRole.hidden = false;
                  if (inputRole) inputRole.value = 'user';
                  if (fieldTeamName) fieldTeamName.hidden = true;
                  if (displayNameInput) displayNameInput.required = true;
                  if (teamNameInput) teamNameInput.required = false;
                } else {
                  mode = 'login';
                  modeToggle.textContent = "Don't have an account? Sign up";
                  if (taglineEl) taglineEl.textContent = 'Sign in to your analytics workspace';
                  if (submitLabel) submitLabel.textContent = 'Sign in';
                  if (fieldDisplayName) fieldDisplayName.hidden = true;
                  if (fieldRole) fieldRole.hidden = true;
                  if (fieldTeamName) fieldTeamName.hidden = true;
                  if (displayNameInput) displayNameInput.required = false;
                  if (teamNameInput) teamNameInput.required = false;
                }
              });
            }

            if (inputRole) {
              inputRole.addEventListener('change', function() {
                var isAdmin = inputRole.value === 'admin';
                if (fieldTeamName) fieldTeamName.hidden = !isAdmin;
                if (teamNameInput) teamNameInput.required = isAdmin;
              });
            }

            function setBusy(busy) {
              btn.disabled = busy;
              btn.classList.toggle('is-busy', busy);
            }

            form.addEventListener('submit', async function(e) {
              e.preventDefault();
              errEl.hidden = true;
              setBusy(true);
              try {
                var username = usernameInput.value.trim();
                var password = pwInput.value;

                if (mode === 'login') {
                  var res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, password: password }),
                    credentials: 'same-origin',
                  });
                  var data = await res.json().catch(function() { return {}; });
                  if (res.ok && data.redirect) {
                    window.location.href = data.redirect;
                  } else {
                    errText.textContent = data.error || 'Sign in failed. Please try again.';
                    errEl.hidden = false;
                    setBusy(false);
                  }
                } else {
                  var displayName = displayNameInput.value.trim();
                  var role = inputRole.value;
                  var teamName = teamNameInput.value.trim();

                  if (!username || !password || !displayName || (role === 'admin' && !teamName)) {
                    errText.textContent = 'Please fill out all required fields.';
                    errEl.hidden = false;
                    setBusy(false);
                    return;
                  }

                  var res = await fetch('/api/auth/signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      username: username,
                      password: password,
                      displayName: displayName,
                      role: role,
                      teamName: teamName
                    }),
                  });

                  var data = await res.json().catch(function() { return {}; });
                  if (!res.ok) {
                    throw new Error(data.error || 'Sign up failed.');
                  }

                  if (role === 'admin') {
                    // Admin auto-login
                    var loginRes = await fetch('/api/auth/login', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ username: username, password: password }),
                      credentials: 'same-origin',
                    });
                    var loginData = await loginRes.json().catch(function() { return {}; });
                    if (loginRes.ok && loginData.redirect) {
                      window.location.href = loginData.redirect;
                    } else {
                      window.location.reload();
                    }
                  } else {
                    form.hidden = true;
                    if (modeToggle) modeToggle.parentElement.hidden = true;
                    
                    document.getElementById('su-api-key').textContent = data.apiKey;
                    document.getElementById('su-cmd-mac').textContent = data.installCommandMac;
                    document.getElementById('su-cmd-win').textContent = data.installCommandWin;
                    
                    if (successWrap) successWrap.hidden = false;

                    if (continueBtn) {
                      continueBtn.addEventListener('click', async function() {
                        continueBtn.disabled = true;
                        continueBtn.textContent = 'Logging in...';
                        try {
                          var loginRes = await fetch('/api/auth/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ username: username, password: password }),
                            credentials: 'same-origin',
                          });
                          var loginData = await loginRes.json().catch(function() { return {}; });
                          if (loginRes.ok && loginData.redirect) {
                            window.location.href = loginData.redirect;
                          } else {
                            window.location.href = '/';
                          }
                        } catch (err) {
                          window.location.href = '/';
                        }
                      });
                    }
                  }
                }
              } catch (err) {
                errText.textContent = err.message || 'Network error. Please try again.';
                errEl.hidden = false;
                setBusy(false);
              }
            });
          })();
        ` }} />
      </div>
    );
  }

  // If there is an active session for standard user, render personal dashboard
  return (
    <div suppressHydrationWarning>
      <Script src="/impersonation.js" strategy="afterInteractive" />
      {/* Shown only until the cookie session check resolves */}
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
          <p className="tt-loader-label">Tracing <em>your</em> tokens…</p>
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

                  {/* Member Filter */}
                  <label className="filter-label">Member
                    <select id="global-member-filter">
                      <option value="all">All Members</option>
                    </select>
                  </label>

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

            </div>
          </main>
        </div>
      </div>



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

      <Script src="/toast.js" strategy="afterInteractive" />
      <Script src="/loader.js" strategy="afterInteractive" />
      <Script src="/team/app.js" strategy="afterInteractive" />
    </div>
  );
}
