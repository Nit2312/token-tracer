/* Visualisation Dashboard frontend — intelligence, trajectories, and Wrapped. */

// ── Auth boot ────────────────────────────────────────────────────────────────
let currentUser = null;

async function bootAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) {
      window.location.href = '/';
      return false;
    }
    currentUser = await res.json();

    // Show user name + profile + logout button
    const nameEl = document.getElementById('user-name');
    if (nameEl) nameEl.textContent = currentUser.displayName || currentUser.username || '';

    const profileBtn = document.getElementById('profile-btn');
    if (profileBtn) {
      profileBtn.addEventListener('click', () => {
        openProfileModal();
      });
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await fetch('/api/auth/me', { method: 'POST', credentials: 'same-origin' });
        window.location.href = '/';
      });
    }

    setupProfileHandlers();

    return true;
  } catch {
    window.location.href = '/';
    return false;
  }
}

function openProfileModal() {
  const dialog = document.getElementById('profile-dialog');
  if (!dialog) return;

  const usernameEl = document.getElementById('profile-username-val');
  if (usernameEl) usernameEl.textContent = currentUser?.username || '—';

  const roleEl = document.getElementById('profile-role-val');
  if (roleEl) {
    roleEl.textContent = currentUser?.role === 'admin' ? 'Team Admin' : currentUser?.role === 'superadmin' ? 'Superadmin' : 'Member';
  }

  const teamsEl = document.getElementById('profile-teams-val');
  if (teamsEl) {
    const teamNames = (currentUser?.teams || []).map((t) => t.name);
    teamsEl.textContent = teamNames.length > 0 ? teamNames.join(', ') : 'Independent';
  }

  const nameInput = document.getElementById('profile-display-name');
  if (nameInput) nameInput.value = currentUser?.displayName || currentUser?.username || '';

  const currentPwd = document.getElementById('profile-current-password');
  if (currentPwd) currentPwd.value = '';

  const newPwd = document.getElementById('profile-new-password');
  if (newPwd) newPwd.value = '';

  const confirmPwd = document.getElementById('profile-confirm-password');
  if (confirmPwd) confirmPwd.value = '';

  const errEl = document.getElementById('profile-error-msg');
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = '';
  }

  dialog.showModal();
}

function setupProfileHandlers() {
  const dialog = document.getElementById('profile-dialog');
  if (!dialog || dialog._profileInitialized) return;
  dialog._profileInitialized = true;

  document.getElementById('cancel-profile-btn')?.addEventListener('click', () => {
    dialog.close();
  });

  const form = document.getElementById('profile-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('profile-error-msg');
      const submitBtn = document.getElementById('save-profile-btn');
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = '';
      }

      const displayName = (document.getElementById('profile-display-name')?.value || '').trim();
      const currentPassword = document.getElementById('profile-current-password')?.value || '';
      const newPassword = document.getElementById('profile-new-password')?.value || '';
      const confirmPassword = document.getElementById('profile-confirm-password')?.value || '';

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
        const nameEl = document.getElementById('user-name');
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


let state = { sessions: [], roots: [], counts: {} };
let stats = null;
let selected = null;
let sourceFilter = localStorage.getItem('ov-source') || 'all';
const SOURCE_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw', clawdbot: 'Clawdbot', moltbot: 'Moltbot', hermes: 'Hermes', cursor: 'Cursor' };
const sourceLabel = (s) => (s === 'all' ? 'Agents' : SOURCE_LABEL[s] || s);
const sourceShort = { 'claude-code': 'Claude', codex: 'Codex', openclaw: 'OpenClaw', hermes: 'Hermes', cursor: 'Cursor' };

const RANGE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'all', label: 'All' },
];

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

function detectPreset(from, to, all) {
  if (all || (!from && !to)) return 'all';
  for (const p of RANGE_PRESETS) {
    if (p.id === 'all') continue;
    const r = rangeFromPreset(p.id);
    if (r.from === from && r.to === to) return p.id;
  }
  return 'custom';
}

function loadSavedRange() {
  const savedFrom = localStorage.getItem('ov-from') || '';
  const savedTo = localStorage.getItem('ov-to') || '';
  const savedAll = localStorage.getItem('ov-range-all');
  // Default to full history so Cursor analysis starts with every session.
  if (savedAll !== '0') return { from: '', to: '', all: true, preset: 'all' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(savedFrom) && /^\d{4}-\d{2}-\d{2}$/.test(savedTo)) {
    const from = savedFrom <= savedTo ? savedFrom : savedTo;
    const to = savedFrom <= savedTo ? savedTo : savedFrom;
    return { from, to, all: false, preset: detectPreset(from, to, false) };
  }
  return { from: '', to: '', all: true, preset: 'all' };
}

let dateRange = loadSavedRange();

function persistRange() {
  if (dateRange.all) {
    localStorage.setItem('ov-range-all', '1');
    localStorage.removeItem('ov-from');
    localStorage.removeItem('ov-to');
  } else {
    localStorage.setItem('ov-range-all', '0');
    localStorage.setItem('ov-from', dateRange.from);
    localStorage.setItem('ov-to', dateRange.to);
  }
}

