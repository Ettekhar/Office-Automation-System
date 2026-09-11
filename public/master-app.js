'use strict';
// ─── State ───────────────────────────────────────────────────────────────────
const S = {
  role: null,         // 'user'|'admin'|'superadmin'
  userId: null,
  userName: null,
  view: null,
  users: [],          // cached user list
  tableMode: 'smart', // 'smart'|'full'
};
try { S.tableMode = localStorage.getItem('officeos_table_mode') || 'smart'; } catch {}

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const landing  = $('landing-screen');
const appShell = $('app-shell');
const mainEl   = $('main-content');
const pageTitleEl    = $('page-title');
const pageSubtitleEl = $('page-subtitle');
const sidebarNavEl   = $('sidebar-nav');

// ─── API ──────────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const GET    = url => api(url);
const POST   = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
const PUT    = (url, body) => api(url, { method: 'PUT',  body: JSON.stringify(body) });
const DELETE = url => api(url, { method: 'DELETE' });

// ─── HTML escape ──────────────────────────────────────────────────────────────
const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal(title, bodyHtml, buttons = []) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  const footer = $('modal-footer');
  footer.innerHTML = '';
  buttons.forEach(({ label, cls = 'btn btn-primary', id, onClick }) => {
    const btn = document.createElement('button');
    btn.className = cls; btn.textContent = label;
    if (id) btn.id = id;
    if (onClick) btn.addEventListener('click', onClick);
    footer.appendChild(btn);
  });
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() { $('modal-overlay').classList.add('hidden'); }
$('modal-close').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) closeModal(); });

// ─── Page header ─────────────────────────────────────────────────────────────
function setPage(title, subtitle = '') {
  pageTitleEl.textContent = title;
  pageSubtitleEl.textContent = subtitle;
}

