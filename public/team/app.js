/* Team admin UI — deep analytics for members, projects, tokens, model pricing, and files */
const RANGE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'all', label: 'All' },
];

let teams = [];
let teamId = localStorage.getItem('team-id') || '';
let dateRange = { from: '', to: '', all: true };
let adminToken = sessionStorage.getItem('team-admin-token') || '';
let currentStatsData = null;
let currentMembersList = [];
let currentUser = null;

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) {
      window.location.href = '/';
      return false;
    }
    currentUser = await res.json();
    if (currentUser.role !== 'admin' && currentUser.role !== 'superadmin' && currentUser.role !== 'user') {
      window.location.href = '/';
      return false;
    }

    const nameEl = document.getElementById('team-admin-name');
    if (nameEl) nameEl.textContent = currentUser.displayName || currentUser.username || 'Profile';

    setupTeamProfileHandlers();

    return true;
  } catch {
    window.location.href = '/';
    return false;
  }
}

function openTeamProfileModal() {
  const dialog = document.getElementById('team-profile-dialog');
  if (!dialog) return;

  const usernameEl = document.getElementById('team-profile-username-val');
  if (usernameEl) usernameEl.textContent = currentUser?.username || '—';

  const roleEl = document.getElementById('team-profile-role-val');
  if (roleEl) {
    if (currentUser?.role === 'superadmin') {
      roleEl.textContent = 'Superadmin';
    } else if (currentUser?.role === 'admin') {
      roleEl.textContent = 'Team Admin';
    } else {
      roleEl.textContent = 'Member';
    }
  }

  const teamsEl = document.getElementById('team-profile-teams-val');
  if (teamsEl) {
    const teamNames = (currentUser?.teams || []).map((t) => t.name);
    teamsEl.textContent = teamNames.length > 0 ? teamNames.join(', ') : 'All Workspaces';
  }

  const nameInput = document.getElementById('team-profile-display-name');
  if (nameInput) nameInput.value = currentUser?.displayName || currentUser?.username || '';

  const currentPwd = document.getElementById('team-profile-current-password');
  if (currentPwd) currentPwd.value = '';

  const newPwd = document.getElementById('team-profile-new-password');
  if (newPwd) newPwd.value = '';

  const confirmPwd = document.getElementById('team-profile-confirm-password');
  if (confirmPwd) confirmPwd.value = '';

  const errEl = document.getElementById('team-profile-error-msg');
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = '';
  }

  dialog.showModal();
}

function setupTeamProfileHandlers() {
  const dialog = document.getElementById('team-profile-dialog');
  if (!dialog || dialog._profileInitialized) return;
  dialog._profileInitialized = true;

  document.getElementById('team-profile-btn')?.addEventListener('click', () => {
    openTeamProfileModal();
  });

  document.getElementById('cancel-team-profile-btn')?.addEventListener('click', () => {
    dialog.close();
  });

  const form = document.getElementById('team-profile-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('team-profile-error-msg');
      const submitBtn = document.getElementById('save-team-profile-btn');
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = '';
      }

      const displayName = (document.getElementById('team-profile-display-name')?.value || '').trim();
      const currentPassword = document.getElementById('team-profile-current-password')?.value || '';
      const newPassword = document.getElementById('team-profile-new-password')?.value || '';
      const confirmPassword = document.getElementById('team-profile-confirm-password')?.value || '';

      if (displayName.length < 2) {
        if (errEl) {
          errEl.textContent = 'Display name must be at least 2 characters long.';
          errEl.hidden = false;
        }
        return;
      }

      if (newPassword) {
        if (newPassword.length < 6) {
          if (errEl) {
            errEl.textContent = 'New password must be at least 6 characters long.';
            errEl.hidden = false;
          }
          return;
        }
        if (newPassword !== confirmPassword) {
          if (errEl) {
            errEl.textContent = 'New passwords do not match.';
            errEl.hidden = false;
          }
          return;
        }
        if (!currentPassword) {
          if (errEl) {
            errEl.textContent = 'Please enter your current password to change password.';
            errEl.hidden = false;
          }
          return;
        }
      }

      const origText = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
      }

      try {
        const payload = { displayName };
        if (newPassword) {
          payload.currentPassword = currentPassword;
          payload.newPassword = newPassword;
        }

        const res = await fetch('/api/auth/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to update profile');
        }

        currentUser.displayName = displayName;
        const nameEl = document.getElementById('team-admin-name');
        if (nameEl) nameEl.textContent = displayName;

        dialog.close();
        if (window.showToast) {
          window.showToast('Profile updated successfully!', { type: 'success' });
        }
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message;
          errEl.hidden = false;
        } else if (window.showToast) {
          window.showToast(err.message, { type: 'error' });
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = origText;
        }
      }
    });
  }
}

function localDayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftLocalDay(daysBack) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return localDayKey(d);
}

function rangeFromPreset(id) {
  const today = localDayKey();
  if (id === 'today') return { from: today, to: today, all: false };
  if (id === '7d') return { from: shiftLocalDay(6), to: today, all: false };
  if (id === '30d') return { from: shiftLocalDay(29), to: today, all: false };
  if (id === '90d') return { from: shiftLocalDay(89), to: today, all: false };
  return { from: '', to: '', all: true };
}

function cleanProjectName(p) {
  if (!p || p === 'default' || p === 'unknown') return 'default';
  let s = String(p).trim();
  if (s.includes('/') || s.includes('\\')) {
    const parts = s.split(/[\/\\]/).filter(Boolean);
    return parts[parts.length - 1] || s;
  }
  if (/^(Users|home|[A-Z])-/i.test(s)) {
    s = s.replace(/^(Users|home|C)-[^-]+-(Coding|Projects|code|dev|workspace|github)-/i, '');
    s = s.replace(/^(Users|home|C)-[^-]+-/i, '');
  }
  return s || 'default';
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (adminToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${adminToken}`;
  }
  const res = await fetch(path, { credentials: 'include', ...opts, headers });
  if (res.status === 401) {
    adminToken = '';
    sessionStorage.removeItem('team-admin-token');
    showLogin();
    throw new Error('session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showRecalculationLoader(msg = 'Updating token cost calculations…') {
  let loader = document.getElementById('cost-calculation-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'cost-calculation-loader';
    loader.className = 'cost-calc-banner';
    document.body.appendChild(loader);
  }
  const html = typeof window.ttLoaderHtml === 'function'
    ? window.ttLoaderHtml(msg, { inline: true })
    : `<span>${msg}</span>`;
  loader.innerHTML = html;
  loader.hidden = false;
}

function hideRecalculationLoader() {
  const loader = document.getElementById('cost-calculation-loader');
  if (loader) loader.hidden = true;
}

function setLoginError(msg) {
  const errEl = document.getElementById('login-error');
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.hidden = !msg;
}

function setAppError(msg) {
  const el = document.getElementById('app-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

function setLoading(on) {
  const loading = document.getElementById('app-loading');
  const content = document.getElementById('app-content');
  const soft = document.getElementById('data-loading');
  if (loading) loading.hidden = !on;
  if (content) content.hidden = on;
  // Never stack soft overlay on top of the full-page loader.
  if (on && soft) soft.hidden = true;
  if (on && typeof window.resetDataLoading === 'function') window.resetDataLoading();
}

function softLoading(on, label) {
  if (typeof window.setDataLoading === 'function') {
    window.setDataLoading(on, label || 'Tracing tokens…');
  }
}

function setLoginBusy(on) {
  const btn = document.getElementById('login-submit');
  if (!btn) return;
  btn.disabled = on;
  btn.textContent = on ? 'Signing in…' : 'Sign in';
}

function hideBootLoading() {
  const el = document.getElementById('boot-loading');
  if (el) el.hidden = true;
}

function showLogin() {
  hideBootLoading();
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app').hidden = true;
  setLoading(false);
  if (typeof window.resetDataLoading === 'function') window.resetDataLoading();
}

function showDashboardShell() {
  hideBootLoading();
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
}

/** Consistent, reusable "nothing to show" placeholder for any panel/table. */
function emptyState(message) {
  return `<div class="table-empty"><span class="table-empty-icon" aria-hidden="true">\u25CC</span><p>${message}</p></div>`;
}

function fmt(n) {
  if (n == null) return '—';
  const num = Number(n);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return num % 1 === 0 ? String(num) : num.toFixed(1);
}

function fmtCost(n) {
  if (n == null || !Number(n)) return '$0.00';
  return `$${Number(n).toFixed(2)}`;
}

function fmtMicroCost(n) {
  if (n == null || !Number(n)) return '$0.00';
  const num = Number(n);
  if (num < 0.01) {
    return `$${num.toFixed(4)}`;
  }
  return `$${num.toFixed(2)}`;
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_FULL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
function fmtHour(h) {
  return h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
}

// hour × weekday activity heat grid — same shape as the legacy personal-dashboard punchcard
function renderActivityRhythm(punch, activity) {
  const host = document.getElementById('activity-rhythm');
  if (!host) return;
  if (!punch || !activity || !activity.activeDays) {
    host.innerHTML = emptyState('No activity data yet for this range');
    return;
  }
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon-first
  const values = punch.flat().filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => (values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : 1);
  const th = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const cls = (v) => (v <= 0 ? '' : v <= th[0] ? 'h1' : v <= th[1] ? 'h2' : v <= th[2] ? 'h3' : v <= th[3] ? 'h4' : 'h5');

  let cells = '';
  for (const w of order) {
    for (let h = 0; h < 24; h++) {
      cells += `<span class="cell ${cls(punch[w][h])}" title="${DOW[w]} ${fmtHour(h)}: ${punch[w][h]} events"></span>`;
    }
  }
  const hours = Array.from({ length: 24 }, (_, h) => `<span>${fmtHour(h).replace('m', '')}</span>`).join('');

  const peak = activity.peakHour;
  host.innerHTML = `
    <div class="punch">
      <div class="dows">${order.map((w) => `<span>${DOW[w]}</span>`).join('')}</div>
      <div class="cells">${cells}</div>
      <div></div>
      <div class="hours">${hours}</div>
    </div>
    <div class="punch-note">
      ${peak && peak.n > 0 ? `Peak: <b>${DOW_FULL[peak.weekday]} around ${fmtHour(peak.hour)}</b> — ${peak.n} events. ` : ''}
      Active <b>${activity.activeDays}</b> day${activity.activeDays === 1 ? '' : 's'} in range · current streak <b>${activity.streak}d</b>
    </div>`;
}

function renderPresets() {
  const el = document.getElementById('range-presets');
  if (!el) return;
  el.innerHTML = '';
  for (const p of RANGE_PRESETS) {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.type = 'button';
    const active = p.id === 'all' ? dateRange.all : (!dateRange.all && rangeFromPreset(p.id).from === dateRange.from && rangeFromPreset(p.id).to === dateRange.to);
    if (active) btn.classList.add('active');
    btn.onclick = () => {
      dateRange = rangeFromPreset(p.id);
      document.getElementById('range-from').value = dateRange.from;
      document.getElementById('range-to').value = dateRange.to;
      renderPresets();
      updateFiltersBadge();
      loadStats().catch((err) => setAppError(formatError(err.message)));
    };
    el.appendChild(btn);
  }
}

function statsQuery() {
  const params = new URLSearchParams({ teamId });
  if (!dateRange.all && dateRange.from) params.set('from', dateRange.from);
  if (!dateRange.all && dateRange.to) params.set('to', dateRange.to);

  const memberId = document.getElementById('global-member-filter')?.value;
  if (memberId && memberId !== 'all') params.set('memberId', memberId);

  const source = document.getElementById('global-source-filter')?.value;
  if (source && source !== 'all') params.set('source', source);

  const minTokens = document.getElementById('global-min-tokens-filter')?.value;
  if (minTokens && Number(minTokens) > 0) params.set('minTokens', minTokens);

  return params.toString();
}

function renderBars(containerId, rows, labelKey, valueKey) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!rows?.length) { el.innerHTML = emptyState('No data matching active filters'); return; }
  const max = Math.max(...rows.map((r) => r[valueKey]), 1);
  el.innerHTML = rows.map((r) => `
    <div class="bar-row">
      <span class="name">${r[labelKey]}</span>
      <div class="track"><div class="fill" style="width:${Math.round((r[valueKey] / max) * 100)}%"></div></div>
      <span class="val">${fmt(r[valueKey])}</span>
    </div>`).join('');
}

function renderTotals(t) {
  const el = document.getElementById('totals');
  if (!el || !t) return;
  el.innerHTML = [
    ['Sessions', fmt(t.sessions), 'Agent executions'],
    ['Input Tokens', fmt(t.tokensIn), 'Sent to LLM'],
    ['Output Tokens', fmt(t.tokensOut), 'Generated by LLM'],
    ['Cache-Read Tokens', fmt(t.tokensCacheRead), 'Reused prompt context'],
    ['Code Edits', fmt(t.edits), `${fmt(t.changedLines)} lines changed`],
    ['API Equivalent Cost', fmtCost(t.apiCost), 'Estimated billable value'],
  ].map(([label, value, sub]) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`).join('');
}