function rangeQuery() {
  const params = new URLSearchParams();
  if (sourceFilter !== 'all') params.set('source', sourceFilter);
  if (dateRange.all) params.set('all', '1');
  else {
    if (dateRange.from) params.set('from', dateRange.from);
    if (dateRange.to) params.set('to', dateRange.to);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function windowLabelText() {
  if (dateRange.all) return 'All history';
  if (stats?.window?.from && stats?.window?.to) {
    if (stats.window.from === stats.window.to) return fmtDay(stats.window.from);
    return `${fmtDay(stats.window.from)} — ${fmtDay(stats.window.to)}`;
  }
  if (dateRange.from && dateRange.to && dateRange.from === dateRange.to) return fmtDay(dateRange.from);
  if (dateRange.from && dateRange.to) return `${fmtDay(dateRange.from)} — ${fmtDay(dateRange.to)}`;
  return 'Custom range';
}

const PLAN_STORAGE_KEY = 'ov-plans';
const DEFAULT_PLANS = {
  'claude-code': { name: 'Claude plan', monthlyCost: 20 },
  codex: { name: 'Codex plan', monthlyCost: 20 },
  cursor: { name: 'Cursor plan', monthlyCost: 20 },
};

function loadPlanConfig() {
  let savedPlans = {};
  try { savedPlans = JSON.parse(localStorage.getItem(PLAN_STORAGE_KEY) || '{}').plans || {}; }
  catch { /* use defaults */ }

  const plans = {};
  for (const source of new Set([...Object.keys(DEFAULT_PLANS), ...Object.keys(savedPlans)])) {
    const fallback = DEFAULT_PLANS[source] || { name: `${sourceLabel(source)} plan`, monthlyCost: 0 };
    const saved = savedPlans[source] || {};
    const monthlyCost = Number(saved.monthlyCost ?? fallback.monthlyCost);
    plans[source] = {
      name: String(saved.name || fallback.name),
      monthlyCost: Number.isFinite(monthlyCost) ? Math.max(0, monthlyCost) : fallback.monthlyCost,
    };
  }
  return { plans };
}

let planConfig = loadPlanConfig();

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtNum = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  : String(Math.round(n));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtMoney = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const digits = Math.abs(n) < 0.01 && n !== 0 ? 4 : 2;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: stats?.cost?.currency || 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
};
const fmtPct = (n, digits = 1) => (n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`);
function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}
const fmtHour = (h) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDay = (k) => parseDay(k).toLocaleDateString([], { month: 'short', day: 'numeric' });
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_FULL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

// ── data loading ─────────────────────────────────────────────────
let lastFingerprint = '';
let hasLoadedOnce = false;
let stateLoadGen = 0;

async function loadState(force = false, { soft = true } = {}) {
  const gen = ++stateLoadGen;
  const showSoft = soft && hasLoadedOnce && typeof window.setDataLoading === 'function';
  if (showSoft) window.setDataLoading(true, force ? 'Refreshing sessions…' : 'Tracing tokens…');
  try {
    const q = rangeQuery();
    const [stateRes, statsRes] = await Promise.all([fetch(`/api/state${q}`), fetch(`/api/stats${q}`)]);
    state = await stateRes.json();
    stats = await statsRes.json();
    if (gen !== stateLoadGen) return;
    $('#roots').textContent = state.roots.length
      ? state.roots.join('  ·  ')
      : 'no agent state directories found';
    renderSeg();
    renderRange();
    // skip re-render (which collapses expanded cards) when nothing changed
    const fp = [
      sourceFilter,
      dateRange.all ? 'all' : `${dateRange.from}:${dateRange.to}`,
      stats?.window?.from,
      stats?.window?.to,
      stats?.totals?.sessions,
      stats?.totals?.edits,
      state.sessions.map((s) => s.id + s.eventCount + (s.endedAt || '')).join('|'),
    ].join('||');
    if (!force && fp === lastFingerprint) return;
    lastFingerprint = fp;
    renderTree();
    renderMain();
    hasLoadedOnce = true;
    const main = document.getElementById('main');
    if (main) main.removeAttribute('aria-busy');
  } finally {
    if (showSoft) window.setDataLoading(false);
  }
}

// ── source switcher ──────────────────────────────────────────────
function renderSeg() {
  const seg = $('#seg');
  const sources = Object.keys(state.counts).sort();
  if (!sources.length) { seg.innerHTML = ''; return; }
  const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
  const pill = (id, name, n) =>
    `<button role="tab" aria-selected="${sourceFilter === id}" class="${sourceFilter === id ? 'active' : ''}" data-src="${esc(id)}">${esc(name)} <span class="n">${n}</span></button>`;
  seg.innerHTML =
    pill('all', 'All', total) +
    sources.map((s) => pill(s, sourceLabel(s), state.counts[s])).join('');
  seg.title = state.roots.join('\n');
  for (const b of seg.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      if (sourceFilter === b.dataset.src) return;
      sourceFilter = b.dataset.src;
      localStorage.setItem('ov-source', sourceFilter);
      selected = null;
      loadState(true);
    });
  }
}

// ── date range filter ────────────────────────────────────────────
function applyRange(next, { reload = true } = {}) {
  let from = next.from || '';
  let to = next.to || '';
  if (from && to && from > to) [from, to] = [to, from];
  dateRange = {
    from,
    to,
    all: Boolean(next.all) || (!from && !to),
    preset: next.preset || detectPreset(from, to, Boolean(next.all) || (!from && !to)),
  };
  persistRange();
  renderRange();
  if (reload) {
    selected = null;
    loadState(true);
  }
}

function renderRange() {
  const presets = $('#range-presets');
  const fromInput = $('#range-from');
  const toInput = $('#range-to');
  if (!presets || !fromInput || !toInput) return;

  const active = dateRange.preset || detectPreset(dateRange.from, dateRange.to, dateRange.all);
  presets.innerHTML = RANGE_PRESETS.map((p) =>
    `<button type="button" role="tab" aria-selected="${active === p.id}" class="${active === p.id ? 'active' : ''}" data-preset="${esc(p.id)}">${esc(p.label)}</button>`
  ).join('');

  fromInput.value = dateRange.all ? '' : (dateRange.from || '');
  toInput.value = dateRange.all ? '' : (dateRange.to || '');
  fromInput.disabled = false;
  toInput.disabled = false;

  for (const b of presets.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      const r = rangeFromPreset(b.dataset.preset);
      applyRange({ ...r, preset: b.dataset.preset });
    });
  }
}

function onRangeInputChange() {
  const from = $('#range-from').value;
  const to = $('#range-to').value;
  if (!from || !to) return;
  applyRange({ from, to, all: false, preset: detectPreset(from, to, false) });
}

// ── tooltip ──────────────────────────────────────────────────────
const tip = () => $('#tooltip');
function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.classList.add('on');
  moveTip(x, y);
}
function moveTip(x, y) {
  const t = tip();
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}
const hideTip = () => tip().classList.remove('on');

// ── sidebar: spawn tree ──────────────────────────────────────────
function renderTree() {
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const byGroup = new Map();
  for (const s of state.sessions) {
    const key = `${s.source} · ${s.agent}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(s);
  }
  // newest activity first, both across groups and within them
  const groups = [...byGroup.entries()].sort(
    (a, b) => latest(b[1]).localeCompare(latest(a[1]))
  );
  let html = '';
  for (const [key, sessions] of groups) {
    html += `<div class="agent-name">${esc(key)}</div>`;
    const roots = sessions
      .filter((s) => !s.parent || !byId.has(s.parent))
      .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''));
    for (const s of roots) html += nodeHtml(s, byId, false);
  }
  $('#tree').innerHTML = html || '<div class="agent-name">no sessions</div>';
  function latest(sessions) {
    return sessions.reduce((m, s) => ((s.endedAt || '') > m ? s.endedAt : m), '');
  }
  for (const btn of document.querySelectorAll('.node-btn')) {
    btn.addEventListener('click', () => selectSession(btn.dataset.id));
  }
}

function nodeHtml(s, byId, isChild) {
  const isLive = s.endedAt && Date.now() - Date.parse(s.endedAt) < 3 * 60_000;
  const live = isLive ? '<span class="live">● live</span>' : '';
  const errs = s.stats?.errors ? `<span class="err">⚠ ${s.stats.errors}</span>` : '';
  const kids = (s.children || []).map((id) => byId.get(id)).filter(Boolean);
  const tools = Object.values(s.stats?.toolCounts || {}).reduce((a, b) => a + b, 0);
  return `
    <div class="tree-node">
      <button class="node-btn ${selected === s.id ? 'active' : ''}" data-id="${esc(s.id)}">
        <span class="node-label">${isChild ? '<span class="spawn-tag">↳ </span>' : ''}${esc(s.label)}</span>
        <span class="node-meta">${live}<span>${s.startedAt ? new Date(s.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span><span>${tools} tools</span>${errs}</span>
      </button>
      ${kids.length ? `<div class="tree-children">${kids.map((k) => nodeHtml(k, byId, true)).join('')}</div>` : ''}
    </div>`;
}