// ─── Badges ───────────────────────────────────────────────────────────────────
function uptimeDot(status) {
  const labels = { online: '🟢 Online', offline: '🔴 Offline', unknown: '⚪ Unknown' };
  return `<span class="uptime-dot ${status || 'unknown'}">${labels[status] || 'Unknown'}</span>`;
}
function statusBadge(s) {
  const map = {
    completed:'success', in_progress:'info', todo:'warning', pending:'dim',
    sent:'success', 'no':'danger',
  };
  const cls = map[s?.toLowerCase()] || 'dim';
  return `<span class="badge badge-${cls}">${esc(s||'—')}</span>`;
}
function domainBadge(days) {
  if (days === null || days === undefined) return '<span class="badge badge-dim">Unknown</span>';
  if (days <= 0)  return `<span class="badge badge-danger">Expired</span>`;
  if (days <= 30) return `<span class="badge badge-danger">${days}d left</span>`;
  if (days <= 90) return `<span class="badge badge-warning">${days}d left</span>`;
  return `<span class="badge badge-success">${days}d left</span>`;
}
function priorityBadge(p) {
  const map = { high:'danger', medium:'warning', low:'dim' };
  return `<span class="badge badge-${map[p?.toLowerCase()]||'dim'}">${esc(p||'—')}</span>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function userOptions(selectedId = '') {
  return S.users.map(u => `<option value="${u.id}" ${u.id===selectedId?'selected':''}>${esc(u.name)} (${u.role})</option>`).join('');
}
function shortUrl(url, max = 38) {
  const s = (url||'').replace(/^https?:\/\//, '').replace(/^www\./, '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ─── Sidebar Nav ──────────────────────────────────────────────────────────────
const NAV = {
  user: [
    { id:'my-sites',   icon:'🌐', label:'My Sites' },
    { id:'my-tasks',   icon:'✅', label:'My Tasks' },
  ],
  admin: [
    { id:'overview',      icon:'📊', label:'Overview' },
    { id:'all-users',     icon:'👥', label:'Team Progress' },
    { id:'sites',         icon:'🌐', label:'All Sites' },
    { id:'tasks',         icon:'📋', label:'Tasks' },
    { id:'domain-expiry', icon:'📅', label:'Domain Expiry' },
    { id:'uptime',        icon:'💓', label:'Uptime Monitor' },
    { id:'user-mgmt',     icon:'⚙️',  label:'Team Members' },
    { id:'send-emails',   icon:'✉️', label:'Send Emails' },
  ],
  superadmin: [
    { id:'overview',      icon:'📊', label:'Overview' },
    { id:'all-users',     icon:'👥', label:'Team Progress' },
    { id:'sites',         icon:'🌐', label:'All Sites' },
    { id:'tasks',         icon:'📋', label:'Tasks' },
    { id:'domain-expiry', icon:'📅', label:'Domain Expiry' },
    { id:'uptime',        icon:'💓', label:'Uptime Monitor' },
    { id:'properties',    icon:'🏢', label:'Property Registry' },
    { id:'dev-projects',  icon:'💻', label:'Dev Tracker' },
    { id:'user-mgmt',     icon:'⚙️',  label:'User Management' },
    { id:'send-emails',   icon:'✉️', label:'Send Emails' },
    { id:'sync',          icon:'🔄', label:'Sync from Sheets' },
  ],
};

function buildNav(role) {
  const items = NAV[role] || [];
  sidebarNavEl.innerHTML = items.map(n => `
    <div class="nav-item" data-view="${n.id}" id="nav-${n.id}">
      <span class="nav-icon">${n.icon}</span>
      <span class="nav-label">${esc(n.label)}</span>
    </div>`).join('');
  sidebarNavEl.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.view));
  });
}

function setActiveNav(viewId) {
  sidebarNavEl.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewId);
  });
}

// ─── Navigation ───────────────────────────────────────────────────────────────
const viewFns = {
  'my-sites':     viewMySites,
  'my-tasks':     viewMyTasks,
  'overview':     viewOverview,
  'all-users':    viewAllUsers,
  'sites':        viewSites,
  'tasks':        viewTasks,
  'domain-expiry':viewDomainExpiry,
  'uptime':       viewUptime,
  'properties':   viewProperties,
  'dev-projects': viewDevProjects,
  'user-mgmt':    viewUserMgmt,
  'send-emails':  viewSendEmails,
  'sync':         viewSync,
};

function navigate(viewId) {
  S.view = viewId;
  setActiveNav(viewId);
  mainEl.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Loading…</p></div>';
  const fn = viewFns[viewId];
  if (fn) fn(); else mainEl.innerHTML = '<div class="empty-state"><p>View not found</p></div>';
}

$('refresh-btn').addEventListener('click', () => { if (S.view) navigate(S.view); });
$('notice-board-top-btn')?.addEventListener('click', () => openNoticeBoardModal());
$('logout-btn').addEventListener('click', () => {
  appShell.classList.add('hidden');
  landing.classList.remove('hidden');
});
const savedSidebar = localStorage.getItem('officeos_sidebar_collapsed');
if (savedSidebar === 'true' || (savedSidebar === null && window.innerWidth < 1350)) {
  appShell.classList.add('sidebar-collapsed');
}
$('sidebar-toggle').addEventListener('click', () => {
  const isCollapsed = appShell.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('officeos_sidebar_collapsed', isCollapsed); } catch {}
});

// ─── Command Palette Setup ───────────────────────────────────────────────────
function initCommandPalette() {
  const overlay = $('cmd-overlay');
  const trigger = $('cmd-palette-trigger');
  const input = $('cmd-input');
  const results = $('cmd-results');
  if (!overlay) return;

  function open() {
    overlay.classList.remove('hidden');
    input.value = '';
    input.focus();
    renderResults('');
  }
  function close() { overlay.classList.add('hidden'); }

  if (trigger) trigger.addEventListener('click', open);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open();
    }
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
      close();
    }
  });

  input.addEventListener('input', e => renderResults(e.target.value));

  async function renderResults(query) {
    const q = (query || '').toLowerCase().trim();
    let items = [];

    // Quick navigation commands
    const navItems = [
      { type: 'View', title: '🌐 My Assigned Sites', action: () => navigate('my-sites') },
      { type: 'View', title: '✅ My Assigned Tasks', action: () => navigate('my-tasks') },
      { type: 'View', title: '📊 Overview Dashboard', action: () => navigate('overview') },
      { type: 'View', title: '👥 Team Progress Tracker', action: () => navigate('all-users') },
      { type: 'View', title: '🌐 All Sites Directory', action: () => navigate('sites') },
      { type: 'View', title: '📅 Domain Expiry Tracker', action: () => navigate('domain-expiry') },
      { type: 'View', title: '💓 Live Uptime Monitor', action: () => navigate('uptime') },
      { type: 'View', title: '🔄 Sync from Google Sheets', action: () => navigate('sync') },
      { type: 'View', title: '✉️ Send Email Reports', action: () => navigate('send-emails') },
    ];

    if (!q) {
      items = navItems.slice(0, 6);
    } else {
      items = navItems.filter(n => n.title.toLowerCase().includes(q));
      // Search sites if loaded
      try {
        const { sites } = await GET('/api/master/sites');
        const matchedSites = (sites || []).filter(s => (s.url||'').toLowerCase().includes(q) || (s.company||'').toLowerCase().includes(q)).slice(0, 6);
        matchedSites.forEach(s => {
          items.push({
            type: 'Website',
            title: `${s.url} (${s.company || s.account || 'CW'})`,
            action: () => { window.open(s.url, '_blank'); close(); }
          });
        });
      } catch {}
    }

    results.innerHTML = items.map((item, idx) => `
      <div class="cmd-item" data-idx="${idx}">
        <span class="cmd-item-title">${esc(item.title)}</span>
        <span class="cmd-item-meta">${esc(item.type)}</span>
      </div>
    `).join('') || '<div style="padding:20px;text-align:center;color:var(--text-muted)">No matching results</div>';

    results.querySelectorAll('.cmd-item').forEach((el, idx) => {
      el.addEventListener('click', () => {
        close();
        if (items[idx]?.action) items[idx].action();
      });
    });
  }
}

// ─── LANDING ──────────────────────────────────────────────────────────────────
async function initLanding() {
  initCommandPalette();

  const defaultNames = ['Toufiq','Sabbir','Taion','Medul','Saiful','Tarikul','Roeich','Asif'];
  const nameSelect = $('user-name-select');
  nameSelect.innerHTML = defaultNames.map(n => `<option value="">${n}</option>`).join('');

  // Handle role cards clicking
  document.querySelectorAll('.role-card').forEach(rc => {
    rc.addEventListener('click', () => {
      document.querySelectorAll('.role-card').forEach(c => c.classList.remove('active'));
      rc.classList.add('active');
      const role = rc.dataset.role;
      $('role-select').value = role;
      $('user-select-wrap').classList.toggle('hidden', role !== 'user');
    });
  });

  // Restore saved session if available
  try {
    const saved = JSON.parse(localStorage.getItem('officeos_session') || '{}');
    if (saved.role) {
      const targetCard = document.querySelector(`.role-card[data-role="${saved.role}"]`);
      if (targetCard) targetCard.click();
    }
  } catch {}

  const statusEl = $('landing-status');
  try {
    const st = await GET('/api/master/db-status');
    if (!st.initialised) {
      statusEl.innerHTML = `<div class="status-pill warn">⚠️ <span><strong>First-time setup:</strong> After entering, go to <em>Sync from Sheets</em> to import data.</span></div>`;
    } else {
      const ago = st.lastSync ? Math.round((Date.now() - new Date(st.lastSync)) / 60000) : null;
      statusEl.innerHTML = `<div class="status-pill ok">⚡ <span><strong>${st.totalSites} Sites</strong> · ${st.totalDomains||0} Domains${ago!==null?` · Synced ${ago}m ago`:''}</span></div>`;
    }
  } catch {}

  // Load real users
  try {
    const { users } = await GET('/api/master/users');
    if (users && users.length > 0) {
      S.users = users;
      const activeUsers = users.filter(u => u.active !== false);
      nameSelect.innerHTML = activeUsers.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    }
  } catch {}

  $('enter-btn').addEventListener('click', () => {
    const role = $('role-select').value;
    S.role = role;
    if (role === 'user') {
      const nameOpt = nameSelect.options[nameSelect.selectedIndex];
      S.userName = nameOpt ? nameOpt.text : defaultNames[0];
      S.userId   = nameOpt ? (nameOpt.value || null) : null;
    } else {
      const nameOpt = nameSelect.options[nameSelect.selectedIndex];
      S.userName = nameOpt ? nameOpt.text : (role === 'admin' ? 'Admin' : 'Superadmin');
      S.userId   = nameOpt ? (nameOpt.value || null) : null;
    }
    // Save session
    try { localStorage.setItem('officeos_session', JSON.stringify({ role: S.role, userName: S.userName, userId: S.userId })); } catch {}
    enterApp();
  });
}

function enterApp() {
  landing.classList.add('hidden');
  appShell.classList.remove('hidden');

  // Set sidebar user info
  $('user-name-display').textContent = S.role === 'user' ? S.userName : (S.role === 'admin' ? 'Admin' : 'Superadmin');
  $('user-role-display').textContent = S.role.toUpperCase();
  $('user-avatar').textContent = (S.userName || S.role)[0].toUpperCase();

  // Topbar quick role switcher
  document.querySelectorAll('.role-pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.role === S.role);
    btn.addEventListener('click', () => {
      const newRole = btn.dataset.role;
      if (newRole === S.role) return;
      S.role = newRole;
      $('user-role-display').textContent = newRole.toUpperCase();
      document.querySelectorAll('.role-pill-btn').forEach(b => b.classList.toggle('active', b.dataset.role === newRole));
      buildNav(newRole);
      const defaultViews = { user: 'my-sites', admin: 'overview', superadmin: 'overview' };
      navigate(defaultViews[newRole] || 'overview');
      toast(`Switched to ${newRole} workspace`, 'info');
    });
  });

  // Quick sync sidebar button
  const qSync = $('quick-sync-btn');
  if (qSync) qSync.addEventListener('click', () => navigate('sync'));

  buildNav(S.role);

  // Show sync-status if synced
  GET('/api/master/db-status').then(st => {
    if (st.lastSync) {
      $('sync-status').classList.remove('hidden');
      const ago = Math.round((Date.now() - new Date(st.lastSync)) / 60000);
      $('sync-status-text').textContent = ago < 1 ? 'Synced just now' : `Synced ${ago}m ago`;
    }
  }).catch(() => {});

  // Default view
  const defaultViews = { user: 'my-sites', admin: 'overview', superadmin: 'overview' };
  navigate(defaultViews[S.role] || 'overview');
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTICE BOARD & PINNED ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════════════════
async function getNoticeBannerHtml() {
  try {
    const { notices } = await GET('/api/master/notices');
    if (!notices || !notices.length) return '';
    const pinned = notices.find(n => n.pinned) || notices[0];
    if (!pinned) return '';
    return `
      <div class="pinned-notice-banner" id="pinned-notice-banner">
        <div class="pnb-left">
          <div class="pnb-icon">📌</div>
          <div class="pnb-content">
            <div class="pnb-title">
              <span>${esc(pinned.title)}</span>
              ${pinned.authorName ? `<span style="font-size:11px;font-weight:400;color:var(--text-dim)">• posted by ${esc(pinned.authorName)}</span>` : ''}
            </div>
            <div class="pnb-text">${esc(pinned.content)}</div>
          </div>
        </div>
        <div class="pnb-actions">
          ${pinned.link ? `<a href="${esc(pinned.link)}" target="_blank" class="btn-notice-meet">${esc(pinned.linkLabel || 'Join Meeting ↗')}</a>` : ''}
          <button class="btn btn-ghost btn-sm btn-open-notices" title="View all team notices">📢 Board</button>
        </div>
      </div>`;
  } catch {
    return '';
  }
}

async function openNoticeBoardModal() {
  let notices = [];
  try {
    const res = await GET('/api/master/notices');
    notices = res.notices || [];
  } catch (e) {
    toast(e.message, 'error');
  }

  const canManage = ['admin', 'superadmin'].includes(S.role);

  const noticesListHtml = notices.length ? notices.map(n => `
    <div style="background:var(--bg-surface-2);border:1px solid ${n.pinned ? 'rgba(99,102,241,0.5)' : 'var(--border)'};border-radius:var(--radius);padding:14px 16px;margin-bottom:12px;position:relative;${n.pinned ? 'box-shadow:0 0 16px rgba(99,102,241,0.15)' : ''}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:8px">
          ${n.pinned ? '<span class="badge badge-accent" style="font-size:10.5px">📌 Pinned</span>' : ''}
          <strong style="font-size:14px;color:#fff">${esc(n.title)}</strong>
        </div>
        <div style="font-size:11px;color:var(--text-dim)">${n.authorName ? esc(n.authorName) + ' • ' : ''}${n.createdAt ? new Date(n.createdAt).toLocaleDateString() : ''}</div>
      </div>
      <p style="font-size:13px;color:var(--text-secondary);margin:0 0 10px;line-height:1.5">${esc(n.content)}</p>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          ${n.link ? `<a href="${esc(n.link)}" target="_blank" class="btn-notice-meet" style="font-size:11.5px;padding:4px 12px">${esc(n.linkLabel || 'Open Link ↗')}</a>` : ''}
        </div>
        ${canManage ? `
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm toggle-pin-btn" data-id="${n.id}" data-pinned="${!n.pinned}" title="${n.pinned ? 'Unpin notice' : 'Pin to top banner'}">
              ${n.pinned ? '📍 Unpin' : '📌 Pin'}
            </button>
            <button class="btn btn-ghost btn-sm edit-notice-btn" data-id="${n.id}" title="Edit notice">✏️</button>
            <button class="btn btn-danger btn-sm del-notice-btn" data-id="${n.id}" title="Delete notice">🗑</button>
          </div>
        ` : ''}
      </div>
    </div>
  `).join('') : '<div class="empty-state"><div class="empty-icon">📢</div><p>No notices posted yet.</p></div>';

  openModal(
    '📢 Team Notice Board',
    `
    <div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:12.5px;color:var(--text-muted)">Important announcements and quick links for the entire team.</div>
      ${canManage ? '<button class="btn btn-primary btn-sm" id="btn-create-notice">+ Post Notice</button>' : ''}
    </div>
    <div id="notices-modal-list" style="max-height:60vh;overflow-y:auto;padding-right:4px">
      ${noticesListHtml}
    </div>
    `,
    [{ label: 'Close', cls: 'btn btn-secondary', onClick: closeModal }]
  );

  const modalList = $('notices-modal-list');
  if (!modalList) return;

  if (canManage) {
    $('btn-create-notice')?.addEventListener('click', () => {
      openModal('Post New Notice',
        `
        <div class="form-group"><label class="form-label">Notice Title *</label><input class="form-input" id="nn-title" placeholder="e.g. Daily Standup Google Meet"></div>
        <div class="form-group"><label class="form-label">Details / Message</label><textarea class="form-textarea" id="nn-content" placeholder="e.g. Join the team every morning at 10:00 AM..."></textarea></div>
        <div class="form-group"><label class="form-label">Link URL (Optional, e.g. Meet link)</label><input class="form-input" id="nn-link" placeholder="https://meet.google.com/xyz"></div>
        <div class="form-group"><label class="form-label">Link Button Label</label><input class="form-input" id="nn-label" placeholder="e.g. Join Google Meet ↗" value="Join Google Meet ↗"></div>
        <div class="form-group" style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <input type="checkbox" id="nn-pin" checked style="width:16px;height:16px;accent-color:var(--accent)">
          <label for="nn-pin" class="form-label" style="margin:0;cursor:pointer">📌 Pin to top of dashboard</label>
        </div>
        `,
        [
          { label: 'Cancel', cls: 'btn btn-secondary', onClick: openNoticeBoardModal },
          { label: 'Publish Notice', cls: 'btn btn-primary', onClick: async () => {
            const title = $('nn-title').value.trim();
            if (!title) { toast('Title required', 'error'); return; }
            try {
              await POST('/api/master/notices', {
                title,
                content: $('nn-content').value.trim(),
                link: $('nn-link').value.trim(),
                linkLabel: $('nn-label').value.trim(),
                pinned: $('nn-pin').checked,
                authorName: S.userName || 'Admin',
                authorRole: S.role || 'admin',
              });
              toast('Notice published!', 'success');
              openNoticeBoardModal();
              if (S.view) navigate(S.view);
            } catch (e) { toast(e.message, 'error'); }
          }}
        ]
      );
    });

    modalList.querySelectorAll('.toggle-pin-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const targetPinned = btn.dataset.pinned === 'true';
        try {
          await PUT(`/api/master/notices/${id}`, { pinned: targetPinned });
          toast(targetPinned ? 'Notice pinned to top!' : 'Notice unpinned', 'success');
          openNoticeBoardModal();
          if (S.view) navigate(S.view);
        } catch (e) { toast(e.message, 'error'); }
      });
    });

    modalList.querySelectorAll('.del-notice-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this notice?')) return;
        try {
          await DELETE(`/api/master/notices/${btn.dataset.id}`);
          toast('Notice deleted', 'success');
          openNoticeBoardModal();
          if (S.view) navigate(S.view);
        } catch (e) { toast(e.message, 'error'); }
      });
    });

    modalList.querySelectorAll('.edit-notice-btn').forEach(btn => {
      const notice = notices.find(n => n.id === btn.dataset.id);
      if (!notice) return;
      btn.addEventListener('click', () => {
        openModal(`Edit: ${notice.title}`,
          `
          <div class="form-group"><label class="form-label">Notice Title *</label><input class="form-input" id="en-title" value="${esc(notice.title)}"></div>
          <div class="form-group"><label class="form-label">Details / Message</label><textarea class="form-textarea" id="en-content">${esc(notice.content || '')}</textarea></div>
          <div class="form-group"><label class="form-label">Link URL</label><input class="form-input" id="en-link" value="${esc(notice.link || '')}"></div>
          <div class="form-group"><label class="form-label">Link Button Label</label><input class="form-input" id="en-label" value="${esc(notice.linkLabel || '')}"></div>
          <div class="form-group" style="display:flex;align-items:center;gap:8px;margin-top:10px">
            <input type="checkbox" id="en-pin" ${notice.pinned ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--accent)">
            <label for="en-pin" class="form-label" style="margin:0;cursor:pointer">📌 Pin to top of dashboard</label>
          </div>
          `,
          [
            { label: 'Cancel', cls: 'btn btn-secondary', onClick: openNoticeBoardModal },
            { label: 'Save Changes', cls: 'btn btn-primary', onClick: async () => {
              try {
                await PUT(`/api/master/notices/${notice.id}`, {
                  title: $('en-title').value.trim(),
                  content: $('en-content').value.trim(),
                  link: $('en-link').value.trim(),
                  linkLabel: $('en-label').value.trim(),
                  pinned: $('en-pin').checked,
                });
                toast('Notice updated', 'success');
                openNoticeBoardModal();
                if (S.view) navigate(S.view);
              } catch (e) { toast(e.message, 'error'); }
            }}
          ]
        );
      });
    });
  }
}

// ─── Shared Checklist Table Interactivity (Quick Uptime, Bulk Edit, Live Stats) ───
function initChecklistTable(containerEl, isUserView = false, activeUserId = null) {
  // 1. Recalculate stats helper
  function recalcStats() {
    const rows = containerEl.querySelectorAll('tr.smart-row, tr[data-status]:not(.smart-row):not(.detail-accordion-row)');
    let comp = 0, inProg = 0, pending = 0, total = rows.length;
    rows.forEach(r => {
      const s = r.dataset.status;
      if (s === 'completed') comp++;
      else if (s === 'in_progress') inProg++;
      else pending++;
    });
    const pct = total ? Math.round(comp / total * 100) : 0;

    // Update stat cards
    const cEl = $('stat-completed'); if (cEl) cEl.textContent = comp;
    const ipEl = $('stat-inprogress'); if (ipEl) ipEl.textContent = inProg;
    const pEl = $('stat-pending'); if (pEl) pEl.textContent = pending;

    // Update progress text & fill
    containerEl.querySelectorAll('.completion-pct-text').forEach(el => el.textContent = `${pct}% Completed`);
    containerEl.querySelectorAll('.user-pct-text').forEach(el => el.textContent = `${pct}% complete`);
    containerEl.querySelectorAll('.completion-progress-fill, .user-progress-fill').forEach(el => el.style.width = `${pct}%`);

    // If active user tab is open on Team Progress, update tab badge
    if (activeUserId) {
      const tabBtn = document.querySelector(`.user-tab-btn[data-uid="${activeUserId}"]`);
      if (tabBtn) {
        const badge = tabBtn.querySelector('.badge');
        if (badge) {
          badge.textContent = `${pct}%`;
          badge.className = `badge badge-${pct >= 100 ? 'success' : (pct > 50 ? 'info' : 'warning')}`;
        }
      }
    }
  }

  // 2. Quick Uptime Check button listener
  containerEl.querySelectorAll('.btn-uptime-check').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.classList.add('spinning');
      try {
        const resp = await POST('/api/master/check-uptime', {
          rowId: btn.dataset.rowId,
          url: btn.dataset.siteUrl,
          siteId: btn.dataset.siteId || undefined,
        });
        btn.classList.remove('spinning');
        const isUp = resp.result?.status === 'online';
        const dot = document.getElementById(`live-dot-${btn.dataset.rowId}`);
        if (dot) {
          dot.className = `live-status-dot ${isUp ? 'online' : 'offline'}`;
          dot.title = isUp ? `Website Online & Active (${resp.result?.responseTime || 0}ms)` : 'Website Down / Offline';
        }
        toast(`${isUp ? '🟢 Online' : '🔴 Offline'} — ${shortUrl(btn.dataset.siteUrl, 24)}${resp.result?.responseTime ? ' (' + resp.result.responseTime + 'ms)' : ''}`, isUp ? 'success' : 'error');
      } catch (err) {
        btn.classList.remove('spinning');
        toast(err.message, 'error');
      }
    });
  });

  // 3. Status change listener for live stat recalculation
  containerEl.querySelectorAll('.select-maint-compact, .select-maint').forEach(sel => {
    sel.addEventListener('change', () => {
      const row = sel.closest('tr');
      if (row) row.dataset.status = sel.value;
      recalcStats();
    });
  });

  // 4. Bulk Edit Dock functionality
  const dock = containerEl.querySelector('#bulk-dock') || $('bulk-dock');
  const countEl = containerEl.querySelector('#bulk-selected-count') || $('bulk-selected-count');
  const selectAll = containerEl.querySelector('.select-all-checkbox');
  const rowCheckboxes = containerEl.querySelectorAll('.row-checkbox');

  function updateDock() {
    const checked = containerEl.querySelectorAll('.row-checkbox:checked');
    if (countEl) countEl.textContent = checked.length;
    if (dock) {
      if (checked.length > 0) dock.classList.remove('hidden');
      else dock.classList.add('hidden');
    }
    if (selectAll) {
      selectAll.checked = rowCheckboxes.length > 0 && checked.length === rowCheckboxes.length;
      selectAll.indeterminate = checked.length > 0 && checked.length < rowCheckboxes.length;
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

  rowCheckboxes.forEach(cb => {
    cb.addEventListener('change', updateDock);
  });

  const clearBtn = containerEl.querySelector('#btn-clear-selection') || $('btn-clear-selection');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      rowCheckboxes.forEach(cb => cb.checked = false);
      updateDock();
    });
  }

  const applyBtn = containerEl.querySelector('#btn-apply-bulk') || $('btn-apply-bulk');
  if (applyBtn) {
    applyBtn.addEventListener('click', async () => {
      const checked = [...containerEl.querySelectorAll('.row-checkbox:checked')];
      if (!checked.length) return;
      const ids = checked.map(cb => cb.dataset.rowId);
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
        await POST('/api/master/daily-review/batch', { ids, updates });
        ids.forEach(id => {
          const row = containerEl.querySelector(`tr[data-id="${id}"]`);
          if (row) {
            if (updates.maintenanceStatus) {
              row.dataset.status = updates.maintenanceStatus;
              const sel = row.querySelector('.select-maint-compact, .select-maint');
              if (sel) sel.value = updates.maintenanceStatus;
            }
            if (updates.reportSentStatus) {
              const btn = row.querySelector('.btn-report-toggle');
              if (btn) {
                btn.className = `btn-report-toggle ${updates.reportSentStatus === 'sent' ? 'sent' : 'pending'}`;
                btn.dataset.status = updates.reportSentStatus;
                btn.textContent = updates.reportSentStatus === 'sent' ? '✓ Sent' : '✉ No';
              }
            }
            if (updates.ga4) {
              const ga4Sel = row.querySelector('.select-ga4-status');
              if (ga4Sel) {
                ga4Sel.value = updates.ga4;
                ga4Sel.className = `select-ga4-status ${/no|n\/a/i.test(updates.ga4) ? 'val-dim' : ''}`;
              }
            }
          }
        });
        toast(`Bulk updated ${ids.length} sites!`, 'success');
        recalcStats();
        rowCheckboxes.forEach(cb => cb.checked = false);
        updateDock();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply Updates';
      }
    });
  }

  const bulkUptimeBtn = containerEl.querySelector('#btn-bulk-uptime') || $('btn-bulk-uptime');
  if (bulkUptimeBtn) {
    bulkUptimeBtn.addEventListener('click', async () => {
      const checked = [...containerEl.querySelectorAll('.row-checkbox:checked')];
      if (!checked.length) return;
      bulkUptimeBtn.disabled = true;
      bulkUptimeBtn.textContent = `⏳ 0/${checked.length}`;
      let done = 0;
      for (const cb of checked) {
        try {
          const resp = await POST('/api/master/check-uptime', {
            rowId: cb.dataset.rowId,
            url: cb.dataset.url,
          });
          const isUp = resp.result?.status === 'online';
          const dot = document.getElementById(`live-dot-${cb.dataset.rowId}`);
          if (dot) {
            dot.className = `live-status-dot ${isUp ? 'online' : 'offline'}`;
            dot.title = isUp ? `Website Online & Active (${resp.result?.responseTime || 0}ms)` : 'Website Down / Offline';
          }
        } catch {}
        done++;
        bulkUptimeBtn.textContent = `⏳ ${done}/${checked.length}`;
      }
      toast(`Completed live uptime check for ${checked.length} sites`, 'success');
      bulkUptimeBtn.disabled = false;
      bulkUptimeBtn.textContent = '↺ Check Uptime';
    });
  }

  // 5. GA4 inline status change listener
  containerEl.querySelectorAll('.select-ga4-status').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const rowId = sel.dataset.rowId;
      const value = sel.value;
      sel.className = `select-ga4-status ${/no|n\/a/i.test(value) ? 'val-dim' : ''}`;
      try {
        await PUT(`/api/master/daily-review/${rowId}`, { ga4: value });
        toast('GA4 status updated', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  // 6. Domain Expiry edit button listener
  containerEl.querySelectorAll('.btn-edit-expiry').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { siteId, url, current, rowId } = btn.dataset;
      openExpiryEditModal({ siteId, siteUrl: url, currentDate: current, rowId }, () => {
        if (isUserView) viewMySites();
        else if (activeUserId) loadUser(activeUserId);
      });
    });
  });

  // 7. Domain Expiry approval actions (Admin / Superadmin)
  containerEl.querySelectorAll('.btn-approve-expiry').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const reqId = btn.dataset.reqId;
      try {
        btn.disabled = true;
        await POST(`/api/master/domain-expiry-requests/${reqId}/resolve`, {
          action: 'approved',
          resolvedBy: S.currentUser?.name || 'admin'
        });
        toast('Domain expiration date approved & applied!', 'success');
        if (isUserView) viewMySites();
        else if (activeUserId) loadUser(activeUserId);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });

  containerEl.querySelectorAll('.btn-reject-expiry').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const reqId = btn.dataset.reqId;
      try {
        btn.disabled = true;
        await POST(`/api/master/domain-expiry-requests/${reqId}/resolve`, {
          action: 'rejected',
          resolvedBy: S.currentUser?.name || 'admin'
        });
        toast('Domain expiration date change rejected', 'info');
        if (isUserView) viewMySites();
        else if (activeUserId) loadUser(activeUserId);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });

  // 8. Open Notice Board listener
  containerEl.querySelectorAll('.btn-open-notices').forEach(btn => {
    btn.addEventListener('click', openNoticeBoardModal);
  });
}

function openExpiryEditModal({ siteId, siteUrl, currentDate, rowId }, onSaved) {
  const isAdminOrSuper = S.currentUser?.role === 'admin' || S.currentUser?.role === 'superadmin';
  const cleanCurrent = currentDate ? currentDate.slice(0, 10) : '';

  openModal(`Domain Expiry: ${shortUrl(siteUrl, 28)}`, `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;word-break:break-all">
      Site: <a href="${esc(siteUrl)}" target="_blank" style="color:var(--accent-2)">${esc(siteUrl)} ↗</a>
    </div>
    <div class="form-group" style="margin-bottom:16px">
      <label class="form-label" style="font-size:12.5px;font-weight:700">Domain Expiration Date</label>
      <input type="date" id="modal-expiry-date" class="form-input" value="${esc(cleanCurrent)}" style="background:var(--bg-surface-2);color:#fff" />
      <div style="font-size:11.5px;color:var(--text-secondary);margin-top:6px">
        ${isAdminOrSuper 
          ? '⚡ As an Admin/Superadmin, changes apply immediately across the system.' 
          : '⏳ As a Team Member, this change will be submitted to Admin/Superadmin for approval.'}
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:10px">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="btn-submit-expiry-change">
        ${isAdminOrSuper ? '✓ Save Expiry Date' : '📤 Submit for Approval'}
      </button>
    </div>
  `);

  const submitBtn = $('btn-submit-expiry-change');
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const newDate = ($('modal-expiry-date').value || '').trim();
      if (!newDate) {
        toast('Please choose a valid expiration date', 'warning');
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      try {
        if (isAdminOrSuper) {
          await POST('/api/master/domain-expiry-requests', {
            siteId,
            siteUrl,
            requestedDate: newDate,
            directApply: true,
          });
          toast('Domain expiration date updated!', 'success');
        } else {
          await POST('/api/master/domain-expiry-requests', {
            siteId,
            siteUrl,
            requestedDate: newDate,
            requestedBy: S.currentUser?.id || '',
            requestedByName: S.currentUser?.name || 'User',
          });
          toast('Submitted to Admin/Superadmin for approval!', 'success');
        }
        closeModal();
        if (onSaved) onSaved();
      } catch (err) {
        toast(err.message, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = isAdminOrSuper ? '✓ Save Expiry Date' : '📤 Submit for Approval';
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: MY SITES (User)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewMySites() {
  setPage('My Sites', `Assigned checklist for ${S.userName}`);

  let rows = [];
  let noticeBannerHtml = '';
  try {
    const [data, nHtml] = await Promise.all([
      GET(`/api/master/daily-review?userId=${S.userId}&user=${encodeURIComponent(S.userName)}`),
      getNoticeBannerHtml()
    ]);
    rows = data.rows || [];
    noticeBannerHtml = nHtml;
  } catch (e) { toast(e.message, 'error'); }

  const completed = rows.filter(r => r.maintenanceStatus === 'completed').length;
  const inProgress = rows.filter(r => r.maintenanceStatus === 'in_progress').length;
  const pending = rows.filter(r => !['completed','in_progress'].includes(r.maintenanceStatus)).length;
  const pct = rows.length ? Math.round(completed / rows.length * 100) : 0;
  const isSmart = S.tableMode !== 'full';

  mainEl.innerHTML = `
    <div class="fade-in">
      ${noticeBannerHtml}
      <div class="stat-grid">
        <div class="stat-card accent"><div class="stat-value" id="stat-total">${rows.length}</div><div class="stat-label">Assigned Sites</div></div>
        <div class="stat-card success"><div class="stat-value" id="stat-completed">${completed}</div><div class="stat-label">Completed</div></div>
        <div class="stat-card warning"><div class="stat-value" id="stat-inprogress">${inProgress}</div><div class="stat-label">In Progress</div></div>
        <div class="stat-card danger"><div class="stat-value" id="stat-pending">${pending}</div><div class="stat-label">Pending Review</div></div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">📋 Daily Maintenance Checklist</span>
          <div class="card-actions">
            <span class="completion-pct-text" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${pct}% Completed</span>
            <div class="progress-wrap" style="width:120px"><div class="progress-fill completion-progress-fill" style="width:${pct}%"></div></div>
            <div class="view-mode-toggle" id="table-mode-toggle">
              <button class="btn btn-sm mode-btn ${isSmart?'active':''}" data-mode="smart" title="Smart Fit 100vw - No horizontal scroll">⚡ Smart Fit</button>
              <button class="btn btn-sm mode-btn ${!isSmart?'active':''}" data-mode="full" title="Spreadsheet mode with all 14 columns">📋 Full Spread</button>
            </div>
            <button id="export-csv-btn" class="btn btn-secondary btn-sm" title="Export this checklist to CSV">
              📥 Export CSV
            </button>
          </div>
        </div>

        <div class="toolbar" style="padding:14px 18px 0;gap:10px">
          <div class="search-wrap" style="flex:1;max-width:320px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input id="site-search" class="search-input" placeholder="Search URL, ClickUp, notes…">
          </div>
          <div style="display:flex;gap:5px;flex-wrap:wrap" id="quick-filter-chips">
            <button class="btn btn-secondary btn-sm chip-btn active" data-filter="">All (${rows.length})</button>
            <button class="btn btn-secondary btn-sm chip-btn" data-filter="completed">Completed (${completed})</button>
            <button class="btn btn-secondary btn-sm chip-btn" data-filter="in_progress">In Progress (${inProgress})</button>
            <button class="btn btn-secondary btn-sm chip-btn" data-filter="pending">Pending (${pending})</button>
            <button class="btn btn-secondary btn-sm chip-btn" data-filter="cw">CW</button>
            <button class="btn btn-secondary btn-sm chip-btn" data-filter="rm">RM</button>
          </div>
        </div>

        <div class="table-wrap">
          <table class="${isSmart ? 'table-smart-fit' : 'table-full-spread'}">
            <thead>
              ${isSmart ? `
                <tr>
                  <th class="col-select" style="text-align:center">
                    <input type="checkbox" class="select-all-checkbox" title="Select all sites" />
                  </th>
                  <th class="col-url">Website &amp; Account</th>
                  <th class="col-maint">Maintenance &amp; Report</th>
                  <th class="col-links">Tasks &amp; Links</th>
                  <th class="col-integ">Integrations</th>
                  <th class="col-resp">Response</th>
                  <th class="col-actions" style="text-align:right">Actions</th>
                </tr>
              ` : `
                <tr>
                  <th style="width:36px;text-align:center">
                    <input type="checkbox" class="select-all-checkbox" title="Select all sites" />
                  </th>
                  <th>Website URL</th>
                  <th>Company</th>
                  <th>Maintenance</th>
                  <th>Report Sent</th>
                  <th>ClickUp Link</th>
                  <th>GA4 Report</th>
                  <th>Newsletter Mail</th>
                  <th>Form Submission Mail</th>
                  <th>Client Response</th>
                  <th>Booking Engine</th>
                  <th>Domain Expiry</th>
                  <th>Cloudflare</th>
                  <th>Actions</th>
                </tr>
              `}
            </thead>
            <tbody id="sites-tbody">
              ${rows.map((r,i) => siteRow(r, i, isSmart ? 'smart' : 'full')).join('')}
            </tbody>
          </table>
        </div>

        <!-- Bulk Edit Sticky Dock -->
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
            <button class="btn btn-secondary btn-sm" id="btn-bulk-uptime" title="Check uptime for all selected sites">↺ Check Uptime</button>
            <button class="btn btn-ghost btn-sm" id="btn-clear-selection" title="Clear selection">✕</button>
          </div>
        </div>
      </div>
    </div>`;

  // Search + Filter Chips
  const tbody = $('sites-tbody');
  const allRows = [...tbody.querySelectorAll('tr')];
  let activeFilter = '';

  function applyFilter() {
    const q = ($('site-search').value || '').toLowerCase().trim();
    allRows.forEach(tr => {
      // If it's a detail row, toggle based on parent row
      if (tr.classList.contains('detail-accordion-row')) {
        const parentId = tr.dataset.parentId;
        const parentTr = tbody.querySelector(`tr[data-id="${parentId}"]:not(.detail-accordion-row)`);
        if (parentTr && parentTr.classList.contains('hidden')) {
          tr.classList.add('hidden');
        }
        return;
      }

      const url = tr.dataset.url || '';
      const status = tr.dataset.status || '';
      const text = tr.innerText.toLowerCase();

      let matchFilter = true;
      if (activeFilter === 'completed') matchFilter = status === 'completed';
      else if (activeFilter === 'in_progress') matchFilter = status === 'in_progress';
      else if (activeFilter === 'pending') matchFilter = !['completed','in_progress'].includes(status);
      else if (activeFilter === 'cw') matchFilter = text.includes('cw');
      else if (activeFilter === 'rm') matchFilter = text.includes('rm');

      const matchQuery = !q || url.includes(q) || text.includes(q);
      const isVisible = matchFilter && matchQuery;
      tr.classList.toggle('hidden', !isVisible);

      // Hide corresponding detail row if parent is hidden
      const rowId = tr.dataset.id;
      const detailRow = $(`detail-row-${rowId}`);
      if (detailRow && !isVisible) detailRow.classList.add('hidden');
    });
  }

  $('site-search').addEventListener('input', applyFilter);

  document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('btn-primary', 'active'));
      btn.classList.add('btn-primary', 'active');
      activeFilter = btn.dataset.filter;
      applyFilter();
    });
  });

  // Mode switcher (Smart Fit vs Full Spread)
  document.querySelectorAll('#table-mode-toggle .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      S.tableMode = mode;
      try { localStorage.setItem('officeos_table_mode', mode); } catch {}
      viewMySites();
    });
  });

  // Export CSV
  $('export-csv-btn').addEventListener('click', () => {
    exportChecklistCsv(rows, `Daily_Maintenance_${S.userName}_${new Date().toISOString().slice(0,10)}.csv`);
  });

  // Status dropdown auto-save
  tbody.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async e => {
      const { rowId, field } = e.target.dataset;
      const value = e.target.value;
      const normMap = { 'Completed':'completed','In Progress':'in_progress','To Do':'todo','Pending':'pending','Yes':'sent','No':'no' };
      try {
        await PUT(`/api/master/daily-review/${rowId}`, {
          [field]: normMap[value] || value,
          [field + 'Raw']: value,
        });
        toast('Status updated', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  // Quick 1-click toggle for Report Sent
  tbody.querySelectorAll('.btn-report-toggle').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { rowId, status } = btn.dataset;
      const newStatus = status === 'sent' ? 'no' : 'sent';
      const newRaw = newStatus === 'sent' ? 'Yes' : 'No';
      try {
        await PUT(`/api/master/daily-review/${rowId}`, {
          reportSentStatus: newStatus,
          reportSentRaw: newRaw
        });
        btn.dataset.status = newStatus;
        btn.className = `btn-report-toggle ${newStatus === 'sent' ? 'sent' : 'pending'}`;
        btn.textContent = newStatus === 'sent' ? '✉️ Sent' : '✉️ No';
        toast(`Report marked ${newRaw}`, 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  // Toggle detail accordion
  tbody.querySelectorAll('.toggle-detail-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const detailRow = $(`detail-row-${id}`);
      const parentTr = tbody.querySelector(`tr[data-id="${id}"]:not(.detail-accordion-row)`);
      if (detailRow) {
        const isHidden = detailRow.classList.contains('hidden');
        detailRow.classList.toggle('hidden', !isHidden);
        if (parentTr) parentTr.classList.toggle('active-row', isHidden);
        btn.textContent = isHidden ? '🔼' : '👁️';
      }
    });
  });

  // Click on row to toggle detail accordion
  tbody.querySelectorAll('tr.smart-row').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (['A', 'BUTTON', 'SELECT', 'INPUT'].includes(e.target.tagName) || e.target.closest('button, a, select, input')) return;
      const id = tr.dataset.id;
      const detailRow = $(`detail-row-${id}`);
      const toggleBtn = tr.querySelector('.toggle-detail-btn');
      if (detailRow) {
        const isHidden = detailRow.classList.contains('hidden');
        detailRow.classList.toggle('hidden', !isHidden);
        tr.classList.toggle('active-row', isHidden);
        if (toggleBtn) toggleBtn.textContent = isHidden ? '🔼' : '👁️';
      }
    });
  });

  // Edit row buttons
  tbody.querySelectorAll('.edit-dr-row-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = rows.find(x => x.id === btn.dataset.id);
      if (r) editDailyReviewRowModal(r, () => viewMySites());
    });
  });

  initChecklistTable(mainEl, true);
}

function exportChecklistCsv(rows, filename) {
  const headers = [
    '#', 'Website URL', 'Company', 'Maintenance', 'Maintenance Report Sent',
    'ClickUp Link', 'GA4 Report', 'Newsletter Mail', 'Form Submission Mail',
    'Client Response', 'Booking Engine', 'UPTimeRobot Monitoring', 'Cloudflare issues'
  ];

  const lines = [headers.map(h => `"${h}"`).join(',')];

  rows.forEach((r, idx) => {
    const row = [
      idx + 1,
      r.siteUrl || '',
      r.company || '',
      r.maintenanceRaw || r.maintenanceStatus || '',
      r.reportSentRaw || r.reportSentStatus || '',
      r.clickupLink || '',
      r.ga4 || '',
      r.newsletterMail || '',
      r.formSubmissionMail || '',
      r.clientResponse || '',
      r.bookingLink || '',
      r.uptimeRobot || '',
      r.cloudflare || ''
    ];
    lines.push(row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','));
  });

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('📥 Checklist exported to CSV', 'success');
}

function siteRow(r, i, mode = (S.tableMode || 'smart')) {
  const maintOpts = ['Completed','In Progress','To Do','Pending'].map(o =>
    `<option ${r.maintenanceRaw===o?'selected':''}>${o}</option>`).join('');
  const sentOpts = ['Yes','No','To Do'].map(o =>
    `<option ${r.reportSentRaw===o?'selected':''}>${o}</option>`).join('');

  // 1. ClickUp Link
  const cuLink = r.clickupLink
    ? `<a href="${esc(r.clickupLink)}" target="_blank" class="btn-clickup" title="${esc(r.clickupLink)}">⚡ ClickUp</a>`
    : '<span class="dim-dash">—</span>';

  // 2. GA4 Report (Interactive Status Dropdown matching custom design)
  const ga4Options = ['Completed', 'In Progress', 'Pending', 'No GA4 Tag', 'N/A'];
  const curGa4 = (r.ga4 || 'No GA4 Tag').trim();
  const isCustomGa4 = curGa4 && !ga4Options.some(o => o.toLowerCase() === curGa4.toLowerCase());
  const isDimGa4 = /no|n\/a/i.test(curGa4);
  const ga4SelectHtml = `
    <select class="select-ga4-status ${isDimGa4 ? 'val-dim' : ''}" data-row-id="${r.id}" title="GA4 Report Status">
      ${ga4Options.map(o => `<option value="${o}" ${curGa4.toLowerCase() === o.toLowerCase() ? 'selected' : ''}>${o}</option>`).join('')}
      ${isCustomGa4 ? `<option value="${esc(curGa4)}" selected>${esc(curGa4)}</option>` : ''}
    </select>
  `;

  // 3. Newsletter Mail
  let newsHtml = '<span class="dim-dash">—</span>';
  if (r.newsletterMail) {
    const isDim = /no|n\/a/i.test(r.newsletterMail);
    newsHtml = `<span class="cell-text-badge ${isDim ? 'badge-dim' : 'badge-purple'}" title="${esc(r.newsletterMail)}">${esc(r.newsletterMail)}</span>`;
  }

  // 4. Form Submission Mail
  let formHtml = '<span class="dim-dash">—</span>';
  if (r.formSubmissionMail) {
    const isDim = /no|n\/a/i.test(r.formSubmissionMail);
    formHtml = `<span class="cell-text-badge ${isDim ? 'badge-dim' : 'badge-accent'}" title="${esc(r.formSubmissionMail)}">${esc(r.formSubmissionMail)}</span>`;
  }

  // 5. Client Response
  let respHtml = '<span class="dim-dash">—</span>';
  if (r.clientResponse) {
    const isSuccess = /responded|yes|done/i.test(r.clientResponse);
    const isDim = /no|n\/a/i.test(r.clientResponse);
    respHtml = `<span class="cell-text-badge ${isSuccess ? 'badge-success' : isDim ? 'badge-dim' : 'badge-warning'}" title="${esc(r.clientResponse)}">${esc(r.clientResponse)}</span>`;
  }

  // 6. Booking Engine
  let bookHtml = '<span class="dim-dash">—</span>';
  if (r.bookingLink) {
    if (/^https?:\/\//i.test(r.bookingLink)) {
      bookHtml = `<a href="${esc(r.bookingLink)}" target="_blank" class="btn-booking" title="${esc(r.bookingLink)}">🍽️ Booking ↗</a>`;
    } else {
      const isYes = /yes/i.test(r.bookingLink);
      bookHtml = `<span class="cell-text-badge ${isYes ? 'badge-success' : 'badge-dim'}">${esc(r.bookingLink)}</span>`;
    }
  }

  // 7. Domain Expiry (Replaces UptimeRobot column)
  let expiryHtml = '<span class="dim-dash">—</span>';
  const cleanExp = r.domainExpiry ? r.domainExpiry.slice(0, 10) : '';
  if (r.domainExpiry) {
    let daysBadge = '';
    if (r.daysLeft !== null && r.daysLeft !== undefined) {
      if (r.daysLeft <= 0) {
        daysBadge = `<span class="badge-expiry-danger">EXPIRED</span>`;
      } else if (r.daysLeft <= 30) {
        daysBadge = `<span class="badge-expiry-danger">${r.daysLeft}d left</span>`;
      } else if (r.daysLeft <= 90) {
        daysBadge = `<span class="badge-expiry-warning">${r.daysLeft}d left</span>`;
      } else {
        daysBadge = `<span class="badge-expiry-safe">${r.daysLeft}d left</span>`;
      }
    }
    expiryHtml = `
      <div class="expiry-cell-grp">
        <span class="expiry-date-text" title="${esc(r.domainExpiry)}">${esc(cleanExp)}</span>
        ${daysBadge}
        <button class="btn-edit-expiry" data-row-id="${r.id}" data-site-id="${r.siteId||''}" data-url="${esc(r.siteUrl)}" data-current="${esc(cleanExp)}" title="Edit expiration date">✏️</button>
      </div>
    `;
  } else {
    expiryHtml = `
      <div class="expiry-cell-grp">
        <span class="dim-dash">—</span>
        <button class="btn-edit-expiry" data-row-id="${r.id}" data-site-id="${r.siteId||''}" data-url="${esc(r.siteUrl)}" data-current="" title="Set expiration date">✏️</button>
      </div>
    `;
  }

  // Pending Expiry Approval Badge + Actions
  if (r.pendingExpiryRequest) {
    const pr = r.pendingExpiryRequest;
    const isAdmin = S.currentUser?.role === 'admin' || S.currentUser?.role === 'superadmin';
    expiryHtml += `
      <div style="margin-top:3px;display:flex;align-items:center;gap:4px;flex-wrap:wrap">
        <span class="expiry-pending-pill" title="Proposed by ${esc(pr.requestedByName||'User')}: ${esc(pr.requestedDate)}">
          ⏳ ${esc(pr.requestedDate)}
        </span>
        ${isAdmin ? `
          <button class="btn-approve-expiry" data-req-id="${pr.id}" title="Approve date: ${esc(pr.requestedDate)}">✓</button>
          <button class="btn-reject-expiry" data-req-id="${pr.id}" title="Reject date">✕</button>
        ` : ''}
      </div>
    `;
  }

  // 8. Cloudflare Issues
  const isCfIssue = r.cloudflare && !/no/i.test(r.cloudflare) && r.cloudflare.trim() !== '';
  const cfHtml = isCfIssue
    ? `<span class="badge badge-danger" title="${esc(r.cloudflare)}">⚠️ Issue</span>`
    : `<span class="badge badge-success">✓ None</span>`;

  const isOnline = r.uptimeStatus === 'online';
  const isOffline = r.uptimeStatus === 'offline';
  const liveBall = `<span class="live-status-dot ${isOffline ? 'offline' : (isOnline ? 'online' : 'pending')}" id="live-dot-${r.id}" title="${isOffline ? 'Website Offline / Down' : (isOnline ? 'Website Active & Online' : 'Website Status: Unknown')}"></span>`;
  const co = (r.company || 'CW').trim();

  if (mode === 'smart') {
    return `
      <tr class="smart-row" data-url="${esc((r.siteUrl||'').toLowerCase())}" data-status="${r.maintenanceStatus}" data-id="${r.id}">
        <td class="col-select" style="text-align:center">
          <input type="checkbox" class="row-checkbox" data-row-id="${r.id}" data-url="${esc(r.siteUrl)}" data-company="${esc(co)}" />
        </td>
        <td class="col-url url-cell">
          <div class="site-identity-cell">
            ${liveBall}
            <span class="badge badge-${co.toLowerCase().includes('cw')?'cw':'rm'} badge-xs">${esc(co)}</span>
            <a href="${esc(r.siteUrl)}" target="_blank" class="site-domain-link" title="${esc(r.siteUrl)}">
              ${esc(shortUrl(r.siteUrl, 26))} <span class="ext-icon">↗</span>
            </a>
            <button class="btn-uptime-check" data-row-id="${r.id}" data-site-url="${esc(r.siteUrl)}" data-site-id="${r.siteId || ''}" title="Check live uptime now">↺</button>
          </div>
        </td>
        <td class="col-maint">
          <div class="status-cell-grp">
            <select class="status-select select-maint-compact" data-row-id="${r.id}" data-field="maintenanceStatus">${maintOpts}</select>
            <button class="btn-report-toggle ${r.reportSentStatus==='sent'?'sent':'pending'}" data-row-id="${r.id}" data-status="${r.reportSentStatus}" title="Click to toggle Report Sent">
              ${r.reportSentStatus==='sent'?'✓ Sent':'✉ No'}
            </button>
          </div>
        </td>
        <td class="col-links">
          <div class="quick-links-grp">
            ${cuLink !== '<span class="dim-dash">—</span>' ? cuLink : ''}
            ${bookHtml !== '<span class="dim-dash">—</span>' ? bookHtml : ''}
            ${cuLink === '<span class="dim-dash">—</span>' && bookHtml === '<span class="dim-dash">—</span>' ? '<span class="dim-dash">—</span>' : ''}
          </div>
        </td>
        <td class="col-integ">
          <div class="integrations-pill-grp">
            ${ga4SelectHtml}
            ${newsHtml !== '<span class="dim-dash">—</span>' ? newsHtml : ''}
            ${formHtml !== '<span class="dim-dash">—</span>' ? formHtml : ''}
          </div>
        </td>
        <td class="col-resp">${respHtml}</td>
        <td class="col-actions" style="text-align:right">
          <div class="actions-grp" style="justify-content:flex-end">
            <button class="btn btn-ghost btn-sm toggle-detail-btn" data-id="${r.id}" title="Toggle all 12 details">👁️</button>
            <button class="btn btn-ghost btn-sm edit-dr-row-btn" data-id="${r.id}" title="Edit row">✏️</button>
          </div>
        </td>
      </tr>
      <tr class="detail-accordion-row hidden" id="detail-row-${r.id}" data-parent-id="${r.id}">
        <td colspan="7">
          <div class="row-detail-bento">
            <div class="detail-bento-card">
              <div class="dbc-head">🌐 Website &amp; Account</div>
              <div class="dbc-row"><span class="dbc-lbl">Full URL:</span> <a href="${esc(r.siteUrl)}" target="_blank" class="dbc-val">${esc(r.siteUrl)} ↗</a></div>
              <div class="dbc-row"><span class="dbc-lbl">Company:</span> <span class="badge badge-${co.toLowerCase().includes('cw')?'cw':'rm'}">${esc(co)} Maintenance</span></div>
              <div class="dbc-row"><span class="dbc-lbl">ClickUp:</span> ${r.clickupLink ? `<a href="${esc(r.clickupLink)}" target="_blank" class="btn-clickup">⚡ View Task ↗</a>` : '<span class="dim-dash">—</span>'}</div>
            </div>
            <div class="detail-bento-card">
              <div class="dbc-head">🛠️ Review &amp; Report</div>
              <div class="dbc-row"><span class="dbc-lbl">Maintenance:</span> <span class="badge badge-${r.maintenanceStatus==='completed'?'success':r.maintenanceStatus==='in_progress'?'info':'warning'}">${esc(r.maintenanceRaw || r.maintenanceStatus || 'Pending')}</span></div>
              <div class="dbc-row"><span class="dbc-lbl">Report Sent:</span> <span class="badge badge-${r.reportSentStatus==='sent'?'success':'dim'}">${esc(r.reportSentRaw || r.reportSentStatus || 'No')}</span></div>
              <div class="dbc-row"><span class="dbc-lbl">Client Response:</span> <span class="dbc-val">${esc(r.clientResponse || '—')}</span></div>
            </div>
            <div class="detail-bento-card">
              <div class="dbc-head">📈 Analytics &amp; Comms</div>
              <div class="dbc-row"><span class="dbc-lbl">GA4 Report:</span> ${ga4SelectHtml}</div>
              <div class="dbc-row"><span class="dbc-lbl">Newsletter:</span> <span class="dbc-val">${esc(r.newsletterMail || '—')}</span></div>
              <div class="dbc-row"><span class="dbc-lbl">Form Mail:</span> <span class="dbc-val" title="${esc(r.formSubmissionMail)}">${esc(r.formSubmissionMail || '—')}</span></div>
            </div>
            <div class="detail-bento-card">
              <div class="dbc-head">🛡️ Health &amp; Domain</div>
              <div class="dbc-row"><span class="dbc-lbl">Domain Expiry:</span> ${expiryHtml}</div>
              <div class="dbc-row"><span class="dbc-lbl">Booking Engine:</span> ${r.bookingLink ? `<a href="${esc(r.bookingLink)}" target="_blank" class="btn-booking">🍽️ Booking ↗</a>` : '<span class="dim-dash">—</span>'}</div>
              <div class="dbc-row"><span class="dbc-lbl">Cloudflare:</span> ${cfHtml}</div>
              <div style="margin-top:6px;display:flex;justify-content:flex-end">
                <button class="btn btn-secondary btn-sm edit-dr-row-btn" data-id="${r.id}">✏️ Edit Details</button>
              </div>
            </div>
          </div>
        </td>
      </tr>`;
  }

  // Full spreadsheet mode
  return `
    <tr data-url="${esc((r.siteUrl||'').toLowerCase())}" data-status="${r.maintenanceStatus}" data-id="${r.id}">
      <td style="color:var(--text-dim);font-size:11px;text-align:center">
        <input type="checkbox" class="row-checkbox" data-row-id="${r.id}" data-url="${esc(r.siteUrl)}" data-company="${esc(co)}" />
      </td>
      <td class="url-cell">
        <div class="site-identity-cell">
          ${liveBall}
          <a href="${esc(r.siteUrl)}" target="_blank" class="site-domain-link" title="${esc(r.siteUrl)}">${esc(shortUrl(r.siteUrl))} ↗</a>
          <button class="btn-uptime-check" data-row-id="${r.id}" data-site-url="${esc(r.siteUrl)}" data-site-id="${r.siteId || ''}" title="Check live uptime now">↺</button>
        </div>
      </td>
      <td><span class="badge badge-${co.toLowerCase().includes('cw')?'cw':'rm'}">${esc(co)}</span></td>
      <td><select class="status-select select-maint" data-row-id="${r.id}" data-field="maintenanceStatus">${maintOpts}</select></td>
      <td><select class="status-select select-sent" data-row-id="${r.id}" data-field="reportSentStatus">${sentOpts}</select></td>
      <td>${cuLink}</td>
      <td>${ga4SelectHtml}</td>
      <td>${newsHtml}</td>
      <td>${formHtml}</td>
      <td>${respHtml}</td>
      <td>${bookHtml}</td>
      <td>${expiryHtml}</td>
      <td>${cfHtml}</td>
      <td>
        <button class="btn btn-ghost btn-sm edit-dr-row-btn" data-id="${r.id}" title="Edit all columns">✏️</button>
      </td>
    </tr>`;
}

function editDailyReviewRowModal(row, onSaved) {
  if (!row) return;
  const maintOptions = ['Completed','In Progress','To Do','Pending'].map(o =>
    `<option ${row.maintenanceRaw===o?'selected':''}>${o}</option>`).join('');
  const sentOptions = ['Yes','No','To Do'].map(o =>
    `<option ${row.reportSentRaw===o?'selected':''}>${o}</option>`).join('');
  const uptimeOptions = ['Yes','No'].map(o =>
    `<option ${(row.uptimeRobot||'').toLowerCase()===o.toLowerCase()?'selected':''}>${o}</option>`).join('');

  openModal(`Edit Review: ${shortUrl(row.siteUrl)}`, `
    <div style="font-size:12px;color:var(--accent-2);margin-bottom:12px;word-break:break-all">
      <a href="${esc(row.siteUrl)}" target="_blank" style="color:inherit">🌐 ${esc(row.siteUrl)}</a>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group">
        <label class="form-label">Company / Account</label>
        <input class="form-input" id="edr-company" value="${esc(row.company||'CW')}">
      </div>
      <div class="form-group">
        <label class="form-label">Maintenance Status</label>
        <select class="form-select" id="edr-maint">${maintOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Report Sent</label>
        <select class="form-select" id="edr-sent">${sentOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label">ClickUp Task Link</label>
        <input class="form-input" id="edr-clickup" value="${esc(row.clickupLink||'')}" placeholder="https://app.clickup.com/t/...">
      </div>
      <div class="form-group">
        <label class="form-label">GA4 Report</label>
        <input class="form-input" id="edr-ga4" value="${esc(row.ga4||'')}" placeholder="No GA4 Tag / link">
      </div>
      <div class="form-group">
        <label class="form-label">Newsletter Mail</label>
        <input class="form-input" id="edr-newsletter" value="${esc(row.newsletterMail||'')}" placeholder="MailChimp / email">
      </div>
      <div class="form-group">
        <label class="form-label">Form Submission Mail</label>
        <input class="form-input" id="edr-form" value="${esc(row.formSubmissionMail||'')}" placeholder="Recipient email / form name">
      </div>
      <div class="form-group">
        <label class="form-label">Client Response</label>
        <input class="form-input" id="edr-client-resp" value="${esc(row.clientResponse||'')}" placeholder="Client Responded / N/A">
      </div>
      <div class="form-group">
        <label class="form-label">Booking Engine</label>
        <input class="form-input" id="edr-booking" value="${esc(row.bookingLink||'')}" placeholder="OpenTable / Resy link / Yes / No">
      </div>
      <div class="form-group">
        <label class="form-label">UPTimeRobot Monitoring</label>
        <select class="form-select" id="edr-uptime">${uptimeOptions}</select>
      </div>
      <div class="form-group" style="grid-column: span 2">
        <label class="form-label">Cloudflare Issues</label>
        <input class="form-input" id="edr-cf" value="${esc(row.cloudflare||'No')}" placeholder="No / Issue description">
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
    { label: 'Save Changes', cls: 'btn btn-primary', onClick: async () => {
      const maintRaw = $('edr-maint').value;
      const sentRaw = $('edr-sent').value;
      const normMap = { 'Completed':'completed','In Progress':'in_progress','To Do':'todo','Pending':'pending','Yes':'sent','No':'no' };

      const updates = {
        company: $('edr-company').value.trim(),
        maintenanceRaw: maintRaw,
        maintenanceStatus: normMap[maintRaw] || 'pending',
        reportSentRaw: sentRaw,
        reportSentStatus: normMap[sentRaw] || 'no',
        clickupLink: $('edr-clickup').value.trim(),
        ga4: $('edr-ga4').value.trim(),
        newsletterMail: $('edr-newsletter').value.trim(),
        formSubmissionMail: $('edr-form').value.trim(),
        clientResponse: $('edr-client-resp').value.trim(),
        bookingLink: $('edr-booking').value.trim(),
        uptimeRobot: $('edr-uptime').value,
        cloudflare: $('edr-cf').value.trim(),
      };

      try {
        await PUT(`/api/master/daily-review/${row.id}`, updates);
        toast('✅ Row updated successfully', 'success');
        closeModal();
        if (onSaved) onSaved();
      } catch (e) { toast(e.message, 'error'); }
    }}
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: MY TASKS (User)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewMyTasks() {
  setPage('My Tasks');
  let tasks = [];
  try {
    const data = await GET(`/api/master/tasks${S.userId ? `?assigneeId=${S.userId}` : ''}`);
    tasks = data.tasks || [];
  } catch (e) { toast(e.message, 'error'); }

  mainEl.innerHTML = `
    <div class="fade-in">
      <div class="card">
        <div class="card-header"><span class="card-title">📋 Assigned Tasks</span></div>
        <div class="table-wrap">
          <table class="table-smart-fit">
            <thead><tr><th>Task</th><th>Site</th><th>Type</th><th>Priority</th><th>Status</th><th>ClickUp</th></tr></thead>
            <tbody>${tasks.length ? tasks.map(t => `
              <tr>
                <td style="font-weight:500">${esc(t.taskName)}</td>
                <td class="url-cell"><a href="${esc(t.siteUrl)}" target="_blank">${esc(shortUrl(t.siteUrl))}</a></td>
                <td>${esc(t.taskType||'—')}</td>
                <td>${priorityBadge(t.priority)}</td>
                <td>${statusBadge(t.status)}</td>
                <td>${t.clickupLink?`<a class="btn btn-ghost btn-sm" href="${esc(t.clickupLink)}" target="_blank">Open</a>`:'—'}</td>
              </tr>`).join('') : '<tr><td colspan="6" class="empty-state" style="text-align:center;padding:32px">No tasks assigned</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: OVERVIEW (Admin/Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewOverview() {
  setPage('Overview', 'Team-wide snapshot');
  let stats = {}, summary = [];
  let noticeBannerHtml = '';
  try {
    [stats, { summary }, noticeBannerHtml] = await Promise.all([
      GET('/api/master/stats'),
      GET('/api/master/summary'),
      getNoticeBannerHtml(),
    ]);
  } catch (e) { toast(e.message, 'error'); }

  const totalSites = summary.reduce((a,u) => a+u.total, 0);
  const totalDone  = summary.reduce((a,u) => a+u.completed, 0);
  const overallPct = totalSites ? Math.round(totalDone/totalSites*100) : 0;

  mainEl.innerHTML = `
    <div class="fade-in">
      ${noticeBannerHtml}
      <div class="stat-grid">
        <div class="stat-card accent"><div class="stat-value">${stats.totalSites||0}</div><div class="stat-label">Total Sites</div></div>
        <div class="stat-card success"><div class="stat-value">${overallPct}%</div><div class="stat-label">Today's Completion</div></div>
        <div class="stat-card ${stats.urgentDomains>0?'danger':'success'}"><div class="stat-value">${stats.urgentDomains||0}</div><div class="stat-label">Urgent Domains (≤30d)</div></div>
        <div class="stat-card info"><div class="stat-value">${stats.totalTasks||0}</div><div class="stat-label">Open Tasks</div></div>
        <div class="stat-card success"><div class="stat-value">${stats.onlineSites||0}</div><div class="stat-label">Sites Online</div></div>
        <div class="stat-card ${stats.offlineSites>0?'danger':'dim'}"><div class="stat-value">${stats.offlineSites||0}</div><div class="stat-label">Sites Offline</div></div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">👥 Team Progress Today</span>
          <div class="card-actions">
            <span style="font-size:12px;color:var(--text-muted)">${totalDone}/${totalSites} sites completed</span>
          </div>
        </div>
        <div class="card-body" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">
          ${summary.filter(u=>u.total>0).map(u => `
            <div class="user-progress-card">
              <div class="upc-top">
                <span class="upc-name">${esc(u.user)}</span>
                <span class="upc-pct">${u.pct}%</span>
              </div>
              <div class="progress-wrap" style="margin-bottom:8px"><div class="progress-fill" style="width:${u.pct}%"></div></div>
              <div class="upc-meta">
                <span>✅ ${u.completed} done</span>
                <span>🔄 ${u.inProgress} in progress</span>
                <span>📧 ${u.reportSent} sent</span>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;

  mainEl.querySelectorAll('.btn-open-notices').forEach(btn => btn.addEventListener('click', openNoticeBoardModal));
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: ALL USERS (Admin/Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewAllUsers() {
  setPage('Team Progress', 'Click a user to see their sites');
  let summary = [];
  let noticeBannerHtml = '';
  try {
    const [sData, nHtml] = await Promise.all([
      GET('/api/master/summary'),
      getNoticeBannerHtml()
    ]);
    summary = sData.summary || [];
    noticeBannerHtml = nHtml;
  } catch (e) { toast(e.message,'error'); }

  const tabs = summary.filter(u=>u.total>0);
  if (!tabs.length) { mainEl.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><p>No data synced yet.</p></div>`; return; }

  const firstUser = tabs[0];
  mainEl.innerHTML = `
    <div class="fade-in">
      ${noticeBannerHtml}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">
        ${tabs.map((u,i) => `
          <button class="btn ${i===0?'btn-primary':'btn-secondary'} user-tab-btn" data-uid="${u.userId}" data-uname="${esc(u.user)}">
            ${esc(u.user)} <span class="badge badge-${u.pct>=100?'success':u.pct>50?'info':'warning'}">${u.pct}%</span>
          </button>`).join('')}
      </div>
      <div id="user-sites-panel"></div>
    </div>`;

  mainEl.querySelectorAll('.btn-open-notices').forEach(btn => btn.addEventListener('click', openNoticeBoardModal));

  async function loadUser(userId, userName) {
    const panel = $('user-sites-panel');
    panel.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Loading…</p></div>';
    try {
      const { rows } = await GET(`/api/master/daily-review?userId=${userId}&user=${encodeURIComponent(userName)}`);
      const u = summary.find(x=>x.userId===userId)||{};
      const isSmart = S.tableMode !== 'full';
      panel.innerHTML = `
        <div class="card">
          <div class="card-header">
            <span class="card-title">🌐 ${esc(userName)}'s Assigned Sites (${rows.length})</span>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span class="user-pct-text" style="font-size:12px;color:var(--text-muted)">${u.pct||0}% complete</span>
              <div class="progress-wrap" style="width:100px"><div class="progress-fill user-progress-fill" style="width:${u.pct||0}%"></div></div>
              <div class="view-mode-toggle" id="user-table-mode-toggle">
                <button class="btn btn-sm mode-btn ${isSmart?'active':''}" data-mode="smart" title="Smart Fit 100vw - No horizontal scroll">⚡ Smart Fit</button>
                <button class="btn btn-sm mode-btn ${!isSmart?'active':''}" data-mode="full" title="Spreadsheet mode">📋 Full Spread</button>
              </div>
              <button class="btn btn-secondary btn-sm" id="btn-assign-sites-to-user">➕ Assign Websites</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="${isSmart ? 'table-smart-fit' : 'table-full-spread'}">
              <thead>
                ${isSmart ? `
                  <tr>
                    <th class="col-select" style="text-align:center">
                      <input type="checkbox" class="select-all-checkbox" title="Select all sites" />
                    </th>
                    <th class="col-url">Website &amp; Account</th>
                    <th class="col-maint">Maintenance &amp; Report</th>
                    <th class="col-links">Tasks &amp; Links</th>
                    <th class="col-integ">Integrations</th>
                    <th class="col-resp">Response</th>
                    <th class="col-actions" style="text-align:right">Actions</th>
                  </tr>
                ` : `
                  <tr>
                    <th style="width:36px;text-align:center">
                      <input type="checkbox" class="select-all-checkbox" title="Select all sites" />
                    </th>
                    <th>Website URL</th>
                    <th>Company</th>
                    <th>Maintenance</th>
                    <th>Report Sent</th>
                    <th>ClickUp Link</th>
                    <th>GA4 Report</th>
                    <th>Newsletter Mail</th>
                    <th>Form Submission Mail</th>
                    <th>Client Response</th>
                    <th>Booking Engine</th>
                    <th>Domain Expiry</th>
                    <th>Cloudflare</th>
                    <th>Actions</th>
                  </tr>
                `}
              </thead>
              <tbody id="user-sites-tbody">${rows.map((r,i) => siteRow(r, i, isSmart ? 'smart' : 'full')).join('')}</tbody>
            </table>
          </div>

          <!-- Bulk Edit Sticky Dock -->
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
              <button class="btn btn-secondary btn-sm" id="btn-bulk-uptime" title="Check uptime for all selected sites">↺ Check Uptime</button>
              <button class="btn btn-ghost btn-sm" id="btn-clear-selection" title="Clear selection">✕</button>
            </div>
          </div>
        </div>`;

      // Mode toggle
      panel.querySelectorAll('#user-table-mode-toggle .mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.mode;
          S.tableMode = mode;
          try { localStorage.setItem('officeos_table_mode', mode); } catch {}
          loadUser(userId, userName);
        });
      });

      // Wire up Assign Websites button
      const assignBtn = $('btn-assign-sites-to-user');
      if (assignBtn) {
        assignBtn.addEventListener('click', () => {
          openAssignSitesToUserModal(userId, userName, () => loadUser(userId, userName));
        });
      }

      // Wire up edit buttons
      panel.querySelectorAll('.edit-dr-row-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = rows.find(x => x.id === btn.dataset.id);
          if (r) editDailyReviewRowModal(r, () => loadUser(userId, userName));
        });
      });

      // Quick 1-click toggle for Report Sent
      panel.querySelectorAll('.btn-report-toggle').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const { rowId, status } = btn.dataset;
          const newStatus = status === 'sent' ? 'no' : 'sent';
          const newRaw = newStatus === 'sent' ? 'Yes' : 'No';
          try {
            await PUT(`/api/master/daily-review/${rowId}`, {
              reportSentStatus: newStatus,
              reportSentRaw: newRaw
            });
            btn.dataset.status = newStatus;
            btn.className = `btn-report-toggle ${newStatus === 'sent' ? 'sent' : 'pending'}`;
            btn.textContent = newStatus === 'sent' ? '✓ Sent' : '✉ No';
            toast(`Report marked ${newRaw}`, 'success');
          } catch (err) { toast(err.message, 'error'); }
        });
      });

      // Toggle detail accordion
      panel.querySelectorAll('.toggle-detail-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const detailRow = $(`detail-row-${id}`);
          const parentTr = panel.querySelector(`tr[data-id="${id}"]:not(.detail-accordion-row)`);
          if (detailRow) {
            const isHidden = detailRow.classList.contains('hidden');
            detailRow.classList.toggle('hidden', !isHidden);
            if (parentTr) parentTr.classList.toggle('active-row', isHidden);
            btn.textContent = isHidden ? '🔼' : '👁️';
          }
        });
      });

      // Click on smart-row to toggle detail accordion
      panel.querySelectorAll('tr.smart-row').forEach(tr => {
        tr.addEventListener('click', (e) => {
          if (['A', 'BUTTON', 'SELECT', 'INPUT'].includes(e.target.tagName) || e.target.closest('button, a, select, input')) return;
          const id = tr.dataset.id;
          const detailRow = $(`detail-row-${id}`);
          const toggleBtn = tr.querySelector('.toggle-detail-btn');
          if (detailRow) {
            const isHidden = detailRow.classList.contains('hidden');
            detailRow.classList.toggle('hidden', !isHidden);
            tr.classList.toggle('active-row', isHidden);
            if (toggleBtn) toggleBtn.textContent = isHidden ? '🔼' : '👁️';
          }
        });
      });

      // Wire up status dropdowns
      panel.querySelectorAll('.status-select').forEach(sel => {
        sel.addEventListener('change', async e => {
          const { rowId, field } = e.target.dataset;
          const value = e.target.value;
          const normMap = { 'Completed':'completed','In Progress':'in_progress','To Do':'todo','Pending':'pending','Yes':'sent','No':'no' };
          try {
            await PUT(`/api/master/daily-review/${rowId}`, {
              [field]: normMap[value] || value,
              [field + 'Raw']: value,
            });
            toast('Status updated', 'success');
          } catch (err) { toast(err.message, 'error'); }
        });
      });

      // Initialize Quick Uptime, Bulk Edit, and Live Recalculation
      initChecklistTable(panel, false, userId);

    } catch (e) { panel.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`; }
  }

  mainEl.querySelectorAll('.user-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      mainEl.querySelectorAll('.user-tab-btn').forEach(b => b.className = 'btn btn-secondary user-tab-btn');
      btn.className = 'btn btn-primary user-tab-btn';
      loadUser(btn.dataset.uid, btn.dataset.uname);
    });
  });
  loadUser(firstUser.userId, firstUser.user);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: SITES (Admin/Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewSites() {
  setPage('All Sites', 'CW + RM combined site list');
  let sites = [];
  try { ({ sites } = await GET('/api/master/sites')); } catch (e) { toast(e.message,'error'); }

  mainEl.innerHTML = `
    <div class="fade-in">
      <div class="toolbar">
        <div class="search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input id="site-search" class="search-input" placeholder="Search URL, company…">
        </div>
        <select id="acct-filter" class="filter-select"><option value="">All Accounts</option><option value="CW">CW</option><option value="RM">RM</option></select>
        <select id="uptime-filter" class="filter-select"><option value="">All Uptime</option><option value="online">Online</option><option value="offline">Offline</option><option value="unknown">Unknown</option></select>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">🌐 Sites (${sites.length})</span>
          <div class="card-actions">
            <button class="btn btn-secondary btn-sm" id="check-uptime-btn">💓 Check Uptime</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table-smart-fit">
            <thead><tr><th>Website</th><th>Account</th><th>Company</th><th>CMS</th><th>A/C Manager</th><th>Domain Expiry</th><th>Latest Maint.</th><th>Uptime</th><th>Assignees</th><th>Actions</th></tr></thead>
            <tbody id="sites-tbody">
              ${sites.map(s => siteFullRow(s)).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  // Filters
  const tbody = $('sites-tbody');
  const allRows = [...tbody.querySelectorAll('tr')];
  function filter() {
    const q = $('site-search').value.toLowerCase();
    const a = $('acct-filter').value;
    const u = $('uptime-filter').value;
    allRows.forEach(tr => {
      tr.classList.toggle('hidden',
        (q && !tr.dataset.url?.includes(q) && !tr.dataset.company?.includes(q)) ||
        (a && tr.dataset.account !== a) ||
        (u && tr.dataset.uptime !== u)
      );
    });
  }
  $('site-search').addEventListener('input', filter);
  $('acct-filter').addEventListener('change', filter);
  $('uptime-filter').addEventListener('change', filter);

  // Assign buttons
  tbody.querySelectorAll('.assign-site-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = sites.find(x => x.id === btn.dataset.id);
      if (s) openAssignModal(btn.dataset.id, s, () => viewSites());
    });
  });

  // Edit buttons
  tbody.querySelectorAll('.edit-site-btn').forEach(btn => {
    btn.addEventListener('click', () => editSiteModal(btn.dataset.id, sites.find(s=>s.id===btn.dataset.id)));
  });

  // Check uptime
  $('check-uptime-btn').addEventListener('click', async () => {
    toast('Checking all sites… this may take a few minutes', 'info', 10000);
    try {
      const r = await POST('/api/master/check-uptime', {});
      toast(`✅ ${r.online} online, ${r.offline} offline`, 'success', 6000);
      navigate('sites');
    } catch (e) { toast(e.message, 'error'); }
  });
}