// Flags members whose error/correction/abandonment rate runs well above the team
// average (computed server-side in buildTeamStats), so an admin doesn't have to
// eyeball the raw head-to-head scoreboard to spot who might need help.
function renderAtRisk(rows) {
  const panel = document.getElementById('at-risk-panel');
  const host = document.getElementById('at-risk');
  if (!panel || !host) return;
  if (!rows || !rows.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  host.innerHTML = rows.map((r) => `
    <div style="padding:10px 0;border-bottom:1px solid var(--border);">
      <div><b>${r.display_name}</b> <span class="muted" style="font-size:12px">(${r.sessions} sessions)</span></div>
      <ul style="margin:6px 0 0 18px;padding:0;font-size:12.5px;color:var(--muted)">
        ${r.reasons.map((reason) => `<li>${reason}</li>`).join('')}
      </ul>
    </div>`).join('');
}

function renderLeaderboard(rows) {
  const el = document.getElementById('leaderboard');
  if (!el) return;
  if (!rows?.length) { el.innerHTML = emptyState('No member data matching active filters'); return; }
  el.innerHTML = `<table><thead><tr>
    <th>Member</th><th>Sessions</th><th>Input Tokens</th><th>Output Tokens</th><th>Edits</th><th>Lines Diff</th><th>Est. Cost</th>
  </tr></thead><tbody>${rows.map((r) => `<tr>
    <td><strong>👤 ${r.display_name}</strong></td>
    <td>${fmt(r.sessions)}</td>
    <td>${fmt(r.tokens_in)}</td>
    <td>${fmt(r.tokens_out)}</td>
    <td>${fmt(r.edits)}</td>
    <td><span class="diff-add">+${fmt(r.additions || 0)}</span> / <span class="diff-del">−${fmt(r.deletions || 0)}</span></td>
    <td><strong>${fmtCost(r.api_cost)}</strong></td>
  </tr>`).join('')}</tbody></table>`;
}

function renderTokenLeaderboard(rows) {
  const el = document.getElementById('token-leaderboard-table');
  if (!el) return;
  if (!rows?.length) { el.innerHTML = emptyState('No token records matching active filters'); return; }
  const maxTokens = rows[0]?.total_tokens || 1;

  el.innerHTML = `<table><thead><tr>
    <th>Rank</th><th>Member</th><th>Total Tokens</th><th>Team Share</th><th>Input Tokens</th><th>Output Tokens</th><th>Cache Read</th><th>Est. API Cost</th><th style="text-align:right;">Deep Dive</th>
  </tr></thead><tbody>${rows.map((r, i) => `<tr>
    <td><strong>#${i + 1}</strong></td>
    <td><strong>👤 ${r.display_name}</strong></td>
    <td><strong style="color:var(--brand-hi);">${fmt(r.total_tokens)}</strong></td>
    <td>
      <div class="bar-row" style="margin:0">
        <div class="track" style="width:80px"><div class="fill" style="width:${Math.round((r.total_tokens / maxTokens) * 100)}%"></div></div>
        <span class="val">${r.share_pct ? r.share_pct.toFixed(1) + '%' : '—'}</span>
      </div>
    </td>
    <td>${fmt(r.tokens_in)}</td>
    <td>${fmt(r.tokens_out)}</td>
    <td>${fmt(r.tokens_cache_read)}</td>
    <td><strong>${fmtCost(r.api_cost)}</strong></td>
    <td style="text-align:right;">
      <button type="button" class="hbtn" style="font-size:11px; padding:3px 8px; border-color:var(--brand); color:var(--brand-hi);" onclick="openTeamMemberDeepDive('${r.member_id}', '${encodeURIComponent(r.display_name)}')">
        🔍 Analyze
      </button>
    </td>
  </tr>`).join('')}</tbody></table>`;
}

function renderHeadToHead(rows) {
  const el = document.getElementById('head-to-head-table');
  if (!el) return;
  if (!rows?.length) { el.innerHTML = emptyState('No efficiency data available'); return; }
  el.innerHTML = `<table><thead><tr>
    <th>Member</th><th>Edits / Session</th><th>Tokens / Edit</th><th>Tool Error Rate</th><th>Cache Efficiency</th><th>Cost / Edit</th><th>Cost / 100 Lines</th>
  </tr></thead><tbody>${rows.map((r) => `<tr>
    <td><strong>👤 ${r.display_name}</strong></td>
    <td>${r.editsPerSession.toFixed(2)}</td>
    <td>${fmt(r.outputTokensPerEdit)}</td>
    <td>${fmtPct(r.toolErrorRate)}</td>
    <td>${fmtPct(r.cacheEfficiency)}</td>
    <td>${fmtMicroCost(r.costPerEdit)}</td>
    <td>${fmtMicroCost(r.costPer100Lines)}</td>
  </tr>`).join('')}</tbody></table>`;
}

function renderMemberDrilldown(membersData) {
  const select = document.getElementById('member-filter-select');
  const container = document.getElementById('member-drilldown-cards');
  if (!container || !membersData) return;

  if (select) {
    const currentVal = select.value;
    select.innerHTML = '<option value="all">All Members</option>' +
      membersData.map((m) => `<option value="${m.member_id}">${m.display_name}</option>`).join('');
    if (currentVal && membersData.some((m) => m.member_id === currentVal)) select.value = currentVal;
    else select.value = 'all';
    select.onchange = () => renderMemberDrilldown(membersData);
  }

  const selectedId = select?.value || 'all';
  const filtered = selectedId === 'all' ? membersData : membersData.filter((m) => m.member_id === selectedId);

  if (!filtered.length) {
    container.innerHTML = emptyState('No member data matching filters');
    return;
  }

  container.innerHTML = filtered.map((m) => {
    const sourcesHtml = m.sources?.length
      ? m.sources.map((s) => `
        <div class="bar-row">
          <span class="name"><span class="source-tag">${s.source}</span></span>
          <div class="track"><div class="fill" style="width:${Math.min(100, (s.tokens_in / Math.max(1, m.tokens_in)) * 100)}%"></div></div>
          <span class="val">${fmt(s.tokens_in)} in / ${fmtCost(s.api_cost)}</span>
        </div>`).join('')
      : emptyState('No source breakdown');

    const projectsHtml = m.projects?.length
      ? `<div class="table-wrap"><table><thead><tr><th>Project / Workspace</th><th>Source</th><th>Sessions</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>` +
        m.projects.map((p) => `<tr>
          <td><strong>📁 ${cleanProjectName(p.project)}</strong></td>
          <td><span class="source-tag">${p.source}</span></td>
          <td>${fmt(p.sessions)}</td>
          <td>${fmt(p.tokens_in)} in</td>
          <td>${fmtCost(p.api_cost)}</td>
        </tr>`).join('') + `</tbody></table></div>`
      : emptyState('No projects logged yet');

    const modelsHtml = m.models?.length
      ? `<div class="table-wrap"><table><thead><tr><th>LLM Model Used</th><th>Source</th><th>Sessions</th><th>Tokens (In/Out)</th><th>Est. Cost</th></tr></thead><tbody>` +
        m.models.map((mod) => `<tr>
          <td><strong>🤖 <code>${mod.model}</code></strong></td>
          <td><span class="source-tag">${mod.source}</span></td>
          <td>${fmt(mod.sessions)}</td>
          <td>${fmt(mod.tokens_in)} / ${fmt(mod.tokens_out)}</td>
          <td><strong>${fmtCost(mod.api_cost)}</strong></td>
        </tr>`).join('') + `</tbody></table></div>`
      : emptyState('No model usage logged yet');

    const filesHtml = m.topFiles?.length
      ? `<div class="table-wrap"><table><thead><tr><th>File Path</th><th>Edits</th><th>Diff (+ / −)</th></tr></thead><tbody>` +
        m.topFiles.map((f) => `<tr>
          <td><code>${f.path}</code></td>
          <td>${fmt(f.edits)}</td>
          <td><span class="diff-add">+${fmt(f.additions)}</span> <span class="diff-del">−${fmt(f.deletions)}</span></td>
        </tr>`).join('') + `</tbody></table></div>`
      : emptyState('No code edit payloads found');

    return `
      <details class="member-card" open id="member-card-${m.member_id}">
        <summary class="member-header">
          <div style="display:flex; align-items:center; gap:10px;">
            <h3 style="margin:0;">👤 ${m.display_name}</h3>
            <span class="source-tag">${fmt(m.sessions)} sessions</span>
            <span class="source-tag">${fmt(Number(m.tokens_in || 0) + Number(m.tokens_out || 0))} tokens</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <strong>${fmtCost(m.api_cost)} total cost</strong>
            <button type="button" class="hbtn primary" style="font-size:11px;padding:3px 8px;" onclick="event.stopPropagation(); openTeamMemberDeepDive('${m.member_id}', '${encodeURIComponent(m.display_name)}')">🔍 Full Token Breakdown</button>
            <button type="button" class="hbtn" style="border-color:var(--brand);color:var(--brand-hi);font-size:11px;padding:3px 8px;" onclick="event.stopPropagation(); triggerMemberSync('${m.member_id}', '${encodeURIComponent(m.display_name)}')">⚡ Trigger Sync</button>
            <span class="collapse-icon">▼</span>
          </div>
        </summary>
        <div class="member-body">
          <div class="member-stats-grid">
            <div class="mini-stat"><span>Input Tokens</span><strong>${fmt(m.tokens_in)}</strong></div>
            <div class="mini-stat"><span>Output Tokens</span><strong>${fmt(m.tokens_out)}</strong></div>
            <div class="mini-stat"><span>Cache Read</span><strong>${fmt(m.tokens_cache_read)}</strong></div>
            <div class="mini-stat"><span>Code Edits</span><strong>${fmt(m.edits)}</strong></div>
            <div class="mini-stat"><span>Lines Changed</span><strong>+${fmt(m.additions || 0)} / −${fmt(m.deletions || 0)}</strong></div>
            <div class="mini-stat"><span>API Cost</span><strong>${fmtCost(m.api_cost)}</strong></div>
          </div>
          <div class="member-sections">
            <div class="member-subpanel">
              <h4>AI Tools & Accounts Used</h4>
              ${sourcesHtml}
            </div>
            <div class="member-subpanel">
              <h4>Projects & Repos Worked On</h4>
              ${projectsHtml}
            </div>
          </div>
          <div style="margin-top: 14px;" class="member-sections">
            <div class="member-subpanel">
              <h4>LLM Models Used by ${m.display_name}</h4>
              ${modelsHtml}
            </div>
            <div class="member-subpanel">
              <h4>Top Modified Files by ${m.display_name}</h4>
              ${filesHtml}
            </div>
          </div>
        </div>
      </details>`;
  }).join('');
}

function renderProjects(projectsData) {
  const el = document.getElementById('projects-table');
  if (!el) return;
  if (!projectsData?.length) {
    el.innerHTML = emptyState('No project activity matching filters');
    return;
  }
  el.innerHTML = `<table><thead><tr>
    <th>Project / Workspace Name</th><th>Contributors</th><th>AI Sources</th><th>Sessions</th><th>Input Tokens</th><th>Output Tokens</th><th>Lines Changed</th><th>Total API Cost</th>
  </tr></thead><tbody>${projectsData.map((p) => {
    const memberNames = p.members?.map((m) => m.display_name).join(', ') || '—';
    return `<tr>
      <td><strong>📁 ${cleanProjectName(p.project)}</strong> <br/><small class="muted">${p.project}</small></td>
      <td>${memberNames}</td>
      <td><span class="source-tag">${p.source_count || 1} sources</span></td>
      <td>${fmt(p.sessions)}</td>
      <td>${fmt(p.tokens_in)}</td>
      <td>${fmt(p.tokens_out)}</td>
      <td><span class="diff-add">+${fmt(p.changed_lines)}</span></td>
      <td><strong>${fmtCost(p.api_cost)}</strong></td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function renderTopFiles(filesData) {
  const el = document.getElementById('top-files');
  if (!el) return;
  if (!filesData?.length) {
    el.innerHTML = emptyState('No code modification payloads matching filters');
    return;
  }
  el.innerHTML = `<table><thead><tr>
    <th>Codebase File Path</th><th>Edits</th><th>Lines Added</th><th>Lines Removed</th><th>Total Diff</th><th>Contributors</th>
  </tr></thead><tbody>${filesData.map((f) => `<tr>
    <td><code>${f.path}</code></td>
    <td>${fmt(f.edits)}</td>
    <td><span class="diff-add">+${fmt(f.additions || 0)}</span></td>
    <td><span class="diff-del">−${fmt(f.deletions || 0)}</span></td>
    <td><strong>${fmt(f.changed_lines)}</strong></td>
    <td>${fmt(f.member_count || 1)} member(s)</td>
  </tr>`).join('')}</tbody></table>`;
}

function renderSessionLogs(logs) {
  const el = document.getElementById('session-logs-table');
  if (!el) return;
  if (!logs?.length) {
    el.innerHTML = emptyState('No activity logs matching filters');
    return;
  }
  el.innerHTML = `<table><thead><tr>
    <th>Timestamp</th><th>Member</th><th>Project</th><th>Source / Agent</th><th>Model</th><th>Tokens (In/Out)</th><th>Cost</th>
  </tr></thead><tbody>${logs.map((l) => `<tr>
    <td>${fmtDate(l.timestamp)}</td>
    <td><strong>👤 ${l.member_name}</strong></td>
    <td><code>${cleanProjectName(l.project)}</code></td>
    <td><span class="source-tag">${l.source}</span></td>
    <td>${l.model || '—'}</td>
    <td>${fmt(l.tokens_in)} / ${fmt(l.tokens_out)}</td>
    <td><strong>${fmtCost(l.api_cost)}</strong></td>
  </tr>`).join('')}</tbody></table>`;
}

function renderModelPricingTable(pricingList) {
  const el = document.getElementById('model-pricing-table');
  if (!el) return;

  const defaultDefaults = [
    { model_pattern: 'claude-3-5-sonnet / 3-7-sonnet', cost_in_per_m: 3.00, cost_out_per_m: 15.00, cost_cache_read_per_m: 0.30, isDefault: true },
    { model_pattern: 'claude-3-5-haiku', cost_in_per_m: 0.80, cost_out_per_m: 4.00, cost_cache_read_per_m: 0.08, isDefault: true },
    { model_pattern: 'gpt-4o', cost_in_per_m: 2.50, cost_out_per_m: 10.00, cost_cache_read_per_m: 1.25, isDefault: true },
    { model_pattern: 'o1 / o3-mini', cost_in_per_m: 1.10, cost_out_per_m: 4.40, cost_cache_read_per_m: 0.55, isDefault: true },
  ];

  const customRows = pricingList?.length ? pricingList : [];
  const displayRows = [...customRows, ...defaultDefaults];

  el.innerHTML = `<table><thead><tr>
    <th>Model Pattern / Name</th><th>Input Cost ($/1M)</th><th>Output Cost ($/1M)</th><th>Cache-Read Cost ($/1M)</th><th>Type</th><th>Actions</th>
  </tr></thead><tbody>${displayRows.map((p) => `<tr>
    <td><strong><code>${p.model_pattern}</code></strong></td>
    <td>$${Number(p.cost_in_per_m).toFixed(2)} / 1M</td>
    <td>$${Number(p.cost_out_per_m).toFixed(2)} / 1M</td>
    <td>$${Number(p.cost_cache_read_per_m).toFixed(2)} / 1M</td>
    <td><span class="source-tag">${p.isDefault ? 'Standard Default' : 'Custom Team Override'}</span></td>
    <td>
      ${p.id ? `<button type="button" class="hbtn" style="color:#ee5555" onclick="deletePricingRule('${p.id}')">🗑️ Remove Rule</button>` : '—'}
    </td>
  </tr>`).join('')}</tbody></table>`;
}

function renderMemberModelsTable(memberModels) {
  const el = document.getElementById('member-models-table');
  if (!el) return;
  if (!memberModels?.length) {
    el.innerHTML = emptyState('No member model usage recorded matching filters');
    return;
  }
  el.innerHTML = `<table><thead><tr>
    <th>Member Name</th><th>LLM Model Used</th><th>Agent Source</th><th>Sessions</th><th>Input Tokens</th><th>Output Tokens</th><th>Estimated API Cost</th>
  </tr></thead><tbody>${memberModels.map((m) => `<tr>
    <td><strong>👤 ${m.member_name}</strong></td>
    <td>🤖 <code>${m.model}</code></td>
    <td><span class="source-tag">${m.source}</span></td>
    <td>${fmt(m.sessions)}</td>
    <td>${fmt(m.tokens_in)}</td>
    <td>${fmt(m.tokens_out)}</td>
    <td><strong>${fmtCost(m.api_cost)}</strong></td>
  </tr>`).join('')}</tbody></table>`;
}

window.deletePricingRule = async function (id) {
  if (!confirm('Are you sure you want to delete this model pricing override rule?')) return;
  showRecalculationLoader('Removing rule & recalculating session costs...');
  try {
    await api(`/api/v1/team/pricing?id=${id}&teamId=${teamId}`, { method: 'DELETE' });
    await loadStats();
    window.showToast('Pricing rule removed and costs recalculated.', { type: 'success' });
  } catch (err) {
    window.showToast(formatError(err.message), { type: 'error' });
  } finally {
    hideRecalculationLoader();
  }
};

function renderMembersTable(rows) {
  currentMembersList = rows || [];
  const select = document.getElementById('global-member-filter');
  if (select) {
    const currentVal = select.value;
    select.innerHTML = '<option value="all">All Members</option>' +
      (rows || []).map((m) => `<option value="${m.id}">${m.display_name}</option>`).join('');
    if (currentVal && rows && rows.some((m) => m.id === currentVal)) select.value = currentVal;
    else select.value = 'all';
  }

  const el = document.getElementById('members');
  if (!el) return;
  if (!rows?.length) { el.innerHTML = emptyState('No members registered'); return; }
  const host = window.location.origin;

  el.innerHTML = `<table><thead><tr>
    <th>Member Name</th><th>Role</th><th>Sessions</th><th>Tokens Used</th><th>Total API Cost</th><th>Last Sync</th><th>Daemon</th><th>Actions</th>
  </tr></thead><tbody>
    ${rows.map((m) => {
      const installCmd = `curl -fsSL ${host}/install.sh | bash -s -- --key ${m.api_key || 'av_live_YOUR_KEY'}`;
      const winInstallCmd = `$ApiKey="${m.api_key || 'av_live_YOUR_KEY'}"; iex (irm ${host}/install.ps1)`;
      const daemonBadge = renderDaemonVersionBadge(m.daemon_version, m.daemon_last_seen_at);
      return `<tr>
        <td><strong>👤 ${m.display_name}</strong></td>
        <td><span class="source-tag">${m.role}</span></td>
        <td>${fmt(m.session_count || 0)}</td>
        <td>${fmt(m.total_tokens || 0)}</td>
        <td><strong>${fmtCost(m.total_cost || 0)}</strong></td>
        <td>${fmtDate(m.last_sync_at)}</td>
        <td>${daemonBadge}</td>
        <td>
          <button type="button" class="hbtn" style="border-color:var(--brand);color:var(--brand-hi);" onclick="triggerMemberSync('${m.id}', '${encodeURIComponent(m.display_name)}')">⚡ Trigger Sync</button>
          <button type="button" class="hbtn primary" onclick="copyInstallCmd('${encodeURIComponent(installCmd)}', 'Mac')">📋 Mac Cmd</button>
          <button type="button" class="hbtn primary" onclick="copyInstallCmd('${encodeURIComponent(winInstallCmd)}', 'Windows')">📋 Win Cmd</button>
          <button type="button" class="hbtn" onclick="openEditMember('${m.id}', '${encodeURIComponent(m.display_name)}', '${m.role}')">✏️ Edit</button>
          <button type="button" class="hbtn" style="color:#ee5555" onclick="confirmDeleteMember('${m.id}', '${encodeURIComponent(m.display_name)}')">🗑️ Delete</button>
        </td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

// ── Daemon version badge ──────────────────────────────────────────────────────
// latestDaemonVersion is populated by loadReleases() when the releases panel loads.
let latestDaemonVersion = null;

function compareVersionParts(a, b) {
  const pa = (a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = (b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function renderDaemonVersionBadge(daemonVersion, lastSeenAt) {
  if (!daemonVersion) {
    return `<span class="source-tag daemon-badge daemon-badge--unknown" title="Daemon version unknown — pre-update install">⬜ unknown</span>`;
  }
  let colorClass = 'daemon-badge--current';
  let icon = '🟢';
  let hint = 'Up to date';
  if (latestDaemonVersion && daemonVersion !== latestDaemonVersion) {
    const delta = compareVersionParts(latestDaemonVersion, daemonVersion);
    if (delta >= 2) { colorClass = 'daemon-badge--outdated'; icon = '🔴'; hint = `Outdated — latest is v${latestDaemonVersion}`; }
    else if (delta === 1) { colorClass = 'daemon-badge--behind'; icon = '🟡'; hint = `1 version behind — latest is v${latestDaemonVersion}`; }
  }
  const seenStr = lastSeenAt ? `Last seen: ${fmtDate(lastSeenAt)}` : 'Never synced';
  return `<span class="source-tag daemon-badge ${colorClass}" title="${hint} | ${seenStr}">${icon} v${daemonVersion}</span>`;
}


window.copyInstallCmd = function (encodedCmd, osName) {
  const cmd = decodeURIComponent(encodedCmd);
  navigator.clipboard.writeText(cmd).then(() => {
    window.showToast(`${osName} install command copied to clipboard.`, { type: 'success' });
  }).catch(() => {
    prompt(`Copy ${osName} Install Command:`, cmd);
  });
};

window.openEditMember = function (id, encodedName, role) {
  const name = decodeURIComponent(encodedName);
  document.getElementById('edit-member-id').value = id;
  document.getElementById('edit-member-name').value = name;
  document.getElementById('edit-member-role').value = role || 'member';
  document.getElementById('edit-member-dialog').showModal();
};

window.confirmDeleteMember = async function (id, encodedName) {
  const name = decodeURIComponent(encodedName);
  if (!confirm(`Are you sure you want to remove "${name}" from this team?`)) {
    return;
  }
  try {
    await api(`/api/v1/team/members?id=${id}&teamId=${teamId}`, { method: 'DELETE' });
    loadMembers();
    loadStats();
    window.showToast(`Member "${name}" removed from this team.`, { type: 'success' });
  } catch (err) {
    window.showToast(formatError(err.message), { type: 'error' });
  }
};

let promptsPage = 1;
let promptsTotalPages = 1;
let promptsData = [];

let statsLoadGen = 0;

async function loadStats({ soft = true } = {}) {
  if (!teamId) return;
  promptsPage = 1;
  const gen = ++statsLoadGen;
  const fullLoading = document.getElementById('app-loading') && !document.getElementById('app-loading').hidden;
  const useSoft = soft && !fullLoading;
  if (useSoft) softLoading(true, 'Tracing tokens…');
  try {
    const stats = await api(`/api/v1/team/stats?${statsQuery()}`);
    if (gen !== statsLoadGen) return;
    currentStatsData = stats;

    renderTotals(stats.totals);
    renderLeaderboard(stats.leaderboard);
    renderTokenLeaderboard(stats.tokenLeaderboard);
    renderHeadToHead(stats.scoreboard);
    renderAtRisk(stats.atRisk);
    renderMemberDrilldown(stats.leaderboard);
    renderProjects(stats.projects);
    renderBars('by-source', stats.bySource, 'source', 'api_cost');
    renderBars('by-day', stats.byDay, 'date', 'tokens_in');
    renderBars('top-tools', stats.topTools, 'name', 'count');
    renderActivityRhythm(stats.punch, stats.activity);
    renderTopFiles(stats.topFiles);
    renderSessionLogs(stats.recentLogs);
    renderModelPricingTable(stats.modelPricing);
    renderMemberModelsTable(stats.memberModels);
    loadPrompts().catch(console.error);
  } finally {
    if (useSoft) softLoading(false);
  }
}

async function loadPrompts() {
  const tableEl = document.getElementById('prompts-table');
  if (!tableEl) return;
  
  const pageInfoEl = document.getElementById('prompts-page-info');
  
  try {
    const queryStr = statsQuery();
    const data = await api(`/api/v1/team/prompts?${queryStr}&page=${promptsPage}&limit=10`);
    promptsData = data.prompts || [];
    promptsTotalPages = data.totalPages || 1;
    
    if (pageInfoEl) {
      pageInfoEl.textContent = `Page ${promptsPage} of ${promptsTotalPages}`;
    }
    
    renderPromptsTable();
  } catch (err) {
    console.error('Failed to load prompts:', err);
    tableEl.innerHTML = `<p class="error" style="padding:12px">Error loading prompts: ${err.message}</p>`;
  }
}

function renderPromptsTable() {
  const el = document.getElementById('prompts-table');
  if (!el) return;
  
  if (!promptsData || !promptsData.length) {
    el.innerHTML = emptyState('No prompts found matching active filters');
    return;
  }
  
  el.innerHTML = `<table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Developer</th>
        <th>Model</th>
        <th>Tool</th>
        <th>Input Tokens</th>
        <th>Output Tokens</th>
        <th>Cache Read</th>
        <th>Prompt Text</th>
      </tr>
    </thead>
    <tbody>
      ${promptsData.map(p => {
        const dateStr = new Date(p.createdAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        const escapedPrompt = (p.promptText || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
          
        return `
          <tr>
            <td style="white-space: nowrap;">${dateStr}</td>
            <td><strong>👤 ${p.userName}</strong></td>
            <td><code class="model-tag">${p.model}</code></td>
            <td><span class="source-tag">${p.tool || '—'}</span></td>
            <td>${fmt(p.inputTokens)}</td>
            <td>${fmt(p.outputTokens)}</td>
            <td>${fmt(p.cacheRead)}</td>
            <td>
              <div style="max-height: 80px; overflow-y: auto; font-family: monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,0.1); padding: 6px; border-radius: 4px; max-width: 400px;">${escapedPrompt}</div>
            </td>
          </tr>
        `;
      }).join('')}
    </tbody>
  </table>`;
}

async function loadMembers() {
  if (!teamId) return;
  const { members } = await api(`/api/v1/team/members?teamId=${teamId}`);
  renderMembersTable(members);
}

async function loadTeams() {
  const { teams: list } = await api('/api/v1/teams');
  teams = list;
  const sel = document.getElementById('team-select');
  if (!sel) return;
  sel.innerHTML = teams.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  if (teamId && teams.some((t) => t.id === teamId)) sel.value = teamId;
  else if (teams[0]) {
    teamId = teams[0].id;
    sel.value = teamId;
    localStorage.setItem('team-id', teamId);
  }
}

async function loadDashboardData() {
  renderPresets();
  await loadTeams();
  const selectDiv = document.querySelector('.sidebar-team-select');
  if (currentUser && currentUser.role === 'admin') {
    if (currentUser.teamId && teams.some((t) => t.id === currentUser.teamId)) {
      if (!teamId || !teams.some((t) => t.id === teamId)) {
        teamId = currentUser.teamId;
      }
    } else if (teams.length > 0 && (!teamId || !teams.some((t) => t.id === teamId))) {
      teamId = teams[0].id;
    }
    localStorage.setItem('team-id', teamId);
    const sel = document.getElementById('team-select');
    if (sel) sel.value = teamId;
    if (selectDiv) selectDiv.style.display = teams.length > 1 ? 'flex' : 'none';
  } else {
    if (selectDiv) selectDiv.style.display = 'flex';
  }
  await Promise.all([loadStats({ soft: false }), loadMembers(), loadReleases()]);
}

async function showApp() {
  setAppError('');
  showDashboardShell();
  setLoading(true);
  try {
    if (currentUser && currentUser.role === 'user') {
      // Hide settings tab button
      const settingsTabBtn = document.getElementById('tabbtn-settings');
      if (settingsTabBtn) settingsTabBtn.style.display = 'none';

      // Hide current team select wrapper
      const teamSelectDiv = document.querySelector('.sidebar-team-select');
      if (teamSelectDiv) teamSelectDiv.style.display = 'none';

      // Hide member filter select & label
      const memberFilterSelect = document.getElementById('global-member-filter');
      const memberFilterLabel = memberFilterSelect?.closest('label');
      if (memberFilterLabel) memberFilterLabel.style.display = 'none';

      // Hide pricing cost modification and recalculation buttons
      const recalcBtn = document.getElementById('recalculate-costs-btn');
      if (recalcBtn) recalcBtn.style.display = 'none';
      const addPriceBtn = document.getElementById('add-pricing-btn');
      if (addPriceBtn) addPriceBtn.style.display = 'none';

      // Hide personal dashboard links in sidebar footer
      const backLinks = document.querySelectorAll('.sidebar-footer-links a[href="/"]');
      backLinks.forEach(link => link.style.display = 'none');

      // "At risk" callouts compare a member against the team average — meaningless
      // when the "team" is just the signed-in member themselves.
      const atRiskPanel = document.getElementById('at-risk-panel');
      if (atRiskPanel) atRiskPanel.style.display = 'none';
    }

    await loadDashboardData();
  } catch (err) {
    showLogin();
    setLoginError(formatError(err.message));
    throw err;
  } finally {
    setLoading(false);
  }
}

function formatError(msg) {
  if (msg === 'unauthorized') return 'Session expired — please sign in again.';
  if (msg === 'not found') return 'API route not found — restart server or redeploy.';
  if (msg === 'invalid credentials') return 'Wrong password.';
  return msg;
}

function setupTabs() {
  const tabsNav = document.getElementById('team-tabs');
  const titleEl = document.getElementById('team-page-title');
  if (!tabsNav) return;
  tabsNav.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.onclick = () => {
      tabsNav.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
        b.tabIndex = -1;
      });
      document.querySelectorAll('.tab-content').forEach((tc) => { tc.hidden = true; tc.classList.remove('active'); });

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      btn.tabIndex = 0;
      const targetId = btn.dataset.tab;
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.hidden = false;
        targetEl.classList.add('active');
      }
      if (titleEl) {
        // Prefer explicit title; fall back to button label without leading emoji/icon.
        const label = (btn.dataset.title || btn.textContent || '')
          .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D]+\s*/u, '')
          .trim();
        titleEl.textContent = label || 'Team Analytics';
      }
      closeMobileNav();
    };
  });
}