// ── main: overview + charts ──────────────────────────────────────
function renderMain() {
  if (!state.sessions.length) {
    $('#main').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" aria-hidden="true">◎</div>
        <h2>No sessions found</h2>
        <p>Visualisation Dashboard looked for agent transcripts and found none in this window.</p>
        <div class="empty-state-actions">
          <div class="empty-state-action">
            <span>Point this tool at a state directory</span>
            <code>--dir &lt;path&gt;</code>
          </div>
          <div class="empty-state-action">
            <span>Widen the time window</span>
            <code>--all</code>
          </div>
          <div class="empty-state-action">
            <span>Or try it with sample data</span>
            <code>npm run sample</code>
          </div>
        </div>
      </div>`;
    return;
  }
  const t = stats.totals;
  const freshIn = Math.max(0, t.tokensIn - t.cacheRead - (t.cacheWrite || 0));
  const totalTokens = freshIn + t.tokensOut;
  const windowLabel = windowLabelText();
  const topModel = stats.models[0]?.name;

  $('#main').innerHTML = `
    <div class="hero">
      <div>
        <div class="eyebrow">${esc(windowLabel)} with ${esc(sourceFilter === 'all' ? 'your agents' : sourceShort[sourceFilter] || sourceLabel(sourceFilter))}</div>
        <div class="big">${fmtNum(totalTokens)}<small>tokens</small></div>
        <div class="sub"><b>${fmtNum(freshIn)}</b> in · <b>${fmtNum(t.tokensOut)}</b> out · <b>${fmtNum(t.cacheRead)}</b> cache-read</div>
      </div>
      <div class="hero-side">
        active <b>${stats.records?.activeDays || 0}</b> of ${stats.perDay?.length || 0} days · streak <b>${stats.records?.streak || 0}d</b><br/>
        ${topModel ? `mostly <b>${esc(topModel)}</b>` : ''}
      </div>
    </div>
    <div class="cards">
      ${statTile('Sessions', fmtInt(t.sessions), `${fmtInt(t.messages)} messages`)}
      ${statTile('Tool calls', fmtInt(t.toolCalls), stats.tools[0] ? `${esc(stats.tools[0].name)} leads` : '')}
      ${statTile('Code impact', `+${fmtNum(t.additions)}`, `−${fmtNum(t.deletions)} · ${fmtInt(t.filesTouched)} files`)}
      ${statTile('Sub-agents', fmtInt(t.spawns), 'spawned')}
      ${statTile('Errors survived', fmtInt(t.errors), t.toolCalls ? `${((t.errors / t.toolCalls) * 100).toFixed(1)}% of calls` : '')}
    </div>
    <div class="panel feature-panel" id="cost-intelligence"></div>
    <div class="panel feature-panel">
      <h2>Code impact, not token volume <span class="note">· what the tokens bought</span></h2>
      <div class="impact-summary">
        <div><strong class="add">+${fmtInt(t.additions)}</strong><span>lines added</span></div>
        <div><strong class="del">−${fmtInt(t.deletions)}</strong><span>lines removed</span></div>
        <div><strong>${fmtInt(t.filesTouched)}</strong><span>files touched</span></div>
        <div><strong>${fmtInt(stats.impact.churnFiles.length)}</strong><span>churn hotspots</span></div>
      </div>
      <div class="grid-2 impact-grid">
        <div>
          <h3>Daily diff</h3>
          <div class="legend">
            <span class="chip"><span class="sw" style="background:var(--good)"></span>Added</span>
            <span class="chip"><span class="sw" style="background:var(--critical)"></span>Removed</span>
          </div>
          <div class="chart-wrap" id="impact-chart"></div>
        </div>
        <div>
          <h3>Most-shaped directories</h3>
          <div id="directory-bars" class="mini-bars"></div>
        </div>
      </div>
      <div class="risk-head">
        <div><h3>AI-written code risk map</h3><p>Heat combines repeat sessions, edit count, churn, and changed lines.</p></div>
        <span class="risk-scale"><i></i> low <i></i> watch <i></i> high</span>
      </div>
      <div id="risk-map"></div>
    </div>
    <div class="panel feature-panel" id="scoreboard-panel">
      <h2>Agent head-to-head <span class="note">· normalized on your work</span></h2>
      <div id="scoreboard"></div>
    </div>
    <div class="panel feature-panel">
      <h2>Workflow intelligence <span class="note">· coaching signals from session shape</span></h2>
      <div id="workflow"></div>
    </div>
    <div class="panel">
      <h2>Daily token flow <span class="note">· hover for detail</span></h2>
      <div class="legend">
        <span class="chip"><span class="sw" style="background:var(--ser-in)"></span>Input</span>
        <span class="chip"><span class="sw" style="background:var(--ser-out)"></span>Output</span>
      </div>
      <div class="chart-wrap" id="daily-chart"></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h2>Working rhythm <span class="note">· activity by hour × weekday</span></h2>
        <div id="punchcard"></div>
      </div>
      <div class="panel">
        <h2>Top tools</h2>
        <div class="bars" id="tool-bars"></div>
      </div>
    </div>
    <div class="panel" id="trajectory"></div>`;

  renderDailyChart();
  renderCostIntelligence();
  renderImpactChart();
  renderDirectoryBars();
  renderRiskMap();
  renderScoreboard();
  renderWorkflow();
  renderPunchcard();
  renderToolBars();
  renderTrajectory();
}

const statTile = (k, v, d) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;

function activePlanEntries() {
  const activeSources = sourceFilter === 'all' ? Object.keys(state.counts) : [sourceFilter];
  return activeSources
    .map((source) => ({ source, ...(planConfig.plans[source] || {}) }))
    .filter((plan) => Number(plan.monthlyCost) > 0);
}

function planLabelForWindow() {
  const plans = activePlanEntries();
  if (plans.length === 1) return plans[0].name || `${sourceLabel(plans[0].source)} plan`;
  return plans.length > 1 ? 'combined plans' : 'plan';
}

function planSpendForWindow() {
  const monthly = activePlanEntries().reduce((sum, plan) => sum + Math.max(0, Number(plan.monthlyCost) || 0), 0);
  const windowMonths = Math.max(1 / 30, stats.perDay.length / 30);
  return monthly * windowMonths;
}

function renderCostIntelligence() {
  const host = $('#cost-intelligence');
  const cost = stats.cost;
  const planSpend = planSpendForWindow();
  const planLabel = planLabelForWindow();
  const roi = planSpend ? cost.total / planSpend : null;
  const coverage = fmtPct(cost.coverage, 0);
  const rows = cost.bySource.filter((r) => r.pricedSessions > 0);
  const max = Math.max(0.000001, ...rows.map((r) => r.total));
  const observedRates = stats.models.filter((m) => m.rate);
  host.innerHTML = `
    <div class="panel-title-row">
      <div><h2>Cost intelligence & plan ROI <span class="note">· API-equivalent estimate</span></h2></div>
      <button class="micro-btn" id="cost-settings">Plan setup</button>
    </div>
    <div class="roi-layout">
      <div class="roi-card">
        <div class="roi-k">Return on plan</div>
        <div class="roi-v">${roi == null ? '—' : `${roi.toFixed(1)}×`}</div>
        <p>You consumed <b>${fmtMoney(cost.total)}</b> of API-equivalent tokens on ${planSpend ? `<b>${fmtMoney(planSpend)} ${esc(planLabel)}</b>` : 'an unconfigured plan'}${roi == null ? '.' : ` — <strong>${roi.toFixed(1)}× ROI</strong>.`}</p>
        <span>${coverage} of billable sessions priced · ${fmtMoney(cost.perSession)} / session</span>
      </div>
      <div class="cost-breakdown">
        <div class="cost-kpis">
          <div><span>API equivalent</span><b>${fmtMoney(cost.total)}</b></div>
          <div><span>Cost / edit</span><b>${fmtMoney(cost.perEdit)}</b></div>
          <div><span>Plan spend</span><b>${planSpend ? fmtMoney(planSpend) : 'not set'}</b></div>
        </div>
        <div class="cost-bars">
          ${rows.length ? rows.map((r) => `
            <div class="cost-row">
              <span>${esc(sourceLabel(r.source))}</span>
              <i><i style="width:${Math.max(2, r.total / max * 100)}%"></i></i>
              <b>${fmtMoney(r.total)}</b>
              <small>${fmtMoney(r.costPerEdit)}/edit · ${fmtMoney(r.costPer100Lines)}/100 lines</small>
            </div>`).join('') : '<p class="muted-copy">No sessions match the pricing table yet.</p>'}
        </div>
      </div>
    </div>
    ${cost.unpricedSessions ? `<div class="coverage-warn">${fmtInt(cost.unpricedSessions)} session${cost.unpricedSessions === 1 ? '' : 's'} with token usage could not be priced — add to pricing.json: ${(cost.unpricedModels || []).map((m) => `${esc(m.model)} (${m.count})`).join(', ') || 'unknown models'}.</div>` : ''}
    <details class="pricing-details">
      <summary>Observed model pricing · updated ${esc(cost.pricingUpdatedAt || 'unknown')}</summary>
      <div class="pricing-table">
        <span>Model</span><span>Input</span><span>Cache read</span><span>Cache write</span><span>Output</span>
        ${observedRates.map((m) => `<b>${esc(m.name)}</b><span>${fmtMoney(m.rate.input)}</span><span>${fmtMoney(m.rate.cacheRead)}</span><span>${fmtMoney(m.rate.cacheWrite)}</span><span>${fmtMoney(m.rate.output)}</span>`).join('')}
      </div>
      <p class="method-note">Rates are USD per million tokens. Subscription usage is valued at equivalent public API rates; it is not a vendor invoice.</p>
    </details>`;
  $('#cost-settings').addEventListener('click', openCostSettings);
}

function openCostSettings() {
  let dialog = $('#plan-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'plan-dialog';
    document.body.appendChild(dialog);
  }
  const planSources = [...new Set([
    ...Object.keys(DEFAULT_PLANS),
    ...Object.keys(state.counts),
    ...(sourceFilter === 'all' ? [] : [sourceFilter]),
  ])];
  dialog.innerHTML = `
    <form method="dialog" class="plan-form">
      <div><span class="form-eyebrow">Cost intelligence</span><h2>Plan setup</h2></div>
      <div class="plan-providers">
        ${planSources.map((source) => {
          const plan = planConfig.plans[source] || { name: `${sourceLabel(source)} plan`, monthlyCost: 0 };
          return `<section class="plan-provider">
            <div class="plan-provider-head"><strong>${esc(sourceLabel(source))}</strong><span>monthly</span></div>
            <div class="plan-fields">
              <label>Plan name<input name="name:${esc(source)}" value="${esc(plan.name)}" placeholder="${esc(sourceLabel(source))} plan" /></label>
              <label>Spend (USD)<input name="cost:${esc(source)}" type="number" min="0" step="0.01" value="${Number(plan.monthlyCost) || 0}" /></label>
            </div>
          </section>`;
        }).join('')}
      </div>
      <p>Each plan is included only when its agent source is present in the selected view. Spend is scaled to the reporting window; set a plan to 0 to exclude it.</p>
      <div class="dialog-actions"><button value="cancel" class="micro-btn">Cancel</button><button value="save" class="micro-btn primary">Save plans</button></div>
    </form>`;
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    const data = new FormData(dialog.querySelector('form'));
    const plans = { ...planConfig.plans };
    for (const source of planSources) {
      plans[source] = {
        name: String(data.get(`name:${source}`) || `${sourceLabel(source)} plan`),
        monthlyCost: Math.max(0, Number(data.get(`cost:${source}`)) || 0),
      };
    }
    planConfig = { plans };
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(planConfig));
    renderCostIntelligence();
  }, { once: true });
  dialog.returnValue = '';
  dialog.showModal();
}

function renderImpactChart() {
  const host = $('#impact-chart');
  const days = stats.perDay;
  const W = Math.max(320, host.clientWidth || 620);
  const H = 188, padL = 42, padR = 6, padT = 10, padB = 22;
  const iw = W - padL - padR, center = 83, half = 68;
  const max = Math.max(1, ...days.map((d) => Math.max(d.additions, d.deletions)));
  const step = iw / days.length;
  const barW = Math.min(Math.max(3, step * 0.62), 25);
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(iw / 58)));
  let svg = `<line x1="${padL}" x2="${W - padR}" y1="${center}" y2="${center}" stroke="var(--grid)" stroke-width="1.5"/>`;
  days.forEach((d, i) => {
    const cx = padL + step * i + step / 2, x = cx - barW / 2;
    const ah = d.additions / max * half, dh = d.deletions / max * half;
    if (ah) svg += `<rect x="${x}" y="${center - ah}" width="${barW}" height="${Math.max(1, ah)}" rx="2.5" fill="var(--good)"/>`;
    if (dh) svg += `<rect x="${x}" y="${center + 2}" width="${barW}" height="${Math.max(1, dh)}" rx="2.5" fill="var(--critical)"/>`;
    if (i % labelEvery === 0) svg += `<text x="${cx}" y="${H - 5}" font-size="10" text-anchor="middle">${fmtDay(d.date)}</text>`;
    svg += `<rect class="col-hit" data-i="${i}" x="${padL + step * i}" y="${padT}" width="${step}" height="${half * 2 + 4}"/>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lines added and removed per day">${svg}</svg>`;
  host.querySelectorAll('.col-hit').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const d = days[Number(el.dataset.i)];
      showTip(`<div class="tt-title">${fmtDay(d.date)}</div><div class="row"><span>Added</span><b>+${fmtInt(d.additions)}</b></div><div class="row"><span>Removed</span><b>−${fmtInt(d.deletions)}</b></div><div class="row"><span>Edit operations</span><b>${fmtInt(d.edits)}</b></div>`, e.clientX, e.clientY);
    });
    el.addEventListener('pointerleave', hideTip);
  });
}

