/**
 * master-app.js
 * SPA logic for the Master Office Automation Dashboard.
 * Three role-based views: User, Admin, Superadmin.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  role: null,       // 'user' | 'admin' | 'superadmin'
  user: null,       // selected user name (for 'user' role)
  currentView: null,
  cache: {},        // { [key]: { data, ts } }
  CACHE_TTL: 5 * 60 * 1000,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const landingScreen   = $('landing-screen');
const appShell        = $('app-shell');
const roleSelect      = $('role-select');
const userNameSelect  = $('user-name-select');
const userSelectWrap  = $('user-select-wrap');
const enterBtn        = $('enter-btn');
const sidebarNav      = $('sidebar-nav');
const sidebarFooter   = $('sidebar-footer');
const pageTitle       = $('page-title');
const pageSubtitle    = $('page-subtitle');
const mainContent     = $('main-content');
const refreshBtn      = $('refresh-btn');
const switchRoleBtn   = $('switch-role-btn');

// ─── Nav Configs ──────────────────────────────────────────────────────────────
const NAV = {
  user: [
    { id: 'my-sites',   icon: '🌐', label: 'My Sites' },
    { id: 'send-email-user', icon: '✉️', label: 'Send Email' },
  ],
  admin: [
    { id: 'admin-overview', icon: '📊', label: 'Overview' },
    { id: 'all-users',      icon: '👥', label: 'All Users' },
    { id: 'domain-expiry',  icon: '📅', label: 'Domain Expiry' },
    { id: 'distribution',   icon: '📋', label: 'Task Distribution' },
    { id: 'maint-overview', icon: '🔧', label: 'Maintenance Status' },
    { id: 'send-email-admin', icon: '✉️', label: 'Send Emails' },
    { id: 'sync-data',      icon: '🔄', label: 'Sync from Sheets' },
  ],
  superadmin: [
    { id: 'sa-overview',    icon: '🏠', label: 'Overview' },
    { id: 'all-users',      icon: '👥', label: 'All Users' },
    { id: 'domain-expiry',  icon: '📅', label: 'Domain Expiry' },
    { id: 'distribution',   icon: '📋', label: 'Task Distribution' },
    { id: 'maint-overview', icon: '🔧', label: 'Maintenance Status' },
    { id: 'dev-tracker',    icon: '💻', label: 'Dev Tracker' },
    { id: 'properties',     icon: '🏢', label: 'Property Registry' },
    { id: 'send-email-admin', icon: '✉️', label: 'Send Emails' },
    { id: 'sync-data',      icon: '🔄', label: 'Sync from Sheets' },
  ],
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `m-toast ${type}`;
  el.textContent = msg;
  $('m-toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function loading(msg = 'Loading...') {
  mainContent.innerHTML = `
    <div class="loading-state fade-in">
      <div class="spinner"></div>
      <div>${msg}</div>
    </div>`;
}

function empty(msg, icon = '📭') {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><div>${msg}</div></div>`;
}

async function apiFetch(url, opts = {}) {
  const key = url + JSON.stringify(opts);
  if (!opts.noCache && state.cache[key] && Date.now() - state.cache[key].ts < state.CACHE_TTL) {
    return state.cache[key].data;
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  if (!opts.noCache) state.cache[key] = { data, ts: Date.now() };
  return data;
}

function invalidateCache() { state.cache = {}; }

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function statusBadge(s) {
  const map = {
    completed: ['badge-completed','✅ Completed'],
    in_progress: ['badge-in_progress','⏳ In Progress'],
    todo: ['badge-todo','📌 To Do'],
    pending: ['badge-pending','— Pending'],
    sent: ['badge-sent','📨 Sent'],
    no: ['badge-pending','✗ No'],
  };
  const [cls, label] = map[s] || ['badge-pending', escHtml(s) || '—'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function daysLeftBadge(days) {
  if (days === null) return '<span class="text-muted">—</span>';
  if (days <= 0)  return `<span class="badge badge-urgent">⚠️ Expired</span>`;
  if (days <= 30) return `<span class="badge badge-urgent">🔴 ${days}d left</span>`;
  if (days <= 90) return `<span class="badge badge-warning">🟡 ${days}d left</span>`;
  return `<span class="badge badge-ok">🟢 ${days}d left</span>`;
}

// ─── Landing ──────────────────────────────────────────────────────────────────
async function initLanding() {
  const defaultUsers = ['Toufiq','Sabbir','Taion','Medul','Saiful','Tarikul','Roeich','Asif'];
  userNameSelect.innerHTML = defaultUsers.map(u => `<option value="${u}">${u}</option>`).join('');

  // Check if local DB is initialised
  try {
    const status = await apiFetch('/api/master/db-status', { noCache: true });
    if (!status.initialised) {
      const warn = document.createElement('div');
      warn.style.cssText = 'background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#fbbf24';
      warn.innerHTML = '⚠️ <strong>First time setup:</strong> After entering, go to <em>Sync from Sheets</em> to import all data.';
      document.querySelector('.landing-card').insertBefore(warn, document.querySelector('.btn-enter'));
    } else {
      const syncAgo = status.lastSync ? Math.round((Date.now() - new Date(status.lastSync)) / 60000) : null;
      const info = document.createElement('div');
      info.style.cssText = 'background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:12px;color:#34d399';
      info.textContent = `✅ Data ready · ${status.totalSites} sites · ${status.totalDomains} domains${syncAgo !== null ? ` · synced ${syncAgo}m ago` : ''}`;
      document.querySelector('.landing-card').insertBefore(info, document.querySelector('.btn-enter'));
    }
  } catch {}

  roleSelect.addEventListener('change', () => {
    userSelectWrap.classList.toggle('hidden', roleSelect.value !== 'user');
  });
  userSelectWrap.classList.remove('hidden');
}

enterBtn.addEventListener('click', () => {
  state.role = roleSelect.value;
  state.user = roleSelect.value === 'user' ? userNameSelect.value : null;
  landingScreen.classList.add('hidden');
  appShell.classList.remove('hidden');
  buildSidebar();
  const firstView = NAV[state.role][0].id;
  navigateTo(firstView);
});

switchRoleBtn.addEventListener('click', () => {
  invalidateCache();
  appShell.classList.add('hidden');
  landingScreen.classList.remove('hidden');
});

refreshBtn.addEventListener('click', () => {
  invalidateCache();
  navigateTo(state.currentView);
  toast('Data refreshed', 'success');
});

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function buildSidebar() {
  const items = NAV[state.role] || [];
  const roleLabel = { user: '👤 User', admin: '🔑 Admin', superadmin: '👑 Superadmin' }[state.role];

  sidebarNav.innerHTML = items.map(n => `
    <div class="nav-item" data-view="${n.id}">
      <span class="nav-icon">${n.icon}</span>
      <span>${n.label}</span>
    </div>`).join('');

  sidebarFooter.innerHTML = `
    <div style="font-weight:600;color:var(--text-muted);margin-bottom:4px">${roleLabel}</div>
    ${state.user ? `<div style="color:var(--accent-2)">${state.user}</div>` : ''}
  `;

  sidebarNav.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.view));
  });
}

function setActiveNav(viewId) {
  sidebarNav.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewId);
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────
async function navigateTo(viewId) {
  state.currentView = viewId;
  setActiveNav(viewId);

  const views = {
    'my-sites':        renderMySites,
    'send-email-user': renderSendEmailsLink,
    'admin-overview':  renderAdminOverview,
    'sa-overview':     renderAdminOverview,
    'all-users':       renderAllUsers,
    'domain-expiry':   renderDomainExpiry,
    'distribution':    renderDistribution,
    'maint-overview':  renderMaintenanceOverview,
    'dev-tracker':     renderDevTracker,
    'properties':      renderProperties,
    'send-email-admin':renderSendEmailsLink,
    'sync-data':       renderSync,
  };

  const fn = views[viewId];
  if (!fn) { mainContent.innerHTML = `<div class="empty-state">View not found: ${viewId}</div>`; return; }

  loading();
  try { await fn(); }
  catch (err) {
    mainContent.innerHTML = `<div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div style="color:var(--danger)">${escHtml(err.message)}</div>
    </div>`;
    toast(err.message, 'error');
  }
}

// ─── VIEW: My Sites ───────────────────────────────────────────────────────────
async function renderMySites() {
  pageTitle.textContent = `My Sites`;
  pageSubtitle.textContent = `${state.user}'s Daily Review`;

  const { sites } = await apiFetch(`/api/master/daily-review?user=${encodeURIComponent(state.user)}`);

  if (!sites.length) { mainContent.innerHTML = empty('No sites assigned to you yet.', '📭'); return; }

  const completed = sites.filter(s => s.maintenance === 'completed').length;
  const inProgress = sites.filter(s => s.maintenance === 'in_progress').length;
  const pending = sites.length - completed - inProgress;
  const pct = Math.round((completed / sites.length) * 100);

  mainContent.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid">
        <div class="stat-card purple"><div class="stat-value">${sites.length}</div><div class="stat-label">Total Sites</div></div>
        <div class="stat-card green"><div class="stat-value">${completed}</div><div class="stat-label">Completed</div></div>
        <div class="stat-card yellow"><div class="stat-value">${inProgress}</div><div class="stat-label">In Progress</div></div>
        <div class="stat-card blue"><div class="stat-value">${pending}</div><div class="stat-label">Pending</div></div>
      </div>

      <div class="section-card">
        <div class="section-header">
          <span class="section-title">Today's Progress</span>
          <span class="section-subtitle">${pct}% complete</span>
        </div>
        <div class="progress-bar-wrap" style="margin-bottom:24px">
          <div class="progress-bar-fill" style="width:${pct}%"></div>
        </div>

        <div class="filter-row">
          <input class="search-input" id="sites-search" placeholder="🔍 Search websites..." />
          <select class="status-select" id="sites-filter">
            <option value="">All Status</option>
            <option value="completed">Completed</option>
            <option value="in_progress">In Progress</option>
            <option value="pending">Pending</option>
          </select>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Website</th>
                <th>Company</th>
                <th>Maintenance</th>
                <th>Report Sent</th>
                <th>GA4</th>
                <th>Cloudflare</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="sites-tbody">
              ${sites.map((s, i) => renderSiteRow(s, i, state.user)).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  // Search + filter
  const tbody = $('sites-tbody');
  const searchInput = $('sites-search');
  const filterSelect = $('sites-filter');

  function filterTable() {
    const q = searchInput.value.toLowerCase();
    const f = filterSelect.value;
    tbody.querySelectorAll('tr').forEach(tr => {
      const url = tr.dataset.url || '';
      const status = tr.dataset.status || '';
      const matchQ = !q || url.includes(q);
      const matchF = !f || status === f;
      tr.style.display = matchQ && matchF ? '' : 'none';
    });
  }

  searchInput.addEventListener('input', filterTable);
  filterSelect.addEventListener('change', filterTable);

  // Status update listeners — saves to local DB
  tbody.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async e => {
      const { siteUrl, field } = e.target.dataset;
      const value = e.target.value;
      const updates = { [field + 'Raw']: value, [field]: value.toLowerCase().replace(' ', '_') };
      try {
        await apiFetch('/api/master/update-row', {
          method: 'POST',
          noCache: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: state.user, url: siteUrl, updates }),
        });
        toast(`Updated to "${value}"`, 'success');
        invalidateCache();
      } catch (err) {
        toast(`Failed: ${err.message}`, 'error');
      }
    });
  });
}

function renderSiteRow(s, i, user) {
  const statusOpts = ['Completed', 'In Progress', 'To Do', 'Pending'].map(o =>
    `<option value="${o}" ${s.maintenanceRaw === o ? 'selected' : ''}>${o}</option>`
  ).join('');
  const reportOpts = ['Yes', 'No', 'To Do'].map(o =>
    `<option value="${o}" ${s.reportSentRaw === o ? 'selected' : ''}>${o}</option>`
  ).join('');

  return `
    <tr data-url="${escHtml(s.url.toLowerCase())}" data-status="${s.maintenance}">
      <td style="color:var(--text-dim)">${i + 1}</td>
      <td class="url-cell"><a href="${escHtml(s.url)}" target="_blank">${escHtml(s.url.replace(/^https?:\/\//, '').slice(0,40))}</a></td>
      <td><span class="badge ${s.company === 'CW' ? 'badge-todo' : 'badge-pending'}">${escHtml(s.company)}</span></td>
      <td>
        <select class="status-select" data-site-url="${escHtml(s.url)}" data-field="maintenance">
          ${statusOpts}
        </select>
      </td>
      <td>
        <select class="status-select" data-site-url="${escHtml(s.url)}" data-field="reportSent">
          ${reportOpts}
        </select>
      </td>
      <td style="font-size:12px;color:var(--text-muted)">${escHtml(s.ga4 || '—')}</td>
      <td style="font-size:12px">${s.cloudflare === 'No' ? '<span class="text-success">✓</span>' : escHtml(s.cloudflare || '—')}</td>
      <td>
        ${s.clickupLink ? `<a class="btn btn-ghost btn-sm" href="${escHtml(s.clickupLink)}" target="_blank">ClickUp</a>` : ''}
        ${s.bookingLink ? `<a class="btn btn-ghost btn-sm" href="${escHtml(s.bookingLink)}" target="_blank">Booking</a>` : ''}
      </td>
    </tr>`;
}

// ─── VIEW: Admin Overview ─────────────────────────────────────────────────────
async function renderAdminOverview() {
  pageTitle.textContent = 'Overview';
  pageSubtitle.textContent = 'Team progress at a glance';

  const [{ summary }, { domains }] = await Promise.all([
    apiFetch('/api/master/summary'),
    apiFetch('/api/master/domain-expiry'),
  ]);

  const totalSites = summary.reduce((a, u) => a + u.total, 0);
  const totalCompleted = summary.reduce((a, u) => a + u.completed, 0);
  const totalReports = summary.reduce((a, u) => a + u.reportSent, 0);
  const urgentDomains = domains.filter(d => d.urgent).length;
  const overallPct = totalSites ? Math.round((totalCompleted / totalSites) * 100) : 0;

  mainContent.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid">
        <div class="stat-card purple"><div class="stat-value">${totalSites}</div><div class="stat-label">Total Sites</div><div class="stat-sub">Across all users</div></div>
        <div class="stat-card green"><div class="stat-value">${totalCompleted}</div><div class="stat-label">Completed</div><div class="stat-sub">${overallPct}% done</div></div>
        <div class="stat-card blue"><div class="stat-value">${totalReports}</div><div class="stat-label">Reports Sent</div></div>
        <div class="stat-card red"><div class="stat-value">${urgentDomains}</div><div class="stat-label">Urgent Domains</div><div class="stat-sub">Expiring ≤30 days</div></div>
      </div>

      <div class="section-card">
        <div class="section-header">
          <span class="section-title">Overall Progress</span>
          <span class="section-subtitle">${overallPct}% complete</span>
        </div>
        <div class="progress-bar-wrap" style="margin-bottom:24px">
          <div class="progress-bar-fill" style="width:${overallPct}%"></div>
        </div>

        <div class="user-grid">
          ${summary.map(u => {
            const pct = u.total ? Math.round((u.completed / u.total) * 100) : 0;
            return `
              <div class="user-card" onclick="navigateTo('all-users')">
                <div class="user-avatar">${u.user[0]}</div>
                <div class="user-name">${u.user}</div>
                <div class="user-stats">${u.completed}/${u.total} completed · ${u.reportSent} reports sent</div>
                <div class="user-progress">
                  <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-bottom:4px">
                    <span>Progress</span><span>${pct}%</span>
                  </div>
                  <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>

      ${urgentDomains > 0 ? `
      <div class="section-card" style="border-color:rgba(248,113,113,.3)">
        <div class="section-header">
          <span class="section-title" style="color:var(--danger)">⚠️ Urgent Domain Expirations</span>
          <span class="section-subtitle">${urgentDomains} expiring within 30 days</span>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Website</th><th>Company</th><th>A/C Manager</th><th>Days Left</th></tr></thead>
          <tbody>
            ${domains.filter(d => d.urgent).map(d => `
              <tr>
                <td class="url-cell"><a href="https://${escHtml(d.url)}" target="_blank">${escHtml(d.url)}</a></td>
                <td>${escHtml(d.company)}</td>
                <td>${escHtml(d.accountManager)}</td>
                <td>${daysLeftBadge(d.daysLeft)}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>` : ''}
    </div>`;
}

// ─── VIEW: All Users ──────────────────────────────────────────────────────────
async function renderAllUsers() {
  pageTitle.textContent = 'All Users';
  pageSubtitle.textContent = 'Detailed view per technician';

  const allData = await apiFetch('/api/master/daily-review-all');

  const userNames = Object.keys(allData);

  mainContent.innerHTML = `
    <div class="fade-in">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">
        ${userNames.map(u => `<button class="btn btn-ghost" id="tab-${u}" onclick="showUserDetail('${u}')">${u}</button>`).join('')}
      </div>
      <div id="user-detail-area"></div>
    </div>`;

  window._allUsersData = allData;
  showUserDetail(userNames[0]);
}

window.showUserDetail = function(user) {
  document.querySelectorAll('[id^="tab-"]').forEach(b => b.classList.remove('btn-primary'));
  const tab = $(`tab-${user}`);
  if (tab) { tab.classList.remove('btn-ghost'); tab.classList.add('btn-primary'); }

  const sites = window._allUsersData[user] || [];
  const area = $('user-detail-area');
  if (!sites.length) { area.innerHTML = empty(`No sites found for ${user}`); return; }

  area.innerHTML = `
    <div class="section-card">
      <div class="section-header">
        <span class="section-title">${user}'s Sites (${sites.length})</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Website</th><th>Company</th><th>Maintenance</th><th>Report Sent</th><th>GA4</th><th>ClickUp</th></tr></thead>
        <tbody>
          ${sites.map((s, i) => `
            <tr>
              <td style="color:var(--text-dim)">${i + 1}</td>
              <td class="url-cell"><a href="${escHtml(s.url)}" target="_blank">${escHtml(s.url.replace(/^https?:\/\//, '').slice(0,40))}</a></td>
              <td><span class="badge ${s.company === 'CW' ? 'badge-todo' : 'badge-pending'}">${escHtml(s.company)}</span></td>
              <td>${statusBadge(s.maintenance)}</td>
              <td>${s.reportSentRaw?.toLowerCase() === 'yes' ? '<span class="badge badge-sent">✅ Sent</span>' : '<span class="badge badge-pending">✗ No</span>'}</td>
              <td style="font-size:12px;color:var(--text-muted)">${escHtml(s.ga4 || '—')}</td>
              <td>${s.clickupLink ? `<a class="btn btn-ghost btn-sm" href="${escHtml(s.clickupLink)}" target="_blank">↗</a>` : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;
};

// ─── VIEW: Domain Expiry ──────────────────────────────────────────────────────
async function renderDomainExpiry() {
  pageTitle.textContent = 'Domain Expiration';
  pageSubtitle.textContent = 'All tracked domains sorted by urgency';

  const { domains } = await apiFetch('/api/master/domain-expiry');
  domains.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));

  const urgent = domains.filter(d => d.urgent).length;
  const warning = domains.filter(d => d.warning).length;

  mainContent.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid">
        <div class="stat-card purple"><div class="stat-value">${domains.length}</div><div class="stat-label">Total Domains</div></div>
        <div class="stat-card red"><div class="stat-value">${urgent}</div><div class="stat-label">Urgent (≤30d)</div></div>
        <div class="stat-card yellow"><div class="stat-value">${warning}</div><div class="stat-label">Warning (≤90d)</div></div>
        <div class="stat-card green"><div class="stat-value">${domains.length - urgent - warning}</div><div class="stat-label">OK</div></div>
      </div>

      <div class="section-card">
        <div class="section-header">
          <span class="section-title">All Domains</span>
        </div>
        <div class="filter-row">
          <input class="search-input" id="domain-search" placeholder="🔍 Search domain..." />
          <select class="status-select" id="domain-filter" style="max-width:200px">
            <option value="">All</option>
            <option value="urgent">Urgent (≤30d)</option>
            <option value="warning">Warning (≤90d)</option>
            <option value="ok">OK</option>
          </select>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Status</th><th>Website</th><th>Company</th><th>A/C Manager</th><th>CMS</th><th>Expiry Date</th><th>Days Left</th></tr></thead>
          <tbody id="domain-tbody">
            ${domains.map(d => {
              const urgency = d.urgent ? 'urgent' : d.warning ? 'warning' : 'ok';
              return `<tr data-url="${escHtml((d.url || '').toLowerCase())}" data-urgency="${urgency}">
                <td><span class="badge ${d.status === 'Active' ? 'badge-completed' : 'badge-pending'}">${escHtml(d.status)}</span></td>
                <td class="url-cell"><a href="https://${escHtml(d.url)}" target="_blank">${escHtml(d.url)}</a></td>
                <td>${escHtml(d.company)}</td>
                <td>${escHtml(d.accountManager)}</td>
                <td style="font-size:12px;color:var(--text-muted)">${escHtml(d.cms)}</td>
                <td style="font-size:12px">${escHtml(d.expiryDate)}</td>
                <td>${daysLeftBadge(d.daysLeft)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>
      </div>
    </div>`;

  $('domain-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    const f = $('domain-filter').value;
    $('domain-tbody').querySelectorAll('tr').forEach(tr => {
      const url = tr.dataset.url || '';
      const urgency = tr.dataset.urgency || '';
      tr.style.display = ((!q || url.includes(q)) && (!f || urgency === f)) ? '' : 'none';
    });
  });
  $('domain-filter').addEventListener('change', e => e.target.dispatchEvent(new Event('change')) || $('domain-search').dispatchEvent(new Event('input')));
}

// ─── VIEW: Distribution ───────────────────────────────────────────────────────
async function renderDistribution() {
  pageTitle.textContent = 'Task Distribution';
  pageSubtitle.textContent = 'Assignments from Distribution & Work Sheet';

  const { tasks, taskLoad } = await apiFetch('/api/master/distribution');

  const statusCounts = {};
  tasks.forEach(t => { statusCounts[t.status] = (statusCounts[t.status] || 0) + 1; });

  mainContent.innerHTML = `
    <div class="fade-in">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">

        <div class="section-card" style="margin-bottom:0">
          <div class="section-header"><span class="section-title">👥 Task Load</span></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Team Member</th><th>Tasks On Hand</th><th>Details</th></tr></thead>
            <tbody>
              ${taskLoad.map(m => `
                <tr>
                  <td><strong>${escHtml(m.member)}</strong></td>
                  <td><span class="badge ${m.taskCount > 5 ? 'badge-urgent' : m.taskCount > 2 ? 'badge-warning' : 'badge-completed'}">${m.taskCount}</span></td>
                  <td>${m.taskLink ? `<a class="btn btn-ghost btn-sm" href="${escHtml(m.taskLink)}" target="_blank">↗ View</a>` : '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>
        </div>

        <div class="section-card" style="margin-bottom:0">
          <div class="section-header"><span class="section-title">📊 Status Breakdown</span></div>
          ${Object.entries(statusCounts).map(([s, c]) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
              <span>${escHtml(s) || '(blank)'}</span>
              <span class="badge badge-todo">${c}</span>
            </div>`).join('')}
        </div>
      </div>

      <div class="section-card">
        <div class="section-header"><span class="section-title">All Tasks (${tasks.length})</span></div>
        <div class="filter-row">
          <input class="search-input" id="dist-search" placeholder="🔍 Search website or task..." />
          <select class="status-select" id="dist-assignee" style="max-width:160px">
            <option value="">All Assignees</option>
            ${[...new Set(tasks.map(t => t.assignee).filter(Boolean))].map(a => `<option value="${a}">${a}</option>`).join('')}
          </select>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Task</th><th>Website</th><th>Type</th><th>Assignee</th><th>Status</th><th>Priority</th><th>A/C Mgr</th><th>Link</th></tr></thead>
          <tbody id="dist-tbody">
            ${tasks.map(t => `
              <tr data-q="${escHtml((t.taskName + t.website).toLowerCase())}" data-assignee="${escHtml(t.assignee)}">
                <td style="max-width:180px;white-space:normal">${escHtml(t.taskName)}</td>
                <td style="font-size:12px;color:var(--info)">${escHtml(t.website)}</td>
                <td><span class="badge badge-todo" style="font-size:10px">${escHtml(t.taskType)}</span></td>
                <td>${escHtml(t.assignee)}</td>
                <td>${statusBadge(t.status.toLowerCase().replace(' ', '_')) || escHtml(t.status)}</td>
                <td><span class="badge ${t.priority === 'High' ? 'badge-urgent' : t.priority === 'Medium' ? 'badge-warning' : 'badge-pending'}" style="font-size:10px">${escHtml(t.priority)}</span></td>
                <td style="font-size:12px">${escHtml(t.accountManager)}</td>
                <td>${t.clickupLink ? `<a class="btn btn-ghost btn-sm" href="${escHtml(t.clickupLink)}" target="_blank">↗</a>` : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    </div>`;

  function filterDist() {
    const q = $('dist-search').value.toLowerCase();
    const a = $('dist-assignee').value;
    $('dist-tbody').querySelectorAll('tr').forEach(tr => {
      tr.style.display = ((!q || tr.dataset.q.includes(q)) && (!a || tr.dataset.assignee === a)) ? '' : 'none';
    });
  }
  $('dist-search').addEventListener('input', filterDist);
  $('dist-assignee').addEventListener('change', filterDist);
}

// ─── VIEW: Maintenance Overview ───────────────────────────────────────────────
async function renderMaintenanceOverview() {
  pageTitle.textContent = 'Maintenance Status';
  pageSubtitle.textContent = 'CW + RM site maintenance overview';

  const { sites } = await apiFetch('/api/master/maintenance-overview');

  const cw = sites.filter(s => s.account === 'CW');
  const rm = sites.filter(s => s.account === 'RM');
  const updated = sites.filter(s => s.latestMonthStatus?.toLowerCase().includes('updated'));

  mainContent.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid">
        <div class="stat-card purple"><div class="stat-value">${sites.length}</div><div class="stat-label">Total Sites</div></div>
        <div class="stat-card blue"><div class="stat-value">${cw.length}</div><div class="stat-label">CW Sites</div></div>
        <div class="stat-card green"><div class="stat-value">${rm.length}</div><div class="stat-label">RM Sites</div></div>
        <div class="stat-card green"><div class="stat-value">${updated.length}</div><div class="stat-label">Updated This Month</div></div>
      </div>

      <div class="section-card">
        <div class="section-header"><span class="section-title">All Sites</span></div>
        <div class="filter-row">
          <input class="search-input" id="maint-search" placeholder="🔍 Search URL..." />
          <select class="status-select" id="maint-acct" style="max-width:140px">
            <option value="">All Accounts</option>
            <option value="CW">CW</option>
            <option value="RM">RM</option>
          </select>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Account</th><th>Status</th><th>Website URL</th><th>CMS</th><th>Latest Month</th><th>Monthly Status</th><th>Links</th></tr></thead>
          <tbody id="maint-tbody">
            ${sites.map(s => `
              <tr data-url="${escHtml(s.url.toLowerCase())}" data-acct="${s.account}">
                <td><span class="badge ${s.account === 'CW' ? 'badge-todo' : 'badge-pending'}">${s.account}</span></td>
                <td><span class="badge ${s.status === 'Active' ? 'badge-completed' : 'badge-pending'}" style="font-size:10px">${escHtml(s.status)}</span></td>
                <td class="url-cell"><a href="https://${escHtml(s.url)}" target="_blank">${escHtml(s.url.slice(0,45))}</a></td>
                <td style="font-size:12px;color:var(--text-muted)">${escHtml(s.cms)}</td>
                <td style="font-size:11px;color:var(--text-dim)">${escHtml(s.latestMonth)}</td>
                <td>${s.latestMonthStatus ? `<span class="badge ${s.latestMonthStatus.toLowerCase().includes('updated') ? 'badge-completed' : s.latestMonthStatus.toLowerCase().includes('progress') ? 'badge-in_progress' : 'badge-pending'}" style="font-size:10px">${escHtml(s.latestMonthStatus.slice(0,22))}</span>` : '—'}</td>
                <td style="display:flex;gap:6px;flex-wrap:wrap">
                  ${s.reportUrl ? `<a class="btn btn-ghost btn-sm" href="${escHtml(s.reportUrl)}" target="_blank">Report</a>` : ''}
                  ${s.clickupUrl ? `<a class="btn btn-ghost btn-sm" href="${escHtml(s.clickupUrl)}" target="_blank">ClickUp</a>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    </div>`;

  function filterMaint() {
    const q = $('maint-search').value.toLowerCase();
    const a = $('maint-acct').value;
    $('maint-tbody').querySelectorAll('tr').forEach(tr => {
      tr.style.display = ((!q || tr.dataset.url.includes(q)) && (!a || tr.dataset.acct === a)) ? '' : 'none';
    });
  }
  $('maint-search').addEventListener('input', filterMaint);
  $('maint-acct').addEventListener('change', filterMaint);
}

// ─── VIEW: Dev Tracker ────────────────────────────────────────────────────────
async function renderDevTracker() {
  pageTitle.textContent = 'Dev Tracker';
  pageSubtitle.textContent = 'Web development project status';

  const { projects } = await apiFetch('/api/master/dev-tracker');
  if (!projects.length) { mainContent.innerHTML = empty('No dev projects found.', '💻'); return; }

  let activeProject = projects[0].project;

  function renderProjectContent(projectName) {
    const proj = projects.find(p => p.project === projectName);
    if (!proj) return '';
    const done = proj.items.filter(i => i.status?.toLowerCase().includes('completed')).length;
    return `
      <div class="section-card">
        <div class="section-header">
          <span class="section-title">${escHtml(proj.project)}</span>
          <span class="section-subtitle">${done}/${proj.items.length} completed</span>
        </div>
        <div class="progress-bar-wrap" style="margin-bottom:20px">
          <div class="progress-bar-fill" style="width:${proj.items.length ? Math.round(done/proj.items.length*100) : 0}%"></div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>URL</th><th>Status</th><th>Date</th><th>Notes</th><th>Feedback</th></tr></thead>
          <tbody>
            ${proj.items.map(item => `
              <tr>
                <td class="url-cell" style="max-width:200px"><a href="${escHtml(item.url)}" target="_blank">${escHtml(item.url.replace(/^https?:\/\//,'').slice(0,40))}</a></td>
                <td><span class="badge ${item.status?.toLowerCase().includes('completed') ? 'badge-completed' : 'badge-in_progress'}">${escHtml(item.status)}</span></td>
                <td style="font-size:12px;color:var(--text-muted);white-space:nowrap">${escHtml(item.date)}</td>
                <td style="font-size:12px;max-width:250px;white-space:normal">${escHtml((item.notes || '').slice(0,120))}${item.notes?.length > 120 ? '…' : ''}</td>
                <td>${item.feedbackUrl && !item.feedbackUrl.includes('Feedback-1') ? `<a class="btn btn-ghost btn-sm" href="${escHtml(item.feedbackUrl)}" target="_blank">↗ Feedback</a>` : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
  }

  mainContent.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid">
        <div class="stat-card purple"><div class="stat-value">${projects.length}</div><div class="stat-label">Projects</div></div>
        <div class="stat-card green"><div class="stat-value">${projects.reduce((a,p) => a + p.items.filter(i => i.status?.toLowerCase().includes('completed')).length, 0)}</div><div class="stat-label">Pages Done</div></div>
        <div class="stat-card blue"><div class="stat-value">${projects.reduce((a,p) => a + p.items.length, 0)}</div><div class="stat-label">Total Pages</div></div>
      </div>
      <div class="project-tabs">
        ${projects.map(p => `<div class="project-tab ${p.project === activeProject ? 'active' : ''}" data-proj="${escHtml(p.project)}">${escHtml(p.project)}</div>`).join('')}
      </div>
      <div id="dev-content">${renderProjectContent(activeProject)}</div>
    </div>`;

  mainContent.querySelectorAll('.project-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      mainContent.querySelectorAll('.project-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $('dev-content').innerHTML = renderProjectContent(tab.dataset.proj);
    });
  });
}

// ─── VIEW: Property Registry ──────────────────────────────────────────────────
async function renderProperties() {
  pageTitle.textContent = 'Property Registry';
  pageSubtitle.textContent = 'All managed properties';

  const { properties } = await apiFetch('/api/master/properties');

  const active = properties.filter(p => p.status?.toLowerCase() === 'active');
  const seo = properties.filter(p => p.seo?.toLowerCase() === 'yes');

  mainContent.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid">
        <div class="stat-card purple"><div class="stat-value">${properties.length}</div><div class="stat-label">Total Properties</div></div>
        <div class="stat-card green"><div class="stat-value">${active.length}</div><div class="stat-label">Active</div></div>
        <div class="stat-card blue"><div class="stat-value">${seo.length}</div><div class="stat-label">With SEO</div></div>
      </div>

      <div class="section-card">
        <div class="section-header"><span class="section-title">All Properties</span></div>
        <div class="filter-row">
          <input class="search-input" id="prop-search" placeholder="🔍 Search property..." />
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Property Name</th><th>URL</th><th>Type</th><th>Status</th><th>SEO</th><th>H&M</th><th>SEO Task</th><th>Web Task</th></tr></thead>
          <tbody id="prop-tbody">
            ${properties.map(p => `
              <tr data-q="${escHtml((p.name + p.url).toLowerCase())}">
                <td style="font-weight:600">${escHtml(p.name)}</td>
                <td class="url-cell"><a href="${escHtml(p.url)}" target="_blank">${escHtml(p.url.replace(/^https?:\/\//,'').slice(0,35))}</a></td>
                <td style="font-size:12px;color:var(--text-muted)">${escHtml(p.type)}</td>
                <td><span class="badge ${p.status?.toLowerCase() === 'active' ? 'badge-completed' : 'badge-pending'}">${escHtml(p.status)}</span></td>
                <td><span class="badge ${p.seo?.toLowerCase() === 'yes' ? 'badge-completed' : 'badge-pending'}">${escHtml(p.seo || '—')}</span></td>
                <td style="font-size:12px;color:var(--text-muted)">${escHtml(p.hm || '—')}</td>
                <td style="font-size:12px;color:var(--text-muted);max-width:150px;white-space:normal">${escHtml(p.seoTask || '—')}</td>
                <td style="font-size:12px;color:var(--text-muted);max-width:150px;white-space:normal">${escHtml(p.webTask || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    </div>`;

  $('prop-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $('prop-tbody').querySelectorAll('tr').forEach(tr => {
      tr.style.display = !q || tr.dataset.q.includes(q) ? '' : 'none';
    });
  });
}

// ─── VIEW: Send Emails (link to existing dashboard) ───────────────────────────
async function renderSendEmailsLink() {
  pageTitle.textContent = 'Send Emails';
  pageSubtitle.textContent = 'Launch the Maintenance Mailer';

  mainContent.innerHTML = `
    <div class="fade-in" style="max-width:500px;margin:60px auto;text-align:center">
      <div style="font-size:64px;margin-bottom:20px">✉️</div>
      <h2 style="font-size:22px;font-weight:700;margin-bottom:12px">Maintenance Email Sender</h2>
      <p style="color:var(--text-muted);margin-bottom:32px">
        The email dashboard lets you preview, customise, and send maintenance reports to all clients.
      </p>
      <a href="/" class="btn btn-primary" style="font-size:16px;padding:14px 32px">
        Open Email Dashboard →
      </a>
    </div>`;
}

// ─── VIEW: Sync from Sheets ────────────────────────────────────────────────────
async function renderSync() {
  pageTitle.textContent = 'Sync from Sheets';
  pageSubtitle.textContent = 'Import latest data from all 6 Google Sheets';

  // Check current DB status
  let status = {};
  try { status = await apiFetch('/api/master/db-status', { noCache: true }); } catch {}

  mainContent.innerHTML = `
    <div class="fade-in" style="max-width:640px;margin:0 auto">
      <div class="section-card">
        <div class="section-header"><span class="section-title">📊 Current Database Status</span></div>
        <div class="stat-grid" style="margin-bottom:0">
          <div class="stat-card ${status.initialised ? 'green' : 'yellow'}">
            <div class="stat-value">${status.totalSites || 0}</div>
            <div class="stat-label">Sites (CW+RM)</div>
          </div>
          <div class="stat-card blue">
            <div class="stat-value">${status.totalDomains || 0}</div>
            <div class="stat-label">Domains tracked</div>
          </div>
          <div class="stat-card purple">
            <div class="stat-value">${status.totalUserSites || 0}</div>
            <div class="stat-label">User site rows</div>
          </div>
          <div class="stat-card ${status.initialised ? 'green' : 'red'}">
            <div class="stat-value">${status.initialised ? '✓' : '✗'}</div>
            <div class="stat-label">${status.initialised ? 'DB ready' : 'Needs sync'}</div>
          </div>
        </div>
        ${status.lastSync ? `<div style="margin-top:16px;font-size:12px;color:var(--text-muted)">Last synced: ${new Date(status.lastSync).toLocaleString()}</div>` : ''}
      </div>

      <div class="section-card">
        <div class="section-header"><span class="section-title">🔄 Sync All Sheets</span></div>
        <p style="color:var(--text-muted);margin-bottom:20px;font-size:13px">
          This will import data from all 6 Google Sheets into the local database.
          Takes 2–4 minutes due to API rate limits. After sync, all dashboard views load instantly.
        </p>
        <div id="sync-progress" class="hidden" style="margin-bottom:20px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:6px">
            <span id="sync-step">Starting…</span>
            <span id="sync-pct">0%</span>
          </div>
          <div class="progress-bar-wrap" style="height:10px">
            <div class="progress-bar-fill" id="sync-bar" style="width:0%;transition:width .3s ease"></div>
          </div>
          <div id="sync-log" style="margin-top:12px;font-size:11px;color:var(--text-dim);max-height:120px;overflow-y:auto"></div>
        </div>
        <div id="sync-result" class="hidden"></div>
        <button class="btn btn-primary" id="sync-btn" style="padding:12px 28px;font-size:15px">
          🔄 Start Sync
        </button>
      </div>
    </div>`;

  $('sync-btn').addEventListener('click', async () => {
    const btn = $('sync-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Syncing…';
    $('sync-progress').classList.remove('hidden');
    $('sync-result').classList.add('hidden');

    const bar = $('sync-bar');
    const step = $('sync-step');
    const pct  = $('sync-pct');
    const log  = $('sync-log');

    try {
      const evtSource = new EventSource('/api/master/sync-sse');
      // We'll use fetch with EventSource workaround via POST + SSE
      // Actually trigger sync via POST with Accept: text/event-stream
      const response = await fetch('/api/master/sync', {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const msg = JSON.parse(line.slice(6));
            if (msg.step) {
              step.textContent = msg.step;
              pct.textContent = `${msg.pct}%`;
              bar.style.width = `${msg.pct}%`;
              const entry = document.createElement('div');
              entry.textContent = `${msg.pct}% — ${msg.step}`;
              log.appendChild(entry);
              log.scrollTop = log.scrollHeight;
            }
            if (msg.done) {
              bar.style.width = '100%';
              pct.textContent = '100%';
              step.textContent = `✅ Done in ${msg.elapsed}s`;
              $('sync-result').classList.remove('hidden');
              $('sync-result').innerHTML = `
                <div style="background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.3);border-radius:8px;padding:16px;color:var(--success);font-size:14px;font-weight:600">
                  ✅ Sync complete in ${msg.elapsed}s — all data imported!<br>
                  <span style="font-size:12px;font-weight:400;color:var(--text-muted)">Navigate to any view to see the data.</span>
                </div>`;
              invalidateCache();
              btn.textContent = '🔄 Sync Again';
              btn.disabled = false;
            }
            if (msg.error) throw new Error(msg.error);
          } catch {}
        }
      }
    } catch (err) {
      $('sync-result').classList.remove('hidden');
      $('sync-result').innerHTML = `<div style="background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.3);border-radius:8px;padding:16px;color:var(--danger)">${escHtml(err.message)}</div>`;
      btn.textContent = '🔄 Retry Sync';
      btn.disabled = false;
      toast(err.message, 'error');
    }
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
initLanding();