/** Hamburger toggle for the off-canvas sidebar on narrow (mobile) viewports. */
function setupMobileNav() {
  const layout = document.getElementById('app');
  const toggle = document.getElementById('team-nav-toggle');
  const overlay = document.getElementById('team-nav-overlay');
  if (!layout || !toggle || !overlay) return;

  toggle.addEventListener('click', () => {
    const isOpen = layout.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
  overlay.addEventListener('click', () => closeMobileNav());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileNav();
  });
}

function closeMobileNav() {
  const layout = document.getElementById('app');
  const toggle = document.getElementById('team-nav-toggle');
  if (!layout) return;
  layout.classList.remove('nav-open');
  toggle?.setAttribute('aria-expanded', 'false');
}

/** Collapsible "Filters" panel on narrow (mobile) viewports, plus an
 * active-filter count badge on the trigger button. */
function setupFiltersToggle() {
  const toggle = document.getElementById('filters-toggle');
  const panel = document.getElementById('filters-more');
  if (!toggle || !panel) return;
  toggle.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
}

function updateFiltersBadge() {
  const badge = document.getElementById('filters-badge');
  if (!badge) return;
  let count = 0;
  if (!dateRange.all) count++;
  if (document.getElementById('global-member-filter')?.value !== 'all') count++;
  if (document.getElementById('global-source-filter')?.value !== 'all') count++;
  if (Number(document.getElementById('global-min-tokens-filter')?.value) > 0) count++;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setLoginError('');
  setLoginBusy(true);
  try {
    const data = await api('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('login-password').value }),
    });
    if (data.token) {
      adminToken = data.token;
      sessionStorage.setItem('team-admin-token', data.token);
    }
    await showApp();
  } catch (err) {
    showLogin();
    setLoginError(formatError(err.message));
  } finally {
    setLoginBusy(false);
  }
});