const compactPath = (p, parts = 3) => {
  const segs = String(p || '.').replaceAll('\\', '/').split('/').filter(Boolean);
  return (String(p).startsWith('/') ? '…/' : '') + segs.slice(-parts).join('/');
};

function renderDirectoryBars() {
  const host = $('#directory-bars');
  const rows = stats.impact.directories.slice(0, 7);
  const max = Math.max(1, ...rows.map((r) => r.edits));
  host.innerHTML = rows.length ? rows.map((r) => `
    <div class="mini-bar" title="${esc(r.path)}">
      <div><span>${esc(compactPath(r.path, 2))}</span><b>${fmtInt(r.edits)} edits</b></div>
      <i><i style="width:${Math.max(2, r.edits / max * 100)}%"></i></i>
      <small>${fmtInt(r.files)} files · +${fmtInt(r.additions)} / −${fmtInt(r.deletions)}</small>
    </div>`).join('') : '<p class="muted-copy">No parseable code edits in this window.</p>';
}

function renderRiskMap() {
  const host = $('#risk-map');
  const rows = stats.impact.files.slice(0, 14);
  if (!rows.length) { host.innerHTML = '<p class="muted-copy">No Edit, Write, NotebookEdit, str_replace_editor, or apply_patch payloads found.</p>'; return; }
  host.innerHTML = `<div class="risk-table">
    <div class="risk-row risk-labels"><span>File</span><span>Risk</span><span>Sessions</span><span>Churn</span><span>Diff</span></div>
    ${rows.map((r) => `<div class="risk-row" title="${esc(r.path)}">
      <span class="risk-file">${esc(compactPath(r.path, 4))}</span>
      <span class="risk-cell ${r.risk}" style="--score:${r.riskScore / 100}"><b>${r.riskScore}</b></span>
      <span>${fmtInt(r.sessions)}</span>
      <span class="${r.churn ? 'churn' : ''}">${fmtInt(r.churn)}</span>
      <span><i class="add">+${fmtInt(r.additions)}</i> <i class="del">−${fmtInt(r.deletions)}</i></span>
    </div>`).join('')}
  </div>`;
}