function siteFullRow(s) {
  const assigneeNames = (s.assignedUsers||[]).map(uid => {
    const u = S.users.find(u => u.id === uid);
    return u ? u.name : '?';
  }).join(', ');
  return `
    <tr data-url="${esc((s.url||'').toLowerCase())}" data-account="${esc(s.account)}" data-company="${esc((s.company||'').toLowerCase())}" data-uptime="${esc(s.uptimeStatus||'unknown')}">
      <td class="url-cell"><a href="${esc(s.url)}" target="_blank">${esc(shortUrl(s.url))}</a></td>
      <td><span class="badge badge-${s.account==='CW'?'cw':'rm'}">${esc(s.account)}</span></td>
      <td style="font-size:12px">${esc(s.company||'—')}</td>
      <td style="font-size:12px">${esc(s.cms||'—')}</td>
      <td style="font-size:12px">${esc(s.accountManager||'—')}</td>
      <td>${domainBadge(s.daysLeft)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${esc(s.latestMonthStatus||'—')}</td>
      <td>${uptimeDot(s.uptimeStatus)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${esc(assigneeNames||'Unassigned')}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-secondary btn-sm assign-site-btn" data-id="${s.id}" title="Assign to team members">👤 Assign</button>
          <button class="btn btn-ghost btn-sm edit-site-btn" data-id="${s.id}" title="Edit site metadata">✏️</button>
        </div>
      </td>
    </tr>`;
}