document.getElementById('team-select').addEventListener('change', (e) => {
  teamId = e.target.value;
  localStorage.setItem('team-id', teamId);
  const mf = document.getElementById('global-member-filter');
  if (mf) mf.value = 'all';
  const mds = document.getElementById('member-filter-select');
  if (mds) mds.value = 'all';
  updateFiltersBadge();
  loadMembers().catch((err) => setAppError(formatError(err.message)));
  loadStats().catch((err) => setAppError(formatError(err.message)));
});

document.getElementById('range-from').addEventListener('change', (e) => {
  dateRange.from = e.target.value;
  dateRange.all = !dateRange.from && !dateRange.to;
  renderPresets();
  updateFiltersBadge();
  loadStats().catch((err) => setAppError(formatError(err.message)));
});

document.getElementById('range-to').addEventListener('change', (e) => {
  dateRange.to = e.target.value;
  dateRange.all = !dateRange.from && !dateRange.to;
  renderPresets();
  updateFiltersBadge();
  loadStats().catch((err) => setAppError(formatError(err.message)));
});

// Event listeners for global header filters
document.getElementById('global-member-filter')?.addEventListener('change', () => {
  updateFiltersBadge();
  loadStats().catch((err) => setAppError(formatError(err.message)));
});
document.getElementById('global-source-filter')?.addEventListener('change', () => {
  updateFiltersBadge();
  loadStats().catch((err) => setAppError(formatError(err.message)));
});
document.getElementById('global-min-tokens-filter')?.addEventListener('change', () => {
  updateFiltersBadge();
  loadStats().catch((err) => setAppError(formatError(err.message)));
});