function renderScoreboard() {
  const host = $('#scoreboard');
  const agents = stats.scoreboard;
  if (!agents.length) { host.innerHTML = '<p class="muted-copy">No agent sessions to compare.</p>'; return; }
  const metrics = [
    { key: 'editsPerSession', label: 'Edits / session', better: 'high', fmt: (v) => v?.toFixed(2) ?? '—' },
    { key: 'outputTokensPerEdit', label: 'Output tokens / edit', better: 'low', fmt: (v) => v == null ? '—' : fmtNum(v) },
    { key: 'toolErrorRate', label: 'Tool error rate', better: 'low', fmt: fmtPct },
    { key: 'medianToolLatencyMs', label: 'Median tool latency', better: 'low', fmt: (v) => fmtDur(v) || '—' },
    { key: 'cacheEfficiency', label: 'Cache efficiency', better: 'high', fmt: fmtPct },
    { key: 'costPerEdit', label: 'API $ / edit', better: 'low', fmt: fmtMoney },
    { key: 'costPer100Lines', label: 'API $ / 100 lines', better: 'low', fmt: fmtMoney },
  ];
  const bestFor = (metric) => {
    const values = agents.map((a) => a[metric.key]).filter((v) => v != null && Number.isFinite(v));
    if (values.length < 2) return null;
    return metric.better === 'high' ? Math.max(...values) : Math.min(...values);
  };
  host.innerHTML = `
    <div class="score-agents">${agents.map((a) => `<div><span>${esc(sourceLabel(a.source))}</span><b>${fmtInt(a.edits)}</b><small>edit operations · ${fmtInt(a.sessions)} sessions</small></div>`).join('')}</div>
    <div class="score-table" style="--agents:${agents.length}">
      <div class="score-row score-head"><span>Normalized metric</span>${agents.map((a) => `<b>${esc(sourceLabel(a.source))}</b>`).join('')}</div>
      ${metrics.map((m) => { const best = bestFor(m); return `<div class="score-row"><span>${m.label}<small>${m.better === 'high' ? 'higher' : 'lower'} is better</small></span>${agents.map((a) => `<b class="${best != null && a[m.key] === best ? 'winner' : ''}">${m.fmt(a[m.key])}${best != null && a[m.key] === best ? '<i>best</i>' : ''}</b>`).join('')}</div>`; }).join('')}
    </div>
    <p class="method-note">An edit is one file operation parsed from an edit/write/patch payload. Latency measures tool call → result. Cost per unit only uses priced sessions.</p>`;
}

function renderWorkflow() {
  const host = $('#workflow');
  const w = stats.workflow;
  const t = stats.totals;
  const correctionRate = t.sessions ? w.sessionsCorrected / t.sessions : 0;
  const reworkRate = t.sessions ? w.sessionsWithRework / t.sessions : 0;
  const abandonedRate = t.sessions ? w.abandoned / t.sessions : 0;
  const churn = stats.impact.churnFiles[0];
  const coaching = [];
  if (churn) coaching.push(`<b>${esc(compactPath(churn.path, 3))}</b> crossed ${fmtInt(churn.sessions)} sessions and ${fmtInt(churn.edits)} edits. Consider a focused spec or test around that file.`);
  if (correctionRate >= 0.2) coaching.push(`You corrected the agent in ${fmtPct(correctionRate, 0)} of sessions. Front-load constraints that recur in those follow-ups.`);
  if (w.medianTimeToFirstEditMs != null && w.medianTimeToFirstEditMs > 5 * 60_000) coaching.push(`The median first edit takes ${fmtDur(w.medianTimeToFirstEditMs)}. Smaller initial scopes may shorten the reconnaissance phase.`);
  if (!coaching.length) coaching.push('No strong workflow smell crossed the current heuristics. Keep watching repeat-file churn as the sample grows.');
  host.innerHTML = `
    <div class="workflow-cards">
      ${workflowCard('Rework loops', fmtInt(w.reworkLoops), `${fmtPct(reworkRate, 0)} of sessions`, 'same file edited again in-session')}
      ${workflowCard('Abandoned', fmtInt(w.abandoned), `${fmtPct(abandonedRate, 0)} of sessions`, 'ended without a final assistant reply')}
      ${workflowCard('Corrections', fmtInt(w.corrections), `${fmtPct(correctionRate, 0)} of sessions`, 'negative user follow-ups after kickoff')}
      ${workflowCard('Time to first edit', fmtDur(w.medianTimeToFirstEditMs) || '—', 'median', 'first user request → first code edit')}
    </div>
    <div class="workflow-bottom">
      <div class="coach"><span>Coaching note</span><p>${coaching.join(' ')}</p></div>
      <div class="workflow-sources">
        ${stats.scoreboard.map((a) => `<div><b>${esc(sourceLabel(a.source))}</b><span>${a.reworkPerSession.toFixed(2)} rework/session</span><span>${fmtPct(a.abandonedRate)} abandoned</span><span>${fmtDur(a.medianTimeToFirstEditMs) || '—'} to edit</span></div>`).join('')}
      </div>
    </div>`;
}

const workflowCard = (label, value, detail, note) => `<div class="workflow-card"><span>${label}</span><b>${value}</b><i>${detail}</i><small>${note}</small></div>`;

// stacked columns of tokens in/out per day (single unit → one stacked axis)
function renderDailyChart() {
  const host = $('#daily-chart');
  const days = stats.perDay;
  const W = Math.max(320, host.clientWidth || 640);
  const H = 190, padL = 44, padR = 6, padT = 12, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const inOf = (d) => Math.max(0, d.tokensIn - (d.tokensCache || 0) - (d.tokensCacheWrite || 0));
  const max = Math.max(1, ...days.map((d) => inOf(d) + d.tokensOut));
  const y = (v) => padT + ih - (v / max) * ih;
  const step = iw / days.length;
  const barW = Math.min(Math.max(3, step * 0.62), 26);
  const ticks = niceTicks(max, 4);

  let g = '';
  for (const tv of ticks) {
    g += `<line x1="${padL}" x2="${W - padR}" y1="${y(tv)}" y2="${y(tv)}" stroke="var(--grid)" stroke-width="1"/>`;
    g += `<text x="${padL - 7}" y="${y(tv) + 3.5}" font-size="10" text-anchor="end">${fmtNum(tv)}</text>`;
  }
  g += `<line x1="${padL}" x2="${W - padR}" y1="${padT + ih}" y2="${padT + ih}" stroke="var(--grid)" stroke-width="1.25"/>`;

  const labelEvery = Math.ceil(days.length / Math.floor(iw / 58));
  let bars = '', hits = '';
  days.forEach((d, i) => {
    const cx = padL + step * i + step / 2;
    const x0 = cx - barW / 2;
    const total = inOf(d) + d.tokensOut;
    if (i % labelEvery === 0)
      g += `<text x="${cx}" y="${H - 7}" font-size="10" text-anchor="middle">${fmtDay(d.date)}</text>`;
    if (total > 0) {
      const hIn = ((inOf(d) / max) * ih);
      const hOut = ((d.tokensOut / max) * ih);
      const yIn = padT + ih - hIn;
      // input segment sits on the baseline; output stacks above with a 2px surface gap
      if (hOut > 0.5) {
        const yOut = yIn - 2 - hOut;
        bars += roundTopRect(x0, Math.max(padT, yOut), barW, hOut, 'var(--ser-out)');
        bars += `<rect x="${x0}" y="${yIn}" width="${barW}" height="${Math.max(1, hIn)}" fill="var(--ser-in)"/>`;
      } else {
        bars += roundTopRect(x0, yIn, barW, hIn, 'var(--ser-in)');
      }
    }
    hits += `<rect class="col-hit" data-i="${i}" x="${padL + step * i}" y="${padT}" width="${step}" height="${ih}"/>`;
  });

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Tokens per day, stacked input and output">${g}${bars}${hits}</svg>`;

  host.querySelectorAll('.col-hit').forEach((r) => {
    r.addEventListener('pointermove', (e) => {
      const d = days[Number(r.dataset.i)];
      showTip(
        `<div class="tt-title">${fmtDay(d.date)}</div>
         <div class="row"><span><span class="sw" style="background:var(--ser-in)"></span>Input</span><b>${fmtNum(inOf(d))}</b></div>
         <div class="row"><span><span class="sw" style="background:var(--ser-out)"></span>Output</span><b>${fmtNum(d.tokensOut)}</b></div>
         <div class="row"><span>Cache-read</span><b>${fmtNum(d.tokensCache || 0)}</b></div>
         <div class="row"><span>Cache-write</span><b>${fmtNum(d.tokensCacheWrite || 0)}</b></div>
         <div class="row"><span>Tool calls</span><b>${fmtInt(d.toolCalls)}</b></div>
         <div class="row"><span>Sessions</span><b>${fmtInt(d.sessions)}</b></div>`,
        e.clientX, e.clientY
      );
    });
    r.addEventListener('pointerleave', hideTip);
  });
}

