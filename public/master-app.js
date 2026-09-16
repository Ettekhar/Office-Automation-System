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
try { S.tableMode = localStorage.getItem('officeos_table_mode') || 'smart'; } catch { }

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const landing = $('landing-screen');
const appShell = $('app-shell');
const mainEl = $('main-content');
const pageTitleEl = $('page-title');
const pageSubtitleEl = $('page-subtitle');
const sidebarNavEl = $('sidebar-nav');

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
const GET = url => api(url);
const POST = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
const PUT = (url, body) => api(url, { method: 'PUT', body: JSON.stringify(body) });
const DELETE = url => api(url, { method: 'DELETE' });

// ─── HTML escape ──────────────────────────────────────────────────────────────
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

// ─── Bespoke Vector SVG Icon System (No cheap OS emojis) ─────────────────────
function getSvg(name, size = 14, extraClass = '') {
  const cls = extraClass ? `class="${extraClass}"` : '';
  const s = size;
  switch (name) {
    case 'wifi':
    case 'network':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`;
    case 'edit':
    case 'pencil':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    case 'trash':
    case 'delete':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
    case 'zap':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    case 'columns':
    case 'table':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/></svg>`;
    case 'check':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    case 'x':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    case 'eye':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    case 'plus':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    case 'refresh':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
    case 'external':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
    case 'download':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    case 'pin':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24z"/></svg>`;
    case 'pinOff':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 9v1.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24V17h12"/><path d="M15 9.34V6a3 3 0 0 0-5.94-.6"/></svg>`;
    case 'bell':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
    case 'settings':
    case 'cog':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
    case 'shield':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
    case 'database':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`;
    case 'layers':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;
    case 'bar-chart':
    case 'chart':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>`;
    case 'link':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
    case 'copy':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    case 'sort':
      return `<svg ${cls} width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5h10M11 9h7M11 13h4"/><path d="m3 17 3 3 3-3"/><path d="M6 20V4"/></svg>`;
    default:
      return '';
  }
}

// ─── Badges ───────────────────────────────────────────────────────────────────
function uptimeDot(status) {
  const st = (status || 'unknown').toLowerCase();
  const label = st === 'online' ? 'Online' : (st === 'offline' ? 'Offline' : 'Unknown');
  return `<span class="linear-uptime-pill ${st}">
    <span class="uptime-net-icon ${st}">${getSvg('network', 12)}</span>
    <span>${label}</span>
  </span>`;
}
function statusBadge(s) {
  const map = {
    completed: 'success', in_progress: 'info', todo: 'warning', pending: 'dim',
    sent: 'success', 'no': 'danger',
  };
  const cls = map[s?.toLowerCase()] || 'dim';
  return `<span class="badge badge-${cls}">${esc(s || '—')}</span>`;
}
function domainBadge(days) {
  if (days === null || days === undefined) return '<span class="badge badge-dim">Unknown</span>';
  if (days <= 0) return `<span class="badge badge-danger">Expired</span>`;
  if (days <= 30) return `<span class="badge badge-danger">${days}d left</span>`;
  if (days <= 90) return `<span class="badge badge-warning">${days}d left</span>`;
  return `<span class="badge badge-success">${days}d left</span>`;
}
function priorityBadge(p) {
  const map = { high: 'danger', medium: 'warning', low: 'dim' };
  return `<span class="badge badge-${map[p?.toLowerCase()] || 'dim'}">${esc(p || '—')}</span>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function userOptions(selectedId = '') {
  return S.users.map(u => `<option value="${u.id}" ${u.id === selectedId ? 'selected' : ''}>${esc(u.name)} (${u.role})</option>`).join('');
}
function shortUrl(url, max = 38) {
  const s = (url || '').replace(/^https?:\/\//, '').replace(/^www\./, '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ─── Vector Nav Icons ────────────────────────────────────────────────────────
function getNavSvg(key) {
  const map = {
    'overview': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>`,
    'all-users': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    'sites': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`,
    'my-sites': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`,
    'tasks': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    'my-tasks': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    'domain-expiry': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>`,
    'uptime': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
    'properties': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>`,
    'dev-projects': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
    'user-mgmt': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    'send-emails': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
    'sync': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6"/><path d="M22 11.5A10 10 0 0 0 3.2 7.2M2 12.5a10 10 0 0 0 18.8 4.2"/></svg>`,
    'sheet-manager': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
    'ai-settings': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><circle cx="12" cy="12" r="4"/><path d="M5.6 5.6l2.1 2.1"/><path d="M16.3 16.3l2.1 2.1"/><path d="M18.4 5.6l-2.1 2.1"/><path d="M7.7 16.3l-2.1 2.1"/></svg>`,
    'custom-sheet': `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/></svg>`,
  };
  return map[key] || `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`;
}

// ─── Categorized Sidebar Navigation ───────────────────────────────────────────
const NAV_SECTIONS = {
  user: [
    {
      title: 'My Workspace',
      items: [
        { id: 'my-sites', icon: 'my-sites', label: 'My Sites' },
        { id: 'my-tasks', icon: 'my-tasks', label: 'My Tasks' },
        { id: 'dev-projects', icon: 'dev-projects', label: 'Dev Tracker' },
      ],
    },
  ],
  admin: [
    {
      title: 'Workspace',
      items: [
        { id: 'overview', icon: 'overview', label: 'Overview' },
        { id: 'dev-projects', icon: 'dev-projects', label: 'Dev Tracker & Sitemaps', badge: 'Live' },
        { id: 'all-users', icon: 'all-users', label: 'Team Progress' },
      ],
    },
    {
      title: 'Operations',
      items: [
        { id: 'sites', icon: 'sites', label: 'All Sites' },
        { id: 'tasks', icon: 'tasks', label: 'Daily Tasks' },
        { id: 'domain-expiry', icon: 'domain-expiry', label: 'Domain Expiry' },
        { id: 'uptime', icon: 'uptime', label: 'Uptime Monitor' },
      ],
    },
    {
      title: 'Team & Comms',
      items: [
        { id: 'user-mgmt', icon: 'user-mgmt', label: 'Team Members' },
        { id: 'send-emails', icon: 'send-emails', label: 'Email Reports' },
      ],
    },
  ],
  superadmin: [
    {
      title: 'Workspace',
      items: [
        { id: 'overview', icon: 'overview', label: 'Overview' },
        { id: 'dev-projects', icon: 'dev-projects', label: 'Dev Tracker & Sitemaps', badge: 'Live' },
        { id: 'all-users', icon: 'all-users', label: 'Team Progress' },
      ],
    },
    {
      title: 'Operations',
      items: [
        { id: 'sites', icon: 'sites', label: 'All Sites' },
        { id: 'tasks', icon: 'tasks', label: 'Daily Tasks' },
        { id: 'domain-expiry', icon: 'domain-expiry', label: 'Domain Expiry' },
        { id: 'uptime', icon: 'uptime', label: 'Uptime Monitor' },
        { id: 'properties', icon: 'properties', label: 'Property Registry' },
      ],
    },
    {
      title: 'Administration',
      items: [
        { id: 'user-mgmt', icon: 'user-mgmt', label: 'User Management' },
        { id: 'send-emails', icon: 'send-emails', label: 'Email Reports' },
        { id: 'sync', icon: 'sync', label: 'Sheets Sync' },
        { id: 'sheet-manager', icon: 'sheet-manager', label: 'Sheet Manager', badge: 'Super' },
        { id: 'ai-settings', icon: 'ai-settings', label: 'AI Settings', badge: 'Super' },
      ],
    },
  ],
};

function buildNav(role) {
  const sections = NAV_SECTIONS[role] || [];
  sidebarNavEl.innerHTML = sections.map(sec => `
    <div class="nav-section">
      <div class="nav-section-title">${esc(sec.title)}</div>
      <div class="nav-section-items">
        ${sec.items.map(n => `
          <div class="nav-item" data-view="${n.id}" id="nav-${n.id}" title="${esc(n.label)}">
            <span class="nav-icon">${getNavSvg(n.icon)}</span>
            <span class="nav-label">${esc(n.label)}</span>
            ${n.badge ? `<span class="nav-pill-badge">${esc(n.badge)}</span>` : ''}
          </div>
        `).join('')}
      </div>
    </div>`).join('');

  sidebarNavEl.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.view));
  });

  // Append dynamic custom sheet tabs after static nav
  buildCustomSheetNav();
}

function setActiveNav(viewId) {
  sidebarNavEl.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewId);
  });
}

// ─── Navigation ───────────────────────────────────────────────────────────────
const viewFns = {
  'my-sites': viewMySites,
  'my-tasks': viewMyTasks,
  'overview': viewOverview,
  'all-users': viewAllUsers,
  'sites': viewSites,
  'tasks': viewTasks,
  'domain-expiry': viewDomainExpiry,
  'uptime': viewUptime,
  'properties': viewProperties,
  'dev-projects': viewDevProjects,
  'user-mgmt': viewUserMgmt,
  'send-emails': viewSendEmails,
  'sync': viewSync,
  'sheet-manager': viewSheetManager,
  'ai-settings': viewAiSettings,
};

function navigate(viewId) {
  S.view = viewId;
  setActiveNav(viewId);
  mainEl.innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><p>Loading…</p></div>`;
  // Dynamic custom-sheet route
  if (viewId.startsWith('custom-sheet-')) {
    const sheetId = viewId.replace('custom-sheet-', '');
    viewCustomSheet(sheetId);
    return;
  }
  const fn = viewFns[viewId];
  if (fn) fn(); else mainEl.innerHTML = '<div class="empty-state"><p>View not found</p></div>';
}

$('refresh-btn').addEventListener('click', () => { if (S.view) navigate(S.view); });
$('notice-board-top-btn')?.addEventListener('click', () => openNoticeBoardModal());
$('logout-btn').addEventListener('click', () => {
  sessionStorage.setItem('officeos_logged_out', '1');
  appShell.classList.add('hidden');
  landing.classList.remove('hidden');
});
const savedSidebar = localStorage.getItem('officeos_sidebar_collapsed');
if (savedSidebar === 'true' || (savedSidebar === null && window.innerWidth < 1350)) {
  appShell.classList.add('sidebar-collapsed');
}
$('sidebar-toggle').addEventListener('click', () => {
  const isCollapsed = appShell.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('officeos_sidebar_collapsed', isCollapsed); } catch { }
});

// ─── Theme Management (Linear Dark & Light) ──────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('officeos_theme', theme); } catch { }
  const sun = document.querySelector('.theme-icon-sun');
  const moon = document.querySelector('.theme-icon-moon');
  if (sun && moon) {
    if (theme === 'light') {
      sun.classList.remove('hidden');
      moon.classList.add('hidden');
    } else {
      sun.classList.add('hidden');
      moon.classList.remove('hidden');
    }
  }
}
function initTheme() {
  const saved = localStorage.getItem('officeos_theme') || 'dark';
  applyTheme(saved);
  $('theme-toggle-btn')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    toast(`Switched to ${next === 'light' ? 'Light' : 'Dark'} mode`, 'info', 2000);
  });
}
initTheme();

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
        const matchedSites = (sites || []).filter(s => (s.url || '').toLowerCase().includes(q) || (s.company || '').toLowerCase().includes(q)).slice(0, 6);
        matchedSites.forEach(s => {
          items.push({
            type: 'Website',
            title: `${s.url} (${s.company || s.account || 'CW'})`,
            action: () => { window.open(s.url, '_blank'); close(); }
          });
        });
      } catch { }
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

  const defaultNames = ['Toufiq', 'Sabbir', 'Taion', 'Medul', 'Saiful', 'Tarikul', 'Roeich', 'Asif'];
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
  } catch { }

  const statusEl = $('landing-status');
  try {
    const st = await GET('/api/master/db-status');
    if (!st.initialised) {
      statusEl.innerHTML = `<div class="status-pill warn">⚠️ <span><strong>First-time setup:</strong> After entering, go to <em>Sync from Sheets</em> to import data.</span></div>`;
    } else {
      const ago = st.lastSync ? Math.round((Date.now() - new Date(st.lastSync)) / 60000) : null;
      statusEl.innerHTML = `<div class="status-pill ok">⚡ <span><strong>${st.totalSites} Sites</strong> · ${st.totalDomains || 0} Domains${ago !== null ? ` · Synced ${ago}m ago` : ''}</span></div>`;
    }
  } catch { }

  // Load real users
  try {
    const { users } = await GET('/api/master/users');
    if (users && users.length > 0) {
      S.users = users;
      const activeUsers = users.filter(u => u.active !== false);
      nameSelect.innerHTML = activeUsers.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    }
  } catch { }

  // Auto-restore session if previously entered and not explicitly switched/logged out
  try {
    const saved = JSON.parse(localStorage.getItem('officeos_session') || '{}');
    const isManualLogout = sessionStorage.getItem('officeos_logged_out');
    if (saved.role && !isManualLogout) {
      S.role = saved.role;
      S.userName = saved.userName || (saved.role === 'admin' ? 'Admin' : 'Superadmin');
      S.userId = saved.userId || null;
      enterApp();
      return;
    }
  } catch { }

  $('enter-btn').addEventListener('click', () => {
    sessionStorage.removeItem('officeos_logged_out');
    const role = $('role-select').value;
    S.role = role;
    if (role === 'user') {
      const nameOpt = nameSelect.options[nameSelect.selectedIndex];
      S.userName = nameOpt ? nameOpt.text : defaultNames[0];
      S.userId = nameOpt ? (nameOpt.value || null) : null;
    } else {
      const nameOpt = nameSelect.options[nameSelect.selectedIndex];
      S.userName = nameOpt ? nameOpt.text : (role === 'admin' ? 'Admin' : 'Superadmin');
      S.userId = nameOpt ? (nameOpt.value || null) : null;
    }
    // Save session
    try { localStorage.setItem('officeos_session', JSON.stringify({ role: S.role, userName: S.userName, userId: S.userId })); } catch { }
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
      updateExpiryApprovalsBadge();
      const defaultViews = { user: 'my-sites', admin: 'overview', superadmin: 'overview' };
      navigate(defaultViews[newRole] || 'overview');
      toast(`Switched to ${newRole} workspace`, 'info');
    });
  });

  // Quick sync sidebar button
  const qSync = $('quick-sync-btn');
  if (qSync) qSync.addEventListener('click', () => navigate('sync'));

  buildNav(S.role);

  // Wire top bar buttons
  $('expiry-approvals-top-btn')?.addEventListener('click', () => openExpiryApprovalsModal());
  updateExpiryApprovalsBadge();

  // Month selector dropdown
  $('month-selector-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_monthDropdownOpen) closeMonthDropdown();
    else openMonthDropdown();
  });
  updateActiveMonthUI();

  $('active-month-wrapper')?.addEventListener('click', () => {
    if (S.role === 'admin' || S.role === 'superadmin') openAddMonthModal();
  });
  applyColumnVisibilityStyles();

  // Refresh button also updates badge
  $('refresh-btn')?.addEventListener('click', () => {
    updateExpiryApprovalsBadge();
    updateActiveMonthUI();
  });

  // Show sync-status if synced
  GET('/api/master/db-status').then(st => {
    if (st.lastSync) {
      $('sync-status').classList.remove('hidden');
      const ago = Math.round((Date.now() - new Date(st.lastSync)) / 60000);
      $('sync-status-text').textContent = ago < 1 ? 'Synced just now' : `Synced ${ago}m ago`;
    }
  }).catch(() => { });

  // Default view
  const defaultViews = { user: 'my-sites', admin: 'overview', superadmin: 'overview' };
  navigate(defaultViews[S.role] || 'overview');
}

// ─── Active Month Selector Dropdown ──────────────────────────────────────────
let currentActiveMonth = 'August';
let _monthDropdownOpen = false;

async function updateActiveMonthUI() {
  try {
    const data = await GET('/api/master/months');
    if (data.activeMonth) {
      currentActiveMonth = data.activeMonth;
      const lbl = $('active-month-label');
      if (lbl) lbl.textContent = currentActiveMonth;
    }
    // Populate dropdown list
    const list = $('month-dropdown-list');
    if (list && Array.isArray(data.months) && data.months.length) {
      // Sort: try to keep chronological order (most recent = last in sheet = top of list)
      const months = [...data.months].reverse();
      list.innerHTML = months.map(m => `
        <button onclick="selectMonth('${esc(m)}')" style="width:100%;text-align:left;padding:7px 14px;font-size:12px;font-weight:${m === currentActiveMonth ? '700' : '400'};color:${m === currentActiveMonth ? '#a78bfa' : '#cbd5e1'};background:${m === currentActiveMonth ? 'rgba(167,139,250,0.1)' : 'none'};border:none;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background .15s" onmouseover="this.style.background='rgba(255,255,255,0.06)'" onmouseout="this.style.background='${m === currentActiveMonth ? 'rgba(167,139,250,0.1)' : 'none'}'">
          ${m === currentActiveMonth ? '✓ ' : ''}<span>${esc(m)}</span>
          ${m === currentActiveMonth ? '<span style="margin-left:auto;font-size:10px;opacity:.6">active</span>' : ''}
        </button>
      `).join('');
    } else if (list) {
      list.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:#64748b">No months found. Add one below.</div>';
    }
  } catch { }
}

async function selectMonth(monthName) {
  closeMonthDropdown();
  if (monthName === currentActiveMonth) return;
  try {
    await POST('/api/master/months/select', { monthName });
    currentActiveMonth = monthName;
    const lbl = $('active-month-label');
    if (lbl) lbl.textContent = monthName;
    toast(`📅 Active month switched to "${monthName}" — status syncs will now target this month`, 'success', 4000);
    // Re-populate the dropdown to update active highlight
    await updateActiveMonthUI();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function openMonthDropdown() {
  const dd = $('month-dropdown');
  const caret = $('month-caret');
  if (!dd) return;
  _monthDropdownOpen = true;
  dd.style.display = 'block';
  if (caret) caret.style.transform = 'rotate(180deg)';
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeMonthDropdownOutside, { once: true });
  }, 10);
}

function closeMonthDropdown() {
  const dd = $('month-dropdown');
  const caret = $('month-caret');
  if (!dd) return;
  _monthDropdownOpen = false;
  dd.style.display = 'none';
  if (caret) caret.style.transform = '';
}

function closeMonthDropdownOutside(e) {
  const wrap = $('month-selector-wrap');
  if (wrap && !wrap.contains(e.target)) {
    closeMonthDropdown();
  } else if (!_monthDropdownOpen) {
    // already closed
  } else {
    // Still inside — re-register
    document.addEventListener('click', closeMonthDropdownOutside, { once: true });
  }
}

function getNextSuggestedMonth(curr) {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const match = (curr || '').match(/([a-zA-Z]+)(?:\s*(\d{2,4}))?/);
  if (!match) return 'September';
  const name = match[1];
  const yr = match[2];
  const idx = monthNames.findIndex(m => m.toLowerCase().startsWith(name.toLowerCase().slice(0, 3)));
  if (idx === -1) return 'September';
  const nextIdx = (idx + 1) % 12;
  const nextName = monthNames[nextIdx];
  if (yr) {
    let nextYr = parseInt(yr, 10);
    if (nextIdx === 0) nextYr++;
    return `${nextName} ${nextYr}`;
  }
  return nextName;
}

function openAddMonthModal() {
  closeMonthDropdown();
  const suggested = getNextSuggestedMonth(currentActiveMonth);
  openModal(
    '➕ Create New Month Column in Google Sheets',
    `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:16px;line-height:1.6">
      This will append a new column at the <strong>rightmost edge</strong> of the <code>Website List</code> tab in both 
      <strong>CW Maintenance</strong> and <strong>RM Maintenance</strong> Google Sheets, automatically inheriting the dropdown validation &amp; styles from ${esc(currentActiveMonth)}, and set it as the active reporting month.
    </div>
    <div class="form-group" style="margin-bottom:16px">
      <label class="form-label" style="font-size:12.5px;font-weight:700">New Month Name *</label>
      <input class="form-input" id="new-month-input" value="${esc(suggested)}" placeholder="e.g. September or September 24" style="font-size:14px;font-weight:600;background:var(--bg-surface-2);color:#fff" />
      <div style="font-size:11.5px;color:var(--text-secondary);margin-top:6px">
        Current active month is <strong>${esc(currentActiveMonth)}</strong>. Suggested next month: <code>${esc(suggested)}</code>.
      </div>
    </div>
    <div id="add-month-progress" class="hidden" style="margin-bottom:16px;padding:12px;border-radius:8px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.3);font-size:12px;color:var(--accent-1)">
      ⏳ Appending column to CW &amp; RM Google Sheets via API... Please wait a few moments.
    </div>
    `,
    [
      { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
      {
        label: '🚀 Create Month Column',
        cls: 'btn btn-primary',
        id: 'btn-confirm-add-month',
        onClick: async () => {
          const val = ($('new-month-input')?.value || '').trim();
          if (!val) { toast('Please enter a month name', 'warning'); return; }
          const btn = $('btn-confirm-add-month');
          if (btn) { btn.disabled = true; btn.textContent = 'Creating in Sheets…'; }
          $('add-month-progress')?.classList.remove('hidden');

          try {
            const res = await POST('/api/master/add-month', { monthName: val });
            currentActiveMonth = val;
            const lbl = $('active-month-label');
            if (lbl) lbl.textContent = val;

            const cwCol = res.cw?.column || 'new';
            const rmCol = res.rm?.column || 'new';
            toast(`✅ "${val}" added to CW (col ${cwCol}) and RM (col ${rmCol}) sheets!`, 'success', 5000);
            closeModal();
            await updateActiveMonthUI();
            if (S.view) navigate(S.view);
          } catch (e) {
            toast(e.message, 'error', 4000);
            if (btn) { btn.disabled = false; btn.textContent = '🚀 Create Month Column'; }
            $('add-month-progress')?.classList.add('hidden');
          }
        }
      }
    ]
  );
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
          ${n.pinned ? `<span class="badge badge-accent" style="font-size:10.5px;display:inline-flex;align-items:center;gap:4px">${getSvg('pin', 10)} Pinned</span>` : ''}
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
            <button class="btn btn-ghost btn-sm toggle-pin-btn" data-id="${n.id}" data-pinned="${!n.pinned}" title="${n.pinned ? 'Unpin notice' : 'Pin to top banner'}" style="display:inline-flex;align-items:center;gap:5px">
              ${n.pinned ? getSvg('pinOff', 12) + ' Unpin' : getSvg('pin', 12) + ' Pin'}
            </button>
            <button class="btn btn-ghost btn-sm edit-notice-btn" data-id="${n.id}" title="Edit notice" style="display:inline-flex;align-items:center;gap:4px">${getSvg('edit', 12)}</button>
            <button class="btn btn-danger btn-sm del-notice-btn" data-id="${n.id}" title="Delete notice" style="display:inline-flex;align-items:center;gap:4px">${getSvg('trash', 12)}</button>
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
          {
            label: 'Publish Notice', cls: 'btn btn-primary', onClick: async () => {
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
            }
          }
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
            {
              label: 'Save Changes', cls: 'btn btn-primary', onClick: async () => {
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
              }
            }
          ]
        );
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLUMN VISIBILITY MANAGER (Add or Hide Columns)
// ═══════════════════════════════════════════════════════════════════════════════
const COLUMN_DEFS = [
  { id: 'company', label: 'Company (CW / RM)' },
  { id: 'maintenance', label: 'Maintenance Status' },
  { id: 'report', label: 'Report Sent' },
  { id: 'clickup', label: 'ClickUp Link' },
  { id: 'ga4', label: 'GA4 Report' },
  { id: 'newsletter', label: 'Newsletter Mail' },
  { id: 'form', label: 'Form Submission Mail' },
  { id: 'response', label: 'Client Response' },
  { id: 'booking', label: 'Booking Engine' },
  { id: 'expiry', label: 'Domain Expiry' },
  { id: 'cloudflare', label: 'Cloudflare Issues' },
];

function getHiddenColumns() {
  try {
    return JSON.parse(localStorage.getItem('officeos_hidden_columns') || '[]');
  } catch {
    return [];
  }
}

function setHiddenColumns(hiddenCols) {
  try {
    localStorage.setItem('officeos_hidden_columns', JSON.stringify(hiddenCols));
  } catch { }
  applyColumnVisibilityStyles();
}

function applyColumnVisibilityStyles() {
  let styleEl = document.getElementById('dynamic-column-visibility');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dynamic-column-visibility';
    document.head.appendChild(styleEl);
  }
  const hidden = getHiddenColumns();
  if (!hidden.length) {
    styleEl.textContent = '';
    return;
  }
  const rules = hidden.map(c => `th[data-col="${c}"], td[data-col="${c}"] { display: none !important; }`).join('\n');
  styleEl.textContent = rules;
}

function openColumnManagerModal() {
  const hidden = new Set(getHiddenColumns());

  openModal('Customize Table Columns', `
    <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:14px">
      Toggle columns to show or hide them dynamically. Preferences are saved automatically.
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:12px;gap:8px">
      <button class="btn btn-ghost btn-sm" id="btn-col-show-all">✓ Show All</button>
      <button class="btn btn-ghost btn-sm" id="btn-col-reset-defaults">↺ Reset Defaults</button>
    </div>
    <div class="col-visibility-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
      ${COLUMN_DEFS.map(c => `
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;padding:8px 12px;background:var(--bg-surface-2);border-radius:6px;border:1px solid var(--border)">
          <input type="checkbox" class="col-toggle-cb" data-col="${c.id}" ${!hidden.has(c.id) ? 'checked' : ''} style="accent-color:var(--accent);width:15px;height:15px" />
          <span style="font-weight:600">${esc(c.label)}</span>
        </label>
      `).join('')}
    </div>
    <div style="display:flex;justify-content:flex-end">
      <button class="btn btn-primary" onclick="closeModal()">Done</button>
    </div>
  `);

  document.querySelectorAll('.col-toggle-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const col = cb.dataset.col;
      const curHidden = new Set(getHiddenColumns());
      if (cb.checked) curHidden.delete(col);
      else curHidden.add(col);
      setHiddenColumns([...curHidden]);
    });
  });

  const showAllBtn = $('btn-col-show-all');
  if (showAllBtn) {
    showAllBtn.addEventListener('click', () => {
      setHiddenColumns([]);
      document.querySelectorAll('.col-toggle-cb').forEach(cb => cb.checked = true);
      toast('All columns visible', 'info');
    });
  }

  const resetBtn = $('btn-col-reset-defaults');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      setHiddenColumns([]);
      document.querySelectorAll('.col-toggle-cb').forEach(cb => cb.checked = true);
      toast('Columns reset to default', 'info');
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOMAIN EXPIRY APPROVALS (Admin / Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function openExpiryApprovalsModal(onResolved) {
  let requests = [];
  try {
    const data = await GET('/api/master/domain-expiry-requests?status=pending');
    requests = data.requests || [];
  } catch (e) {
    toast(e.message, 'error');
    return;
  }

  if (!requests.length) {
    openModal('Domain Expiry Approvals', `
      <div style="text-align:center;padding:24px 10px">
        <div style="font-size:32px;margin-bottom:10px">🎉</div>
        <h3 style="margin-bottom:6px">All Caught Up!</h3>
        <p style="color:var(--text-muted);font-size:13px">There are currently no pending domain expiration change requests.</p>
      </div>
    `);
    return;
  }

  openModal(`Domain Expiry Approvals (${requests.length})`, `
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:14px">
      Review and approve or reject expiration date changes submitted by team members.
    </div>
    <div style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:10px">
      ${requests.map(r => `
        <div style="background:var(--bg-surface-2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div style="font-weight:700;font-size:13.5px;color:#fff;margin-bottom:3px">
              <a href="${esc(r.siteUrl)}" target="_blank" style="color:var(--accent-2)">${esc(shortUrl(r.siteUrl, 32))} ↗</a>
            </div>
            <div style="font-size:11.5px;color:var(--text-muted);display:flex;gap:10px;align-items:center">
              <span>Proposed: <strong style="color:#fbbf24">${esc(r.requestedDate)}</strong></span>
              <span>By: <strong>${esc(r.requestedByName || 'Team Member')}</strong></span>
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-success btn-sm modal-approve-btn" data-id="${r.id}" style="padding:5px 10px;font-size:11.5px">✓ Approve</button>
            <button class="btn btn-danger btn-sm modal-reject-btn" data-id="${r.id}" style="padding:5px 10px;font-size:11.5px">✕ Reject</button>
          </div>
        </div>
      `).join('')}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px">
      <button class="btn btn-ghost btn-sm" id="btn-approve-all-expiry">✓ Approve All (${requests.length})</button>
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
    </div>
  `);

  document.querySelectorAll('.modal-approve-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await POST(`/api/master/domain-expiry-requests/${btn.dataset.id}/resolve`, {
          action: 'approved',
          resolvedBy: S.userName || 'Admin'
        });
        toast('Date approved & applied!', 'success');
        closeModal();
        updateExpiryApprovalsBadge();
        if (onResolved) onResolved();
        else if (S.role === 'admin' || S.role === 'superadmin') viewAllUsers();
        else viewMySites();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  });

  document.querySelectorAll('.modal-reject-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await POST(`/api/master/domain-expiry-requests/${btn.dataset.id}/resolve`, {
          action: 'rejected',
          resolvedBy: S.userName || 'Admin'
        });
        toast('Date rejected', 'info');
        closeModal();
        updateExpiryApprovalsBadge();
        if (onResolved) onResolved();
        else if (S.role === 'admin' || S.role === 'superadmin') viewAllUsers();
        else viewMySites();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  });

  const approveAllBtn = $('btn-approve-all-expiry');
  if (approveAllBtn) {
    approveAllBtn.addEventListener('click', async () => {
      approveAllBtn.disabled = true;
      approveAllBtn.textContent = 'Approving…';
      for (const r of requests) {
        try {
          await POST(`/api/master/domain-expiry-requests/${r.id}/resolve`, {
            action: 'approved',
            resolvedBy: S.userName || 'Admin'
          });
        } catch { }
      }
      toast('All pending dates approved & applied!', 'success');
      closeModal();
      updateExpiryApprovalsBadge();
      if (onResolved) onResolved();
      else if (S.role === 'admin' || S.role === 'superadmin') viewAllUsers();
      else viewMySites();
    });
  }
}