document.getElementById('refresh').addEventListener('click', () => {
  setAppError('');
  softLoading(true, 'Refreshing analytics…');
  Promise.all([loadStats({ soft: false }), loadMembers()])
    .catch((err) => setAppError(formatError(err.message)))
    .finally(() => softLoading(false));
});

document.getElementById('prompts-prev-btn')?.addEventListener('click', () => {
  if (promptsPage > 1) {
    promptsPage--;
    loadPrompts().catch(console.error);
  }
});

document.getElementById('prompts-next-btn')?.addEventListener('click', () => {
  if (promptsPage < promptsTotalPages) {
    promptsPage++;
    loadPrompts().catch(console.error);
  }
});

document.getElementById('recalculate-costs-btn')?.addEventListener('click', async () => {
  if (!teamId) return;
  const btn = document.getElementById('recalculate-costs-btn');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Recalculating session costs…';
  showRecalculationLoader('⚡ Recalculating costs across all team sessions...');

  try {
    const res = await api('/api/v1/team/recalculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId }),
    });
    await loadStats();
    window.showToast(`Recalculated costs across ${res.updatedCount || res.totalSessions || 0} sessions using the latest model rates.`, { type: 'success' });
  } catch (err) {
    window.showToast(formatError(err.message), { type: 'error' });
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
    hideRecalculationLoader();
  }
});