function roundTopRect(x, y, w, h, fill) {
  if (h < 1) h = 1;
  const r = Math.min(3.5, w / 2, h);
  return `<path d="M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z" fill="${fill}"/>`;
}

function niceTicks(max, count) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = step; v <= max; v += step) out.push(v);
  return out;
}

// hour × weekday heat grid (sequential single-hue ramp; near-zero recedes)
function renderPunchcard() {
  const host = $('#punchcard');
  const punch = stats.punch;
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon-first
  const values = punch.flat().filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : 1;
  const th = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const cls = (v) => (v <= 0 ? '' : v <= th[0] ? 'h1' : v <= th[1] ? 'h2' : v <= th[2] ? 'h3' : v <= th[3] ? 'h4' : 'h5');

  let cells = '';
  for (const w of order)
    for (let h = 0; h < 24; h++)
      cells += `<span class="cell ${cls(punch[w][h])}" data-w="${w}" data-h="${h}"></span>`;
  const hours = Array.from({ length: 24 }, (_, h) => `<span>${fmtHour(h).replace('m', '')}</span>`).join('');

  const peak = stats.records.peakHour;
  host.innerHTML = `
    <div class="punch">
      <div class="dows">${order.map((w) => `<span>${DOW[w]}</span>`).join('')}</div>
      <div class="cells">${cells}</div>
      <div></div>
      <div class="hours">${hours}</div>
    </div>
    ${peak ? `<div class="punch-note">Peak: <b>${DOW_FULL[peak.weekday]} around ${fmtHour(peak.hour)}</b> — ${fmtInt(peak.n)} events</div>` : ''}`;

  host.querySelectorAll('.cell').forEach((c) => {
    c.addEventListener('pointermove', (e) => {
      const w = Number(c.dataset.w), h = Number(c.dataset.h);
      showTip(`<div class="tt-title">${DOW[w]} · ${fmtHour(h)}</div><div class="row"><span>Events</span><b>${fmtInt(punch[w][h])}</b></div>`, e.clientX, e.clientY);
    });
    c.addEventListener('pointerleave', hideTip);
  });
}

function renderToolBars() {
  const host = $('#tool-bars');
  const rows = stats.tools.slice(0, 8);
  if (!rows.length) { host.innerHTML = '<div class="node-meta">no tool calls</div>'; return; }
  const max = rows[0].count;
  host.innerHTML = rows
    .map(
      (r, i) => `
      <div class="bar-row" data-i="${i}">
        <span class="name">${esc(r.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(1.5, (r.count / max) * 100)}%"></span></span>
        <span class="val">${fmtInt(r.count)}</span>
      </div>`
    )
    .join('');
  host.querySelectorAll('.bar-row').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = rows[Number(el.dataset.i)];
      showTip(
        `<div class="tt-title">${esc(r.name)}</div>
         <div class="row"><span>Calls</span><b>${fmtInt(r.count)}</b></div>
         <div class="row"><span>Errors</span><b>${fmtInt(r.errors)}</b></div>`,
        e.clientX, e.clientY
      );
    });
    el.addEventListener('pointerleave', hideTip);
  });
}

