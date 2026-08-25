let users = [];
let unlinkedMembers = [];
let teams = [];
let pricingRules = [];
let defaultPricingRules = [];
let currentTab = 'users';
let editingUser = null;
let editingPricing = null;

// User Table Filters
let userFilterSearch = '';
let userFilterTeam = '';
let userFilterStatus = '';

let currentAdminSession = null;
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
    return `<span class="muted" style="font-size:11.5px;">— none —</span>`;
  }
  let colorClass = 'daemon-badge--current';
  let icon = '🟢';
  let hint = 'Up to date';
  if (latestDaemonVersion && daemonVersion !== latestDaemonVersion) {
    const delta = compareVersionParts(latestDaemonVersion, daemonVersion);
    if (delta >= 2) {
      colorClass = 'daemon-badge--outdated';
      icon = '🔴';
      hint = `Outdated — latest is v${latestDaemonVersion}`;
    } else if (delta === 1) {
      colorClass = 'daemon-badge--behind';
      icon = '🟡';
      hint = `1 version behind — latest is v${latestDaemonVersion}`;
    } else if (delta < 0) {
      colorClass = 'daemon-badge--current';
      icon = '🟢';
      hint = 'Up to date (pre-release)';
    } else {
      colorClass = 'daemon-badge--outdated';
      icon = '🔴';
      hint = `Outdated — latest is v${latestDaemonVersion}`;
    }
  }
  const seenStr = lastSeenAt ? `Last seen: ${typeof fmtDate === 'function' ? fmtDate(lastSeenAt) : new Date(lastSeenAt).toLocaleDateString()}` : 'Never synced';
  return `<span class="source-tag daemon-badge ${colorClass}" title="${hint} | ${seenStr}">${icon} v${esc(daemonVersion)}</span>`;
}

// Helpers
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function loadSession() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = '/';
    return;
  }
  const session = await res.json();
  if (session.role !== 'superadmin') {
    window.location.href = '/';
    return;
  }
  currentAdminSession = session;
  const userEl = $('#admin-user-name');
  if (userEl) userEl.textContent = session.displayName || session.username;

  setupAdminProfileHandlers();

  const boot = $('#boot-loading');
  if (boot) boot.hidden = true;
  $('#admin-app').hidden = false;
}

function setupAdminProfileHandlers() {
  const dialog = $('#admin-profile-dialog');
  if (!dialog || dialog._initialized) return;
  dialog._initialized = true;

  $('#admin-profile-btn')?.addEventListener('click', () => {
    if (!dialog) return;
    const usernameEl = $('#admin-profile-username-val');
    if (usernameEl) usernameEl.textContent = currentAdminSession?.username || 'admin';

    const nameInput = $('#admin-profile-display-name');
    if (nameInput) nameInput.value = currentAdminSession?.displayName || currentAdminSession?.username || '';

    const curPwd = $('#admin-profile-current-password');
    if (curPwd) curPwd.value = '';
    const newPwd = $('#admin-profile-new-password');
    if (newPwd) newPwd.value = '';
    const confPwd = $('#admin-profile-confirm-password');
    if (confPwd) confPwd.value = '';

    const errEl = $('#admin-profile-error-msg');
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }

    const isStaticAdmin = !currentAdminSession?.userId?.match?.(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    // BUG-09 fix: superadmin uses a static userId ('superadmin'), not a UUID.
    // Profile changes are unsupported for static sessions — show a clear notice.
    const profileNote = $('#admin-profile-static-note');
    if (profileNote) profileNote.hidden = !isStaticAdmin;
    const profileInputs = dialog.querySelectorAll('input, button[type="submit"]');
    if (isStaticAdmin) {
      profileInputs.forEach(el => { el.disabled = true; });
    } else {
      profileInputs.forEach(el => { el.disabled = false; });
    }

    dialog.showModal();
  });

  $('#cancel-admin-profile-btn')?.addEventListener('click', () => {
    dialog.close();
  });

  $('#admin-profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#admin-profile-error-msg');
    const submitBtn = $('#save-admin-profile-btn');
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }

    const displayName = ($('#admin-profile-display-name')?.value || '').trim();
    const currentPassword = $('#admin-profile-current-password')?.value || '';
    const newPassword = $('#admin-profile-new-password')?.value || '';
    const confirmPassword = $('#admin-profile-confirm-password')?.value || '';

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

      if (currentAdminSession) {
        currentAdminSession.displayName = displayName;
      }
      const userEl = $('#admin-user-name');
      if (userEl) userEl.textContent = displayName;

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