document.getElementById('add-member-btn')?.addEventListener('click', () => {
  const currentTeamObj = (teams || []).find((t) => t.id === teamId);
  const teamHintEl = document.getElementById('add-member-team-hint');
  if (teamHintEl) {
    teamHintEl.textContent = currentTeamObj ? currentTeamObj.name : 'this team';
  }
  document.getElementById('member-name').value = '';
  document.getElementById('member-username').value = '';
  document.getElementById('member-password').value = '';
  document.getElementById('member-role').value = 'member';
  document.getElementById('add-member-dialog').showModal();
});

document.getElementById('cancel-member')?.addEventListener('click', () => {
  document.getElementById('add-member-dialog').close();
});

document.getElementById('cancel-edit-member')?.addEventListener('click', () => {
  document.getElementById('edit-member-dialog').close();
});

document.getElementById('link-member-btn')?.addEventListener('click', async () => {
  const sel = document.getElementById('link-member-select');
  sel.innerHTML = '<option value="">Loading members…</option>';
  document.getElementById('link-member-dialog').showModal();

  try {
    const { members } = await api(`/api/v1/team/members/link?teamId=${teamId}`);
    if (!members || !members.length) {
      sel.innerHTML = '<option value="">All members are already linked to this team.</option>';
      return;
    }
    sel.innerHTML = '<option value="">— select member —</option>' + 
      members.map(m => `<option value="${m.id}">${m.display_name} (Teams: ${m.existing_teams || 'None'})</option>`).join('');
  } catch (err) {
    sel.innerHTML = `<option value="">Error loading members: ${err.message}</option>`;
  }
});

document.getElementById('cancel-link-member')?.addEventListener('click', () => {
  document.getElementById('link-member-dialog').close();
});

document.getElementById('link-member-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const memberId = document.getElementById('link-member-select').value;
  if (!memberId || !teamId) return;

  try {
    await api('/api/v1/team/members/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, memberId }),
    });
    document.getElementById('link-member-dialog').close();
    loadMembers();
    loadStats();
    window.showToast('Member linked to team.', { type: 'success' });
  } catch (err) {
    window.showToast(formatError(err.message), { type: 'error' });
  }
});

document.getElementById('add-pricing-btn')?.addEventListener('click', () => {
  document.getElementById('add-pricing-dialog').showModal();
});

document.getElementById('cancel-pricing')?.addEventListener('click', () => {
  document.getElementById('add-pricing-dialog').close();
});

document.getElementById('add-member-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('member-name').value.trim();
  const username = document.getElementById('member-username').value.trim();
  const password = document.getElementById('member-password').value.trim();
  const role = document.getElementById('member-role').value || 'member';
  if (!name || !teamId) return;

  const submitBtn = document.getElementById('add-member-submit');
  const originalBtnText = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating user...';
  }

  try {
    const res = await api('/api/v1/team/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId,
        displayName: name,
        username: username || undefined,
        password: password || undefined,
        role,
      }),
    });

    document.getElementById('add-member-dialog').close();

    const banner = document.getElementById('new-member-banner');
    if (banner) {
      banner.hidden = false;
      document.getElementById('cred-username').textContent = res.user?.username || '—';
      document.getElementById('cred-password').textContent = res.tempPassword || '—';
      document.getElementById('cred-apikey').textContent = res.apiKey || '—';
      document.getElementById('cred-teams').innerHTML = (res.teams || []).map((t) => `<span class="cred-team-tag">🛡️ ${t}</span>`).join(' ');
      document.getElementById('cred-cmd-mac').textContent = res.installCommandMac || '—';
      document.getElementById('cred-cmd-win').textContent = res.installCommandWin || '—';

      banner._latestCredentials = {
        name: res.user?.display_name || name,
        username: res.user?.username || '',
        tempPassword: res.tempPassword || '',
        apiKey: res.apiKey || '',
        teams: res.teams || [],
        installCommandMac: res.installCommandMac || '',
        installCommandWin: res.installCommandWin || '',
      };
      banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    loadMembers();
    loadStats();
    window.showToast(`User & member "${res.user?.display_name || name}" created successfully.`, { type: 'success' });
  } catch (err) {
    window.showToast(formatError(err.message), { type: 'error' });
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
  }
});

document.getElementById('close-credentials-banner')?.addEventListener('click', () => {
  const banner = document.getElementById('new-member-banner');
  if (banner) banner.hidden = true;
});

// Setup click handlers for all copy buttons in the credentials banner
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-field-btn');
  if (!btn) return;
  const targetId = btn.getAttribute('data-target');
  const targetEl = document.getElementById(targetId);
  if (!targetEl) return;
  const textToCopy = targetEl.textContent.trim();
  if (!textToCopy || textToCopy === '—') return;

  navigator.clipboard.writeText(textToCopy).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    window.showToast('Failed to copy to clipboard', { type: 'error' });
  });
});

document.getElementById('copy-all-credentials-btn')?.addEventListener('click', () => {
  const banner = document.getElementById('new-member-banner');
  const c = banner?._latestCredentials;
  if (!c) return;

  const fullText = 
`🚀 Token Tracer Account Details
───────────────────────────────
Name: ${c.name}
Username: ${c.username}
Temporary Password: ${c.tempPassword}
API Key: ${c.apiKey}
Assigned Workspaces: ${c.teams.join(', ')}

🍎 macOS / Linux Setup Command:
${c.installCommandMac}

🪟 Windows PowerShell Setup Command:
${c.installCommandWin}
───────────────────────────────`;

  navigator.clipboard.writeText(fullText).then(() => {
    const btn = document.getElementById('copy-all-credentials-btn');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ All Details Copied to Clipboard!';
      setTimeout(() => { btn.textContent = orig; }, 2500);
    }
    window.showToast('All onboarding details copied to clipboard!', { type: 'success' });
  });
});

document.getElementById('edit-member-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('edit-member-id').value;
  const name = document.getElementById('edit-member-name').value.trim();
  const role = document.getElementById('edit-member-role').value || 'member';
  if (!id || !name || !teamId) return;
  try {
    await api('/api/v1/team/members', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, teamId, displayName: name, role }),
    });
    document.getElementById('edit-member-dialog').close();
    loadMembers();
    loadStats();
    window.showToast(`Member "${name}" updated.`, { type: 'success' });
  } catch (err) {
    window.showToast(formatError(err.message), { type: 'error' });
  }
});

document.getElementById('add-pricing-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const modelPattern = document.getElementById('pricing-model-pattern').value.trim();
  const costInPerM = document.getElementById('pricing-cost-in').value;
  const costOutPerM = document.getElementById('pricing-cost-out').value;
  const costCacheReadPerM = document.getElementById('pricing-cost-cache').value;
  if (!modelPattern || !teamId) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const origText = submitBtn ? submitBtn.textContent : 'Save Rule';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Saving & Recalculating Costs...';
  }

  showRecalculationLoader('Calculating session costs with new pricing rule...');

  try {
    await api('/api/v1/team/pricing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId,
        modelPattern,
        costInPerM: Number(costInPerM),
        costOutPerM: Number(costOutPerM),
        costCacheReadPerM: Number(costCacheReadPerM),
      }),
    });
    document.getElementById('add-pricing-dialog').close();
    document.getElementById('pricing-model-pattern').value = '';
    document.getElementById('pricing-cost-in').value = '';
    document.getElementById('pricing-cost-out').value = '';
    document.getElementById('pricing-cost-cache').value = '';
    await loadStats();
    window.showToast('Pricing rule saved and costs recalculated.', { type: 'success' });
  } catch (err) {
    window.showToast(formatError(err.message), { type: 'error' });
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = origText;
    }
    hideRecalculationLoader();
  }
});

