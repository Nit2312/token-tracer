import type { Metadata } from 'next';
import Script from 'next/script';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionFromCookie } from '@/lib/auth';
import { PersonalDashboardView } from '@/components/dashboard/PersonalDashboardView';

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

  // If there is an active session for standard user, render the modern personal dashboard
  return (
    <div suppressHydrationWarning>
      <Script src="/impersonation.js" strategy="afterInteractive" />
      <PersonalDashboardView 
        user={{
          id: session.userId,
          username: session.username,
          displayName: session.displayName || session.username,
          role: session.role
        }} 
      />
    </div>
  );
}