// ── trajectory ───────────────────────────────────────────────────
async function selectSession(id) {
  selected = id;
  renderTree();
  await renderTrajectory();
  $('#trajectory')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function renderTrajectory() {
  const el = $('#trajectory');
  if (!el) return;
  if (!selected) {
    el.innerHTML = '<h2>Trajectory</h2><div class="node-meta">Select a session on the left to replay its full trajectory. Sessions marked <span class="spawn-tag">↳</span> were spawned by a parent agent.</div>';
    return;
  }
  const res = await fetch(`/api/session?id=${encodeURIComponent(selected)}`);
  const s = await res.json();
  if (s.error) { el.innerHTML = `<h2>Trajectory</h2><div class="node-meta">${esc(s.error)}</div>`; return; }

  const byId = new Map(state.sessions.map((x) => [x.id, x]));
  const chain = [];
  for (let cur = s; cur; cur = cur.parent ? byId.get(cur.parent) : null) chain.unshift(cur);
  const crumbs = chain
    .map((c, i) =>
      i === chain.length - 1
        ? `<b>${esc(c.label)}</b>`
        : `<button data-id="${esc(c.id)}">${esc(c.label)}</button> <span>↳</span>`
    )
    .join(' ');

  const durMs = s.startedAt && s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : null;
  el.innerHTML = `
    <h2>Trajectory</h2>
    <div class="crumbs">${crumbs}</div>
    <div class="sess-meta">
      <span>source <b>${esc(s.source)}</b></span>
      <span>agent <b>${esc(s.agent)}</b></span>
      <span>model <b>${esc(s.model ?? '—')}</b></span>
      <span>started <b>${fmtDate(s.startedAt)}</b></span>
      <span>duration <b>${fmtDur(durMs) || '—'}</b></span>
      <span>tokens <b>${fmtNum(s.stats.tokensIn)} in / ${fmtNum(s.stats.tokensOut)} out</b></span>
      <span>API equivalent <b>${fmtMoney(s.intelligence.apiCost)}</b></span>
      <span>impact <b>+${fmtInt(s.intelligence.additions)} / −${fmtInt(s.intelligence.deletions)}</b></span>
      <span>first edit <b>${fmtDur(s.intelligence.timeToFirstEditMs) || '—'}</b></span>
      <span>session <b>${esc(s.id.slice(0, 8))}</b></span>
    </div>
    ${(s.intelligence.reworkLoops || s.intelligence.corrections || s.intelligence.abandoned) ? `<div class="session-signals">
      ${s.intelligence.reworkLoops ? `<span>${fmtInt(s.intelligence.reworkLoops)} rework loop${s.intelligence.reworkLoops === 1 ? '' : 's'}</span>` : ''}
      ${s.intelligence.corrections ? `<span>${fmtInt(s.intelligence.corrections)} correction${s.intelligence.corrections === 1 ? '' : 's'}</span>` : ''}
      ${s.intelligence.abandoned ? '<span class="bad">abandoned trajectory</span>' : ''}
    </div>` : ''}
    <div class="timeline">${s.events.map(eventHtml).join('')}</div>`;

  for (const btn of el.querySelectorAll('.crumbs button, .spawn-open')) {
    btn.addEventListener('click', () => selectSession(btn.dataset.id));
  }
}

function eventHtml(ev) {
  const when = `<span class="when">${fmtTime(ev.ts)}</span>`;
  if (ev.kind === 'user') return wrap('ev-user', `USER ${when}`, `<div class="body">${esc(ev.text)}</div>`);
  if (ev.kind === 'assistant') {
    const badge = ev.usage
      ? ` <span class="usage-badge" style="font-size:10px; opacity:0.75; font-weight:normal; margin-left:8px; border:1px solid var(--border); padding:2px 6px; border-radius:4px; background:var(--surface);">in: ${fmtNum(ev.usage.tokensIn)} | out: ${fmtNum(ev.usage.tokensOut)}${ev.usage.cacheRead ? ` | cache: ${fmtNum(ev.usage.cacheRead)}` : ''}</span>`
      : '';
    return wrap('ev-assistant', `ASSISTANT ${when}${badge}`, `<div class="body">${esc(ev.text)}</div>`);
  }
  if (ev.kind === 'thinking')
    return wrap('ev-thinking', `THINKING ${when}`, `<details><summary>show reasoning</summary><pre>${esc(ev.text)}</pre></details>`);
  if (ev.kind === 'meta') return wrap('ev-meta', `EVENT ${when}`, `<div class="body">${esc(ev.text)}</div>`);
  if (ev.kind === 'tool') {
    const t = ev.tool;
    const spawn = Boolean(t.spawnTarget);
    const dur = t.resultTs && ev.ts ? fmtDur(Date.parse(t.resultTs) - Date.parse(ev.ts)) : '';
    const status = t.result == null ? '' : t.isError ? '<span class="badge-err">⚠ ERROR</span>' : '<span class="badge-ok">✓ ok</span>';
    const args = JSON.stringify(t.args, null, 2);
    return wrap(
      spawn ? 'ev-spawn' : 'ev-tool',
      `${spawn ? 'SPAWN' : 'TOOL'} ${when}`,
      `<div class="tool-card">
        <div class="tool-head">
          <span class="tool-name">${esc(t.name)}</span>
          ${status}
          ${dur ? `<span class="dur">${dur}</span>` : ''}
        </div>
        ${args && args !== '{}' ? `<details><summary>arguments</summary><pre>${esc(args)}</pre></details>` : ''}
        ${t.result ? `<details><summary>result — ${esc(t.result.slice(0, 120))}${t.result.length > 120 ? '…' : ''}</summary><pre>${esc(t.result)}</pre></details>` : ''}
        ${spawn ? `<button class="spawn-open" data-id="${esc(t.spawnTarget)}">Open sub-agent trajectory ↳</button>` : ''}
      </div>`
    );
  }
  return '';
}

const wrap = (cls, who, body) => `<div class="ev ${cls}"><span class="who">${who}</span>${body}</div>`;

// ── Wrapped: your usage as a story ───────────────────────────────
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

function wrappedSlides() {
  const t = stats.totals;
  const r = stats.records;
  const tokens = t.tokensIn - t.cacheRead - (t.cacheWrite || 0) + t.tokensOut;
  const words = tokens * 0.75;
  const novels = words / 90_000;
  const rangeLabel = `${fmtDay(stats.window.from)} — ${fmtDay(stats.window.to)}`;
  const [t1, t2, t3] = stats.tools;
  const slides = [];

  slides.push({
    kicker: 'visualisation dashboard presents', dur: 4200,
    html: `<div class="w-title">Your <em>${esc(sourceLabel(sourceFilter))}</em><br/>Wrapped</div>
           <div class="w-line">${rangeLabel} · <b>${fmtInt(t.sessions)}</b> sessions on the record.<br/>Let's roll the tape.</div>`,
  });

  slides.push({
    kicker: 'the volume', dur: 5200,
    html: `<div class="w-num"><span class="cnt" data-v="${tokens}" data-f="num">0</span><span class="unit">tokens exchanged</span></div>
           <div class="w-line">${novels >= 1.5 ? `Roughly <b>${fmtNum(words)}</b> words — <span class="hl">${novels.toFixed(0)} novels'</span> worth of pair programming.` : `Roughly <b>${fmtNum(words)}</b> words of pair programming.`}
           ${t.cacheRead > 0 ? `<br/>Plus <b>${fmtNum(t.cacheRead)}</b> cache-read tokens Claude skimmed for context.` : ''}</div>`,
  });

  if (t1) slides.push({
    kicker: 'the workhorse', dur: 5200,
    html: `<div class="w-num" style="font-size:clamp(54px,10vw,120px)">${esc(t1.name)}<span class="unit"><span class="cnt" data-v="${t1.count}" data-f="int">0</span> calls</span></div>
           <div class="w-line">${t2 ? `Then <b>${esc(t2.name)}</b> (${fmtInt(t2.count)})` : ''}${t3 ? ` and <b>${esc(t3.name)}</b> (${fmtInt(t3.count)})` : ''}${t2 ? '. You have a type.' : 'Your one true tool.'}</div>`,
  });

  slides.push({
    kicker: 'the output', dur: 5200,
    html: `<div class="w-num">+<span class="cnt" data-v="${t.additions}" data-f="int">0</span><span class="unit">lines added · −${fmtInt(t.deletions)} removed</span></div>
           <div class="w-line">across <b>${fmtInt(t.filesTouched)}</b> distinct files and <b>${fmtInt(t.edits)}</b> edit operations. That's what the tokens bought.</div>`,
  });

  const wrappedPlanSpend = planSpendForWindow();
  const wrappedPlanLabel = planLabelForWindow();
  const wrappedRoi = wrappedPlanSpend ? stats.cost.total / wrappedPlanSpend : null;
  slides.push({
    kicker: 'the return', dur: 5600,
    html: `<div class="w-num">${wrappedRoi == null ? fmtMoney(stats.cost.total) : `${wrappedRoi.toFixed(1)}×`}<span class="unit">${wrappedRoi == null ? 'API-equivalent cost' : 'return on plan'}</span></div>
           <div class="w-line">You consumed <b>${fmtMoney(stats.cost.total)}</b> of API-equivalent tokens${wrappedPlanSpend ? ` on <b>${fmtMoney(wrappedPlanSpend)} ${esc(wrappedPlanLabel)}</b>` : ''}. <span class="hl">${fmtPct(stats.cost.coverage, 0)} pricing coverage.</span></div>`,
  });

  if (r.peakHour) {
    const h = r.peakHour.hour;
    const vibe = h >= 22 || h <= 4 ? 'Certified night shipper.' : h < 9 ? 'Dawn patrol.' : h >= 18 ? 'Evening flow state.' : 'Daylight operator.';
    const hourTotals = Array.from({ length: 24 }, (_, i) => stats.punch.reduce((a, row) => a + row[i], 0));
    const hmax = Math.max(...hourTotals, 1);
    const mini = hourTotals.map((v, i) =>
      `<i style="height:${8 + (v / hmax) * 46}px;${i === h ? 'background:#e2a355' : ''}"></i>`).join('');
    slides.push({
      kicker: 'the rhythm', dur: 5600,
      html: `<div class="w-title">Peak hour:<br/><em>${fmtHour(h)}</em></div>
             <div class="w-minipunch" style="align-items:flex-end">${mini}</div>
             <div class="w-line">Busiest on <b>${DOW_FULL[r.peakHour.weekday]}</b>. <span class="hl">${vibe}</span></div>`,
    });
  }

  slides.push(t.spawns > 0 ? {
    kicker: 'the fleet', dur: 5200,
    html: `<div class="w-num"><span class="cnt" data-v="${t.spawns}" data-f="int">0</span><span class="unit">sub-agents dispatched</span></div>
           <div class="w-line">${r.longestSession ? `Longest run: <b>${esc(r.longestSession.label)}</b> — <span class="hl">${fmtDur(r.longestSession.ms)}</span> without blinking.` : 'An army of one, delegating like a general.'}</div>`,
  } : {
    kicker: 'the style', dur: 5200,
    html: `<div class="w-title">Hands on<br/><em>the wheel</em></div>
           <div class="w-line">Zero sub-agents spawned. ${r.longestSession ? `Longest session: <b>${fmtDur(r.longestSession.ms)}</b> straight.` : 'Every token, supervised.'}</div>`,
  });

  slides.push({
    kicker: 'the scars', dur: 5200,
    html: `<div class="w-num"><span class="cnt" data-v="${t.errors}" data-f="int">0</span><span class="unit">tool errors survived</span></div>
           <div class="w-line">${t.errors === 0 ? 'Flawless. Suspiciously flawless.' : `A ${((t.errors / Math.max(1, t.toolCalls)) * 100).toFixed(1)}% error rate — and <b>every single one</b> recovered from.`}</div>`,
  });

  slides.push({
    kicker: '', dur: 12_000, hint: 'screenshot this one',
    html: `<div class="w-card">
      <div class="head"><span class="t">${esc(sourceLabel(sourceFilter))} <em>Wrapped</em></span><span class="range">${rangeLabel}</span></div>
      <div class="grid">
        ${cardCell(fmtNum(tokens), 'tokens')}
        ${cardCell(fmtInt(t.sessions), 'sessions')}
        ${cardCell(fmtInt(t.toolCalls), 'tool calls')}
        ${cardCell(`+${fmtNum(t.additions)}`, 'lines added')}
        ${cardCell(fmtInt(t.spawns), 'sub-agents')}
        ${cardCell(wrappedRoi == null ? fmtMoney(stats.cost.total) : `${wrappedRoi.toFixed(1)}×`, wrappedRoi == null ? 'API equivalent' : 'plan ROI')}
      </div>
      <div class="foot"><span>visualisation<span class="dot">·</span>dashboard</span><span>${t1 ? `favorite tool: ${esc(t1.name)}` : ''}</span></div>
    </div>`,
  });

  return slides;
}
const cardCell = (n, l) => `<div class="cell"><div class="n">${n}</div><div class="l">${l}</div></div>`;

let wrappedTimer = null;
function openWrapped() {
  if (!stats || !stats.totals.sessions) return;
  closeWrapped();
  const slides = wrappedSlides();
  let idx = 0;

  const root = document.createElement('div');
  root.id = 'wrapped';
  root.innerHTML = `
    <div class="w-progress">${slides.map(() => '<span><i></i></span>').join('')}</div>
    <div class="w-top">
      <span>${esc(sourceLabel(sourceFilter))} · Wrapped</span>
      <button class="w-close" aria-label="Close">✕</button>
    </div>
    <div class="w-stage"></div>
    <div class="w-hint"></div>`;
  document.body.appendChild(root);

  const stage = root.querySelector('.w-stage');
  const bars = [...root.querySelectorAll('.w-progress span')];
  const hint = root.querySelector('.w-hint');

  function show(i) {
    idx = Math.max(0, Math.min(slides.length - 1, i));
    const s = slides[idx];
    bars.forEach((b, j) => {
      b.classList.toggle('done', j < idx);
      b.classList.toggle('now', j === idx);
      if (j === idx) { b.style.setProperty('--w-dur', `${s.dur}ms`); b.querySelector('i').style.animation = 'none'; void b.offsetWidth; b.querySelector('i').style.animation = ''; }
    });
    stage.innerHTML = `<div class="w-slide">${s.kicker ? `<div class="w-kicker">${s.kicker}</div>` : ''}${s.html}</div>`;
    hint.textContent = s.hint || 'tap → · esc to exit';
    animateCounts(stage);
    clearTimeout(wrappedTimer);
    if (idx < slides.length - 1) wrappedTimer = setTimeout(() => show(idx + 1), s.dur);
  }

  function onKey(e) {
    if (e.key === 'Escape') closeWrapped();
    else if (e.key === 'ArrowRight' || e.key === ' ') show(idx + 1);
    else if (e.key === 'ArrowLeft') show(idx - 1);
  }
  root.addEventListener('click', (e) => {
    if (e.target.closest('.w-close')) return closeWrapped();
    show(e.clientX < innerWidth / 3 ? idx - 1 : idx + 1);
  });
  document.addEventListener('keydown', onKey);
  root._cleanup = () => document.removeEventListener('keydown', onKey);
  show(0);
}

function closeWrapped() {
  clearTimeout(wrappedTimer);
  const el = $('#wrapped');
  if (el) { el._cleanup?.(); el.remove(); }
}

function animateCounts(scope) {
  for (const el of scope.querySelectorAll('.cnt')) {
    const target = Number(el.dataset.v);
    const fmt = el.dataset.f === 'int' ? fmtInt : fmtNum;
    if (REDUCED || target === 0) { el.textContent = fmt(target); continue; }
    const t0 = performance.now(), dur = 1400;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(2, -10 * p); // easeOutExpo
      el.textContent = fmt(target * eased);
      if (p < 1 && el.isConnected) requestAnimationFrame(tick);
      else el.textContent = fmt(target);
    };
    requestAnimationFrame(tick);
  }
}