window.triggerMemberSync = async function (memberId = 'all', name = 'all members') {
  const memberName = name && name !== 'all members' ? decodeURIComponent(name) : 'all members';
  showRecalculationLoader(`Broadcasting sync signal to ${memberName}...`);
  try {
    await api('/api/v1/team/members/trigger-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, memberId }),
    });
    window.showToast(`Sync request broadcast to ${memberName}.`, { type: 'success' });
    await loadMembers();
    await loadStats();
  } catch (err) {
    window.showToast(formatError(err.message), { type: 'error' });
  } finally {
    const banner = document.querySelector('.cost-calc-banner');
    if (banner) banner.remove();
  }
};

document.getElementById('trigger-sync-all-btn')?.addEventListener('click', () => {
  window.triggerMemberSync('all', 'all members');
});

document.getElementById('collapse-all-members')?.addEventListener('click', () => {
  document.querySelectorAll('#member-drilldown-cards details.member-card').forEach((el) => el.removeAttribute('open'));
});

document.getElementById('expand-all-members')?.addEventListener('click', () => {
  document.querySelectorAll('#member-drilldown-cards details.member-card').forEach((el) => el.setAttribute('open', ''));
});

document.getElementById('team-logout-btn')?.addEventListener('click', async () => {
  await fetch('/api/auth/me', { method: 'POST', credentials: 'same-origin' });
  window.location.href = '/';
});

setupTabs();
setupMobileNav();
setupFiltersToggle();
updateFiltersBadge();

(async () => {
  const ok = await checkAuth();
  if (!ok) return;


  showApp().catch((err) => {
    console.error('Failed to load dashboard:', err);
  });
})();
// ── Daemon Releases Panel ─────────────────────────────────────────────────────
// Loads release records, renders a table with activate/deactivate/delete,
// and wires the "Publish Release" form.

let releasesData = [];

async function loadReleases() {
  const el = document.getElementById('daemon-releases-list');
  if (currentUser && currentUser.role === 'user') {
    if (el) el.innerHTML = '<p class="muted" style="padding:12px">Unable to load releases (admin access required).</p>';
    return;
  }
  try {
    const data = await api('/api/internal/releases');
    releasesData = data.releases || [];

    // Hide/show the publish form depending on superadmin role
    const form = document.getElementById('publish-release-form');
    if (form) {
      const isSuper = currentUser && currentUser.role === 'superadmin';
      form.style.display = isSuper ? 'grid' : 'none';
    }

    // Update latestDaemonVersion for version badge comparisons
    const activeReleases = releasesData.filter((r) => r.active);
    if (activeReleases.length > 0) {
      latestDaemonVersion = activeReleases[0].version;
      // Re-render members table to update badges
      const memberEl = document.getElementById('members');
      if (memberEl && memberEl.querySelector('tbody')) {
        loadMembers();
      }
    }

    renderReleasesTable();
  } catch {
    if (el) el.innerHTML = '<p class="muted" style="padding:12px">Unable to load releases (admin access required).</p>';
  }
}

function renderReleasesTable() {
  const el = document.getElementById('daemon-releases-list');
  if (!el) return;

  const isSuper = currentUser && currentUser.role === 'superadmin';

  // Update latest version badge in panel header
  const latestEl = document.getElementById('daemon-latest-version-badge');
  if (latestEl) {
    const active = releasesData.find((r) => r.active);
    latestEl.textContent = active ? `Latest: v${active.version}` : 'No active release';
  }

  if (!releasesData.length) {
    el.innerHTML = '<p class="muted" style="padding:12px 0">No daemon releases published yet. Use the form above to publish the first release.</p>';
    return;
  }

  el.innerHTML = `<table><thead><tr>
    <th>Version</th><th>Status</th><th>Mandatory</th><th>Released</th><th>SHA-256</th><th>Notes</th>${isSuper ? '<th>Actions</th>' : ''}
  </tr></thead><tbody>
    ${releasesData.map((r) => {
      const statusBadge = r.active
        ? '<span class="source-tag" style="background:rgba(34,197,94,0.15);color:#4ade80;">🟢 Active</span>'
        : '<span class="source-tag" style="background:rgba(100,116,139,0.15);color:#94a3b8;">⬛ Inactive</span>';
      const mandatoryBadge = r.mandatory
        ? '<span class="source-tag" style="background:rgba(239,68,68,0.15);color:#f87171;">🔴 Mandatory</span>'
        : '<span class="source-tag" style="color:#94a3b8;">Optional</span>';
      const sha = r.sha256 ? r.sha256.slice(0, 12) + '…' : '—';
      const actionsCell = isSuper ? `<td>
        ${r.active
          ? `<button type="button" class="hbtn" style="color:#94a3b8" onclick="deactivateRelease('${r.id}')">⏸️ Deactivate</button>`
          : `<button type="button" class="hbtn primary" onclick="activateRelease('${r.id}')">▶️ Activate</button>`}
        <button type="button" class="hbtn" style="color:#ee5555" onclick="deleteRelease('${r.id}', 'v${r.version}')">🗑️ Delete</button>
      </td>` : '';
      return `<tr>
        <td><strong>v${r.version}</strong></td>
        <td>${statusBadge}</td>
        <td>${mandatoryBadge}</td>
        <td>${fmtDate(r.released_at)}</td>
        <td><code title="${r.sha256 || ''}">${sha}</code></td>
        <td>${r.release_notes || '—'}</td>
        ${actionsCell}
      </tr>`;
    }).join('')}
  </tbody></table>`;
}


window.activateRelease = async function (id) {
  try {
    await api('/api/internal/releases', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active: true }),
    });
    window.showToast('Release activated — daemons will update on next check.', { type: 'success' });
    await loadReleases();
  } catch (err) {
    window.showToast('Failed to activate: ' + err.message, { type: 'error' });
  }
};

window.deactivateRelease = async function (id) {
  if (!confirm('Deactivate this release? Running daemons will stop updating to it.')) return;
  try {
    await api('/api/internal/releases', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active: false }),
    });
    window.showToast('Release deactivated.', { type: 'success' });
    await loadReleases();
  } catch (err) {
    window.showToast('Failed to deactivate: ' + err.message, { type: 'error' });
  }
};

window.deleteRelease = async function (id, label) {
  if (!confirm(`Permanently delete release ${label}? This cannot be undone.`)) return;
  try {
    await api(`/api/internal/releases?id=${id}`, { method: 'DELETE' });
    window.showToast(`Release ${label} deleted.`, { type: 'success' });
    await loadReleases();
  } catch (err) {
    window.showToast('Failed to delete: ' + err.message, { type: 'error' });
  }
};

// Publish Release form handler
document.getElementById('publish-release-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('publish-release-submit');
  const errEl = document.getElementById('publish-release-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

  const version = document.getElementById('release-version')?.value.trim();
  const downloadUrl = document.getElementById('release-url')?.value.trim();
  const sha256 = document.getElementById('release-sha256')?.value.trim().toLowerCase();
  const mandatory = document.getElementById('release-mandatory')?.checked ?? false;
  const releaseNotes = document.getElementById('release-notes')?.value.trim() || null;

  if (!version || !downloadUrl || !sha256) {
    if (errEl) { errEl.textContent = 'Version, URL, and SHA-256 are required.'; errEl.hidden = false; }
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    if (errEl) { errEl.textContent = 'SHA-256 must be 64 lowercase hex characters.'; errEl.hidden = false; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  try {
    await api('/api/internal/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, downloadUrl, sha256, mandatory, releaseNotes }),
    });
    window.showToast(`Release v${version} published successfully.`, { type: 'success' });
    e.target.reset();
    await loadReleases();
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Publish Release'; }
  }
});

// ── Team Member Token Deep-Dive Modal Controller ────────────────────────────
const deepDiveClientCache = new Map();

async function openTeamMemberDeepDive(memberId, memberName) {
  const dialog = document.getElementById('team-whale-drilldown-dialog');
  if (!dialog) return;

  const titleEl = document.getElementById('twdd-title');
  const subEl = document.getElementById('twdd-subtitle');
  const decodedName = decodeURIComponent(memberName || 'Member');
  if (titleEl) titleEl.textContent = `👤 ${decodedName} — Deep-Dive Token Analysis`;
  if (subEl) subEl.textContent = `Analyzing where this member spent their tokens across repositories, models & sessions…`;

  const loadingEl = document.getElementById('twdd-loading');
  const contentEl = document.getElementById('twdd-content');

  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }

  const teamId = currentTeamId || document.getElementById('team-select')?.value;
  const from = currentFrom;
  const to = currentTo;

  const params = new URLSearchParams();
  if (teamId) params.set('teamId', teamId);
  params.set('memberId', memberId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const cacheKey = params.toString();
  const cached = deepDiveClientCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < 60000)) {
    renderTeamMemberDeepDive(cached.data);
    return;
  }

  if (loadingEl) loadingEl.hidden = false;
  if (contentEl) contentEl.hidden = true;

  try {
    const res = await fetch(`/api/v1/team/usage-deep-dive?${cacheKey}`);
    if (!res.ok) {
      throw new Error(`Failed to load member deep dive: ${res.statusText}`);
    }
    const data = await res.json();
    deepDiveClientCache.set(cacheKey, { ts: Date.now(), data });
    renderTeamMemberDeepDive(data);
  } catch (err) {
    console.error('[openTeamMemberDeepDive error]', err);
    if (loadingEl) {
      loadingEl.innerHTML = `<span style="color:var(--error-text);">Error loading deep dive: ${esc(err.message)}</span>`;
    }
  }
}