async function updateExpiryApprovalsBadge() {
  const badgeBtn = $('expiry-approvals-top-btn');
  const countSpan = $('expiry-approvals-count');
  if (!badgeBtn) return;

  const isAdmin = S.role === 'admin' || S.role === 'superadmin';
  if (!isAdmin) {
    badgeBtn.classList.add('hidden');
    return;
  }

  try {
    const data = await GET('/api/master/domain-expiry-requests?status=pending');
    const count = (data.requests || []).length;
    if (count > 0) {
      if (countSpan) countSpan.textContent = count;
      badgeBtn.classList.remove('hidden');
    } else {
      badgeBtn.classList.add('hidden');
    }
  } catch { }
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
          dot.className = `live-network-icon ${isUp ? 'online' : 'offline'}`;
          dot.title = isUp ? `Website Online & Active (${resp.result?.responseTime || 0}ms)` : 'Website Down / Offline';
          dot.innerHTML = getSvg('network', 11);
        }
        toast(`${isUp ? 'Online' : 'Offline'} — ${shortUrl(btn.dataset.siteUrl, 24)}${resp.result?.responseTime ? ' (' + resp.result.responseTime + 'ms)' : ''}`, isUp ? 'success' : 'error');
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
            dot.className = `live-network-icon ${isUp ? 'online' : 'offline'}`;
            dot.title = isUp ? `Website Online & Active (${resp.result?.responseTime || 0}ms)` : 'Website Down / Offline';
            dot.innerHTML = getSvg('network', 11);
          }
        } catch { }
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
          resolvedBy: S.userName || 'Admin'
        });
        toast('Domain expiration date approved & applied!', 'success');
        updateExpiryApprovalsBadge();
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
          resolvedBy: S.userName || 'Admin'
        });
        toast('Domain expiration date change rejected', 'info');
        updateExpiryApprovalsBadge();
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

  // 9. Columns toggle listener
  containerEl.querySelectorAll('#btn-toggle-columns, .btn-toggle-columns').forEach(btn => {
    btn.addEventListener('click', openColumnManagerModal);
  });
}

function openExpiryEditModal({ siteId, siteUrl, currentDate, rowId }, onSaved) {
  const isAdminOrSuper = S.role === 'admin' || S.role === 'superadmin';
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
            requestedBy: S.userId || '',
            requestedByName: S.userName || 'User',
          });
          toast('Submitted to Admin/Superadmin for approval!', 'success');
        }
        closeModal();
        updateExpiryApprovalsBadge();
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
  const pending = rows.filter(r => !['completed', 'in_progress'].includes(r.maintenanceStatus)).length;
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
          <span class="card-title" style="display:inline-flex;align-items:center;gap:7px">${getSvg('table', 14)} Daily Maintenance Checklist</span>
          <div class="card-actions">
            <span class="completion-pct-text" style="font-size:12px;font-weight:600;color:var(--text-secondary)">${pct}% Completed</span>
            <div class="progress-wrap" style="width:120px"><div class="progress-fill completion-progress-fill" style="width:${pct}%"></div></div>
            <div class="view-mode-toggle" id="table-mode-toggle">
              <button class="btn btn-sm mode-btn ${isSmart ? 'active' : ''}" data-mode="smart" title="Smart Fit — compact 7-column view" style="display:inline-flex;align-items:center;gap:5px">${getSvg('zap', 11)} Smart Fit</button>
              <button class="btn btn-sm mode-btn ${!isSmart ? 'active' : ''}" data-mode="full" title="Full Spread — all 14 columns visible" style="display:inline-flex;align-items:center;gap:5px">${getSvg('columns', 11)} Full Spread</button>
            </div>
            <button id="export-csv-btn" class="btn btn-secondary btn-sm" title="Export this checklist to CSV" style="display:inline-flex;align-items:center;gap:5px">
              ${getSvg('download', 12)} Export CSV
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
              ${rows.map((r, i) => siteRow(r, i, isSmart ? 'smart' : 'full')).join('')}
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
      else if (activeFilter === 'pending') matchFilter = !['completed', 'in_progress'].includes(status);
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
      try { localStorage.setItem('officeos_table_mode', mode); } catch { }
      viewMySites();
    });
  });

  // Export CSV
  $('export-csv-btn').addEventListener('click', () => {
    exportChecklistCsv(rows, `Daily_Maintenance_${S.userName}_${new Date().toISOString().slice(0, 10)}.csv`);
  });

  // Status dropdown auto-save
  tbody.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async e => {
      const { rowId, field } = e.target.dataset;
      const value = e.target.value;
      const normMap = { 'Completed': 'completed', 'In Progress': 'in_progress', 'To Do': 'todo', 'Pending': 'pending', 'Yes': 'sent', 'No': 'no' };
      const isMaint = field === 'maintenanceStatus' || field === 'maintenanceRaw';
      try {
        await PUT(`/api/master/daily-review/${rowId}`, {
          [field]: normMap[value] || value,
          [field + 'Raw']: value,
        });
        if (isMaint) {
          const sheetVal = (value === 'Completed' || value === 'completed') ? 'Updated & Backup' : value;
          toast(`⚡ Status saved & synced to Google Sheet (${sheetVal})`, 'success', 3000);
        } else {
          toast('Status updated', 'success');
        }
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
        btn.innerHTML = isHidden ? getSvg('x', 11) : getSvg('eye', 11);
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
  const maintOpts = ['Completed', 'In Progress', 'To Do', 'Pending'].map(o =>
    `<option ${r.maintenanceRaw === o ? 'selected' : ''}>${o}</option>`).join('');
  const sentOpts = ['Yes', 'No', 'To Do'].map(o =>
    `<option ${r.reportSentRaw === o ? 'selected' : ''}>${o}</option>`).join('');

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
      <div class="expiry-cell-grp" title="Domain Expiration: ${esc(cleanExp || 'Not set')}">
        ${daysBadge}
        <button class="btn-edit-expiry" data-row-id="${r.id}" data-site-id="${r.siteId || ''}" data-url="${esc(r.siteUrl)}" data-current="${esc(cleanExp)}" title="Edit expiration date (Current: ${esc(cleanExp || 'None')})">✏️</button>
      </div>
    `;
  } else {
    expiryHtml = `
      <div class="expiry-cell-grp" title="No expiration date set">
        <span class="dim-dash">—</span>
        <button class="btn-edit-expiry" data-row-id="${r.id}" data-site-id="${r.siteId || ''}" data-url="${esc(r.siteUrl)}" data-current="" title="Set expiration date">✏️</button>
      </div>
    `;
  }

  // Pending Expiry Approval Badge + Actions (Visible to Admin/Superadmin)
  if (r.pendingExpiryRequest) {
    const pr = r.pendingExpiryRequest;
    const isAdmin = S.role === 'admin' || S.role === 'superadmin';
    expiryHtml += `
      <div style="margin-top:4px;display:flex;align-items:center;gap:4px;flex-wrap:wrap">
        <span class="expiry-pending-pill" title="Proposed by ${esc(pr.requestedByName || 'User')}: ${esc(pr.requestedDate)}">
          ⏳ Req: ${esc(pr.requestedDate)}
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
  const netSt = isOffline ? 'offline' : (isOnline ? 'online' : 'pending');
  const liveBall = `<span class="live-network-icon ${netSt}" id="live-dot-${r.id}" title="${isOffline ? 'Website Offline / Down' : (isOnline ? 'Website Active & Online' : 'Website Status: Unknown')}">${getSvg('network', 11)}</span>`;
  const co = (r.company || 'CW').trim();

  if (mode === 'smart') {
    return `
      <tr class="smart-row" data-url="${esc((r.siteUrl || '').toLowerCase())}" data-status="${r.maintenanceStatus}" data-id="${r.id}">
        <td class="col-select" style="text-align:center">
          <input type="checkbox" class="row-checkbox" data-row-id="${r.id}" data-url="${esc(r.siteUrl)}" data-company="${esc(co)}" />
        </td>
        <td class="col-url url-cell" data-col="url">
          <div class="site-identity-cell">
            ${liveBall}
            <span class="badge badge-${co.toLowerCase().includes('cw') ? 'cw' : 'rm'} badge-xs">${esc(co)}</span>
            <a href="${esc(r.siteUrl)}" target="_blank" class="site-domain-link" title="${esc(r.siteUrl)}">
              ${esc(shortUrl(r.siteUrl, 26))} <span class="ext-icon">↗</span>
            </a>
            <button class="btn-uptime-check" data-row-id="${r.id}" data-site-url="${esc(r.siteUrl)}" data-site-id="${r.siteId || ''}" title="Check live uptime now">↺</button>
          </div>
        </td>
        <td class="col-maint" data-col="maintenance">
          <div class="status-cell-grp">
            <select class="status-select select-maint-compact" data-row-id="${r.id}" data-field="maintenanceStatus">${maintOpts}</select>
            <button class="btn-report-toggle ${r.reportSentStatus === 'sent' ? 'sent' : 'pending'}" data-row-id="${r.id}" data-status="${r.reportSentStatus}" title="Click to toggle Report Sent">
              ${r.reportSentStatus === 'sent' ? '✓ Sent' : '✉ No'}
            </button>
          </div>
        </td>
        <td class="col-links" data-col="clickup">
          <div class="quick-links-grp">
            ${cuLink !== '<span class="dim-dash">—</span>' ? cuLink : ''}
            ${bookHtml !== '<span class="dim-dash">—</span>' ? bookHtml : ''}
            ${cuLink === '<span class="dim-dash">—</span>' && bookHtml === '<span class="dim-dash">—</span>' ? '<span class="dim-dash">—</span>' : ''}
          </div>
        </td>
        <td class="col-integ" data-col="ga4">
          <div class="integrations-pill-grp">
            ${ga4SelectHtml}
            ${newsHtml !== '<span class="dim-dash">—</span>' ? newsHtml : ''}
            ${formHtml !== '<span class="dim-dash">—</span>' ? formHtml : ''}
          </div>
        </td>
        <td class="col-resp" data-col="response">${respHtml}</td>
        <td class="col-actions" data-col="actions" style="text-align:right">
          <div class="actions-grp" style="justify-content:flex-end">
            <button class="btn btn-ghost btn-sm toggle-detail-btn" data-id="${r.id}" title="Show all 12 details" style="display:inline-flex;align-items:center;gap:4px">${getSvg('eye', 12)}</button>
            <button class="btn btn-ghost btn-sm edit-dr-row-btn" data-id="${r.id}" title="Edit row data" style="display:inline-flex;align-items:center;gap:4px">${getSvg('edit', 12)}</button>
          </div>
        </td>
      </tr>
      <tr class="detail-accordion-row hidden" id="detail-row-${r.id}" data-parent-id="${r.id}">
        <td colspan="7">
          <div class="row-detail-bento">
            <div class="detail-bento-card">
              <div class="dbc-head">🌐 Website &amp; Account</div>
              <div class="dbc-row"><span class="dbc-lbl">Full URL:</span> <a href="${esc(r.siteUrl)}" target="_blank" class="dbc-val">${esc(r.siteUrl)} ↗</a></div>
              <div class="dbc-row"><span class="dbc-lbl">Company:</span> <span class="badge badge-${co.toLowerCase().includes('cw') ? 'cw' : 'rm'}">${esc(co)} Maintenance</span></div>
              <div class="dbc-row"><span class="dbc-lbl">ClickUp:</span> ${r.clickupLink ? `<a href="${esc(r.clickupLink)}" target="_blank" class="btn-clickup">⚡ View Task ↗</a>` : '<span class="dim-dash">—</span>'}</div>
            </div>
            <div class="detail-bento-card">
              <div class="dbc-head">🛠️ Review &amp; Report</div>
              <div class="dbc-row"><span class="dbc-lbl">Maintenance:</span> <span class="badge badge-${r.maintenanceStatus === 'completed' ? 'success' : r.maintenanceStatus === 'in_progress' ? 'info' : 'warning'}">${esc(r.maintenanceRaw || r.maintenanceStatus || 'Pending')}</span></div>
              <div class="dbc-row"><span class="dbc-lbl">Report Sent:</span> <span class="badge badge-${r.reportSentStatus === 'sent' ? 'success' : 'dim'}">${esc(r.reportSentRaw || r.reportSentStatus || 'No')}</span></div>
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
                <button class="btn btn-secondary btn-sm edit-dr-row-btn" data-id="${r.id}" style="display:inline-flex;align-items:center;gap:5px">${getSvg('edit', 12)} Edit Details</button>
              </div>
            </div>
          </div>
        </td>
      </tr>`;
  }

  // Full spreadsheet mode
  return `
    <tr data-url="${esc((r.siteUrl || '').toLowerCase())}" data-status="${r.maintenanceStatus}" data-id="${r.id}">
      <td style="color:var(--text-dim);font-size:11px;text-align:center">
        <input type="checkbox" class="row-checkbox" data-row-id="${r.id}" data-url="${esc(r.siteUrl)}" data-company="${esc(co)}" />
      </td>
      <td class="url-cell" data-col="url">
        <div class="site-identity-cell">
          ${liveBall}
          <a href="${esc(r.siteUrl)}" target="_blank" class="site-domain-link" title="${esc(r.siteUrl)}">${esc(shortUrl(r.siteUrl))} ↗</a>
          <button class="btn-uptime-check" data-row-id="${r.id}" data-site-url="${esc(r.siteUrl)}" data-site-id="${r.siteId || ''}" title="Check live uptime now">↺</button>
        </div>
      </td>
      <td data-col="company"><span class="badge badge-${co.toLowerCase().includes('cw') ? 'cw' : 'rm'}">${esc(co)}</span></td>
      <td data-col="maintenance"><select class="status-select select-maint" data-row-id="${r.id}" data-field="maintenanceStatus">${maintOpts}</select></td>
      <td data-col="report"><select class="status-select select-sent" data-row-id="${r.id}" data-field="reportSentStatus">${sentOpts}</select></td>
      <td data-col="clickup">${cuLink}</td>
      <td data-col="ga4">${ga4SelectHtml}</td>
      <td data-col="newsletter">${newsHtml}</td>
      <td data-col="form">${formHtml}</td>
      <td data-col="response">${respHtml}</td>
      <td data-col="booking">${bookHtml}</td>
      <td data-col="expiry">${expiryHtml}</td>
      <td data-col="cloudflare">${cfHtml}</td>
      <td data-col="actions">
        <button class="btn btn-ghost btn-sm edit-dr-row-btn" data-id="${r.id}" title="Edit all columns" style="display:inline-flex;align-items:center;gap:5px">${getSvg('edit', 12)} Edit</button>
      </td>
    </tr>`;
}

function editDailyReviewRowModal(row, onSaved) {
  if (!row) return;
  const maintOptions = ['Completed', 'In Progress', 'To Do', 'Pending'].map(o =>
    `<option ${row.maintenanceRaw === o ? 'selected' : ''}>${o}</option>`).join('');
  const sentOptions = ['Yes', 'No', 'To Do'].map(o =>
    `<option ${row.reportSentRaw === o ? 'selected' : ''}>${o}</option>`).join('');
  const uptimeOptions = ['Yes', 'No'].map(o =>
    `<option ${(row.uptimeRobot || '').toLowerCase() === o.toLowerCase() ? 'selected' : ''}>${o}</option>`).join('');

  openModal(`Edit Review: ${shortUrl(row.siteUrl)}`, `
    <div style="font-size:12px;color:var(--accent-2);margin-bottom:12px;word-break:break-all">
      <a href="${esc(row.siteUrl)}" target="_blank" style="color:inherit">🌐 ${esc(row.siteUrl)}</a>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group">
        <label class="form-label">Company / Account</label>
        <input class="form-input" id="edr-company" value="${esc(row.company || 'CW')}">
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
        <input class="form-input" id="edr-clickup" value="${esc(row.clickupLink || '')}" placeholder="https://app.clickup.com/t/...">
      </div>
      <div class="form-group">
        <label class="form-label">GA4 Report</label>
        <input class="form-input" id="edr-ga4" value="${esc(row.ga4 || '')}" placeholder="No GA4 Tag / link">
      </div>
      <div class="form-group">
        <label class="form-label">Newsletter Mail</label>
        <input class="form-input" id="edr-newsletter" value="${esc(row.newsletterMail || '')}" placeholder="MailChimp / email">
      </div>
      <div class="form-group">
        <label class="form-label">Form Submission Mail</label>
        <input class="form-input" id="edr-form" value="${esc(row.formSubmissionMail || '')}" placeholder="Recipient email / form name">
      </div>
      <div class="form-group">
        <label class="form-label">Client Response</label>
        <input class="form-input" id="edr-client-resp" value="${esc(row.clientResponse || '')}" placeholder="Client Responded / N/A">
      </div>
      <div class="form-group">
        <label class="form-label">Booking Engine</label>
        <input class="form-input" id="edr-booking" value="${esc(row.bookingLink || '')}" placeholder="OpenTable / Resy link / Yes / No">
      </div>
      <div class="form-group">
        <label class="form-label">UPTimeRobot Monitoring</label>
        <select class="form-select" id="edr-uptime">${uptimeOptions}</select>
      </div>
      <div class="form-group" style="grid-column: span 2">
        <label class="form-label">Cloudflare Issues</label>
        <input class="form-input" id="edr-cf" value="${esc(row.cloudflare || 'No')}" placeholder="No / Issue description">
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
    {
      label: 'Save Changes', cls: 'btn btn-primary', onClick: async () => {
        const maintRaw = $('edr-maint').value;
        const sentRaw = $('edr-sent').value;
        const normMap = { 'Completed': 'completed', 'In Progress': 'in_progress', 'To Do': 'todo', 'Pending': 'pending', 'Yes': 'sent', 'No': 'no' };

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
      }
    }
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
                <td>${esc(t.taskType || '—')}</td>
                <td>${priorityBadge(t.priority)}</td>
                <td>${statusBadge(t.status)}</td>
                <td>${t.clickupLink ? `<a class="btn btn-ghost btn-sm" href="${esc(t.clickupLink)}" target="_blank">Open</a>` : '—'}</td>
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
  let sheetCredsData = { credentials: [] };
  try {
    [stats, { summary }, noticeBannerHtml, sheetCredsData] = await Promise.all([
      GET('/api/master/stats'),
      GET('/api/master/summary'),
      getNoticeBannerHtml(),
      GET(`/api/master/sheet-credentials?role=${S.role}&progress=1`).catch(() => ({ credentials: [] }))
    ]);
  } catch (e) { toast(e.message, 'error'); }

  const totalSites = summary.reduce((a, u) => a + u.total, 0);
  const totalDone = summary.reduce((a, u) => a + u.completed, 0);
  const overallPct = totalSites ? Math.round(totalDone / totalSites * 100) : 0;
  const connectedSheets = (sheetCredsData?.credentials || []).filter(c => c.active !== false);

  mainEl.innerHTML = `
    <div class="fade-in">
      ${noticeBannerHtml}
      <div class="stat-grid">
        <div class="stat-card accent"><div class="stat-value">${stats.totalSites || 0}</div><div class="stat-label">Total Sites</div></div>
        <div class="stat-card success"><div class="stat-value">${overallPct}%</div><div class="stat-label">Today's Completion</div></div>
        <div class="stat-card ${stats.urgentDomains > 0 ? 'danger' : 'success'}"><div class="stat-value">${stats.urgentDomains || 0}</div><div class="stat-label">Urgent Domains (≤30d)</div></div>
        <div class="stat-card info"><div class="stat-value">${stats.totalTasks || 0}</div><div class="stat-label">Open Tasks</div></div>
        <div class="stat-card success"><div class="stat-value">${stats.onlineSites || 0}</div><div class="stat-label">Sites Online</div></div>
        <div class="stat-card ${stats.offlineSites > 0 ? 'danger' : 'dim'}"><div class="stat-value">${stats.offlineSites || 0}</div><div class="stat-label">Sites Offline</div></div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">👥 Team Progress Today</span>
          <div class="card-actions">
            <span style="font-size:12px;color:var(--text-muted)">${totalDone}/${totalSites} sites completed</span>
          </div>
        </div>
        <div class="card-body" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">
          ${summary.filter(u => u.total > 0).map(u => `
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

      ${connectedSheets.length ? `
        <div class="card" style="margin-top:20px">
          <div class="card-header" style="flex-wrap:wrap;gap:10px">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="card-title" style="display:inline-flex;align-items:center;gap:8px;color:var(--text-primary)">
                ${getSvg('database', 16)} Connected Sheets Intelligence & Progress
              </span>
              <span class="badge badge-accent" style="font-size:11px">Live Sync</span>
            </div>
            <div class="card-actions">
              <span style="font-size:12px;color:var(--text-muted)">Tracking ${connectedSheets.length} active sheets</span>
              ${S.role === 'superadmin' ? '<button class="btn btn-ghost btn-sm" onclick="navigate(\'sheet-manager\')">Sheet Manager</button>' : ''}
            </div>
          </div>
          <div class="card-body" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">
            ${connectedSheets.map(c => {
    const m = c.metrics || { total: 0, completed: 0, inProgress: 0, pending: 0, completionPct: 0 };
    return `
                <div class="overview-sheet-card">
                  <div class="osc-top">
                    <div class="osc-title-wrap">
                      <span class="osc-title">
                        ${getSvg('table', 14)} ${esc(c.title || c.label)}
                      </span>
                      <span class="osc-sub">${esc(c.tabName || 'Default')} · ${m.total.toLocaleString()} total items</span>
                    </div>
                    <span class="osc-pct">${m.completionPct}%</span>
                  </div>
                  <div class="osc-bar-wrap">
                    <div class="osc-bar-fill" style="width:${m.completionPct}%"></div>
                  </div>
                  <div class="osc-meta-row">
                    <span>${m.completed} Done · ${m.inProgress} In Progress · ${m.pending} Pending</span>
                    <span class="badge ${c.canEdit ? 'badge-success' : 'badge-dim'}" style="font-size:10.5px">
                      ${c.canEdit ? 'Can Edit' : 'View Only'}
                    </span>
                  </div>
                  <button class="osc-action-btn" onclick="navigate('custom-sheet-${c.id}')">
                    ${getSvg('table', 13)} Open Smart Dashboard →
                  </button>
                </div>
              `;
  }).join('')}
          </div>
        </div>
      ` : ''}
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
  } catch (e) { toast(e.message, 'error'); }

  const tabs = summary.filter(u => u.total > 0);
  if (!tabs.length) { mainEl.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><p>No data synced yet.</p></div>`; return; }

  const firstUser = tabs[0];
  mainEl.innerHTML = `
    <div class="fade-in">
      ${noticeBannerHtml}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">
        ${tabs.map((u, i) => `
          <button class="btn ${i === 0 ? 'btn-primary' : 'btn-secondary'} user-tab-btn" data-uid="${u.userId}" data-uname="${esc(u.user)}">
            ${esc(u.user)} <span class="badge badge-${u.pct >= 100 ? 'success' : u.pct > 50 ? 'info' : 'warning'}">${u.pct}%</span>
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
      const u = summary.find(x => x.userId === userId) || {};
      const isSmart = S.tableMode !== 'full';
      panel.innerHTML = `
        <div class="card">
          <div class="card-header">
            <span class="card-title">🌐 ${esc(userName)}'s Assigned Sites (${rows.length})</span>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span class="user-pct-text" style="font-size:12px;color:var(--text-muted)">${u.pct || 0}% complete</span>
              <div class="progress-wrap" style="width:100px"><div class="progress-fill user-progress-fill" style="width:${u.pct || 0}%"></div></div>
              <div class="view-mode-toggle" id="user-table-mode-toggle">
                <button class="btn btn-sm mode-btn ${isSmart ? 'active' : ''}" data-mode="smart" title="Smart Fit 100vw - No horizontal scroll">⚡ Smart Fit</button>
                <button class="btn btn-sm mode-btn ${!isSmart ? 'active' : ''}" data-mode="full" title="Spreadsheet mode">📋 Full Spread</button>
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
              <tbody id="user-sites-tbody">${rows.map((r, i) => siteRow(r, i, isSmart ? 'smart' : 'full')).join('')}</tbody>
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
          try { localStorage.setItem('officeos_table_mode', mode); } catch { }
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
          const normMap = { 'Completed': 'completed', 'In Progress': 'in_progress', 'To Do': 'todo', 'Pending': 'pending', 'Yes': 'sent', 'No': 'no' };
          const isMaint = field === 'maintenanceStatus' || field === 'maintenanceRaw';
          try {
            await PUT(`/api/master/daily-review/${rowId}`, {
              [field]: normMap[value] || value,
              [field + 'Raw']: value,
            });
            if (isMaint) {
              const sheetVal = (value === 'Completed' || value === 'completed') ? 'Updated & Backup' : value;
              toast(`⚡ Status saved & synced to Google Sheet (${sheetVal})`, 'success', 3000);
            } else {
              toast('Status updated', 'success');
            }
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
  setPage('All Sites', 'Client website portfolio & live maintenance tracker');
  let sites = [];
  try { ({ sites } = await GET('/api/master/sites')); } catch (e) { toast(e.message, 'error'); }

  const total = sites.length;
  const activeSites = sites.filter(s => !(s.status || '').toLowerCase().includes('deactiv'));
  const deactSites = sites.filter(s => (s.status || '').toLowerCase().includes('deactiv'));
  const onlineSites = sites.filter(s => s.uptimeStatus === 'online');
  const cwCount = sites.filter(s => s.account === 'CW').length;
  const rmCount = sites.filter(s => s.account === 'RM').length;

  mainEl.innerHTML = `
    <div class="fade-in" style="padding: 4px 0 24px">
      <!-- Linear View Header (Matches Reference Screenshot) -->
      <div class="linear-view-header">
        <div class="linear-view-title-wrap">
          <h2 class="linear-view-title">Active sites</h2>
          <span class="linear-count-pill" id="header-count-pill">${activeSites.length}</span>
        </div>
        <div class="linear-header-actions">
          <button class="linear-icon-btn active" title="List View">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          </button>
          <button class="linear-icon-btn" title="Board View">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          </button>
          <button class="linear-icon-btn" id="check-uptime-btn" title="Check Sites Uptime">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          </button>
        </div>
      </div>

      <!-- Linear Action Bar (Filter [F], Display [D], + New site [C]) -->
      <div class="linear-action-bar">
        <div class="linear-action-bar-left">
          <!-- Interactive Filter Popover Trigger -->
          <div style="position:relative">
            <button class="btn-linear-capsule active" id="btn-filter-capsule" data-tooltip="Open filter options (F)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
              <span>Filter</span>
              <kbd class="linear-kbd">F</kbd>
            </button>
            <div id="linear-filter-popover" class="linear-filter-popover hidden">
              <div>
                <div class="linear-filter-group-title">Account Checklist</div>
                <div class="linear-filter-options">
                  <button class="linear-filter-opt active" data-filter-type="acct" data-filter-val="">All Accounts</button>
                  <button class="linear-filter-opt" data-filter-type="acct" data-filter-val="CW">CW (Cogwheel)</button>
                  <button class="linear-filter-opt" data-filter-type="acct" data-filter-val="RM">RM (RevMax)</button>
                </div>
              </div>
              <div>
                <div class="linear-filter-group-title">Site Status</div>
                <div class="linear-filter-options">
                  <button class="linear-filter-opt active" data-filter-type="status" data-filter-val="">All Status</button>
                  <button class="linear-filter-opt" data-filter-type="status" data-filter-val="active">🟢 Active</button>
                  <button class="linear-filter-opt" data-filter-type="status" data-filter-val="deactive">⚪ Deactive</button>
                </div>
              </div>
              <div>
                <div class="linear-filter-group-title">Uptime Status</div>
                <div class="linear-filter-options">
                  <button class="linear-filter-opt active" data-filter-type="uptime" data-filter-val="">All</button>
                  <button class="linear-filter-opt" data-filter-type="uptime" data-filter-val="online">🟢 Online</button>
                  <button class="linear-filter-opt" data-filter-type="uptime" data-filter-val="offline">🔴 Offline</button>
                </div>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px">
                <span id="popover-match-count" style="font-size:11px;color:#8a8f98">${sites.length} matching</span>
                <button class="btn-linear-capsule" id="btn-reset-popover" style="padding:2px 8px;font-size:11px">Reset</button>
              </div>
            </div>
          </div>

          <!-- Quick Filter Status Pills -->
          <div style="display:flex;align-items:center;gap:4px;margin-left:4px">
            <button class="site-tab-pill active" data-filter="all">All (${total})</button>
            <button class="site-tab-pill" data-filter="active">Active (${activeSites.length})</button>
            <button class="site-tab-pill" data-filter="deactive">Deactive (${deactSites.length})</button>
            <button class="site-tab-pill" data-filter="CW">CW (${cwCount})</button>
            <button class="site-tab-pill" data-filter="RM">RM (${rmCount})</button>
          </div>
        </div>

        <div class="linear-action-bar-right">
          <!-- Search input with hotkey -->
          <div class="search-wrap" style="width:220px;height:30px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input id="site-search" class="search-input" placeholder="Search sites…" style="font-size:12px">
            <kbd class="linear-kbd" style="margin-right:6px">/</kbd>
          </div>

          <!-- + New Site [C] Button -->
          <button class="btn-linear-primary" id="add-site-btn" data-tooltip="Add new site to inventory & Google Sheet (C)">
            <span>+ New site</span>
            <kbd class="linear-kbd">C</kbd>
          </button>
        </div>
      </div>

      <!-- Linear List Card (Precision 38px rows, hairline dividers) -->
      <div class="linear-list-card">
        <table class="linear-table">
          <thead>
            <tr>
              <th style="width:28px;text-align:center"></th>
              <th style="width:24px;text-align:center"></th>
              <th style="width:72px">ID</th>
              <th>Website &amp; Client</th>
              <th style="width:65px">Account</th>
              <th style="width:85px">CMS</th>
              <th style="width:90px">Uptime</th>
              <th style="width:105px">Domain Expiry</th>
              <th style="width:140px">A/C Manager</th>
              <th style="text-align:right;width:115px">Actions</th>
            </tr>
          </thead>
          <tbody id="sites-tbody">
            ${sites.map((s, i) => siteFullRow(s, i)).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  // Filter state
  let currentTab = 'all';
  let filterAcct = '';
  let filterStatus = '';
  let filterUptime = '';

  const tbody = $('sites-tbody');
  const allRows = [...tbody.querySelectorAll('tr')];

  function applyFilters() {
    const q = ($('site-search')?.value || '').toLowerCase().trim();

    let visibleCount = 0;
    allRows.forEach(tr => {
      const url = tr.dataset.url || '';
      const comp = tr.dataset.company || '';
      const acm = tr.dataset.acm || '';
      const cms = tr.dataset.cms || '';
      const acc = tr.dataset.account || '';
      const st = tr.dataset.status || '';
      const upt = tr.dataset.uptime || '';

      let matchTab = true;
      if (currentTab === 'active') matchTab = st === 'active';
      else if (currentTab === 'deactive') matchTab = st === 'deactive';
      else if (currentTab === 'CW') matchTab = acc === 'CW';
      else if (currentTab === 'RM') matchTab = acc === 'RM';

      let matchSearch = true;
      if (q) {
        matchSearch = url.includes(q) || comp.includes(q) || acm.includes(q) || cms.includes(q);
      }

      let matchAcct = !filterAcct || acc === filterAcct;
      let matchStatus = !filterStatus || st === filterStatus;
      let matchUptime = !filterUptime || upt === filterUptime;

      const show = matchTab && matchSearch && matchAcct && matchStatus && matchUptime;
      tr.classList.toggle('hidden', !show);
      if (show) visibleCount++;
    });

    const badge = $('header-count-pill');
    if (badge) badge.textContent = visibleCount;
    const popoverBadge = $('popover-match-count');
    if (popoverBadge) popoverBadge.textContent = `${visibleCount} matching`;
  }

  // Bind tab pills
  document.querySelectorAll('.site-tab-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.site-tab-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.filter;
      applyFilters();
    });
  });

  // Filter Popover Toggling
  const filterBtn = $('btn-filter-capsule');
  const filterPopover = $('linear-filter-popover');
  if (filterBtn && filterPopover) {
    filterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      filterPopover.classList.toggle('hidden');
    });

    // Option clicks inside popover
    filterPopover.querySelectorAll('.linear-filter-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = opt.dataset.filterType;
        const val = opt.dataset.filterVal;
        filterPopover.querySelectorAll(`.linear-filter-opt[data-filter-type="${type}"]`).forEach(b => b.classList.remove('active'));
        opt.classList.add('active');

        if (type === 'acct') filterAcct = val;
        else if (type === 'status') filterStatus = val;
        else if (type === 'uptime') filterUptime = val;

        applyFilters();
      });
    });

    // Reset popover filters
    $('btn-reset-popover')?.addEventListener('click', (e) => {
      e.stopPropagation();
      filterAcct = '';
      filterStatus = '';
      filterUptime = '';
      filterPopover.querySelectorAll('.linear-filter-opt').forEach(b => {
        b.classList.toggle('active', b.dataset.filterVal === '');
      });
      applyFilters();
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!filterPopover.contains(e.target) && e.target !== filterBtn) {
        filterPopover.classList.add('hidden');
      }
    });
  }

  $('site-search')?.addEventListener('input', applyFilters);

  // Add website button
  $('add-site-btn')?.addEventListener('click', () => openAddSiteModal());

  // Assign buttons
  tbody.querySelectorAll('.assign-site-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = sites.find(x => x.id === btn.dataset.id);
      if (s) openAssignModal(btn.dataset.id, s, () => viewSites());
    });
  });

  // Edit buttons
  tbody.querySelectorAll('.edit-site-btn').forEach(btn => {
    btn.addEventListener('click', () => editSiteModal(btn.dataset.id, sites.find(s => s.id === btn.dataset.id)));
  });

  // Quick toggle active/deactive buttons
  tbody.querySelectorAll('.toggle-status-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const targetStatus = action === 'activate' ? 'Active' : 'Deactive';
      const s = sites.find(x => x.id === id);
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      try {
        await PUT(`/api/master/sites/${id}/status`, { status: targetStatus });
        toast(`Site "${s?.url || id}" marked as ${targetStatus} and synchronized with ${s?.account || 'CW'} Sheet!`, 'success', 5000);
        viewSites();
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = originalText;
        toast(err.message, 'error');
      }
    });
  });

  // Copy URL buttons
  tbody.querySelectorAll('.btn-copy-url').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const u = btn.dataset.url;
      if (u) {
        navigator.clipboard.writeText(u);
        toast(`Copied "${u}" to clipboard`, 'info', 2500);
      }
    });
  });

  // Check uptime
  $('check-uptime-btn')?.addEventListener('click', async () => {
    toast('Checking all sites… this may take a few minutes', 'info', 10000);
    try {
      const r = await POST('/api/master/check-uptime', {});
      toast(`✅ ${r.online} online, ${r.offline} offline`, 'success', 6000);
      navigate('sites');
    } catch (e) { toast(e.message, 'error'); }
  });
}

