const fs = require('fs');
const path = require('path');

const replacementCode = `// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: ALL USERS (Admin/Superadmin) — Reorganized Master Sites & Team Progress
// ═══════════════════════════════════════════════════════════════════════════════
async function viewAllUsers() {
  setPage('Team Progress', 'Live organization-wide websites, assignments & maintenance tracker');
  let summary = [];
  let noticeBannerHtml = '';
  let sites = [];
  let dailyReviewRows = [];

  try {
    const [sData, nHtml, sitesData, drData] = await Promise.all([
      GET('/api/master/summary').catch(() => ({ summary: [] })),
      getNoticeBannerHtml().catch(() => ''),
      GET('/api/master/sites').catch(() => ({ sites: [] })),
      GET('/api/master/daily-review').catch(() => ({ rows: [] }))
    ]);
    summary = sData.summary || [];
    noticeBannerHtml = nHtml || '';
    sites = sitesData.sites || [];
    dailyReviewRows = drData.rows || [];
  } catch (e) {
    toast(e.message, 'error');
  }

  if (!S.users || !S.users.length) {
    try {
      const uRes = await GET('/api/master/users');
      S.users = uRes.users || [];
    } catch {}
  }

  if (!sites.length && !summary.length) {
    mainEl.innerHTML = \`<div class="empty-state"><div class="empty-icon">🌐</div><p>No websites or team data synced yet.</p></div>\`;
    return;
  }

  // Pre-index daily review rows by siteId and normalized URL
  const siteDrMap = {};
  dailyReviewRows.forEach(r => {
    if (r.siteId && !siteDrMap[r.siteId]) siteDrMap[r.siteId] = r;
    if (r.siteUrl) {
      const cleanU = (r.siteUrl || '').toLowerCase().trim();
      if (!siteDrMap[cleanU]) siteDrMap[cleanU] = r;
    }
  });

  // Helper to get assigned user objects for a site
  function getAssignedUsersForSite(s) {
    const res = [];
    const ids = Array.isArray(s.assignedUsers) ? s.assignedUsers : [];
    ids.forEach(uid => {
      const u = S.users.find(x => x.id === uid);
      if (u) res.push(u);
    });
    // Fallback: check daily review row
    if (!res.length) {
      const dr = siteDrMap[s.id] || siteDrMap[(s.url || '').toLowerCase().trim()];
      if (dr && dr.userName) {
        const u = S.users.find(x => x.name === dr.userName);
        if (u) res.push(u);
        else res.push({ id: dr.userId || '', name: dr.userName, role: 'user' });
      }
    }
    return res;
  }

  // Compute metrics
  const totalSites = sites.length;
  const activeSites = sites.filter(s => !(s.status || '').toLowerCase().includes('deactiv'));
  const deactSites = sites.filter(s => (s.status || '').toLowerCase().includes('deactiv'));
  const unassignedSites = sites.filter(s => !s.assignedUsers || s.assignedUsers.length === 0);
  const assignedSites = sites.filter(s => s.assignedUsers && s.assignedUsers.length > 0);

  const completedReviews = dailyReviewRows.filter(r => r.maintenanceStatus === 'completed').length;
  const inProgReviews = dailyReviewRows.filter(r => r.maintenanceStatus === 'in_progress').length;
  const totalReviews = dailyReviewRows.length || 1;
  const overallPct = Math.round((completedReviews / totalReviews) * 100);

  const isSmart = S.tableMode !== 'full';
  const memberTabs = summary.filter(u => u.total > 0);

  // Render Shell
  mainEl.innerHTML = \`
    <div class="fade-in team-progress-page">
      \${noticeBannerHtml}

      <!-- Top KPI Metric Strip -->
      <div class="team-kpi-strip">
        <div class="team-kpi-card accent" id="kpi-card-all" title="View all websites">
          <div class="kpi-icon-wrap">\${getSvg('globe', 18)}</div>
          <div class="kpi-content">
            <div class="kpi-value" id="kpi-val-total">\${totalSites}</div>
            <div class="kpi-label">Total Websites</div>
          </div>
        </div>

        <div class="team-kpi-card success" id="kpi-card-assigned" title="View assigned websites">
          <div class="kpi-icon-wrap">\${getSvg('user', 18)}</div>
          <div class="kpi-content">
            <div class="kpi-value" id="kpi-val-assigned">\${assignedSites.length}</div>
            <div class="kpi-label">Assigned Websites</div>
          </div>
        </div>

        <div class="team-kpi-card \${unassignedSites.length > 0 ? 'warning cursor-pointer' : 'dim'}" id="kpi-card-unassigned" title="Click to filter unassigned websites">
          <div class="kpi-icon-wrap">⚠️</div>
          <div class="kpi-content">
            <div class="kpi-value" id="kpi-val-unassigned">\${unassignedSites.length}</div>
            <div class="kpi-label">\${unassignedSites.length > 0 ? 'Unassigned (Action Needed)' : 'All Assigned'}</div>
          </div>
        </div>

        <div class="team-kpi-card info" id="kpi-card-status" title="Active vs Deactivated websites">
          <div class="kpi-icon-wrap">\${getSvg('activity', 18)}</div>
          <div class="kpi-content">
            <div class="kpi-value">\${activeSites.length} <span style="font-size:13px;font-weight:400;color:var(--text-muted)">/ \${deactSites.length} off</span></div>
            <div class="kpi-label">Active vs Deactivated</div>
          </div>
        </div>

        <div class="team-kpi-card \${overallPct >= 80 ? 'success' : 'primary'}">
          <div class="kpi-icon-wrap">\${getSvg('check', 18)}</div>
          <div class="kpi-content">
            <div class="kpi-value">\${overallPct}%</div>
            <div class="kpi-label">\${completedReviews}/\${dailyReviewRows.length} Reviews Done</div>
          </div>
          <div class="progress-wrap kpi-progress-bar"><div class="progress-fill" style="width:\${overallPct}%"></div></div>
        </div>
      </div>

      <!-- Main Navigation Strip (Tabs + Action Buttons) -->
      <div class="team-nav-strip">
        <div class="team-tabs-row" id="team-main-tabs">
          <button class="team-tab-pill active" data-tab="all">
            🌐 All Websites <span class="tab-pill-badge">\${totalSites}</span>
          </button>
          <button class="team-tab-pill \${unassignedSites.length > 0 ? 'pill-warn' : ''}" data-tab="unassigned">
            ⚠️ Unassigned <span class="tab-pill-badge">\${unassignedSites.length}</span>
          </button>
          <button class="team-tab-pill" data-tab="active">
            🟢 Active <span class="tab-pill-badge">\${activeSites.length}</span>
          </button>
          <button class="team-tab-pill" data-tab="deactive">
            ⚪ Deactivated <span class="tab-pill-badge">\${deactSites.length}</span>
          </button>
          <button class="team-tab-pill" data-tab="members">
            👥 By Member <span class="tab-pill-badge">\${memberTabs.length}</span>
          </button>
        </div>

        <div class="team-nav-actions">
          <div class="view-mode-toggle" id="team-table-mode-toggle">
            <button class="btn btn-sm mode-btn \${isSmart ? 'active' : ''}" data-mode="smart" title="Smart Fit 100vw - Compact &amp; responsive">⚡ Smart Fit</button>
            <button class="btn btn-sm mode-btn \${!isSmart ? 'active' : ''}" data-mode="full" title="Spreadsheet mode - Full spread">📋 Full Spread</button>
          </div>
          <button class="btn btn-secondary btn-sm" id="btn-export-team-csv" title="Export visible websites to CSV">📥 Export CSV</button>
          <button class="btn btn-primary btn-sm" id="btn-team-add-site">➕ Add Website</button>
        </div>
      </div>

      <!-- Member Filter Sub-Bar -->
      <div class="member-pills-container hidden" id="member-pills-bar">
        <div class="member-pills-track">
          <button class="member-pill-btn active" data-uid="all">
            <span>All Members (\${totalSites})</span>
          </button>
          \${memberTabs.map(u => \`
            <button class="member-pill-btn" data-uid="\${u.userId}" data-uname="\${esc(u.user)}">
              <span class="member-pill-avatar">\${esc((u.user || 'U')[0].toUpperCase())}</span>
              <span class="member-pill-name">\${esc(u.user)}</span>
              <span class="badge badge-\${u.pct >= 100 ? 'success' : u.pct > 50 ? 'info' : 'warning'} badge-xs">\${u.pct}%</span>
              <span class="member-pill-count">(\${u.completed}/\${u.total})</span>
            </button>
          \`).join('')}
        </div>
      </div>

      <!-- Member Focus Banner -->
      <div class="member-focus-banner hidden" id="member-focus-banner">
        <div class="mfb-left">
          <span class="mfb-avatar" id="mfb-avatar">U</span>
          <div>
            <div class="mfb-title" id="mfb-title">Member Sites</div>
            <div class="mfb-subtitle" id="mfb-subtitle">0 sites assigned</div>
          </div>
        </div>
        <div class="mfb-right">
          <div class="mfb-progress-wrap">
            <span class="mfb-pct" id="mfb-pct">0% complete</span>
            <div class="progress-wrap" style="width:120px"><div class="progress-fill" id="mfb-progress-fill" style="width:0%"></div></div>
          </div>
          <button class="btn btn-secondary btn-sm" id="btn-member-assign-sites">➕ Assign Websites to Member</button>
          <button class="btn btn-ghost btn-sm" id="btn-member-clear-focus" title="Show all websites">✕ Clear Filter</button>
        </div>
      </div>

      <!-- Control & Filter Toolbar -->
      <div class="team-filter-bar">
        <div class="tf-left">
          <!-- Search input -->
          <div class="search-wrap team-search-wrap">
            \${getSvg('search', 13)}
            <input id="team-search-input" class="search-input" placeholder="Search URL, client, assignee, manager…" style="font-size:12px">
            <button class="search-clear-btn hidden" id="btn-clear-search">✕</button>
          </div>

          <!-- Account Filter -->
          <select class="form-select select-sm tf-select" id="tf-account">
            <option value="">All Accounts (CW &amp; RM)</option>
            <option value="CW">CW (Cogwheel)</option>
            <option value="RM">RM (RevMax)</option>
          </select>

          <!-- Site Status Filter -->
          <select class="form-select select-sm tf-select" id="tf-status">
            <option value="">All Status (Active &amp; Deact)</option>
            <option value="active">🟢 Active Sites Only</option>
            <option value="deactive">⚪ Deactivated Only</option>
          </select>

          <!-- Assignee Filter -->
          <select class="form-select select-sm tf-select" id="tf-assignee">
            <option value="">All Assignees</option>
            <option value="__unassigned__">⚠️ Unassigned Only</option>
            \${S.users.map(u => \`<option value="\${u.id}">\${esc(u.name)} (\${esc(u.role || 'user')})</option>\`).join('')}
          </select>

          <!-- Maintenance Filter -->
          <select class="form-select select-sm tf-select" id="tf-maintenance">
            <option value="">All Maintenance</option>
            <option value="completed">Completed</option>
            <option value="in_progress">In Progress</option>
            <option value="todo">To Do</option>
            <option value="pending">Pending</option>
          </select>

          <button class="btn btn-ghost btn-sm" id="btn-reset-filters" style="font-size:11.5px">Reset</button>
        </div>

        <div class="tf-right">
          <span class="tf-count-text" id="tf-match-count">\${totalSites} websites showing</span>
        </div>
      </div>

      <!-- Master Table Card -->
      <div class="card team-table-card">
        <div class="table-wrap">
          <table class="\${isSmart ? 'table-smart-fit' : 'table-full-spread'}" id="team-master-table">
            <thead>
              \${isSmart ? \`
                <tr>
                  <th class="col-select" style="text-align:center;width:38px">
                    <input type="checkbox" class="select-all-checkbox" title="Select all sites" />
                  </th>
                  <th class="col-url" style="min-width:210px">Website &amp; Account</th>
                  <th class="col-assignee" style="min-width:180px">Assigned Developer</th>
                  <th class="col-site-status" style="width:110px">Site Status</th>
                  <th class="col-maint" style="min-width:200px">Maintenance &amp; Report</th>
                  <th class="col-links">Tasks &amp; Links</th>
                  <th class="col-integ">GA4 / Integrations</th>
                  <th class="col-actions" style="text-align:right;width:95px">Actions</th>
                </tr>
              \` : \`
                <tr>
                  <th style="width:38px;text-align:center">
                    <input type="checkbox" class="select-all-checkbox" title="Select all sites" />
                  </th>
                  <th style="min-width:180px">Website URL</th>
                  <th style="min-width:130px">Client / Company</th>
                  <th style="width:75px">Account</th>
                  <th style="min-width:170px">Assigned Developer</th>
                  <th style="width:110px">Site Status</th>
                  <th style="width:130px">Maintenance</th>
                  <th style="width:105px">Report Sent</th>
                  <th style="width:105px">ClickUp</th>
                  <th style="width:125px">GA4 Report</th>
                  <th style="width:110px">Domain Expiry</th>
                  <th style="width:85px">Uptime</th>
                  <th style="text-align:right;width:95px">Actions</th>
                </tr>
              \`}
            </thead>
            <tbody id="team-master-tbody">
              \${sites.map((s, idx) => renderTeamSiteRow(s, idx, isSmart ? 'smart' : 'full', siteDrMap, getAssignedUsersForSite(s))).join('')}
            </tbody>
          </table>
        </div>

        <!-- Sticky Bulk Dock -->
        <div class="bulk-dock hidden" id="bulk-dock">
          <div class="bulk-dock-count"><span id="bulk-selected-count">0</span> sites selected</div>
          <div class="bulk-dock-controls">
            <select class="form-select select-sm" id="bulk-maint-status" style="width:130px;background:var(--bg-surface-3);color:#fff;border-color:var(--border)">
              <option value="">— Maintenance —</option>
              <option value="completed">Completed</option>
              <option value="in_progress">In Progress</option>
              <option value="todo">To Do</option>
            </select>
            <select class="form-select select-sm" id="bulk-report-status" style="width:110px;background:var(--bg-surface-3);color:#fff;border-color:var(--border)">
              <option value="">— Report —</option>
              <option value="sent">Sent (Yes)</option>
              <option value="no">No</option>
            </select>
            <select class="form-select select-sm select-ga4-status" id="bulk-ga4-status" style="width:125px;border-radius:6px">
              <option value="">— GA4 Status —</option>
              <option value="Completed">Completed</option>
              <option value="In Progress">In Progress</option>
              <option value="Pending">Pending</option>
              <option value="No GA4 Tag">No GA4 Tag</option>
              <option value="N/A">N/A</option>
            </select>
            <button class="btn btn-primary btn-sm" id="btn-apply-bulk">Apply Updates</button>
            <button class="btn btn-secondary btn-sm" id="btn-bulk-assign" title="Assign all selected sites to developer">👥 Bulk Assign</button>
            <button class="btn btn-secondary btn-sm" id="btn-bulk-uptime" title="Check uptime for all selected sites">↺ Check Uptime</button>
            <button class="btn btn-ghost btn-sm" id="btn-clear-selection" title="Clear selection">✕</button>
          </div>
        </div>
      </div>
    </div>
  \`;

  // Attach notice modal
  mainEl.querySelectorAll('.btn-open-notices').forEach(btn => btn.addEventListener('click', openNoticeBoardModal));

  // State for filtering
  let activeTab = 'all';
  let focusedUserId = null;
  let filterAcct = '';
  let filterStatus = '';
  let filterAssignee = '';
  let filterMaint = '';

  const tbody = $('team-master-tbody');
  const allRows = [...tbody.querySelectorAll('tr:not(.detail-accordion-row)')];

  function applyTeamFilters() {
    const q = ($('team-search-input')?.value || '').toLowerCase().trim();
    $('btn-clear-search')?.classList.toggle('hidden', !q);

    let matchCount = 0;
    allRows.forEach(tr => {
      const url = tr.dataset.url || '';
      const comp = tr.dataset.company || '';
      const acm = tr.dataset.acm || '';
      const acc = tr.dataset.account || '';
      const st = tr.dataset.status || '';
      const maint = tr.dataset.maint || '';
      const assignees = tr.dataset.assignees || '';
      const assigneeIds = (tr.dataset.assigneeIds || '').split(',').filter(Boolean);
      const isUnassigned = tr.dataset.unassigned === 'true';

      // 1. Tab check
      let matchTab = true;
      if (activeTab === 'unassigned') matchTab = isUnassigned;
      else if (activeTab === 'active') matchTab = st === 'active';
      else if (activeTab === 'deactive') matchTab = st === 'deactive';
      else if (activeTab === 'members' && focusedUserId) matchTab = assigneeIds.includes(focusedUserId);

      // 2. Focused member check
      if (focusedUserId && !assigneeIds.includes(focusedUserId)) matchTab = false;

      // 3. Search query
      let matchSearch = true;
      if (q) {
        matchSearch = url.includes(q) || comp.includes(q) || acm.includes(q) || assignees.includes(q);
      }

      // 4. Dropdown filters
      let matchAcct = !filterAcct || acc === filterAcct;
      let matchStatus = !filterStatus || st === filterStatus;
      let matchMaint = !filterMaint || maint.toLowerCase() === filterMaint.toLowerCase();

      let matchAssignee = true;
      if (filterAssignee === '__unassigned__') matchAssignee = isUnassigned;
      else if (filterAssignee) matchAssignee = assigneeIds.includes(filterAssignee);

      const visible = matchTab && matchSearch && matchAcct && matchStatus && matchMaint && matchAssignee;
      tr.classList.toggle('hidden', !visible);
      const detailRow = $(\`detail-row-\${tr.dataset.id}\`);
      if (detailRow && !visible) detailRow.classList.add('hidden');
      if (visible) matchCount++;
    });

    const countEl = $('tf-match-count');
    if (countEl) countEl.textContent = \`\${matchCount} websites showing\`;
  }

  // Bind main tabs
  $('team-main-tabs')?.querySelectorAll('.team-tab-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      $('team-main-tabs').querySelectorAll('.team-tab-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;

      const memberBar = $('member-pills-bar');
      if (activeTab === 'members') {
        memberBar?.classList.remove('hidden');
      } else {
        memberBar?.classList.add('hidden');
        focusedUserId = null;
        $('member-focus-banner')?.classList.add('hidden');
        memberBar?.querySelectorAll('.member-pill-btn').forEach(b => b.classList.toggle('active', b.dataset.uid === 'all'));
      }
      applyTeamFilters();
    });
  });

  // KPI card shortcuts
  $('kpi-card-all')?.addEventListener('click', () => {
    const tabBtn = $('team-main-tabs')?.querySelector('.team-tab-pill[data-tab="all"]');
    if (tabBtn) tabBtn.click();
  });
  $('kpi-card-assigned')?.addEventListener('click', () => {
    const tabBtn = $('team-main-tabs')?.querySelector('.team-tab-pill[data-tab="all"]');
    if (tabBtn) tabBtn.click();
    const sel = $('tf-assignee');
    if (sel) { sel.value = ''; filterAssignee = ''; applyTeamFilters(); }
  });
  $('kpi-card-unassigned')?.addEventListener('click', () => {
    const tabBtn = $('team-main-tabs')?.querySelector('.team-tab-pill[data-tab="unassigned"]');
    if (tabBtn) tabBtn.click();
  });
  $('kpi-card-status')?.addEventListener('click', () => {
    const tabBtn = $('team-main-tabs')?.querySelector('.team-tab-pill[data-tab="active"]');
    if (tabBtn) tabBtn.click();
  });

  // Member sub-pills click
  $('member-pills-bar')?.querySelectorAll('.member-pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $('member-pills-bar').querySelectorAll('.member-pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const uid = btn.dataset.uid;
      const uname = btn.dataset.uname;

      if (uid === 'all') {
        focusedUserId = null;
        $('member-focus-banner')?.classList.add('hidden');
      } else {
        focusedUserId = uid;
        const u = summary.find(x => x.userId === uid) || {};
        const banner = $('member-focus-banner');
        if (banner) {
          banner.classList.remove('hidden');
          $('mfb-avatar').textContent = (uname || 'U')[0].toUpperCase();
          $('mfb-title').textContent = \`\${uname}'s Assigned Websites\`;
          $('mfb-subtitle').textContent = \`\${u.total || 0} sites assigned (\${u.completed || 0} completed)\`;
          $('mfb-pct').textContent = \`\${u.pct || 0}% complete\`;
          $('mfb-progress-fill').style.width = \`\${u.pct || 0}%\`;

          // Assign more button
          const assignMoreBtn = $('btn-member-assign-sites');
          if (assignMoreBtn) {
            assignMoreBtn.onclick = () => {
              openAssignSitesToUserModal(uid, uname, () => viewAllUsers());
            };
          }
        }
      }
      applyTeamFilters();
    });
  });

  // Clear focus banner button
  $('btn-member-clear-focus')?.addEventListener('click', () => {
    focusedUserId = null;
    $('member-focus-banner')?.classList.add('hidden');
    $('member-pills-bar')?.querySelectorAll('.member-pill-btn').forEach(b => b.classList.toggle('active', b.dataset.uid === 'all'));
    applyTeamFilters();
  });

  // Search input and clear
  $('team-search-input')?.addEventListener('input', applyTeamFilters);
  $('btn-clear-search')?.addEventListener('click', () => {
    const input = $('team-search-input');
    if (input) { input.value = ''; applyTeamFilters(); }
  });

  // Dropdown filter changes
  $('tf-account')?.addEventListener('change', e => { filterAcct = e.target.value; applyTeamFilters(); });
  $('tf-status')?.addEventListener('change', e => { filterStatus = e.target.value; applyTeamFilters(); });
  $('tf-assignee')?.addEventListener('change', e => { filterAssignee = e.target.value; applyTeamFilters(); });
  $('tf-maintenance')?.addEventListener('change', e => { filterMaint = e.target.value; applyTeamFilters(); });

  // Reset filters button
  $('btn-reset-filters')?.addEventListener('click', () => {
    $('team-search-input').value = '';
    $('tf-account').value = ''; filterAcct = '';
    $('tf-status').value = ''; filterStatus = '';
    $('tf-assignee').value = ''; filterAssignee = '';
    $('tf-maintenance').value = ''; filterMaint = '';
    $('team-main-tabs')?.querySelector('.team-tab-pill[data-tab="all"]')?.click();
    applyTeamFilters();
  });

  // Mode toggle (Smart Fit vs Full Spread)
  $('team-table-mode-toggle')?.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      S.tableMode = mode;
      try { localStorage.setItem('officeos_table_mode', mode); } catch {}
      viewAllUsers();
    });
  });

  // Add website button
  $('btn-team-add-site')?.addEventListener('click', () => openAddSiteModal(() => viewAllUsers()));

  // Export CSV button
  $('btn-export-team-csv')?.addEventListener('click', () => {
    const visibleTrs = allRows.filter(tr => !tr.classList.contains('hidden'));
    const rowsToExport = visibleTrs.map(tr => {
      const id = tr.dataset.id;
      const s = sites.find(x => x.id === id);
      const dr = siteDrMap[id] || siteDrMap[(s?.url || '').toLowerCase().trim()] || {};
      return {
        siteUrl: s?.url || '',
        company: s?.company || s?.account || '',
        maintenanceRaw: dr.maintenanceRaw || dr.maintenanceStatus || '',
        reportSentRaw: dr.reportSentRaw || dr.reportSentStatus || '',
        clickupLink: dr.clickupLink || s?.clickupUrl || '',
        ga4: dr.ga4 || '',
        newsletterMail: dr.newsletterMail || '',
        formSubmissionMail: dr.formSubmissionMail || '',
        clientResponse: dr.clientResponse || '',
        bookingLink: dr.bookingLink || '',
        uptimeRobot: s?.uptimeStatus || '',
        cloudflare: dr.cloudflare || ''
      };
    });
    exportTableToCSV(rowsToExport, \`Team_Progress_Websites_\${new Date().toISOString().slice(0, 10)}.csv\`);
  });

  // Wire 1-Click Active/Deactive Toggle
  tbody.querySelectorAll('.btn-site-status-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const siteId = btn.dataset.siteId;
      const action = btn.dataset.action;
      const targetStatus = action === 'activate' ? 'Active' : 'Deactive';
      const s = sites.find(x => x.id === siteId);

      btn.disabled = true;
      const origText = btn.innerHTML;
      btn.innerHTML = \`<span class="status-indicator-dot"></span><span>Syncing…</span>\`;

      try {
        await PUT(\`/api/master/sites/\${siteId}/status\`, { status: targetStatus });
        toast(\`Site "\${s?.url || siteId}" marked as \${targetStatus} and synchronized with \${s?.account || 'CW'} Sheet!\`, 'success', 5000);
        if (s) s.status = targetStatus;

        // Update button UI & row attributes
        const isDeact = targetStatus === 'Deactive';
        btn.dataset.action = isDeact ? 'activate' : 'deactivate';
        btn.className = \`btn-site-status-toggle \${isDeact ? 'deactive' : 'active'}\`;
        btn.innerHTML = \`<span class="status-indicator-dot"></span><span class="status-label-text">\${targetStatus}</span>\`;
        btn.disabled = false;

        const tr = tbody.querySelector(\`tr[data-id="\${siteId}"]\`);
        if (tr) tr.dataset.status = isDeact ? 'deactive' : 'active';

        // Recalculate KPIs
        const newAct = sites.filter(x => !(x.status || '').toLowerCase().includes('deactiv')).length;
        const newDeact = sites.filter(x => (x.status || '').toLowerCase().includes('deactiv')).length;
        const actTabBadge = $('team-main-tabs')?.querySelector('.team-tab-pill[data-tab="active"] .tab-pill-badge');
        if (actTabBadge) actTabBadge.textContent = newAct;
        const deactTabBadge = $('team-main-tabs')?.querySelector('.team-tab-pill[data-tab="deactive"] .tab-pill-badge');
        if (deactTabBadge) deactTabBadge.textContent = newDeact;

        applyTeamFilters();
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = origText;
        toast(err.message, 'error');
      }
    });
  });

  // Wire Quick Assign Buttons
  tbody.querySelectorAll('.btn-assign-quick').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const siteId = btn.dataset.siteId;
      const s = sites.find(x => x.id === siteId);
      if (s) openAssignModal(siteId, s, () => viewAllUsers());
    });
  });

  // Wire Copy URL buttons
  tbody.querySelectorAll('.btn-copy-url').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const u = btn.dataset.url;
      if (u) {
        navigator.clipboard.writeText(u);
        toast(\`Copied "\${u}" to clipboard\`, 'info', 2000);
      }
    });
  });

  // Wire Details Accordion Toggle
  tbody.querySelectorAll('.toggle-detail-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const detailRow = $(\`detail-row-\${id}\`);
      const parentTr = tbody.querySelector(\`tr[data-id="\${id}"]:not(.detail-accordion-row)\`);
      if (detailRow) {
        const isHidden = detailRow.classList.contains('hidden');
        detailRow.classList.toggle('hidden', !isHidden);
        if (parentTr) parentTr.classList.toggle('active-row', isHidden);
        btn.innerHTML = isHidden ? '🔼' : getSvg('eye', 12);
      }
    });
  });

  // Click on row to toggle accordion
  tbody.querySelectorAll('tr.smart-row').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (['A', 'BUTTON', 'SELECT', 'INPUT'].includes(e.target.tagName) || e.target.closest('button, a, select, input')) return;
      const id = tr.dataset.id;
      const detailRow = $(\`detail-row-\${id}\`);
      const toggleBtn = tr.querySelector('.toggle-detail-btn');
      if (detailRow) {
        const isHidden = detailRow.classList.contains('hidden');
        detailRow.classList.toggle('hidden', !isHidden);
        tr.classList.toggle('active-row', isHidden);
        if (toggleBtn) toggleBtn.innerHTML = isHidden ? '🔼' : getSvg('eye', 12);
      }
    });
  });

  // Wire Edit Site Metadata
  tbody.querySelectorAll('.edit-site-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const s = sites.find(x => x.id === id);
      if (s) editSiteModal(id, s);
    });
  });

  // Wire Edit Review Row Data
  tbody.querySelectorAll('.edit-dr-row-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const dr = dailyReviewRows.find(x => x.id === id) || siteDrMap[id];
      if (dr) editDailyReviewRowModal(dr, () => viewAllUsers());
      else {
        const s = sites.find(x => x.id === id);
        if (s) editSiteModal(id, s);
      }
    });
  });

  // Wire Report Sent 1-Click Toggle
  tbody.querySelectorAll('.btn-report-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { rowId, siteId, status } = btn.dataset;
      if (!rowId) {
        toast('Assign a developer first to track daily review report', 'warning');
        return;
      }
      const newStatus = status === 'sent' ? 'no' : 'sent';
      const newRaw = newStatus === 'sent' ? 'Yes' : 'No';
      try {
        await PUT(\`/api/master/daily-review/\${rowId}\`, {
          reportSentStatus: newStatus,
          reportSentRaw: newRaw
        });
        btn.dataset.status = newStatus;
        btn.className = \`btn-report-toggle \${newStatus === 'sent' ? 'sent' : 'pending'}\`;
        btn.textContent = newStatus === 'sent' ? '✓ Sent' : '✉ No';
        toast(\`Report marked \${newRaw} & synced to Sheet\`, 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  // Wire Maintenance Select
  tbody.querySelectorAll('.team-maint-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const { rowId, siteId } = sel.dataset;
      const value = sel.value;
      if (!rowId) {
        toast('Assign a developer to sync maintenance row with Sheet', 'warning');
        return;
      }
      const normMap = { 'Completed': 'completed', 'In Progress': 'in_progress', 'To Do': 'todo', 'Pending': 'pending' };
      const normVal = normMap[value] || value.toLowerCase();
      try {
        await PUT(\`/api/master/daily-review/\${rowId}\`, {
          maintenanceStatus: normVal,
          maintenanceRaw: value
        });
        const tr = sel.closest('tr');
        if (tr) tr.dataset.maint = normVal;
        const sheetVal = (value === 'Completed' || normVal === 'completed') ? 'Updated & Backup' : value;
        toast(\`⚡ Status saved & synced to Google Sheet (\${sheetVal})\`, 'success', 3000);
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  // Wire GA4 Select
  tbody.querySelectorAll('.select-ga4-status').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const { rowId } = sel.dataset;
      if (!rowId) return;
      try {
        await PUT(\`/api/master/daily-review/\${rowId}\`, { ga4: sel.value });
        toast('GA4 status updated', 'success', 2000);
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  // Wire Bulk Dock & Uptime
  initTeamBulkDock(mainEl, sites, () => viewAllUsers());
}

function renderTeamSiteRow(s, idx, mode, siteDrMap, assignedList) {
  const isDeact = (s.status || '').toLowerCase().includes('deactiv');
  const cleanUrl = (s.url || '').trim();
  const href = cleanUrl.startsWith('http') ? cleanUrl : \`https://\${cleanUrl}\`;
  const dr = siteDrMap[s.id] || siteDrMap[cleanUrl.toLowerCase()] || {};
  const co = (s.company || s.account || 'CW').trim();

  const isOnline = s.uptimeStatus === 'online' || dr.uptimeStatus === 'online';
  const isOffline = s.uptimeStatus === 'offline' || dr.uptimeStatus === 'offline';
  const netSt = isOffline ? 'offline' : (isOnline ? 'online' : 'pending');
  const liveBall = \`<span class="live-network-icon \${netSt}" id="live-dot-\${dr.id || s.id}" title="\${isOffline ? 'Website Offline / Down' : (isOnline ? 'Website Active & Online' : 'Website Status: Unknown')}">\${getSvg('network', 11)}</span>\`;

  // Assigned Member Column HTML
  let assigneeHtml = '';
  if (assignedList && assignedList.length > 0) {
    assigneeHtml = \`
      <div class="team-assignee-cell">
        <div class="team-assignee-pills">
          \${assignedList.map(u => {
            const inits = (u.name || 'U').split(/\\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
            return \`
              <span class="team-assignee-pill" title="Assigned to \${esc(u.name)} (\${esc(u.role || 'user')})">
                <span class="assignee-avatar-mini">\${esc(inits)}</span>
                <span class="assignee-name-text">\${esc(u.name)}</span>
              </span>
            \`;
          }).join('')}
        </div>
        <button class="btn-assign-quick" data-site-id="\${s.id}" title="Reassign developer">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
    \`;
  } else {
    assigneeHtml = \`
      <div class="team-assignee-cell unassigned">
        <span class="badge badge-warning unassigned-badge" title="No developer assigned">⚠️ Unassigned</span>
        <button class="btn btn-xs btn-primary btn-assign-quick" data-site-id="\${s.id}" title="Assign team member">
          + Assign
        </button>
      </div>
    \`;
  }

  // Active / Deactive Toggle Button
  const statusToggleHtml = \`
    <button class="btn-site-status-toggle \${isDeact ? 'deactive' : 'active'}" 
            data-site-id="\${s.id}" 
            data-action="\${isDeact ? 'activate' : 'deactivate'}" 
            title="\${isDeact ? 'Click to Activate site & sync with Sheet' : 'Click to Deactivate site & archive in Sheet'}">
      <span class="status-indicator-dot"></span>
      <span class="status-label-text">\${isDeact ? 'Deactive' : 'Active'}</span>
    </button>
  \`;

  // Maintenance & Report
  const curMaint = (dr.maintenanceRaw || dr.maintenanceStatus || 'To Do');
  const maintOpts = ['Completed', 'In Progress', 'To Do', 'Pending'].map(o =>
    \`<option value="\${o}" \${curMaint.toLowerCase() === o.toLowerCase() ? 'selected' : ''}>\${o}</option>\`
  ).join('');

  const maintSelectHtml = \`
    <select class="status-select select-maint-compact team-maint-select" data-row-id="\${dr.id || ''}" data-site-id="\${s.id}">
      \${maintOpts}
    </select>
  \`;

  const isSent = (dr.reportSentStatus === 'sent' || (dr.reportSentRaw || '').toLowerCase() === 'yes');
  const reportBtnHtml = \`
    <button class="btn-report-toggle \${isSent ? 'sent' : 'pending'}" data-row-id="\${dr.id || ''}" data-site-id="\${s.id}" data-status="\${isSent ? 'sent' : 'no'}" title="Click to toggle Report Sent">
      \${isSent ? '✓ Sent' : '✉ No'}
    </button>
  \`;

  // ClickUp Link
  const cuLink = (dr.clickupLink || s.clickupUrl)
    ? \`<a href="\${esc(dr.clickupLink || s.clickupUrl)}" target="_blank" class="btn-clickup" title="\${esc(dr.clickupLink || s.clickupUrl)}">⚡ ClickUp</a>\`
    : '<span class="dim-dash">—</span>';

  // Booking Engine
  let bookHtml = '<span class="dim-dash">—</span>';
  if (dr.bookingLink) {
    if (/^https?:\\/\\//i.test(dr.bookingLink)) {
      bookHtml = \`<a href="\${esc(dr.bookingLink)}" target="_blank" class="btn-booking" title="\${esc(dr.bookingLink)}">🍽️ Booking ↗</a>\`;
    } else {
      const isYes = /yes/i.test(dr.bookingLink);
      bookHtml = \`<span class="cell-text-badge \${isYes ? 'badge-success' : 'badge-dim'}">\${esc(dr.bookingLink)}</span>\`;
    }
  }

  // GA4 Report
  const ga4Options = ['Completed', 'In Progress', 'Pending', 'No GA4 Tag', 'N/A'];
  const curGa4 = (dr.ga4 || 'No GA4 Tag').trim();
  const isDimGa4 = /no|n\\/a/i.test(curGa4);
  const ga4SelectHtml = \`
    <select class="select-ga4-status \${isDimGa4 ? 'val-dim' : ''}" data-row-id="\${dr.id || ''}" title="GA4 Report Status">
      \${ga4Options.map(o => \`<option value="\${o}" \${curGa4.toLowerCase() === o.toLowerCase() ? 'selected' : ''}>\${o}</option>\`).join('')}
    </select>
  \`;

  // Newsletter & Form
  let newsHtml = dr.newsletterMail ? \`<span class="cell-text-badge badge-purple" title="\${esc(dr.newsletterMail)}">\${esc(dr.newsletterMail)}</span>\` : '';
  let formHtml = dr.formSubmissionMail ? \`<span class="cell-text-badge badge-accent" title="\${esc(dr.formSubmissionMail)}">\${esc(dr.formSubmissionMail)}</span>\` : '';

  // Domain Expiry
  let expiryBadge = '<span class="dim-dash">—</span>';
  const expDays = s.daysLeft ?? dr.daysLeft;
  if (s.domainExpiry || dr.domainExpiry) {
    let cls = 'badge-expiry-safe';
    let txt = \`\${expDays}d left\`;
    if (expDays <= 0) { cls = 'badge-expiry-danger'; txt = 'EXPIRED'; }
    else if (expDays <= 30) { cls = 'badge-expiry-danger'; }
    else if (expDays <= 90) { cls = 'badge-expiry-warning'; }
    expiryBadge = \`<span class="\${cls}" title="Expires \${esc((s.domainExpiry || dr.domainExpiry).slice(0, 10))}">\${txt}</span>\`;
  }

  const assignedNames = assignedList.map(u => u.name.toLowerCase()).join(' ');
  const assignedIds = assignedList.map(u => u.id).join(',');
  const isUnassigned = assignedList.length === 0;

  if (mode === 'smart') {
    return \`
      <tr class="smart-row" 
          data-id="\${s.id}" 
          data-url="\${esc(cleanUrl.toLowerCase())}" 
          data-company="\${esc(co.toLowerCase())}" 
          data-account="\${esc(s.account || 'CW')}" 
          data-acm="\${esc((s.accountManager || '').toLowerCase())}"
          data-status="\${isDeact ? 'deactive' : 'active'}" 
          data-maint="\${esc((dr.maintenanceStatus || 'todo').toLowerCase())}" 
          data-assignees="\${esc(assignedNames)}" 
          data-assignee-ids="\${esc(assignedIds)}" 
          data-unassigned="\${isUnassigned}">
        
        <td class="col-select" style="text-align:center">
          <input type="checkbox" class="row-checkbox" data-row-id="\${dr.id || ''}" data-site-id="\${s.id}" data-url="\${esc(cleanUrl)}" data-company="\${esc(co)}" />
        </td>

        <td class="col-url" data-col="url">
          <div class="site-identity-cell">
            \${liveBall}
            <span class="badge badge-\${(s.account || 'CW').toLowerCase() === 'cw' ? 'cw' : 'rm'} badge-xs">\${esc(s.account || 'CW')}</span>
            <a href="\${esc(href)}" target="_blank" class="site-domain-link" title="\${esc(cleanUrl)}">
              \${esc(shortUrl(cleanUrl, 24))} <span class="ext-icon">↗</span>
            </a>
            <button class="btn-icon-micro btn-copy-url" data-url="\${esc(cleanUrl)}" title="Copy URL">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="btn-uptime-check" data-row-id="\${dr.id || s.id}" data-site-url="\${esc(cleanUrl)}" data-site-id="\${s.id}" title="Check live uptime now">↺</button>
          </div>
          \${s.company ? \`<div class="site-company-sub" title="\${esc(s.company)}">\${esc(s.company)}</div>\` : ''}
        </td>

        <td class="col-assignee">
          \${assigneeHtml}
        </td>

        <td class="col-site-status">
          \${statusToggleHtml}
        </td>

        <td class="col-maint">
          <div class="status-cell-grp">
            \${maintSelectHtml}
            \${reportBtnHtml}
          </div>
        </td>

        <td class="col-links">
          <div class="quick-links-grp">
            \${cuLink !== '<span class="dim-dash">—</span>' ? cuLink : ''}
            \${bookHtml !== '<span class="dim-dash">—</span>' ? bookHtml : ''}
            \${cuLink === '<span class="dim-dash">—</span>' && bookHtml === '<span class="dim-dash">—</span>' ? '<span class="dim-dash">—</span>' : ''}
          </div>
        </td>

        <td class="col-integ">
          <div class="integrations-pill-grp">
            \${ga4SelectHtml}
            \${newsHtml}
            \${formHtml}
          </div>
        </td>

        <td class="col-actions" style="text-align:right">
          <div class="actions-grp" style="justify-content:flex-end">
            <button class="btn btn-ghost btn-sm toggle-detail-btn" data-id="\${s.id}" title="View details accordion">\${getSvg('eye', 12)}</button>
            <button class="btn btn-ghost btn-sm edit-site-btn" data-id="\${s.id}" title="Edit site metadata">\${getSvg('edit', 12)}</button>
          </div>
        </td>
      </tr>

      <tr class="detail-accordion-row hidden" id="detail-row-\${s.id}" data-parent-id="\${s.id}">
        <td colspan="8">
          <div class="row-detail-bento">
            <div class="detail-bento-card">
              <div class="dbc-head">🌐 Website &amp; Client</div>
              <div class="dbc-row"><span class="dbc-lbl">Full URL:</span> <a href="\${esc(href)}" target="_blank" class="dbc-val">\${esc(cleanUrl)} ↗</a></div>
              <div class="dbc-row"><span class="dbc-lbl">Client Name:</span> <span class="dbc-val">\${esc(s.company || '—')}</span></div>
              <div class="dbc-row"><span class="dbc-lbl">Account Manager:</span> <span class="dbc-val">\${esc(s.accountManager || '—')}</span></div>
              <div class="dbc-row"><span class="dbc-lbl">CMS Platform:</span> <span class="badge badge-dim">\${esc(s.cms || 'Wordpress')}</span></div>
            </div>
            <div class="detail-bento-card">
              <div class="dbc-head">🛠️ Review &amp; Links</div>
              <div class="dbc-row"><span class="dbc-lbl">ClickUp Task:</span> \${s.clickupUrl || dr.clickupLink ? \`<a href="\${esc(s.clickupUrl || dr.clickupLink)}" target="_blank" class="btn-clickup">⚡ View Task ↗</a>\` : '<span class="dim-dash">—</span>'}</div>
              <div class="dbc-row"><span class="dbc-lbl">Drive Backup:</span> \${s.backupUrl ? \`<a href="\${esc(s.backupUrl)}" target="_blank" class="dbc-val">📁 Google Drive ↗</a>\` : '<span class="dim-dash">—</span>'}</div>
              <div class="dbc-row"><span class="dbc-lbl">Monthly Report:</span> \${s.reportUrl ? \`<a href="\${esc(s.reportUrl)}" target="_blank" class="dbc-val">📊 Sheet Report ↗</a>\` : '<span class="dim-dash">—</span>'}</div>
              <div class="dbc-row"><span class="dbc-lbl">Domain Expiry:</span> \${expiryBadge}</div>
            </div>
            <div class="detail-bento-card">
              <div class="dbc-head">👥 Assigned Developers</div>
              <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
                \${assignedList.length ? assignedList.map(u => \`
                  <div style="display:flex;align-items:center;gap:8px">
                    <span class="user-check-avatar" style="width:22px;height:22px;font-size:10px">\${esc(u.name[0].toUpperCase())}</span>
                    <span style="font-weight:500;font-size:12px">\${esc(u.name)}</span>
                    <span class="badge badge-dim badge-xs">\${esc(u.role || 'user')}</span>
                  </div>
                \`).join('') : '<span style="font-size:12px;color:var(--text-muted)">No developer assigned to this website yet.</span>'}
                <button class="btn btn-secondary btn-sm btn-assign-quick" data-site-id="\${s.id}" style="margin-top:6px;width:fit-content">
                  ✎ Manage Assignees
                </button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    \`;
  }

  // Full Spread Mode
  return \`
    <tr data-id="\${s.id}" 
        data-url="\${esc(cleanUrl.toLowerCase())}" 
        data-company="\${esc(co.toLowerCase())}" 
        data-account="\${esc(s.account || 'CW')}" 
        data-acm="\${esc((s.accountManager || '').toLowerCase())}"
        data-status="\${isDeact ? 'deactive' : 'active'}" 
        data-maint="\${esc((dr.maintenanceStatus || 'todo').toLowerCase())}" 
        data-assignees="\${esc(assignedNames)}" 
        data-assignee-ids="\${esc(assignedIds)}" 
        data-unassigned="\${isUnassigned}">
      
      <td style="text-align:center">
        <input type="checkbox" class="row-checkbox" data-row-id="\${dr.id || ''}" data-site-id="\${s.id}" data-url="\${esc(cleanUrl)}" data-company="\${esc(co)}" />
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          \${liveBall}
          <a href="\${esc(href)}" target="_blank" class="site-domain-link" title="\${esc(cleanUrl)}">
            \${esc(shortUrl(cleanUrl, 26))} ↗
          </a>
          <button class="btn-icon-micro btn-copy-url" data-url="\${esc(cleanUrl)}" title="Copy URL">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </td>
      <td><span style="font-size:12px">\${esc(s.company || '—')}</span></td>
      <td><span class="badge badge-\${(s.account || 'CW').toLowerCase() === 'cw' ? 'cw' : 'rm'}">\${esc(s.account || 'CW')}</span></td>
      <td>\${assigneeHtml}</td>
      <td>\${statusToggleHtml}</td>
      <td>\${maintSelectHtml}</td>
      <td>\${reportBtnHtml}</td>
      <td>\${cuLink}</td>
      <td>\${ga4SelectHtml}</td>
      <td>\${expiryBadge}</td>
      <td>\${uptimeDot(s.uptimeStatus || dr.uptimeStatus)}</td>
      <td style="text-align:right">
        <div style="display:inline-flex;gap:4px">
          <button class="btn btn-ghost btn-sm edit-site-btn" data-id="\${s.id}" title="Edit site">\${getSvg('edit', 12)}</button>
        </div>
      </td>
    </tr>
  \`;
}

function initTeamBulkDock(containerEl, sites, onRefresh) {
  const dock = containerEl.querySelector('#bulk-dock');
  const countEl = containerEl.querySelector('#bulk-selected-count');
  const selectAll = containerEl.querySelector('.select-all-checkbox');
  const rowCheckboxes = containerEl.querySelectorAll('.row-checkbox');

  function updateDock() {
    const checked = containerEl.querySelectorAll('.row-checkbox:checked');
    if (countEl) countEl.textContent = checked.length;
    if (dock) {
      if (checked.length > 0) dock.classList.remove('hidden');
      else dock.classList.add('hidden');
    }
    const visibleCheckboxes = [...rowCheckboxes].filter(cb => {
      const tr = cb.closest('tr');
      return tr && !tr.classList.contains('hidden');
    });
    if (selectAll && visibleCheckboxes.length > 0) {
      const checkedVisible = visibleCheckboxes.filter(cb => cb.checked);
      selectAll.checked = checkedVisible.length === visibleCheckboxes.length;
      selectAll.indeterminate = checkedVisible.length > 0 && checkedVisible.length < visibleCheckboxes.length;
    }
  }

  if (selectAll) {
    selectAll.addEventListener('change', () => {
      rowCheckboxes.forEach(cb => {
        const tr = cb.closest('tr');
        if (tr && !tr.classList.contains('hidden')) cb.checked = selectAll.checked;
      });
      updateDock();
    });
  }

  rowCheckboxes.forEach(cb => cb.addEventListener('change', updateDock));

  const clearBtn = containerEl.querySelector('#btn-clear-selection');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      rowCheckboxes.forEach(cb => cb.checked = false);
      updateDock();
    });
  }

  const applyBtn = containerEl.querySelector('#btn-apply-bulk');
  if (applyBtn) {
    applyBtn.addEventListener('click', async () => {
      const checked = [...containerEl.querySelectorAll('.row-checkbox:checked')];
      if (!checked.length) return;
      const rowIds = checked.map(cb => cb.dataset.rowId).filter(Boolean);
      const maintVal = ($('bulk-maint-status') || {}).value;
      const reportVal = ($('bulk-report-status') || {}).value;
      const ga4Val = ($('bulk-ga4-status') || {}).value;

      if (!maintVal && !reportVal && !ga4Val) {
        toast('Please select a Maintenance, Report, or GA4 status to apply', 'warning');
        return;
      }

      const updates = {};
      if (maintVal) {
        updates.maintenanceStatus = maintVal;
        updates.maintenanceRaw = maintVal === 'completed' ? 'Completed' : (maintVal === 'in_progress' ? 'In Progress' : 'To Do');
      }
      if (reportVal) {
        updates.reportSentStatus = reportVal;
        updates.reportSentRaw = reportVal === 'sent' ? 'Yes' : 'No';
      }
      if (ga4Val) {
        updates.ga4 = ga4Val;
      }

      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying…';
      try {
        if (rowIds.length) {
          await POST('/api/master/daily-review/batch', { ids: rowIds, updates });
        }
        toast(\`✅ Applied updates to \${checked.length} selected sites\`, 'success');
        if (onRefresh) onRefresh();
      } catch (e) {
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply Updates';
        toast(e.message, 'error');
      }
    });
  }

  // Bulk Assign Button
  const bulkAssignBtn = containerEl.querySelector('#btn-bulk-assign');
  if (bulkAssignBtn) {
    bulkAssignBtn.addEventListener('click', () => {
      const checked = [...containerEl.querySelectorAll('.row-checkbox:checked')];
      if (!checked.length) return;
      const siteIds = checked.map(cb => cb.dataset.siteId).filter(Boolean);

      openModal(\`Bulk Assign \${siteIds.length} Websites\`, \`
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
          Select team members to assign to all <strong>\${siteIds.length} selected websites</strong>.
        </div>
        <div class="user-assign-grid">
          \${S.users.map(u => \`
            <label class="user-check-item">
              <input type="checkbox" class="bulk-assign-user-checkbox" value="\${u.id}">
              <span class="user-check-avatar">\${esc((u.name || 'U')[0].toUpperCase())}</span>
              <div>
                <div class="user-check-name">\${esc(u.name)}</div>
                <div class="user-check-role">\${esc(u.role || 'user')}</div>
              </div>
            </label>
          \`).join('')}
        </div>
      \`, [
        { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
        {
          label: \`Assign to \${siteIds.length} Sites\`,
          cls: 'btn btn-primary',
          onClick: async () => {
            const selectedUserIds = [...document.querySelectorAll('.bulk-assign-user-checkbox:checked')].map(cb => cb.value);
            const saveBtn = document.querySelector('.modal-footer .btn-primary');
            if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Assigning…'; }

            try {
              await Promise.all(siteIds.map(id => POST(\`/api/master/sites/\${id}/assign\`, { userIds: selectedUserIds })));
              toast(\`🎉 Successfully assigned developers to \${siteIds.length} websites!\`, 'success', 5000);
              closeModal();
              if (onRefresh) onRefresh();
            } catch (err) {
              if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Assignments'; }
              toast(err.message, 'error');
            }
          }
        }
      ]);
    });
  }

  // Bulk Uptime Button
  const bulkUptimeBtn = containerEl.querySelector('#btn-bulk-uptime');
  if (bulkUptimeBtn) {
    bulkUptimeBtn.addEventListener('click', async () => {
      const checked = [...containerEl.querySelectorAll('.row-checkbox:checked')];
      if (!checked.length) return;
      toast(\`Checking live uptime for \${checked.length} sites…\`, 'info', 5000);
      bulkUptimeBtn.disabled = true;
      try {
        for (const cb of checked) {
          await POST('/api/master/check-uptime', {
            siteId: cb.dataset.siteId,
            url: cb.dataset.url
          }).catch(() => {});
        }
        toast(\`✅ Uptime checks completed for \${checked.length} sites\`, 'success');
        if (onRefresh) onRefresh();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        bulkUptimeBtn.disabled = false;
      }
    });
  }
}
`;

module.exports = { replacementCode };