function renderTeamMemberDeepDive(data) {
  const loadingEl = document.getElementById('twdd-loading');
  const contentEl = document.getElementById('twdd-content');
  if (loadingEl) loadingEl.hidden = true;
  if (contentEl) contentEl.hidden = false;

  if (!data) return;

  const m = data.member || {};
  const totals = data.totals || {};

  const subEl = document.getElementById('twdd-subtitle');
  if (subEl) {
    subEl.textContent = `Team: ${m.teamName || 'Independent'} • Total Volume: ${fmt(totals.totalTokens)} tokens (${fmtCost(totals.totalCost)}) across ${totals.sessionCount} sessions`;
  }

  // Stat cards
  const statTok = document.getElementById('twdd-stat-tokens');
  const statCost = document.getElementById('twdd-stat-cost');
  if (statTok) statTok.textContent = fmt(totals.totalTokens);
  if (statCost) statCost.textContent = `${fmtCost(totals.totalCost)} total API cost`;

  const statInOut = document.getElementById('twdd-stat-in-out');
  const statCache = document.getElementById('twdd-stat-cache');
  if (statInOut) statInOut.textContent = `${fmt(totals.tokensIn)} in / ${fmt(totals.tokensOut)} out`;
  if (statCache) statCache.textContent = `Cache read: ${fmt(totals.tokensCacheRead)} (${fmt(totals.tokensCacheWrite)} write)`;

  const statSess = document.getElementById('twdd-stat-sessions');
  const statAvg = document.getElementById('twdd-stat-avg');
  if (statSess) statSess.textContent = `${totals.sessionCount} sessions (${totals.activeDays} active days)`;
  if (statAvg) statAvg.textContent = `Avg: ${fmt(totals.avgTokensPerSession)} / session`;

  const statEdits = document.getElementById('twdd-stat-edits');
  const statLines = document.getElementById('twdd-stat-lines');
  if (statEdits) statEdits.textContent = `${totals.edits || 0} code edits`;
  if (statLines) statLines.textContent = `${totals.changedLines || 0} lines changed • ${totals.toolCalls || 0} tool calls`;

  // Dimension 1: Projects Table
  const projTbody = document.getElementById('twdd-projects-tbody');
  if (projTbody) {
    if (!data.projects?.length) {
      projTbody.innerHTML = `<tr><td colSpan="7" class="muted" style="text-align:center; padding:16px;">No project records logged.</td></tr>`;
    } else {
      projTbody.innerHTML = data.projects.map(p => `
        <tr>
          <td><strong>📁 ${cleanProjectName(p.project)}</strong></td>
          <td>${(p.sources || []).map(s => `<span class="source-tag">${esc(s)}</span>`).join(' ')}</td>
          <td>${p.sessions}</td>
          <td>${fmt(p.tokensIn)} / ${fmt(p.tokensOut)}</td>
          <td><strong style="color:var(--brand-hi);">${fmt(p.totalTokens)}</strong></td>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-weight:600; width:36px;">${Math.round(p.percentage)}%</span>
              <div style="flex:1; max-width:80px; height:6px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden;">
                <div style="width:${Math.min(100, Math.round(p.percentage))}%; height:100%; background:var(--brand); border-radius:3px;"></div>
              </div>
            </div>
          </td>
          <td><strong>${fmtCost(p.apiCost)}</strong></td>
        </tr>
      `).join('');
    }
  }

  // Dimension 2: Models Table
  const modTbody = document.getElementById('twdd-models-tbody');
  if (modTbody) {
    if (!data.models?.length) {
      modTbody.innerHTML = `<tr><td colSpan="7" class="muted" style="text-align:center; padding:16px;">No model records logged.</td></tr>`;
    } else {
      modTbody.innerHTML = data.models.map(mod => `
        <tr>
          <td><strong>🤖 <code>${esc(mod.model)}</code></strong></td>
          <td><span class="source-tag">${esc(mod.source)}</span></td>
          <td>${mod.sessions}</td>
          <td>${fmt(mod.tokensIn)} / ${fmt(mod.tokensOut)}</td>
          <td><span style="color:#a78bfa; font-weight:600;">${Math.round(mod.cacheHitRate)}%</span></td>
          <td><strong>${fmt(mod.totalTokens)}</strong></td>
          <td><strong>${fmtCost(mod.apiCost)}</strong></td>
        </tr>
      `).join('');
    }
  }

  // Dimension 3: Top Sessions Table
  const sessTbody = document.getElementById('twdd-sessions-tbody');
  if (sessTbody) {
    if (!data.topSessions?.length) {
      sessTbody.innerHTML = `<tr><td colSpan="7" class="muted" style="text-align:center; padding:16px;">No session logs found.</td></tr>`;
    } else {
      sessTbody.innerHTML = data.topSessions.map(s => {
        const runawayBadge = s.isRunaway
          ? `<span class="source-tag" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); font-size:10px;">⚠️ Loop / Runaway</span>`
          : `<span class="muted" style="font-size:10.5px;">✓ Normal</span>`;
        const timeStr = s.startedAt ? String(s.startedAt).slice(0, 16).replace('T', ' ') : '—';

        return `
          <tr>
            <td>
              <div style="font-weight:600; font-size:12px; font-family:monospace;">${esc(s.sessionId)}</div>
              <div class="muted" style="font-size:10.5px;">${timeStr}</div>
            </td>
            <td>📁 ${cleanProjectName(s.project)}</td>
            <td>
              <div><span class="source-tag">${esc(s.source)}</span></div>
              <code style="font-size:10px;">${esc(s.model)}</code>
            </td>
            <td>
              <div style="font-weight:700; color:var(--brand-hi);">${fmt(s.totalTokens)}</div>
              <div class="muted" style="font-size:10px;">${fmt(s.tokensIn)} in • ${fmt(s.tokensCacheRead)} cache</div>
            </td>
            <td><strong>${fmtCost(s.apiCost)}</strong></td>
            <td>
              ${runawayBadge}
              <div class="muted" style="font-size:10px;">${s.toolErrors || 0} errs • ${s.reworkLoops || 0} loops</div>
            </td>
            <td style="text-align:right;">
              <button type="button" class="hbtn" style="font-size:11px; padding:3px 8px;" onclick="inspectTeamPrompt('${esc(s.sessionId)}')">
                Prompts ↗
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // Dimension 4: Files Table
  const filesTbody = document.getElementById('twdd-files-tbody');
  if (filesTbody) {
    if (!data.topFiles?.length) {
      filesTbody.innerHTML = `<tr><td colSpan="3" class="muted" style="text-align:center; padding:16px;">No code diff records logged.</td></tr>`;
    } else {
      filesTbody.innerHTML = data.topFiles.map(f => `
        <tr>
          <td><code style="font-size:11.5px;">${esc(f.path)}</code></td>
          <td>${f.edits} edits</td>
          <td><span style="color:#4ade80;">+${f.additions || 0}</span> <span style="color:#f87171;">−${f.deletions || 0}</span> (${f.changedLines} changed)</td>
        </tr>
      `).join('');
    }
  }

  // Dimension 5: Daily Timeline
  const timelineEl = document.getElementById('twdd-timeline-chart');
  if (timelineEl) {
    if (!data.dailyTimeline?.length) {
      timelineEl.innerHTML = `<p class="muted" style="font-size:12px; margin:0;">No daily timeline data available.</p>`;
    } else {
      const maxDaily = Math.max(...data.dailyTimeline.map(d => d.totalTokens), 1);
      timelineEl.innerHTML = `
        <div style="display:flex; gap:6px; align-items:flex-end; height:120px; padding-top:20px; overflow-x:auto;">
          ${data.dailyTimeline.map(d => {
            const h = Math.max(4, Math.round((d.totalTokens / maxDaily) * 90));
            return `
              <div style="display:flex; flex-direction:column; align-items:center; flex:1; min-width:24px;" title="${d.day}: ${fmt(d.totalTokens)} tokens (${fmtCost(d.apiCost)}) across ${d.sessions} sessions">
                <span style="font-size:9px; color:var(--muted); margin-bottom:4px;">${fmt(d.totalTokens)}</span>
                <div style="width:100%; height:${h}px; background:var(--brand); border-radius:3px 3px 0 0; opacity:0.85;"></div>
                <span style="font-size:9px; color:var(--muted); margin-top:4px; transform:rotate(-45deg); transform-origin:left top; white-space:nowrap;">${d.day.slice(5)}</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
  }
}

function inspectTeamPrompt(sessionId) {
  const dialog = document.getElementById('team-whale-drilldown-dialog');
  if (dialog) dialog.close?.();

  const tabBtn = document.getElementById('tabbtn-prompts');
  if (tabBtn) tabBtn.click();

  setTimeout(() => {
    const searchInput = document.getElementById('prompt-search') || document.getElementById('prompt-search-input');
    if (searchInput) {
      searchInput.value = sessionId;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, 100);
}

document.getElementById('twdd-close-btn')?.addEventListener('click', () => {
  document.getElementById('team-whale-drilldown-dialog')?.close?.();
});