function openAssignModal(siteId, site, onSaved) {
  if (!site) return;
  const currentAssigned = site.assignedUsers || [];

  openModal(`Assign Users: ${shortUrl(site.url)}`, `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
      Assign team members to manage <strong>${esc(site.url)}</strong> (${esc(site.company || site.account || 'CW')}).<br>
      Changes will automatically update their <em>My Sites</em> checklist.
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button type="button" class="btn btn-secondary btn-sm" id="btn-select-all-users">Select All</button>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-clear-all-users">Clear All</button>
    </div>
    <div class="user-assign-grid">
      ${S.users.map(u => `
        <label class="user-check-item">
          <input type="checkbox" class="user-assign-checkbox" value="${u.id}" ${currentAssigned.includes(u.id)?'checked':''}>
          <span class="user-check-avatar">${esc((u.name||'U')[0].toUpperCase())}</span>
          <div>
            <div class="user-check-name">${esc(u.name)}</div>
            <div class="user-check-role">${esc(u.role)}</div>
          </div>
        </label>
      `).join('')}
    </div>
  `, [
    { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
    { label: 'Save Assignments', cls: 'btn btn-primary', onClick: async () => {
      const selected = [...document.querySelectorAll('.user-assign-checkbox:checked')].map(cb => cb.value);
      try {
        await POST(`/api/master/sites/${siteId}/assign`, { userIds: selected });
        toast(`✅ Assigned ${selected.length} user(s) to site`, 'success');
        closeModal();
        if (onSaved) onSaved();
        else navigate('sites');
      } catch (err) { toast(err.message, 'error'); }
    }}
  ]);

  setTimeout(() => {
    const selAll = $('btn-select-all-users');
    const clrAll = $('btn-clear-all-users');
    if (selAll) selAll.addEventListener('click', () => {
      document.querySelectorAll('.user-assign-checkbox').forEach(cb => cb.checked = true);
    });
    if (clrAll) clrAll.addEventListener('click', () => {
      document.querySelectorAll('.user-assign-checkbox').forEach(cb => cb.checked = false);
    });
  }, 50);
}

async function openAssignSitesToUserModal(userId, userName, onSaved) {
  let sites = [];
  try {
    const data = await GET('/api/master/sites');
    sites = data.sites || [];
  } catch (e) { toast(e.message, 'error'); return; }

  openModal(`Assign Websites to ${esc(userName)}`, `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
      Select websites that <strong>${esc(userName)}</strong> is responsible for. These will appear in their <em>My Sites</em> checklist.
    </div>
    <div class="toolbar" style="margin-bottom:12px">
      <div class="search-wrap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input id="assign-site-search" class="search-input" placeholder="Search websites…">
      </div>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-select-all-sites">Select All Visible</button>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-clear-all-sites">Clear All</button>
    </div>
    <div id="assign-sites-list" style="max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
      ${sites.map(s => {
        const isAssigned = (s.assignedUsers||[]).includes(userId);
        return `
          <label class="user-check-item site-check-row" data-url="${esc((s.url||'').toLowerCase())}" data-comp="${esc((s.company||'').toLowerCase())}" style="justify-content:space-between">
            <div style="display:flex;align-items:center;gap:10px">
              <input type="checkbox" class="site-assign-checkbox" value="${s.id}" ${isAssigned?'checked':''}>
              <div>
                <div style="font-weight:600;font-size:12px">${esc(shortUrl(s.url, 45))}</div>
                <div style="font-size:11px;color:var(--text-muted)">${esc(s.company||'—')} · ${esc(s.account||'CW')}</div>
              </div>
            </div>
            <span class="badge badge-${s.account==='CW'?'cw':'rm'}">${esc(s.account||'CW')}</span>
          </label>`;
      }).join('')}
    </div>
  `, [
    { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
    { label: 'Save Assignments', cls: 'btn btn-primary', onClick: async () => {
      const checkedSiteIds = new Set([...document.querySelectorAll('.site-assign-checkbox:checked')].map(cb => cb.value));
      let count = 0;
      try {
        for (const s of sites) {
          const currentlyAssigned = (s.assignedUsers || []).includes(userId);
          const shouldAssign = checkedSiteIds.has(s.id);
          if (currentlyAssigned !== shouldAssign) {
            let newUserIds = (s.assignedUsers || []).filter(id => id !== userId);
            if (shouldAssign) newUserIds.push(userId);
            await POST(`/api/master/sites/${s.id}/assign`, { userIds: newUserIds });
            count++;
          }
        }
        toast(`✅ Updated assignments for ${count} site(s)`, 'success');
        closeModal();
        if (onSaved) onSaved();
      } catch (err) { toast(err.message, 'error'); }
    }}
  ]);

  setTimeout(() => {
    const searchInput = $('assign-site-search');
    const siteRows = document.querySelectorAll('.site-check-row');
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        const q = e.target.value.toLowerCase();
        siteRows.forEach(row => {
          const u = row.dataset.url || '';
          const c = row.dataset.comp || '';
          row.classList.toggle('hidden', q && !u.includes(q) && !c.includes(q));
        });
      });
    }
    const selAll = $('btn-select-all-sites');
    const clrAll = $('btn-clear-all-sites');
    if (selAll) selAll.addEventListener('click', () => {
      document.querySelectorAll('.site-check-row:not(.hidden) .site-assign-checkbox').forEach(cb => cb.checked = true);
    });
    if (clrAll) clrAll.addEventListener('click', () => {
      document.querySelectorAll('.site-assign-checkbox').forEach(cb => cb.checked = false);
    });
  }, 50);
}