// ── boot ─────────────────────────────────────────────────────────
$('#refresh')?.addEventListener('click', () => loadState(true));
$('#wrapped-btn')?.addEventListener('click', openWrapped);
$('#range-from')?.addEventListener('change', onRangeInputChange);
$('#range-to')?.addEventListener('change', onRangeInputChange);

let resizeT = null;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    if (state.sessions.length && $('#daily-chart')) renderDailyChart();
    if (state.sessions.length && $('#impact-chart')) renderImpactChart();
  }, 160);
});

// Auth-gated boot: check session before loading any data
(async () => {
  const ok = await bootAuth();
  if (!ok) return;

  renderRange();
  await loadState(true, { soft: false });

  let lastLoadTime = Date.now();
  let lastUserActivity = Date.now();
  const POLL_INTERVAL_MS = 300_000; // 5 minutes (prevents Neon DB compute exhaustion)
  const IDLE_TIMEOUT_MS = 300_000;  // 5 minutes of inactivity pauses polling

  const markActive = () => {
    lastUserActivity = Date.now();
  };
  ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach((evt) => {
    window.addEventListener(evt, markActive, { passive: true });
  });

  // Poll only when page is visible AND user has been active recently
  setInterval(() => {
    const isVisible = document.visibilityState === 'visible';
    const isUserActive = (Date.now() - lastUserActivity) < IDLE_TIMEOUT_MS;
    if (isVisible && isUserActive) {
      lastLoadTime = Date.now();
      loadState(false, { soft: false });
    }
  }, POLL_INTERVAL_MS);

  // Refresh immediately on tab focus if data is older than poll interval
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadTime >= POLL_INTERVAL_MS) {
      lastLoadTime = Date.now();
      lastUserActivity = Date.now();
      loadState(false, { soft: false });
    }
  });
})();