function siteFullRow(s, idx = 0) {
  const isDeact = (s.status || '').toLowerCase().includes('deactiv');
  const cleanUrl = (s.url || '').trim();
  const href = cleanUrl.startsWith('http') ? cleanUrl : `https://${cleanUrl}`;

  // 2-Letter clean initials without parenthesis or special characters
  let initials = '—';
  const cleanManager = (s.accountManager || '').replace(/[^a-zA-Z0-9\s]/g, '').trim();
  if (cleanManager) {
    const parts = cleanManager.split(/\s+/);
    initials = parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : parts[0].slice(0, 2).toUpperCase();
  } else if (s.assignedUsers && s.assignedUsers.length) {
    const u = S.users.find(u => u.id === s.assignedUsers[0]);
    if (u && u.name) {
      const cleanU = u.name.replace(/[^a-zA-Z0-9\s]/g, '').trim();
      const parts = cleanU.split(/\s+/);
      initials = parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : parts[0].slice(0, 2).toUpperCase();
    }
  }

  const idCode = `${esc(s.account || 'CW')}-${String((idx || 0) + 1).padStart(3, '0')}`;

  return `
    <tr data-url="${esc(cleanUrl.toLowerCase())}" 
        data-account="${esc(s.account)}" 
        data-company="${esc((s.company || '').toLowerCase())}" 
        data-acm="${esc((s.accountManager || '').toLowerCase())}"
        data-cms="${esc((s.cms || '').toLowerCase())}"
        data-status="${isDeact ? 'deactive' : 'active'}" 
        data-uptime="${esc(s.uptimeStatus || 'unknown')}">
      
      <!-- 1. Status Glyph -->
      <td style="text-align:center">
        <span class="linear-status-icon ${isDeact ? 'deactive' : 'active'}" data-tooltip="${isDeact ? 'Deactivated: archived in spreadsheet' : 'Active: live monitored site'}">
          ${isDeact ? '⚪' : '⊙'}
        </span>
      </td>

      <!-- 2. Signal Bars -->
      <td style="text-align:center">
        <span class="linear-signal-icon" data-tooltip="Standard Priority">
          <span class="linear-signal-bar" style="height:4px"></span>
          <span class="linear-signal-bar" style="height:7px"></span>
          <span class="linear-signal-bar" style="height:10px"></span>
        </span>
      </td>

      <!-- 3. Monospace Code -->
      <td>
        <span class="linear-code">${idCode}</span>
      </td>

      <!-- 4. Website & Client -->
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <a href="${esc(href)}" target="_blank" rel="noopener" class="linear-title" data-tooltip="Open website in new tab ↗">
            ${esc(shortUrl(cleanUrl, 28))}
          </a>
          <button class="btn-icon-micro btn-copy-url" data-url="${esc(cleanUrl)}" data-tooltip="Copy website URL">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          ${s.company ? `<span style="font-size:11.5px;color:var(--text-muted)">• ${esc(s.company)}</span>` : ''}
        </div>
      </td>

      <!-- 5. Account Tag -->
      <td>
        <span class="linear-badge ${s.account === 'CW' ? 'cw' : 'rm'}" data-tooltip="${s.account === 'CW' ? 'Cogwheel Checklist' : 'RevMax Checklist'}">${esc(s.account)}</span>
      </td>

      <!-- 6. CMS Tag -->
      <td>
        <span class="linear-badge infra" data-tooltip="Platform: ${esc(s.cms || 'Custom')}">${esc(s.cms || 'Web')}</span>
      </td>

      <!-- 7. Uptime Status -->
      <td>
        <div data-tooltip="Uptime: ${esc(s.uptimeStatus || 'unknown')}">
          ${uptimeDot(s.uptimeStatus)}
        </div>
      </td>

      <!-- 8. Domain Expiry -->
      <td>
        <div data-tooltip="Domain Expiration">
          ${domainBadge(s.daysLeft)}
        </div>
      </td>

      <!-- 9. Account Manager with Avatar Initials -->
      <td>
        <div style="display:flex;align-items:center;gap:7px" data-tooltip="Account Manager: ${esc(s.accountManager || 'Unassigned')}">
          <span class="linear-avatar-initials">${esc(initials)}</span>
          <span style="font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:95px">${esc(s.accountManager || '—')}</span>
        </div>
      </td>

      <!-- 10. Linear Vector SVG Action Buttons -->
      <td style="text-align:right">
        <div style="display:inline-flex;align-items:center;gap:4px">
          ${isDeact
      ? `<button class="btn-linear-action toggle-status-btn" data-id="${s.id}" data-action="activate" data-tooltip="Activate site & sync to Google Sheet" style="color:#10b981">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
              </button>`
      : `<button class="btn-linear-action toggle-status-btn" data-id="${s.id}" data-action="deactivate" data-tooltip="Deactivate site & sync to Google Sheet" style="color:#f43f5e">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
              </button>`}
          <button class="btn-linear-action assign-site-btn" data-id="${s.id}" data-tooltip="Assign team members">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
          </button>
          <button class="btn-linear-action edit-site-btn" data-id="${s.id}" data-tooltip="Edit site metadata">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
}

function openAddSiteModal() {
  openModal(`➕ Add New Website`, `
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="form-group">
        <label class="form-label">Website URL <span style="color:var(--danger)">*</span></label>
        <input class="form-input" id="new-site-url" placeholder="e.g. acmehotel.com or https://acmehotel.com">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label class="form-label">Account / Sheet</label>
          <select class="form-select" id="new-site-account">
            <option value="CW" selected>CW (Checklist)</option>
            <option value="RM">RM (Checklist)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Initial Status</label>
          <select class="form-select" id="new-site-status">
            <option value="Active" selected>🟢 Active</option>
            <option value="Deactive">⚪ Deactive</option>
          </select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label class="form-label">Company / Client Name</label>
          <input class="form-input" id="new-site-company" placeholder="e.g. Acme Hotel Group">
        </div>
        <div class="form-group">
          <label class="form-label">CMS Platform</label>
          <input class="form-input" id="new-site-cms" placeholder="e.g. WordPress, Shopify, Custom" value="Wordpress">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label class="form-label">Account Manager</label>
          <input class="form-input" id="new-site-acm" placeholder="e.g. Jacob, Mohammed, Yana">
        </div>
        <div class="form-group">
          <label class="form-label">Domain Expiry Date (optional)</label>
          <input class="form-input" id="new-site-expiry" type="date">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Assign Developers / Team Members</label>
        <div class="user-assign-grid">
          ${S.users.map(u => `
            <label class="user-check-item">
              <input type="checkbox" class="modal-new-assignee" value="${u.id}">
              <span class="user-check-avatar">${esc((u.name || 'U')[0].toUpperCase())}</span>
              <span class="user-check-name">${esc(u.name)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes (optional)</label>
        <input class="form-input" id="new-site-note" placeholder="Any special notes or client instructions…">
      </div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
    {
      label: '➕ Add & Sync to Sheet', cls: 'btn btn-primary', onClick: async () => {
        const url = ($('new-site-url')?.value || '').trim();
        if (!url) { toast('Please enter a website URL', 'warning'); return; }

        const selected = [...document.querySelectorAll('.modal-new-assignee:checked')].map(cb => cb.value);
        const submitBtn = document.querySelector('.modal-footer .btn-primary');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding & Syncing…'; }

        try {
          const account = $('new-site-account')?.value || 'CW';
          await POST('/api/master/sites', {
            url,
            account,
            status: $('new-site-status')?.value || 'Active',
            company: $('new-site-company')?.value || '',
            cms: $('new-site-cms')?.value || '',
            accountManager: $('new-site-acm')?.value || '',
            domainExpiry: $('new-site-expiry')?.value || '',
            note: $('new-site-note')?.value || '',
            assignedUsers: selected,
          });

          toast(`🎉 Added "${url}" and synchronized with ${account} Sheet!`, 'success', 5000);
          closeModal();
          viewSites();
        } catch (e) {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '➕ Add & Sync to Sheet'; }
          toast(e.message, 'error', 6000);
        }
      }
    }
  ]);
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
          <input type="checkbox" class="user-assign-checkbox" value="${u.id}" ${currentAssigned.includes(u.id) ? 'checked' : ''}>
          <span class="user-check-avatar">${esc((u.name || 'U')[0].toUpperCase())}</span>
          <div>
            <div class="user-check-name">${esc(u.name)}</div>
            <div class="user-check-role">${esc(u.role)}</div>
          </div>
        </label>
      `).join('')}
    </div>
  `, [
    { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
    {
      label: 'Save Assignments', cls: 'btn btn-primary', onClick: async () => {
        const selected = [...document.querySelectorAll('.user-assign-checkbox:checked')].map(cb => cb.value);
        try {
          await POST(`/api/master/sites/${siteId}/assign`, { userIds: selected });
          toast(`✅ Assigned ${selected.length} user(s) to site`, 'success');
          closeModal();
          if (onSaved) onSaved();
          else navigate('sites');
        } catch (err) { toast(err.message, 'error'); }
      }
    }
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
    const isAssigned = (s.assignedUsers || []).includes(userId);
    return `
          <label class="user-check-item site-check-row" data-url="${esc((s.url || '').toLowerCase())}" data-comp="${esc((s.company || '').toLowerCase())}" style="justify-content:space-between">
            <div style="display:flex;align-items:center;gap:10px">
              <input type="checkbox" class="site-assign-checkbox" value="${s.id}" ${isAssigned ? 'checked' : ''}>
              <div>
                <div style="font-weight:600;font-size:12px">${esc(shortUrl(s.url, 45))}</div>
                <div style="font-size:11px;color:var(--text-muted)">${esc(s.company || '—')} · ${esc(s.account || 'CW')}</div>
              </div>
            </div>
            <span class="badge badge-${s.account === 'CW' ? 'cw' : 'rm'}">${esc(s.account || 'CW')}</span>
          </label>`;
  }).join('')}
    </div>
  `, [
    { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
    {
      label: 'Save Assignments', cls: 'btn btn-primary', onClick: async () => {
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
      }
    }
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
         <option value="Active" ${!(site.status || '').toLowerCase().includes('deactiv') ? 'selected' : ''}>🟢 Active</option>
         <option value="Deactive" ${(site.status || '').toLowerCase().includes('deactiv') ? 'selected' : ''}>⚪ Deactive</option>
       </select></div>
     <div class="form-group"><label class="form-label">Assign Users</label>
       <div class="user-assign-grid">
         ${S.users.map(u => `
           <label class="user-check-item">
             <input type="checkbox" class="modal-edit-assignee" value="${u.id}" ${currentAssigned.includes(u.id) ? 'checked' : ''}>
             <span class="user-check-avatar">${esc((u.name || 'U')[0].toUpperCase())}</span>
             <span class="user-check-name">${esc(u.name)}</span>
           </label>
         `).join('')}
       </div>
     </div>`,
    [
      { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
      {
        label: 'Save', cls: 'btn btn-primary', onClick: async () => {
          const selected = [...document.querySelectorAll('.modal-edit-assignee:checked')].map(cb => cb.value);
          try {
            await PUT(`/api/master/sites/${id}`, {
              company: $('edit-company').value,
              accountManager: $('edit-acm').value,
              cms: $('edit-cms').value,
              status: $('edit-status').value,
              assignedUsers: selected,
            });
            toast(`Site updated & synced with ${site.account || 'CW'} Sheet!`, 'success');
            closeModal();
            viewSites();
          } catch (e) { toast(e.message, 'error'); }
        }
      },
    ]
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: TASKS (Admin/Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewTasks() {
  setPage('Tasks', 'Manage and assign tasks');
  let tasks = [];
  try { ({ tasks } = await GET('/api/master/tasks')); } catch (e) { toast(e.message, 'error'); }

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
          ${S.users.map(u => `<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('')}
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
    btn.addEventListener('click', () => editTaskModal(btn.dataset.id, tasks.find(t => t.id === btn.dataset.id)));
  });
  tbody.querySelectorAll('.del-task-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this task?')) return;
      try { await DELETE(`/api/master/tasks/${btn.dataset.id}`); toast('Deleted', 'success'); navigate('tasks'); }
      catch (e) { toast(e.message, 'error'); }
    });
  });
  // Inline status change
  tbody.querySelectorAll('.task-status-sel').forEach(sel => {
    sel.addEventListener('change', async e => {
      const id = e.target.dataset.id;
      try { await PUT(`/api/master/tasks/${id}`, { status: e.target.value }); toast('Status updated', 'success'); }
      catch (e2) { toast(e2.message, 'error'); }
    });
  });
}

function taskRow(t) {
  const statuses = ['todo', 'in_progress', 'completed'];
  const opts = statuses.map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('');
  return `
    <tr data-task="${esc((t.taskName || '').toLowerCase())}" data-site="${esc((t.siteUrl || '').toLowerCase())}" data-status="${esc(t.status)}" data-assignee="${esc(t.assigneeName)}">
      <td style="font-weight:500;max-width:200px">${esc(t.taskName)}</td>
      <td class="url-cell"><a href="${esc(t.siteUrl)}" target="_blank">${esc(shortUrl(t.siteUrl))}</a></td>
      <td>${esc(t.assigneeName || 'Unassigned')}</td>
      <td style="font-size:12px">${esc(t.taskType || '—')}</td>
      <td>${priorityBadge(t.priority)}</td>
      <td><select class="task-status-sel status-select" data-id="${t.id}">${opts}</select></td>
      <td>${t.clickupLink ? `<a class="btn btn-ghost btn-sm" href="${esc(t.clickupLink)}" target="_blank">Open</a>` : '—'}</td>
      <td style="display:flex;gap:4px">
        <button class="btn btn-ghost btn-sm edit-task-btn" data-id="${t.id}" title="Edit task" style="display:inline-flex;align-items:center;justify-content:center">${getSvg('edit', 12)}</button>
        <button class="btn btn-danger btn-sm del-task-btn" data-id="${t.id}" title="Delete task" style="display:inline-flex;align-items:center;justify-content:center">${getSvg('trash', 12)}</button>
      </td>
    </tr>`;
}