function editSiteModal(id, site) {
  if (!site) return;
  const currentAssigned = site.assignedUsers || [];
  openModal(`Edit Site: ${shortUrl(site.url)}`,
    `<div class="form-group"><label class="form-label">Company</label><input class="form-input" id="edit-company" value="${esc(site.company)}"></div>
     <div class="form-group"><label class="form-label">A/C Manager</label><input class="form-input" id="edit-acm" value="${esc(site.accountManager)}"></div>
     <div class="form-group"><label class="form-label">CMS</label><input class="form-input" id="edit-cms" value="${esc(site.cms)}"></div>
     <div class="form-group"><label class="form-label">Status</label>
       <select class="form-select" id="edit-status">
         <option ${site.status==='Active'?'selected':''}>Active</option>
         <option ${site.status==='Inactive'?'selected':''}>Inactive</option>
       </select></div>
     <div class="form-group"><label class="form-label">Assign Users</label>
       <div class="user-assign-grid">
         ${S.users.map(u=>`
           <label class="user-check-item">
             <input type="checkbox" class="modal-edit-assignee" value="${u.id}" ${currentAssigned.includes(u.id)?'checked':''}>
             <span class="user-check-avatar">${esc((u.name||'U')[0].toUpperCase())}</span>
             <span class="user-check-name">${esc(u.name)}</span>
           </label>
         `).join('')}
       </div>
     </div>`,
    [
      { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
      { label: 'Save', cls: 'btn btn-primary', onClick: async () => {
        const selected = [...document.querySelectorAll('.modal-edit-assignee:checked')].map(cb => cb.value);
        try {
          await PUT(`/api/master/sites/${id}`, {
            company: $('edit-company').value,
            accountManager: $('edit-acm').value,
            cms: $('edit-cms').value,
            status: $('edit-status').value,
            assignedUsers: selected,
          });
          toast('Site updated', 'success');
          closeModal();
          navigate('sites');
        } catch (e) { toast(e.message, 'error'); }
      }},
    ]
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: TASKS (Admin/Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewTasks() {
  setPage('Tasks', 'Manage and assign tasks');
  let tasks = [];
  try { ({ tasks } = await GET('/api/master/tasks')); } catch (e) { toast(e.message,'error'); }

  mainEl.innerHTML = `
    <div class="fade-in">
      <div class="toolbar">
        <div class="search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input id="task-search" class="search-input" placeholder="Search tasks…">
        </div>
        <select id="task-status-filter" class="filter-select">
          <option value="">All Status</option>
          <option value="todo">To Do</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
        </select>
        <select id="task-assignee-filter" class="filter-select">
          <option value="">All Assignees</option>
          ${S.users.map(u=>`<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" id="new-task-btn">+ New Task</button>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">📋 Tasks (${tasks.length})</span></div>
        <div class="table-wrap">
          <table class="table-smart-fit">
            <thead><tr><th>Task</th><th>Site</th><th>Assignee</th><th>Type</th><th>Priority</th><th>Status</th><th>ClickUp</th><th>Actions</th></tr></thead>
            <tbody id="tasks-tbody">
              ${tasks.map(t => taskRow(t)).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  // Filters
  const tbody = $('tasks-tbody');
  const allRows = [...tbody.querySelectorAll('tr')];
  function filterTasks() {
    const q = $('task-search').value.toLowerCase();
    const st = $('task-status-filter').value;
    const as = $('task-assignee-filter').value;
    allRows.forEach(tr => {
      tr.classList.toggle('hidden',
        (q && !tr.dataset.task?.includes(q) && !tr.dataset.site?.includes(q)) ||
        (st && tr.dataset.status !== st) ||
        (as && tr.dataset.assignee !== as)
      );
    });
  }
  $('task-search').addEventListener('input', filterTasks);
  $('task-status-filter').addEventListener('change', filterTasks);
  $('task-assignee-filter').addEventListener('change', filterTasks);

  $('new-task-btn').addEventListener('click', () => newTaskModal());
  tbody.querySelectorAll('.edit-task-btn').forEach(btn => {
    btn.addEventListener('click', () => editTaskModal(btn.dataset.id, tasks.find(t=>t.id===btn.dataset.id)));
  });
  tbody.querySelectorAll('.del-task-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this task?')) return;
      try { await DELETE(`/api/master/tasks/${btn.dataset.id}`); toast('Deleted','success'); navigate('tasks'); }
      catch (e) { toast(e.message,'error'); }
    });
  });
  // Inline status change
  tbody.querySelectorAll('.task-status-sel').forEach(sel => {
    sel.addEventListener('change', async e => {
      const id = e.target.dataset.id;
      try { await PUT(`/api/master/tasks/${id}`, { status: e.target.value }); toast('Status updated','success'); }
      catch (e2) { toast(e2.message,'error'); }
    });
  });
}