async function loadData() {
  if (typeof window.setDataLoading === 'function') {
    window.setDataLoading(true, 'Loading accounts…');
  }
  try {
    // Fetch users and releases in parallel so latestDaemonVersion is ready for badge rendering
    const [usersRes, relRes] = await Promise.allSettled([
      fetch('/api/admin/users'),
      fetch('/api/internal/releases')
    ]);

    if (relRes.status === 'fulfilled' && relRes.value.ok) {
      try {
        const relData = await relRes.value.json();
        releasesData = relData.releases || [];
        const active = releasesData.find((r) => r.active);
        latestDaemonVersion = active ? active.version : null;
        const latestEl = $('#daemon-latest-version-badge');
        if (latestEl) {
          latestEl.textContent = active ? `Latest: v${active.version}` : 'No active release';
        }
      } catch (_) {}
    }

    if (usersRes.status !== 'fulfilled' || !usersRes.value.ok) {
      throw new Error('Failed to load user list');
    }
    const data = await usersRes.value.json();
    
    if (data.needsMigration) {
      const btn = $('#migrate-btn');
      if (btn) btn.hidden = false;
      const tbody = $('#users-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="error admin-empty">Users table does not exist. Run database migration to initialize it.</td></tr>`;
      return;
    } else {
      const btn = $('#migrate-btn');
      if (btn) btn.hidden = true;
    }

    users = data.users || [];
    unlinkedMembers = data.unlinkedMembers || [];
    teams = data.teams || [];
    renderUsers();
    renderMembers();
    renderTeams();
    populateMemberDropdown();
    populateTeamDropdown();
    populateMemberFormTeamDropdown();
    await loadPricing();
  } catch (err) {
    window.showToast(err.message, { type: 'error' });
  } finally {
    if (typeof window.setDataLoading === 'function') {
      window.setDataLoading(false);
    }
  }
}

function populateTeamDropdown() {
  const select = $('#uf-team');
  if (select) {
    select.innerHTML = `
      <option value="">— none —</option>
      <option value="new">— create new team —</option>
    `;
    teams.forEach(t => {
      select.innerHTML += `<option value="${t.id}">${esc(t.name)}</option>`;
    });
  }

  const filterTeam = $('#filter-team-select');
  if (filterTeam) {
    filterTeam.innerHTML = `<option value="">All Teams</option>`;
    teams.forEach(t => {
      filterTeam.innerHTML += `<option value="${t.id}">${esc(t.name)}</option>`;
    });
  }

  // Populate multi-team checkboxes for user form
  const ufBoxes = $('#uf-teams-checkboxes');
  if (ufBoxes) {
    if (!teams.length) {
      ufBoxes.innerHTML = '<span class="muted">No teams created yet.</span>';
    } else {
      ufBoxes.innerHTML = teams.map(t => `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
          <input type="checkbox" name="uf-team-cb" value="${t.id}" />
          <span>🛡️ ${esc(t.name)}</span>
        </label>
      `).join('');
    }
  }

  // Populate multi-team checkboxes for member form
  const mfBoxes = $('#mf-teams-checkboxes');
  if (mfBoxes) {
    if (!teams.length) {
      mfBoxes.innerHTML = '<span class="muted">No teams created yet.</span>';
    } else {
      mfBoxes.innerHTML = teams.map(t => `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
          <input type="checkbox" name="mf-team-cb" value="${t.id}" />
          <span>🛡️ ${esc(t.name)}</span>
        </label>
      `).join('');
    }
  }
}

function populateMemberFormTeamDropdown() {
  populateTeamDropdown();
}

function renderUsers() {
  const tbody = $('#users-tbody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted admin-empty">No users yet. Create one to get started.</td></tr>`;
    return;
  }

  let filteredUsers = users;

  if (userFilterSearch) {
    const term = userFilterSearch.toLowerCase();
    filteredUsers = filteredUsers.filter(u => 
      (u.username && u.username.toLowerCase().includes(term)) || 
      (u.display_name && u.display_name.toLowerCase().includes(term))
    );
  }

  if (userFilterTeam) {
    filteredUsers = filteredUsers.filter(u => {
      if (u.teams && u.teams.length > 0) {
        return u.teams.some(t => t.id === userFilterTeam);
      }
      return false;
    });
  }

  if (userFilterStatus) {
    filteredUsers = filteredUsers.filter(u => {
      const isActive = u.active ? 'active' : 'inactive';
      return isActive === userFilterStatus;
    });
  }

  if (!filteredUsers.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted admin-empty">No users match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredUsers.map(u => {
    const daemonVersion = renderDaemonVersionBadge(u.daemon_version, u.daemon_last_seen_at);
    const status = u.active ? '<span class="status-badge active-badge">Active</span>' : '<span class="status-badge inactive-badge">Inactive</span>';
    const sessionCount = u.session_count || 0;
    
    const teamBadges = (u.teams && u.teams.length > 0)
      ? `<div style="display:flex; flex-wrap:wrap; gap:4px;">` + u.teams.map(t => `<span class="team-badge" style="background:rgba(255,255,255,0.08); padding:2px 6px; border-radius:4px; font-size:11px;">🛡️ ${esc(t.name)}</span>`).join('') + `</div>`
      : (u.team_name && u.team_name !== '—' ? `<span class="team-badge" style="background:rgba(255,255,255,0.08); padding:2px 6px; border-radius:4px; font-size:11px;">🛡️ ${esc(u.team_name)}</span>` : '<span class="muted">—</span>');

    // Don't show "Login as" for the current superadmin's own account
    const isSelf = currentAdminSession && (currentAdminSession.userId === u.id || currentAdminSession.username === u.username);

    return `
      <tr>
        <td>
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 32px; height: 32px; border-radius: 50%; background: var(--surface-2, rgba(255,255,255,0.05)); display: flex; align-items: center; justify-content: center; font-weight: 600; color: var(--brand); flex-shrink: 0; font-size: 13px;">
              ${esc((u.display_name || u.username)[0].toUpperCase())}
            </div>
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <strong style="color: var(--ink); font-size: 14px;">${esc(u.display_name || u.username)}</strong>
                <code class="role-badge" style="font-size: 10px; padding: 2px 6px;">${esc(u.role)}</code>
              </div>
              <span class="muted" style="font-size: 12px;">@${esc(u.username)}</span>
            </div>
          </div>
        </td>
        <td>${teamBadges}</td>
        <td>${sessionCount} sessions</td>
        <td>${daemonVersion}</td>
        <td>${status}</td>
        <td>
          <div class="actions-cell">
            ${isSelf ? '' : `<button class="hbtn small-btn impersonate-btn" data-id="${u.id}" data-username="${esc(u.username)}" data-displayname="${esc(u.display_name)}" data-role="${esc(u.role)}" title="Login as User" style="padding: 4px 6px; font-size: 14px;">👁️</button>`}
            <button class="hbtn small-btn edit-btn" data-id="${u.id}" title="Edit User" style="padding: 4px 6px; font-size: 14px;">✏️</button>
            <button class="hbtn small-btn reset-btn" data-id="${u.id}" data-username="${esc(u.username)}" title="Reset Password" style="padding: 4px 6px; font-size: 14px;">🔑</button>
            <button class="hbtn small-btn danger-btn delete-btn" data-id="${u.id}" data-username="${esc(u.username)}" title="Delete User" style="padding: 4px 6px; font-size: 14px;">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Wire action buttons
  tbody.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', () => editUser(b.dataset.id)));
  tbody.querySelectorAll('.reset-btn').forEach(b => b.addEventListener('click', () => resetPassword(b.dataset.id, b.dataset.username)));
  tbody.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', () => deleteUser(b.dataset.id, b.dataset.username)));

  // Wire impersonate buttons
  tbody.querySelectorAll('.impersonate-btn').forEach(b => {
    b.addEventListener('click', () => impersonateUser(b.dataset.id, b.dataset.username, b.dataset.displayname, b.dataset.role));
  });
}

function renderMembers() {
  const tbody = $('#members-tbody');
  if (!tbody) return;
  if (!unlinkedMembers.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted admin-empty">All members are linked to user accounts.</td></tr>`;
    return;
  }

  tbody.innerHTML = unlinkedMembers.map(m => {
    const teamBadges = (m.teams && m.teams.length > 0)
      ? `<div style="display:flex; flex-wrap:wrap; gap:4px;">` + m.teams.map(t => `<span class="team-badge" style="background:rgba(255,255,255,0.08); padding:2px 6px; border-radius:4px; font-size:11px;">🛡️ ${esc(t.name)}</span>`).join('') + `</div>`
      : `<span class="team-badge" style="background:rgba(255,255,255,0.08); padding:2px 6px; border-radius:4px; font-size:11px;">🛡️ ${esc(m.team_name || 'Independent')}</span>`;

    return `
      <tr>
        <td><strong>${esc(m.display_name)}</strong></td>
        <td>${teamBadges}</td>
        <td><span class="muted">Needs User Account</span></td>
        <td>
          <div class="actions-cell">
            <button class="hbtn small-btn edit-member-btn" data-id="${m.id}">Edit</button>
            <button class="hbtn small-btn danger-btn delete-member-btn" data-id="${m.id}" data-name="${esc(m.display_name)}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.edit-member-btn').forEach(b => b.addEventListener('click', () => editMember(b.dataset.id)));
  tbody.querySelectorAll('.delete-member-btn').forEach(b => b.addEventListener('click', () => deleteMember(b.dataset.id, b.dataset.name)));
}

function renderTeams() {
  const tbody = $('#teams-tbody');
  if (!tbody) return;
  if (!teams.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted admin-empty">No teams found.</td></tr>`;
    return;
  }

  tbody.innerHTML = teams.map(t => {
    const memberCount = t.member_count || 0;
    return `
      <tr>
        <td><strong>${esc(t.name)}</strong></td>
        <td>${memberCount} member(s)</td>
        <td>
          <div class="actions-cell">
            <button class="hbtn small-btn edit-team-btn" data-id="${t.id}">Edit</button>
            <button class="hbtn small-btn danger-btn delete-team-btn" data-id="${t.id}" data-name="${esc(t.name)}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.edit-team-btn').forEach(b => b.addEventListener('click', () => editTeam(b.dataset.id)));
  tbody.querySelectorAll('.delete-team-btn').forEach(b => b.addEventListener('click', () => deleteTeam(b.dataset.id, b.dataset.name)));
}

function populateMemberDropdown() {
  const select = $('#uf-member');
  if (!select) return;
  
  select.innerHTML = `
    <option value="">— none —</option>
    <option value="new">— create new independent member —</option>
  `;
  
  unlinkedMembers.forEach(m => {
    select.innerHTML += `<option value="${m.id}">${esc(m.display_name)} (${esc(m.team_name)})</option>`;
  });
}

function editUser(id) {
  const user = users.find(u => u.id === id);
  if (!user) return;
  
  editingUser = user;
  $('#uf-id').value = user.id;
  $('#uf-username').value = user.username;
  $('#uf-username').disabled = false;
  $('#uf-displayname').value = user.display_name;
  $('#uf-role').value = user.role;
  $('#uf-password').placeholder = 'Leave blank to keep current password';
  
  // Show team dropdown only for admins
  if (user.role === 'admin') {
    $('#field-uf-team').hidden = false;
    $('#uf-team').value = user.team_id || '';
  } else {
    $('#field-uf-team').hidden = true;
    $('#uf-team').value = '';
  }
  $('#field-uf-new-team').hidden = true;
  $('#uf-new-team').value = '';

  // Select team checkboxes corresponding to user's teams
  const userTeamIds = (user.teams || []).map(t => t.id);
  document.querySelectorAll('input[name="uf-team-cb"]').forEach(cb => {
    cb.checked = userTeamIds.includes(cb.value) || (user.team_id && user.team_id === cb.value);
  });

  // Temporarily add their own linked member to dropdown option list if they have one
  const select = $('#uf-member');
  select.innerHTML = `
    <option value="">— none —</option>
    <option value="new">— create new independent member —</option>
  `;
  if (user.member_id) {
    select.innerHTML += `<option value="${user.member_id}" selected>👤 ${esc(user.member_name)}</option>`;
  }
  unlinkedMembers.forEach(m => {
    select.innerHTML += `<option value="${m.id}">${esc(m.display_name)} (${esc(m.team_name)})</option>`;
  });

  $('#uf-member').value = user.member_id || '';
  $('#user-form-title').textContent = 'Edit User';
  $('#user-form-wrap').hidden = false;
  $('#uf-displayname').focus();
}

function cancelForm() {
  editingUser = null;
  $('#uf-id').value = '';
  $('#uf-username').value = '';
  $('#uf-username').disabled = false;
  $('#uf-displayname').value = '';
  $('#uf-password').value = '';
  $('#uf-password').placeholder = 'temporary password';
  $('#uf-role').value = 'user';
  $('#uf-member').value = '';
  $('#uf-team').value = '';
  $('#uf-new-team').value = '';
  $('#field-uf-team').hidden = true;
  $('#field-uf-new-team').hidden = true;
  $('#user-form-wrap').hidden = true;
  $('#uf-error').hidden = true;
  document.querySelectorAll('input[name="uf-team-cb"]').forEach(cb => { cb.checked = false; });
  populateMemberDropdown();
  populateTeamDropdown();
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const errorEl = $('#uf-error');
  errorEl.hidden = true;
  
  const id = $('#uf-id').value;
  const username = $('#uf-username').value.trim().toLowerCase();
  const displayName = $('#uf-displayname').value.trim();
  const password = $('#uf-password').value;
  const role = $('#uf-role').value;
  const memberId = $('#uf-member').value || null;

  if (!displayName || (!id && !username) || (!id && !password)) {
    errorEl.textContent = 'Please fill out all required fields';
    errorEl.hidden = false;
    if (!displayName) $('#uf-displayname')?.classList.add('invalid-field');
    if (!id && !username) $('#uf-username')?.classList.add('invalid-field');
    if (!id && !password) $('#uf-password')?.classList.add('invalid-field');
    return;
  }

  // Username validation
  if (username) {
    if (username.length < 2) {
      errorEl.textContent = 'Username must be at least 2 characters long';
      errorEl.hidden = false;
      $('#uf-username')?.classList.add('invalid-field');
      return;
    }
    if (!/^[a-z0-9_.-]+$/.test(username)) {
      errorEl.textContent = 'Username can only contain letters, numbers, dots, hyphens, and underscores';
      errorEl.hidden = false;
      $('#uf-username')?.classList.add('invalid-field');
      return;
    }
  }

  const teamVal = $('#uf-team').value;
  let teamId = null;
  let newTeamName = null;

  if (role === 'admin') {
    if (teamVal === 'new') {
      newTeamName = $('#uf-new-team').value.trim();
      if (!newTeamName) {
        errorEl.textContent = 'Please enter a name for the new team';
        errorEl.hidden = false;
        return;
      }
    } else if (teamVal) {
      teamId = teamVal;
    } else {
      errorEl.textContent = 'Please select or create a team for the admin account';
      errorEl.hidden = false;
      return;
    }
  }

  // Collect selected teamIds from checkboxes
  const selectedTeamIds = Array.from(document.querySelectorAll('input[name="uf-team-cb"]:checked')).map(cb => cb.value);

  const payload = { displayName, role, memberId, teamId, newTeamName, teamIds: selectedTeamIds };
  if (!id) {
    payload.username = username;
    payload.password = password;
  } else {
    if (username) payload.username = username;
    if (password) payload.password = password;
  }

  const url = '/api/admin/users';
  const method = id ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id, ...payload } : payload)
    });
    
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409) {
        $('#uf-username')?.classList.add('invalid-field');
      }
      throw new Error(data.error || 'Request failed');
    }

    if (data.apiKey) {
      // Show the generated sync command details
      const banner = $('#new-password-banner');
      const val = $('#new-password-value');
      if (banner && val) {
        let msg = `<b>User:</b> ${username || data.user.username}<br>`;
        if (password) {
          msg += `<b>Temp Password:</b> ${password}<br>`;
        }
        msg += `<b>API Key:</b> <code>${data.apiKey}</code><br><br>`;
        if (data.installCommandMac) {
          msg += `<b>🍎 Mac Command:</b><br><pre style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 12px; margin: 4px 0 12px 0; user-select: all;">${data.installCommandMac}</pre>`;
        }
        if (data.installCommandWin) {
          msg += `<b>🪟 Windows Command:</b><br><pre style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 12px; margin: 4px 0 12px 0; user-select: all;">${data.installCommandWin}</pre>`;
        }
      // BUG-11/17 fix: store just the API key in a data attribute so the copy
        // button can read it cleanly without HTML content.
        val.dataset.apiKey = data.apiKey || '';
        val.innerHTML = msg;
        banner.hidden = false;
      }
    } else {
      window.showToast(id ? `User "${displayName}" updated.` : `User "${displayName}" created.`, { type: 'success' });
    }

    cancelForm();
    await loadData();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
}

async function resetPassword(id, username) {
  if (!confirm(`Are you sure you want to reset the password for "${username}"?`)) return;
  
  try {
    const res = await fetch('/api/admin/users/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Password reset failed');

    const banner = $('#new-password-banner');
    const val = $('#new-password-value');
    if (banner && val) {
      val.textContent = `Temporary password for ${username}: ${data.newPassword}`;
      banner.hidden = false;
    }
    window.showToast(`Password reset for "${username}".`, { type: 'success' });
  } catch (err) {
    window.showToast(err.message, { type: 'error' });
  }
}

async function impersonateUser(userId, username, displayName, role) {
  const dialog = document.getElementById('impersonate-dialog');
  const targetNameEl = document.getElementById('impersonate-target-name');
  const targetRoleEl = document.getElementById('impersonate-target-role');
  const cancelBtn = document.getElementById('impersonate-cancel-btn');
  const confirmBtn = document.getElementById('impersonate-confirm-btn');
  const errorMsg = document.getElementById('impersonate-error-msg');
  
  if (!dialog || !targetNameEl || !targetRoleEl || !cancelBtn || !confirmBtn) {
    // Fallback if dialog is missing
    if (!confirm(`Login as ${displayName || username} (${role})?\n\nYou will see their exact dashboard. You can return to your superadmin account at any time.`)) return;
    performImpersonation(userId);
    return;
  }
  
  targetNameEl.textContent = displayName || username;
  targetRoleEl.textContent = role;
  errorMsg.hidden = true;
  confirmBtn.textContent = 'Login as User';
  confirmBtn.disabled = false;
  
  dialog.showModal();
  
  // Clean up any old listeners
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
  const newConfirm = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
  
  newCancel.addEventListener('click', () => dialog.close());
  
  newConfirm.addEventListener('click', async (e) => {
    e.preventDefault();
    newConfirm.disabled = true;
    newConfirm.textContent = 'Authenticating...';
    errorMsg.hidden = true;
    
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to impersonate user');
      
      window.location.href = data.redirect || '/';
    } catch (err) {
      errorMsg.textContent = err.message;
      errorMsg.hidden = false;
      newConfirm.disabled = false;
      newConfirm.textContent = 'Login as User';
    }
  });
}

async function performImpersonation(userId) {
  try {
    const res = await fetch('/api/admin/impersonate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to impersonate user');
    
    window.location.href = data.redirect || '/';
  } catch (err) {
    window.showToast(err.message, { type: 'error' });
  }
}