function taskModalBody(t = {}) {
  return `
    <div class="form-group"><label class="form-label">Task Name *</label><input class="form-input" id="t-name" value="${esc(t.taskName || '')}"></div>
    <div class="form-group"><label class="form-label">Site URL</label><input class="form-input" id="t-site" value="${esc(t.siteUrl || '')}"></div>
    <div class="form-group"><label class="form-label">Assignee</label>
      <select class="form-select" id="t-assignee">
        <option value="">Unassigned</option>
        ${S.users.map(u => `<option value="${u.id}" ${t.assigneeId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group"><label class="form-label">Task Type</label><input class="form-input" id="t-type" value="${esc(t.taskType || '')}"></div>
      <div class="form-group"><label class="form-label">Priority</label>
        <select class="form-select" id="t-priority">
          ${['high', 'medium', 'low'].map(p => `<option ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-group"><label class="form-label">ClickUp Link</label><input class="form-input" id="t-clickup" value="${esc(t.clickupLink || '')}"></div>
    <div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" id="t-notes">${esc(t.notes || '')}</textarea></div>`;
}

function gatherTask() {
  const uid = $('t-assignee').value;
  const u = S.users.find(x => x.id === uid);
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
    { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
    {
      label: 'Create', cls: 'btn btn-primary', onClick: async () => {
        const b = gatherTask();
        if (!b.taskName) { toast('Task name required', 'error'); return; }
        try { await POST('/api/master/tasks', b); toast('Task created', 'success'); closeModal(); navigate('tasks'); }
        catch (e) { toast(e.message, 'error'); }
      }
    },
  ]);
}

function editTaskModal(id, t) {
  if (!t) return;
  openModal('Edit Task', taskModalBody(t), [
    { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
    {
      label: 'Save', cls: 'btn btn-primary', onClick: async () => {
        try { await PUT(`/api/master/tasks/${id}`, gatherTask()); toast('Saved', 'success'); closeModal(); navigate('tasks'); }
        catch (e) { toast(e.message, 'error'); }
      }
    },
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: DOMAIN EXPIRY
// ═══════════════════════════════════════════════════════════════════════════════
async function viewDomainExpiry() {
  setPage('Domain Expiry', 'Sorted by urgency');
  let domains = [];
  try { ({ domains } = await GET('/api/master/domain-expiry')); } catch (e) { toast(e.message, 'error'); }

  const urgent = domains.filter(d => d.urgent).length;
  const warning = domains.filter(d => d.warning).length;

  mainEl.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid" style="margin-bottom:20px">
        <div class="stat-card danger">
          <div class="stat-header">
            <span class="stat-label">Critical Expiry</span>
            <span class="linear-badge bug" style="font-size:10px">≤30d</span>
          </div>
          <div class="stat-value" style="color:#f43f5e">${urgent}</div>
          <div class="stat-sub">Expiring within 30 days</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-header">
            <span class="stat-label">Expiring Soon</span>
            <span class="linear-badge" style="background:rgba(245,158,11,0.12);color:#fbbf24;font-size:10px">31–90d</span>
          </div>
          <div class="stat-value" style="color:#fbbf24">${warning}</div>
          <div class="stat-sub">Action needed this quarter</div>
        </div>
        <div class="stat-card success">
          <div class="stat-header">
            <span class="stat-label">Healthy Domains</span>
            <span class="linear-badge active" style="font-size:10px">&gt;90d</span>
          </div>
          <div class="stat-value" style="color:#10b981">${domains.length - urgent - warning}</div>
          <div class="stat-sub">Valid for over 3 months</div>
        </div>
        <div class="stat-card accent">
          <div class="stat-header">
            <span class="stat-label">Domain Portfolio</span>
            <span class="linear-badge feature" style="font-size:10px">Total</span>
          </div>
          <div class="stat-value" style="color:#818cf8">${domains.length}</div>
          <div class="stat-sub">Monitored domain records</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">📅 All Domains</span></div>
        <div class="table-wrap"><table class="table-smart-fit">
          <thead><tr><th>URL</th><th>Account</th><th>Company</th><th>A/C Manager</th><th>CMS</th><th>Expiry Date</th><th>Status</th></tr></thead>
          <tbody>
            ${domains.map(d => `<tr>
              <td class="url-cell"><a href="${esc(d.url)}" target="_blank">${esc(shortUrl(d.url))}</a></td>
              <td><span class="badge badge-${d.account === 'CW' ? 'cw' : 'rm'}">${esc(d.account || '—')}</span></td>
              <td style="font-size:12px">${esc(d.company || '—')}</td>
              <td style="font-size:12px">${esc(d.accountManager || '—')}</td>
              <td style="font-size:12px">${esc(d.cms || '—')}</td>
              <td style="font-size:12px">${esc(d.expiryDate || '—')}</td>
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
  try { ({ sites } = await GET('/api/master/sites')); } catch (e) { toast(e.message, 'error'); }

  const online = sites.filter(s => s.uptimeStatus === 'online').length;
  const offline = sites.filter(s => s.uptimeStatus === 'offline').length;
  const unknown = sites.filter(s => s.uptimeStatus === 'unknown').length;

  mainEl.innerHTML = `
    <div class="fade-in">
      <div class="stat-grid" style="margin-bottom:20px">
        <div class="stat-card success">
          <div class="stat-header">
            <span class="stat-label">Online Sites</span>
            <span class="linear-badge active" style="font-size:10px">HTTP 200</span>
          </div>
          <div class="stat-value" style="color:#10b981">${online}</div>
          <div class="stat-sub">${Math.round(sites.length ? (online / sites.length) * 100 : 0)}% healthy responses</div>
        </div>
        <div class="stat-card danger">
          <div class="stat-header">
            <span class="stat-label">Offline Detected</span>
            <span class="linear-badge bug" style="font-size:10px">Alert</span>
          </div>
          <div class="stat-value" style="color:#f43f5e">${offline}</div>
          <div class="stat-sub">${offline ? 'Requires team review' : 'No outages detected'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-header">
            <span class="stat-label">Pending Checks</span>
            <span class="linear-badge infra" style="font-size:10px">Queue</span>
          </div>
          <div class="stat-value" style="color:#8a8f98">${unknown}</div>
          <div class="stat-sub">Awaiting next uptime sweep</div>
        </div>
        <div class="stat-card accent">
          <div class="stat-header">
            <span class="stat-label">Total Monitored</span>
            <span class="linear-badge feature" style="font-size:10px">Active</span>
          </div>
          <div class="stat-value" style="color:#818cf8">${sites.length}</div>
          <div class="stat-sub">Across CW and RM checklists</div>
        </div>
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
            ${sites.map(s => `
              <div class="uptime-item ${s.uptimeStatus || 'unknown'}" data-site-id="${s.id}">
                ${uptimeDot(s.uptimeStatus)}
                <span class="uptime-url" title="${esc(s.url)}">${esc(shortUrl(s.url, 32))}</span>
                ${s.uptimeResponseTime ? `<span class="uptime-ms">${s.uptimeResponseTime}ms</span>` : ''}
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
            if (msg.complete) { toast(`✅ Done — ${done} sites checked`, 'success', 5000); navigate('uptime'); }
          } catch { }
        }
      }
    } catch (e) { toast(e.message, 'error'); }
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
        item.querySelector('.uptime-dot').textContent = result.status === 'online' ? '🟢 Online' : '🔴 Offline';
        btn.textContent = '↺';
        toast(`${result.status === 'online' ? '🟢 Online' : '🔴 Offline'}${result.responseTime ? ' · ' + result.responseTime + 'ms' : ''}`, result.status === 'online' ? 'success' : 'error');
      } catch (e) { toast(e.message, 'error'); btn.textContent = '↺'; }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: PROPERTY REGISTRY (Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewProperties() {
  setPage('Property Registry', 'RM Active Projects');
  let properties = [];
  try { ({ properties } = await GET('/api/master/properties')); } catch (e) { toast(e.message, 'error'); }

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
            ${properties.map(p => `
              <tr data-name="${esc((p.name || '').toLowerCase())}">
                <td style="font-weight:500">${esc(p.name || '—')}</td>
                <td class="url-cell"><a href="${esc(p.url)}" target="_blank">${esc(shortUrl(p.url))}</a></td>
                <td style="font-size:12px">${esc(p.type || '—')}</td>
                <td><span class="badge badge-${p.status === 'Active' ? 'success' : 'dim'}">${esc(p.status)}</span></td>
                <td><span class="badge badge-${p.seo === 'Yes' ? 'success' : 'dim'}">${esc(p.seo || '—')}</span></td>
                <td><span class="badge badge-${p.hm === 'Yes' ? 'success' : 'dim'}">${esc(p.hm || '—')}</span></td>
                <td style="font-size:12px">${esc(p.seoAssignee || '—')}</td>
                <td style="font-size:12px">${esc(p.webAssignee || '—')}</td>
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
      const prop = properties.find(p => p.id === btn.dataset.id);
      if (!prop) return;
      openModal(`Edit: ${prop.name}`,
        `<div class="form-group"><label class="form-label">Property Name</label><input class="form-input" id="p-name" value="${esc(prop.name)}"></div>
         <div class="form-group"><label class="form-label">URL</label><input class="form-input" id="p-url" value="${esc(prop.url)}"></div>
         <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
           <div class="form-group"><label class="form-label">Type</label><input class="form-input" id="p-type" value="${esc(prop.type)}"></div>
           <div class="form-group"><label class="form-label">Status</label>
             <select class="form-select" id="p-status">
               <option ${prop.status === 'Active' ? 'selected' : ''}>Active</option>
               <option ${prop.status === 'Inactive' ? 'selected' : ''}>Inactive</option>
             </select></div>
         </div>
         <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
           <div class="form-group"><label class="form-label">SEO</label>
             <select class="form-select" id="p-seo"><option ${prop.seo === 'Yes' ? 'selected' : ''}>Yes</option><option ${prop.seo === 'No' ? 'selected' : ''}>No</option></select></div>
           <div class="form-group"><label class="form-label">H&M</label>
             <select class="form-select" id="p-hm"><option ${prop.hm === 'Yes' ? 'selected' : ''}>Yes</option><option ${prop.hm === 'No' ? 'selected' : ''}>No</option></select></div>
         </div>
         <div class="form-group"><label class="form-label">SEO Assignee</label>
           <select class="form-select" id="p-seo-assignee">
             <option value="">— None —</option>
             ${S.users.map(u => `<option value="${u.name}" ${prop.seoAssignee === u.name ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
           </select></div>
         <div class="form-group"><label class="form-label">Web Assignee</label>
           <select class="form-select" id="p-web-assignee">
             <option value="">— None —</option>
             ${S.users.map(u => `<option value="${u.name}" ${prop.webAssignee === u.name ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
           </select></div>`,
        [
          { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
          {
            label: 'Save', cls: 'btn btn-primary', onClick: async () => {
              try {
                const seoName = $('p-seo-assignee').value;
                const webName = $('p-web-assignee').value;
                const seoUser = S.users.find(u => u.name === seoName);
                const webUser = S.users.find(u => u.name === webName);
                await PUT(`/api/master/properties/${prop.id}`, {
                  name: $('p-name').value,
                  url: $('p-url').value,
                  type: $('p-type').value,
                  status: $('p-status').value,
                  seo: $('p-seo').value,
                  hm: $('p-hm').value,
                  seoAssignee: seoName,
                  seoAssigneeId: seoUser?.id || null,
                  webAssignee: webName,
                  webAssigneeId: webUser?.id || null,
                });
                toast('Property updated', 'success'); closeModal(); navigate('properties');
              } catch (e) { toast(e.message, 'error'); }
            }
          },
        ]
      );
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: DEV TRACKER & FEEDBACK WORK LOG (Brand Guidelines & Bulk Sitemap)
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: parse pasted text, XML sitemaps, or lists into clean deduplicated URLs
function parsePastedSitemapUrls(text) {
  if (!text) return [];
  const urls = [];
  const locRegex = /<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(text)) !== null) {
    if (match[1]) urls.push(match[1].trim());
  }
  if (urls.length > 0) {
    return [...new Set(urls)];
  }

  const lines = text.split(/[\r\n,]+/);
  for (let l of lines) {
    l = l.trim();
    if (!l) continue;
    const urlMatch = l.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
      urls.push(urlMatch[0].trim());
    } else if (l.startsWith('/') || (l.includes('.') && !l.includes(' '))) {
      urls.push(l);
    }
  }
  return [...new Set(urls)];
}

async function viewDevProjects() {
  setPage('Dev Tracker & Feedback Log', 'Website sitemaps, client feedback rounds, and live work updates');

  const SHEET_URL = 'https://docs.google.com/spreadsheets/d/14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78/edit?gid=0#gid=0';
  let projects = [];
  let activeIdx = 0;
  let activeSubTab = 'feedback'; // 'feedback' | 'sitemap' | 'sheet'
  let sitemapSearch = '';

  async function loadData(fresh = false) {
    try {
      const url = fresh ? '/api/master/dev-projects?fresh=true' : '/api/master/dev-projects';
      const data = await GET(url);
      projects = data.projects || [];
    } catch (e) {
      toast('Failed to load dev projects: ' + e.message, 'error');
    }
  }

  await loadData();

  if (!projects.length) {
    mainEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💻</div>
        <h3>No Dev Projects Found</h3>
        <p>You can create a new website project or fetch live tabs from your Google Sheet.</p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px">
          <button class="btn btn-primary" id="btn-create-first-proj">➕ Create New Website</button>
          <button class="btn btn-secondary" id="btn-initial-fetch">🔄 Fetch from Google Sheets</button>
        </div>
      </div>`;
    $('btn-create-first-proj')?.addEventListener('click', () => openCreateWebsiteModal());
    $('btn-initial-fetch')?.addEventListener('click', async () => {
      toast('Connecting to Google Sheet...', 'info');
      await POST('/api/master/dev-projects/fetch-live');
      await loadData();
      render();
    });
    return;
  }

  function render() {
    const proj = projects[activeIdx] || projects[0];
    const items = proj.items || [];

    // Categorize items
    const sitemapItems = items.filter(it => it.url && !it.isHeader);

    // Group items into feedback rounds
    const feedbackGroupsMap = new Map();
    items.forEach((it, origIdx) => {
      const g = it.feedbackGroup || 'General';
      if (!feedbackGroupsMap.has(g)) {
        feedbackGroupsMap.set(g, []);
      }
      feedbackGroupsMap.get(g).push({ ...it, origIdx });
    });

    // Extract sorted feedback rounds (newest / highest round first)
    const feedbackRounds = Array.from(feedbackGroupsMap.entries()).map(([groupName, groupItems]) => {
      const docLink = groupItems.find(it => it.feedbackUrl && it.feedbackUrl.startsWith('http'))?.feedbackUrl || '';
      const dates = groupItems.map(it => it.date).filter(Boolean);
      const primaryDate = dates[0] || '';
      const statuses = groupItems.map(it => it.status).filter(Boolean);
      const isCompleted = statuses.length > 0 && statuses.every(s => s.toLowerCase() === 'completed');
      const hasInProgress = statuses.some(s => s.toLowerCase() === 'in_progress');
      const roundStatus = isCompleted ? 'Completed' : (hasInProgress ? 'In Progress' : (statuses[0] || 'Pending'));

      const workEntries = groupItems.filter(it => it.notes && it.notes.trim().length > 0);
      // Development-Date / Development-Updates live in sheet columns C/D and are
      // NOT part of the feedback round's comment log (which is F/G). A single
      // sheet row can carry both, so they are collected separately and always
      // rendered — otherwise the two Development columns a user adds by hand
      // never appear anywhere in the dashboard.
      const devEntries = groupItems.filter(it => it.devNotes && it.devNotes.trim().length > 0);

      return {
        name: groupName,
        docLink,
        primaryDate,
        status: roundStatus,
        items: groupItems,
        workEntries,
        devEntries,
      };
    }).reverse();

    const totalPages = sitemapItems.length;
    const completedPages = sitemapItems.filter(p => (p.status || '').toLowerCase() === 'completed').length;
    const latestFeedback = feedbackRounds[0];

    mainEl.innerHTML = `
      <div class="fade-in">
        <!-- Top Action Bar -->
        <div class="dev-header-actions">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" id="btn-new-feedback">
              <span>➕ Log New Feedback</span>
            </button>
            <button class="btn btn-secondary" id="btn-create-website">
              <span>🚀 New Website Project</span>
            </button>
            <button class="btn btn-secondary" id="btn-top-import-sitemap">
              <span>📋 Paste Sitemap</span>
            </button>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span class="dev-sync-tag" title="Connected to Google Sheet ID: 14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78">
              Live Google Sheets Sync
            </span>
            <button class="btn btn-secondary btn-sm" id="btn-dev-refresh" title="Pull fresh updates directly from Google Sheets">
              <span id="refresh-icon">🔄</span> Refresh Sheet
            </button>
            <a class="dev-sheet-link-btn" href="${SHEET_URL}" target="_blank" title="Open Google Sheet in new tab">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
              Open Sheet ↗
            </a>
          </div>
        </div>

        <!-- Project Selector Pills -->
        <div class="dev-project-pills">
          ${projects.map((p, i) => {
      const pageCount = (p.items || []).filter(it => it.url && !it.isHeader).length;
      return `
              <button class="dev-project-pill ${i === activeIdx ? 'active' : ''}" data-idx="${i}">
                <span>💻 ${esc(p.project)}</span>
                <span class="dev-pill-badge">${pageCount} pages</span>
              </button>`;
    }).join('')}
          <button class="btn btn-ghost btn-sm" id="btn-pill-add-website" style="align-self:center;margin-left:4px" title="Create new website project">
            + New Site
          </button>
        </div>

        <!-- Stats Overview Cards -->
        <div class="dev-stats-row">
          <div class="dev-stat-card">
            <div class="dev-stat-val">${totalPages}</div>
            <div class="dev-stat-label">Sitemap Pages (${completedPages} Completed)</div>
          </div>
          <div class="dev-stat-card">
            <div class="dev-stat-val">${feedbackRounds.length}</div>
            <div class="dev-stat-label">Feedback Rounds</div>
          </div>
          <div class="dev-stat-card">
            <div class="dev-stat-val" style="font-size:16px;padding-top:4px">${esc(latestFeedback?.primaryDate || 'None')}</div>
            <div class="dev-stat-label">Latest Feedback Date (${esc(latestFeedback?.name || '—')})</div>
          </div>
          <div class="dev-stat-card">
            <div class="dev-stat-val" style="color:var(--success)">
              ${Math.round((completedPages / (totalPages || 1)) * 100)}%
            </div>
            <div class="dev-stat-label">Website Readiness</div>
          </div>
        </div>

        <!-- Sub-View Tabs -->
        <div class="dev-subnav-tabs">
          <button class="dev-subnav-btn ${activeSubTab === 'feedback' ? 'active' : ''}" data-subtab="feedback">
            💬 Feedback & Work Log (${feedbackRounds.length})
          </button>
          <button class="dev-subnav-btn ${activeSubTab === 'sitemap' ? 'active' : ''}" data-subtab="sitemap">
            🗺️ Website Sitemap / Pages (${totalPages})
          </button>
          <button class="dev-subnav-btn ${activeSubTab === 'sheet' ? 'active' : ''}" data-subtab="sheet">
            📊 Full Sheet Grid (${items.length} rows)
          </button>
        </div>

        <!-- Sub-View Content -->
        <div id="dev-subtab-container">
          ${renderSubTabContent(proj, items, sitemapItems, feedbackRounds)}
        </div>
      </div>`;

    attachEventListeners(proj, feedbackRounds);
  }

  function renderSubTabContent(proj, items, sitemapItems, feedbackRounds) {
    if (activeSubTab === 'feedback') {
      if (!feedbackRounds.length) {
        return `
          <div class="card" style="text-align:center;padding:40px 20px">
            <div style="font-size:32px;margin-bottom:12px">💬</div>
            <h3 style="margin-bottom:8px;font-family:var(--font-heading)">No Feedback Logged Yet</h3>
            <p style="color:var(--text-muted);font-size:13px;max-width:420px;margin:0 auto 18px">
              When client sends feedback via email or Google Docs, click below to record the arrival date, doc link, and work notes.
            </p>
            <button class="btn btn-primary" id="btn-empty-feedback">
              ➕ Log First Feedback Round
            </button>
          </div>`;
      }

      return `
        <div class="feedback-rounds-container">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <div style="font-size:12px;color:var(--text-muted)">
              Showing all feedback rounds for <strong>${esc(proj.project)}</strong>. Every comment and status change is saved directly to Google Sheets.
            </div>
            <button class="btn btn-primary btn-sm" id="btn-add-fb-top">
              ➕ Log New Feedback
            </button>
          </div>

          ${feedbackRounds.map(round => `
            <div class="feedback-round-card">
              <!-- Header -->
              <div class="feedback-round-header">
                <div class="feedback-round-title-row">
                  <div class="feedback-round-title">
                    <span>💬</span>
                    <span>${esc(round.name)}</span>
                  </div>
                  <span class="badge badge-dim" style="font-size:11px">
                    📅 Arrived: ${esc(round.primaryDate || 'Date not set')}
                  </span>
                  ${statusBadge(round.status)}
                </div>

                <div class="feedback-round-actions">
                  ${round.docLink ? `
                    <a href="${esc(round.docLink)}" target="_blank" class="btn btn-secondary btn-sm" style="display:inline-flex;align-items:center;gap:6px">
                      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                      Open Doc ↗
                    </a>` : ''}
                  <button class="btn btn-secondary btn-sm btn-card-add-work" data-round="${esc(round.name)}">
                    💬 + Add Work Comment
                  </button>
                </div>
              </div>

              <!-- Work Updates & Comments List -->
              <div class="feedback-work-list">
                ${round.workEntries.length > 0 ? round.workEntries.map(entry => `
                  <div class="feedback-work-entry">
                    <div class="feedback-work-entry-top">
                      <div class="feedback-work-meta">
                        <span style="font-weight:600;color:var(--text-primary)">📅 ${esc(entry.date || 'No date')}</span>
                        <span>•</span>
                        <span>${statusBadge(entry.status)}</span>
                        ${entry.url ? `<span class="url-cell" style="font-size:11px"><a href="${esc(entry.url)}" target="_blank">${esc(shortUrl(entry.url, 28))}</a></span>` : ''}
                      </div>
                      <div style="display:flex;align-items:center;gap:6px">
                        <span class="dev-sync-tag" style="font-size:10px;padding:1px 6px">Synced (Row ${entry.rowNum || entry.origIdx + 2})</span>
                        <button class="btn btn-ghost btn-sm btn-edit-entry" data-orig-idx="${entry.origIdx}" title="Edit note or status">✏️</button>
                      </div>
                    </div>
                    <div class="feedback-work-note">${esc(entry.notes)}</div>
                  </div>
                `).join('') : `
                  <div style="padding:14px 18px;background:var(--bg-surface-2);border-radius:var(--radius-sm);border:1px dashed var(--border);color:var(--text-muted);font-size:13px;display:flex;justify-content:space-between;align-items:center">
                    <span>No work comments logged for this feedback round yet.</span>
                    <button class="btn btn-secondary btn-sm btn-card-add-work" data-round="${esc(round.name)}">
                      💬 Record Work Done
                    </button>
                  </div>
                `}
              </div>

              ${(round.devEntries || []).length > 0 ? `
                <div class="feedback-work-list" style="border-top:1px dashed var(--border)">
                  <div style="padding:12px 18px 0;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text-muted)">
                    🛠 Development Updates <span style="font-weight:400;text-transform:none">(sheet columns C &amp; D)</span>
                  </div>
                  ${(round.devEntries || []).map(entry => `
                    <div class="feedback-work-entry">
                      <div class="feedback-work-entry-top">
                        <div class="feedback-work-meta">
                          <span style="font-weight:600;color:var(--text-primary)">📅 ${esc(entry.devDate || 'No date')}</span>
                          <span>•</span>
                          <span class="badge badge-dim" style="font-size:10px">Development</span>
                          ${entry.url ? `<span class="url-cell" style="font-size:11px"><a href="${esc(entry.url)}" target="_blank">${esc(shortUrl(entry.url, 28))}</a></span>` : ''}
                        </div>
                        <div style="display:flex;align-items:center;gap:6px">
                          <span class="dev-sync-tag" style="font-size:10px;padding:1px 6px">Synced (Row ${entry.rowNum || entry.origIdx + 2})</span>
                          <button class="btn btn-ghost btn-sm btn-edit-entry" data-orig-idx="${entry.origIdx}" title="Edit development date / notes">✏️</button>
                        </div>
                      </div>
                      <div class="feedback-work-note">${esc(entry.devNotes)}</div>
                    </div>
                  `).join('')}
                </div>` : ''}
            </div>
          `).join('')}
        </div>`;
    }

    if (activeSubTab === 'sitemap') {
      const filtered = sitemapItems.filter(p => {
        if (!sitemapSearch) return true;
        const q = sitemapSearch.toLowerCase();
        return (p.url || '').toLowerCase().includes(q)
          || (p.notes || '').toLowerCase().includes(q)
          || (p.devNotes || '').toLowerCase().includes(q)
          || (p.devDate || '').toLowerCase().includes(q)
          || (p.status || '').toLowerCase().includes(q);
      });

      return `
        <div class="card">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="card-title">🗺️ Website Sitemap (${sitemapItems.length} pages)</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <div class="search-bar" style="max-width:220px">
                <input id="sitemap-search-input" class="search-input" placeholder="Search pages…" value="${esc(sitemapSearch)}">
              </div>
              <button class="btn btn-primary btn-sm" id="btn-sitemap-bulk-import">
                📋 Paste / Bulk Import
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-sitemap-add-page">
                ➕ Add Page
              </button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="table-smart-fit">
              <thead>
                <tr>
                  <th style="width:40px">#</th>
                  <th>Page URL</th>
                  <th>Preview</th>
                  <th style="width:160px">Status</th>
                  <th style="width:190px">🛠 Development Update (Col C/D)</th>
                  <th>Feedback Notes (Col G)</th>
                  <th style="width:70px;text-align:center">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.length ? filtered.map((item, localIdx) => {
        const origIdx = items.indexOf(item);
        return `
                    <tr>
                      <td style="color:var(--text-muted);font-size:11px">${localIdx + 1}</td>
                      <td style="font-weight:500;font-family:var(--font-mono);font-size:12px;color:var(--text-primary)">
                        ${esc(item.url)}
                      </td>
                      <td>
                        <a href="${esc(item.url)}" target="_blank" class="btn btn-ghost btn-sm" style="padding:3px 7px;font-size:11px" title="Open page">
                          Open ↗
                        </a>
                      </td>
                      <td>
                        <select class="form-select sitemap-status-select" data-orig-idx="${origIdx}" style="padding:4px 8px;font-size:12px;height:28px">
                          ${['todo', 'in_progress', 'completed', 'review', 'blocked'].map(s => `
                            <option value="${s}" ${(item.status || '').toLowerCase() === s.toLowerCase() ? 'selected' : ''}>
                              ${s === 'completed' ? '🟢 Completed' : (s === 'in_progress' ? '🟡 In Progress' : (s === 'review' ? '🔵 Review' : '⚪ ' + s))}
                            </option>
                          `).join('')}
                        </select>
                      </td>
                      <td style="font-size:12px;color:var(--text-muted);max-width:240px">
                        ${item.devNotes ? `
                          <div style="font-size:11px;color:var(--text-secondary);font-weight:600">${esc(item.devDate || 'No date')}</div>
                          <div title="${esc(item.devNotes)}">${esc(item.devNotes)}</div>
                        ` : '<span style="color:var(--text-muted)">—</span>'}
                      </td>
                      <td style="font-size:12px;color:var(--text-muted);max-width:240px" title="${esc(item.notes || '')}">
                        ${esc(item.notes || '—')}
                      </td>
                      <td style="text-align:center">
                        <button class="btn btn-ghost btn-sm btn-edit-entry" data-orig-idx="${origIdx}" title="Edit page details">
                          ✏️
                        </button>
                      </td>
                    </tr>`;
      }).join('') : `
                  <tr>
                    <td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted)">
                      No sitemap pages found. Click <strong>"📋 Paste / Bulk Import"</strong> to paste your website's sitemap URLs.
                    </td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>
        </div>`;
    }

    if (activeSubTab === 'sheet') {
      // Columns are resolved from the tab's OWN header row (server-side:
      // tabSchema.js), so this table renders whatever the sheet actually has —
      // 5 columns, 7 columns, or 9 after someone adds two by hand. Nothing here
      // is hardcoded to A:G any more.
      const sheetCols = proj.columns || {};
      const extras = proj.extraColumns || sheetCols.extras || [];
      const colLetter = (i) => (typeof i === 'number' && i >= 0 && i < 26 ? String.fromCharCode(65 + i) : '?');
      const baseCols = [
        { key: 'url', label: 'URL / Page', index: typeof sheetCols.url === 'number' ? sheetCols.url : 0 },
        { key: 'status', label: 'Status', index: typeof sheetCols.status === 'number' ? sheetCols.status : 1 },
        { key: 'devDate', label: 'Development Date', index: sheetCols.devDate },
        { key: 'devNotes', label: 'Development Updates', index: sheetCols.devNotes },
        { key: 'feedbackUrl', label: 'Feedback URL', index: sheetCols.feedbackUrl },
        { key: 'date', label: 'Feedback Date', index: sheetCols.date },
        { key: 'notes', label: 'Feedback Notes', index: sheetCols.notes },
      ].filter(c => typeof c.index === 'number' && c.index >= 0);
      const sheetTableCols = [
        ...baseCols,
        ...extras.map(e => ({ key: e.key, label: e.label || e.key, index: e.index, kind: e.kind, extra: true })),
      ].sort((a, b) => a.index - b.index);
      const cellValue = (item, c) => String((c.extra ? (item.extra || {})[c.key] : item[c.key]) || '');
      const sheetCell = (item, c) => {
        const raw = cellValue(item, c);
        if (c.key === 'url') {
          return `<td class="url-cell">${raw ? `<a href="${esc(raw)}" target="_blank">${esc(shortUrl(raw, 40))}</a>` : '<span style="color:var(--text-muted)">&#8212;</span>'}</td>`;
        }
        if (c.key === 'status') return `<td>${statusBadge(item.status)}</td>`;
        if (c.key === 'feedbackUrl') {
          return `<td style="font-size:11px">${raw ? (raw.startsWith('http') ? `<a href="${esc(raw)}" target="_blank" class="btn btn-ghost btn-sm" style="padding:2px 6px">View Doc &#8599;</a>` : esc(raw)) : '&#8212;'}</td>`;
        }
        const badge = c.extra && raw ? ' <span class="badge" style="font-size:9.5px">custom</span>' : '';
        return `<td style="font-size:12px;color:var(--text-secondary);max-width:250px" title="${esc(raw)}">${esc(raw || '-')}${badge}</td>`;
      };
      return `
        <div class="card">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <span class="card-title">📊 Google Sheet Tab: ${esc(proj.project)}</span>
            <div style="display:flex;align-items:center;gap:10px">
              <span class="dev-sync-tag">1:1 Row Level Sync</span>
              <a href="${SHEET_URL}" target="_blank" class="btn btn-secondary btn-sm">Open in Sheets ↗</a>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:50px">Row</th>
                  ${sheetTableCols.map(c => `<th${c.extra ? ' title="Column added to the sheet by hand — understood automatically"' : ''}>Col ${colLetter(c.index)}: ${esc(c.label)}</th>`).join('')}
                  <th style="width:60px">Edit</th>
                </tr>
              </thead>
              <tbody>
                ${items.map((item, idx) => `
                  <tr style="${item.isHeader ? 'background:rgba(37,99,235,0.06);font-weight:600' : ''}">
                    <td style="color:var(--text-muted);font-size:11px">${item.rowNum || idx + 2}</td>
                    ${sheetTableCols.map(c => sheetCell(item, c)).join('')}
                    <td>
                      <button class="btn btn-ghost btn-sm btn-edit-entry" data-orig-idx="${idx}">&#9998;</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          ${extras.length ? `<div style="font-size:11px;color:var(--text-muted);padding:8px 4px">
            Custom column${extras.length === 1 ? '' : 's'} detected from this tab's header row (${esc(extras.map(e => e.label).join(', '))}) — read, editable and answerable by the assistant automatically.
          </div>` : ''}
        </div>`;
    }

    return '';
  }

  function attachEventListeners(proj, feedbackRounds) {
    mainEl.querySelectorAll('.dev-project-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        activeIdx = parseInt(btn.dataset.idx, 10);
        render();
      });
    });

    mainEl.querySelectorAll('.dev-subnav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeSubTab = btn.dataset.subtab;
        render();
      });
    });

    const searchInput = $('sitemap-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        sitemapSearch = e.target.value;
        const container = $('dev-subtab-container');
        if (container) {
          const sitemapItems = (proj.items || []).filter(it => it.url && !it.isHeader);
          container.innerHTML = renderSubTabContent(proj, proj.items || [], sitemapItems, feedbackRounds);
          attachEventListeners(proj, feedbackRounds);
        }
      });
    }

    $('btn-dev-refresh')?.addEventListener('click', async () => {
      const icon = $('refresh-icon');
      if (icon) icon.classList.add('rotating');
      toast('Pulling latest updates directly from Google Sheets...', 'info');
      try {
        await POST('/api/master/dev-projects/fetch-live');
        await loadData(true);
        toast('Google Sheets sync complete!', 'success');
        render();
      } catch (e) {
        toast('Failed to refresh from Sheet: ' + e.message, 'error');
      } finally {
        if (icon) icon.classList.remove('rotating');
      }
    });

    // New Feedback button
    const triggerNewFeedback = () => openNewFeedbackModal(proj, feedbackRounds);
    $('btn-new-feedback')?.addEventListener('click', triggerNewFeedback);
    $('btn-add-fb-top')?.addEventListener('click', triggerNewFeedback);
    $('btn-empty-feedback')?.addEventListener('click', triggerNewFeedback);

    // Create New Website
    const triggerNewWebsite = () => openCreateWebsiteModal();
    $('btn-create-website')?.addEventListener('click', triggerNewWebsite);
    $('btn-pill-add-website')?.addEventListener('click', triggerNewWebsite);

    // Bulk Sitemap Import
    const triggerBulkSitemap = () => openBulkSitemapModal(proj);
    $('btn-top-import-sitemap')?.addEventListener('click', triggerBulkSitemap);
    $('btn-sitemap-bulk-import')?.addEventListener('click', triggerBulkSitemap);

    // Single Add Page
    const triggerAddPage = () => openAddPageModal(proj);
    $('btn-add-page')?.addEventListener('click', triggerAddPage);
    $('btn-sitemap-add-page')?.addEventListener('click', triggerAddPage);

    mainEl.querySelectorAll('.btn-card-add-work').forEach(btn => {
      btn.addEventListener('click', () => {
        const roundName = btn.dataset.round;
        openAddWorkCommentModal(proj, roundName);
      });
    });

    mainEl.querySelectorAll('.btn-edit-entry').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.origIdx, 10);
        const item = (proj.items || [])[idx];
        if (item) openEditItemModal(proj, item, idx);
      });
    });

    mainEl.querySelectorAll('.sitemap-status-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const idx = parseInt(sel.dataset.origIdx, 10);
        const newStatus = sel.value;
        const item = (proj.items || [])[idx];
        if (!item) return;

        try {
          await PUT(`/api/master/dev-projects/${proj.id}/items/${idx}`, {
            status: newStatus,
          });
          item.status = newStatus;
          toast(`Updated "${shortUrl(item.url, 25)}" status to ${newStatus} & synced to Google Sheet!`, 'success', 2500);
        } catch (e) {
          toast('Failed to update status: ' + e.message, 'error');
        }
      });
    });
  }

  // ── Modal: Create New Website Project with Sitemap & Feedback ──
  function openCreateWebsiteModal() {
    const today = new Date().toISOString().split('T')[0];

    openModal('🚀 Create New Website Project',
      `<div class="form-group">
         <label class="form-label">Website / Project Name *</label>
         <input class="form-input" id="cwp-name" placeholder="e.g. Acme Corp or Sunshine Dental">
         <span style="font-size:11px;color:var(--text-muted)">Will create a dedicated tab in your Google Sheet</span>
       </div>
       <div class="form-group">
         <label class="form-label">Copy &amp; Paste Sitemap URLs (XML or Links)</label>
         <textarea class="sitemap-import-textarea" id="cwp-sitemap" rows="5" placeholder="Paste full XML sitemap or list of URLs copied from browser/text..."></textarea>
         <div id="cwp-counter-badge" class="sitemap-detected-badge" style="display:none;margin-top:6px">
           Detected 0 URLs
         </div>
       </div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
         <div class="form-group">
           <label class="form-label">Feedback Source / Google Doc</label>
           <input class="form-input" id="cwp-fb-url" placeholder="https://docs.google.com/document/d/...">
         </div>
         <div class="form-group">
           <label class="form-label">Date Arrived</label>
           <input class="form-input" id="cwp-date" type="date" value="${today}">
         </div>
       </div>
       <div class="form-group">
         <label class="form-label">Initial Notes / Scope</label>
         <textarea class="form-textarea" id="cwp-notes" rows="2" placeholder="Initial requirements, design phase, or client requests..."></textarea>
       </div>`,
      [
        { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
        {
          label: 'Create Website & Sync to Google Sheet',
          cls: 'btn btn-primary',
          onClick: async () => {
            const projectName = $('cwp-name')?.value.trim();
            if (!projectName) {
              toast('Website project name is required', 'warning');
              return;
            }
            const sitemapText = $('cwp-sitemap')?.value || '';
            const urls = parsePastedSitemapUrls(sitemapText);
            const feedbackUrl = $('cwp-fb-url')?.value.trim() || '';
            const date = $('cwp-date')?.value || today;
            const notes = $('cwp-notes')?.value.trim() || '';

            try {
              toast('Creating project tab and saving sitemap to Google Sheet...', 'info');
              await POST('/api/master/dev-projects/create-project', {
                projectName,
                urls,
                feedbackUrl,
                date,
                notes,
                status: 'todo',
              });
              closeModal();
              toast(`✅ Website "${projectName}" created with ${urls.length} sitemap pages in Google Sheets!`, 'success');
              await loadData(true);
              activeIdx = projects.findIndex(p => p.project.toLowerCase() === projectName.toLowerCase());
              if (activeIdx === -1) activeIdx = projects.length - 1;
              activeSubTab = urls.length ? 'sitemap' : 'feedback';
              render();
            } catch (e) {
              toast('Failed to create project: ' + e.message, 'error');
            }
          },
        },
      ]
    );

    // Live URL counter listener
    $('cwp-sitemap')?.addEventListener('input', (e) => {
      const detected = parsePastedSitemapUrls(e.target.value);
      const badge = $('cwp-counter-badge');
      if (badge) {
        if (detected.length > 0) {
          badge.style.display = 'inline-flex';
          badge.textContent = `🟢 Detected ${detected.length} valid URLs`;
        } else {
          badge.style.display = 'none';
        }
      }
    });
  }

  // ── Modal: Bulk Import / Paste Sitemap into Existing Project ──
  function openBulkSitemapModal(proj) {
    openModal(`📋 Paste Sitemap into "${proj.project}"`,
      `<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
         Copy any sitemap (XML, list of URLs, or links from your browser) and paste below. They will be automatically extracted and appended to Google Sheets.
       </p>
       <div class="form-group">
         <label class="form-label">Paste Sitemap Content *</label>
         <textarea class="sitemap-import-textarea" id="bs-text" rows="6" placeholder="Paste XML sitemap (e.g. <loc>https://...</loc>) or plaintext URLs separated by newlines..."></textarea>
         <div id="bs-counter-badge" class="sitemap-detected-badge" style="display:none;margin-top:6px">
           Detected 0 URLs
         </div>
       </div>
       <div class="form-group">
         <label class="form-label">Initial Status for Imported Pages</label>
         <select class="form-select" id="bs-status">
           <option value="todo" selected>⚪ Todo</option>
           <option value="in_progress">🟡 In Progress</option>
           <option value="completed">🟢 Completed</option>
           <option value="review">🔵 Review</option>
         </select>
       </div>`,
      [
        { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
        {
          label: 'Import & Append to Google Sheet',
          cls: 'btn btn-primary',
          onClick: async () => {
            const text = $('bs-text')?.value || '';
            const urls = parsePastedSitemapUrls(text);
            if (!urls.length) {
              toast('No valid URLs detected in the pasted text', 'warning');
              return;
            }
            const status = $('bs-status')?.value || 'todo';

            try {
              toast(`Appending ${urls.length} URLs to Google Sheet "${proj.project}"...`, 'info');
              await POST(`/api/master/dev-projects/${proj.id}/bulk-sitemap`, {
                urls,
                status,
              });
              closeModal();
              toast(`✅ Successfully imported ${urls.length} pages into sitemap & Google Sheet!`, 'success');
              await loadData();
              activeSubTab = 'sitemap';
              render();
            } catch (e) {
              toast('Bulk import failed: ' + e.message, 'error');
            }
          },
        },
      ]
    );

    $('bs-text')?.addEventListener('input', (e) => {
      const detected = parsePastedSitemapUrls(e.target.value);
      const badge = $('bs-counter-badge');
      if (badge) {
        if (detected.length > 0) {
          badge.style.display = 'inline-flex';
          badge.textContent = `🟢 Detected ${detected.length} valid URLs`;
        } else {
          badge.style.display = 'none';
        }
      }
    });
  }

  // ── Modal: Log New Feedback Came In ──
  function openNewFeedbackModal(proj, feedbackRounds) {
    const today = new Date().toISOString().split('T')[0];
    const nextNum = feedbackRounds.length + 1;
    const defaultRoundName = `Feedback ${nextNum}`;

    openModal('➕ Log New Client Feedback',
      `<div class="form-group">
         <label class="form-label">Project</label>
         <input class="form-input" value="${esc(proj.project)}" disabled style="opacity:0.8">
       </div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
         <div class="form-group">
           <label class="form-label">Feedback Round / Title *</label>
           <input class="form-input" id="fb-round-name" value="${esc(defaultRoundName)}" placeholder="e.g. Feedback 4 or Client Email Rev 2">
         </div>
         <div class="form-group">
           <label class="form-label">Date Feedback Came In *</label>
           <input class="form-input" id="fb-date" type="date" value="${today}">
         </div>
       </div>
       <div class="form-group">
         <label class="form-label">Feedback Source / Google Doc Link</label>
         <input class="form-input" id="fb-url" placeholder="https://docs.google.com/document/d/... or Loom URL">
         <span style="font-size:11px;color:var(--text-muted);margin-top:4px;display:block">Paste Google Doc, client email link, or review document URL</span>
       </div>
       <div class="form-group">
         <label class="form-label">Initial Status</label>
         <select class="form-select" id="fb-status">
           <option value="todo" selected>⚪ Todo / New Feedback</option>
           <option value="in_progress">🟡 In Progress (Working on it)</option>
           <option value="review">🔵 Review (Waiting for client)</option>
           <option value="completed">🟢 Completed</option>
         </select>
       </div>
       <div class="form-group">
         <label class="form-label">Initial Work Notes / Details</label>
         <textarea class="form-textarea" id="fb-notes" rows="3" placeholder="Summary of what client requested or initial tasks to do..."></textarea>
       </div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
         <div class="form-group">
           <label class="form-label">🛠 Development Date (Col C)</label>
           <input class="form-input" id="fb-dev-date" type="date" value="${today}">
         </div>
         <div class="form-group">
           <label class="form-label">🛠 Development Notes (Col D)</label>
           <input class="form-input" id="fb-dev-notes" placeholder="Optional — what was built/changed">
         </div>
       </div>`,
      [
        { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
        {
          label: 'Save & Sync to Google Sheet',
          cls: 'btn btn-primary',
          onClick: async () => {
            const roundName = $('fb-round-name')?.value.trim() || defaultRoundName;
            const date = $('fb-date')?.value || today;
            const feedbackUrl = $('fb-url')?.value.trim() || '';
            const status = $('fb-status')?.value || 'todo';
            const notes = $('fb-notes')?.value.trim() || '';
            const devNotes = $('fb-dev-notes')?.value.trim() || '';
            const devDate = devNotes ? ($('fb-dev-date')?.value || today) : '';

            try {
              toast('Creating new feedback round & syncing to Google Sheet...', 'info');
              await POST(`/api/master/dev-projects/${proj.id}/feedback-round`, {
                feedbackGroup: roundName,
                feedbackUrl,
                date,
                notes,
                status,
                devDate,
                devNotes,
              });
              closeModal();
              toast(`✅ "${roundName}" logged & synced directly to Google Sheet!`, 'success');
              await loadData();
              activeSubTab = 'feedback';
              render();
            } catch (e) {
              toast('Error creating feedback: ' + e.message, 'error');
            }
          },
        },
      ]
    );
  }

  // ── Modal: Add Work Comment to a Feedback Round ──
  function openAddWorkCommentModal(proj, roundName) {
    const today = new Date().toISOString().split('T')[0];

    openModal(`💬 Add Work Comment to "${roundName}"`,
      `<div class="form-group">
         <label class="form-label">Feedback Round</label>
         <input class="form-input" value="${esc(roundName)}" disabled style="opacity:0.8">
       </div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
         <div class="form-group">
           <label class="form-label">Date Worked *</label>
           <input class="form-input" id="wc-date" type="date" value="${today}">
         </div>
         <div class="form-group">
           <label class="form-label">Status Update</label>
           <select class="form-select" id="wc-status">
             <option value="in_progress" selected>🟡 In Progress</option>
             <option value="completed">🟢 Completed</option>
             <option value="review">🔵 Review / Waiting</option>
             <option value="todo">⚪ Todo</option>
           </select>
         </div>
       </div>
       <div class="form-group">
         <label class="form-label">What Did You Work On? (Work Comment) *</label>
         <textarea class="form-textarea" id="wc-notes" rows="4" placeholder="Explain what you worked on, changes made, pages updated, or % progress..."></textarea>
       </div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
         <div class="form-group">
           <label class="form-label">🛠 Development Date (Col C)</label>
           <input class="form-input" id="wc-dev-date" type="date" value="${today}">
         </div>
         <div class="form-group">
           <label class="form-label">🛠 Development Notes (Col D)</label>
           <input class="form-input" id="wc-dev-notes" placeholder="Optional — e.g. All the pages are completed">
         </div>
       </div>                ${(() => {
          const extras = proj.extraColumns || (proj.columns && proj.columns.extras) || [];
          if (!extras.length) return '';
          return `<div class="form-group">
            <label class="form-label">Custom columns on this tab</label>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
              ${extras.map(e => `
                <div>
                  <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(e.label || e.key)} ${e.kind ? `<span class="badge" style="font-size:9.5px">${esc(e.kind)}</span>` : ''}</div>
                  <input class="form-input wc-extra" data-key="${esc(e.key)}" placeholder="${esc(e.label || e.key)}">
                </div>`).join('')}
            </div>
          </div>`;
        })()}`,

      [
        { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
        {
          label: 'Save Work Comment & Sync to Sheet',
          cls: 'btn btn-primary',
          onClick: async () => {
            const notes = $('wc-notes')?.value.trim();
            if (!notes) {
              toast('Please describe what you worked on', 'warning');
              return;
            }
            const date = $('wc-date')?.value || today;
            const status = $('wc-status')?.value || 'in_progress';
            const devNotes = $('wc-dev-notes')?.value.trim() || '';
            const devDate = devNotes ? ($('wc-dev-date')?.value || today) : '';
            // Hand-added columns of THIS tab — included so a custom column never
            // gets blanked when a new work comment row is appended.
            const extras = proj.extraColumns || (proj.columns && proj.columns.extras) || [];
            const extra = {};
            if (extras.length) {
              mainEl.querySelectorAll('.wc-extra').forEach(inp => { extra[inp.dataset.key] = inp.value ?? ''; });
            }

            try {
              toast('Saving comment & updating Google Sheet...', 'info');
              await POST(`/api/master/dev-projects/${proj.id}/items`, {
                feedbackGroup: roundName,
                date,
                status,
                notes,
                devDate,
                devNotes,
                extra,
              });
              closeModal();
              toast('✅ Work comment saved & updated in Google Sheet!', 'success');
              await loadData();
              render();
            } catch (e) {
              toast('Failed to save comment: ' + e.message, 'error');
            }
          },
        },
      ]
    );
  }

  // ── Modal: Edit Item / Work Note ──
  function openEditItemModal(proj, item, itemIdx) {
    const today = new Date().toISOString().split('T')[0];
    // Hand-added columns of THIS tab (auto-discovered from the sheet header) are
    // editable here too — they are written back to their own cells, so a custom
    // column never gets blanked by editing the row.
    const extras = proj.extraColumns || (proj.columns && proj.columns.extras) || [];
    const extraFieldsHtml = extras.length
      ? `<div class="form-group">
           <label class="form-label">Custom columns detected on this tab</label>
           <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
             ${extras.map(e => `
               <div>
                 <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${esc(e.label || e.key)} ${e.kind ? `<span class="badge" style="font-size:9.5px">${esc(e.kind)}</span>` : ''}</div>
                 <input class="form-input ei-extra" data-key="${esc(e.key)}" value="${esc((item.extra || {})[e.key] || '')}">
               </div>`).join('')}
           </div>
         </div>`
      : '';
    const collectExtras = () => {
      const out = { ...(item.extra || {}) };
      mainEl.querySelectorAll('.ei-extra').forEach(inp => { out[inp.dataset.key] = inp.value ?? ''; });
      return out;
    };

    openModal('✏️ Edit Item / Work Record',
      `<div class="form-group">
         <label class="form-label">Page URL / Identifier</label>
         <input class="form-input" id="ei-url" value="${esc(item.url || '')}" placeholder="Optional URL">
       </div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
         <div class="form-group">
           <label class="form-label">Status</label>
           <select class="form-select" id="ei-status">
             ${['todo', 'in_progress', 'completed', 'review', 'blocked'].map(s => `
               <option value="${s}" ${(item.status || '').toLowerCase() === s.toLowerCase() ? 'selected' : ''}>
                 ${s}
               </option>`).join('')}
           </select>
         </div>
         <div class="form-group">
           <label class="form-label">Feedback Date (Col F)</label>
           <input class="form-input" id="ei-date" type="date" value="${item.date || today}">
         </div>
       </div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
         <div class="form-group">
           <label class="form-label">🛠 Development Date (Col C)</label>
           <input class="form-input" id="ei-dev-date" type="date" value="${item.devDate || ''}">
         </div>
         <div class="form-group">
           <label class="form-label">🛠 Development Notes (Col D)</label>
           <input class="form-input" id="ei-dev-notes" value="${esc(item.devNotes || '')}" placeholder="e.g. All the pages are completed">
         </div>
       </div>
       <div class="form-group">
         <label class="form-label">Feedback Doc / URL (Col E)</label>
         <input class="form-input" id="ei-fb" value="${esc(item.feedbackUrl || '')}" placeholder="Google Doc or feedback link">
       </div>
       <div class="form-group">
         <label class="form-label">Feedback Work Notes / Comment (Col G)</label>
         <textarea class="form-textarea" id="ei-notes" rows="4">${esc(item.notes || '')}</textarea>
       </div>
       ${extraFieldsHtml}
       <div style="font-size:11px;color:var(--text-muted)">
         Row in Google Sheet: <strong>Row ${item.rowNum || itemIdx + 2}</strong> in Tab "${esc(proj.project)}"
       </div>`,
      [
        { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
        {
          label: 'Save & Update Google Sheet',
          cls: 'btn btn-primary',
          onClick: async () => {
            try {
              toast('Updating Google Sheet row...', 'info');
              await PUT(`/api/master/dev-projects/${proj.id}/items/${itemIdx}`, {
                url: $('ei-url')?.value.trim() || item.url,
                status: $('ei-status')?.value || item.status,
                devDate: $('ei-dev-date')?.value ?? item.devDate ?? '',
                devNotes: $('ei-dev-notes')?.value ?? item.devNotes ?? '',
                date: $('ei-date')?.value || item.date,
                feedbackUrl: $('ei-fb')?.value.trim() || item.feedbackUrl,
                notes: $('ei-notes')?.value || '',
                extra: collectExtras(),
              });
              closeModal();
              toast('✅ Saved & updated Google Sheet!', 'success');
              await loadData();
              render();
            } catch (e) {
              toast('Error updating: ' + e.message, 'error');
            }
          },
        },
      ]
    );
  }

  // ── Modal: Add Single Page to Sitemap ──
  function openAddPageModal(proj) {
    openModal(`🌐 Add Page to "${proj.project}" Sitemap`,
      `<div class="form-group">
         <label class="form-label">Page URL *</label>
         <input class="form-input" id="ap-url" placeholder="https://example.com/services/">
       </div>
       <div class="form-group">
         <label class="form-label">Initial Status</label>
         <select class="form-select" id="ap-status">
           <option value="todo" selected>⚪ Todo</option>
           <option value="in_progress">🟡 In Progress</option>
           <option value="completed">🟢 Completed</option>
           <option value="review">🔵 Review</option>
         </select>
       </div>
       <div class="form-group">
         <label class="form-label">Notes / Description</label>
         <textarea class="form-textarea" id="ap-notes" rows="2" placeholder="Optional notes about this page..."></textarea>
       </div>`,
      [
        { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
        {
          label: 'Add Page & Sync to Sheet',
          cls: 'btn btn-primary',
          onClick: async () => {
            const url = $('ap-url')?.value.trim();
            if (!url) {
              toast('Page URL is required', 'warning');
              return;
            }
            try {
              toast('Appending page to Google Sheet...', 'info');
              await POST(`/api/master/dev-projects/${proj.id}/items`, {
                url,
                status: $('ap-status')?.value || 'todo',
                notes: $('ap-notes')?.value.trim() || '',
              });
              closeModal();
              toast(`✅ Page added to sitemap and Google Sheet!`, 'success');
              await loadData();
              activeSubTab = 'sitemap';
              render();
            } catch (e) {
              toast('Failed to add page: ' + e.message, 'error');
            }
          },
        },
      ]
    );
  }

  render();
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
                <button class="btn btn-sm ${currentFilter === 'all' ? 'btn-primary' : 'btn-secondary'} filter-chip-btn" data-filter="all">All (${users.length})</button>
                <button class="btn btn-sm ${currentFilter === 'active' ? 'btn-primary' : 'btn-secondary'} filter-chip-btn" data-filter="active">Active (${activeCount})</button>
                <button class="btn btn-sm ${currentFilter === 'inactive' ? 'btn-primary' : 'btn-secondary'} filter-chip-btn" data-filter="inactive">Deactivated (${deactCount})</button>
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
                      <div class="user-avatar" style="width:26px;height:26px;font-size:11px;${!isActive ? 'filter:grayscale(1)' : ''}">${(u.name || 'U')[0].toUpperCase()}</div>
                      <div>
                        <div>${esc(u.name)}</div>
                        ${!isActive ? '<div style="font-size:10px;color:var(--danger);font-weight:500">Deactivated — excluded from Team Progress</div>' : ''}
                      </div>
                    </td>
                    <td><span class="badge badge-${u.role === 'superadmin' ? 'danger' : u.role === 'admin' ? 'warning' : 'info'}">${esc(u.role)}</span></td>
                    <td>
                      <span class="badge badge-${isActive ? 'success' : 'danger'}" style="font-size:11px;display:inline-flex;align-items:center;gap:4px">
                        ${isActive ? getSvg('check', 10) + ' Active' : getSvg('x', 10) + ' Deactivated'}
                      </span>
                    </td>
                    <td style="font-size:12px;color:var(--text-muted)">${esc(u.email || '—')}</td>
                    <td style="font-size:12px;font-weight:600">${userSites.length} ${userSites.length === 1 ? 'site' : 'sites'}</td>
                    <td style="font-size:11px;color:var(--text-dim)">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
                    <td style="text-align:right">
                      <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
                        <button class="btn btn-ghost btn-sm edit-user-btn" data-id="${u.id}" title="Edit User" style="display:inline-flex;align-items:center;gap:5px">${getSvg('edit', 12)} Edit</button>
                        <button class="btn btn-sm toggle-status-btn ${isActive ? 'btn-secondary' : 'btn-success'}" data-id="${u.id}" data-active="${!isActive}" title="${isActive ? 'Deactivate user (hide from Team Progress)' : 'Activate user (show in Team Progress)'}" style="display:inline-flex;align-items:center;gap:5px">
                          ${isActive ? getSvg('x', 12) + ' Deactivate' : getSvg('check', 12) + ' Activate'}
                        </button>
                        ${u.role !== 'superadmin' ? `<button class="btn btn-danger btn-sm del-user-btn" data-id="${u.id}" title="Delete User" style="display:inline-flex;align-items:center;justify-content:center">${getSvg('trash', 12)}</button>` : ''}
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
          { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
          {
            label: 'Create', cls: 'btn btn-primary', onClick: async () => {
              const name = $('nu-name').value.trim();
              if (!name) { toast('Name required', 'error'); return; }
              try {
                const { user } = await POST('/api/master/users', {
                  name,
                  role: $('nu-role').value,
                  email: $('nu-email').value,
                  active: $('nu-active').value === 'true',
                });
                users.push(user);
                S.users = users;
                toast(`User "${name}" created`, 'success'); closeModal(); render();
              } catch (e) { toast(e.message, 'error'); }
            }
          },
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
      const user = users.find(u => u.id === btn.dataset.id);
      if (!user) return;
      btn.addEventListener('click', () => {
        const isActive = user.active !== false;
        openModal(`Edit: ${user.name}`,
          `<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="eu-name" value="${esc(user.name)}"></div>
           <div class="form-group"><label class="form-label">Role</label>
             <select class="form-select" id="eu-role">
               <option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option>
               <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
               <option value="superadmin" ${user.role === 'superadmin' ? 'selected' : ''}>Superadmin</option>
             </select></div>
           <div class="form-group"><label class="form-label">Status</label>
             <select class="form-select" id="eu-active">
               <option value="true" ${isActive ? 'selected' : ''}>🟢 Active (Shown in Team Progress)</option>
               <option value="false" ${!isActive ? 'selected' : ''}>🔴 Deactivated (Hidden from Team Progress)</option>
             </select></div>
           <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="eu-email" type="email" value="${esc(user.email || '')}"></div>`,
          [
            { label: 'Cancel', cls: 'btn btn-secondary', onClick: closeModal },
            {
              label: 'Save', cls: 'btn btn-primary', onClick: async () => {
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
                  toast('User updated', 'success'); closeModal(); render();
                } catch (e) { toast(e.message, 'error'); }
              }
            },
          ]
        );
      });
    });

    // Delete user listener
    mainEl.querySelectorAll('.del-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const user = users.find(u => u.id === btn.dataset.id);
        if (!confirm(`Delete user "${user?.name}"?`)) return;
        try {
          await DELETE(`/api/master/users/${btn.dataset.id}`);
          users = users.filter(u => u.id !== btn.dataset.id);
          S.users = users;
          toast('User deleted', 'success'); render();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  render();
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: SEND EMAILS
// ═══════════════════════════════════════════════════════════════════════════════
function viewSendEmails() {
  setPage('Send Emails', 'Maintenance report mailer & client dispatch');
  mainEl.innerHTML = `
    <div class="fade-in" style="display:flex;flex-direction:column;height:calc(100vh - 125px);gap:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;background:var(--card-bg, #1a1f2c);padding:10px 18px;border-radius:10px;border:1px solid var(--border,#2d3748);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-size:20px">✉️</span>
          <div>
            <strong style="font-size:14px;color:var(--text,#fff);font-family:var(--font-heading,'Outfit',sans-serif)">Maintenance Mailer Console</strong>
            <span style="font-size:12px;color:var(--text-muted,#94a3b8);margin-left:8px">Preview reports, edit HTML, and send batch or single emails</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn btn-secondary btn-sm" id="reload-mailer-frame" title="Reload Mailer" style="padding:6px 12px;font-size:12px;cursor:pointer">
            🔄 Reload
          </button>
          <a href="/mailer" target="_blank" class="btn btn-primary btn-sm" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;padding:7px 14px;font-size:12px;font-weight:600">
            <span>Open in Full Tab</span>
            <span>↗</span>
          </a>
        </div>
      </div>
      <div style="flex:1;position:relative;min-height:500px;border-radius:12px;overflow:hidden;border:1px solid var(--border,#2d3748);box-shadow:0 8px 30px rgba(0,0,0,0.25)">
        <iframe id="mailer-iframe" src="/mailer" style="width:100%;height:100%;border:none;display:block;background:#0d1117"></iframe>
      </div>
    </div>`;

  $('reload-mailer-frame')?.addEventListener('click', () => {
    const frame = $('mailer-iframe');
    if (frame) {
      frame.src = '/mailer?t=' + Date.now();
      toast('Reloading mailer...', 'info', 1500);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW: SYNC FROM SHEETS (Superadmin)
// ═══════════════════════════════════════════════════════════════════════════════
async function viewSync() {
  setPage('Sync from Sheets', 'Import + merge all 6 Google Sheets');
  let status = {};
  try { status = await GET('/api/master/db-status'); } catch { }

  mainEl.innerHTML = `
    <div class="fade-in" style="max-width:660px;margin:0 auto">
      <div class="card">
        <div class="card-header"><span class="card-title">📊 Database Status</span></div>
        <div class="card-body">
          <div class="stat-grid" style="margin-bottom:0">
            <div class="stat-card ${status.initialised ? 'success' : 'warning'}">
              <div class="stat-value">${status.totalSites || 0}</div><div class="stat-label">Sites</div></div>
            <div class="stat-card info">
              <div class="stat-value">${status.totalDomains || 0}</div><div class="stat-label">Domains</div></div>
            <div class="stat-card accent">
              <div class="stat-value">${status.totalTasks || 0}</div><div class="stat-label">Tasks</div></div>
            <div class="stat-card purple">
              <div class="stat-value">${status.totalUsers || 0}</div><div class="stat-label">Users</div></div>
          </div>
          ${status.lastSync ? `<p style="margin-top:14px;font-size:12px;color:var(--text-muted)">Last synced: ${new Date(status.lastSync).toLocaleString()} (${status.syncDuration}s)</p>` : ''}
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
      const resp = await fetch('/api/master/sync', { method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' }, body: '{}' });
      const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
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
              const c = msg.counts || {};
              $('sync-result').innerHTML = `
                <div style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:16px;color:var(--success);font-size:13px">
                  ✅ Sync complete in ${msg.elapsed}s<br>
                  <span style="color:var(--text-muted);font-size:12px">
                    ${c.sites || 0} sites · ${c.dailyReviewRows || 0} daily rows · ${c.tasks || 0} tasks · ${c.properties || 0} properties · ${c.devProjects || 0} dev projects
                  </span>
                </div>`;
              btn.textContent = '🔄 Sync Again'; btn.disabled = false;
              $('sync-status').classList.remove('hidden'); $('sync-status-text').textContent = 'Synced just now';
            }
            if (msg.error) throw new Error(msg.error);
          } catch { }
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

// ─── Linear Keyboard Shortcuts (C for Create, F for Filter, / for Search) ───
document.addEventListener('keydown', (e) => {
  // If user is currently typing in an input or textarea, ignore single-key triggers
  const tag = (e.target.tagName || '').toUpperCase();
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;

  if (e.key === 'Escape') {
    closeModal();
    return;
  }

  if (isInput) return;

  if (e.key === 'c' || e.key === 'C') {
    const addSiteBtn = $('add-site-btn');
    if (addSiteBtn && !$('modal-overlay').classList.contains('hidden') === false) {
      e.preventDefault();
      addSiteBtn.click();
    }
  } else if (e.key === 'f' || e.key === 'F' || e.key === '/') {
    const searchInput = $('site-search') || $('cmd-input');
    if (searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select?.();
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHEET MANAGER — Dynamic Custom Google Sheets
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Build Connected Sheets Sidebar Navigation Section ───────────────────────
async function buildCustomSheetNav() {
  if (!S.role) return;
  try {
    const params = new URLSearchParams({
      role: S.role,
      userId: S.userId || '',
      userName: S.userName || '',
    });
    const res = await GET(`/api/master/sheet-credentials?${params}`);
    const items = (res.credentials || res.sheets || []).filter(s => s.active !== false);

    // Clean up any previously injected custom sheet nav items and old sections
    sidebarNavEl.querySelectorAll('.nav-item-custom-sheet').forEach(el => el.remove());
    sidebarNavEl.querySelector('.nav-section-custom-sheets')?.remove();

    if (!items.length) return;

    // Read persisted minimize state
    let isCollapsed = false;
    try {
      isCollapsed = localStorage.getItem('officeos_connected_sheets_collapsed') === 'true';
    } catch { }

    // Build the dedicated Connected Sheets section
    const secEl = document.createElement('div');
    secEl.className = `nav-section nav-section-custom-sheets ${isCollapsed ? 'is-collapsed' : ''}`;
    secEl.innerHTML = `
      <div class="nav-section-title nav-section-title-custom-sheets" title="Click to ${isCollapsed ? 'expand' : 'minimize'} Connected Sheets" style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:6px">
          <span class="nav-section-chevron" style="transform:${isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
          <span>Connected Sheets</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="badge badge-accent" style="font-size:9.5px;padding:2px 7px;border-radius:10px;text-transform:none;letter-spacing:0;font-weight:700">${items.length} Live</span>
          <button type="button" class="nav-section-minimize-btn" title="${isCollapsed ? 'Expand Connected Sheets' : 'Minimize Connected Sheets'}" aria-label="${isCollapsed ? 'Expand Connected Sheets' : 'Minimize Connected Sheets'}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              ${isCollapsed
        ? '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'
        : '<line x1="5" y1="12" x2="19" y2="12"/>'}
            </svg>
          </button>
        </div>
      </div>
      <div class="nav-section-items" style="${isCollapsed ? 'display:none;' : ''}"></div>
    `;
    const itemsContainer = secEl.querySelector('.nav-section-items');
    const headerTitleEl = secEl.querySelector('.nav-section-title-custom-sheets');
    const minBtn = secEl.querySelector('.nav-section-minimize-btn');
    const chevronEl = secEl.querySelector('.nav-section-chevron');

    function updateMinimizeState(collapsed) {
      isCollapsed = collapsed;
      secEl.classList.toggle('is-collapsed', isCollapsed);
      try {
        localStorage.setItem('officeos_connected_sheets_collapsed', isCollapsed);
      } catch { }

      if (isCollapsed) {
        itemsContainer.style.display = 'none';
        if (chevronEl) chevronEl.style.transform = 'rotate(-90deg)';
        if (minBtn) {
          minBtn.title = 'Expand Connected Sheets';
          minBtn.setAttribute('aria-label', 'Expand Connected Sheets');
          minBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        }
        if (headerTitleEl) headerTitleEl.title = 'Click to expand Connected Sheets';
      } else {
        itemsContainer.style.display = '';
        if (chevronEl) chevronEl.style.transform = 'rotate(0deg)';
        if (minBtn) {
          minBtn.title = 'Minimize Connected Sheets';
          minBtn.setAttribute('aria-label', 'Minimize Connected Sheets');
          minBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        }
        if (headerTitleEl) headerTitleEl.title = 'Click to minimize Connected Sheets';
      }
    }

    headerTitleEl.addEventListener('click', () => {
      updateMinimizeState(!secEl.classList.contains('is-collapsed'));
    });

    items.forEach(sh => {
      const itemEl = document.createElement('div');
      itemEl.className = `nav-item nav-item-custom-sheet ${S.view === 'custom-sheet-' + sh.id ? 'active' : ''}`;
      itemEl.dataset.view = `custom-sheet-${sh.id}`;
      itemEl.id = `nav-custom-sheet-${sh.id}`;
      itemEl.title = `${sh.title || sh.label} (Live Google Sheet)`;
      itemEl.innerHTML = `
        <span class="nav-icon" style="color:${esc(sh.color || '#38bdf8')}">${getNavSvg(sh.icon || 'custom-sheet')}</span>
        <span class="nav-label">${esc(sh.title || sh.label)}</span>
        <span class="nav-pill-badge" style="background:rgba(34,197,94,.15);color:#4ade80;font-size:9px">LIVE</span>
      `;
      itemEl.addEventListener('click', () => navigate(itemEl.dataset.view));
      itemsContainer.appendChild(itemEl);
    });

    if (S.role === 'superadmin' || S.role === 'admin') {
      const addSheetEl = document.createElement('div');
      addSheetEl.className = 'nav-item nav-item-custom-sheet nav-item-add-sheet';
      addSheetEl.title = 'Open Sheet Manager or connect a new Google Sheet';
      addSheetEl.style.opacity = '0.9';
      addSheetEl.innerHTML = `
        <span class="nav-icon" style="color:var(--accent)">${getSvg('plus', 13)}</span>
        <span class="nav-label" style="font-size:12px;color:var(--accent);font-weight:600">+ Connect Sheet</span>
      `;
      addSheetEl.addEventListener('click', () => {
        navigate('sheet-manager');
        setTimeout(() => $('btn-add-custom-sheet')?.click(), 150);
      });
      itemsContainer.appendChild(addSheetEl);
    }

    // Position Connected Sheets cleanly:
    // Place right after Operations or Workspace, before Administration or Team & Comms
    const sections = Array.from(sidebarNavEl.querySelectorAll('.nav-section'));
    const nextSec = sections.find(sec => {
      const t = sec.querySelector('.nav-section-title')?.textContent?.trim().toLowerCase() || '';
      return t.includes('admin') || t.includes('team');
    });

    if (nextSec) {
      sidebarNavEl.insertBefore(secEl, nextSec);
    } else {
      sidebarNavEl.appendChild(secEl);
    }
  } catch (err) {
    console.warn('[nav] failed to render connected sheets:', err);
  }
}

// ─── Sheet Manager & Credentials Hub (Superadmin) ─────────────────────────────
async function viewSheetManager() {
  if (S.role !== 'superadmin') {
    mainEl.innerHTML = '<div class="empty-state"><p>Access denied — Superadmin only</p></div>';
    return;
  }
  setPage('Sheet Manager', 'Google Sheets Integration & Operations Dashboard Manager');

  // Ensure S.users list is available for user assignment
  if (!S.users || !S.users.length) {
    try {
      const uRes = await GET('/api/master/users');
      S.users = uRes.users || [];
    } catch { }
  }

  let credsData = { credentials: [], serviceAccountEmail: null };
  try {
    credsData = await GET('/api/master/sheet-credentials?role=superadmin&manage=1');
  } catch (e1) {
    try {
      credsData = await GET('/api/master/custom-sheets?role=superadmin&manage=1');
    } catch (e2) {
      mainEl.innerHTML = `
        <div class="empty-state" style="padding:60px">
          ${getSvg('database', 36)}
          <h3 style="margin:16px 0 8px;font-size:16px">Failed to load sheet credentials</h3>
          <p style="color:var(--text-muted)">${esc(e2.message || e1.message)}</p>
          <button class="btn btn-primary btn-sm" id="retry-load-sheets-btn" style="margin-top:16px">Retry</button>
        </div>`;
      $('retry-load-sheets-btn')?.addEventListener('click', () => viewSheetManager());
      return;
    }
  }

  let credentials = credsData.credentials || [];
  const serviceAccountEmail = credsData.serviceAccountEmail;

  function render() {
    const totalCount = credentials.length;
    const activeCount = credentials.filter(c => c.active !== false).length;
    const reachableCount = credentials.filter(c => c.connectionStatus === 'ok').length;

    mainEl.innerHTML = `
      <div class="page-content" style="max-width:1200px">
        <!-- Hero Card -->
        <div class="sheet-manager-hero-card">
          <div class="sm-hero-header">
            <div class="sm-hero-title-group">
              <div class="sm-hero-icon-badge">${getSvg('database', 22)}</div>
              <div>
                <div class="sm-hero-title">Operations Sheet &amp; Credential Manager</div>
                <div class="sm-hero-subtitle">Connect Google Sheets directly into your <strong>OPERATIONS</strong> menu, assign team members, configure view/edit rights, and monitor live sync.</div>
              </div>
            </div>
            <div class="sm-hero-actions">
              <button class="btn btn-secondary btn-sm" id="sm-test-all-btn" style="display:inline-flex;align-items:center;gap:6px">
                ${getSvg('network', 13)} Test All Connections
              </button>
              <button class="btn btn-primary btn-sm" id="sm-sync-all-btn" style="display:inline-flex;align-items:center;gap:6px">
                ${getSvg('refresh', 13)} Sync All Sheets
              </button>
              <button class="btn btn-primary btn-sm" id="sm-add-sheet-btn" style="display:inline-flex;align-items:center;gap:6px">
                ${getSvg('plus', 13)} Add New Operations Sheet
              </button>
            </div>
          </div>

          <!-- Quick Metrics Strip -->
          <div class="sm-metric-strip">
            <div class="sm-metric-item">
              <span class="sm-metric-val" id="sm-metric-total">${totalCount}</span>
              <span class="sm-metric-lbl">Total Configured</span>
            </div>
            <div class="sm-metric-item">
              <span class="sm-metric-val text-success" id="sm-metric-active">${activeCount}</span>
              <span class="sm-metric-lbl">Active &amp; Synced</span>
            </div>
            <div class="sm-metric-item">
              <span class="sm-metric-val" id="sm-metric-reachable">${reachableCount}</span>
              <span class="sm-metric-lbl">Verified Reachable</span>
            </div>
            <div class="sm-metric-item">
              <span class="sm-metric-val"><span class="badge badge-success" style="font-size:11px">Google API Ready</span></span>
              <span class="sm-metric-lbl">Auth Engine</span>
            </div>
          </div>

          <!-- Service Account Principal Callout -->
          ${serviceAccountEmail ? `
            <div class="sm-sa-callout">
              <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
                <div class="sm-sa-icon">${getSvg('shield', 18)}</div>
                <div class="sm-sa-info" style="min-width:0">
                  <div class="sm-sa-label">Google Service Account Principal</div>
                  <div class="sm-sa-email-row">
                    <code id="sa-email-text" style="word-break:break-all">${esc(serviceAccountEmail)}</code>
                    <button class="btn btn-ghost btn-xs" id="copy-sa-btn" title="Copy email address" style="display:inline-flex;align-items:center;gap:4px">
                      ${getSvg('copy', 11)} Copy
                    </button>
                  </div>
                </div>
              </div>
              <div class="sm-sa-tip">
                Share every Google Sheet with this email with <strong>Viewer</strong> or <strong>Editor</strong> permission.
              </div>
            </div>
          ` : ''}
        </div>

        <!-- Sync Progress Banner (Hidden by default) -->
        <div id="sm-sync-banner" class="hidden sm-sync-banner">
          <div class="sm-sync-banner-header">
            <div class="sm-sync-banner-title" id="sm-sync-status-text">Starting synchronization from Google Sheets…</div>
            <span class="sm-sync-pct" id="sm-sync-pct-text">0%</span>
          </div>
          <div class="sm-progress-bar-track">
            <div class="sm-progress-bar-fill" id="sm-sync-progress-fill" style="width:0%"></div>
          </div>
        </div>

        <!-- Section Header -->
        <div class="sm-section-header">
          <div class="sm-section-title">${getSvg('layers', 15)} Operational Spreadsheets &amp; User Assignments</div>
          <div class="sm-section-sub">Configure which sheets appear under Operations, assign team members who can work on them, set view/edit rights, and toggle sync status.</div>
        </div>

        <!-- Credential Box Cards Grid -->
        <div class="sheet-manager-grid" id="sheet-credential-grid">
          ${credentials.map(c => `
            <div class="sheet-manager-card ${c.active === false ? 'is-inactive' : ''}" id="card-${c.id}" data-id="${c.id}">
              <div class="smc-card-top">
                <div class="smc-title-area">
                  <span class="smc-cat-pill">${esc(c.navSection || c.category || 'Operations')}</span>
                  <input class="smc-title-input" id="title-${c.id}" value="${esc(c.title || '')}" title="Click to rename sheet" placeholder="Sheet Title" />
                </div>
                <div class="smc-top-controls">
                  <label class="sm-toggle-label" title="Toggle active status (disabling hides from sidebar and skips during sync)">
                    <input type="checkbox" class="sm-active-toggle" data-id="${c.id}" ${c.active !== false ? 'checked' : ''} />
                    <span class="sm-toggle-text" id="toggle-txt-${c.id}">${c.active !== false ? 'Active' : 'Inactive'}</span>
                  </label>
                  <div class="sm-status-pill ${c.active === false ? 'inactive' : (c.connectionStatus === 'ok' ? 'online' : (c.connectionStatus === 'error' ? 'error' : 'pending'))}" id="status-pill-${c.id}">
                    <span class="live-network-icon ${c.active === false ? 'offline' : (c.connectionStatus === 'ok' ? 'online' : (c.connectionStatus === 'error' ? 'offline' : 'pending'))}" id="net-icon-${c.id}">
                      ${getSvg('network', 11)}
                    </span>
                    <span id="status-lbl-${c.id}">${c.active === false ? 'Inactive' : (c.connectionStatus === 'ok' ? 'Connected' : (c.connectionStatus === 'error' ? 'Error' : 'Untested'))}</span>
                  </div>
                </div>
              </div>

              <div class="smc-card-body">
                <div class="sm-field-group">
                  <label class="sm-field-label">Spreadsheet ID</label>
                  <div class="sm-input-with-actions">
                    <input class="form-input sm-id-input font-mono" id="sid-${c.id}" value="${esc(c.spreadsheetId || '')}" placeholder="Google Spreadsheet ID" spellcheck="false" />
                    <button class="btn btn-ghost btn-sm sm-action-icon copy-sid-btn" data-id="${c.id}" title="Copy Spreadsheet ID">
                      ${getSvg('copy', 13)}
                    </button>
                    <a href="https://docs.google.com/spreadsheets/d/${esc(c.spreadsheetId || '')}/edit" target="_blank" rel="noreferrer" class="btn btn-ghost btn-sm sm-action-icon" title="Open spreadsheet in Google Sheets">
                      ${getSvg('external', 13)}
                    </a>
                  </div>
                </div>

                <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
                  <div class="sm-field-group">
                    <label class="sm-field-label">Worksheet / Tab Name</label>
                    <input class="form-input sm-tab-input" id="tab-${c.id}" value="${esc(c.tabName || 'Sheet1')}" placeholder="e.g. Website List" />
                  </div>
                  <div class="sm-field-group">
                    <label class="sm-field-label">Header Row</label>
                    <input class="form-input font-mono" id="hrow-${c.id}" type="number" min="1" max="20" value="${c.headerRow || 1}" title="Row number containing column headers" />
                  </div>
                </div>

                <!-- Granular Role Permissions & User Assignment -->
                <div class="sm-role-box">
                  <div class="sm-role-box-title" style="justify-content:space-between">
                    <span style="display:inline-flex;align-items:center;gap:5px">${getSvg('shield', 11)} Access &amp; Assignment</span>
                    <span style="font-size:10.5px;color:var(--text-muted);text-transform:none">
                      Section: <strong>${esc(c.navSection || 'Operations')}</strong>
                    </span>
                  </div>

                  <div class="sm-role-row">
                    <span class="sm-role-label">Sidebar Section:</span>
                    <select class="form-select sm-sec-select" id="sec-${c.id}" data-id="${c.id}" style="font-size:11px;padding:2px 6px;height:24px;width:140px">
                      <option value="Operations" ${(c.navSection || 'Operations') === 'Operations' ? 'selected' : ''}>Operations (Default)</option>
                      <option value="Workspace" ${(c.navSection || 'Operations') === 'Workspace' ? 'selected' : ''}>Workspace</option>
                      <option value="Administration" ${(c.navSection || 'Operations') === 'Administration' ? 'selected' : ''}>Administration</option>
                    </select>
                  </div>

                  <div class="sm-role-row">
                    <span class="sm-role-label">Can View:</span>
                    <div class="sm-role-options">
                      ${['superadmin', 'admin', 'user'].map(r => `
                        <label class="sm-role-chk-label" title="Allow ${r} to see this sheet in the sidebar and view data">
                          <input type="checkbox" class="perm-chk perm-view-chk" data-id="${c.id}" data-role="${r}" value="${r}" ${(c.visibleTo || ['superadmin', 'admin', 'user']).includes(r) ? 'checked' : ''} />
                          <span>${r}</span>
                        </label>
                      `).join('')}
                    </div>
                  </div>

                  <div class="sm-role-row">
                    <span class="sm-role-label">Can Edit:</span>
                    <div class="sm-role-options">
                      ${['superadmin', 'admin', 'user'].map(r => `
                        <label class="sm-role-chk-label" title="Allow ${r} to edit cells, add rows, and add columns">
                          <input type="checkbox" class="perm-chk perm-edit-chk" data-id="${c.id}" data-role="${r}" value="${r}" ${(c.editableBy || ['superadmin', 'admin']).includes(r) ? 'checked' : ''} />
                          <span>${r}</span>
                        </label>
                      `).join('')}
                    </div>
                  </div>

                  <!-- Specific User Assignment -->
                  <div class="sm-role-row" style="padding-top:4px;border-top:1px solid rgba(255,255,255,0.03);margin-top:4px">
                    <span class="sm-role-label">Assigned Users:</span>
                    <div style="display:flex;align-items:center;gap:6px">
                      <span style="font-size:11.5px;color:var(--text-secondary)" id="assigned-lbl-${c.id}">
                        ${(c.assignedUsers && c.assignedUsers.length) ? `${c.assignedUsers.length} assigned member(s)` : 'All Permitted Users'}
                      </span>
                      <button class="btn btn-ghost btn-xs assign-users-btn" data-id="${c.id}" style="display:inline-flex;align-items:center;gap:4px">
                        ${getSvg('pencil', 10)} Assign Users
                      </button>
                    </div>
                  </div>
                </div>

                <div class="sm-card-desc">${esc(c.description || 'Operations Google Sheet')}</div>

                <div class="sm-diag-box ${c.connectionStatus === 'error' ? 'error' : (c.connectionStatus === 'ok' ? 'ok' : 'dim')}" id="diag-${c.id}">
                  <span class="sm-diag-msg" id="diag-msg-${c.id}">
                    ${c.lastError ? `⚠ ${esc(c.lastError)}` : (c.detectedTabs?.length ? `✓ Verified: ${c.detectedTabs.length} tab(s) found (${c.detectedTabs.slice(0, 3).map(esc).join(', ')}${c.detectedTabs.length > 3 ? '…' : ''})` : (c.lastChecked ? `✓ Reachable (tested ${new Date(c.lastChecked).toLocaleTimeString()})` : 'Click "Check Status" to verify Google API access.'))}
                  </span>
                </div>
              </div>

              <div class="smc-card-footer">
                <div class="smc-footer-left">
                  <button class="btn btn-ghost btn-sm check-sheet-btn" data-id="${c.id}" style="display:inline-flex;align-items:center;gap:5px">
                    ${getSvg('network', 12)} Check Status
                  </button>
                  <button class="btn btn-secondary btn-sm save-sheet-btn" data-id="${c.id}" style="display:inline-flex;align-items:center;gap:5px">
                    ${getSvg('check', 11)} Save Settings
                  </button>
                </div>
                <div class="smc-footer-right">
                  <button class="btn btn-primary btn-sm open-sheet-btn" data-id="${c.id}" title="Open smart interactive operations sheet view" style="display:inline-flex;align-items:center;gap:5px">
                    ${getSvg('table', 12)} Open Dashboard
                  </button>
                  ${!c.isSystem ? `
                    <button class="btn btn-ghost btn-sm del-sheet-btn" data-id="${c.id}" title="Remove custom sheet" style="color:var(--accent-danger);display:inline-flex;align-items:center;justify-content:center">
                      ${getSvg('trash', 12)}
                    </button>
                  ` : ''}
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;

    attachEvents();
  }

  function attachEvents() {
    // Copy service account email
    $('copy-sa-btn')?.addEventListener('click', () => {
      if (serviceAccountEmail) {
        navigator.clipboard.writeText(serviceAccountEmail).then(() => {
          toast('Service account email copied to clipboard!', 'success');
        }).catch(() => {
          toast(serviceAccountEmail, 'info', 6000);
        });
      }
    });

    // Copy Spreadsheet ID
    mainEl.querySelectorAll('.copy-sid-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const inp = $(`sid-${id}`);
        if (inp && inp.value) {
          navigator.clipboard.writeText(inp.value).then(() => {
            toast('Spreadsheet ID copied!', 'success');
          });
        }
      });
    });

    // Toggle Active / Inactive
    mainEl.querySelectorAll('.sm-active-toggle').forEach(chk => {
      chk.addEventListener('change', async () => {
        const id = chk.dataset.id;
        const isActive = chk.checked;
        const target = credentials.find(c => c.id === id);
        const txt = $(`toggle-txt-${id}`);
        const pill = $(`status-pill-${id}`);
        const netIcon = $(`net-icon-${id}`);
        const statusLbl = $(`status-lbl-${id}`);
        const card = $(`card-${id}`);

        if (txt) txt.textContent = isActive ? 'Active' : 'Inactive';
        if (card) card.classList.toggle('is-inactive', !isActive);
        if (!isActive) {
          if (pill) pill.className = 'sm-status-pill inactive';
          if (netIcon) netIcon.className = 'live-network-icon offline';
          if (statusLbl) statusLbl.textContent = 'Inactive';
        }

        try {
          await PUT(`/api/master/sheet-credentials/${id}`, { active: isActive });
          if (target) target.active = isActive;
          const activeCount = credentials.filter(c => c.active !== false).length;
          const metricActive = $('sm-metric-active');
          if (metricActive) metricActive.textContent = activeCount;

          toast(`${target?.title || 'Sheet'} is now ${isActive ? 'Active (shows in Operations)' : 'Inactive (hidden from sidebar)'}`, 'info');
          buildCustomSheetNav();
        } catch (e) {
          chk.checked = !isActive;
          toast('Failed to update status: ' + e.message, 'error');
        }
      });
    });

    // Instant role permission checkbox toggles
    mainEl.querySelectorAll('.perm-chk').forEach(chk => {
      chk.addEventListener('change', async () => {
        const id = chk.dataset.id;
        const visibleTo = Array.from(mainEl.querySelectorAll(`.perm-view-chk[data-id="${id}"]:checked`)).map(el => el.value);
        const editableBy = Array.from(mainEl.querySelectorAll(`.perm-edit-chk[data-id="${id}"]:checked`)).map(el => el.value);

        try {
          await PUT(`/api/master/sheet-credentials/${id}`, { visibleTo, editableBy });
          const target = credentials.find(c => c.id === id);
          if (target) {
            target.visibleTo = visibleTo;
            target.editableBy = editableBy;
          }
          toast(`Updated permissions for "${target?.title || 'Sheet'}": View [${visibleTo.join(', ')}], Edit [${editableBy.join(', ')}]`, 'success', 2500);
          buildCustomSheetNav();
        } catch (e) {
          chk.checked = !chk.checked; // revert
          toast('Failed to update permissions: ' + e.message, 'error');
        }
      });
    });

    // Section Placement Dropdown
    mainEl.querySelectorAll('.sm-sec-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const id = sel.dataset.id;
        const navSection = sel.value;
        try {
          await PUT(`/api/master/sheet-credentials/${id}`, { navSection });
          const target = credentials.find(c => c.id === id);
          if (target) target.navSection = navSection;
          toast(`Updated sidebar section to "${navSection}"`, 'success');
          buildCustomSheetNav();
        } catch (e) {
          toast('Failed to update section: ' + e.message, 'error');
        }
      });
    });

    // Specific User Assignment Modal
    mainEl.querySelectorAll('.assign-users-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const target = credentials.find(c => c.id === id);
        if (!target) return;

        const currentAssigned = Array.isArray(target.assignedUsers) ? target.assignedUsers : [];

        openModal(`Assign Team Members to "${target.title || 'Sheet'}"`, `
          <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px">
            Select team members who can work on this sheet under Operations. If no users are checked, all users permitted by role will see it.
          </div>
          <div style="display:grid;gap:8px;max-height:55vh;overflow-y:auto;padding-right:4px">
            ${(S.users || []).map(u => `
              <label style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:var(--bg-surface-2);border:1px solid var(--border);border-radius:8px;cursor:pointer">
                <div style="display:flex;align-items:center;gap:10px">
                  <span class="avatar-sm" style="width:26px;height:26px;border-radius:50%;background:rgba(99,102,241,0.2);color:#818cf8;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">
                    ${(u.name || 'U')[0].toUpperCase()}
                  </span>
                  <div>
                    <div style="font-size:13px;font-weight:600;color:#fff">${esc(u.name)}</div>
                    <div style="font-size:11px;color:var(--text-dim)">${esc(u.role)} · ${esc(u.email || '')}</div>
                  </div>
                </div>
                <input type="checkbox" class="user-assign-target-chk" value="${esc(u.id || u.name)}" ${currentAssigned.includes(u.id) || currentAssigned.includes(u.name) ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--accent)" />
              </label>
            `).join('')}
          </div>
        `, [
          { label: 'Cancel', cls: 'btn btn-ghost', onClick: closeModal },
          {
            label: 'Save User Assignments',
            cls: 'btn btn-primary',
            onClick: async () => {
              const assignedUsers = Array.from(document.querySelectorAll('.user-assign-target-chk:checked')).map(el => el.value);
              try {
                await PUT(`/api/master/sheet-credentials/${id}`, { assignedUsers });
                target.assignedUsers = assignedUsers;
                const lbl = $(`assigned-lbl-${id}`);
                if (lbl) lbl.textContent = assignedUsers.length ? `${assignedUsers.length} assigned member(s)` : 'All Permitted Users';
                closeModal();
                toast(`Updated user assignments for "${target.title}"!`, 'success');
                buildCustomSheetNav();
              } catch (e) {
                toast('Failed to save user assignments: ' + e.message, 'error');
              }
            }
          }
        ]);
      });
    });

    // Save ID & Settings buttons
    mainEl.querySelectorAll('.save-sheet-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const sidInput = $(`sid-${id}`);
        const tabInput = $(`tab-${id}`);
        const titleInput = $(`title-${id}`);
        const hrowInput = $(`hrow-${id}`);
        const secInput = $(`sec-${id}`);

        const spreadsheetId = (sidInput?.value || '').trim();
        const tabName = (tabInput?.value || '').trim();
        const title = (titleInput?.value || '').trim();
        const headerRow = parseInt(hrowInput?.value) || 1;
        const navSection = secInput?.value || 'Operations';

        if (!spreadsheetId) {
          toast('Spreadsheet ID cannot be empty', 'warning');
          return;
        }

        btn.disabled = true;
        btn.innerHTML = `${getSvg('refresh', 11)} Saving…`;

        const visibleTo = Array.from(mainEl.querySelectorAll(`.perm-view-chk[data-id="${id}"]:checked`)).map(el => el.value);
        const editableBy = Array.from(mainEl.querySelectorAll(`.perm-edit-chk[data-id="${id}"]:checked`)).map(el => el.value);

        try {
          await PUT(`/api/master/sheet-credentials/${id}`, {
            spreadsheetId,
            tabName: tabName || 'Sheet1',
            title: title || undefined,
            headerRow,
            navSection,
            visibleTo,
            editableBy,
          });

          const target = credentials.find(c => c.id === id);
          if (target) {
            target.spreadsheetId = spreadsheetId;
            target.tabName = tabName || 'Sheet1';
            if (title) target.title = title;
            target.headerRow = headerRow;
            target.navSection = navSection;
            target.visibleTo = visibleTo;
            target.editableBy = editableBy;
          }

          toast(`Saved settings for "${title || target?.title || 'Sheet'}"!`, 'success');
          buildCustomSheetNav();
        } catch (e) {
          toast('Save failed: ' + e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.innerHTML = `${getSvg('check', 11)} Save Settings`;
        }
      });
    });

    // Check Single Sheet Connection
    mainEl.querySelectorAll('.check-sheet-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        await testSingleSheet(id, btn);
      });
    });

    // Delete custom sheet
    mainEl.querySelectorAll('.del-sheet-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const target = credentials.find(c => c.id === id);
        if (!target) return;
        if (!confirm(`Are you sure you want to remove "${target.title}"?`)) return;
        try {
          await DELETE(`/api/master/sheet-credentials/${id}`);
          credentials = credentials.filter(c => c.id !== id);
          toast(`Removed "${target.title}"`, 'success');
          render();
          buildCustomSheetNav();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });

    // Test All Connections
    $('sm-test-all-btn')?.addEventListener('click', async () => {
      const btn = $('sm-test-all-btn');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `${getSvg('refresh', 13)} Testing all…`;
      }
      toast('Testing all Google Sheet connections in parallel…', 'info');
      await Promise.allSettled(credentials.map(c => testSingleSheet(c.id)));
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `${getSvg('network', 13)} Test All Connections`;
      }
      toast('Connection check complete across all sheets!', 'success');
    });

    // Open sheet dashboard
    mainEl.querySelectorAll('.open-sheet-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        navigate('custom-sheet-' + btn.dataset.id);
      });
    });

    // Add New Operations Sheet Modal
    $('sm-add-sheet-btn')?.addEventListener('click', () => openAddSheetModal());
  }

  async function testSingleSheet(id, btnEl = null) {
    const diagMsg = $(`diag-msg-${id}`);
    const diagBox = $(`diag-${id}`);
    const pill = $(`status-pill-${id}`);
    const netIcon = $(`net-icon-${id}`);
    const statusLbl = $(`status-lbl-${id}`);

    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = `${getSvg('refresh', 11)} Checking…`;
    }
    if (diagMsg) diagMsg.textContent = 'Connecting to Google Sheets API…';
    if (diagBox) diagBox.className = 'sm-diag-box pending';
    if (pill) pill.className = 'sm-status-pill pending';
    if (netIcon) netIcon.className = 'live-network-icon pending';
    if (statusLbl) statusLbl.textContent = 'Testing…';

    try {
      const res = await POST(`/api/master/sheet-credentials/${id}/test`, {});
      const c = credentials.find(x => x.id === id);
      if (c) {
        c.connectionStatus = res.status;
        c.lastError = res.error || null;
        c.lastChecked = new Date().toISOString();
        if (res.tabs) c.detectedTabs = res.tabs;
      }

      if (res.status === 'ok') {
        if (pill) pill.className = 'sm-status-pill online';
        if (netIcon) netIcon.className = 'live-network-icon online';
        if (statusLbl) statusLbl.textContent = 'Connected';
        if (diagBox) diagBox.className = 'sm-diag-box ok';
        if (diagMsg) {
          diagMsg.textContent = `✓ Reachable! ${res.tabCount} tab(s) found: (${(res.tabs || []).slice(0, 3).join(', ')}${(res.tabs || []).length > 3 ? '…' : ''}). Row sample: ${res.sampleRowCount} rows.`;
        }
        toast(`Connected to "${res.title || 'Sheet'}"!`, 'success');
      } else {
        if (pill) pill.className = 'sm-status-pill error';
        if (netIcon) netIcon.className = 'live-network-icon offline';
        if (statusLbl) statusLbl.textContent = 'Error';
        if (diagBox) diagBox.className = 'sm-diag-box error';
        if (diagMsg) diagMsg.textContent = `⚠ ${res.error || 'Connection failed'}`;
        toast(`Connection failed: ${res.error}`, 'error');
      }

      const reachableCount = credentials.filter(c => c.connectionStatus === 'ok').length;
      const metricReachable = $('sm-metric-reachable');
      if (metricReachable) metricReachable.textContent = reachableCount;
    } catch (e) {
      if (pill) pill.className = 'sm-status-pill error';
      if (netIcon) netIcon.className = 'live-network-icon offline';
      if (statusLbl) statusLbl.textContent = 'Error';
      if (diagBox) diagBox.className = 'sm-diag-box error';
      if (diagMsg) diagMsg.textContent = `⚠ ${e.message}`;
      toast(`Connection error: ${e.message}`, 'error');
    } finally {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = `${getSvg('network', 12)} Check Status`;
      }
    }
  }

  function openAddSheetModal() {
    openModal('Connect New Operations Google Sheet', `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Operations Sheet Title *</label>
          <input class="form-input" id="sm-modal-title" placeholder="e.g. Client Distribution or Maintenance Operations" />
        </div>
        <div class="form-group">
          <label class="form-label">Google Spreadsheet ID *</label>
          <input class="form-input font-mono" id="sm-modal-sid" placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" />
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px">
            Found in your Google Sheet URL between <code>/d/</code> and <code>/edit</code>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div class="form-group">
            <label class="form-label">Default Tab Name</label>
            <input class="form-input" id="sm-modal-tab" value="Sheet1" placeholder="e.g. Sheet1" />
          </div>
          <div class="form-group">
            <label class="form-label">Header Row</label>
            <input class="form-input" id="sm-modal-hrow" type="number" value="1" min="1" max="20" />
          </div>
          <div class="form-group">
            <label class="form-label">Sidebar Section</label>
            <select class="form-select" id="sm-modal-nav-section">
              <option value="Operations" selected>Operations (Recommended)</option>
              <option value="Workspace">Workspace</option>
              <option value="Administration">Administration</option>
            </select>
          </div>
        </div>

        <!-- Role Permissions -->
        <div style="padding:10px 12px;background:rgba(255,255,255,0.02);border:1px solid var(--border-color);border-radius:8px">
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px">Role-Based Permissions</div>
          <div style="display:flex;flex-direction:column;gap:6px;font-size:12px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span>Can View (Shows in Menu):</span>
              <div style="display:flex;gap:8px">
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer"><input type="checkbox" id="m-v-super" checked disabled /> superadmin</label>
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer"><input type="checkbox" id="m-v-admin" checked /> admin</label>
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer"><input type="checkbox" id="m-v-user" checked /> user</label>
              </div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span>Can Edit &amp; Update Live:</span>
              <div style="display:flex;gap:8px">
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer"><input type="checkbox" id="m-e-super" checked disabled /> superadmin</label>
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer"><input type="checkbox" id="m-e-admin" checked /> admin</label>
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer"><input type="checkbox" id="m-e-user" /> user</label>
              </div>
            </div>
          </div>
        </div>

        <!-- Team Member User Assignment -->
        <div class="form-group">
          <label class="form-label">Assign Team Members (Optional)</label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px 12px;background:var(--bg-surface-2);border:1px solid var(--border);border-radius:6px;max-height:120px;overflow-y:auto">
            ${(S.users || []).map(u => `
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
                <input type="checkbox" class="modal-assigned-user-chk" value="${esc(u.id || u.name)}" />
                <span>${esc(u.name)} (${u.role})</span>
              </label>
            `).join('')}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
            Leave unchecked to allow all users with view permissions to access this sheet.
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Description / Purpose</label>
          <input class="form-input" id="sm-modal-desc" placeholder="Brief note explaining what this sheet tracks" />
        </div>
        ${serviceAccountEmail ? `
          <div style="padding:10px 14px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.22);border-radius:8px;font-size:12px;color:var(--text-secondary)">
            ${getSvg('shield', 12)} Remember to grant Viewer or Editor access to:<br/>
            <code style="font-size:11px;background:rgba(0,0,0,.25);padding:2px 6px;border-radius:4px;display:inline-block;margin-top:4px">${esc(serviceAccountEmail)}</code>
          </div>
        ` : ''}
      </div>
    `, [
      { label: 'Cancel', cls: 'btn btn-ghost', onClick: closeModal },
      {
        label: 'Add to Operations & Test',
        cls: 'btn btn-primary',
        id: 'sm-modal-submit-btn',
        onClick: async () => {
          const title = ($('sm-modal-title')?.value || '').trim();
          const spreadsheetId = ($('sm-modal-sid')?.value || '').trim();
          const tabName = ($('sm-modal-tab')?.value || '').trim() || 'Sheet1';
          const headerRow = parseInt($('sm-modal-hrow')?.value) || 1;
          const navSection = $('sm-modal-nav-section')?.value || 'Operations';
          const description = ($('sm-modal-desc')?.value || '').trim();

          const visibleTo = ['superadmin'];
          if ($('m-v-admin')?.checked) visibleTo.push('admin');
          if ($('m-v-user')?.checked) visibleTo.push('user');

          const editableBy = ['superadmin'];
          if ($('m-e-admin')?.checked) editableBy.push('admin');
          if ($('m-e-user')?.checked) editableBy.push('user');

          const assignedUsers = Array.from(document.querySelectorAll('.modal-assigned-user-chk:checked')).map(el => el.value);

          if (!title || !spreadsheetId) {
            return toast('Please enter both Title and Spreadsheet ID', 'warning');
          }

          const btn = $('sm-modal-submit-btn');
          if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving & Verifying…';
          }

          try {
            const res = await POST('/api/master/sheet-credentials', {
              title,
              spreadsheetId,
              tabName,
              headerRow,
              category: navSection,
              navSection,
              description,
              visibleTo,
              editableBy,
              assignedUsers,
              active: true,
              showInNav: true,
            });
            if (res.credential) {
              credentials.push(res.credential);
              closeModal();
              render();
              buildCustomSheetNav();
              toast(`Added "${title}" directly to ${navSection}! Testing connection…`, 'success');
              testSingleSheet(res.credential.id);
            }
          } catch (e) {
            toast('Failed to add sheet: ' + e.message, 'error');
            if (btn) {
              btn.disabled = false;
              btn.textContent = 'Add to Operations & Test';
            }
          }
        }
      }
    ]);
  }

  render();
}


// ─── Smart Sheet Workspace Dashboard (Live 2-Way Sync & Role-Based Access) ───
// ─── Smart Sheet Workspace Dashboard (Live 2-Way Sync & Role-Based Access) ───
// ─── Smart Sheet Workspace Dashboard (Live 2-Way Sync & Role-Based Access) ───
async function viewCustomSheet(sheetId) {
  setPage('Loading Smart Sheet…', '');

  let currentSearch = '';
  let currentPage = 1;
  let sortKey = '';
  let sortDir = 1;
  let selectedTab = '';
  let activeStatusFilter = '';
  let activeAssigneeFilter = '';
  let viewMode = 'cards';
  try { viewMode = localStorage.getItem('officeos_sheet_view_mode') || 'cards'; } catch { }

  async function loadAndRender() {
    mainEl.innerHTML = '<div class="empty-state"><div class="loading-spinner"></div><p>Connecting to Google Sheets…</p></div>';
    const params = new URLSearchParams({ page: currentPage, limit: 120, search: currentSearch, role: S.role });
    if (selectedTab) params.set('tab', selectedTab);

    let data;
    try {
      data = await GET(`/api/master/sheet-credentials/${sheetId}/data?${params}`);
    } catch (e) {
      mainEl.innerHTML = `
        <div class="empty-state" style="padding:60px">
          ${getSvg('database', 36)}
          <h3 style="margin:16px 0 8px;font-size:16px">Unable to load sheet</h3>
          <p style="color:var(--text-muted)">${esc(e.message)}</p>
          <div style="margin-top:16px;display:flex;gap:8px;justify-content:center">
            <button class="btn btn-primary btn-sm" id="cs-retry-load-btn">Retry Connection</button>
            ${S.role === 'superadmin' ? '<button class="btn btn-secondary btn-sm" onclick="navigate(\'sheet-manager\')">Sheet Manager</button>' : ''}
          </div>
        </div>`;
      $('cs-retry-load-btn')?.addEventListener('click', () => loadAndRender());
      return;
    }

    const {
      rows = [], total = 0, headers = [], pages = 1, canEdit = false, title = '', tabName = '', tabs = [], spreadsheetId = '',
      statusColKeys = [], assigneeColKeys = [], urlColKeys = [], titleColKeys = [],
      primaryStatusKey = null, primaryAssigneeKey = null, primaryUrlKey = null, primaryTitleKey = null,
      statusSummary = {}, assigneeSummary = {}, allStatuses = [], metrics = {}
    } = data;

    if (!selectedTab) selectedTab = tabName;
    const activeTab = selectedTab || tabName;
    setPage(title || 'Smart Sheet', `Live Google Sheet · ${activeTab} (${total.toLocaleString()} rows)`);

    // Client-side filtering by Status or Assignee
    let filtered = [...rows];
    if (activeStatusFilter && primaryStatusKey) {
      filtered = filtered.filter(r => String(r[primaryStatusKey] || '').toLowerCase() === activeStatusFilter.toLowerCase());
    }
    if (activeAssigneeFilter && primaryAssigneeKey) {
      filtered = filtered.filter(r => String(r[primaryAssigneeKey] || '').toLowerCase() === activeAssigneeFilter.toLowerCase());
    }

    // Client-side sorting
    if (sortKey) {
      filtered.sort((a, b) => {
        const av = String(a[sortKey] || ''), bv = String(b[sortKey] || '');
        const an = parseFloat(av), bn = parseFloat(bv);
        return (!isNaN(an) && !isNaN(bn) ? (an - bn) : av.localeCompare(bv)) * sortDir;
      });
    }

    const totalCount = metrics.total || total || 0;
    const completedCount = metrics.completed || 0;
    const inProgressCount = metrics.inProgress || 0;
    const pendingCount = metrics.pending || 0;
    const completionPct = metrics.completionPct || 0;

    // Tabs dropdown HTML
    const tabsDropdownHtml = (tabs && tabs.length > 1) ? `
      <div style="display:inline-flex;align-items:center;gap:6px;padding:2px 8px;background:rgba(255,255,255,0.03);border:1px solid var(--border-color);border-radius:6px">
        <span style="font-size:11px;color:var(--text-secondary);font-weight:600">Tab:</span>
        <select id="cs-tab-select" class="cs-tab-select">
          ${tabs.map(t => `<option value="${esc(t)}" ${t === activeTab ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </div>` : '';

    // Status KPI entries
    const statusEntries = Object.entries(statusSummary);

    // Assignee entries for quick-filter
    const assigneeEntries = Object.entries(assigneeSummary);

    mainEl.innerHTML = `
      <div class="page-content" style="max-width:100%">
        <!-- Hero Progress Card -->
        <div class="cs-hero-card">
          <div class="cs-hero-top">
            <div class="cs-hero-title-wrap">
              <span class="cs-hero-title">
                ${getSvg('database', 20)} ${esc(title || activeTab)}
              </span>
              ${tabsDropdownHtml}
              <span class="sm-status-pill online" style="font-size:11px">
                <span class="live-network-icon online">${getSvg('network', 10)}</span>
                Live 2-Way Sync
              </span>
              <span class="badge ${canEdit ? 'badge-success' : 'badge-dim'}" style="font-size:11px;display:inline-flex;align-items:center;gap:4px">
                ${canEdit ? getSvg('check', 10) + ' Full Edit Access' : getSvg('shield', 10) + ' View Only'}
              </span>
            </div>

            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${canEdit ? `
                <button id="cs-add-row-btn" class="btn btn-primary btn-sm" style="display:inline-flex;align-items:center;gap:5px">
                  ${getSvg('plus', 12)} Add Row
                </button>
                <button id="cs-add-col-btn" class="btn btn-secondary btn-sm" style="display:inline-flex;align-items:center;gap:5px">
                  ${getSvg('plus', 12)} Add Column
                </button>
              ` : ''}
              <button id="cs-refresh-btn" class="btn btn-ghost btn-sm" title="Refresh data from Google Sheets" style="display:inline-flex;align-items:center;gap:5px">
                ${getSvg('refresh', 12)} Refresh
              </button>
              <button id="cs-export-btn" class="btn btn-ghost btn-sm" title="Export to CSV" style="display:inline-flex;align-items:center;gap:5px">
                ${getSvg('download', 12)} Export CSV
              </button>
              <a href="https://docs.google.com/spreadsheets/d/${esc(spreadsheetId)}/edit" target="_blank" rel="noreferrer" class="btn btn-ghost btn-sm" title="Open in Google Sheets" style="display:inline-flex;align-items:center;gap:5px">
                ${getSvg('external', 12)} Google Sheets
              </a>
              ${S.role === 'superadmin' ? `
                <button class="btn btn-ghost btn-sm" onclick="navigate('sheet-manager')" title="Manage sheet settings" style="display:inline-flex;align-items:center;gap:5px">
                  ${getSvg('settings', 12)} Manage
                </button>
              ` : ''}
            </div>
          </div>

          <!-- Progress Hero -->
          <div class="cs-progress-row">
            <div class="cs-progress-badge">
              <span class="cs-progress-number">${completionPct}%</span>
              <span class="cs-progress-label">Completed</span>
            </div>
            <div class="cs-bar-wrap">
              <div class="cs-bar-fill" style="width:${completionPct}%"></div>
            </div>
            <div class="cs-progress-details">
              ${completedCount} of ${totalCount} items completed · ${inProgressCount} in progress · ${pendingCount} pending
            </div>
          </div>
        </div>

        <!-- Dynamic KPI Stat Cards (Clickable Filters) -->
        <div class="cs-kpi-grid">
          <div class="cs-kpi-card theme-total ${!activeStatusFilter ? 'active' : ''}" data-filter="" title="Click to show all records">
            <div class="cs-kpi-top">
              <span class="cs-kpi-label">Total Records</span>
              ${getSvg('database', 12)}
            </div>
            <div class="cs-kpi-val">${totalCount.toLocaleString()}</div>
            <div class="cs-kpi-sub">${headers.length} columns detected</div>
          </div>

          ${completedCount > 0 || primaryStatusKey ? `
            <div class="cs-kpi-card theme-completed ${activeStatusFilter.toLowerCase() === 'completed' || activeStatusFilter.toLowerCase() === 'done' || activeStatusFilter.toLowerCase() === 'active' ? 'active' : ''}" data-filter="${completedCount > 0 ? (statusEntries.find(([k]) => /completed|done|active|live/i.test(k))?.[0] || 'Completed') : 'Completed'}" title="Click to filter completed">
              <div class="cs-kpi-top">
                <span class="cs-kpi-label">Completed</span>
                ${getSvg('check', 12)}
              </div>
              <div class="cs-kpi-val">${completedCount}</div>
              <div class="cs-kpi-sub">${completionPct}% completion rate</div>
            </div>
          ` : ''}

          ${inProgressCount > 0 || primaryStatusKey ? `
            <div class="cs-kpi-card theme-progress ${activeStatusFilter.toLowerCase().includes('progress') || activeStatusFilter.toLowerCase().includes('review') ? 'active' : ''}" data-filter="${statusEntries.find(([k]) => /progress|review|doing|wip/i.test(k))?.[0] || 'In Progress'}" title="Click to filter in-progress">
              <div class="cs-kpi-top">
                <span class="cs-kpi-label">In Progress</span>
                ${getSvg('zap', 12)}
              </div>
              <div class="cs-kpi-val">${inProgressCount}</div>
              <div class="cs-kpi-sub">Active workflow items</div>
            </div>
          ` : ''}

          ${pendingCount > 0 || primaryStatusKey ? `
            <div class="cs-kpi-card theme-pending ${activeStatusFilter.toLowerCase().includes('pending') || activeStatusFilter.toLowerCase().includes('todo') ? 'active' : ''}" data-filter="${statusEntries.find(([k]) => /pending|todo|backlog|open/i.test(k))?.[0] || 'Pending'}" title="Click to filter pending">
              <div class="cs-kpi-top">
                <span class="cs-kpi-label">Pending / To Do</span>
                ${getSvg('bell', 12)}
              </div>
              <div class="cs-kpi-val">${pendingCount}</div>
              <div class="cs-kpi-sub">Awaiting action</div>
            </div>
          ` : ''}

          ${statusEntries.filter(([st]) => !/^(completed|done|finished|active|live|in[ _-]progress|progress|review|pending|todo|open)$/i.test(st)).slice(0, 3).map(([st, cnt]) => `
            <div class="cs-kpi-card ${activeStatusFilter === st ? 'active' : ''}" data-filter="${esc(st)}" title="Click to filter by ${esc(st)}">
              <div class="cs-kpi-top">
                <span class="cs-kpi-label">${esc(st)}</span>
                ${getSvg('table', 12)}
              </div>
              <div class="cs-kpi-val">${cnt}</div>
              <div class="cs-kpi-sub">Custom Status</div>
            </div>
          `).join('')}
        </div>

        <!-- Toolbar: Search, View Switcher & Quick Filters -->
        <div class="card" style="margin-bottom:20px">
          <div class="toolbar" style="padding:14px 18px;gap:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:12px;flex:1;max-width:540px;flex-wrap:wrap">
              <div class="search-wrap" style="flex:1;min-width:220px">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input id="cs-search" class="search-input" placeholder="Search across all records…" value="${esc(currentSearch)}">
              </div>

              <!-- View Mode Switcher -->
              <div class="cs-view-mode-group">
                <button class="cs-view-btn ${viewMode === 'cards' ? 'active' : ''}" id="cs-view-cards-btn" title="Visual Cards View">
                  ${getSvg('columns', 13)} Cards
                </button>
                <button class="cs-view-btn ${viewMode === 'table' ? 'active' : ''}" id="cs-view-table-btn" title="Spreadsheet Table View">
                  ${getSvg('table', 13)} Table
                </button>
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text-muted);flex-wrap:wrap">
              ${(activeStatusFilter || activeAssigneeFilter) ? `
                <div style="display:flex;align-items:center;gap:6px">
                  <span class="badge badge-accent" style="font-size:11px">
                    Filter: ${esc(activeStatusFilter || activeAssigneeFilter)}
                  </span>
                  <button class="btn btn-ghost btn-sm" id="cs-clear-filter-btn" style="padding:2px 6px;font-size:11px">✕ Clear</button>
                </div>
              ` : ''}
              <span>Showing <strong>${filtered.length}</strong> of ${total.toLocaleString()} rows</span>
            </div>
          </div>

          <!-- Assignee Filter Pills (if team column detected) -->
          ${assigneeEntries.length > 1 ? `
            <div style="padding:0 18px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,0.03);padding-top:10px">
              <span style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase">Assignee:</span>
              <button class="badge ${!activeAssigneeFilter ? 'badge-accent' : 'badge-dim'} cs-assignee-pill" data-assignee="" style="cursor:pointer;border:none">
                All (${totalCount})
              </button>
              ${assigneeEntries.slice(0, 10).map(([person, cnt]) => `
                <button class="badge ${activeAssigneeFilter === person ? 'badge-accent' : 'badge-dim'} cs-assignee-pill" data-assignee="${esc(person)}" style="cursor:pointer;border:none">
                  ${esc(person)} (${cnt})
                </button>
              `).join('')}
            </div>
          ` : ''}

          <!-- Main Content Area: Cards View or Table View -->
          ${viewMode === 'cards' ? `
            <!-- CARDS GRID VIEW -->
            <div style="padding:0 18px 18px">
              ${filtered.length === 0 ? `
                <div class="empty-state" style="padding:40px">
                  <p>No matching records found${currentSearch ? ' for "' + esc(currentSearch) + '"' : ''}</p>
                  ${(activeStatusFilter || activeAssigneeFilter) ? '<button class="btn btn-secondary btn-sm" id="cs-reset-filters-btn" style="margin-top:8px">Reset Filters</button>' : ''}
                </div>
              ` : `
                <div class="cs-cards-grid">
                  ${filtered.map(r => {
      const titleVal = primaryTitleKey ? String(r[primaryTitleKey] || '').trim() : '';
      const displayTitle = titleVal || Object.values(r).find(v => typeof v === 'string' && v.trim() && !v.startsWith('http')) || `Row #${r._rowNumber}`;
      const urlVal = primaryUrlKey ? String(r[primaryUrlKey] || '').trim() : Object.values(r).find(v => String(v).startsWith('http'));
      const statusVal = primaryStatusKey ? String(r[primaryStatusKey] || '').trim() : '';
      const statusColObj = headers.find(h => h.key === primaryStatusKey);

      const stLower = statusVal.toLowerCase();
      const statusClass = (stLower.includes('completed') || stLower.includes('done') || stLower.includes('active'))
        ? 'status-completed'
        : ((stLower.includes('progress') || stLower.includes('review')) ? 'status-progress' : (statusVal ? 'status-pending' : ''));

      return `
                      <div class="cs-item-card ${statusClass}">
                        <div class="cs-item-card-top">
                          <span class="cs-item-row-num">#${r._rowNumber}</span>

                          ${primaryStatusKey ? (canEdit ? `
                            <select class="cs-card-status-select" data-row="${r._rowNumber}" data-col="${statusColObj?.index ?? 0}">
                              ${allStatuses.map(s => `
                                <option value="${esc(s)}" ${s.toLowerCase() === statusVal.toLowerCase() ? 'selected' : ''}>${esc(s)}</option>
                              `).join('')}
                            </select>
                          ` : `
                            <span class="badge ${statusClass === 'status-completed' ? 'badge-success' : (statusClass === 'status-progress' ? 'badge-info' : 'badge-warning')}">
                              ${esc(statusVal || 'Unset')}
                            </span>
                          `) : ''}
                        </div>

                        <div>
                          <div class="cs-item-card-title">${esc(displayTitle)}</div>
                          ${urlVal ? `
                            <div style="margin-top:5px">
                              <a href="${esc(urlVal)}" target="_blank" rel="noreferrer" class="cs-item-card-url">
                                ${getSvg('external', 11)} ${esc(shortUrl(urlVal, 38))}
                              </a>
                            </div>
                          ` : ''}
                        </div>

                        <!-- Metadata tags -->
                        <div class="cs-item-card-meta">
                          ${headers.filter(h => h.key !== primaryTitleKey && h.key !== primaryUrlKey && h.key !== primaryStatusKey && String(r[h.key] || '').trim()).slice(0, 4).map(h => `
                            <span class="cs-meta-tag" title="${esc(h.label)}: ${esc(r[h.key])}">
                              <strong>${esc(h.label)}:</strong> ${esc(shortUrl(String(r[h.key]), 24))}
                            </span>
                          `).join('')}
                        </div>

                        ${canEdit ? `
                          <div style="display:flex;justify-content:flex-end;border-top:1px solid rgba(255,255,255,0.04);padding-top:8px">
                            <button class="btn btn-ghost btn-sm cs-edit-row-btn" data-row="${r._rowNumber}" style="font-size:11px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px">
                              ${getSvg('edit', 11)} Edit Details
                            </button>
                          </div>
                        ` : ''}
                      </div>
                    `;
    }).join('')}
                </div>
              `}
            </div>
          ` : `
            <!-- DATA TABLE VIEW -->
            <div class="table-scroll-wrapper" style="overflow-x:auto">
              <table class="linear-table" style="min-width:${Math.max(750, headers.length * 135)}px">
                <thead>
                  <tr>
                    <th style="width:50px;text-align:center">#</th>
                    ${headers.map(h => `
                      <th class="cs-sort-th" data-key="${h.key}" style="cursor:pointer;white-space:nowrap;user-select:none">
                        <div style="display:flex;align-items:center;gap:5px">
                          ${esc(h.label)}
                          ${sortKey === h.key ? getSvg('sort', 10) : `<span style="opacity:0.25">${getSvg('sort', 10)}</span>`}
                        </div>
                      </th>`).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${filtered.length === 0 ? `
                    <tr><td colspan="${headers.length + 1}" class="empty-state" style="text-align:center;padding:40px">No matching records found${currentSearch ? ' for "' + esc(currentSearch) + '"' : ''}</td></tr>
                  ` : filtered.map(r => `
                    <tr data-row="${r._rowNumber}">
                      <td style="font-size:11px;color:var(--text-dim);text-align:center">${r._rowNumber}</td>
                      ${headers.map(h => {
      const val = r[h.key];
      const isStatusCol = (statusColKeys || []).includes(h.key);
      const isUrl = String(val).startsWith('http');
      const stStr = String(val).toLowerCase();
      return `
                          <td class="cs-cell ${canEdit ? 'cs-editable-cell' : ''}" data-row="${r._rowNumber}" data-col="${h.index}" data-key="${h.key}" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(val || '')} ${canEdit ? '(Double-click to edit)' : ''}">
                            ${isStatusCol ? `
                              <span class="badge ${stStr.includes('active') || stStr.includes('done') || stStr.includes('completed') ? 'badge-success' : (stStr.includes('progress') || stStr.includes('review') ? 'badge-info' : 'badge-dim')}" style="cursor:${canEdit ? 'pointer' : 'default'}">
                                ${esc(val || '—')}
                              </span>
                            ` : (isUrl ? `
                              <a href="${esc(val)}" target="_blank" rel="noreferrer" style="color:var(--accent-1);display:inline-flex;align-items:center;gap:4px">
                                ${esc(shortUrl(val, 36))} ${getSvg('external', 10)}
                              </a>
                            ` : (val ? esc(val) : '<span class="dim-dash">—</span>'))}
                          </td>`;
    }).join('')}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}

          ${pages > 1 ? `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-top:1px solid var(--border-color)">
              <button class="btn btn-ghost btn-sm" id="cs-prev-btn" ${currentPage <= 1 ? 'disabled' : ''}>← Previous</button>
              <span style="font-size:12px;color:var(--text-muted)">Page ${currentPage} of ${pages} (${total.toLocaleString()} total rows)</span>
              <button class="btn btn-ghost btn-sm" id="cs-next-btn" ${currentPage >= pages ? 'disabled' : ''}>Next →</button>
            </div>
          ` : ''}
        </div>
      </div>`;

    // ── EVENT LISTENERS ──

    // View Mode Toggle
    $('cs-view-cards-btn')?.addEventListener('click', () => {
      viewMode = 'cards';
      try { localStorage.setItem('officeos_sheet_view_mode', 'cards'); } catch { }
      loadAndRender();
    });

    $('cs-view-table-btn')?.addEventListener('click', () => {
      viewMode = 'table';
      try { localStorage.setItem('officeos_sheet_view_mode', 'table'); } catch { }
      loadAndRender();
    });

    // KPI Card Click Filter
    mainEl.querySelectorAll('.cs-kpi-card').forEach(card => {
      card.addEventListener('click', () => {
        const filterVal = card.dataset.filter || '';
        if (activeStatusFilter === filterVal) activeStatusFilter = '';
        else activeStatusFilter = filterVal;
        loadAndRender();
      });
    });

    // Assignee Pill Click Filter
    mainEl.querySelectorAll('.cs-assignee-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const person = pill.dataset.assignee || '';
        activeAssigneeFilter = (activeAssigneeFilter === person) ? '' : person;
        loadAndRender();
      });
    });

    // Clear Filter
    $('cs-clear-filter-btn')?.addEventListener('click', () => {
      activeStatusFilter = '';
      activeAssigneeFilter = '';
      loadAndRender();
    });
    $('cs-reset-filters-btn')?.addEventListener('click', () => {
      activeStatusFilter = '';
      activeAssigneeFilter = '';
      loadAndRender();
    });

    // Worksheet tab switcher
    $('cs-tab-select')?.addEventListener('change', e => {
      selectedTab = e.target.value;
      currentPage = 1;
      activeStatusFilter = '';
      activeAssigneeFilter = '';
      loadAndRender();
    });

    // Search input
    $('cs-search')?.addEventListener('input', e => {
      currentSearch = e.target.value;
      currentPage = 1;
      loadAndRender();
    });

    // Refresh button
    $('cs-refresh-btn')?.addEventListener('click', () => {
      loadAndRender();
      toast('Refreshed data from Google Sheets', 'info');
    });

    // Sort column headers
    mainEl.querySelectorAll('.cs-sort-th').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (sortKey === key) sortDir *= -1;
        else { sortKey = key; sortDir = 1; }
        loadAndRender();
      });
    });

    // Pagination
    $('cs-prev-btn')?.addEventListener('click', () => { currentPage--; loadAndRender(); });
    $('cs-next-btn')?.addEventListener('click', () => { currentPage++; loadAndRender(); });

    // Export CSV
    $('cs-export-btn')?.addEventListener('click', () => {
      const csvRows = [
        headers.map(h => `"${h.label}"`).join(','),
        ...filtered.map(r => headers.map(h => `"${String(r[h.key] || '').replace(/"/g, '""')}"`).join(',')),
      ];
      const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(title || tabName).replace(/\s+/g, '_')}_export.csv`;
      a.click();
      toast('CSV exported successfully', 'success');
    });

    // ── 2-WAY LIVE SYNC EDITING (if canEdit) ──
    if (canEdit) {
      // 1. Status Dropdown on Cards View (Instant 2-Way Sync)
      mainEl.querySelectorAll('.cs-card-status-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          const rowNumber = parseInt(sel.dataset.row);
          const colIndex = parseInt(sel.dataset.col);
          const newVal = sel.value;
          sel.disabled = true;
          try {
            await POST(`/api/master/sheet-credentials/${sheetId}/cell`, {
              rowNumber, colIndex, value: newVal, tabName: activeTab
            });
            toast(`Updated status to "${newVal}" in Google Sheets!`, 'success', 3000);
            loadAndRender();
          } catch (err) {
            toast('Failed to update status: ' + err.message, 'error');
            sel.disabled = false;
          }
        });
      });

      // 2. Edit Row Details Modal
      mainEl.querySelectorAll('.cs-edit-row-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const rowNum = parseInt(btn.dataset.row);
          const rowData = rows.find(r => r._rowNumber === rowNum);
          if (!rowData) return;

          openModal(`Edit Record #${rowNum} in "${title || tabName}"`, `
            <div style="display:grid;gap:12px;max-height:60vh;overflow-y:auto;padding-right:6px">
              ${headers.map(h => `
                <div class="form-group">
                  <label class="form-label">${esc(h.label)}</label>
                  <input class="form-input" id="edit-row-col-${h.index}" value="${esc(rowData[h.key] || '')}" />
                </div>
              `).join('')}
            </div>
          `, [
            { label: 'Cancel', cls: 'btn btn-ghost', onClick: closeModal },
            {
              label: 'Save Changes to Google Sheet',
              cls: 'btn btn-primary',
              id: 'btn-save-row-changes',
              onClick: async () => {
                const saveBtn = $('btn-save-row-changes');
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
                try {
                  for (const h of headers) {
                    const inp = $(`edit-row-col-${h.index}`);
                    const val = inp ? inp.value.trim() : '';
                    if (val !== (rowData[h.key] || '')) {
                      await POST(`/api/master/sheet-credentials/${sheetId}/cell`, {
                        rowNumber: rowNum,
                        colIndex: h.index,
                        value: val,
                        tabName: activeTab
                      });
                    }
                  }
                  closeModal();
                  toast(`Saved record #${rowNum} to Google Sheet!`, 'success', 3500);
                  loadAndRender();
                } catch (err) {
                  toast('Save failed: ' + err.message, 'error');
                  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes to Google Sheet'; }
                }
              }
            }
          ]);
        });
      });

      // 3. Double-Click Inline Cell Editing on Table View
      mainEl.querySelectorAll('.cs-editable-cell').forEach(cell => {
        cell.addEventListener('dblclick', () => {
          if (cell.querySelector('input, select')) return;
          const currentVal = cell.getAttribute('title') ? cell.getAttribute('title').split(' (Double-click')[0] : cell.textContent.trim();
          const rowNumber = parseInt(cell.dataset.row);
          const colIndex = parseInt(cell.dataset.col);
          const isStatusCol = (statusColKeys || []).includes(cell.dataset.key);

          if (isStatusCol) {
            cell.innerHTML = `
              <select class="form-select" style="font-size:11px;padding:2px 4px;height:26px">
                ${allStatuses.map(opt => `
                  <option value="${esc(opt)}" ${opt.toLowerCase() === currentVal.toLowerCase() ? 'selected' : ''}>${esc(opt)}</option>
                `).join('')}
              </select>`;
            const sel = cell.querySelector('select');
            sel.focus();
            const commitChange = async () => {
              const newVal = sel.value;
              cell.innerHTML = '<span class="badge badge-info">Saving…</span>';
              try {
                await POST(`/api/master/sheet-credentials/${sheetId}/cell`, { rowNumber, colIndex, value: newVal, tabName: activeTab });
                toast(`Updated cell [row ${rowNumber}] to "${newVal}" in Google Sheets!`, 'success');
                loadAndRender();
              } catch (err) {
                toast('Update failed: ' + err.message, 'error');
                loadAndRender();
              }
            };
            sel.addEventListener('change', commitChange);
            sel.addEventListener('blur', () => loadAndRender());
          } else {
            cell.innerHTML = `<input class="form-input" style="font-size:12px;padding:3px 6px;height:26px" value="${esc(currentVal === '—' ? '' : currentVal)}" />`;
            const inp = cell.querySelector('input');
            inp.focus();
            inp.select();

            const commitTextChange = async () => {
              const newVal = inp.value.trim();
              cell.innerHTML = '<span style="color:var(--text-dim)">Saving…</span>';
              try {
                await POST(`/api/master/sheet-credentials/${sheetId}/cell`, { rowNumber, colIndex, value: newVal, tabName: activeTab });
                toast('Saved to Google Sheets!', 'success');
                loadAndRender();
              } catch (err) {
                toast('Update failed: ' + err.message, 'error');
                loadAndRender();
              }
            };

            inp.addEventListener('keydown', e => {
              if (e.key === 'Enter') commitTextChange();
              if (e.key === 'Escape') loadAndRender();
            });
            inp.addEventListener('blur', commitTextChange);
          }
        });
      });

      // 4. Add Row Button
      $('cs-add-row-btn')?.addEventListener('click', () => {
        openModal(`Add Row to "${title || tabName}"`, `
          <div style="display:grid;gap:12px;max-height:60vh;overflow-y:auto;padding-right:6px">
            ${headers.map(h => `
              <div class="form-group">
                <label class="form-label">${esc(h.label)}</label>
                <input class="form-input" id="new-row-col-${h.index}" placeholder="Enter ${esc(h.label)}" />
              </div>
            `).join('')}
          </div>
        `, [
          { label: 'Cancel', cls: 'btn btn-ghost', onClick: closeModal },
          {
            label: 'Append Row to Google Sheet',
            cls: 'btn btn-primary',
            id: 'btn-confirm-add-row',
            onClick: async () => {
              const rowValues = [];
              const maxIdx = Math.max(...headers.map(h => h.index));
              for (let i = 0; i <= maxIdx; i++) {
                const inp = $(`new-row-col-${i}`);
                rowValues.push(inp ? inp.value.trim() : '');
              }
              const btn = $('btn-confirm-add-row');
              if (btn) { btn.disabled = true; btn.textContent = 'Appending to Sheet…'; }
              try {
                await POST(`/api/master/sheet-credentials/${sheetId}/row`, { rowValues, tabName: activeTab });
                closeModal();
                toast('Row appended directly to Google Sheet!', 'success', 4000);
                loadAndRender();
              } catch (err) {
                toast('Failed to append row: ' + err.message, 'error');
                if (btn) { btn.disabled = false; btn.textContent = 'Append Row to Google Sheet'; }
              }
            }
          }
        ]);
      });

      // 5. Add Column Button
      $('cs-add-col-btn')?.addEventListener('click', () => {
        openModal('Add New Column', `
          <div style="display:grid;gap:12px">
            <div class="form-group">
              <label class="form-label">New Column Header Name *</label>
              <input class="form-input" id="new-col-name-input" placeholder="e.g. Status or Reviewer Note" />
            </div>
            <div style="font-size:12px;color:var(--text-muted)">
              This will create a new column header directly in the Google Sheet at the next available column letter.
            </div>
          </div>
        `, [
          { label: 'Cancel', cls: 'btn btn-ghost', onClick: closeModal },
          {
            label: 'Create Column in Google Sheet',
            cls: 'btn btn-primary',
            id: 'btn-confirm-add-col',
            onClick: async () => {
              const val = ($('new-col-name-input')?.value || '').trim();
              if (!val) return toast('Please enter a column header name', 'warning');
              const btn = $('btn-confirm-add-col');
              if (btn) { btn.disabled = true; btn.textContent = 'Creating Column…'; }
              try {
                const res = await POST(`/api/master/sheet-credentials/${sheetId}/column`, { columnName: val, tabName: activeTab });
                closeModal();
                toast(`Created column "${val}" (Column ${res.colLetter}) in Google Sheet!`, 'success', 5000);
                loadAndRender();
              } catch (err) {
                toast('Failed to add column: ' + err.message, 'error');
                if (btn) { btn.disabled = false; btn.textContent = 'Create Column in Google Sheet'; }
              }
            }
          }
        ]);
      });
    }
  }

  loadAndRender();
}