function taskRow(t) {
  const statuses = ['todo','in_progress','completed'];
  const opts = statuses.map(s=>`<option value="${s}" ${t.status===s?'selected':''}>${s.replace('_',' ')}</option>`).join('');
  return `
    <tr data-task="${esc((t.taskName||'').toLowerCase())}" data-site="${esc((t.siteUrl||'').toLowerCase())}" data-status="${esc(t.status)}" data-assignee="${esc(t.assigneeName)}">
      <td style="font-weight:500;max-width:200px">${esc(t.taskName)}</td>
      <td class="url-cell"><a href="${esc(t.siteUrl)}" target="_blank">${esc(shortUrl(t.siteUrl))}</a></td>
      <td>${esc(t.assigneeName||'Unassigned')}</td>
      <td style="font-size:12px">${esc(t.taskType||'—')}</td>
      <td>${priorityBadge(t.priority)}</td>
      <td><select class="task-status-sel status-select" data-id="${t.id}">${opts}</select></td>
      <td>${t.clickupLink?`<a class="btn btn-ghost btn-sm" href="${esc(t.clickupLink)}" target="_blank">Open</a>`:'—'}</td>
      <td style="display:flex;gap:4px">
        <button class="btn btn-ghost btn-sm edit-task-btn" data-id="${t.id}">✏️</button>
        <button class="btn btn-danger btn-sm del-task-btn" data-id="${t.id}">🗑</button>
      </td>
    </tr>`;
}

