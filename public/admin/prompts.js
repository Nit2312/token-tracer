(function() {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let teamsList = [];
  let isFetching = false;
  let searchTimeout = null;

  let currentPage = 1;
  let totalPages = 1;
  const limitPerPage = 50;
  
  const selectedMembers = new Set();
  let currentMembersList = [];

  async function init() {
    await fetchTeams();
    setupFilters();
    setupRefresh();
    setupPaginationHandlers();
    setupMultiselectDropdown();
    await loadPrompts();
  }

  async function fetchTeams() {
    try {
      const res = await fetch('/api/admin/pricing');
      if (res.ok) {
        const data = await res.json();
        teamsList = data.teams || [];
        const orgSelect = $('#prompt-org-select');
        if (orgSelect) {
          orgSelect.innerHTML = '<option value="">— All Orgs —</option>' + 
            teamsList.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
        }
      }
    } catch (err) {
      console.error('Failed to fetch teams list:', err);
    }
  }

  function getQueryString() {
    const range = $('#prompt-range-select')?.value || '30d';
    const org = $('#prompt-org-select')?.value || '';
    const tool = $('#prompt-tool-select')?.value || '';
    const search = $('#prompt-search-input')?.value || '';
    
    let url = `range=${range}&org=${org}&tool=${tool}&search=${encodeURIComponent(search)}&page=${currentPage}&limit=${limitPerPage}`;
    if (selectedMembers.size > 0) {
      url += `&members=${[...selectedMembers].join(',')}`;
    }
    return url;
  }

  async function loadPrompts() {
    if (isFetching) return;
    isFetching = true;

    const tbody = $('#prompt-explorer-tbody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; padding: 30px;" class="muted">🔄 Fetching prompts...</td></tr>';
    }

    try {
      const queryStr = getQueryString();
      const res = await fetch(`/api/admin/prompts?${queryStr}`);
      if (!res.ok) throw new Error('Failed to fetch prompts data');

      const data = await res.json();
      currentPage = data.page || 1;
      totalPages = data.totalPages || 1;

      renderStats(data.stats || {});
      renderList(data.prompts || []);
      renderPagination(data.stats?.totalPrompts || 0);
      
      // Update developer dropdown list
      currentMembersList = data.members || [];
      renderMemberDropdown(currentMembersList);
    } catch (err) {
      console.error(err);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 30px; color: #ef4444;">❌ Error: ${esc(err.message)}</td></tr>`;
      }
    } finally {
      isFetching = false;
    }
  }

  function renderStats(stats) {
    const countEl = $('#prompt-stat-count');
    const inputEl = $('#prompt-stat-input');
    const outputEl = $('#prompt-stat-output');
    const cacheEl = $('#prompt-stat-cache');

    const totalPrompts = Number(stats.totalPrompts || 0);
    const totalInput = Number(stats.totalInput || 0);
    const totalOutput = Number(stats.totalOutput || 0);
    const totalCacheRead = Number(stats.totalCacheRead || 0);

    if (countEl) countEl.textContent = totalPrompts.toLocaleString();
    if (inputEl) inputEl.textContent = totalInput.toLocaleString();
    if (outputEl) outputEl.textContent = totalOutput.toLocaleString();
    
    if (cacheEl) {
      const ratio = totalInput > 0 ? (totalCacheRead / totalInput) * 100 : 0;
      cacheEl.textContent = `${ratio.toFixed(1)}%`;
    }
  }

  function renderList(prompts) {
    const tbody = $('#prompt-explorer-tbody');
    if (!tbody) return;

    if (!prompts.length) {
      tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; padding: 30px;" class="muted">No matching prompts found.</td></tr>';
      return;
    }

    tbody.innerHTML = prompts.map((p, idx) => `
      <tr class="prompt-explorer-row" data-idx="${idx}" style="cursor: pointer;">
        <td><code>${esc(p.sessionId.slice(0, 8))}...</code></td>
        <td><strong style="color: var(--brand);">${esc(p.userName)}</strong></td>
        <td><span class="badge-pill" style="font-size: 11px; padding: 2px 8px; background: rgba(255,255,255,0.05);">${esc(p.projectName)}</span></td>
        <td><code>${esc(p.tool || '—')}</code></td>
        <td><span style="font-size: 11px; color: var(--muted);">${esc(p.model || '—')}</span></td>
        <td>${Number(p.inputTokens || 0).toLocaleString()}</td>
        <td>${Number(p.outputTokens || 0).toLocaleString()}</td>
        <td style="color: #60a5fa;">${Number(p.cacheRead || 0).toLocaleString()}</td>
        <td style="color: #34d399;">${Number(p.cacheWrite || 0).toLocaleString()}</td>
        <td>${new Date(p.createdAt).toLocaleDateString()}</td>
        <td style="white-space: nowrap;">
          <button type="button" class="btn-toggle-view" data-idx="${idx}" style="background: none; border: none; color: var(--brand); font-weight: 500; font-size: 12px; cursor: pointer; padding: 2px 4px;">View 📂</button>
          <button type="button" class="btn-delete-prompt" data-idx="${idx}" style="background: none; border: none; color: #ef4444; font-size: 12px; cursor: pointer; padding: 2px 4px; margin-left: 4px;" title="Delete this prompt">🗑️</button>
        </td>
      </tr>
    `).join('');

    // Setup accordion toggles & delete buttons
    tbody.querySelectorAll('.prompt-explorer-row').forEach(row => {
      const idx = Number(row.dataset.idx);
      const p = prompts[idx];

      const toggleBtn = row.querySelector('.btn-toggle-view');
      const deleteBtn = row.querySelector('.btn-delete-prompt');

      deleteBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Are you sure you want to permanently delete this prompt from ${p.userName}?\n\n"${(p.promptText || '').slice(0, 100)}..."`)) {
          return;
        }

        try {
          deleteBtn.disabled = true;
          deleteBtn.textContent = '⏳';
          const res = await fetch('/api/admin/prompts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: p.id,
              sessionId: p.sessionId,
              turnIndex: p.turnIndex,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to delete prompt');

          alert('Prompt permanently deleted.');
          loadPrompts();
        } catch (err) {
          alert('Error deleting prompt: ' + err.message);
          deleteBtn.disabled = false;
          deleteBtn.textContent = '🗑️';
        }
      });

      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-prompt')) return;
        const nextRow = row.nextElementSibling;

        if (nextRow && nextRow.classList.contains('prompt-explore-detail-row')) {
          nextRow.remove();
          if (toggleBtn) toggleBtn.textContent = 'View 📂';
        } else {
          // Remove any other open details
          tbody.querySelectorAll('.prompt-explore-detail-row').forEach(el => {
            const prevToggle = el.previousElementSibling?.querySelector('.btn-toggle-view');
            if (prevToggle) prevToggle.textContent = 'View 📂';
            el.remove();
          });

          const detailRow = document.createElement('tr');
          detailRow.className = 'prompt-explore-detail-row';
          detailRow.style.background = 'rgba(0, 0, 0, 0.15)';
          detailRow.innerHTML = `
            <td colspan="11" style="padding: 16px 20px; text-align: left;">
              <div style="background: rgba(255,255,255,0.01); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                  <div style="font-size: 11px; font-weight: 600; color: var(--brand); text-transform: uppercase; letter-spacing: 0.05em;">Prompt Content (Turn #${p.turnIndex})</div>
                  <button type="button" class="btn-detail-delete" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; border-radius: 4px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer;">🗑️ Delete Prompt</button>
                </div>
                <pre style="white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; margin: 0; max-height: 250px; overflow-y: auto; color: var(--ink); line-height: 1.5; padding: 4px 0;">${esc(p.promptText || '—')}</pre>
              </div>
            </td>
          `;
          row.after(detailRow);
          if (toggleBtn) toggleBtn.textContent = 'Hide ❌';

          detailRow.querySelector('.btn-detail-delete')?.addEventListener('click', () => {
            deleteBtn?.click();
          });
        }
      });
    });
  }

  function renderMemberDropdown(members) {
    const dropdown = $('#prompt-member-multiselect-dropdown');
    if (!dropdown) return;

    // Remove any checked items that are no longer available in the scoped organization
    const availableIds = new Set(members.map(m => m.id));
    for (const id of selectedMembers) {
      if (!availableIds.has(id)) {
        selectedMembers.delete(id);
      }
    }

    let html = `
      <div style="display: flex; flex-direction: column; gap: 6px; text-align: left;">
        <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; padding: 4px 0; border-bottom: 1px solid var(--border); margin-bottom: 4px; color: var(--ink);">
          <input type="checkbox" id="prompt-member-all-checkbox" ${selectedMembers.size === 0 ? 'checked' : ''} />
          <span style="font-weight: 600;">— All Developers —</span>
        </label>
    `;

    members.forEach(m => {
      const isChecked = selectedMembers.has(m.id);
      html += `
        <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; padding: 2px 0; color: var(--muted); transition: color 0.1s;">
          <input type="checkbox" class="prompt-member-checkbox" data-id="${esc(m.id)}" data-name="${esc(m.name)}" ${isChecked ? 'checked' : ''} />
          <span>${esc(m.name)}</span>
        </label>
      `;
    });

    html += '</div>';
    dropdown.innerHTML = html;

    // Bind checkbox change events
    const allCheckbox = $('#prompt-member-all-checkbox');
    const memberCheckboxes = dropdown.querySelectorAll('.prompt-member-checkbox');

    allCheckbox?.addEventListener('change', () => {
      if (allCheckbox.checked) {
        selectedMembers.clear();
        memberCheckboxes.forEach(cb => cb.checked = false);
        updateMultiselectLabel();
        currentPage = 1;
        loadPrompts();
      }
    });

    memberCheckboxes.forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.id;
        if (cb.checked) {
          selectedMembers.add(id);
          if (allCheckbox) allCheckbox.checked = false;
        } else {
          selectedMembers.delete(id);
          if (selectedMembers.size === 0 && allCheckbox) {
            allCheckbox.checked = true;
          }
        }
        updateMultiselectLabel();
        currentPage = 1;
        loadPrompts();
      });
    });

    updateMultiselectLabel();
  }

  function updateMultiselectLabel() {
    const label = $('#prompt-member-multiselect-label');
    if (!label) return;

    if (selectedMembers.size === 0) {
      label.textContent = 'All Developers';
    } else if (selectedMembers.size === 1) {
      const checkedBox = $('#prompt-member-multiselect-dropdown .prompt-member-checkbox:checked');
      label.textContent = checkedBox ? checkedBox.dataset.name : '1 selected';
    } else {
      label.textContent = `${selectedMembers.size} selected`;
    }
  }

  function setupMultiselectDropdown() {
    const btn = $('#prompt-member-multiselect-btn');
    const dropdown = $('#prompt-member-multiselect-dropdown');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = dropdown.style.display === 'none' || dropdown.style.display === '';
      dropdown.style.display = isHidden ? 'block' : 'none';
    });

    document.addEventListener('click', (e) => {
      if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });
  }

  function renderPagination(totalPrompts) {
    const info = $('#prompts-pagination-info');
    const prevBtn = $('#prompts-prev-btn');
    const nextBtn = $('#prompts-next-btn');

    if (info) {
      if (totalPrompts === 0) {
        info.textContent = 'Showing 0-0 of 0 prompts';
      } else {
        const start = (currentPage - 1) * limitPerPage + 1;
        const end = Math.min(currentPage * limitPerPage, totalPrompts);
        info.textContent = `Showing ${start}-${end} of ${totalPrompts.toLocaleString()} prompts (Page ${currentPage} of ${totalPages})`;
      }
    }

    if (prevBtn) {
      prevBtn.disabled = currentPage <= 1;
      prevBtn.style.opacity = currentPage <= 1 ? '0.5' : '1';
      prevBtn.style.cursor = currentPage <= 1 ? 'not-allowed' : 'pointer';
    }

    if (nextBtn) {
      nextBtn.disabled = currentPage >= totalPages;
      nextBtn.style.opacity = currentPage >= totalPages ? '0.5' : '1';
      nextBtn.style.cursor = currentPage >= totalPages ? 'not-allowed' : 'pointer';
    }
  }

  function setupFilters() {
    $('#prompt-org-select')?.addEventListener('change', () => {
      selectedMembers.clear();
      updateMultiselectLabel();
      currentPage = 1;
      loadPrompts();
    });

    const filters = ['#prompt-range-select', '#prompt-tool-select'];
    filters.forEach(sel => {
      $(sel)?.addEventListener('change', () => {
        currentPage = 1;
        loadPrompts();
      });
    });

    const searchInput = $('#prompt-search-input');
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        currentPage = 1;
        loadPrompts();
      }, 350); // debounce keypress searching
    });
  }

  function setupRefresh() {
    $('#prompts-refresh-btn')?.addEventListener('click', () => {
      currentPage = 1;
      loadPrompts();
    });
  }

  function setupPaginationHandlers() {
    $('#prompts-prev-btn')?.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        loadPrompts();
      }
    });

    $('#prompts-next-btn')?.addEventListener('click', () => {
      if (currentPage < totalPages) {
        currentPage++;
        loadPrompts();
      }
    });
  }

  // Active listener
  window.addEventListener('prompts-tab-activated', () => {
    loadPrompts();
  });

  // Bootstrap
  init();
})();