// ─── Bootstrap ────────────────────────────────────────────────────────────────
initLanding();

/* ═════════════════════════════════════════════════════════════════════════════
 * DEV ASSISTANT — Floating Chat Widget
 * Talks to GET/POST /api/master/dev-assistant (devAssistant.js engine).
 * ═════════════════════════════════════════════════════════════════════════════ */
(function initDevAssistant() {
  const launcher = document.getElementById('ai-chat-launcher');
  const panel = document.getElementById('ai-chat-panel');
  const closeBtn = document.getElementById('ai-chat-close');
  const form = document.getElementById('ai-chat-form');
  const input = document.getElementById('ai-chat-input');
  const sendBtn = document.getElementById('ai-chat-send');
  const msgBox = document.getElementById('ai-chat-messages');
  const chipBox = document.getElementById('ai-chat-chips');
  if (!launcher || !panel) return;

  let booted = false;   // greeting fetched once
  let busy = false;   // a question is in-flight

  const escHtml = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // markdown-lite renderer (esc FIRST, then transform). Beyond **bold** and
  // linkified URLs it now lays the answer out in arranged rows, so replies read
  // like a modern assistant instead of one long paragraph:
  //   "Label: value"      → aligned two-column stat row
  //   "• item"            → bullet row with a colored dot
  //   "**Heading**" alone → section heading
  //   "  indented"        → muted sub-line
  //   '"quoted work"'     → quoted block
  function renderRich(text) {
    let html = escHtml(text);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?)])/g, '$1<em class="ai-em">$2</em>');
    html = html.replace(/(https?:\/\/[^\s"'<>)\]]+)/g, (m) =>
      `<a href="${m}" target="_blank" rel="noopener" style="color:var(--accent-2);text-decoration:underline;word-break:break-all">${m.length > 46 ? m.slice(0, 44) + '…' : m}</a>`);

    return html.split('\n').map((line) => {
      if (!line.trim()) return '<div class="ai-gap"></div>';
      if (/^<strong>[^<]+<\/strong>$/.test(line)) return `<div class="ai-h">${line}</div>`;
      const stat = line.match(/^([A-Z][A-Za-z ]{1,16}):\s+(.+)$/);
      if (stat) return `<div class="ai-stat"><span class="ai-stat-k">${stat[1]}</span><span class="ai-stat-v">${stat[2]}</span></div>`;
      const li = line.match(/^\s*[•·\-]\s+(.+)$/);
      if (li) return `<div class="ai-li"><span class="ai-dot">•</span><span class="ai-li-t">${li[1]}</span></div>`;
      if (/^\s{2,}\S/.test(line)) return `<div class="ai-sub">${line.trim()}</div>`;
      if (/^["“]/.test(line.trim())) return `<div class="ai-quote">${line.trim()}</div>`;
      return `<div class="ai-line">${line}</div>`;
    }).join('');
  }

  function addMsg(text, who, meta) {
    const el = document.createElement('div');
    el.className = `ai-msg ai-msg-${who}`;
    el.innerHTML = who === 'user' ? escHtml(text) : renderRich(text);
    msgBox.appendChild(el);
    if (meta) {
      const m = document.createElement('div');
      m.className = 'ai-msg-meta';
      m.textContent = meta;
      msgBox.appendChild(m);
    }
    msgBox.scrollTop = msgBox.scrollHeight;
    return el;
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'ai-msg ai-msg-bot';
    el.innerHTML = '<div class="ai-typing"><span></span><span></span><span></span></div>';
    el.id = 'ai-typing-el';
    msgBox.appendChild(el);
    msgBox.scrollTop = msgBox.scrollHeight;
  }
  function hideTyping() { document.getElementById('ai-typing-el')?.remove(); }

  function setChips(chips) {
    chipBox.innerHTML = '';
    (chips || []).forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ai-chip';
      b.textContent = c;
      b.addEventListener('click', () => ask(c));
      chipBox.appendChild(b);
    });
  }

  async function ask(question, fresh = false) {
    if (busy || !question.trim()) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    addMsg(question, 'user');
    showTyping();
    try {
      const res = await POST('/api/master/dev-assistant', { question, fresh });
      hideTyping();
      addMsg(res.answer || '…', 'bot', res.engine === 'llm' ? '✦ AI-enhanced answer' : null);
      if (res.suggestions?.length) setChips(res.suggestions);
    } catch (e) {
      hideTyping();
      addMsg(`⚠️ ${e.message || 'Something went wrong.'}`, 'bot');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  async function boot() {
    if (booted) return;
    booted = true;
    showTyping();
    try {
      const meta = await GET('/api/master/dev-assistant');
      hideTyping();
      const t = meta.overview?.totals;
      const greet = [
        '👋 **Hi! I\'m your Dev Assistant.**',
        t ? `I\'m watching **${t.projects} projects** — ${t.completed}/${t.pages} sitemap pages done (${t.readiness}%), ${t.rounds} feedback rounds.` : 'Ask me anything about your Dev Tracker.',
        '',
        'Ask things like *"what\'s the update on Reitz Union?"*, *"what\'s pending?"* or *"latest updates"*.'
      ].join('\n');
      const aiNote = meta.aiAvailable
        ? '✦ AI mode active (RAG)' + (Array.isArray(meta.aiProviders) && meta.aiProviders.length ? ': ' + meta.aiProviders.join(' → ') : '') + ' — data-grounded answers'
        : '⚡ Deterministic engine — no AI keys configured';
      addMsg(greet, 'bot', aiNote);
      setChips(meta.suggestions);
      // Show the auto-discovered column layout if the server sent it.
      if (meta.schemaText && typeof meta.schemaText === 'string' && meta.schemaText.length) {
        setTimeout(() => {
          const el = document.createElement('div');
          el.className = 'ai-msg ai-msg-bot';
          el.innerHTML = `<div class="ai-schema-notice"><strong style="font-size:11px">📐 Columns the assistant can see:</strong><pre style="font-size:10.5px;margin-top:4px;color:var(--text-muted);white-space:pre-wrap;font-family:var(--mono,monospace)">${escHtml(meta.schemaText)}</pre></div>`;
          msgBox.appendChild(el);
          msgBox.scrollTop = msgBox.scrollHeight;
        }, 120);
      }
      if (meta.detectedColumns && Array.isArray(meta.detectedColumns) && meta.detectedColumns.length) {
        setTimeout(() => {
          const el = document.createElement('div');
          el.className = 'ai-msg ai-msg-bot';
          el.innerHTML = `<div class="ai-schema-notice" style="margin-top:6px"><strong style="font-size:11px">➕ Hand-added columns detected:</strong> ${escHtml(meta.detectedColumns.map(c => `${c.label}${c.project ? ' (' + escHtml(c.project) + ')' : ''}`).join(', '))}</div>`;
          msgBox.appendChild(el);
          msgBox.scrollTop = msgBox.scrollHeight;
        }, 140);
      }
    } catch (e) {
      hideTyping();
      addMsg('⚠️ Couldn\'t reach the Dev Assistant API — is the server running?', 'bot');
    }
  }

  function open() { panel.classList.remove('hidden'); setTimeout(() => input.focus(), 60); boot(); }
  function close() { panel.classList.add('hidden'); }
  function toggle() { panel.classList.contains('hidden') ? open() : close(); }

  launcher.addEventListener('click', toggle);
  closeBtn.addEventListener('click', close);
  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) close();
  });
})();