function taskModalBody(t = {}) {
  return `
    <div class="form-group"><label class="form-label">Task Name *</label><input class="form-input" id="t-name" value="${esc(t.taskName||'')}"></div>
    <div class="form-group"><label class="form-label">Site URL</label><input class="form-input" id="t-site" value="${esc(t.siteUrl||'')}"></div>
    <div class="form-group"><label class="form-label">Assignee</label>
      <select class="form-select" id="t-assignee">
        <option value="">Unassigned</option>
        ${S.users.map(u=>`<option value="${u.id}" ${t.assigneeId===u.id?'selected':''}>${esc(u.name)}</option>`).join('')}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group"><label class="form-label">Task Type</label><input class="form-input" id="t-type" value="${esc(t.taskType||'')}"></div>
      <div class="form-group"><label class="form-label">Priority</label>
        <select class="form-select" id="t-priority">
          ${['high','medium','low'].map(p=>`<option ${t.priority===p?'selected':''}>${p}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-group"><label class="form-label">ClickUp Link</label><input class="form-input" id="t-clickup" value="${esc(t.clickupLink||'')}"></div>
    <div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" id="t-notes">${esc(t.notes||'')}</textarea></div>`;
}

function gatherTask() {
  const uid = $('t-assignee').value;
  const u = S.users.find(x=>x.id===uid);
  return {
    taskName: $('t-name').value,
    siteUrl: $('t-site').value,
    assigneeId: uid || null,
    assigneeName: u?.name || '',
    taskType: $('t-type').value,
    priority: $('t-priority').value,
    clickupLink: $('t-clickup').value,
    notes: $('t-notes').value,
  };
}

function newTaskModal() {
  openModal('New Task', taskModalBody(), [
    { label:'Cancel', cls:'btn btn-secondary', onClick: closeModal },
    { label:'Create', cls:'btn btn-primary', onClick: async () => {
      const b = gatherTask();
      if (!b.taskName) { toast('Task name required','error'); return; }
      try { await POST('/api/master/tasks', b); toast('Task created','success'); closeModal(); navigate('tasks'); }
      catch (e) { toast(e.message,'error'); }
    }},
  ]);
}