async function deleteUser(id, username) {
  if (!confirm(`Are you sure you want to permanently delete user "${username}"?`)) return;
  
  try {
    const res = await fetch(`/api/admin/users?id=${id}`, {
      method: 'DELETE'
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    
    await loadData();
    window.showToast(`User "${username}" deleted.`, { type: 'success' });
  } catch (err) {
    window.showToast(err.message, { type: 'error' });
  }
}

// Members CRUD
function editMember(id) {
  const member = unlinkedMembers.find(m => m.id === id);
  if (!member) return;

  cancelMemberForm();
  $('#mf-id').value = member.id;
  $('#mf-displayname').value = member.display_name;
  
  const memberTeamIds = (member.teams || []).map(t => t.id);
  document.querySelectorAll('input[name="mf-team-cb"]').forEach(cb => {
    cb.checked = memberTeamIds.includes(cb.value) || (member.team_id && member.team_id === cb.value);
  });

  $('#member-form-title').textContent = 'Edit Member';
  $('#member-form-wrap').hidden = false;
  $('#mf-displayname').focus();
}

function cancelMemberForm() {
  $('#mf-id').value = '';
  $('#mf-displayname').value = '';
  document.querySelectorAll('input[name="mf-team-cb"]').forEach(cb => { cb.checked = false; });
  $('#member-form-wrap').hidden = true;
  $('#mf-error').hidden = true;
}

async function handleMemberFormSubmit(e) {
  e.preventDefault();
  const errorEl = $('#mf-error');
  errorEl.hidden = true;

  const id = $('#mf-id').value;
  const displayName = $('#mf-displayname').value.trim();
  const selectedTeamIds = Array.from(document.querySelectorAll('input[name="mf-team-cb"]:checked')).map(cb => cb.value);

  if (!displayName) {
    errorEl.textContent = 'Display name is required';
    errorEl.hidden = false;
    $('#mf-displayname')?.classList.add('invalid-field');
    return;
  }

  const method = id ? 'PUT' : 'POST';

  try {
    const res = await fetch('/api/admin/members', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id, displayName, teamIds: selectedTeamIds } : { displayName, teamIds: selectedTeamIds })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    if (!id && data.apiKey) {
      const banner = $('#new-password-banner');
      const val = $('#new-password-value');
      if (banner && val) {
        let msg = `<b>Member:</b> ${displayName}<br>`;
        msg += `<b>API Key:</b> <code>${data.apiKey}</code><br><br>`;
        const serverUrl = window.location.origin;
        const macCmd = `curl -fsSL ${serverUrl}/install.sh | bash -s -- --key ${data.apiKey}`;
        const winCmd = `$ApiKey="${data.apiKey}"; iex (irm ${serverUrl}/install.ps1)`;
        msg += `<b>🍎 Mac Command:</b><br><pre style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 12px; margin: 4px 0 12px 0; user-select: all;">${macCmd}</pre>`;
        msg += `<b>🪟 Windows Command:</b><br><pre style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 12px; margin: 4px 0 12px 0; user-select: all;">${winCmd}</pre>`;
        val.innerHTML = msg;
        banner.hidden = false;
      }
    } else {
      window.showToast(id ? `Member "${displayName}" updated.` : `Member "${displayName}" created.`, { type: 'success' });
    }

    cancelMemberForm();
    await loadData();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
}

async function deleteMember(id, name) {
  if (!confirm(`Are you sure you want to permanently delete member "${name}"?\nThis will cascade delete any associated API keys and session logs.`)) return;

  try {
    const res = await fetch(`/api/admin/members?id=${id}`, {
      method: 'DELETE'
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');

    await loadData();
    window.showToast(`Member "${name}" deleted.`, { type: 'success' });
  } catch (err) {
    window.showToast(err.message, { type: 'error' });
  }
}

// Teams CRUD
function editTeam(id) {
  const team = teams.find(t => t.id === id);
  if (!team) return;

  cancelTeamForm();
  $('#tf-id').value = team.id;
  $('#tf-name').value = team.name;
  $('#team-form-title').textContent = 'Edit Team';
  $('#team-form-wrap').hidden = false;
  $('#tf-name').focus();
}

function cancelTeamForm() {
  $('#tf-id').value = '';
  $('#tf-name').value = '';
  $('#team-form-wrap').hidden = true;
  $('#tf-error').hidden = true;
}

async function handleTeamFormSubmit(e) {
  e.preventDefault();
  const errorEl = $('#tf-error');
  errorEl.hidden = true;

  const id = $('#tf-id').value;
  const name = $('#tf-name').value.trim();

  if (!name) {
    errorEl.textContent = 'Team name is required';
    errorEl.hidden = false;
    $('#tf-name')?.classList.add('invalid-field');
    return;
  }

  const method = id ? 'PUT' : 'POST';

  try {
    const res = await fetch('/api/admin/teams', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id, name } : { name })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    window.showToast(id ? `Team "${name}" updated.` : `Team "${name}" created.`, { type: 'success' });
    cancelTeamForm();
    await loadData();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
}

async function deleteTeam(id, name) {
  if (!confirm(`Are you sure you want to permanently delete team "${name}"?\nThis will cascade delete any associated members/sessions linked only to this team.`)) return;

  try {
    const res = await fetch(`/api/admin/teams?id=${id}`, {
      method: 'DELETE'
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');

    await loadData();
    window.showToast(`Team "${name}" deleted.`, { type: 'success' });
  } catch (err) {
    window.showToast(err.message, { type: 'error' });
  }
}

function setupInputEventListeners() {
  const inputs = [
    { id: '#uf-username', errorId: '#uf-error' },
    { id: '#uf-displayname', errorId: '#uf-error' },
    { id: '#uf-password', errorId: '#uf-error' },
    { id: '#mf-displayname', errorId: '#mf-error' },
    { id: '#tf-name', errorId: '#tf-error' },
    { id: '#pf-pattern', errorId: '#pf-error' },
    { id: '#pf-cost-in', errorId: '#pf-error' },
    { id: '#pf-cost-out', errorId: '#pf-error' },
    { id: '#pf-cost-cache', errorId: '#pf-error' }
  ];

  inputs.forEach(({ id, errorId }) => {
    $(id)?.addEventListener('input', () => {
      $(id).classList.remove('invalid-field');
      const err = $(errorId);
      if (err) err.hidden = true;
    });
  });
}

// Model Pricing & Global Sync
async function loadPricing() {
  try {
    const res = await fetch('/api/admin/pricing');
    if (!res.ok) throw new Error('Failed to load model pricing');
    const data = await res.json();
    pricingRules = data.pricing || [];
    defaultPricingRules = data.defaultRules || [];
    renderPricing();
    populatePricingTeamDropdown();
  } catch (err) {
    console.error('[loadPricing error]', err);
  }
}

function populatePricingTeamDropdown() {
  const select = $('#pf-team');
  if (!select) return;
  const currentVal = select.value || 'global';
  select.innerHTML = `<option value="global">🌐 Global (Applies to all teams &amp; members)</option>`;
  teams.forEach(t => {
    select.innerHTML += `<option value="${t.id}">🛡️ ${esc(t.name)} (Team Override)</option>`;
  });
  select.value = currentVal;
}

function renderPricing() {
  const tbody = $('#pricing-tbody');
  const countBadge = $('#pricing-count-badge');
  if (countBadge) {
    countBadge.textContent = `${pricingRules.length} rule${pricingRules.length === 1 ? '' : 's'}`;
  }

  if (tbody) {
    if (!pricingRules.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted admin-empty">No custom pricing rules defined yet. System uses baseline reference rates below.</td></tr>`;
    } else {
      tbody.innerHTML = pricingRules.map(r => {
        const isGlobal = !r.team_id;
        const scopeBadge = isGlobal
          ? `<span class="scope-badge-global">🌐 Global</span>`
          : `<span class="scope-badge-team">🛡️ ${esc(r.team_name || 'Team Override')}</span>`;

        return `
          <tr>
            <td><strong><code>${esc(r.model_pattern)}</code></strong></td>
            <td>${scopeBadge}</td>
            <td>$${Number(r.cost_in_per_m).toFixed(4)}</td>
            <td>$${Number(r.cost_out_per_m).toFixed(4)}</td>
            <td>$${Number(r.cost_cache_read_per_m).toFixed(4)}</td>
            <td>
              <div class="actions-cell">
                <button class="hbtn small-btn edit-pricing-btn" data-id="${r.id}">Edit</button>
                <button class="hbtn small-btn danger-btn delete-pricing-btn" data-id="${r.id}" data-pattern="${esc(r.model_pattern)}">Delete</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      tbody.querySelectorAll('.edit-pricing-btn').forEach(b => b.addEventListener('click', () => editPricing(b.dataset.id)));
      tbody.querySelectorAll('.delete-pricing-btn').forEach(b => b.addEventListener('click', () => deletePricing(b.dataset.id, b.dataset.pattern)));
    }
  }

  const defTbody = $('#default-pricing-tbody');
  if (defTbody && defaultPricingRules.length) {
    defTbody.innerHTML = defaultPricingRules.map(d => {
      return `
        <tr>
          <td><strong>${esc(d.label || d.model_pattern)}</strong> ${d.model_pattern ? `<code style="font-size:11px; margin-left:6px; opacity:0.75;">${esc(d.model_pattern)}</code>` : '<span class="muted" style="font-size:11px; margin-left:6px;">(Default Fallback)</span>'}</td>
          <td>$${Number(d.cost_in_per_m).toFixed(2)}</td>
          <td>$${Number(d.cost_out_per_m).toFixed(2)}</td>
          <td>$${Number(d.cost_cache_read_per_m).toFixed(2)}</td>
          <td>
            <button class="hbtn small-btn quick-override-btn" data-pattern="${esc(d.model_pattern)}" data-in="${d.cost_in_per_m}" data-out="${d.cost_out_per_m}" data-cache="${d.cost_cache_read_per_m}">Customize</button>
          </td>
        </tr>
      `;
    }).join('');

    defTbody.querySelectorAll('.quick-override-btn').forEach(b => {
      b.addEventListener('click', () => {
        cancelPricingForm();
        $('#pf-pattern').value = b.dataset.pattern;
        $('#pf-cost-in').value = b.dataset.in;
        $('#pf-cost-out').value = b.dataset.out;
        $('#pf-cost-cache').value = b.dataset.cache;
        $('#pricing-form-title').textContent = `Add Override for ${b.dataset.pattern || 'Fallback'}`;
        $('#pricing-form-wrap').hidden = false;
        $('#pf-team').focus();
      });
    });
  }
}

function editPricing(id) {
  const rule = pricingRules.find(r => r.id === id);
  if (!rule) return;

  editingPricing = rule;
  $('#pf-id').value = rule.id;
  $('#pf-team').value = rule.team_id || 'global';
  $('#pf-pattern').value = rule.model_pattern;
  $('#pf-cost-in').value = rule.cost_in_per_m;
  $('#pf-cost-out').value = rule.cost_out_per_m;
  $('#pf-cost-cache').value = rule.cost_cache_read_per_m;
  $('#pricing-form-title').textContent = `Edit Pricing Rule (${rule.model_pattern})`;
  $('#pricing-form-wrap').hidden = false;
  $('#pf-pattern').focus();
}

function cancelPricingForm() {
  editingPricing = null;
  $('#pf-id').value = '';
  $('#pf-team').value = 'global';
  $('#pf-pattern').value = '';
  $('#pf-cost-in').value = '';
  $('#pf-cost-out').value = '';
  $('#pf-cost-cache').value = '';
  $('#pricing-form-wrap').hidden = true;
  $('#pf-error').hidden = true;
}

async function handlePricingFormSubmit(e) {
  e.preventDefault();
  const errorEl = $('#pf-error');
  errorEl.hidden = true;

  const id = $('#pf-id').value;
  const teamId = $('#pf-team').value;
  const modelPattern = $('#pf-pattern').value.trim();
  const costInPerM = $('#pf-cost-in').value;
  const costOutPerM = $('#pf-cost-out').value;
  const costCacheReadPerM = $('#pf-cost-cache').value;

  if (!modelPattern) {
    errorEl.textContent = 'Model pattern or identifier is required';
    errorEl.hidden = false;
    return;
  }

  const submitBtn = $('#pf-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving & Recalculating…';

  try {
    const res = await fetch('/api/admin/pricing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: id || undefined,
        teamId: teamId === 'global' ? null : teamId,
        modelPattern,
        costInPerM: parseFloat(costInPerM) || 0,
        costOutPerM: parseFloat(costOutPerM) || 0,
        costCacheReadPerM: parseFloat(costCacheReadPerM) || 0,
        syncRecalc: true,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save pricing rule');

    window.showToast(`Pricing rule for "${modelPattern}" saved and session costs recalculated.`, { type: 'success' });
    cancelPricingForm();
    await loadPricing();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Pricing Rule';
  }
}

async function deletePricing(id, pattern) {
  if (!confirm(`Are you sure you want to delete the pricing rule for "${pattern}"?\nSession costs will be recalculated using remaining rules.`)) return;

  try {
    const res = await fetch(`/api/admin/pricing?id=${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete pricing rule');

    window.showToast(`Pricing rule for "${pattern}" deleted and costs recalculated.`, { type: 'success' });
    await loadPricing();
  } catch (err) {
    window.showToast(err.message, { type: 'error' });
  }
}

async function syncAllTeamsAndMembers() {
  const btn = $('#sync-all-btn');
  if (!btn) return;
  const icon = btn.querySelector('.sync-icon');
  
  if (!confirm('Broadcast sync to all developer machines and recalculate historical token costs across all teams and members?')) {
    return;
  }

  btn.disabled = true;
  if (icon) icon.classList.add('spinning');
  btn.innerHTML = `<span class="sync-icon spinning">🔄</span> Syncing & Recalculating…`;

  try {
    const res = await fetch('/api/admin/pricing/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync request failed');

    window.showToast(data.message || 'All teams & members synced successfully!', { type: 'success', duration: 6000 });
    await loadData();
  } catch (err) {
    window.showToast(err.message, { type: 'error' });
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span class="sync-icon">🔄</span> Sync for All Teams &amp; Members`;
  }
}

// Tabs
function switchTab(tabId) {
  currentTab = tabId;
  // BUG-10 fix: select both button and <a> nav items so all get the active state.
  document.querySelectorAll('.admin-sidebar-nav button, .admin-sidebar-nav a').forEach(b => {
    const active = b.dataset.tab === tabId;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
    b.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.hidden = t.id !== tabId;
  });
  closeMobileNav();
}

/** Hamburger toggle for the off-canvas sidebar on narrow (mobile) viewports. */
function setupMobileNav() {
  const layout = $('#admin-app');
  const toggle = $('#admin-nav-toggle');
  const overlay = $('#admin-nav-overlay');
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
  const layout = $('#admin-app');
  const toggle = $('#admin-nav-toggle');
  if (!layout) return;
  layout.classList.remove('nav-open');
  toggle?.setAttribute('aria-expanded', 'false');
}

// Boot
(async () => {
  await loadSession();
  await loadData();

  // Tab buttons
  document.querySelectorAll('.admin-sidebar-nav button').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  setupMobileNav();

  // Action buttons
  $('#migrate-btn')?.addEventListener('click', async () => {
    const btn = $('#migrate-btn');
    btn.disabled = true;
    btn.textContent = 'Migrating database…';
    try {
      const res = await fetch('/api/admin/migrate', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Migration failed');
      window.showToast('Migration successful — database table initialized.', { type: 'success' });
      btn.hidden = true;
      await loadData();
    } catch (err) {
      window.showToast(err.message, { type: 'error' });
      btn.disabled = false;
      btn.textContent = 'Run database migration';
    }
  });

  $('#create-user-btn')?.addEventListener('click', () => {
    cancelForm();
    $('#user-form-title').textContent = 'Add User';
    $('#user-form-wrap').hidden = false;
    $('#uf-username').focus();
  });
  $('#uf-cancel')?.addEventListener('click', cancelForm);
  $('#user-form')?.addEventListener('submit', handleFormSubmit);

  // Form change toggles
  $('#uf-role')?.addEventListener('change', (e) => {
    const showTeam = e.target.value === 'admin';
    $('#field-uf-team').hidden = !showTeam;
    if (!showTeam) {
      $('#uf-team').value = '';
      $('#field-uf-new-team').hidden = true;
      $('#uf-new-team').value = '';
    }
  });

  $('#uf-team')?.addEventListener('change', (e) => {
    const showNewTeam = e.target.value === 'new';
    $('#field-uf-new-team').hidden = !showNewTeam;
    if (!showNewTeam) {
      $('#uf-new-team').value = '';
    }
  });

  // Member form listeners
  $('#create-member-btn')?.addEventListener('click', () => {
    cancelMemberForm();
    $('#member-form-title').textContent = 'Add Member';
    $('#member-form-wrap').hidden = false;
    $('#mf-displayname').focus();
  });
  $('#mf-cancel')?.addEventListener('click', cancelMemberForm);
  $('#member-form')?.addEventListener('submit', handleMemberFormSubmit);

  setupInputEventListeners();

  // Team form listeners
  $('#create-team-btn')?.addEventListener('click', () => {
    cancelTeamForm();
    $('#team-form-title').textContent = 'Add Team';
    $('#team-form-wrap').hidden = false;
    $('#tf-name').focus();
  });
  $('#tf-cancel')?.addEventListener('click', cancelTeamForm);
  $('#team-form')?.addEventListener('submit', handleTeamFormSubmit);

  // Pricing listeners
  $('#create-pricing-btn')?.addEventListener('click', () => {
    cancelPricingForm();
    $('#pricing-form-title').textContent = 'Add Pricing Rule';
    $('#pricing-form-wrap').hidden = false;
    $('#pf-pattern').focus();
  });
  $('#pf-cancel')?.addEventListener('click', cancelPricingForm);
  $('#pricing-form')?.addEventListener('submit', handlePricingFormSubmit);
  $('#sync-all-btn')?.addEventListener('click', syncAllTeamsAndMembers);

  // Preset quick fill buttons
  document.querySelectorAll('.preset-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      cancelPricingForm();
      $('#pf-pattern').value = btn.dataset.pattern || '';
      $('#pf-cost-in').value = btn.dataset.in || '';
      $('#pf-cost-out').value = btn.dataset.out || '';
      $('#pf-cost-cache').value = btn.dataset.cache || '';
      $('#pricing-form-title').textContent = `Add Rule for ${btn.textContent || btn.dataset.pattern}`;
      $('#pricing-form-wrap').hidden = false;
      $('#pf-team').focus();
    });
  });

  // Logout
  $('#admin-logout-btn')?.addEventListener('click', async () => {
    await fetch('/api/auth/me', { method: 'POST' });
    window.location.href = '/';
  });

  // Password banner close
  $('#new-password-close')?.addEventListener('click', () => {
    $('#new-password-banner').hidden = true;
  });
  $('#new-password-copy')?.addEventListener('click', () => {
    // BUG-11 fix: copy only the raw API key stored in the data attribute,
    // not the entire innerHTML block which includes install commands.
    const val = $('#new-password-value');
    const txt = val?.dataset.apiKey || val?.textContent || '';
    navigator.clipboard.writeText(txt).then(() => {
      $('#new-password-copy').textContent = 'Copied!';
      setTimeout(() => { $('#new-password-copy').textContent = 'Copy'; }, 2000);
    });
  });

  // ── Analytics tab hooks ────────────────────────────────────────────────────
  // Lazy-load analytics data the first time each tab is activated.
  // Re-fetch whenever the range-select changes.
  setupAnalyticsTabs();

  // BUG-16 fix: bind form handlers here in the main IIFE where timing is
  // controlled and the DOM is guaranteed to be ready, rather than via setTimeout.
  bindReleasesForm();
  bindAuditLogFilters();
})();


/* ═══════════════════════════════════════════════════════════
   SUPERADMIN ANALYTICS — client-side logic
   ═══════════════════════════════════════════════════════════ */

// ── Shared SVG helpers ──────────────────────────────────────────────────────

const PALETTE = {
  claude_code: '#f87171',
  cursor:      '#60a5fa',
  codex:       '#a78bfa',
  unknown:     '#94a3b8',
};

function toolColor(tool) {
  return PALETTE[tool] || PALETTE.unknown;
}

function fmtCost(v) {
  const n = Number(v) || 0;
  if (n === 0) return '$0.00';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return s.toFixed(0) + 's';
  const m = s / 60;
  if (m < 60) return m.toFixed(1) + 'm';
  const h = m / 60;
  if (h < 24) return h.toFixed(1) + 'h';
  const d = h / 24;
  return d.toFixed(1) + 'd';
}

/**
 * Generate smooth bezier curve path points
 */
function getBezierPath(points) {
  if (points.length < 2) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpX1 = p0.x + (p1.x - p0.x) / 3;
    const cpY1 = p0.y;
    const cpX2 = p0.x + 2 * (p1.x - p0.x) / 3;
    const cpY2 = p1.y;
    d += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${p1.x} ${p1.y}`;
  }
  return d;
}

/**
 * Draw a smooth line chart on an SVG element.
 */
function drawLineChart(svgEl, series, xLabels, opts = {}) {
  if (!svgEl) return;
  const W = 600, H = opts.height || 160;
  const padL = 42, padR = 12, padT = 12, padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const allVals = series.flatMap(s => s.values).filter(v => v != null);
  const maxV = allVals.length ? Math.max(...allVals, 0) * 1.1 || 1 : 1;
  const n = xLabels.length;

  function px(i) { return padL + (n < 2 ? chartW / 2 : (i / (n - 1)) * chartW); }
  function py(v) { return padT + chartH - (v / maxV) * chartH; }

  const labelFormatter = opts.yFormatter || ((v) => String(v));

  let html = `<g class="grid">`;
  // Horizontal grid lines (4)
  for (let i = 0; i <= 4; i++) {
    const y = padT + (i / 4) * chartH;
    const v = maxV * (1 - i / 4);
    html += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
    html += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.3)" font-family="var(--font-mono)">${labelFormatter(v).replace('$','')}</text>`;
  }
  html += `</g>`;

  // Draw series paths
  series.forEach(s => {
    if (!s.values.length) return;
    const pts = s.values.map((v, i) => ({ x: px(i), y: py(v || 0) }));
    const curvePath = getBezierPath(pts);
    const firstPt = pts[0];
    const lastPt = pts[pts.length - 1];
    const areaPath = `${curvePath} L ${lastPt.x} ${padT + chartH} L ${firstPt.x} ${padT + chartH} Z`;

    html += `<path d="${areaPath}" fill="${s.color}" fill-opacity="0.05"/>`;
    html += `<path d="${curvePath}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    
    // Draw dots at points
    pts.forEach((pt) => {
      html += `<circle cx="${pt.x}" cy="${pt.y}" r="3" fill="var(--surface)" stroke="${s.color}" stroke-width="1.5" />`;
    });
  });

  // X-axis labels
  const step = Math.max(1, Math.floor(n / 6));
  html += `<g>`;
  xLabels.forEach((lbl, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    html += `<text x="${px(i)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.35)">${lbl}</text>`;
  });
  html += `</g>`;

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.innerHTML = html;
}

/**
 * Draw a bar chart on an SVG element.
 */
function drawBarChart(svgEl, bars, opts = {}) {
  if (!svgEl || !bars.length) return;
  const W = 600, H = opts.height || 120;
  const padL = 24, padR = 12, padT = 12, padB = 24;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const maxV = Math.max(...bars.map(b => b.value), 0) * 1.1 || 1;
  const bw = (chartW / bars.length) * 0.6;
  const gap = chartW / bars.length;

  let html = '';
  // Horizontal grid lines
  for (let i = 0; i <= 3; i++) {
    const y = padT + (i / 3) * chartH;
    html += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.03)" stroke-width="1"/>`;
  }

  bars.forEach((b, i) => {
    const bh = (b.value / maxV) * chartH;
    const x = padL + i * gap + (gap - bw) / 2;
    const y = padT + chartH - bh;
    
    html += `
      <g class="bar-group" data-index="${i}">
        <rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="${b.color || '#34d399'}" fill-opacity="0.8" />
      </g>
    `;
  });

  // X-axis labels
  const step = Math.max(1, Math.floor(bars.length / 5));
  bars.forEach((b, i) => {
    if (i % step !== 0 && i !== bars.length - 1) return;
    const x = padL + i * gap + gap / 2;
    html += `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.35)">${fmtDate(b.label)}</text>`;
  });

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.innerHTML = html;
}

// ── Empty state helper ──────────────────────────────────────────────────────
function showEmptyState(el, msg = 'No data yet — rollup runs nightly') {
  if (!el) return;
  el.innerHTML = `
    <div class="analytics-empty-new">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="8" y1="12" x2="16" y2="12"/>
      </svg>
      <span>${esc(msg)}</span>
    </div>`;
}

// ── Interactive Tooltips and Hover Tracking ─────────────────────────────────

function initInteractiveChart(svgEl, series, xLabels, tooltipEl, valueFormatter = (v) => v) {
  if (!svgEl || !xLabels.length) return;

  const W = 600;
  const H = svgEl.viewBox.baseVal.height || 180;
  const padL = 42, padR = 12, padT = 12, padB = 28;
  const chartW = W - padL - padR;

  const points = xLabels.map((_, i) => {
    return padL + (xLabels.length < 2 ? chartW / 2 : (i / (xLabels.length - 1)) * chartW);
  });

  svgEl.style.position = 'relative';

  svgEl.onmousemove = (e) => {
    const rect = svgEl.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    
    let closestIdx = 0;
    let minDiff = Infinity;
    points.forEach((px, idx) => {
      const diff = Math.abs(x - px);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = idx;
      }
    });

    updateInteractiveGroup(svgEl, points[closestIdx], closestIdx, series, H, padT, padB);

    if (tooltipEl) {
      tooltipEl.hidden = false;
      const tooltipX = ((points[closestIdx] / W) * rect.width);
      const alignLeft = tooltipX > rect.width * 0.6;
      tooltipEl.style.left = `${alignLeft ? tooltipX - tooltipEl.offsetWidth - 10 : tooltipX + 15}px`;
      tooltipEl.style.top = `${((H / 2) / H) * rect.height - 20}px`;

      let tooltipHtml = `<div class="tooltip-label">${xLabels[closestIdx]}</div>`;
      series.forEach(s => {
        const val = s.values[closestIdx];
        if (val !== undefined && val !== null) {
          tooltipHtml += `
            <div class="tooltip-row">
              <span class="tooltip-dot" style="background:${s.color}"></span>
              <span style="color:var(--ink-2);margin-right:auto">${s.label}:</span>
              <span class="tooltip-val">${valueFormatter(val, s.label)}</span>
            </div>`;
        }
      });
      tooltipEl.innerHTML = tooltipHtml;
    }
  };

  svgEl.onmouseleave = () => {
    const interactiveG = svgEl.querySelector('#interactive-group');
    if (interactiveG) interactiveG.setAttribute('opacity', '0');
    if (tooltipEl) tooltipEl.hidden = true;
  };
}

function updateInteractiveGroup(svgEl, x, idx, series, H, padT, padB) {
  let interactiveG = svgEl.querySelector('#interactive-group');
  if (!interactiveG) {
    interactiveG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    interactiveG.setAttribute('id', 'interactive-group');
    svgEl.appendChild(interactiveG);
  }
  interactiveG.setAttribute('opacity', '1');

  const maxVal = Math.max(...series.flatMap(s => s.values).filter(v => v != null), 0) * 1.1 || 1;
  const chartH = H - padT - padB;
  function py(v) { return padT + chartH - (v / maxVal) * chartH; }

  let html = `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-dasharray="3,3"/>`;
  
  series.forEach(s => {
    const val = s.values[idx];
    if (val !== undefined && val !== null) {
      const y = py(val);
      html += `
        <circle cx="${x}" cy="${y}" r="5" fill="${s.color}" stroke="var(--surface)" stroke-width="1.5"/>
        <circle cx="${x}" cy="${y}" r="8" fill="${s.color}" opacity="0.25"/>
      `;
    }
  });

  interactiveG.innerHTML = html;
}

// ── Easing counter animations ────────────────────────────────────────────────

function animateValue(el, endVal, duration = 400, formatter = (v) => String(v)) {
  if (!el) return;
  const target = Number(endVal) || 0;
  const start = 0;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const ease = progress * (2 - progress);
    const val = start + (target - start) * ease;
    
    el.textContent = formatter(val);

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      el.textContent = formatter(target);
    }
  }

  requestAnimationFrame(update);
}

// ── Pipeline Health ─────────────────────────────────────────────────────────

let pipelineLoaded = false;

async function loadPipelineHealth(range = '7d') {
  try {
    const res = await fetch(`/api/admin/pipeline-health?range=${range}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderPipelineHealth(data);
  } catch (err) {
    window.showToast?.(`Pipeline health: ${err.message}`, { type: 'error' });
  }
}

function daemonHealthClass(last_heartbeat) {
  if (!last_heartbeat) return 'never';
  const diffMs = Date.now() - new Date(last_heartbeat).getTime();
  const diffHr = diffMs / 3600000;
  if (diffHr < 1)  return 'healthy';
  if (diffHr < 24) return 'stale';
  return 'dead';
}

function renderPipelineHealth(data) {
  const dot = $('#pipeline-health-dot');
  const label = $('#pipeline-health-label');
  
  const daemons = data.daemons || [];
  let status = 'healthy';
  let activeCount = 0;
  let staleCount = 0;
  let deadCount = 0;

  daemons.forEach(d => {
    const s = daemonHealthClass(d.last_heartbeat);
    if (s === 'healthy') activeCount++;
    else if (s === 'stale') staleCount++;
    else if (s === 'dead') deadCount++;
  });

  if (deadCount > 0 || (daemons.length === 0)) {
    status = 'critical';
  } else if (staleCount > 0) {
    status = 'warn';
  }

  if (dot) {
    dot.className = 'health-indicator-dot ' + (status === 'healthy' ? 'dot-healthy' : status === 'warn' ? 'dot-warn' : 'dot-critical');
  }
  if (label) {
    label.textContent = status === 'healthy' ? 'All Systems Operational' : status === 'warn' ? `${staleCount} Daemon(s) Stale` : 'System Issues Detected';
  }

  // Animate KPI values
  animateValue($('#pipeline-active-24h'), data.active_24h ?? 0, 400, (v) => String(Math.floor(v)));
  animateValue($('#pipeline-total-known'), data.total_known ?? 0, 400, (v) => String(Math.floor(v)));
  animateValue($('#pipeline-table-count'), data.schema?.table_count ?? 0, 400, (v) => String(Math.floor(v)));
  
  const avgLag = daemons.length ? Math.round(daemons.reduce((acc, curr) => acc + (curr.avg_ingestion_lag_seconds || 0), 0) / daemons.length) : 0;
  animateValue($('#pipeline-avg-lag'), avgLag, 400, fmtDuration);

  // Daemon grid new
  const grid = $('#daemon-grid');
  const countBadge = $('#daemon-count-badge');
  if (countBadge) {
    countBadge.textContent = `${daemons.length} registered`;
  }
  if (grid) {
    if (!daemons.length) {
      showEmptyState(grid, 'No registered daemons found');
    } else {
      const latestVersion = data.latest_version;
      const compareVersions = (a, b) => {
        if (!a || !b) return 0;
        const parse = (v) => v.split('.').map((p) => parseInt(p, 10) || 0);
        const pa = parse(a);
        const pb = parse(b);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const diff = (pa[i] || 0) - (pb[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      };

      grid.innerHTML = daemons.map(d => {
        const statusClass = daemonHealthClass(d.last_heartbeat);
        const labelMap = { healthy: 'Healthy', stale: 'Stale', dead: 'Dead', never: 'Never' };
        const hb = d.last_heartbeat
          ? new Date(d.last_heartbeat).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + new Date(d.last_heartbeat).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          : 'Never';

        let versionBadge = '';
        if (d.daemon_version) {
          const isOutdated = latestVersion && compareVersions(latestVersion, d.daemon_version) > 0;
          if (isOutdated) {
            versionBadge = `<span class="source-tag" style="font-size: 10px; padding: 1px 5px; margin-left: 6px; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 4px; font-family: monospace; font-weight: normal; color: #fbbf24; vertical-align: middle;" title="Update available: v${esc(latestVersion)} is latest">v${esc(d.daemon_version)} (outdated)</span>`;
          } else {
            versionBadge = `<span class="source-tag" style="font-size: 10px; padding: 1px 5px; margin-left: 6px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 4px; font-family: monospace; font-weight: normal; color: #34d399; vertical-align: middle;" title="Running latest version">v${esc(d.daemon_version)} (latest)</span>`;
          }
        }

        return `
          <div class="daemon-row">
            <div class="daemon-status-dot ${statusClass}" title="${labelMap[statusClass]}"></div>
            <div>
              <div class="daemon-row-name">
                ${esc(d.daemon_name || d.daemon_id)}
                ${versionBadge}
              </div>
              <div class="daemon-row-org">${esc(d.org_name || 'Independent')} · ${fmtDuration(d.avg_ingestion_lag_seconds)} lag · ${Number(d.batches_received || 0).toLocaleString()} batches</div>
            </div>
            <div class="daemon-row-meta">
              <span class="daemon-row-badge badge-${statusClass}">${labelMap[statusClass]}</span>
              <div class="daemon-row-hb">${hb}</div>
            </div>
          </div>`;
      }).join('');
    }
  }

  // Ingestion lag chart
  const lagSvg = $('#lag-chart');
  const lagTooltip = $('#lag-tooltip');
  if (lagSvg) {
    const trend = data.lag_trend || [];
    if (!trend.length) {
      showEmptyState(document.getElementById('lag-chart-wrap'), 'No lag data recorded in period');
    } else {
      const labels = trend.map(r => fmtDate(r.day));
      const vals   = trend.map(r => Number(r.avg_lag_seconds) || 0);
      const series = [{ label: 'Ingestion Lag', color: '#a78bfa', values: vals }];
      
      drawLineChart(lagSvg, series, labels, {
        height: 150,
        yFormatter: fmtDuration
      });
      initInteractiveChart(lagSvg, series, labels, lagTooltip, fmtDuration);
    }
  }

  // Failure Rates List
  const frList = $('#failure-rate-list');
  if (frList) {
    const failures = data.failure_rates || [];
    if (!failures.length) {
      showEmptyState(frList, 'No activity or failures recorded');
    } else {
      frList.innerHTML = failures.map(r => {
        const rate = Number(r.failure_rate_pct) || 0;
        const total = Number(r.total_received) || 0;
        const failed = Number(r.total_failed) || 0;
        return `
          <div class="fr-row">
            <div class="fr-name">${esc(r.daemon_name || r.daemon_id)}</div>
            <div class="fr-track">
              <div class="fr-fill" style="width: ${rate}%"></div>
            </div>
            <div class="fr-meta">
              <span>Failure Rate: <strong>${rate.toFixed(1)}%</strong></span>
              <span>${failed}/${total} failed batches</span>
            </div>
          </div>`;
      }).join('');
    }
  }
}

// ── Cost Intelligence ───────────────────────────────────────────────────────

let costLoaded = false;

async function loadCostOverview(range = '30d') {
  try {
    const res = await fetch(`/api/admin/cost-overview?range=${range}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderCostOverview(data);
  } catch (err) {
    window.showToast?.(`Cost overview: ${err.message}`, { type: 'error' });
  }
}

function renderCostOverview(data) {
  const t = data.totals || {};

  // KPI Row with animated values
  animateValue($('#cost-total-actual'), t.total_actual_cost ?? 0, 400, fmtCost);
  animateValue($('#cost-total-list'), t.total_list_price ?? 0, 400, fmtCost);
  animateValue($('#cost-total-sessions'), t.total_sessions ?? 0, 400, (v) => Number(Math.floor(v)).toLocaleString());

  const totalCacheSavings = (data.cache_savings || []).reduce((sum, r) => sum + (Number(r.estimated_cache_savings_usd) || 0), 0);
  animateValue($('#cost-total-cache-savings'), totalCacheSavings, 400, fmtCost);

  // Avg cost per session sub label
  const avgSessCost = t.total_sessions ? (t.total_actual_cost / t.total_sessions) : 0;
  const avgSessCostEl = $('#cost-per-session-avg');
  if (avgSessCostEl) {
    avgSessCostEl.textContent = fmtCost(avgSessCost) + ' avg/session';
  }

  // Cost trend line chart
  const costSvg = $('#cost-trend-chart');
  const costTooltip = $('#cost-tooltip');
  if (costSvg) {
    const trend = data.cost_trend || [];
    if (!trend.length) {
      showEmptyState(document.getElementById('cost-chart-wrap'), 'No cost data recorded in period');
    } else {
      const labels = trend.map(r => fmtDate(r.day));
      const series = [
        { label: 'List Price', color: '#fbbf24', values: trend.map(r => Number(r.list_price_total) || 0) },
        { label: 'Actual Cost', color: '#34d399', values: trend.map(r => Number(r.actual_cost_total) || 0) },
      ];
      drawLineChart(costSvg, series, labels, {
        height: 210,
        yFormatter: (v) => fmtCost(v)
      });
      initInteractiveChart(costSvg, series, labels, costTooltip, (v) => fmtCost(v));
    }
  }

  // Cache savings bar chart
  const cacheSvg = $('#cache-savings-chart');
  if (cacheSvg) {
    const savings = data.cache_savings || [];
    if (!savings.length) {
      showEmptyState(document.getElementById('cache-chart-wrap'), 'No cache savings recorded');
    } else {
      drawBarChart(cacheSvg, savings.map(r => ({
        label: r.day,
        value: Number(r.estimated_cache_savings_usd) || 0,
        color: '#34d399',
      })), { height: 140 });
    }
  }

  // Top Orgs List (rendered with beautiful visual bars instead of raw table)
  const orgsList = $('#top-orgs-list');
  if (orgsList) {
    const orgs = data.top_orgs || [];
    if (!orgs.length) {
      showEmptyState(orgsList, 'No spend data recorded');
    } else {
      const maxCost = orgs.length ? Math.max(...orgs.map(o => o.total_actual_cost), 1) : 1;
      orgsList.innerHTML = orgs.map((o, i) => {
        const pct = Math.max(3, (o.total_actual_cost / maxCost) * 100);
        return `
          <div class="org-row">
            <div class="org-rank">#${i + 1}</div>
            <div class="org-info">
              <div class="org-name">${esc(o.org_name || 'Independent')}</div>
              <div class="org-sessions">${Number(o.total_sessions).toLocaleString()} sessions · ${fmtTokens(o.total_input_tokens)} in · ${fmtTokens(o.total_output_tokens)} out</div>
            </div>
            <div class="org-cost-block">
              <div class="org-cost-actual">${fmtCost(o.total_actual_cost)}</div>
              <div class="org-cost-bar-wrap">
                <div class="org-cost-bar-track">
                  <div class="org-cost-bar-fill" style="width: ${pct}%"></div>
                </div>
              </div>
            </div>
          </div>`;
      }).join('');
    }
  }

  // Override Audit List
  const auditList = $('#override-audit-list');
  if (auditList) {
    const overrides = data.override_audit || [];
    if (!overrides.length) {
      showEmptyState(auditList, 'No active custom pricing overrides');
    } else {
      auditList.innerHTML = overrides.map(o => `
        <div class="override-row">
          <div class="override-org">${esc(o.org_name || 'Global Override')}</div>
          <div class="override-pattern"><code>${esc(o.model_pattern)}</code></div>
          <div class="override-rates">
            In: $${Number(o.cost_in_per_m).toFixed(2)}/M · Out: $${Number(o.cost_out_per_m).toFixed(2)}/M · Cache: $${Number(o.cost_cache_read_per_m).toFixed(2)}/M
          </div>
        </div>`).join('');
    }
  }
}

// ── Usage & Growth ──────────────────────────────────────────────────────────

let usageLoaded = false;
let auditLoaded = false;

async function loadUsageTrends(range = '30d') {
  try {
    const res = await fetch(`/api/admin/usage-trends?range=${range}&groupBy=tool`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderUsageTrends(data);
  } catch (err) {
    window.showToast?.(`Usage trends: ${err.message}`, { type: 'error' });
  }
}

function renderUsageTrends(data) {
  const da = data.daemon_activity || {};
  
  // KPI card counter updates
  animateValue($('#usage-active-24h'), da.active_24h ?? 0, 400, (v) => String(Math.floor(v)));
  animateValue($('#usage-active-7d'), da.active_7d ?? 0, 400, (v) => String(Math.floor(v)));
  animateValue($('#usage-total-registered'), da.total_registered ?? 0, 400, (v) => String(Math.floor(v)));

  const totalTokens = (data.daily_summary || []).reduce((sum, r) => sum + (Number(r.total_tokens) || 0), 0);
  animateValue($('#usage-total-tokens'), totalTokens, 400, fmtTokens);

  // Token trend line chart (by tool stacked/multi-line)
  const tokenSvg = $('#token-trend-chart');
  const tokenTooltip = $('#token-tooltip');
  if (tokenSvg) {
    const byTool = data.tokens_by_tool || [];
    if (!byTool.length) {
      showEmptyState(document.getElementById('token-trend-wrap'), 'No token usage recorded in period');
    } else {
      const days = [...new Set(byTool.map(r => r.day))].sort();
      const tools = [...new Set(byTool.map(r => r.tool))];
      const series = tools.map(tool => ({
        label: tool,
        color: toolColor(tool),
        values: days.map(day => {
          const row = byTool.find(r => r.day === day && r.tool === tool);
          return row ? Number(row.input_tokens) + Number(row.output_tokens) : 0;
        }),
      }));
      drawLineChart(tokenSvg, series, days.map(fmtDate), {
        height: 220,
        yFormatter: (v) => fmtTokens(v)
      });
      initInteractiveChart(tokenSvg, series, days.map(fmtDate), tokenTooltip, (v) => fmtTokens(v));

      // Redesigned inline tool legends
      const legend = $('#tool-legend');
      if (legend) {
        legend.innerHTML = tools.map(t => `
          <span style="display:inline-flex;align-items:center;margin-right:12px;">
            <span class="cli-dot" style="background:${toolColor(t)}"></span>${esc(t)}
          </span>`
        ).join('');
      }
    }
  }

  // Model Leaderboard
  const modelLeader = $('#model-punchcard-wrap');
  if (modelLeader) {
    const models = data.top_models || [];
    if (!models.length) {
      showEmptyState(modelLeader, 'No model usage recorded');
    } else {
      const maxTokens = models.length ? Math.max(...models.map(m => Number(m.total_tokens) || 0), 1) : 1;
      modelLeader.innerHTML = models.slice(0, 10).map(m => {
        const tokens = Number(m.total_tokens) || 0;
        const pct = Math.max(3, (tokens / maxTokens) * 100);
        return `
          <div class="model-row">
            <div class="model-row-header">
              <span class="model-name">${esc(m.model)}</span>
              <span class="model-tokens">${fmtTokens(tokens)} tokens</span>
            </div>
            <div class="model-bar-track">
              <div class="model-bar-fill" style="width: ${pct}%"></div>
            </div>
          </div>`;
      }).join('');
    }
  }

  // Daily Summary List
  const summaryList = $('#daily-summary-list');
  if (summaryList) {
    const summary = [...(data.daily_summary || [])].reverse(); // most recent first
    if (!summary.length) {
      showEmptyState(summaryList, 'No daily summary recorded');
    } else {
      summaryList.innerHTML = summary.map(r => `
        <div class="ds-row">
          <div class="ds-date">${fmtDate(r.day)}</div>
          <div class="ds-tokens">${fmtTokens(r.total_tokens)} tkn</div>
          <div class="ds-sessions">${Number(r.total_sessions).toLocaleString()} sess</div>
          <div><span class="ds-orgs">${r.active_orgs} orgs</span></div>
        </div>`).join('');
    }
  }
}

// ── Wire up analytics tab lazy-loading ─────────────────────────────────────
function setupAnalyticsTabs() {
  $('#pipeline-range-select')?.addEventListener('change', (e) => {
    loadPipelineHealth(e.target.value);
  });

  const costSel = $('#cost-range-select');
  if (costSel) {
    costSel.addEventListener('change', (e) => loadCostOverview(e.target.value));
  }

  const usageSel = $('#usage-range-select');
  if (usageSel) {
    usageSel.addEventListener('change', (e) => loadUsageTrends(e.target.value));
  }

  // Lazy-load on first tab activation by patching switchTab
  const _origSwitchTab = window._switchTab || switchTab;
  function patchedSwitchTab(tabId) {
    _origSwitchTab(tabId);
    if (tabId === 'tab-infra') {
      infraLoaded = true;
      loadInfraHealth();
    }
    if (tabId === 'tab-pipeline' && !pipelineLoaded) {
      pipelineLoaded = true;
      loadPipelineHealth($('#pipeline-range-select')?.value || '7d');
    }
    if (tabId === 'tab-cost' && !costLoaded) {
      costLoaded = true;
      loadCostOverview($('#cost-range-select')?.value || '30d');
    }
    if (tabId === 'tab-usage' && !usageLoaded) {
      usageLoaded = true;
      loadUsageTrends($('#usage-range-select')?.value || '30d');
    }
    if (tabId === 'tab-top-usage') {
      topUsageLoaded = true;
      loadTopUsage();
    }
    if (tabId === 'tab-prompts') {
      window.dispatchEvent(new CustomEvent('prompts-tab-activated'));
    }
    if (tabId === 'tab-releases') {
      loadReleases();
    }
    if (tabId === 'tab-audit' && !auditLoaded) {
      auditLoaded = true;
      loadAuditLog();
    }
  }


  document.querySelectorAll('.admin-sidebar-nav button').forEach(b => {
    b.onclick = () => patchedSwitchTab(b.dataset.tab);
  });
}

function bindUserFilters() {
  const searchInput = $('#filter-user-input');
  const teamSelect = $('#filter-team-select');
  const statusSelect = $('#filter-status-select');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      userFilterSearch = e.target.value;
      renderUsers();
    });
  }
  if (teamSelect) {
    teamSelect.addEventListener('change', (e) => {
      userFilterTeam = e.target.value;
      renderUsers();
    });
  }
  if (statusSelect) {
    statusSelect.addEventListener('change', (e) => {
      userFilterStatus = e.target.value;
      renderUsers();
    });
  }
}

// Bind filters immediately, assuming elements might already be in DOM
// or will be accessed when loadData runs
if (typeof window !== 'undefined') {
  // Use setTimeout to ensure DOM is fully parsed if script runs early
  setTimeout(bindUserFilters, 0);
}

// ── Daemon Releases Management ────────────────────────────────────────────────
let releasesData = [];

async function loadReleases() {
  const el = $('#daemon-releases-list');
  try {
    const res = await fetch('/api/internal/releases');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    releasesData = data.releases || [];

    // Update latest version badge & variable
    const active = releasesData.find((r) => r.active);
    latestDaemonVersion = active ? active.version : null;
    const latestEl = $('#daemon-latest-version-badge');
    if (latestEl) {
      latestEl.textContent = active ? `Latest: v${active.version}` : 'No active release';
    }

    renderReleasesTable();
    renderUsers();
  } catch (err) {
    if (el) el.innerHTML = `<p class="error admin-empty" style="padding:12px">Unable to load releases: ${esc(err.message)}</p>`;
  }
}

function renderReleasesTable() {
  const el = $('#daemon-releases-list');
  if (!el) return;

  if (!releasesData.length) {
    el.innerHTML = '<p class="muted admin-empty" style="padding:24px; text-align:center">No daemon releases published yet.</p>';
    return;
  }

  el.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Status</th>
          <th>Mandatory</th>
          <th>Released</th>
          <th>SHA-256 Checksum</th>
          <th>Notes</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${releasesData.map(r => {
          const statusBadge = r.active
            ? '<span class="badge badge-active" style="background:rgba(34,197,94,0.15);color:#4ade80;padding:2px 6px;border-radius:4px;font-size:11px;">🟢 Active</span>'
            : '<span class="badge badge-inactive" style="background:rgba(148,163,184,0.15);color:#94a3b8;padding:2px 6px;border-radius:4px;font-size:11px;">Inactive</span>';
          const mandatoryBadge = r.mandatory
            ? '<span class="badge badge-error" style="background:rgba(239,68,68,0.15);color:#f87171;padding:2px 6px;border-radius:4px;font-size:11px;">Mandatory</span>'
            : '<span class="badge badge-inactive" style="background:rgba(148,163,184,0.15);color:#94a3b8;padding:2px 6px;border-radius:4px;font-size:11px;">Optional</span>';
          const sha = r.sha256 ? r.sha256.slice(0, 12) + '…' : '—';
          return `
            <tr>
              <td><strong>v${esc(r.version)}</strong></td>
              <td>${statusBadge}</td>
              <td>${mandatoryBadge}</td>
              <td>${fmtDate(r.released_at)}</td>
              <td><code title="${esc(r.sha256)}">${esc(sha)}</code></td>
              <td>${esc(r.release_notes || '—')}</td>
              <td>
                ${r.active
                  ? `<button type="button" class="hbtn" style="color:var(--brand-hi)" onclick="deactivateRelease('${r.id}')">⏸️ Deactivate</button>`
                  : `<button type="button" class="hbtn primary" onclick="activateRelease('${r.id}')">▶️ Activate</button>`
                }
                <button type="button" class="hbtn" style="color:#f87171; border-color:#f87171" onclick="deleteRelease('${r.id}', 'v${esc(r.version)}')">🗑️ Delete</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

window.activateRelease = async function (id) {
  try {
    const res = await fetch('/api/internal/releases', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.showToast('Release activated successfully.', { type: 'success' });
    await loadReleases();
  } catch (err) {
    window.showToast('Failed to activate: ' + err.message, { type: 'error' });
  }
};

window.deactivateRelease = async function (id) {
  if (!confirm('Deactivate this release? running daemons will stop updating to it.')) return;
  try {
    const res = await fetch('/api/internal/releases', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.showToast('Release deactivated.', { type: 'success' });
    await loadReleases();
  } catch (err) {
    window.showToast('Failed to deactivate: ' + err.message, { type: 'error' });
  }
};

window.deleteRelease = async function (id, version) {
  if (!confirm(`Permanently delete release ${version}? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/internal/releases?id=${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.showToast(`Release ${version} deleted.`, { type: 'success' });
    await loadReleases();
  } catch (err) {
    window.showToast('Failed to delete: ' + err.message, { type: 'error' });
  }
};

function bindReleasesForm() {
  const form = $('#publish-release-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#publish-release-submit');
    const errEl = $('#publish-release-error');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }

    const version = ($('#release-version')?.value || '').trim();
    const downloadUrl = ($('#release-url')?.value || '').trim();
    const sha256 = ($('#release-sha256')?.value || '').trim().toLowerCase();
    const mandatory = $('#release-mandatory')?.checked ?? false;
    const releaseNotes = ($('#release-notes')?.value || '').trim() || null;

    if (!version || !downloadUrl || !sha256) {
      if (errEl) { errEl.textContent = 'Version, URL, and SHA-256 are required.'; errEl.hidden = false; }
      return;
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      if (errEl) { errEl.textContent = 'SHA-256 must be a 64-character hex string.'; errEl.hidden = false; }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
    try {
      const res = await fetch('/api/internal/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, downloadUrl, sha256, mandatory, releaseNotes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      window.showToast(`Release v${version} published successfully.`, { type: 'success' });
      form.reset();
      await loadReleases();
    } catch (err) {
      if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Publish Release'; }
    }
  });
}

// Bind form setup when script runs or DOM is ready
// NOTE: bindReleasesForm() and bindAuditLogFilters() are now called from the
// main async IIFE (see above) where timing is guaranteed. The old setTimeout
// fallbacks have been removed.

// ── Audit Log ────────────────────────────────────────────────────────────────
const AUDIT_ACTION_LABELS = {
  'impersonate.start': '🎭 Impersonation started',
  'impersonate.end': '↩️ Impersonation ended',
  'user.create': '👤 User created',
  'user.reset-password': '🔑 Password reset',
  'pricing.create': '💲 Pricing rule created',
  'pricing.update': '💲 Pricing rule updated',
  'pricing.delete': '🗑️ Pricing rule deleted',
};

function fmtAuditDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function loadAuditLog() {
  const el = $('#audit-log-table');
  if (!el) return;
  el.innerHTML = '<p class="muted admin-empty" style="padding:24px; text-align:center">Loading audit log…</p>';
  try {
    const action = $('#audit-action-filter')?.value || '';
    const qs = action ? `?action=${encodeURIComponent(action)}` : '';
    const res = await fetch(`/api/admin/audit-log${qs}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderAuditLogTable(data.events || []);
  } catch (err) {
    el.innerHTML = `<p class="error admin-empty" style="padding:12px">Unable to load audit log: ${esc(err.message)}</p>`;
  }
}

function renderAuditLogTable(events) {
  const el = $('#audit-log-table');
  if (!el) return;
  if (!events.length) {
    el.innerHTML = '<p class="muted admin-empty" style="padding:24px; text-align:center">No audit events recorded yet.</p>';
    return;
  }
  el.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Actor</th>
          <th>Action</th>
          <th>Target</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        ${events.map((e) => {
          const label = AUDIT_ACTION_LABELS[e.action] || esc(e.action);
          const target = e.target_id ? `<code>${esc(e.target_type || '')} ${esc(String(e.target_id).slice(0, 8))}…</code>` : '—';
          const metaStr = e.metadata ? esc(JSON.stringify(e.metadata)) : '—';
          return `
            <tr>
              <td>${fmtAuditDate(e.created_at)}</td>
              <td>${esc(e.actor_username || '—')}</td>
              <td>${label}</td>
              <td>${target}</td>
              <td style="max-width:320px; overflow-wrap:anywhere; font-size:11.5px; color:var(--muted)">${metaStr}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function bindAuditLogFilters() {
  $('#audit-refresh-btn')?.addEventListener('click', () => loadAuditLog());
  $('#audit-action-filter')?.addEventListener('change', () => loadAuditLog());
}
if (typeof window !== 'undefined') {
  setTimeout(bindAuditLogFilters, 0);
}

// ── Infrastructure & Compute Monitoring Panel ────────────────────────────────
let infraLoaded = false;

async function loadInfraHealth() {
  const tbody = $('#infra-tables-tbody');
  try {
    const res = await fetch('/api/admin/infra-health');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderInfraHealth(data);
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" class="error admin-empty" style="padding:20px; text-align:center">Unable to load infrastructure metrics: ${esc(err.message)}</td></tr>`;
    }
  }
}

function renderInfraHealth(data) {
  if (!data || !data.limits) return;

  const { neonStorage, vercelInvocations, cacheEfficiency, activeConnections } = data.limits;

  // 1. Neon DB Storage KPI
  const storageVal = $('#infra-storage-val');
  const storageBar = $('#infra-storage-bar');
  const storageSub = $('#infra-storage-sub');
  if (storageVal) storageVal.textContent = `${neonStorage.prettySize} / 500 MB`;
  if (storageBar) {
    storageBar.style.width = `${neonStorage.usedPct}%`;
    storageBar.style.background = neonStorage.status === 'critical' ? '#ef4444' : neonStorage.status === 'warning' ? '#f59e0b' : '#3b82f6';
  }
  if (storageSub) storageSub.textContent = `${neonStorage.usedPct}% used • Status: ${neonStorage.status.toUpperCase()}`;

  // 2. Vercel Invocations KPI
  const invocationsVal = $('#infra-invocations-val');
  const invocationsBar = $('#infra-invocations-bar');
  const invocationsSub = $('#infra-invocations-sub');
  if (invocationsVal) invocationsVal.textContent = `~${vercelInvocations.estimatedToday.toLocaleString()} / 100k`;
  if (invocationsBar) {
    invocationsBar.style.width = `${vercelInvocations.usedPct}%`;
    invocationsBar.style.background = vercelInvocations.status === 'critical' ? '#ef4444' : vercelInvocations.status === 'warning' ? '#f59e0b' : '#10b981';
  }
  if (invocationsSub) invocationsSub.textContent = `${vercelInvocations.usedPct}% used • Batches today: ${vercelInvocations.batchesToday.toLocaleString()} (${vercelInvocations.sessionsToday.toLocaleString()} sessions)`;

  // 3. Cache Hit Ratio
  const cacheVal = $('#infra-cache-val');
  const cacheSub = $('#infra-cache-sub');
  if (cacheVal) cacheVal.textContent = `${cacheEfficiency.hitRatio.toFixed(1)}%`;
  if (cacheSub) cacheSub.textContent = `Memory efficiency: ${cacheEfficiency.status.toUpperCase()}`;

  // 4. Active DB Connections
  const connVal = $('#infra-conn-val');
  if (connVal) connVal.textContent = activeConnections.count;

  // 5. Daemon Rollout Progress Bar (v1.3.0)
  const rollout = data.daemonRollout || { v130Pct: 0, v130Count: 0, totalMembers: 0, breakdown: [] };
  const rolloutPct = $('#infra-rollout-pct');
  const rolloutBar = $('#infra-rollout-bar');
  const rolloutBadge = $('#infra-v130-badge');
  const rolloutList = $('#infra-versions-list');

  if (rolloutPct) rolloutPct.textContent = `${rollout.v130Pct}% (${rollout.v130Count} / ${rollout.totalMembers})`;
  if (rolloutBar) rolloutBar.style.width = `${rollout.v130Pct}%`;
  if (rolloutBadge) {
    rolloutBadge.textContent = `${rollout.v130Count} on v1.3.0`;
    rolloutBadge.className = rollout.v130Pct >= 80 ? 'badge-pill green' : 'badge-pill';
  }

  if (rolloutList && rollout.breakdown) {
    rolloutList.innerHTML = rollout.breakdown.map((r) => `
      <div style="background:var(--bg-subtle, rgba(255,255,255,0.05)); padding:4px 10px; borderRadius:4px; border:1px solid var(--border, #333)">
        <strong>${esc(r.version)}:</strong> ${r.member_count} members (${r.active_count} active 7d)
      </div>
    `).join('');
  }

  // 6. Table Storage Breakdown Table
  const tbody = $('#infra-tables-tbody');
  if (tbody && data.tableStorage) {
    if (!data.tableStorage.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted admin-empty" style="padding:20px; text-align:center">No table statistics available.</td></tr>';
    } else {
      tbody.innerHTML = data.tableStorage.map((t) => {
        let policy = 'Permanent';
        if (t.table_name === 'sync_sessions' || t.table_name === 'sync_session_files' || t.table_name === 'sync_session_tools') {
          policy = '30-Day Rolling Prune';
        } else if (t.table_name === 'session_turns' || t.table_name === 'session_tool_errors') {
          policy = '14-Day Rolling Prune';
        } else if (t.table_name.startsWith('daily_')) {
          policy = 'Permanent Pre-Computed';
        }
        return `
          <tr>
            <td><code>${esc(t.table_name)}</code></td>
            <td><strong>${esc(t.total_size)}</strong></td>
            <td>${esc(t.table_size)}</td>
            <td>${esc(t.index_size)}</td>
            <td>${Number(t.row_estimate).toLocaleString()}</td>
            <td><span class="badge-pill ${policy.includes('Prune') ? 'amber' : 'green'}">${policy}</span></td>
          </tr>
        `;
      }).join('');
    }
  }

  // 7. Retention Status
  const retention = data.retentionStatus;
  const unprunedEl = $('#infra-unpruned-events');
  const oldestSessionEl = $('#infra-oldest-session');
  if (unprunedEl && retention) {
    unprunedEl.textContent = `${retention.unprunedEventsCount} unpruned raw events`;
  }
  if (oldestSessionEl && retention) {
    const oldest = retention.oldestSessionDate ? String(retention.oldestSessionDate).slice(0, 10) : 'None';
    oldestSessionEl.textContent = `Oldest session: ${oldest} • ${retention.totalSessionsInDb.toLocaleString()} active rows`;
  }
}

function bindInfraEvents() {
  $('#infra-refresh-btn')?.addEventListener('click', () => loadInfraHealth());

  const pruneBtn = $('#run-rollup-prune-btn');
  if (pruneBtn) {
    pruneBtn.addEventListener('click', async () => {
      const origText = pruneBtn.innerHTML;
      pruneBtn.disabled = true;
      pruneBtn.innerHTML = '⏳ Running Rollup &amp; Pruning…';

      try {
        const res = await fetch('/api/internal/rollup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
          throw new Error(data.errors?.join(', ') || data.error || `HTTP ${res.status}`);
        }

        const p = data.pruning || {};
        const msg = `✅ Rollup & Prune finished in ${data.elapsed_ms}ms! (Nullified: ${p.nullifiedEventsOlderThan7d || 0} events, Deleted: ${p.deletedSessionsOlderThan30d || 0} old sessions)`;
        if (typeof showToast === 'function') {
          showToast(msg, 'success');
        } else {
          alert(msg);
        }

        // Instantly refresh infrastructure metrics
        await loadInfraHealth();
      } catch (err) {
        const errStr = `Rollup failed: ${err.message}`;
        if (typeof showToast === 'function') {
          showToast(errStr, 'error');
        } else {
          alert(errStr);
        }
      } finally {
        pruneBtn.disabled = false;
        pruneBtn.innerHTML = origText;
      }
    });
  }
}
if (typeof window !== 'undefined') {
  setTimeout(bindInfraEvents, 0);
}

let topUsageLoaded = false;
let currentWhalesData = null;

async function loadTopUsage() {
  const tbody = $('#whale-table-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colSpan="10" class="muted" style="text-align:center; padding:30px;"><span class="inline-spinner"></span> Analyzing top usage and spenders across the platform…</td></tr>`;
  }

  // Populate team dropdown if empty
  const teamSel = $('#whale-team-select');
  if (teamSel && teamSel.options.length <= 1 && teams && teams.length) {
    const curVal = teamSel.value;
    teamSel.innerHTML = '<option value="all">All Teams</option>' +
      teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    if (curVal) teamSel.value = curVal;
  }

  const range = $('#whale-range-select')?.value || 'all';
  const teamId = $('#whale-team-select')?.value || 'all';
  const minTokens = $('#whale-min-tokens-select')?.value || '0';
  const search = $('#whale-search-input')?.value || '';

  const params = new URLSearchParams();
  if (range && range !== 'all') params.set('range', range);
  if (teamId && teamId !== 'all') params.set('teamId', teamId);
  if (minTokens && minTokens !== '0') params.set('minTokens', minTokens);
  if (search) params.set('search', search);

  try {
    const res = await fetch(`/api/admin/top-usage?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to load whale analysis: ${res.statusText}`);
    }
    const data = await res.json();
    currentWhalesData = data;
    renderTopUsage(data);
  } catch (err) {
    console.error('[loadTopUsage error]', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colSpan="10" style="color:var(--error-text); text-align:center; padding:20px;">Error loading top usage: ${esc(err.message)}</td></tr>`;
    }
  }
}

function renderTopUsage(data) {
  if (!data) return;

  // 1. KPI Cards
  const topUser = data.whales?.[0];
  const topUserEl = $('#whale-kpi-top-user');
  const topUserSub = $('#whale-kpi-top-user-sub');
  if (topUserEl) {
    topUserEl.textContent = topUser ? topUser.displayName : 'None';
  }
  if (topUserSub && topUser) {
    topUserSub.textContent = `${fmtTokens(topUser.totalTokens)} tokens • ${fmtCost(topUser.apiCost)}`;
  }

  const totalTokensEl = $('#whale-kpi-total-tokens');
  const totalCostEl = $('#whale-kpi-total-cost');
  if (totalTokensEl) {
    totalTokensEl.textContent = fmtTokens(data.totals?.totalTokens || 0);
  }
  if (totalCostEl) {
    totalCostEl.textContent = `${fmtCost(data.totals?.totalCost || 0)} total platform spend`;
  }

  const topProj = data.topProjectsGlobal?.[0];
  const topProjEl = $('#whale-kpi-top-project');
  const topProjSub = $('#whale-kpi-top-project-sub');
  if (topProjEl) {
    topProjEl.textContent = topProj ? topProj.name : 'None';
  }
  if (topProjSub && topProj) {
    topProjSub.textContent = `${fmtTokens(topProj.tokens)} tokens (${topProj.sessions} sessions)`;
  }

  const whaleCountEl = $('#whale-kpi-whale-count');
  if (whaleCountEl) {
    whaleCountEl.textContent = String(data.totalWhales || 0);
  }

  // 2. Global Projects Section
  const globalProjEl = $('#whale-global-projects');
  if (globalProjEl) {
    if (!data.topProjectsGlobal?.length) {
      globalProjEl.innerHTML = `<p class="muted" style="font-size:12px; margin:8px 0;">No project data found.</p>`;
    } else {
      const maxProjTok = Math.max(...data.topProjectsGlobal.map(p => p.tokens), 1);
      globalProjEl.innerHTML = data.topProjectsGlobal.map(p => {
        const pct = Math.min(100, Math.round((p.tokens / maxProjTok) * 100));
        return `
          <div style="margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:3px;">
              <span style="font-weight:600;">📁 ${esc(p.name)}</span>
              <span class="muted">${fmtTokens(p.tokens)} tokens • ${fmtCost(p.cost)} (${p.sessions} sess)</span>
            </div>
            <div class="progress-bar" style="height:6px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden;">
              <div style="width:${pct}%; height:100%; background:var(--brand); border-radius:3px;"></div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 3. Extreme Runaway Sessions
  const extremeEl = $('#whale-extreme-sessions');
  if (extremeEl) {
    if (!data.extremeSessions?.length) {
      extremeEl.innerHTML = `<p class="muted" style="font-size:12px; margin:8px 0;">No runaway sessions detected.</p>`;
    } else {
      extremeEl.innerHTML = data.extremeSessions.map(s => {
        const isRunaway = s.totalTokens > 5_000_000 || s.toolErrors > 15 || s.reworkLoops > 5;
        const badge = isRunaway ? `<span class="source-tag" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); font-size:10px;">⚠️ Loop / Anomaly</span>` : '';
        return `
          <div style="padding:8px; margin-bottom:8px; background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:var(--radius-sm); font-size:11.5px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <strong>👤 ${esc(s.memberName)} <span class="muted">(${esc(s.teamName)})</span></strong>
              <strong style="color:var(--brand-hi);">${fmtTokens(s.totalTokens)}</strong>
            </div>
            <div style="display:flex; justify-content:space-between; color:var(--muted); font-size:11px; align-items:center;">
              <span>📁 ${esc(s.project)} • 🤖 <code>${esc(s.model)}</code></span>
              <div style="display:flex; gap:6px; align-items:center;">
                ${badge}
                <button type="button" class="hbtn" style="font-size:10.5px; padding:2px 6px;" onclick="inspectWhalePrompt('${esc(s.sessionId)}')">Inspect Prompts ↗</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 4. Whale Table
  const tbody = $('#whale-table-body');
  if (tbody) {
    if (!data.whales?.length) {
      tbody.innerHTML = `<tr><td colSpan="10" class="muted" style="text-align:center; padding:30px;">No members matching filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.whales.map((w, idx) => {
      const topProjName = w.topProject?.name || 'none';
      const topProjPct = Math.round(w.topProject?.percentage || 0);
      const runawayBadge = w.runawayCount > 0
        ? `<span class="source-tag" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); font-size:11px; font-weight:600;">⚠️ ${w.runawayCount} runaway</span>`
        : `<span class="muted" style="font-size:11px;">✓ Normal</span>`;

      const rankBadge = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;

      return `
        <tr style="cursor:pointer;" onclick="openWhaleDrilldown('${esc(w.memberId)}', '${esc(w.displayName)}')">
          <td style="font-weight:600; text-align:center; font-size:13px;">${rankBadge}</td>
          <td>
            <div style="font-weight:600; color:var(--text); font-size:13px;">👤 ${esc(w.displayName)}</div>
            <div class="muted" style="font-size:11px;">${w.sessionsCount} sessions • ${w.topSource}</div>
          </td>
          <td>
            <span class="source-tag">${esc(w.teamName)}</span>
          </td>
          <td>
            <div style="font-weight:700; color:var(--brand-hi); font-size:13.5px;">${fmtTokens(w.totalTokens)}</div>
            <div class="muted" style="font-size:10.5px;">${fmtTokens(w.tokensIn)} in / ${fmtTokens(w.tokensOut)} out</div>
          </td>
          <td>
            <span style="color:#a78bfa; font-weight:600;">${fmtTokens(w.tokensCacheRead)}</span>
          </td>
          <td>
            <strong style="color:var(--text);">${fmtCost(w.apiCost)}</strong>
          </td>
          <td>
            <div style="font-weight:600; font-size:12px;">📁 ${esc(topProjName)}</div>
            <div class="muted" style="font-size:10.5px;">${topProjPct}% of member burn</div>
          </td>
          <td>
            <code style="font-size:11px;">${esc(w.topModel)}</code>
          </td>
          <td>${runawayBadge}</td>
          <td style="text-align:right;" onclick="event.stopPropagation();">
            <button type="button" class="hbtn primary" style="font-size:11.5px; padding:4px 10px;" onclick="openWhaleDrilldown('${esc(w.memberId)}', '${esc(w.displayName)}')">
              🔍 Analyze Breakdown
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }
}

// Whale Drilldown Modal
const adminDrilldownCache = new Map();

async function openWhaleDrilldown(memberId, memberName) {
  const dialog = $('#whale-drilldown-dialog');
  if (!dialog) return;

  const titleEl = $('#wdd-title');
  const subEl = $('#wdd-subtitle');
  if (titleEl) titleEl.textContent = `👤 ${memberName || 'Member'} — Token Deep-Dive Analysis`;
  if (subEl) subEl.textContent = `Analyzing where this developer spent their tokens…`;

  const loadingEl = $('#wdd-loading');
  const contentEl = $('#wdd-content');

  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }

  const range = $('#whale-range-select')?.value || 'all';
  const cacheKey = `${memberId}_${range}`;
  const cached = adminDrilldownCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < 60000)) {
    renderWhaleDrilldown(cached.data);
    return;
  }

  if (loadingEl) loadingEl.hidden = false;
  if (contentEl) contentEl.hidden = true;

  try {
    const res = await fetch(`/api/admin/top-usage?memberId=${encodeURIComponent(memberId)}&range=${encodeURIComponent(range)}`);
    if (!res.ok) {
      throw new Error(`Failed to load member deep dive: ${res.statusText}`);
    }
    const data = await res.json();
    adminDrilldownCache.set(cacheKey, { ts: Date.now(), data });
    renderWhaleDrilldown(data);
  } catch (err) {
    console.error('[openWhaleDrilldown error]', err);
    if (loadingEl) {
      loadingEl.innerHTML = `<span style="color:var(--error-text);">Error loading deep dive: ${esc(err.message)}</span>`;
    }
  }
}

function renderWhaleDrilldown(data) {
  const loadingEl = $('#wdd-loading');
  const contentEl = $('#wdd-content');
  if (loadingEl) loadingEl.hidden = true;
  if (contentEl) contentEl.hidden = false;

  if (!data) return;

  const m = data.member || {};
  const totals = data.totals || {};

  const subEl = $('#wdd-subtitle');
  if (subEl) {
    subEl.textContent = `Team: ${m.teamName || 'Independent'} • Total Consumption: ${fmtTokens(totals.totalTokens)} tokens (${fmtCost(totals.totalCost)}) across ${totals.sessionCount} sessions`;
  }

  // Stats Pills
  const statTok = $('#wdd-stat-tokens');
  const statCost = $('#wdd-stat-cost');
  if (statTok) statTok.textContent = fmtTokens(totals.totalTokens);
  if (statCost) statCost.textContent = `${fmtCost(totals.totalCost)} total API cost`;

  const statInOut = $('#wdd-stat-in-out');
  const statCache = $('#wdd-stat-cache');
  if (statInOut) statInOut.textContent = `${fmtTokens(totals.tokensIn)} in / ${fmtTokens(totals.tokensOut)} out`;
  if (statCache) statCache.textContent = `Cache read: ${fmtTokens(totals.tokensCacheRead)} (${fmtTokens(totals.tokensCacheWrite)} write)`;

  const statSess = $('#wdd-stat-sessions');
  const statAvg = $('#wdd-stat-avg');
  if (statSess) statSess.textContent = `${totals.sessionCount} sessions (${totals.activeDays} days)`;
  if (statAvg) statAvg.textContent = `Avg: ${fmtTokens(totals.avgTokensPerSession)} / session`;

  const statEdits = $('#wdd-stat-edits');
  const statLines = $('#wdd-stat-lines');
  if (statEdits) statEdits.textContent = `${totals.edits || 0} code edits`;
  if (statLines) statLines.textContent = `${totals.changedLines || 0} lines changed • ${totals.toolCalls || 0} tool calls`;

  // Dimension 1: Projects Table
  const projTbody = $('#wdd-projects-tbody');
  if (projTbody) {
    if (!data.projects?.length) {
      projTbody.innerHTML = `<tr><td colSpan="7" class="muted" style="text-align:center; padding:16px;">No project records logged.</td></tr>`;
    } else {
      projTbody.innerHTML = data.projects.map(p => `
        <tr>
          <td><strong>📁 ${esc(p.project)}</strong></td>
          <td>${(p.sources || []).map(s => `<span class="source-tag">${esc(s)}</span>`).join(' ')}</td>
          <td>${p.sessions}</td>
          <td>${fmtTokens(p.tokensIn)} / ${fmtTokens(p.tokensOut)}</td>
          <td><strong style="color:var(--brand-hi);">${fmtTokens(p.totalTokens)}</strong></td>
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
  const modTbody = $('#wdd-models-tbody');
  if (modTbody) {
    if (!data.models?.length) {
      modTbody.innerHTML = `<tr><td colSpan="7" class="muted" style="text-align:center; padding:16px;">No model records logged.</td></tr>`;
    } else {
      modTbody.innerHTML = data.models.map(mod => `
        <tr>
          <td><strong>🤖 <code>${esc(mod.model)}</code></strong></td>
          <td><span class="source-tag">${esc(mod.source)}</span></td>
          <td>${mod.sessions}</td>
          <td>${fmtTokens(mod.tokensIn)} / ${fmtTokens(mod.tokensOut)}</td>
          <td><span style="color:#a78bfa; font-weight:600;">${Math.round(mod.cacheHitRate)}%</span></td>
          <td><strong>${fmtTokens(mod.totalTokens)}</strong></td>
          <td><strong>${fmtCost(mod.apiCost)}</strong></td>
        </tr>
      `).join('');
    }
  }

  // Dimension 3: Top Sessions Table
  const sessTbody = $('#wdd-sessions-tbody');
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
            <td>📁 ${esc(s.project)}</td>
            <td>
              <div><span class="source-tag">${esc(s.source)}</span></div>
              <code style="font-size:10px;">${esc(s.model)}</code>
            </td>
            <td>
              <div style="font-weight:700; color:var(--brand-hi);">${fmtTokens(s.totalTokens)}</div>
              <div class="muted" style="font-size:10px;">${fmtTokens(s.tokensIn)} in • ${fmtTokens(s.tokensCacheRead)} cache</div>
            </td>
            <td><strong>${fmtCost(s.apiCost)}</strong></td>
            <td>
              ${runawayBadge}
              <div class="muted" style="font-size:10px;">${s.toolErrors || 0} errs • ${s.reworkLoops || 0} loops</div>
            </td>
            <td style="text-align:right;">
              <button type="button" class="hbtn" style="font-size:11px; padding:3px 8px;" onclick="inspectWhalePrompt('${esc(s.sessionId)}')">
                Prompts ↗
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // Dimension 4: Files Table
  const filesTbody = $('#wdd-files-tbody');
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
  const timelineEl = $('#wdd-timeline-chart');
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
              <div style="display:flex; flex-direction:column; align-items:center; flex:1; min-width:24px;" title="${d.day}: ${fmtTokens(d.totalTokens)} tokens (${fmtCost(d.apiCost)}) across ${d.sessions} sessions">
                <span style="font-size:9px; color:var(--muted); margin-bottom:4px;">${fmtTokens(d.totalTokens)}</span>
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

function inspectWhalePrompt(sessionId) {
  // Close modal
  const dialog = $('#whale-drilldown-dialog');
  if (dialog) dialog.close?.();

  // Switch to prompts tab
  const btn = $('#tabbtn-prompts');
  if (btn) btn.click();

  // Filter prompt explorer by session ID if input exists
  setTimeout(() => {
    const searchInput = $('#prompt-search-input') || $('#prompt-search');
    if (searchInput) {
      searchInput.value = sessionId;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, 100);
}

// Bind Top Usage Events
function bindTopUsageEvents() {
  $('#whale-range-select')?.addEventListener('change', () => loadTopUsage());
  $('#whale-team-select')?.addEventListener('change', () => loadTopUsage());
  $('#whale-min-tokens-select')?.addEventListener('change', () => loadTopUsage());
  $('#whale-refresh-btn')?.addEventListener('click', () => loadTopUsage());

  let searchTimeout = null;
  $('#whale-search-input')?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadTopUsage(), 350);
  });

  $('#wdd-close-btn')?.addEventListener('click', () => {
    $('#whale-drilldown-dialog')?.close?.();
  });
}

if (typeof window !== 'undefined') {
  setTimeout(bindTopUsageEvents, 0);
}