// ─── AI Settings (Superadmin) — Dev Assistant providers, tokens & RAG source ───
async function viewAiSettings() {
  if (S.role !== 'superadmin') {
    mainEl.innerHTML = '<div class="empty-state"><p>Access denied — Superadmin only</p></div>';
    return;
  }
  setPage('AI Settings', 'Dev Assistant — LLM providers, API tokens & RAG data source');
  let cfg;
  try {
    cfg = await GET('/api/master/assistant-config?role=superadmin');
  } catch (e) {
    mainEl.innerHTML = '<div class="empty-state" style="padding:60px">' + getSvg('ai-settings', 36) +
      '<h3 style="margin:16px 0 8px;font-size:16px">Failed to load AI configuration</h3>' +
      '<p style="color:var(--text-muted)">' + esc(e.message || '') + '</p>' +
      '<button class="btn btn-primary btn-sm" id="ai-retry-btn" style="margin-top:16px">Retry</button></div>';
    mainEl.querySelector('#ai-retry-btn')?.addEventListener('click', () => viewAiSettings());
    return;
  }

  const tabs = { perTab: null, totalRows: 0, error: '' };
  const selected = new Set((cfg.source?.tabs || []).slice());
  const BOX = 'border:1px solid var(--border,#2a2f3a);border-radius:10px;padding:14px 16px;background:var(--bg-card,transparent)';

  function keyBadge(p) {
    if (!p.hasKey) return '<span class="badge" style="font-size:10.5px;color:#f59e0b;border-color:rgba(245,158,11,.4)">No key</span>';
    const src = p.keySource === 'dashboard' ? 'Dashboard' : p.keySource === 'env' ? '.env' : 'None';
    const col = p.keySource === 'dashboard' ? '#22c55e' : '#60a5fa';
    return '<span class="badge" style="font-size:10.5px;color:' + col + ';border-color:' + col + '55" title="' + esc(p.keyMasked || '') + '">Key: ' + esc(src) + ' · ' + esc(p.keyMasked || '') + '</span>';
  }

  function kindBadge(k) {
    if (k === 'worker') return '<span class="badge" style="font-size:10.5px">WORKER</span>';
    if (k === 'gemini') return '<span class="badge" style="font-size:10.5px">GEMINI API</span>';
    return '<span class="badge" style="font-size:10.5px">OPENAI-COMPATIBLE</span>';
  }

  function cards() {
    return (cfg.providers || []).map((p) => {
      const pos = (cfg.order || []).indexOf(p.name) + 1;
      return `
      <div style="${BOX};margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="badge" style="font-size:10.5px">#${pos || '?'} in chain</span>
          <strong style="font-size:13.5px">${esc(p.label || p.name)}</strong>
          ${kindBadge(p.kind)}
          ${keyBadge(p)}
          <label style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
            <input type="checkbox" class="ai-en" data-name="${esc(p.name)}"${p.enabled !== false ? ' checked' : ''}> enabled
          </label>
        </div>
        ${p.skipReason ? '<div style="font-size:11.5px;color:var(--text-muted);margin-top:6px">ℹ ' + esc(p.skipReason) + '</div>' : ''}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:10px">
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">API token${p.hasKey ? ' — leave empty to keep the saved key' : ''}</div>
            <input type="password" class="ai-key" data-name="${esc(p.name)}" placeholder="${p.hasKey ? '••••• saved key active' : 'Paste API token (16+ chars)…'}" style="width:100%" autocomplete="off">
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Models override (comma list; blank = defaults)</div>
            <input type="text" class="ai-models" data-name="${esc(p.name)}" value="${esc(p.modelsOverride || '')}" placeholder="${esc((p.defaultModels || []).join(', '))}" style="width:100%">
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Base URL override</div>
            <input type="text" class="ai-base" data-name="${esc(p.name)}" value="${esc(p.baseUrl && p.baseUrl !== p.defaultBaseUrl ? p.baseUrl : '')}" placeholder="${esc(p.defaultBaseUrl || '')}" style="width:100%">
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm ai-test" data-name="${esc(p.name)}">⚡ Test key</button>
          <button class="btn btn-primary btn-sm ai-save-test" data-name="${esc(p.name)}">💾 Save &amp; Test</button>
          <span class="ai-res" data-name="${esc(p.name)}" style="font-size:12px"></span>
        </div>
      </div>`;
    }).join('');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
  }

  // Which provider answers first. Every failure (bad key, retired model 404,
  // 429 quota, timeout, empty answer) rolls to the next one automatically.
  function orderEditor() {
    const provs = cfg.providers || [];
    return `
      <div style="${BOX};margin-bottom:14px">
        <div style="font-size:13px;font-weight:700;margin-bottom:4px">Provider chain order</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
          Lower number = tried first. The builtin deterministic engine is always the final fallback.
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px">
          ${provs.map((p) => {
            const pos = (cfg.order || []).indexOf(p.name) + 1;
            return `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px">
              <input type="number" class="ai-ord" data-name="${esc(p.name)}" min="1" max="${provs.length}" value="${pos || 1}" style="width:64px">
              ${esc(p.label || p.name)}
            </label>`;
          }).join('')}
        </div>
      </div>`;
  }
// Accuracy controls — these drive the RAG grounding guard on every answer.
  function ragBox(id, label, hint, on) {
    return `<label style="display:flex;gap:9px;align-items:flex-start;font-size:12.5px;cursor:pointer">
        <input type="checkbox" id="${id}" ${on ? 'checked' : ''} style="margin-top:2px">
        <span><strong>${label}</strong><br><span style="color:var(--text-muted);font-size:11.5px">${hint}</span></span>
      </label>`;
  }

  function ragEditor() {
    const r = cfg.rag || {};
    return `
      <div style="${BOX};margin-bottom:14px">
        <div style="font-size:13px;font-weight:700;margin-bottom:4px">RAG accuracy</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
          Accuracy is the priority: the assistant answers only from retrieved tracker rows, and every number it returns is verified against them.
        </div>
        <div style="display:grid;gap:12px">
          ${ragBox('rag-strict', 'Strict grounding (recommended)', 'If an answer contains a number the retrieved rows do not support, discard it and answer deterministically instead of showing a wrong figure.', r.strictGrounding !== false)}
          ${ragBox('rag-verify', 'Verify numbers in every answer', 'Cross-checks page / completed / pending / round counts and dates against the exact context fed to the model.', r.verifyNumbers !== false)}
          ${ragBox('rag-urls', 'Include sitemap page URLs', 'Adds exact page URLs to the context so “which page is pending?” questions are answerable.', r.includePageUrls !== false)}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:12px">
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Evidence rows retrieved per question (0 = auto)</div>
            <input type="number" id="rag-evidence" min="0" max="60" value="${Number(r.evidenceLimit) || 0}" style="width:100%">
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Max context characters (2000–60000)</div>
            <input type="number" id="rag-chars" min="2000" max="60000" step="500" value="${Number(r.contextChars) || 20000}" style="width:100%">
          </div>
        </div>
      </div>`;
  }
// "Choose which Google Sheet the AI fetches" — superadmin only.
  function sourceEditor() {
    const s = cfg.source || {};
    const opts = cfg.sheetOptions || [];
    return `
      <div style="${BOX};margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="font-size:13px;font-weight:700">📊 RAG data source</div>
          <span class="badge" style="font-size:10.5px;color:#a78bfa;border-color:rgba(167,139,250,.4)">SUPERADMIN</span>
          <label style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
            <input type="checkbox" id="src-fresh" ${s.freshOnAsk ? 'checked' : ''}> re-read the sheet on every question
          </label>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin:6px 0 12px">
          The assistant answers only from this sheet. Pick a configured source, then choose which tabs (sitemap projects) it may read.
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Configured sheet source</div>
            <select id="src-cred" style="width:100%">
              <option value="">— use the spreadsheet ID below —</option>
              ${opts.map((o) => `<option value="${esc(o.id)}" data-spreadsheet="${esc(o.spreadsheetId || '')}" ${s.credentialId && s.credentialId === o.id ? 'selected' : ''}>${esc(o.title)}${o.isSystem ? ' (system)' : ''}${o.active ? '' : ' — inactive'}</option>`).join('')}
            </select>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Spreadsheet ID (auto-filled / editable)</div>
            <input type="text" id="src-sheet-id" value="${esc(s.spreadsheetId || '')}" placeholder="1AbC…" style="width:100%;font-family:ui-monospace,monospace;font-size:11.5px">
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="src-test">🔍 Test source &amp; load tabs</button>
          <span style="font-size:12px;color:var(--text-muted)" id="src-res">${selected.size ? selected.size + ' tab(s) selected' : 'no tabs selected → all tabs are used'}</span>
        </div>
        <div id="src-tabs-box" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:6px;margin-top:12px"></div>
      </div>`;
  }
function render() {
    const provs = cfg.providers || [];
    const withKey = provs.filter((p) => p.hasKey).length;
    const live = provs.filter((p) => p.configured && p.enabled !== false);
    mainEl.innerHTML = `
      <div class="page-content" style="max-width:1180px">
        <div style="${BOX};margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="font-size:15px;font-weight:700">🤖 Dev Assistant AI</div>
            <span class="badge" style="font-size:10.5px;color:${cfg.aiAvailable ? '#22c55e' : '#f59e0b'};border-color:${cfg.aiAvailable ? 'rgba(34,197,94,.4)' : 'rgba(245,158,11,.4)'}">${cfg.aiAvailable ? 'AI ACTIVE' : 'BUILTIN ONLY'}</span>
            <span style="font-size:12px;color:var(--text-muted)">engine: <code>${esc(cfg.engine || 'builtin')}</code></span>
            <span style="font-size:11.5px;color:var(--text-muted);margin-left:auto">updated ${esc(fmtDate(cfg.updatedAt))}</span>
          </div>
          <div class="sm-metric-strip" style="margin-top:12px">
            <div class="sm-metric-item"><span class="sm-metric-val">${provs.length}</span><span class="sm-metric-lbl">Providers</span></div>
            <div class="sm-metric-item"><span class="sm-metric-val text-success">${withKey}</span><span class="sm-metric-lbl">With API token</span></div>
            <div class="sm-metric-item"><span class="sm-metric-val">${live.length}</span><span class="sm-metric-lbl">Enabled &amp; usable</span></div>
            <div class="sm-metric-item"><span class="sm-metric-val">${selected.size || 'all'}</span><span class="sm-metric-lbl">Sheet tabs in RAG</span></div>
          </div>
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:8px">
            Superadmin only · tokens are stored server-side and never sent back to the browser (masked previews only) ·
            chain: ${(cfg.order || []).map((n, i) => `${i + 1}. ${esc(n)}`).join(' → ')} → builtin
          </div>
        </div>

        ${sourceEditor()}
        ${orderEditor()}
        ${ragEditor()}

        <div style="display:flex;align-items:center;gap:10px;margin:4px 0 12px;flex-wrap:wrap">
          <div style="font-size:13px;font-weight:700">🔌 AI providers &amp; API tokens</div>
          <button class="btn btn-secondary btn-sm" id="ai-test-all" style="margin-left:auto">⚡ Test all keys</button>
        </div>
        <div id="ai-providers">${cards()}</div>
        <div id="ai-test-all-res" style="font-size:12px;margin-bottom:12px"></div>

        <div style="display:flex;gap:10px;align-items:center;position:sticky;bottom:0;background:var(--bg,#111);padding:12px 0;border-top:1px solid var(--border,#2a2f3a);flex-wrap:wrap">
          <button class="btn btn-primary" id="ai-save-all">💾 Save AI settings</button>
          <span style="font-size:12px;color:var(--text-muted)" id="ai-save-res"></span>
        </div>
      </div>`;
    wire();
  }
// ── wiring ──────────────────────────────────────────────────────────────────
  const pick = (cls, name) => Array.from(mainEl.querySelectorAll('.' + cls)).find((el) => el.dataset.name === name);
  const setRes = (name, msg, ok) => {
    const el = mainEl.querySelector('.ai-res[data-name="' + name + '"]');
    if (el) { el.textContent = msg; el.style.color = ok === true ? '#22c55e' : ok === false ? '#f87171' : 'var(--text-muted)'; }
  };

  // Only non-empty values are collected — an empty key field means "keep the
  // saved token" (the server would otherwise treat '' as an explicit clear).
  function collectProvider(name) {
    const d = {};
    const en = pick('ai-en', name); if (en) d.enabled = en.checked;
    const key = pick('ai-key', name); if (key && key.value.trim()) d.apiKey = key.value.trim();
    const models = pick('ai-models', name); if (models) d.models = models.value.trim();
    const base = pick('ai-base', name); if (base) d.baseUrl = base.value.trim();
    return d;
  }

  function collectOrder() {
    const rows = Array.from(mainEl.querySelectorAll('.ai-ord')).map((el) => ({ name: el.dataset.name, pos: Number(el.value) || 1 }));
    rows.sort((a, b) => a.pos - b.pos);
    return rows.map((r) => r.name);
  }

  function collectRag() {
    const val = (id, def) => {
      const el = $('' + id);
      return el ? el.checked : def;
    };
    return {
      strictGrounding: val('rag-strict', true),
      verifyNumbers: val('rag-verify', true),
      includePageUrls: val('rag-urls', true),
      evidenceLimit: Number($('rag-evidence')?.value) || 0,
      contextChars: Number($('rag-chars')?.value) || 20000,
    };
  }

  function renderTabs(allTabs, perTab) {
    const box = $('src-tabs-box');
    if (!box) return;
    const counts = {};
    (perTab || []).forEach((t) => { counts[t.tab] = t; });
    box.innerHTML = (allTabs || []).map((tab) => {
      const info = counts[tab];
      const label = info
        ? `<span style="font-size:11px;color:${info.error ? '#f87171' : 'var(--text-muted)'}">${info.error ? 'error' : info.rows + ' rows'}</span>`
        : '';
      return `<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;padding:6px 8px;border:1px solid var(--border,#2a2f3a);border-radius:8px">
        <input type="checkbox" class="src-tab" value="${esc(tab)}" ${selected.has(tab) ? 'checked' : ''}>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(tab)}</span>
        ${label}
      </label>`;
    }).join('') || '<div style="font-size:12px;color:var(--text-muted)">No tabs loaded yet — click “Test source &amp; load tabs”.</div>';
    box.querySelectorAll('.src-tab').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
      const res = $('src-res');
      if (res) res.textContent = selected.size ? selected.size + ' tab(s) selected' : 'no tabs selected → all tabs are used';
    }));
  }

  async function testSource(loadTabs) {
    const btn = $('src-test'), res = $('src-res');
    const spreadsheetId = ($('src-sheet-id')?.value || '').trim();
    const wanted = loadTabs ? Array.from(selected) : Array.from(selected);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Checking sheet…'; }
    if (res) { res.textContent = 'reading tabs…'; res.style.color = 'var(--text-muted)'; }
    try {
      const r = await POST('/api/master/assistant-config/test-source', {
        role: 'superadmin', spreadsheetId, tabs: wanted,
      });
      renderTabs(r.allTabs || [], r.perTab || []);
      tabs.perTab = r.perTab || []; tabs.totalRows = r.totalRows || 0; tabs.error = '';
      if (res) {
        res.textContent = '✓ ' + (r.tabsUsed || []).length + ' tab(s) read · ' + r.totalRows + ' data rows the AI would see';
        res.style.color = '#22c55e';
      }
      return r;
    } catch (e) {
      tabs.error = e.message || 'failed';
      if (res) { res.textContent = '✗ ' + tabs.error; res.style.color = '#f87171'; }
      return null;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Test source & load tabs'; }
    }
  }