function editTaskModal(id, t) {
  if (!t) return;
  openModal('Edit Task', taskModalBody(t), [
    { label:'Cancel', cls:'btn btn-secondary', onClick: closeModal },
    { label:'Save', cls:'btn btn-primary', onClick: async () => {
      try { await PUT(`/api/master/tasks/${id}`, gatherTask()); toast('Saved','success'); closeModal(); navigate('tasks'); }
      catch (e) { toast(e.message,'error'); }
    }},
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: DOMAIN EXPIRY
// ═══════════════════════════════════════════════════════════════════════════════
async function viewDomainExpiry() {
  setPage('Domain Expiry', 'Sorted by urgency');
  let domains = [];
  try { ({ domains } = await GET('/api/master/domain-expiry')); } catch (e) { toast(e.message,'error'); }

  const urgent  = domains.filter(d => d.urgent).length;
  const warning = domains.filter(d => d.warning).length;

  mainEl.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid">
        <div class="stat-card danger"><div class="stat-value">${urgent}</div><div class="stat-label">Critical (≤30 days)</div></div>
        <div class="stat-card warning"><div class="stat-value">${warning}</div><div class="stat-label">Warning (31–90 days)</div></div>
        <div class="stat-card success"><div class="stat-value">${domains.length-urgent-warning}</div><div class="stat-label">Healthy (&gt;90 days)</div></div>
        <div class="stat-card accent"><div class="stat-value">${domains.length}</div><div class="stat-label">Total Domains</div></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">📅 All Domains</span></div>
        <div class="table-wrap"><table class="table-smart-fit">
          <thead><tr><th>URL</th><th>Account</th><th>Company</th><th>A/C Manager</th><th>CMS</th><th>Expiry Date</th><th>Status</th></tr></thead>
          <tbody>
            ${domains.map(d => `<tr>
              <td class="url-cell"><a href="${esc(d.url)}" target="_blank">${esc(shortUrl(d.url))}</a></td>
              <td><span class="badge badge-${d.account==='CW'?'cw':'rm'}">${esc(d.account||'—')}</span></td>
              <td style="font-size:12px">${esc(d.company||'—')}</td>
              <td style="font-size:12px">${esc(d.accountManager||'—')}</td>
              <td style="font-size:12px">${esc(d.cms||'—')}</td>
              <td style="font-size:12px">${esc(d.expiryDate||'—')}</td>
              <td>${domainBadge(d.daysLeft)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: UPTIME MONITOR
// ═══════════════════════════════════════════════════════════════════════════════
async function viewUptime() {
  setPage('Uptime Monitor', 'Live site status');
  let sites = [];
  try { ({ sites } = await GET('/api/master/sites')); } catch (e) { toast(e.message,'error'); }

  const online  = sites.filter(s=>s.uptimeStatus==='online').length;
  const offline = sites.filter(s=>s.uptimeStatus==='offline').length;
  const unknown = sites.filter(s=>s.uptimeStatus==='unknown').length;

  mainEl.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid">
        <div class="stat-card success"><div class="stat-value">${online}</div><div class="stat-label">🟢 Online</div></div>
        <div class="stat-card danger"><div class="stat-value">${offline}</div><div class="stat-label">🔴 Offline</div></div>
        <div class="stat-card dim"><div class="stat-value">${unknown}</div><div class="stat-label">⚪ Not Checked</div></div>
        <div class="stat-card accent"><div class="stat-value">${sites.length}</div><div class="stat-label">Total Sites</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">💓 Site Availability</span>
          <div class="card-actions">
            <button class="btn btn-primary btn-sm" id="check-all-btn">🔄 Check All Sites</button>
            <div id="uptime-progress" class="hidden" style="font-size:12px;color:var(--text-muted)"></div>
          </div>
        </div>
        <div id="uptime-results" class="card-body">
          <div class="uptime-grid">
            ${sites.map(s=>`
              <div class="uptime-item ${s.uptimeStatus||'unknown'}" data-site-id="${s.id}">
                ${uptimeDot(s.uptimeStatus)}
                <span class="uptime-url" title="${esc(s.url)}">${esc(shortUrl(s.url,32))}</span>
                ${s.uptimeResponseTime?`<span class="uptime-ms">${s.uptimeResponseTime}ms</span>`:''}
                <button class="btn btn-ghost btn-sm check-one-btn" data-id="${s.id}" style="padding:2px 6px">↺</button>
              </div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;

  // Check all via SSE
  $('check-all-btn').addEventListener('click', async () => {
    const btn = $('check-all-btn');
    const prog = $('uptime-progress');
    btn.disabled = true; btn.textContent = '⏳ Checking…';
    prog.classList.remove('hidden'); prog.textContent = '0 / ' + sites.length;
    let done = 0;
    try {
      const resp = await fetch('/api/master/check-uptime', {
        method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: '{}',
      });
      const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done: d } = await reader.read(); if (d) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const msg = JSON.parse(line.slice(6));
            if (msg.url) {
              done = msg.done;
              prog.textContent = `${done} / ${msg.total}`;
              // Update that site's row
              const item = document.querySelector(`.uptime-item[data-site-id="${msg.url}"]`);
              // We don't have id in msg, update by checking url — re-fetch handled by navigate
            }
            if (msg.complete) { toast(`✅ Done — ${done} sites checked`,'success',5000); navigate('uptime'); }
          } catch {}
        }
      }
    } catch (e) { toast(e.message,'error'); }
    btn.disabled = false; btn.textContent = '🔄 Check All Sites';
  });

  // Check single
  mainEl.querySelectorAll('.check-one-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '⏳';
      try {
        const { result } = await POST('/api/master/check-uptime', { siteId: btn.dataset.id });
        const item = btn.closest('.uptime-item');
        item.className = `uptime-item ${result.status}`;
        item.querySelector('.uptime-dot').className = `uptime-dot ${result.status}`;
        item.querySelector('.uptime-dot').textContent = result.status==='online'?'🟢 Online':'🔴 Offline';
        btn.textContent = '↺';
        toast(`${result.status === 'online' ? '🟢 Online' : '🔴 Offline'}${result.responseTime?' · '+result.responseTime+'ms':''}`, result.status==='online'?'success':'error');
      } catch (e) { toast(e.message,'error'); btn.textContent='↺'; }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: PROPERTY REGISTRY (Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewProperties() {
  setPage('Property Registry', 'RM Active Projects');
  let properties = [];
  try { ({ properties } = await GET('/api/master/properties')); } catch (e) { toast(e.message,'error'); }

  mainEl.innerHTML = `
    <div class="fade-in">
      <div class="toolbar">
        <div class="search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input id="prop-search" class="search-input" placeholder="Search properties…">
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">🏢 Properties (${properties.length})</span></div>
        <div class="table-wrap"><table class="table-smart-fit">
          <thead><tr><th>Property</th><th>URL</th><th>Type</th><th>Status</th><th>SEO</th><th>H&amp;M</th><th>SEO Assignee</th><th>Web Assignee</th><th>Actions</th></tr></thead>
          <tbody id="prop-tbody">
            ${properties.map(p=>`
              <tr data-name="${esc((p.name||'').toLowerCase())}">
                <td style="font-weight:500">${esc(p.name||'—')}</td>
                <td class="url-cell"><a href="${esc(p.url)}" target="_blank">${esc(shortUrl(p.url))}</a></td>
                <td style="font-size:12px">${esc(p.type||'—')}</td>
                <td><span class="badge badge-${p.status==='Active'?'success':'dim'}">${esc(p.status)}</span></td>
                <td><span class="badge badge-${p.seo==='Yes'?'success':'dim'}">${esc(p.seo||'—')}</span></td>
                <td><span class="badge badge-${p.hm==='Yes'?'success':'dim'}">${esc(p.hm||'—')}</span></td>
                <td style="font-size:12px">${esc(p.seoAssignee||'—')}</td>
                <td style="font-size:12px">${esc(p.webAssignee||'—')}</td>
                <td><button class="btn btn-ghost btn-sm edit-prop-btn" data-id="${p.id}">✏️ Edit</button></td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    </div>`;

  // Search
  $('prop-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    [...$('prop-tbody').querySelectorAll('tr')].forEach(tr => tr.classList.toggle('hidden', q && !tr.dataset.name?.includes(q)));
  });

  // Edit
  mainEl.querySelectorAll('.edit-prop-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const prop = properties.find(p=>p.id===btn.dataset.id);
      if (!prop) return;
      openModal(`Edit: ${prop.name}`,
        `<div class="form-group"><label class="form-label">Property Name</label><input class="form-input" id="p-name" value="${esc(prop.name)}"></div>
         <div class="form-group"><label class="form-label">URL</label><input class="form-input" id="p-url" value="${esc(prop.url)}"></div>
         <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
           <div class="form-group"><label class="form-label">Type</label><input class="form-input" id="p-type" value="${esc(prop.type)}"></div>
           <div class="form-group"><label class="form-label">Status</label>
             <select class="form-select" id="p-status">
               <option ${prop.status==='Active'?'selected':''}>Active</option>
               <option ${prop.status==='Inactive'?'selected':''}>Inactive</option>
             </select></div>
         </div>
         <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
           <div class="form-group"><label class="form-label">SEO</label>
             <select class="form-select" id="p-seo"><option ${prop.seo==='Yes'?'selected':''}>Yes</option><option ${prop.seo==='No'?'selected':''}>No</option></select></div>
           <div class="form-group"><label class="form-label">H&M</label>
             <select class="form-select" id="p-hm"><option ${prop.hm==='Yes'?'selected':''}>Yes</option><option ${prop.hm==='No'?'selected':''}>No</option></select></div>
         </div>
         <div class="form-group"><label class="form-label">SEO Assignee</label>
           <select class="form-select" id="p-seo-assignee">
             <option value="">— None —</option>
             ${S.users.map(u=>`<option value="${u.name}" ${prop.seoAssignee===u.name?'selected':''}>${esc(u.name)}</option>`).join('')}
           </select></div>
         <div class="form-group"><label class="form-label">Web Assignee</label>
           <select class="form-select" id="p-web-assignee">
             <option value="">— None —</option>
             ${S.users.map(u=>`<option value="${u.name}" ${prop.webAssignee===u.name?'selected':''}>${esc(u.name)}</option>`).join('')}
           </select></div>`,
        [
          { label:'Cancel', cls:'btn btn-secondary', onClick: closeModal },
          { label:'Save', cls:'btn btn-primary', onClick: async () => {
            try {
              const seoName = $('p-seo-assignee').value;
              const webName = $('p-web-assignee').value;
              const seoUser = S.users.find(u=>u.name===seoName);
              const webUser = S.users.find(u=>u.name===webName);
              await PUT(`/api/master/properties/${prop.id}`, {
                name: $('p-name').value,
                url: $('p-url').value,
                type: $('p-type').value,
                status: $('p-status').value,
                seo: $('p-seo').value,
                hm: $('p-hm').value,
                seoAssignee: seoName,
                seoAssigneeId: seoUser?.id||null,
                webAssignee: webName,
                webAssigneeId: webUser?.id||null,
              });
              toast('Property updated','success'); closeModal(); navigate('properties');
            } catch (e) { toast(e.message,'error'); }
          }},
        ]
      );
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: DEV TRACKER (Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewDevProjects() {
  setPage('Dev Tracker', 'Web development project status');
  let projects = [];
  try { ({ projects } = await GET('/api/master/dev-projects')); } catch (e) { toast(e.message,'error'); }

  if (!projects.length) { mainEl.innerHTML=`<div class="empty-state"><div class="empty-icon">💻</div><p>No dev projects. Sync from Sheets first.</p></div>`; return; }

  const tabs = projects.map(p=>p.project);
  const first = projects[0];

  mainEl.innerHTML = `
    <div class="fade-in">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">
        ${projects.map((p,i)=>`<button class="btn ${i===0?'btn-primary':'btn-secondary'} dev-tab-btn" data-idx="${i}">${esc(p.project)}</button>`).join('')}
      </div>
      <div id="dev-panel"></div>
    </div>`;

  function renderProject(proj, projIdx) {
    $('dev-panel').innerHTML = `
      <div class="card">
        <div class="card-header"><span class="card-title">💻 ${esc(proj.project)}</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>URL / Page</th><th>Status</th><th>Date</th><th>Feedback</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>
            ${proj.items.map((item,itemIdx)=>`
              <tr>
                <td class="url-cell"><a href="${esc(item.url)}" target="_blank">${esc(shortUrl(item.url))}</a></td>
                <td>${statusBadge(item.status)}</td>
                <td style="font-size:11px;color:var(--text-muted)">${esc(item.date||'—')}</td>
                <td>${item.feedbackUrl?`<a class="btn btn-ghost btn-sm" href="${esc(item.feedbackUrl)}" target="_blank">View</a>`:'—'}</td>
                <td style="font-size:11px;color:var(--text-muted);max-width:200px">${esc(item.notes||'—')}</td>
                <td><button class="btn btn-ghost btn-sm edit-dev-btn" data-proj-id="${proj.id}" data-proj-idx="${projIdx}" data-item-idx="${itemIdx}">✏️</button></td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;

    $('dev-panel').querySelectorAll('.edit-dev-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = proj.items[parseInt(btn.dataset.itemIdx)];
        openModal('Edit Dev Item',
          `<div class="form-group"><label class="form-label">Status</label>
             <select class="form-select" id="di-status">
               ${['todo','in_progress','completed','review','blocked'].map(s=>`<option ${item.status===s?'selected':''}>${s}</option>`).join('')}
             </select></div>
           <div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" id="di-notes">${esc(item.notes||'')}</textarea></div>
           <div class="form-group"><label class="form-label">Feedback URL</label><input class="form-input" id="di-fb" value="${esc(item.feedbackUrl||'')}"></div>`,
          [
            { label:'Cancel', cls:'btn btn-secondary', onClick: closeModal },
            { label:'Save', cls:'btn btn-primary', onClick: async () => {
              try {
                await PUT(`/api/master/dev-projects/${btn.dataset.projId}/items/${btn.dataset.itemIdx}`, {
                  status: $('di-status').value, notes: $('di-notes').value, feedbackUrl: $('di-fb').value,
                });
                toast('Saved','success'); closeModal();
                const updated = await GET('/api/master/dev-projects');
                renderProject(updated.projects.find(p=>p.id===btn.dataset.projId)||proj, projIdx);
              } catch (e) { toast(e.message,'error'); }
            }},
          ]
        );
      });
    });
  }

  renderProject(first, 0);
  mainEl.querySelectorAll('.dev-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      mainEl.querySelectorAll('.dev-tab-btn').forEach(b=>b.className='btn btn-secondary dev-tab-btn');
      btn.className='btn btn-primary dev-tab-btn';
      renderProject(projects[parseInt(btn.dataset.idx)], parseInt(btn.dataset.idx));
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: USER MANAGEMENT (Admin / Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewUserMgmt() {
  setPage('Team Members', 'Manage active team members and system access');
  let users = [], sites = [];
  try {
    const [uData, sData] = await Promise.all([
      GET('/api/master/users'),
      GET('/api/master/sites'),
    ]);
    users = uData.users || [];
    sites = sData.sites || [];
    S.users = users;
  } catch (e) { toast(e.message, 'error'); }

  let currentFilter = 'all';

  function render() {
    const activeCount = users.filter(u => u.active !== false).length;
    const deactCount = users.filter(u => u.active === false).length;

    const filteredUsers = users.filter(u => {
      if (currentFilter === 'active') return u.active !== false;
      if (currentFilter === 'inactive') return u.active === false;
      return true;
    });

    mainEl.innerHTML = `
      <div class="fade-in">
        <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 20px;">
          <div class="stat-card accent">
            <div class="stat-value">${users.length}</div>
            <div class="stat-label">Total Team Members</div>
          </div>
          <div class="stat-card success">
            <div class="stat-value">${activeCount}</div>
            <div class="stat-label">🟢 Active in Team Progress</div>
          </div>
          <div class="stat-card danger">
            <div class="stat-value">${deactCount}</div>
            <div class="stat-label">🔴 Deactivated (Hidden)</div>
          </div>
        </div>

        <div class="card">
          <div class="card-header" style="flex-wrap:wrap;gap:12px">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span class="card-title">⚙️ Team Members (${users.length})</span>
              <div style="display:flex;gap:6px">
                <button class="btn btn-sm ${currentFilter==='all'?'btn-primary':'btn-secondary'} filter-chip-btn" data-filter="all">All (${users.length})</button>
                <button class="btn btn-sm ${currentFilter==='active'?'btn-primary':'btn-secondary'} filter-chip-btn" data-filter="active">Active (${activeCount})</button>
                <button class="btn btn-sm ${currentFilter==='inactive'?'btn-primary':'btn-secondary'} filter-chip-btn" data-filter="inactive">Deactivated (${deactCount})</button>
              </div>
            </div>
            <button class="btn btn-primary btn-sm" id="new-user-btn">+ Add User</button>
          </div>
          <div class="table-wrap"><table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Email</th>
                <th>Sites Assigned</th>
                <th>Created</th>
                <th style="text-align:right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${filteredUsers.length ? filteredUsers.map(u => {
                const isActive = u.active !== false;
                const userSites = sites.filter(s => s.assignedUsers?.includes(u.id));
                return `
                  <tr style="${!isActive ? 'opacity:0.65;background:rgba(244,63,94,0.03)' : ''}">
                    <td style="font-weight:600;display:flex;align-items:center;gap:8px">
                      <div class="user-avatar" style="width:26px;height:26px;font-size:11px;${!isActive?'filter:grayscale(1)':''}">${(u.name||'U')[0].toUpperCase()}</div>
                      <div>
                        <div>${esc(u.name)}</div>
                        ${!isActive ? '<div style="font-size:10px;color:var(--danger);font-weight:500">Deactivated — excluded from Team Progress</div>' : ''}
                      </div>
                    </td>
                    <td><span class="badge badge-${u.role==='superadmin'?'danger':u.role==='admin'?'warning':'info'}">${esc(u.role)}</span></td>
                    <td>
                      <span class="badge badge-${isActive ? 'success' : 'danger'}" style="font-size:11px">
                        ${isActive ? '🟢 Active' : '🔴 Deactivated'}
                      </span>
                    </td>
                    <td style="font-size:12px;color:var(--text-muted)">${esc(u.email||'—')}</td>
                    <td style="font-size:12px;font-weight:600">${userSites.length} ${userSites.length === 1 ? 'site' : 'sites'}</td>
                    <td style="font-size:11px;color:var(--text-dim)">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
                    <td style="text-align:right">
                      <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
                        <button class="btn btn-ghost btn-sm edit-user-btn" data-id="${u.id}" title="Edit User">✏️ Edit</button>
                        <button class="btn btn-sm toggle-status-btn ${isActive ? 'btn-secondary' : 'btn-success'}" data-id="${u.id}" data-active="${!isActive}" title="${isActive ? 'Deactivate user (hide from Team Progress)' : 'Activate user (show in Team Progress)'}">
                          ${isActive ? '🚫 Deactivate' : '✅ Activate'}
                        </button>
                        ${u.role!=='superadmin'?`<button class="btn btn-danger btn-sm del-user-btn" data-id="${u.id}" title="Delete User">🗑</button>`:''}
                      </div>
                    </td>
                  </tr>`;
              }).join('') : `<tr><td colspan="7" class="empty-state" style="text-align:center;padding:32px">No users found in this view</td></tr>`}
            </tbody>
          </table></div>
        </div>
      </div>`;

    // Filter chip listeners
    mainEl.querySelectorAll('.filter-chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentFilter = btn.dataset.filter;
        render();
      });
    });

    // Add User listener
    $('new-user-btn').addEventListener('click', () => {
      openModal('Add Team Member',
        `<div class="form-group"><label class="form-label">Full Name *</label><input class="form-input" id="nu-name" placeholder="e.g. John Doe"></div>
         <div class="form-group"><label class="form-label">Role</label>
           <select class="form-select" id="nu-role">
             <option value="user">User</option>
             <option value="admin">Admin</option>
             <option value="superadmin">Superadmin</option>
           </select></div>
         <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="nu-email" type="email" placeholder="optional"></div>
         <div class="form-group"><label class="form-label">Status</label>
           <select class="form-select" id="nu-active">
             <option value="true">🟢 Active (Shown in Team Progress)</option>
             <option value="false">🔴 Deactivated (Hidden)</option>
           </select></div>`,
        [
          { label:'Cancel', cls:'btn btn-secondary', onClick: closeModal },
          { label:'Create', cls:'btn btn-primary', onClick: async () => {
            const name = $('nu-name').value.trim();
            if (!name) { toast('Name required','error'); return; }
            try {
              const { user } = await POST('/api/master/users', {
                name,
                role: $('nu-role').value,
                email: $('nu-email').value,
                active: $('nu-active').value === 'true',
              });
              users.push(user);
              S.users = users;
              toast(`User "${name}" created`,'success'); closeModal(); render();
            } catch (e) { toast(e.message,'error'); }
          }},
        ]
      );
    });

    // Toggle status listener
    mainEl.querySelectorAll('.toggle-status-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const targetActive = btn.dataset.active === 'true';
        const user = users.find(u => u.id === id);
        btn.disabled = true;
        try {
          const { user: updated } = await PUT(`/api/master/users/${id}`, { active: targetActive });
          const idx = users.findIndex(u => u.id === id);
          if (idx !== -1) users[idx] = updated;
          S.users = users;
          toast(`User "${user?.name || 'Member'}" ${targetActive ? 'activated' : 'deactivated'}`, targetActive ? 'success' : 'warning');
          render();
        } catch (e) {
          toast(e.message, 'error');
          btn.disabled = false;
        }
      });
    });

    // Edit user listener
    mainEl.querySelectorAll('.edit-user-btn').forEach(btn => {
      const user = users.find(u=>u.id===btn.dataset.id);
      if (!user) return;
      btn.addEventListener('click', () => {
        const isActive = user.active !== false;
        openModal(`Edit: ${user.name}`,
          `<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="eu-name" value="${esc(user.name)}"></div>
           <div class="form-group"><label class="form-label">Role</label>
             <select class="form-select" id="eu-role">
               <option value="user" ${user.role==='user'?'selected':''}>User</option>
               <option value="admin" ${user.role==='admin'?'selected':''}>Admin</option>
               <option value="superadmin" ${user.role==='superadmin'?'selected':''}>Superadmin</option>
             </select></div>
           <div class="form-group"><label class="form-label">Status</label>
             <select class="form-select" id="eu-active">
               <option value="true" ${isActive ? 'selected' : ''}>🟢 Active (Shown in Team Progress)</option>
               <option value="false" ${!isActive ? 'selected' : ''}>🔴 Deactivated (Hidden from Team Progress)</option>
             </select></div>
           <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="eu-email" type="email" value="${esc(user.email||'')}"></div>`,
          [
            { label:'Cancel', cls:'btn btn-secondary', onClick: closeModal },
            { label:'Save', cls:'btn btn-primary', onClick: async () => {
              try {
                const { user: updated } = await PUT(`/api/master/users/${user.id}`, {
                  name: $('eu-name').value,
                  role: $('eu-role').value,
                  active: $('eu-active').value === 'true',
                  email: $('eu-email').value,
                });
                const idx = users.findIndex(u => u.id === user.id);
                if (idx !== -1) users[idx] = updated;
                S.users = users;
                toast('User updated','success'); closeModal(); render();
              } catch (e) { toast(e.message,'error'); }
            }},
          ]
        );
      });
    });

    // Delete user listener
    mainEl.querySelectorAll('.del-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const user = users.find(u=>u.id===btn.dataset.id);
        if (!confirm(`Delete user "${user?.name}"?`)) return;
        try {
          await DELETE(`/api/master/users/${btn.dataset.id}`);
          users = users.filter(u => u.id !== btn.dataset.id);
          S.users = users;
          toast('User deleted','success'); render();
        } catch (e) { toast(e.message,'error'); }
      });
    });
  }

  render();
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: SEND EMAILS
// ═══════════════════════════════════════════════════════════════════════════════
function viewSendEmails() {
  setPage('Send Emails', 'Maintenance mailer');
  mainEl.innerHTML = `
    <div class="fade-in" style="max-width:500px;margin:60px auto;text-align:center">
      <div style="font-size:64px;margin-bottom:20px">✉️</div>
      <h2 style="font-size:22px;font-weight:700;margin-bottom:12px">Maintenance Email Sender</h2>
      <p style="color:var(--text-muted);margin-bottom:32px">The email dashboard lets you preview, customise, and send maintenance reports to all clients.</p>
      <a href="/" class="btn btn-primary" style="font-size:16px;padding:14px 32px">Open Email Dashboard →</a>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: SYNC FROM SHEETS (Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewSync() {
  setPage('Sync from Sheets', 'Import + merge all 6 Google Sheets');
  let status = {};
  try { status = await GET('/api/master/db-status'); } catch {}

  mainEl.innerHTML = `
    <div class="fade-in" style="max-width:660px;margin:0 auto">
      <div class="card">
        <div class="card-header"><span class="card-title">📊 Database Status</span></div>
        <div class="card-body">
          <div class="stat-grid" style="margin-bottom:0">
            <div class="stat-card ${status.initialised?'success':'warning'}">
              <div class="stat-value">${status.totalSites||0}</div><div class="stat-label">Sites</div></div>
            <div class="stat-card info">
              <div class="stat-value">${status.totalDomains||0}</div><div class="stat-label">Domains</div></div>
            <div class="stat-card accent">
              <div class="stat-value">${status.totalTasks||0}</div><div class="stat-label">Tasks</div></div>
            <div class="stat-card purple">
              <div class="stat-value">${status.totalUsers||0}</div><div class="stat-label">Users</div></div>
          </div>
          ${status.lastSync?`<p style="margin-top:14px;font-size:12px;color:var(--text-muted)">Last synced: ${new Date(status.lastSync).toLocaleString()} (${status.syncDuration}s)</p>`:''}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><span class="card-title">🔄 Full Sync</span></div>
        <div class="card-body">
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;line-height:1.7">
            Imports from all 6 Google Sheets, <strong>merges relationships</strong> (sites ↔ users ↔ tasks ↔ domains),
            and saves everything locally. Takes 2–4 minutes due to API rate limits.
          </p>
          <div id="sync-progress-wrap" class="hidden" style="margin-bottom:20px">
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:6px">
              <span id="sync-step-text">Starting…</span>
              <span id="sync-pct-text">0%</span>
            </div>
            <div class="sync-progress-bar"><div class="sync-progress-fill" id="sync-pct-bar" style="width:0%"></div></div>
            <div class="sync-log" id="sync-log"></div>
          </div>
          <div id="sync-result" class="hidden"></div>
          <button class="btn btn-primary" id="sync-btn" style="padding:12px 28px;font-size:15px">🔄 Start Full Sync</button>
        </div>
      </div>
    </div>`;

  $('sync-btn').addEventListener('click', async () => {
    const btn = $('sync-btn');
    btn.disabled = true; btn.textContent = '⏳ Syncing…';
    $('sync-progress-wrap').classList.remove('hidden');
    $('sync-result').classList.add('hidden');
    const bar = $('sync-pct-bar'), step = $('sync-step-text'), pct = $('sync-pct-text'), log = $('sync-log');
    try {
      const resp = await fetch('/api/master/sync', { method:'POST', headers:{ Accept:'text/event-stream', 'Content-Type':'application/json' }, body:'{}' });
      const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream:true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const msg = JSON.parse(line.slice(6));
            if (msg.step) {
              step.textContent = msg.step; pct.textContent = `${msg.pct}%`; bar.style.width = `${msg.pct}%`;
              const e = document.createElement('div'); e.textContent = `${msg.pct}% — ${msg.step}`;
              log.appendChild(e); log.scrollTop = log.scrollHeight;
            }
            if (msg.done) {
              bar.style.width = '100%'; pct.textContent = '100%';
              $('sync-result').classList.remove('hidden');
              const c = msg.counts||{};
              $('sync-result').innerHTML = `
                <div style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:16px;color:var(--success);font-size:13px">
                  ✅ Sync complete in ${msg.elapsed}s<br>
                  <span style="color:var(--text-muted);font-size:12px">
                    ${c.sites||0} sites · ${c.dailyReviewRows||0} daily rows · ${c.tasks||0} tasks · ${c.properties||0} properties · ${c.devProjects||0} dev projects
                  </span>
                </div>`;
              btn.textContent = '🔄 Sync Again'; btn.disabled = false;
              $('sync-status').classList.remove('hidden'); $('sync-status-text').textContent = 'Synced just now';
            }
            if (msg.error) throw new Error(msg.error);
          } catch {}
        }
      }
    } catch (e) {
      $('sync-result').classList.remove('hidden');
      $('sync-result').innerHTML = `<div style="background:rgba(244,63,94,.1);border:1px solid rgba(244,63,94,.3);border-radius:8px;padding:16px;color:var(--danger)">${esc(e.message)}</div>`;
      btn.textContent = '🔄 Retry Sync'; btn.disabled = false;
      toast(e.message, 'error');
    }
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
initLanding();