function wire() {
    $('src-cred')?.addEventListener('change', (e) => {
      const sid = e.target.selectedOptions?.[0]?.dataset?.spreadsheet || '';
      const idEl = $('src-sheet-id');
      if (sid && idEl) idEl.value = sid;
    });
    $('src-test')?.addEventListener('click', () => testSource(true));
    $('src-sheet-id')?.addEventListener('change', () => testSource(true));

    Array.from(mainEl.querySelectorAll('.ai-test')).forEach((b) => b.addEventListener('click', () => runProvider(b.dataset.name, false)));
    Array.from(mainEl.querySelectorAll('.ai-save-test')).forEach((b) => b.addEventListener('click', () => runProvider(b.dataset.name, true)));

    $('ai-test-all')?.addEventListener('click', async () => {
      const btn = $('ai-test-all'), res = $('ai-test-all-res');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Testing all…'; }
      if (res) { res.textContent = 'probing every provider in the chain…'; res.style.color = 'var(--text-muted)'; }
      try {
        const r = await POST('/api/master/assistant-config/test', { role: 'superadmin', all: true });
        if (res) {
          res.innerHTML = (r.results || []).map((x) =>
            `<div style="padding:3px 0">${x.ok ? '✓' : '✗'} <strong>${esc(x.provider)}</strong> — ${esc(x.message || '')}${x.model ? ' · model ' + esc(x.model) : ''}</div>`
          ).join('') || 'no providers configured';
        }
      } catch (e) { if (res) { res.textContent = '✗ ' + e.message; res.style.color = '#f87171'; } }
      finally { if (btn) { btn.disabled = false; btn.textContent = '⚡ Test all keys'; } }
    });

    $('ai-save-all')?.addEventListener('click', saveAll);
  }

  // Test one provider (optionally saving the typed token first). The NOT-saved
  // key is still tested via `draft`, so you can verify a token before storing it.
  async function runProvider(name, saveFirst) {
    const b1 = pick('ai-test', name), b2 = pick('ai-save-test', name);
    if (b1) b1.disabled = true;
    if (b2) b2.disabled = true;
    setRes(name, saveFirst ? '⏳ saving & testing…' : '⏳ testing…', null);
    try {
      if (saveFirst) await PUT('/api/master/assistant-config', { role: 'superadmin', providers: { [name]: collectProvider(name) } });
      const r = await POST('/api/master/assistant-config/test', { role: 'superadmin', provider: name, draft: { [name]: collectProvider(name) } });
      const x = r.result || {};
      setRes(name, (x.ok ? '✓ ' : '✗ ') + (x.message || '') + (x.model ? ' · model ' + x.model : '') + (x.attempts?.length > 1 ? ' · ' + x.attempts.length + ' models tried' : ''), x.ok === true);
      if (saveFirst && x.ok) toast(name + ' key saved & verified', 'success');
    } catch (e) {
      setRes(name, '✗ ' + (e.message || 'failed'), false);
    } finally {
      if (b1) b1.disabled = false;
      if (b2) b2.disabled = false;
    }
  }

  async function saveAll() {
    const btn = $('ai-save-all');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
    const providers = {};
    (cfg.providers || []).forEach((p) => { providers[p.name] = collectProvider(p.name); });
    const body = {
      role: 'superadmin',
      providers,
      order: collectOrder(),
      source: {
        credentialId: $('src-cred')?.value || '',
        spreadsheetId: ($('src-sheet-id')?.value || '').trim(),
        tabs: Array.from(selected),
        freshOnAsk: $('src-fresh')?.checked === true,
      },
      rag: collectRag(),
    };
    try {
      const r = await PUT('/api/master/assistant-config', body);
      cfg = await GET('/api/master/assistant-config?role=superadmin');
      render();
      const el = $('ai-save-res');
      const ignored = r.ignored || [];
      if (el) {
        el.textContent = '✓ Saved ' + fmtDate(r.updatedAt) + (ignored.length ? ' · ignored: ' + ignored.join(' · ') : '');
        el.style.color = ignored.length ? '#f59e0b' : '#22c55e';
      }
      toast('AI settings saved', 'success');
    } catch (e) {
      const el = $('ai-save-res');
      if (el) { el.textContent = '✗ ' + (e.message || 'save failed'); el.style.color = '#f87171'; }
      toast(e.message || 'Save failed', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save AI settings'; }
    }
  }

  render();
  // NOTE: the tab list is loaded on demand ("Test source & load tabs") rather
  // than on page open, so visiting this page never floods the Sheets API.
}
