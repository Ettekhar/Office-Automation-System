// Maintenance Mailer Dashboard Frontend Logic

let currentOverview = null;
let allAccountConfigs = []; // fetched from /api/accounts
let generatedPreviews = new Map(); // websiteUrl -> { websiteUrl, contacts, matchedTab, subject, html, hasAdditionalIssues, hasPremiumPlugins, isCustomEdited, account, accountName, fromEmail }
let currentPreviewSite = null;
let currentFilter = 'all';
let selectedAccount = 'all';
let searchQuery = '';
let selectedSites = new Set(); // Set of websiteUrls selected via checkboxes
let sentHistory = []; // Array of { time, account, websiteUrl, to, subject, status, details, isDryRun }
let activeEditorTab = 'visual'; // 'visual' | 'html'
// Global send mode: 'email+clickup' | 'email' | 'clickup'
let globalSendMode = 'email+clickup';


// DOM Elements
const workspaceSelect = document.getElementById('workspaceSelect');
const monthSelect = document.getElementById('monthSelect');
const refreshBtn = document.getElementById('refreshBtn');
const generateAllBtn = document.getElementById('generateAllBtn');
const sendRemainingBtn = document.getElementById('sendRemainingBtn');
const sendSelectedBtn = document.getElementById('sendSelectedBtn');
const selectedCountText = document.getElementById('selectedCountText');

// Stat Elements
const statTotalSites = document.getElementById('statTotalSites');
const statActive = document.getElementById('statActive');
const statReady = document.getElementById('statReady');
const statInProgress = document.getElementById('statInProgress');
const statGenerated = document.getElementById('statGenerated');
const statSent = document.getElementById('statSent');

// Counts
const countAll = document.getElementById('countAll');
const countReady = document.getElementById('countReady');
const countUnsent = document.getElementById('countUnsent');
const countSent = document.getElementById('countSent');
const countInProgress = document.getElementById('countInProgress');
const countInactive = document.getElementById('countInactive');

// Table & Search
const sitesTableBody = document.getElementById('sitesTableBody');
const searchInput = document.getElementById('searchInput');
const filterTabs = document.querySelectorAll('.filter-tab');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const selectionBar = document.getElementById('selectionBar');
const selectionText = document.getElementById('selectionText');
const selectUnsentBtn = document.getElementById('selectUnsentBtn');
const clearSelectionBtn = document.getElementById('clearSelectionBtn');

// Banner
const batchStatusBanner = document.getElementById('batchStatusBanner');
const bannerSendBtn = document.getElementById('bannerSendBtn');
const bannerReadyCount = document.getElementById('bannerReadyCount');

// History Table
const historyTableBody = document.getElementById('historyTableBody');
const historyCountBadge = document.getElementById('historyCountBadge');

// Preview Modal Elements
const previewModal = document.getElementById('previewModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const modalSiteTitle = document.getElementById('modalSiteTitle');
const modalAccountTag = document.getElementById('modalAccountTag');
const modalTabTag = document.getElementById('modalTabTag');
const modalPremiumTag = document.getElementById('modalPremiumTag');
const modalIssuesTag = document.getElementById('modalIssuesTag');
const modalEditedTag = document.getElementById('modalEditedTag');
const editToInput = document.getElementById('editToInput');
const editSubjectInput = document.getElementById('editSubjectInput');
const tabVisualPreview = document.getElementById('tabVisualPreview');
const tabHtmlEditor = document.getElementById('tabHtmlEditor');
const applyHtmlBtn = document.getElementById('applyHtmlBtn');
const previewFrameContainer = document.getElementById('previewFrameContainer');
const htmlEditorContainer = document.getElementById('htmlEditorContainer');
const previewIframe = document.getElementById('previewIframe');
const rawHtmlTextarea = document.getElementById('rawHtmlTextarea');
const modalSaveCustomBtn = document.getElementById('modalSaveCustomBtn');
const modalSendSingleBtn = document.getElementById('modalSendSingleBtn');

// Batch Modal Elements
const batchModal = document.getElementById('batchModal');
const batchModalTitle = document.getElementById('batchModalTitle');
const closeBatchModalBtn = document.getElementById('closeBatchModalBtn');
const cancelBatchBtn = document.getElementById('cancelBatchBtn');
const confirmBatchSendBtn = document.getElementById('confirmBatchSendBtn');
const batchConfirmView = document.getElementById('batchConfirmView');
const batchProgressView = document.getElementById('batchProgressView');
const batchCountConfirm = document.getElementById('batchCountConfirm');
const batchMonthConfirm = document.getElementById('batchMonthConfirm');
const batchAccountBreakdown = document.getElementById('batchAccountBreakdown');
const batchDryRunCheckbox = document.getElementById('batchDryRunCheckbox');
const batchProgressBar = document.getElementById('batchProgressBar');
const batchProgressText = document.getElementById('batchProgressText');
const batchProgressPercent = document.getElementById('batchProgressPercent');
const batchLogBox = document.getElementById('batchLogBox');

const toast = document.getElementById('toast');

// SMTP Info Bar
const smtpInfoAccounts = document.getElementById('smtpInfoAccounts');

// From selector (in preview modal)
const editFromSelect = document.getElementById('editFromSelect');
const editFromDetails = document.getElementById('editFromDetails');

// ClickUp Sync Elements
const clickupSyncPanel = document.getElementById('clickupSyncPanel');
const clickupTaskStatusBadge = document.getElementById('clickupTaskStatusBadge');
const viewAllAmsBtn = document.getElementById('viewAllAmsBtn');
const refreshClickUpBtn = document.getElementById('refreshClickUpBtn');
const cuTaskId = document.getElementById('cuTaskId');
const cuTaskExternalLink = document.getElementById('cuTaskExternalLink');
const cuLiveStatusPill = document.getElementById('cuLiveStatusPill');
const cuAmName = document.getElementById('cuAmName');
const cuAmResolvedBadge = document.getElementById('cuAmResolvedBadge');
const cuSafetyGuardBadge = document.getElementById('cuSafetyGuardBadge');
const cuCommentPreviewText = document.getElementById('cuCommentPreviewText');
const cuLiveFeedbackBanner = document.getElementById('cuLiveFeedbackBanner');
const optSendEmail = document.getElementById('optSendEmail');
const optSyncClickUp = document.getElementById('optSyncClickUp');
const modalSendBtnLabel = document.getElementById('modalSendBtnLabel');
const modalSyncClickUpOnlyBtn = document.getElementById('modalSyncClickUpOnlyBtn');

// AM Directory Modal Elements
const amDirectoryModal = document.getElementById('amDirectoryModal');
const closeAmModalBtn = document.getElementById('closeAmModalBtn');
const closeAmModalBottomBtn = document.getElementById('closeAmModalBottomBtn');
const amSearchInput = document.getElementById('amSearchInput');
const amDirectoryTableBody = document.getElementById('amDirectoryTableBody');
const amCountBadge = document.getElementById('amCountBadge');
let cachedAccountManagers = null;
let currentClickUpPreview = null;

// ClickUp Bulk Bar Elements
const cuBulkBar = document.getElementById('cuBulkBar');
const cuBulkTaskCount = document.getElementById('cuBulkTaskCount');
const cuLoadPreviewBtn = document.getElementById('cuLoadPreviewBtn');
const cuPreviewReadyBadge = document.getElementById('cuPreviewReadyBadge');
const cuSendAllClickUpBtn = document.getElementById('cuSendAllClickUpBtn');
const cuSendSelectedClickUpBtn = document.getElementById('cuSendSelectedClickUpBtn');
const cuSyncSelectedCount = document.getElementById('cuSyncSelectedCount');
const cuModeBtns = document.querySelectorAll('.cu-mode-btn');
// ClickUp Bulk Preview Modal Elements
const cuBulkPreviewModal = document.getElementById('cuBulkPreviewModal');
const closeCuBulkModalBtn = document.getElementById('closeCuBulkModalBtn');
const cuBulkCancelBtn = document.getElementById('cuBulkCancelBtn');
const cuBulkSendBtn = document.getElementById('cuBulkSendBtn');
const cuBulkSendBtnLabel = document.getElementById('cuBulkSendBtnLabel');
const cuBulkPreviewLoading = document.getElementById('cuBulkPreviewLoading');
const cuBulkPreviewTable = document.getElementById('cuBulkPreviewTable');
const cuBulkPreviewTableBody = document.getElementById('cuBulkPreviewTableBody');
const cuBulkPreviewCount = document.getElementById('cuBulkPreviewCount');
const cuBulkReadyCount = document.getElementById('cuBulkReadyCount');
const cuBulkWarningCount = document.getElementById('cuBulkWarningCount');
const cuBulkNoTaskCount = document.getElementById('cuBulkNoTaskCount');
const cuBulkSelectAll = document.getElementById('cuBulkSelectAll');
const cuBulkSendModeTag = document.getElementById('cuBulkSendModeTag');
const cuBulkDryRunTag = document.getElementById('cuBulkDryRunTag');
const cuBulkLoadingLabel = document.getElementById('cuBulkLoadingLabel');
// Store previewed ClickUp data for the send step
let cuBulkPreviewData = []; // Array of { site, previewResult, selected }

// --- Fetch All Account Configs (SMTP sender info) ---
async function fetchAccounts() {
  try {
    const res = await fetch('/api/accounts');
    if (!res.ok) return;
    const data = await res.json();
    allAccountConfigs = data.accounts || [];
    renderSmtpInfoBar();
    populateFromSelect();
  } catch (e) {
    console.warn('Could not load account configs:', e);
  }
}

function renderSmtpInfoBar() {
  if (!smtpInfoAccounts || allAccountConfigs.length === 0) return;

  // "All" pill first
  const allActive = !selectedAccount || selectedAccount === 'all';
  let html = `
    <button class="smtp-account-pill smtp-filter-pill pill-all ${allActive ? 'pill-active' : ''}" data-filter-account="all" title="Show all workspaces">
      <span class="pill-name">All</span>
      <span class="pill-email">Both workspaces</span>
    </button>
    <span class="smtp-info-divider" style="height:16px;"></span>
  `;

  html += allAccountConfigs.map((a) => {
    const cls = a.key.toLowerCase();
    const isActive = selectedAccount === a.key;
    return `
      <button class="smtp-account-pill smtp-filter-pill pill-${cls} ${isActive ? 'pill-active' : ''}" data-filter-account="${escapeHtml(a.key)}" title="Filter to ${escapeHtml(a.name)} only">
        <span class="pill-name">${escapeHtml(a.key)}</span>
        <span class="smtp-info-divider"></span>
        <span class="pill-email">${escapeHtml(a.fromName)} &lt;${escapeHtml(a.fromEmail)}&gt;</span>
        <span class="smtp-info-divider"></span>
        <span class="pill-host">${escapeHtml(a.smtpHost)}:${a.smtpPort}</span>
      </button>
    `;
  }).join('');

  smtpInfoAccounts.innerHTML = html;

  // Wire up click handlers
  smtpInfoAccounts.querySelectorAll('.smtp-filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const filterKey = btn.getAttribute('data-filter-account');
      selectedAccount = filterKey;
      if (workspaceSelect) workspaceSelect.value = filterKey;
      generatedPreviews.clear();
      selectedSites.clear();
      batchStatusBanner.classList.add('hidden');
      updateActionButtons();
      updateSmtpInfoBarActive();
      loadOverview(monthSelect ? monthSelect.value : null, selectedAccount);
    });
  });
}

function updateSmtpInfoBarActive() {
  if (!smtpInfoAccounts) return;
  smtpInfoAccounts.querySelectorAll('.smtp-filter-pill').forEach((btn) => {
    const key = btn.getAttribute('data-filter-account');
    const isActive = key === selectedAccount || (key === 'all' && (!selectedAccount || selectedAccount === 'all'));
    btn.classList.toggle('pill-active', isActive);
  });
}

function populateFromSelect(preferredKey = null) {
  if (!editFromSelect || allAccountConfigs.length === 0) return;
  const prev = preferredKey || editFromSelect.value;
  editFromSelect.innerHTML = allAccountConfigs.map((a) =>
    `<option value="${escapeHtml(a.key)}">${escapeHtml(a.key)} — ${escapeHtml(a.fromName)} &lt;${escapeHtml(a.fromEmail)}&gt;</option>`
  ).join('');
  if (prev && allAccountConfigs.some((a) => a.key === prev)) {
    editFromSelect.value = prev;
  }
  updateFromDetails();
}

function updateFromDetails() {
  if (!editFromSelect || !editFromDetails) return;
  const selectedKey = editFromSelect.value;
  const acct = allAccountConfigs.find((a) => a.key === selectedKey);
  if (!acct) { editFromDetails.innerHTML = ''; return; }
  const cls = acct.key.toLowerCase();
  editFromDetails.className = `from-details-pill pill-${cls}`;
  editFromDetails.innerHTML = `
    <span class="pill-from-name">${escapeHtml(acct.fromName)}</span>
    <span class="pill-from-email">&lt;${escapeHtml(acct.fromEmail)}&gt;</span>
  `;
}

if (editFromSelect) {
  editFromSelect.addEventListener('change', updateFromDetails);
}

// --- Helper Toast Notification ---
function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `toast toast-${type}`;
  setTimeout(() => {
    toast.className = 'toast hidden';
  }, 4000);
}

// --- Fetch Overview Data ---
async function loadOverview(month = null, account = null) {
  try {
    sitesTableBody.innerHTML = `
      <tr>
        <td colspan="10" class="table-loading">
          <div class="spinner"></div>
          <p>Loading spreadsheet data...</p>
        </td>
      </tr>
    `;

    const targetMonth = month || (monthSelect ? monthSelect.value : null);
    const targetAccount = account || selectedAccount || 'all';

    const params = new URLSearchParams();
    if (targetMonth) params.set('month', targetMonth);
    if (targetAccount && targetAccount !== 'all') params.set('account', targetAccount);

    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`/api/overview${qs}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to fetch overview');
    }

    currentOverview = await res.json();
    populateWorkspaceSelect();
    populateMonthSelect();
    updateActionButtons();
    renderStats();
    renderSitesTable();
  } catch (err) {
    console.error('Error loading overview:', err);
    showToast(`Error loading data: ${err.message}`, 'error');
    sitesTableBody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align: center; color: #ef4444; padding: 32px;">
          Failed to load data: ${err.message}
        </td>
      </tr>
    `;
  }
}

// --- Populate Workspace Dropdown ---
function populateWorkspaceSelect() {
  if (!currentOverview || !workspaceSelect) return;
  if (currentOverview.accounts && currentOverview.accounts.length > 0) {
    const currentVal = selectedAccount;
    workspaceSelect.innerHTML = `<option value="all">All Workspaces (CW &amp; RM)</option>`;
    for (const a of currentOverview.accounts) {
      const opt = document.createElement('option');
      opt.value = a.key;
      const icon = a.key === 'CW' ? '🔷' : '🔶';
      opt.textContent = `${icon} ${a.name} (${a.key})`;
      if (a.key === currentVal) opt.selected = true;
      workspaceSelect.appendChild(opt);
    }
    workspaceSelect.value = currentVal;
  }
}

// --- Populate Month Dropdown ---
function populateMonthSelect() {
  if (!currentOverview) return;
  monthSelect.innerHTML = '';

  for (const m of currentOverview.availableMonths) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === currentOverview.selectedMonth.name) {
      opt.selected = true;
    }
    monthSelect.appendChild(opt);
  }
}

function getSentCount() {
  return sentHistory.filter(h => h.status === 'sent').length;
}

function isSiteSent(websiteUrl) {
  return sentHistory.some(h => h.websiteUrl.toLowerCase() === websiteUrl.toLowerCase() && h.status === 'sent');
}

function getUnsentReadyCount() {
  if (!currentOverview) return 0;
  return currentOverview.sites.filter(s => s.status === 'ready' && !isSiteSent(s.websiteUrl)).length;
}

// --- Update Top Action Buttons ---
function updateActionButtons() {
  const unsentCount = getUnsentReadyCount();
  const hasGenerated = generatedPreviews.size > 0;

  if (hasGenerated && unsentCount > 0) {
    sendRemainingBtn.disabled = false;
    sendRemainingBtn.classList.remove('disabled');
    sendRemainingBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
      2. Send Ready Reports (${unsentCount})
    `;
    bannerReadyCount.textContent = unsentCount;
    batchStatusBanner.classList.remove('hidden');
  } else if (hasGenerated && unsentCount === 0) {
    sendRemainingBtn.disabled = true;
    sendRemainingBtn.classList.add('disabled');
    sendRemainingBtn.textContent = 'All Ready Reports Sent ✓';
    batchStatusBanner.classList.add('hidden');
  } else {
    sendRemainingBtn.disabled = true;
    sendRemainingBtn.classList.add('disabled');
    sendRemainingBtn.textContent = '2. Send All Ready Reports';
    batchStatusBanner.classList.add('hidden');
  }

  // Selection + ClickUp Sync Selected Buttons
  if (selectedSites.size > 0) {
    sendSelectedBtn.classList.remove('hidden');
    selectionBar.classList.remove('hidden');
    selectedCountText.textContent = selectedSites.size;
    selectionText.textContent = `${selectedSites.size} website${selectedSites.size > 1 ? 's' : ''} selected`;
    if (cuSyncSelectedCount) cuSyncSelectedCount.textContent = selectedSites.size;
    if (cuSendSelectedClickUpBtn) cuSendSelectedClickUpBtn.classList.remove('hidden');
  } else {
    sendSelectedBtn.classList.add('hidden');
    selectionBar.classList.add('hidden');
    if (cuSendSelectedClickUpBtn) cuSendSelectedClickUpBtn.classList.add('hidden');
  }
}

// --- Render Overview Stats ---
function renderStats() {
  if (!currentOverview) return;
  const { stats, sites } = currentOverview;
  const sentCount = getSentCount();
  const unsentReadyCount = getUnsentReadyCount();

  statTotalSites.textContent = stats.totalSites;
  statActive.textContent = stats.totalActive;
  statReady.textContent = stats.totalReady;
  statInProgress.textContent = stats.totalInProgress;
  statGenerated.textContent = generatedPreviews.size;
  statSent.textContent = sentCount;

  countAll.textContent = sites.length;
  countReady.textContent = stats.totalReady;
  countUnsent.textContent = unsentReadyCount;
  countSent.textContent = sentCount;
  countInProgress.textContent = stats.totalInProgress;
  countInactive.textContent = stats.totalInactive;

  renderHistoryTable();
  // Keep ClickUp bulk bar count fresh
  updateCuBulkCount();
}

// --- Render Table Rows ---
function renderSitesTable() {
  if (!currentOverview) return;

  const filteredSites = currentOverview.sites.filter((site) => {
    const isSent = isSiteSent(site.websiteUrl);

    if (currentFilter === 'ready' && site.status !== 'ready') return false;
    if (currentFilter === 'unsent' && (site.status !== 'ready' || isSent)) return false;
    if (currentFilter === 'sent' && !isSent) return false;
    if (currentFilter === 'in_progress' && (site.status !== 'in_progress' && site.status !== 'pending')) return false;
    if (currentFilter === 'inactive' && site.status !== 'inactive') return false;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchUrl = site.websiteUrl.toLowerCase().includes(q);
      const matchContacts = site.contacts.some((c) => c.toLowerCase().includes(q));
      const matchCompany = site.company.toLowerCase().includes(q);
      const matchAm = site.accountManager.toLowerCase().includes(q);
      const matchAcct = (site.account || '').toLowerCase().includes(q) || (site.accountName || '').toLowerCase().includes(q);
      if (!matchUrl && !matchContacts && !matchCompany && !matchAm && !matchAcct) return false;
    }
    return true;
  });

  if (filteredSites.length === 0) {
    sitesTableBody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center; padding: 40px; color: var(--text-muted);">
          No websites found matching your criteria.
        </td>
      </tr>
    `;
    selectAllCheckbox.checked = false;
    return;
  }

  const allVisibleSelected = filteredSites.every(s => selectedSites.has(s.websiteUrl));
  selectAllCheckbox.checked = allVisibleSelected;

  sitesTableBody.innerHTML = filteredSites
    .map((site) => {
      const isSent = isSiteSent(site.websiteUrl);
      const preview = generatedPreviews.get(site.websiteUrl);
      const isSelected = selectedSites.has(site.websiteUrl);

      let statusBadge = `<span class="badge badge-inactive">Inactive</span>`;
      if (isSent) {
        statusBadge = `<span class="badge badge-sent">✓ Sent</span>`;
      } else if (site.status === 'ready') {
        statusBadge = `<span class="badge badge-ready">Ready to Send</span>`;
      } else if (site.status === 'in_progress') {
        statusBadge = `<span class="badge badge-in_progress">In Progress</span>`;
      } else if (site.status === 'pending') {
        statusBadge = `<span class="badge badge-in_progress">Pending</span>`;
      } else if (site.status === 'no_contact') {
        statusBadge = `<span class="badge badge-no_contact">No Contact</span>`;
      } else if (site.status === 'no_tab') {
        statusBadge = `<span class="badge badge-no_tab">No Tab</span>`;
      }

      const editedBadge = preview && preview.isCustomEdited
        ? `<span class="tag tag-edited" title="Custom edits saved">✏️ Edited</span>`
        : '';

      const monthStatusDisplay = site.monthCell
        ? `<strong>${escapeHtml(site.monthCell)}</strong>`
        : '<span style="color:var(--text-subtle);">&mdash;</span>';

      const acctClass = (site.account || 'cw').toLowerCase();
      const acctBadge = `<span class="badge-account badge-${acctClass}" title="${escapeHtml(site.accountName)} (from: ${escapeHtml(site.fromEmail)})">${escapeHtml(site.account || 'CW')}</span>`;

      // A blank cell stays visibly blank. It is not a guess and not a link to
      // the wrong column, which is the failure a hardcoded index would give on
      // the sheet that carries this column somewhere else.
      const timeTrackHref = safeExternalUrl(site.timeTrackUrl);
      const timeTrackCell = timeTrackHref
        ? `<a href="${escapeHtml(timeTrackHref)}" target="_blank" rel="noopener noreferrer"
              class="btn btn-secondary btn-sm" title="${escapeHtml(timeTrackHref)}">Time Track</a>`
        : (site.timeTrackUrl
          ? `<span style="color:var(--text-subtle); font-size:11px;" title="Not a usable http(s) link">Not a link</span>`
          : '<span style="color:var(--text-subtle);">&mdash;</span>');

      return `
        <tr>
          <td class="col-checkbox">
            <input type="checkbox" class="site-checkbox" data-url="${escapeHtml(site.websiteUrl)}" ${isSelected ? 'checked' : ''}>
          </td>
          <td class="col-account">${acctBadge}</td>
          <td class="col-website">
            <div style="font-weight: 600; color: #ffffff; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span class="site-domain">${escapeHtml(site.websiteUrl)}</span>
              ${editedBadge}
            </div>
            ${site.company ? `<div class="site-company">${escapeHtml(site.company)}</div>` : ''}
          </td>
          <td class="col-status">${statusBadge}</td>
          <td class="col-month">${monthStatusDisplay}</td>
          <td class="col-contacts">
            <div class="contacts-wrapper">
              ${site.contacts.length > 0
          ? site.contacts.map(c => `<div class="contact-email">${escapeHtml(c)}</div>`).join('')
          : '<span style="color:var(--text-subtle); font-size:11px;">(None)</span>'}
            </div>
          </td>
          <td class="col-tab">
            ${site.matchedTab
          ? `<span class="tag tag-tab" title="${escapeHtml(site.matchedTab)}">${escapeHtml(site.matchedTab.slice(0, 24))}${site.matchedTab.length > 24 ? '...' : ''}</span>`
          : '<span style="color:var(--text-subtle); font-size:11px;">(No tab)</span>'}
          </td>
          <td class="col-timetrack">
            ${timeTrackCell}
          </td>
          <td class="col-meta">
            <div style="font-size:12px;">${escapeHtml(site.cms || '&mdash;')}</div>
            <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(site.accountManager || '')}</div>
          </td>
          <td class="col-action" style="text-align: right;">
            <button class="btn btn-secondary btn-sm preview-btn" data-url="${escapeHtml(site.websiteUrl)}" data-account="${escapeHtml(site.account || 'CW')}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              ${preview ? 'Review' : 'Preview'}
            </button>
          </td>
        </tr>
      `;
    })
    .join('');

  // Row Checkbox Listeners
  document.querySelectorAll('.site-checkbox').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const url = cb.getAttribute('data-url');
      if (e.target.checked) selectedSites.add(url);
      else selectedSites.delete(url);
      updateActionButtons();
    });
  });

  // Preview Button Listeners
  document.querySelectorAll('.preview-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.getAttribute('data-url');
      const acct = btn.getAttribute('data-account') || 'CW';
      openPreviewModal(url, acct);
    });
  });
}

// --- Select All Visible Checkbox ---
selectAllCheckbox.addEventListener('change', (e) => {
  const checkboxes = document.querySelectorAll('.site-checkbox');
  checkboxes.forEach((cb) => {
    const url = cb.getAttribute('data-url');
    cb.checked = e.target.checked;
    if (e.target.checked) selectedSites.add(url);
    else selectedSites.delete(url);
  });
  updateActionButtons();
});

// Selection actions
selectUnsentBtn.addEventListener('click', () => {
  if (!currentOverview) return;
  currentOverview.sites.forEach((site) => {
    if (site.status === 'ready' && !isSiteSent(site.websiteUrl)) {
      selectedSites.add(site.websiteUrl);
    }
  });
  renderSitesTable();
  updateActionButtons();
});

clearSelectionBtn.addEventListener('click', () => {
  selectedSites.clear();
  renderSitesTable();
  updateActionButtons();
});

// --- Open Single Preview & Editor Modal ---
async function openPreviewModal(websiteUrl, account = null) {
  try {
    currentPreviewSite = null;
    modalSiteTitle.textContent = `Loading Preview for ${websiteUrl}...`;
    modalTabTag.textContent = 'Matching tab...';
    modalPremiumTag.classList.add('hidden');
    modalIssuesTag.classList.add('hidden');
    modalEditedTag.classList.add('hidden');
    editToInput.value = '';
    editSubjectInput.value = '';
    rawHtmlTextarea.value = '';
    previewIframe.srcdoc = '<p style="font-family:sans-serif;padding:20px;color:#666;">Rendering live email preview from Google Sheet...</p>';

    switchEditorTab('visual');
    previewModal.classList.remove('hidden');

    let previewData = generatedPreviews.get(websiteUrl);

    if (!previewData) {
      const acctParam = account ? `&account=${encodeURIComponent(account)}` : '';
      const res = await fetch(`/api/preview?websiteUrl=${encodeURIComponent(websiteUrl)}&month=${encodeURIComponent(currentOverview.selectedMonth.name)}${acctParam}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to generate preview');
      }
      previewData = await res.json();
      previewData.isCustomEdited = false;
      previewData.baseHtml = previewData.html; // store original for smart merge on refresh
      generatedPreviews.set(websiteUrl, previewData);
    }

    currentPreviewSite = previewData;
    modalSiteTitle.textContent = `Report: ${previewData.websiteUrl}`;

    const acctKey = previewData.account || 'CW';
    modalAccountTag.textContent = `${acctKey} (${previewData.fromEmail || 'SMTP'})`;
    modalAccountTag.className = `tag tag-account ${acctKey.toLowerCase()}`;

    // Set From selector to the site's account by default
    populateFromSelect(acctKey);

    modalTabTag.textContent = previewData.matchedTab ? `Tab: "${previewData.matchedTab}"` : 'No Tab Found';

    if (previewData.hasPremiumPlugins) modalPremiumTag.classList.remove('hidden');
    if (previewData.hasAdditionalIssues) modalIssuesTag.classList.remove('hidden');
    if (previewData.isCustomEdited) modalEditedTag.classList.remove('hidden');

    editToInput.value = Array.isArray(previewData.contacts) ? previewData.contacts.join(', ') : previewData.contacts;
    editSubjectInput.value = previewData.subject;
    rawHtmlTextarea.value = previewData.html;
    previewIframe.srcdoc = previewData.html;

    // Resolve Account Manager & Time Track from overview if missing in preview
    const overviewSite = currentOverview?.sites?.find((s) => {
      const cleanS = (s.websiteUrl || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      const cleanW = websiteUrl.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      return cleanS === cleanW || cleanS.includes(cleanW) || cleanW.includes(cleanS);
    });

    previewData.accountManager = previewData.accountManager || overviewSite?.accountManager || '';
    previewData.timeTrackUrl = previewData.timeTrackUrl || overviewSite?.timeTrackUrl || '';

    // Reset ClickUp UI & feedback
    if (cuLiveFeedbackBanner) {
      cuLiveFeedbackBanner.className = 'cu-feedback-banner hidden';
      cuLiveFeedbackBanner.textContent = '';
    }
    // Sync checkboxes to the current global send mode (set via the bulk bar)
    syncModalCheckboxesToMode();

    // Load ClickUp Task Preview
    loadClickUpTaskPreview({
      timeTrackUrl: previewData.timeTrackUrl,
      websiteUrl: previewData.websiteUrl,
      accountManager: previewData.accountManager,
      month: currentOverview?.selectedMonth?.name || '',
    });
  } catch (err) {
    console.error('Preview error:', err);
    showToast(`Error: ${err.message}`, 'error');
    previewIframe.srcdoc = `<div style="font-family:sans-serif;padding:20px;color:#ef4444;"><h3>Preview Failed</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

// --- Editor Tabs (Visual vs Raw HTML) ---
function switchEditorTab(tab) {
  activeEditorTab = tab;
  if (tab === 'visual') {
    tabVisualPreview.classList.add('active');
    tabHtmlEditor.classList.remove('active');
    previewFrameContainer.classList.remove('hidden');
    htmlEditorContainer.classList.add('hidden');
    applyHtmlBtn.classList.add('hidden');
    if (rawHtmlTextarea.value) {
      previewIframe.srcdoc = rawHtmlTextarea.value;
    }
  } else {
    tabVisualPreview.classList.remove('active');
    tabHtmlEditor.classList.add('active');
    previewFrameContainer.classList.add('hidden');
    htmlEditorContainer.classList.remove('hidden');
    applyHtmlBtn.classList.remove('hidden');
  }
}

tabVisualPreview.addEventListener('click', () => switchEditorTab('visual'));
tabHtmlEditor.addEventListener('click', () => switchEditorTab('html'));

applyHtmlBtn.addEventListener('click', () => {
  previewIframe.srcdoc = rawHtmlTextarea.value;
  showToast('Visual preview updated from HTML code!');
  switchEditorTab('visual');
});

// --- Save Custom Changes to In-Memory Preview ---
modalSaveCustomBtn.addEventListener('click', () => {
  if (!currentPreviewSite) return;

  const toRecipients = editToInput.value.split(',').map((e) => e.trim()).filter(Boolean);
  const subject = editSubjectInput.value.trim();
  const html = rawHtmlTextarea.value.trim() || currentPreviewSite.html;

  // Extract what was added/changed vs the original sheet HTML so we can
  // re-apply it automatically after a refresh (smart merge).
  const injection = extractCustomInjection(
    currentPreviewSite.baseHtml || currentPreviewSite.html,
    html
  );

  currentPreviewSite.contacts = toRecipients;
  currentPreviewSite.subject = subject;
  currentPreviewSite.html = html;
  currentPreviewSite.isCustomEdited = true;
  if (injection) {
    currentPreviewSite.customInjection = injection.injectedHtml;
    currentPreviewSite.injectionAnchor = injection.anchor;
  }

  generatedPreviews.set(currentPreviewSite.websiteUrl, currentPreviewSite);
  modalEditedTag.classList.remove('hidden');
  showToast('Custom changes saved! Will be re-applied automatically after refresh.');
  renderSitesTable();
});

// --- Send Single Email from Modal ---
modalSendSingleBtn.addEventListener('click', async () => {
  if (!currentPreviewSite) return;

  const toRecipients = editToInput.value.split(',').map((e) => e.trim()).filter(Boolean);
  const subject = editSubjectInput.value.trim();
  const html = rawHtmlTextarea.value.trim() || currentPreviewSite.html;
  // Use selected From account (may differ from original site account)
  const acct = (editFromSelect ? editFromSelect.value : null) || currentPreviewSite.account || 'CW';
  const fromAcctConfig = allAccountConfigs.find((a) => a.key === acct);
  const fromEmailDisplay = fromAcctConfig ? fromAcctConfig.fromEmail : currentPreviewSite.fromEmail;

  if (toRecipients.length === 0) {
    alert('Please enter at least one valid recipient email.');
    return;
  }

  // --- ClickUp Send Options & Action Logic ---
  const doEmail = optSendEmail ? optSendEmail.checked : true;
  const doClickUp = optSyncClickUp ? optSyncClickUp.checked : false;

  if (!doEmail && doClickUp) {
    executeSyncClickUpAlone();
    return;
  }

  if (toRecipients.length === 0) {
    alert('Please enter at least one valid recipient email.');
    return;
  }

  const actionDesc = doClickUp ? 'send this report AND update ClickUp task to Closed' : 'send this report';
  if (!confirm(`Are you sure you want to ${actionDesc} via ${acct} (${fromEmailDisplay}) to ${toRecipients.join(', ')}?`)) {
    return;
  }

  modalSendSingleBtn.disabled = true;
  if (modalSendBtnLabel) modalSendBtnLabel.textContent = 'Processing...';
  if (modalSyncClickUpOnlyBtn) modalSyncClickUpOnlyBtn.disabled = true;

  if (cuLiveFeedbackBanner) {
    cuLiveFeedbackBanner.className = 'cu-feedback-banner banner-info';
    cuLiveFeedbackBanner.innerHTML = `⏳ Sending email via ${acct}... ${doClickUp ? 'and updating ClickUp task...' : ''}`;
  }

  try {
    const res = await fetch('/api/send-single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: toRecipients,
        subject,
        html,
        account: acct,
        dryRun: false,
        syncClickUp: doClickUp,
        websiteUrl: currentPreviewSite.websiteUrl,
        timeTrackUrl: currentPreviewSite.timeTrackUrl,
        accountManager: currentPreviewSite.accountManager,
        monthName: currentOverview?.selectedMonth?.name || '',
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to send email');
    }

    const data = await res.json();
    let cuMsg = '';
    if (data.clickup) {
      if (data.clickup.dryRun) {
        cuMsg = ` | ClickUp (Dry Run): Task #${data.clickup.taskId} simulated as Closed`;
      } else if (data.clickup.success) {
        cuMsg = ` | ClickUp: Task #${data.clickup.taskId} Closed`;
      } else if (data.clickup.error) {
        cuMsg = ` | ClickUp Error: ${data.clickup.error}`;
      }
    }

    recordDelivery({
      time: new Date().toLocaleTimeString(),
      account: acct,
      websiteUrl: currentPreviewSite.websiteUrl,
      to: toRecipients.join(', '),
      subject,
      status: 'sent',
      details: `Sent via ${acct} SMTP (${fromEmailDisplay})${cuMsg}`,
      isDryRun: false,
    });

    if (data.clickup && data.clickup.dryRun) {
      showToast(`✅ Email sent to ${toRecipients.join(', ')}! (ClickUp dry-run simulated for task #${data.clickup.taskId})`);
    } else if (data.clickup && data.clickup.success) {
      showToast(`✅ Email sent and ClickUp task #${data.clickup.taskId} closed!`);
    } else {
      showToast(`✅ Email successfully sent via ${acct} to ${toRecipients.join(', ')}!`);
    }

    previewModal.classList.add('hidden');
    updateActionButtons();
    renderStats();
    renderSitesTable();
  } catch (err) {
    console.error('Send error:', err);
    if (cuLiveFeedbackBanner) {
      cuLiveFeedbackBanner.className = 'cu-feedback-banner banner-error';
      cuLiveFeedbackBanner.innerHTML = `❌ <strong>Send Failed:</strong> ${escapeHtml(err.message)}`;
    }
    recordDelivery({
      time: new Date().toLocaleTimeString(),
      account: acct,
      websiteUrl: currentPreviewSite.websiteUrl,
      to: toRecipients.join(', '),
      subject,
      status: 'failed',
      details: err.message,
      isDryRun: false,
    });
    showToast(`Failed to send: ${err.message}`, 'error');
  } finally {
    modalSendSingleBtn.disabled = false;
    if (modalSyncClickUpOnlyBtn) modalSyncClickUpOnlyBtn.disabled = false;
    updateSendActionButtons();
  }
});

// --- ClickUp Task Preview Loader ---
async function loadClickUpTaskPreview({ timeTrackUrl, websiteUrl, accountManager, month }) {
  // Guard: if the sync panel doesn't exist (different page), bail silently
  if (!clickupSyncPanel) return;

  // Helper to safely set text or html on an element
  const safeText = (el, val) => { if (el) el.textContent = val; };
  const safeHtml  = (el, val) => { if (el) el.innerHTML = val; };
  const safeClass = (el, cls) => { if (el) el.className = cls; };

  // Reset UI to loading state
  safeClass(clickupTaskStatusBadge, 'cu-badge cu-badge-pending');
  safeText(clickupTaskStatusBadge, 'Checking Status...');
  safeText(cuTaskId, timeTrackUrl ? 'Resolving ID...' : 'No Task URL in Sheet');
  if (cuTaskExternalLink) cuTaskExternalLink.classList.add('hidden');
  safeClass(cuLiveStatusPill, 'cu-status-pill');
  safeText(cuLiveStatusPill, 'Checking...');
  safeText(cuAmName, accountManager || 'None in sheet');
  safeHtml(cuAmResolvedBadge, '<span class="cu-user-mention">Resolving...</span>');
  safeText(cuCommentPreviewText, 'Generating notification preview...');

  // Disable sync button while loading
  if (modalSyncClickUpOnlyBtn) modalSyncClickUpOnlyBtn.disabled = true;

  try {
    const params = new URLSearchParams({
      timeTrackUrl: timeTrackUrl || '',
      websiteUrl:   websiteUrl   || '',
      accountManager: accountManager || '',
      month: month || '',
    });

    const res = await fetch(`/api/clickup/preview-task?${params.toString()}`);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Server returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    currentClickUpPreview = data;

    // --- 1. Task ID & External Link ---
    if (data.taskId) {
      safeText(cuTaskId, `#${data.taskId}`);
      if (cuTaskExternalLink && data.timeTrackUrl) {
        cuTaskExternalLink.href = data.timeTrackUrl;
        cuTaskExternalLink.classList.remove('hidden');
      }
    } else {
      safeText(cuTaskId, 'No Task URL in Sheet');
      if (cuTaskExternalLink) cuTaskExternalLink.classList.add('hidden');
    }

    // --- 2. Status Badge (header) ---
    if (!data.taskId) {
      safeClass(clickupTaskStatusBadge, 'cu-badge cu-badge-no-task');
      safeText(clickupTaskStatusBadge, 'No Task URL');
    } else if (data.statusBadge === 'already_closed') {
      safeClass(clickupTaskStatusBadge, 'cu-badge cu-badge-closed');
      safeText(clickupTaskStatusBadge, 'Already Closed');
    } else if (data.statusBadge === 'warning') {
      safeClass(clickupTaskStatusBadge, 'cu-badge cu-badge-pending');
      safeText(clickupTaskStatusBadge, '⚠ Token / API Warning');
    } else if (data.autoCloseEnabled) {
      safeClass(clickupTaskStatusBadge, 'cu-badge cu-badge-ready');
      safeText(clickupTaskStatusBadge, '● Ready (Live)');
    } else {
      safeClass(clickupTaskStatusBadge, 'cu-badge cu-badge-ready');
      safeText(clickupTaskStatusBadge, '● Ready (Dry-Run Safe)');
    }

    // --- 3. Live Status Pill ---
    const liveStatus = data.currentStatus || 'Unknown';
    safeText(cuLiveStatusPill, liveStatus);
    if (liveStatus.toLowerCase() === 'closed') {
      safeClass(cuLiveStatusPill, 'cu-status-pill cu-status-pill-closed');
    } else if (liveStatus === 'lookup-error' || liveStatus === 'none') {
      safeClass(cuLiveStatusPill, 'cu-status-pill');
      if (cuLiveStatusPill) cuLiveStatusPill.style.opacity = '0.6';
    } else {
      safeClass(cuLiveStatusPill, 'cu-status-pill');
      if (cuLiveStatusPill) cuLiveStatusPill.style.opacity = '1';
    }

    // --- 4. Account Manager Display ---
    safeText(cuAmName, data.accountManager?.raw || accountManager || 'None (Support Team)');

    if (data.accountManager?.isNonPerson) {
      safeHtml(cuAmResolvedBadge, '<span class="cu-user-mention" style="background:rgba(100,116,139,0.2);color:#94a3b8;border-color:rgba(100,116,139,0.3);">Support Team — no mention</span>');
    } else if (data.accountManager?.matchedUsers?.length > 0) {
      const badges = data.accountManager.matchedUsers.map((u) =>
        `<span class="cu-user-mention" title="ClickUp ID: ${u.id} | Email: ${escapeHtml(u.email || '')}">@${u.id} <em style="font-style:normal;opacity:.7">(${escapeHtml(u.name)})</em></span>`
      );
      if (data.accountManager.unmatchedNames?.length > 0) {
        data.accountManager.unmatchedNames.forEach((n) => {
          badges.push(`<span class="cu-user-mention" style="background:rgba(245,158,11,0.15);color:#fbbf24;border-color:rgba(245,158,11,0.3);">AM: ${escapeHtml(n)} <em style="font-style:normal;opacity:.6">(plaintext)</em></span>`);
        });
      }
      safeHtml(cuAmResolvedBadge, badges.join(' '));
    } else if (data.accountManager?.unmatchedNames?.length > 0) {
      const badges = data.accountManager.unmatchedNames.map((n) =>
        `<span class="cu-user-mention" style="background:rgba(245,158,11,0.15);color:#fbbf24;border-color:rgba(245,158,11,0.3);">AM: ${escapeHtml(n)} <em style="font-style:normal;opacity:.6">(plaintext fallback)</em></span>`
      );
      safeHtml(cuAmResolvedBadge, badges.join(' '));
    } else {
      safeHtml(cuAmResolvedBadge, '<span style="color:var(--text-muted);font-size:12px;">— (no AM in sheet)</span>');
    }

    // --- 5. Safety Guard Badge ---
    if (cuSafetyGuardBadge) {
      if (!data.hasToken) {
        cuSafetyGuardBadge.textContent = '⚠ No API Token (comment preview only)';
        cuSafetyGuardBadge.style.cssText = 'color:#fbbf24;background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.3)';
      } else if (data.autoCloseEnabled) {
        cuSafetyGuardBadge.textContent = '⚡ Live Mutations Active';
        cuSafetyGuardBadge.style.cssText = 'color:#34d399;background:rgba(16,185,129,0.12);border-color:rgba(16,185,129,0.3)';
      } else {
        cuSafetyGuardBadge.textContent = '🛡️ Dry-Run Safe (Guarded)';
        cuSafetyGuardBadge.style.cssText = 'color:#38bdf8;background:rgba(56,189,248,0.12);border-color:rgba(56,189,248,0.25)';
      }
    }

    // --- 6. Comment Preview (with @mention highlighting) ---
    const rawComment = data.commentText || '';
    if (rawComment) {
      const highlighted = escapeHtml(rawComment).replace(/(@\d+)/g, '<mark class="cu-hl-mention">$1</mark>');
      safeHtml(cuCommentPreviewText, highlighted);
    } else {
      safeText(cuCommentPreviewText, '(No comment will be posted — no task URL or AM found)');
    }

    // --- 7. Show task warning below comment if lookup failed ---
    if (data.taskError && cuLiveFeedbackBanner) {
      cuLiveFeedbackBanner.className = 'cu-feedback-banner banner-warning';
      cuLiveFeedbackBanner.innerHTML = `⚠️ <strong>Task Status Lookup:</strong> ${escapeHtml(data.taskError)}. Comment preview is accurate — close/notify will still work when you send.`;
    }

    // --- 8. Enable sync button ---
    if (modalSyncClickUpOnlyBtn) {
      modalSyncClickUpOnlyBtn.disabled = !data.taskId;
      modalSyncClickUpOnlyBtn.title = data.taskId
        ? 'Update ClickUp task & post comment without sending client email'
        : 'No ClickUp time-track URL found in the Google Sheet for this site';
    }

  } catch (err) {
    console.warn('[ClickUp Preview] Failed to load preview:', err.message);
    // Show graceful degraded state — never crash the whole modal
    safeClass(clickupTaskStatusBadge, 'cu-badge cu-badge-no-task');
    safeText(clickupTaskStatusBadge, '⚠ Preview Unavailable');
    safeText(cuTaskId, 'Could not fetch');
    if (cuTaskExternalLink) cuTaskExternalLink.classList.add('hidden');
    safeText(cuLiveStatusPill, 'Unknown');
    safeHtml(cuAmResolvedBadge, `<span style="color:#94a3b8;font-size:12px;">${escapeHtml(accountManager || '—')}</span>`);

    // Still show the comment preview — it's built purely from local data
    if (accountManager && websiteUrl) {
      // Build the comment client-side as fallback (no API needed for this)
      const cleanUrl = websiteUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      safeText(cuCommentPreviewText, `(AM mention) We have completed Maintenance for the month of ${month || 'the current month'} and sent email to clients for ${cleanUrl}. FYI @49039188`);
    } else {
      safeText(cuCommentPreviewText, '(Preview unavailable — could not reach the ClickUp status API)');
    }

    if (cuLiveFeedbackBanner) {
      cuLiveFeedbackBanner.className = 'cu-feedback-banner banner-warning';
      cuLiveFeedbackBanner.innerHTML = `⚠️ <strong>ClickUp status check failed:</strong> ${escapeHtml(err.message)}<br><small>You can still send email and ClickUp sync will proceed independently with safety guards active.</small>`;
    }

    // Keep sync button usable if we at least have a URL
    if (modalSyncClickUpOnlyBtn) {
      modalSyncClickUpOnlyBtn.disabled = !timeTrackUrl;
      currentClickUpPreview = currentClickUpPreview || { taskId: null, commentText: null };
    }
  }
}

// --- Dynamic Button Label updater based on Send Checkboxes ---
function updateSendActionButtons() {
  if (!optSendEmail || !optSyncClickUp || !modalSendBtnLabel) return;
  const doEmail = optSendEmail.checked;
  const doClickUp = optSyncClickUp.checked;

  if (doEmail && doClickUp) {
    modalSendBtnLabel.textContent = 'Send Email + ClickUp';
    modalSendSingleBtn.disabled = false;
    modalSendSingleBtn.className = 'btn btn-success';
  } else if (doEmail && !doClickUp) {
    modalSendBtnLabel.textContent = 'Send Email Only';
    modalSendSingleBtn.disabled = false;
    modalSendSingleBtn.className = 'btn btn-success';
  } else if (!doEmail && doClickUp) {
    modalSendBtnLabel.textContent = 'Sync ClickUp Alone';
    modalSendSingleBtn.disabled = false;
    modalSendSingleBtn.className = 'btn btn-purple';
  } else {
    modalSendBtnLabel.textContent = 'Select Send Option';
    modalSendSingleBtn.disabled = true;
    modalSendSingleBtn.className = 'btn btn-secondary';
  }
}

if (optSendEmail) optSendEmail.addEventListener('change', updateSendActionButtons);
if (optSyncClickUp) optSyncClickUp.addEventListener('change', updateSendActionButtons);

// --- Sync ClickUp Alone (Without Email) ---
async function executeSyncClickUpAlone() {
  if (!currentPreviewSite) return;
  const taskId = currentClickUpPreview?.taskId;
  if (!taskId) {
    alert('No ClickUp task ID found for this site in the spreadsheet.');
    return;
  }

  if (!confirm(`Are you sure you want to complete ClickUp task #${taskId} and post the notification comment WITHOUT sending an email to the client?`)) {
    return;
  }

  if (modalSyncClickUpOnlyBtn) modalSyncClickUpOnlyBtn.disabled = true;
  modalSendSingleBtn.disabled = true;

  if (cuLiveFeedbackBanner) {
    cuLiveFeedbackBanner.className = 'cu-feedback-banner banner-info';
    cuLiveFeedbackBanner.innerHTML = `⏳ Updating ClickUp task #${taskId} status to Closed and posting comment...`;
  }

  try {
    const res = await fetch('/api/clickup/sync-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeTrackUrl: currentPreviewSite.timeTrackUrl,
        websiteUrl: currentPreviewSite.websiteUrl,
        accountManager: currentPreviewSite.accountManager,
        monthName: currentOverview?.selectedMonth?.name || '',
        dryRun: false,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'ClickUp sync failed');
    }

    const data = await res.json();
    const result = data.result || {};

    if (result.dryRun) {
      if (cuLiveFeedbackBanner) {
        cuLiveFeedbackBanner.className = 'cu-feedback-banner banner-warning';
        cuLiveFeedbackBanner.innerHTML = `🛡️ <strong>Dry-Run Simulated:</strong> Task #${result.taskId} would be marked Closed with AM mention.<br><small class="opacity-75">Notice: ${result.reason}</small>`;
      }
      showToast(`ClickUp dry-run completed for task #${result.taskId}!`);
    } else {
      if (cuLiveFeedbackBanner) {
        cuLiveFeedbackBanner.className = 'cu-feedback-banner banner-success';
        cuLiveFeedbackBanner.innerHTML = `✅ <strong>Success!</strong> Task #${result.taskId} marked as Closed and notification comment posted.`;
      }
      showToast(`✅ ClickUp task #${result.taskId} closed successfully!`);
    }

    // Refresh live badge in preview
    if (cuLiveStatusPill) {
      cuLiveStatusPill.textContent = 'Closed';
      cuLiveStatusPill.className = 'cu-status-pill cu-status-pill-closed';
    }
    if (clickupTaskStatusBadge) {
      clickupTaskStatusBadge.className = 'cu-badge cu-badge-closed';
      clickupTaskStatusBadge.textContent = 'Closed';
    }
  } catch (err) {
    console.error('ClickUp sync alone error:', err);
    if (cuLiveFeedbackBanner) {
      cuLiveFeedbackBanner.className = 'cu-feedback-banner banner-error';
      cuLiveFeedbackBanner.innerHTML = `❌ <strong>ClickUp Failed:</strong> ${escapeHtml(err.message)}`;
    }
    showToast(`ClickUp error: ${err.message}`, 'error');
  } finally {
    if (modalSyncClickUpOnlyBtn) modalSyncClickUpOnlyBtn.disabled = false;
    modalSendSingleBtn.disabled = false;
  }
}

if (modalSyncClickUpOnlyBtn) {
  modalSyncClickUpOnlyBtn.addEventListener('click', executeSyncClickUpAlone);
}

if (refreshClickUpBtn) {
  refreshClickUpBtn.addEventListener('click', () => {
    if (!currentPreviewSite) return;
    loadClickUpTaskPreview({
      timeTrackUrl: currentPreviewSite.timeTrackUrl,
      websiteUrl: currentPreviewSite.websiteUrl,
      accountManager: currentPreviewSite.accountManager,
      month: currentOverview?.selectedMonth?.name || '',
    });
  });
}

// --- Account Manager Directory Modal ---
async function openAmDirectoryModal() {
  if (!amDirectoryModal) return;
  amDirectoryModal.classList.remove('hidden');
  if (amSearchInput) amSearchInput.value = '';

  if (cachedAccountManagers) {
    renderAmDirectoryTable(cachedAccountManagers);
    return;
  }

  if (amDirectoryTableBody) {
    amDirectoryTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text-muted);">Loading verified Account Managers and ClickUp profiles...</td></tr>';
  }

  try {
    const res = await fetch('/api/clickup/account-managers');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cachedAccountManagers = data.accountManagers || [];
    if (amCountBadge) amCountBadge.textContent = `${cachedAccountManagers.length} Verified ClickUp Members`;
    renderAmDirectoryTable(cachedAccountManagers);
  } catch (err) {
    if (amDirectoryTableBody) {
      amDirectoryTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:#ef4444;">Failed to load account managers: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function renderAmDirectoryTable(list, query = '') {
  if (!amDirectoryTableBody) return;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? list.filter((m) => (m.name || '').toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q) || String(m.id).includes(q))
    : list;

  if (filtered.length === 0) {
    amDirectoryTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:#94a3b8;">No matching account managers found.</td></tr>';
    return;
  }

  amDirectoryTableBody.innerHTML = filtered.map((m) => `
    <tr>
      <td><strong>${escapeHtml(m.name)}</strong></td>
      <td><code class="am-id-code">@${m.id}</code></td>
      <td><span class="am-email-text">${escapeHtml(m.email)}</span></td>
      <td><span class="tag tag-issues" style="background:rgba(16,185,129,0.12);color:#34d399;border:1px solid rgba(16,185,129,0.3);">✓ Active</span></td>
    </tr>
  `).join('');
}

if (viewAllAmsBtn) viewAllAmsBtn.addEventListener('click', openAmDirectoryModal);
if (closeAmModalBtn) closeAmModalBtn.addEventListener('click', () => amDirectoryModal.classList.add('hidden'));
if (closeAmModalBottomBtn) closeAmModalBottomBtn.addEventListener('click', () => amDirectoryModal.classList.add('hidden'));
if (amSearchInput) {
  amSearchInput.addEventListener('input', (e) => {
    if (cachedAccountManagers) renderAmDirectoryTable(cachedAccountManagers, e.target.value);
  });
}

// --- Generate All Previews Flow ---
generateAllBtn.addEventListener('click', async () => {
  generateAllBtn.disabled = true;
  generateAllBtn.textContent = 'Generating Previews...';

  try {
    const res = await fetch('/api/generate-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        month: currentOverview.selectedMonth.name,
        account: selectedAccount,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to generate previews');
    }

    const data = await res.json();

    for (const p of data.previews) {
      const existing = generatedPreviews.get(p.websiteUrl);
      if (existing && existing.isCustomEdited) {
        // preserve edited fields
      } else {
        p.isCustomEdited = false;
        generatedPreviews.set(p.websiteUrl, p);
      }
    }

    showToast(`Generated ${data.generatedCount} email previews for review!`);
    updateActionButtons();
    renderStats();
    renderSitesTable();
  } catch (err) {
    console.error('Generate all error:', err);
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    generateAllBtn.disabled = false;
    generateAllBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
      </svg>
      1. Generate All Previews
    `;
  }
});

// --- Open Batch Modal ---
function openBatchModal(targetEmails, titleText) {
  if (targetEmails.length === 0) {
    alert('No unsent ready reports available to send.');
    return;
  }

  batchModalTitle.textContent = titleText;
  batchCountConfirm.textContent = targetEmails.length;
  batchMonthConfirm.textContent = currentOverview.selectedMonth.name;

  // Compute breakdown by account with smtp info
  const accountCounts = {};
  targetEmails.forEach((item) => {
    const acct = item.account || 'CW';
    accountCounts[acct] = (accountCounts[acct] || 0) + 1;
  });

  if (batchAccountBreakdown) {
    batchAccountBreakdown.innerHTML = Object.entries(accountCounts)
      .map(([acct, count]) => {
        const cfg = allAccountConfigs.find((a) => a.key === acct);
        const smtpInfo = cfg ? `${cfg.fromName} &lt;${escapeHtml(cfg.fromEmail)}&gt;` : acct;
        return `
          <div class="batch-smtp-row smtp-${acct.toLowerCase()}">
            <span class="badge-account badge-${acct.toLowerCase()}" style="flex-shrink:0;">${acct}</span>
            <span class="batch-smtp-count">${count}</span>
            <span class="batch-smtp-label">report${count !== 1 ? 's' : ''}</span>
            <span class="batch-smtp-via">via ${smtpInfo}</span>
          </div>
        `;
      })
      .join('');
  }

  batchConfirmView.classList.remove('hidden');
  batchProgressView.classList.add('hidden');
  confirmBatchSendBtn.classList.remove('hidden');
  cancelBatchBtn.textContent = 'Cancel';
  batchModal.classList.remove('hidden');

  batchModal._targetEmails = targetEmails;
}

// Send All Ready / Unsent
sendRemainingBtn.addEventListener('click', () => {
  const unsentReadyPreviews = [];
  currentOverview.sites.forEach((site) => {
    if (site.status === 'ready' && !isSiteSent(site.websiteUrl)) {
      const preview = generatedPreviews.get(site.websiteUrl);
      if (preview) unsentReadyPreviews.push(preview);
    }
  });

  openBatchModal(unsentReadyPreviews, `Send Ready Reports (${unsentReadyPreviews.length})`);
});

bannerSendBtn.addEventListener('click', () => {
  sendRemainingBtn.click();
});

// Send Selected
sendSelectedBtn.addEventListener('click', async () => {
  const selectedPreviews = [];
  for (const url of selectedSites) {
    let preview = generatedPreviews.get(url);
    if (!preview) {
      try {
        const siteObj = currentOverview.sites.find(s => s.websiteUrl === url);
        const acct = siteObj ? siteObj.account : 'CW';
        const res = await fetch(`/api/preview?websiteUrl=${encodeURIComponent(url)}&month=${encodeURIComponent(currentOverview.selectedMonth.name)}&account=${encodeURIComponent(acct)}`);
        if (res.ok) {
          preview = await res.json();
          preview.isCustomEdited = false;
          generatedPreviews.set(url, preview);
        }
      } catch (e) { }
    }
    if (preview) selectedPreviews.push(preview);
  }

  openBatchModal(selectedPreviews, `Send Selected Reports (${selectedPreviews.length})`);
});

// --- Execute Batch Send ---
confirmBatchSendBtn.addEventListener('click', async () => {
  const isDryRun = batchDryRunCheckbox.checked;
  const emailsToSend = batchModal._targetEmails || [];

  if (emailsToSend.length === 0) return;

  batchConfirmView.classList.add('hidden');
  batchProgressView.classList.remove('hidden');
  confirmBatchSendBtn.classList.add('hidden');
  cancelBatchBtn.disabled = true;

  batchLogBox.innerHTML = '';
  batchProgressBar.style.width = '0%';

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < emailsToSend.length; i++) {
    const item = emailsToSend[i];
    const acct = item.account || 'CW';
    batchProgressText.textContent = `[${acct}] Processing ${i + 1} of ${emailsToSend.length}: ${item.websiteUrl}...`;
    const percent = Math.round(((i + 1) / emailsToSend.length) * 100);
    batchProgressBar.style.width = `${percent}%`;
    batchProgressPercent.textContent = `${percent}%`;

    const toRecipients = Array.isArray(item.contacts) ? item.contacts : [item.contacts];

    try {
      await fetch('/api/send-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: toRecipients,
          subject: item.subject,
          html: item.html,
          account: acct,
          dryRun: isDryRun,
        }),
      });

      successCount++;
      recordDelivery({
        time: new Date().toLocaleTimeString(),
        account: acct,
        websiteUrl: item.websiteUrl,
        to: toRecipients.join(', '),
        subject: item.subject,
        status: 'sent',
        details: isDryRun ? `[${acct}] Dry-run preview generated` : `[${acct}] Sent via SMTP (${item.fromEmail || ''})`,
        isDryRun,
      });

      const logItem = document.createElement('div');
      logItem.className = 'log-item log-success';
      logItem.textContent = `${isDryRun ? '📝 [Dry Run]' : '✅ [Sent]'} [${acct}]: ${item.websiteUrl} -> ${toRecipients.join(', ')}`;
      batchLogBox.appendChild(logItem);
    } catch (err) {
      failCount++;
      recordDelivery({
        time: new Date().toLocaleTimeString(),
        account: acct,
        websiteUrl: item.websiteUrl,
        to: toRecipients.join(', '),
        subject: item.subject,
        status: 'failed',
        details: `[${acct}] ${err.message}`,
        isDryRun,
      });

      const logItem = document.createElement('div');
      logItem.className = 'log-item log-fail';
      logItem.textContent = `❌ [${acct}] Failed: ${item.websiteUrl} - ${err.message}`;
      batchLogBox.appendChild(logItem);
    }

    batchLogBox.scrollTop = batchLogBox.scrollHeight;
    await new Promise((r) => setTimeout(r, 250));
  }

  cancelBatchBtn.disabled = false;
  cancelBatchBtn.textContent = 'Done';
  batchProgressText.textContent = `Completed: ${successCount} successful, ${failCount} failed.`;
  showToast(`Batch execution finished: ${successCount} processed.`);
  updateActionButtons();
  renderStats();
  renderSitesTable();
});

// --- Delivery Records Management ---
function recordDelivery(record) {
  sentHistory.unshift(record);
  renderHistoryTable();
}

function renderHistoryTable() {
  historyCountBadge.textContent = `${sentHistory.length} record${sentHistory.length !== 1 ? 's' : ''}`;

  if (sentHistory.length === 0) {
    historyTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="history-empty">No emails sent yet in this session.</td>
      </tr>
    `;
    return;
  }

  historyTableBody.innerHTML = sentHistory
    .map((item) => {
      const badge = item.status === 'sent'
        ? (item.isDryRun ? '<span class="badge badge-in_progress">📝 Dry Run</span>' : '<span class="badge badge-sent">✅ Delivered</span>')
        : '<span class="badge badge-failed">❌ Failed</span>';

      const acctClass = (item.account || 'cw').toLowerCase();
      const acctBadge = `<span class="badge-account badge-${acctClass}">${escapeHtml(item.account || 'CW')}</span>`;

      return `
        <tr>
          <td style="color:var(--text-subtle);font-family:var(--font-mono);font-size:11px;">${item.time}</td>
          <td>${acctBadge}</td>
          <td><strong>${escapeHtml(item.websiteUrl)}</strong></td>
          <td style="font-family:var(--font-mono);font-size:11px;">${escapeHtml(item.to)}</td>
          <td style="font-size:11px;color:var(--text-muted);">${escapeHtml(item.subject)}</td>
          <td>${badge}</td>
          <td style="font-size:11px;color:var(--text-muted);">${escapeHtml(item.details)}</td>
        </tr>
      `;
    })
    .join('');
}

// --- Filter Tab Listeners ---
filterTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    filterTabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.getAttribute('data-filter');
    renderSitesTable();
  });
});

// --- Search Listener ---
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderSitesTable();
});

// --- Workspace Change Listener ---
if (workspaceSelect) {
  workspaceSelect.addEventListener('change', () => {
    selectedAccount = workspaceSelect.value;
    generatedPreviews.clear();
    selectedSites.clear();
    batchStatusBanner.classList.add('hidden');
    updateActionButtons();
    updateSmtpInfoBarActive();
    loadOverview(monthSelect.value || null, selectedAccount);
  });
}

// --- Month Change Listener ---
monthSelect.addEventListener('change', () => {
  const selected = monthSelect.value;
  generatedPreviews.clear();
  selectedSites.clear();
  batchStatusBanner.classList.add('hidden');
  updateActionButtons();
  loadOverview(selected, selectedAccount);
});

// --- Refresh Modal Elements ---
const refreshConfirmModal = document.getElementById('refreshConfirmModal');
const confirmRefreshBtn = document.getElementById('confirmRefreshBtn');
const cancelRefreshBtn = document.getElementById('cancelRefreshBtn');
const refreshEditedCount = document.getElementById('refreshEditedCount');

const REFRESH_BTN_DEFAULT_HTML = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
  </svg>
  Refresh`;

const REFRESH_BTN_LOADING_HTML = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite">
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
  </svg>
  Refreshing...`;

// Guard: prevent stacking multiple refresh cycles from rapid button clicks
let refreshInProgress = false;

// ─── Smart merge helpers ──────────────────────────────────────────────────────

// Find the LAST match of a global regex in a string. Returns {index, match} or null.
// Used instead of String#search() (which only ever returns the FIRST match) so
// that when a user's own added paragraph happens to contain the phrase
// "Best regards" (e.g. they typed a personal sign-off), we still anchor on the
// real template signature line rather than the one buried in their edit.
function lastMatch(str, globalRe) {
  let m, last = null;
  const re = new RegExp(globalRe.source, globalRe.flags.includes('g') ? globalRe.flags : globalRe.flags + 'g');
  while ((m = re.exec(str)) !== null) {
    last = { index: m.index, match: m[0] };
    if (m.index === re.lastIndex) re.lastIndex++; // avoid infinite loop on zero-length match
  }
  return last;
}

// Collapse two (or more) sign-offs that end up adjacent to each other, e.g.
// "...here.\n\nBest Regards,\n\nBest Regards," -> "...here.\n\nBest Regards,"
// This is a defensive last line of protection inside reapplyInjection() so
// that even in an edge case we haven't anticipated, a duplicated "Best
// Regards," can never survive into the merged HTML.
function dedupeSignoff(html) {
  const dupeRe = /((?:<[^>]*>)?\s*Best\s+[Rr]egards,?\s*)(?:\s|<br\s*\/?>|<\/?p>)*\1/i;
  let out = html;
  for (let i = 0; i < 3 && dupeRe.test(out); i++) {
    out = out.replace(dupeRe, '$1');
  }
  return out;
}

/**
 * Find what the user ADDED between the original and edited HTML.
 *
 * EMAIL STRUCTURE:
 *   [Header/intro]
 *   [Dynamic plugin table — fetched from Google Sheets]
 *   <<< custom injection goes here >>>
 *   [Functionality Checks paragraph]   ← static footer starts here
 *   [Responsiveness paragraph]
 *   [Forms paragraph]
 *   [Everything is running smoothly paragraph]
 *   [Best Regards]
 *
 * PRIMARY strategy — "Functionality Checks" anchor:
 *   The static footer always starts with "Functionality Checks".
 *   We compare what sits BEFORE it in both the original and edited HTML.
 *   Whatever the user added between the dynamic table and that line = the
 *   custom injection. The table itself is excluded from comparison entirely.
 *
 * FALLBACK — "Best Regards" anchor (lastMatch):
 *   Used when "Functionality Checks" isn't found.
 *
 * Returns { injectedHtml, anchor } or null.
 */
function extractCustomInjection(originalHtml, editedHtml) {
  if (!originalHtml || !editedHtml) return null;

  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const orig = norm(originalHtml);
  const edit = norm(editedHtml);
  if (orig === edit) return null;

  // ── Primary: "Functionality Checks" is the split point ──────────────────
  // This text is static and always comes right after the dynamic table,
  // so it's the cleanest boundary between "sheet data" and "user edits".
  const fcRe = /Functionality\s+Checks/i;
  const origFcIdx = orig.search(fcRe);
  const editFcIdx = edit.search(fcRe);

  if (origFcIdx > 0 && editFcIdx > 0) {
    // Grab everything BEFORE the footer in each version
    const origBeforeFc = orig.slice(0, origFcIdx);
    const editBeforeFc = edit.slice(0, editFcIdx);

    // Common prefix = shared header + table (identical in both)
    let pre = 0;
    const minLen = Math.min(origBeforeFc.length, editBeforeFc.length);
    while (pre < minLen && origBeforeFc[pre] === editBeforeFc[pre]) pre++;

    const injectedHtml = editBeforeFc.slice(pre).trim();

    if (injectedHtml && injectedHtml.length < orig.length * 0.5) {
      // Anchor = the opening tag + "Functionality Checks" from the original
      // (used to find the re-injection point in fresh HTML)
      const anchorMatch = orig.slice(origFcIdx - 10, origFcIdx + 60).match(/<[^>]*>\s*Functionality/);
      const anchor = anchorMatch
        ? orig.slice(origFcIdx - 10 + anchorMatch.index, origFcIdx + 60)
        : orig.slice(origFcIdx, origFcIdx + 60);
      return { injectedHtml, anchor };
    }
    return null; // nothing was added (or something went wrong)
  }

  // ── Fallback: LAST "Best Regards" as split-point ────────────────────────
  const brRe = /(<[^>]*>)?\s*Best\s+[Rr]egards/gi;
  const origBr = lastMatch(orig, brRe);
  const editBr = lastMatch(edit, brRe);

  if (origBr && editBr) {
    const origBeforeBr = orig.slice(0, origBr.index);
    const editBeforeBr = edit.slice(0, editBr.index);

    let pre = 0;
    const minLen = Math.min(origBeforeBr.length, editBeforeBr.length);
    while (pre < minLen && origBeforeBr[pre] === editBeforeBr[pre]) pre++;

    let injectedHtml = editBeforeBr.slice(pre).trim();
    // Strip any accidental trailing sign-off from the captured injection
    injectedHtml = injectedHtml.replace(/(<[^>]*>)?\s*Best\s+[Rr]egards,?\s*$/i, '').trim();

    if (injectedHtml && injectedHtml.length < orig.length * 0.6) {
      return { injectedHtml, anchor: origBr.match };
    }
    return null;
  }

  return null;
}

/**
 * Re-insert injectedHtml into freshHtml at the right position.
 *
 * Injection order (first match wins):
 *   1. Exact stored anchor text
 *   2. Before "Functionality Checks" paragraph (primary injection point)
 *   3. Before last "Best Regards"
 *   4. Before </body>, or append
 *
 * dedupeSignoff() runs as a final safety net.
 */
function reapplyInjection(freshHtml, injectedHtml, anchor) {
  if (!freshHtml || !injectedHtml) return freshHtml;

  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const fresh = norm(freshHtml);
  const inj   = injectedHtml.trim();

  let merged = null;

  // 1. Exact anchor match (fastest, most precise)
  if (anchor) {
    const idx = fresh.indexOf(anchor);
    if (idx !== -1) {
      merged = fresh.slice(0, idx) + '\n' + inj + '\n' + fresh.slice(idx);
    }
  }

  // 2. "Functionality Checks" — inject right before the static footer
  if (!merged) {
    const fcIdx = fresh.search(/Functionality\s+Checks/i);
    if (fcIdx !== -1) {
      // Step back to the opening tag that wraps "Functionality Checks"
      const tagStart = fresh.lastIndexOf('<', fcIdx);
      const pos = tagStart !== -1 ? tagStart : fcIdx;
      merged = fresh.slice(0, pos) + '\n' + inj + '\n' + fresh.slice(pos);
    }
  }

  // 3. Last "Best Regards" fallback
  if (!merged) {
    const brMatch = lastMatch(fresh, /(<[^>]*>)?\s*Best\s+[Rr]egards/gi);
    if (brMatch) {
      merged = fresh.slice(0, brMatch.index) + '\n' + inj + '\n' + fresh.slice(brMatch.index);
    }
  }

  // 4. Last resort
  if (!merged) {
    const bodyClose = fresh.lastIndexOf('</body>');
    merged = bodyClose !== -1
      ? fresh.slice(0, bodyClose) + '\n' + inj + '\n' + fresh.slice(bodyClose)
      : fresh + '\n' + inj;
  }

  // Defensive: collapse any duplicate sign-offs
  return dedupeSignoff(merged);
}




/**
 * Core refresh logic.
 * keepEdits=true  → re-fetch fresh email HTML from Sheets for each customized
 *                   site, then re-inject the stored custom block at the same
 *                   position. Latest sheet data + your edits = merged result.
 * keepEdits=false → full reset: clear everything including custom edits
 */
async function doRefresh(keepEdits = false) {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = REFRESH_BTN_LOADING_HTML;

    // Always invalidate the server-side Sheets cache so fresh data comes from Google
    await fetch('/api/cache/invalidate', { method: 'POST' }).catch(() => { });

    if (keepEdits) {
      // Collect customized previews before clearing
      const customized = [];
      for (const [url, preview] of generatedPreviews.entries()) {
        if (preview.isCustomEdited) {
          customized.push({ url, preview });
        }
        generatedPreviews.delete(url); // clear all; will re-populate below
      }

      // Reload the overview (fresh data from Sheets)
      await loadOverview(monthSelect.value || null, selectedAccount);

      // Re-fetch fresh email HTML for each customized site and re-inject edits
      let mergedCount = 0;
      for (const { url, preview } of customized) {
        try {
          const month = currentOverview?.selectedMonth?.name || monthSelect?.value || '';
          const acctParam = preview.account ? `&account=${encodeURIComponent(preview.account)}` : '';
          const res = await fetch(
            `/api/preview?websiteUrl=${encodeURIComponent(url)}&month=${encodeURIComponent(month)}${acctParam}`
          );
          if (!res.ok) throw new Error('fetch failed');
          const freshData = await res.json();

          // Re-apply the stored custom injection into fresh HTML
          let mergedHtml = freshData.html;
          if (preview.customInjection) {
            mergedHtml = reapplyInjection(freshData.html, preview.customInjection, preview.injectionAnchor);
          } else {
            // No structured injection stored → keep the old custom HTML as-is
            mergedHtml = preview.html;
          }

          freshData.html = mergedHtml;
          freshData.baseHtml = freshData.html; // update base to new sheet content
          freshData.isCustomEdited = true;
          freshData.customInjection = preview.customInjection;
          freshData.injectionAnchor = preview.injectionAnchor;

          // Preserve custom subject / recipients if they were user-modified
          if (preview.subject && preview.subject !== freshData.subject) {
            freshData.subject = preview.subject;
          }
          const origContacts = Array.isArray(preview.contacts) ? preview.contacts.join(',') : preview.contacts;
          const freshContacts = Array.isArray(freshData.contacts) ? freshData.contacts.join(',') : freshData.contacts;
          if (origContacts !== freshContacts && preview.contacts?.length) {
            freshData.contacts = preview.contacts;
          }

          generatedPreviews.set(url, freshData);
          mergedCount++;
        } catch (_) {
          // If re-fetch fails, fall back to keeping the old custom version
          generatedPreviews.set(url, preview);
          mergedCount++;
        }
      }

      showToast(
        mergedCount > 0
          ? `Refreshed with latest sheet data. ${mergedCount} custom edit(s) re-applied.`
          : 'Data refreshed from Google Sheets!',
        'success'
      );
    } else {
      // Full reset
      generatedPreviews.clear();
      selectedSites.clear();
      batchStatusBanner.classList.add('hidden');
      updateActionButtons();
      await loadOverview(monthSelect.value || null, selectedAccount);
      showToast('Full refresh complete — all previews reset.', 'success');
    }
  } catch (err) {
    showToast(`Refresh failed: ${err.message}`, 'error');
  } finally {
    refreshInProgress = false;
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = REFRESH_BTN_DEFAULT_HTML;
    if (refreshConfirmModal) refreshConfirmModal.classList.add('hidden');
  }
}

// --- Refresh Button click — show modal if edited previews exist ---
refreshBtn.addEventListener('click', () => {
  // Block if a refresh is already running
  if (refreshInProgress) return;

  const editedPreviews = [...generatedPreviews.values()].filter((p) => p.isCustomEdited);

  if (editedPreviews.length > 0) {
    // Show the choice modal
    if (refreshEditedCount) refreshEditedCount.textContent = editedPreviews.length;
    // Default to "keep" selection
    const keepRadio = refreshConfirmModal.querySelector('input[value="keep"]');
    if (keepRadio) keepRadio.checked = true;
    refreshConfirmModal.classList.remove('hidden');
  } else {
    // No edits — just refresh immediately without asking
    doRefresh(false);
  }
});

// --- Confirm Refresh Modal handlers ---
if (confirmRefreshBtn) {
  confirmRefreshBtn.addEventListener('click', () => {
    const selected = refreshConfirmModal.querySelector('input[name="refreshMode"]:checked');
    const keepEdits = selected ? selected.value === 'keep' : true;
    doRefresh(keepEdits);
  });
}

if (cancelRefreshBtn) {
  cancelRefreshBtn.addEventListener('click', () => {
    refreshConfirmModal.classList.add('hidden');
  });
}

// Close refresh modal on backdrop click
if (refreshConfirmModal) {
  refreshConfirmModal.addEventListener('click', (e) => {
    if (e.target === refreshConfirmModal) refreshConfirmModal.classList.add('hidden');
  });
}

// --- Close Modals ---
closeModalBtn.addEventListener('click', () => previewModal.classList.add('hidden'));
closeBatchModalBtn.addEventListener('click', () => batchModal.classList.add('hidden'));
cancelBatchBtn.addEventListener('click', () => batchModal.classList.add('hidden'));

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// escapeHtml() alone does not make a value safe in an href: a cell reading
// "javascript:alert(1)" is perfectly escapable and still executes on click.
// This is the same rule as safeExternalUrl() in src/reportUtils.js, kept in
// step deliberately — a link is either an http(s) URL or it is not shown.
function safeExternalUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return parsed.toString();
}

// ─── Conditional Email Notes ────────────────────────────────────────────────
// A registered condition (e.g. "a11y") is matched against each site's report tab
// as a cell shaped "<condition>:<link>"; when it matches, the stored message is
// added to that site's email above "Best Regards," with the link taken from the
// cell. The server owns the matching rules (src/reportUtils.js); this only manages
// the registry and never edits a spreadsheet.
const condNotesTableBody = document.getElementById('condNotesTableBody');
const condNotesCountBadge = document.getElementById('condNotesCountBadge');
const condNoteConditionInput = document.getElementById('condNoteConditionInput');
const condNoteMessageInput = document.getElementById('condNoteMessageInput');
const condNoteAddBtn = document.getElementById('condNoteAddBtn');
const condSheetsBothBtn = document.getElementById('condSheetsBothBtn');
// One checkbox per sheet. The set of ticked boxes is what an add or an edit
// applies to, so a note can cover both sheets in a single action.
const condSheetInputs = ['CW', 'RM']
  .map((k) => document.getElementById(`condSheet${k}`))
  .filter(Boolean);

const COND_SHEET_LABEL = { CW: '◯ CW', RM: '● RM' };
const condSheetOrder = (a, b) => Object.keys(COND_SHEET_LABEL).indexOf(a) - Object.keys(COND_SHEET_LABEL).indexOf(b);

function condSelectedSheets() {
  return condSheetInputs.filter((el) => el.checked).map((el) => el.value);
}

function condSetSheets(sheets) {
  const want = new Set((sheets || []).map((s) => String(s).toUpperCase()));
  condSheetInputs.forEach((el) => { el.checked = want.has(el.value); });
}

let condNotesEditing = null;   // { condition, accounts:[...] }

async function loadConditionalNotes() {
  if (!condNotesTableBody) return;
  try {
    // No account filter: the table shows every sheet at once, which is the only
    // way "this note is on both sheets" can be visible rather than inferred.
    const res = await fetch('/api/conditional-notes');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderConditionalNotes(data.notes || []);
  } catch (e) {
    condNotesTableBody.innerHTML =
      `<tr><td colspan="5" class="history-empty">Could not load notes: ${escapeHtml(e.message)}</td></tr>`;
    if (condNotesCountBadge) condNotesCountBadge.textContent = 'unavailable';
  }
}

// Notes are stored one record per sheet, so a condition on both sheets is two
// records. They are shown as one row, because that is how the operator thinks
// of it. If the two messages have drifted apart the row says so rather than
// quietly showing one of them.
function condGroupNotes(notes) {
  const byCondition = new Map();
  for (const n of notes) {
    const key = String(n.condition || '').toLowerCase();
    if (!byCondition.has(key)) byCondition.set(key, []);
    byCondition.get(key).push(n);
  }
  return [...byCondition.entries()].map(([condition, group]) => {
    const sorted = [...group].sort((a, b) => condSheetOrder(a.account, b.account));
    const messages = [...new Set(sorted.map((n) => String(n.message || '').trim()))];
    return {
      condition,
      notes: sorted,
      accounts: sorted.map((n) => n.account),
      message: messages[0] || '',
      diverged: messages.length > 1,
      enabled: sorted.every((n) => n.enabled !== false),
    };
  }).sort((a, b) => a.condition.localeCompare(b.condition));
}

function renderConditionalNotes(notes) {
  const groups = condGroupNotes(notes);
  if (condNotesCountBadge) {
    condNotesCountBadge.textContent = `${groups.length} condition${groups.length === 1 ? '' : 's'}`;
  }
  if (!groups.length) {
    condNotesTableBody.innerHTML =
      '<tr><td colspan="5" class="history-empty">No conditions registered. '
      + 'Add one above, then write <code>condition:link</code> in a site\'s report tab.</td></tr>';
    return;
  }

  condNotesTableBody.innerHTML = groups.map((g) => {
    const on = g.enabled;
    const preview = String(g.message).replace(/\s+/g, ' ').trim();
    const shown = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;
    const badges = g.accounts.map((a) =>
      `<span class="cond-sheet-badge">${escapeHtml(COND_SHEET_LABEL[a] || a)}</span>`).join(' ');
    const ids = g.notes.map((n) => n.id).join(',');
    return `<tr>
      <td><code style="background:#f3f4f6; padding:2px 6px; border-radius:3px;">${escapeHtml(g.condition)}</code></td>
      <td>${badges}${g.diverged
    ? '<div style="color:#b45309; font-size:11px; margin-top:4px;" title="These sheets have different messages for this condition. Edit to make them the same.">&#9888; messages differ</div>'
    : ''}</td>
      <td title="${escapeHtml(preview)}">${escapeHtml(shown)}</td>
      <td>${on
    ? '<span style="color:var(--success,#16a34a); font-weight:600;">On</span>'
    : '<span style="color:var(--text-muted,#6b7280);">Off</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-secondary btn-sm" data-cond-toggle="${escapeHtml(ids)}">${on ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-secondary btn-sm" data-cond-edit="${escapeHtml(ids)}">Edit</button>
        <button class="btn btn-secondary btn-sm" data-cond-del="${escapeHtml(ids)}">Remove</button>
      </td>
    </tr>`;
  }).join('');

  condNotesTableBody.querySelectorAll('[data-cond-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => updateConditionalNotes(btn.dataset.condToggle.split(','), null));
  });
  condNotesTableBody.querySelectorAll('[data-cond-edit]').forEach((btn) => {
    btn.addEventListener('click', () => startEditingConditionalNote(btn.dataset.condEdit.split(',')));
  });
  condNotesTableBody.querySelectorAll('[data-cond-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteConditionalNotes(btn.dataset.condDel.split(',')));
  });
}

function startEditingConditionalNote(ids) {
  loadConditionalNotes().then(async () => {
    try {
      const res = await fetch('/api/conditional-notes');
      const data = await res.json();
      const rows = (data.notes || []).filter((n) => ids.includes(n.id));
      if (!rows.length) return;
      condNotesEditing = {
        condition: rows[0].condition,
        accounts: rows.map((n) => n.account),
        ids: rows.map((n) => n.id),
      };
      condNoteConditionInput.value = rows[0].condition;
      condNoteMessageInput.value = rows[0].message;
      // Pre-tick exactly the sheets this condition is already on, so saving
      // without touching the boxes cannot silently drop a sheet.
      condSetSheets(rows.map((n) => n.account));
      condNoteAddBtn.textContent = `Update ${rows.length > 1 ? 'both sheets' : 'Note'}`;
      condNoteMessageInput.focus();
    } catch (_) { /* leave the list as it is */ }
  });
}

function resetConditionalNoteForm() {
  condNotesEditing = null;
  condNoteConditionInput.value = '';
  condNoteMessageInput.value = '';
  condNoteAddBtn.textContent = 'Add Note';
}

async function updateConditionalNotes(ids, patch) {
  try {
    for (const id of ids) {
      const res = await fetch('/api/conditional-notes/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...(patch || {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    }
    showToast(ids.length > 1 ? `Note updated on ${ids.length} sheets.` : 'Note updated.');
    await loadConditionalNotes();
  } catch (e) {
    showToast(`Could not update note: ${e.message}`, 'error');
  }
}

async function deleteConditionalNotes(ids) {
  const sheets = ids.length === 1 ? 'this sheet' : `these ${ids.length} sheets`;
  if (!confirm(`Remove this condition from ${sheets}? Emails for sites that match it will stop showing the message. `
    + 'This removes it from the ticked sheets only.')) return;
  try {
    for (const id of ids) {
      const res = await fetch('/api/conditional-notes/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    }
    showToast('Note removed.');
    if (condNotesEditing && condNotesEditing.ids.some((id) => ids.includes(id))) resetConditionalNoteForm();
    await loadConditionalNotes();
  } catch (e) {
    showToast(`Could not remove note: ${e.message}`, 'error');
  }
}

if (condSheetsBothBtn) {
  condSheetsBothBtn.addEventListener('click', () => {
    const allTicked = condSheetInputs.every((el) => el.checked);
    condSheetInputs.forEach((el) => { el.checked = !allTicked; });
  });
}

if (condNoteAddBtn) {
  condNoteAddBtn.addEventListener('click', async () => {
    const accounts = condSelectedSheets();
    const condition = condNoteConditionInput.value.trim();
    const message = condNoteMessageInput.value.trim();
    if (!accounts.length) {
      showToast('Tick at least one sheet.', 'error');
      return;
    }
    if (!condition || !message) {
      showToast('Both a condition and a message are required.', 'error');
      return;
    }
    // One action covers every ticked sheet. Adding posts the whole set at once.
    // Editing is two steps because it is genuinely two different operations: the
    // sheets that already have this condition are updated in place (which is what
    // makes a condition RENAME work — creating a new record instead would leave
    // the old one orphaned and firing), and a newly ticked sheet gets its own
    // record.
    const editing = condNotesEditing;
    const post = async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    };
    try {
      if (editing) {
        for (const id of editing.ids) {
          await post('/api/conditional-notes/update', { id, condition, message });
        }
        for (const sheet of accounts) {
          if (editing.accounts.includes(sheet)) continue;
          // create-or-update for this one sheet: if it already had this
          // condition, its message is brought into line rather than rejected.
          await post('/api/conditional-notes', { accounts: [sheet], condition, message });
        }
      } else {
        await post('/api/conditional-notes', { accounts, condition, message });
      }
      showToast(editing
        ? `Note saved on ${accounts.length} sheet${accounts.length === 1 ? '' : 's'}.`
        : `Note added to ${accounts.length} sheet${accounts.length === 1 ? '' : 's'}.`);
      resetConditionalNoteForm();
      await loadConditionalNotes();
    } catch (e) {
      showToast(`Could not save note: ${e.message}`, 'error');
    }
  });
}

// Initial Load
fetchAccounts();
loadOverview();
loadConditionalNotes();

// ============================================================
// ClickUp Bulk Actions Bar  — two-step: Load & Preview → Send
// ============================================================

/**
 * Updates the task-count badge to show how many loaded sites
 * have a ClickUp time-track URL.
 */
function updateCuBulkCount() {
  if (!cuBulkTaskCount || !currentOverview) return;
  const withTask = (currentOverview.sites || []).filter(
    (s) => s.timeTrackUrl && s.timeTrackUrl.includes('clickup.com')
  ).length;
  cuBulkTaskCount.textContent = `${withTask} sites with task URLs`;
}

/**
 * Syncs the preview-modal checkboxes with globalSendMode.
 */
function syncModalCheckboxesToMode() {
  if (!optSendEmail || !optSyncClickUp) return;
  if (globalSendMode === 'email+clickup') {
    optSendEmail.checked   = true;
    optSyncClickUp.checked = true;
  } else if (globalSendMode === 'email') {
    optSendEmail.checked   = true;
    optSyncClickUp.checked = false;
  } else if (globalSendMode === 'clickup') {
    optSendEmail.checked   = false;
    optSyncClickUp.checked = true;
  }
  updateSendActionButtons();
}

// --- Mode Segmented Control (right side of bulk bar) ---
cuModeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const newMode = btn.dataset.mode;
    if (!newMode) return;
    globalSendMode = newMode;
    cuModeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === newMode));
    syncModalCheckboxesToMode();
    showToast(
      newMode === 'email+clickup'
        ? '✉ + ClickUp — email will also be sent'
        : '🔄 ClickUp only — no email to clients',
      'info'
    );
  });
});

// --- Modal close helpers ---
function closeCuBulkModal() {
  if (cuBulkPreviewModal) cuBulkPreviewModal.classList.add('hidden');
}
closeCuBulkModalBtn?.addEventListener('click', closeCuBulkModal);
cuBulkCancelBtn?.addEventListener('click', closeCuBulkModal);
cuBulkPreviewModal?.addEventListener('click', (e) => {
  if (e.target === cuBulkPreviewModal) closeCuBulkModal();
});

// --- Step 1: Load & Preview ClickUp ---
cuLoadPreviewBtn?.addEventListener('click', async () => {
  if (!currentOverview) {
    showToast('Data not loaded yet — please refresh first.', 'error');
    return;
  }

  const monthName = monthSelect?.options[monthSelect.selectedIndex]?.text || '';
  const doEmail   = globalSendMode !== 'clickup';

  // Gather ALL sites that have a task URL (not just unsent)
  const candidates = (currentOverview.sites || []).filter(
    (s) => s.timeTrackUrl?.includes('clickup.com')
  );

  if (candidates.length === 0) {
    showToast('No sites with ClickUp task URLs found in the sheet.', 'error');
    return;
  }

  // Open modal in loading state
  cuBulkPreviewModal.classList.remove('hidden');
  cuBulkPreviewLoading.classList.remove('hidden');
  cuBulkPreviewTable.classList.add('hidden');
  cuBulkSendBtn.disabled = true;
  cuBulkPreviewData = [];

  // Update mode tag in footer
  if (cuBulkSendModeTag) {
    cuBulkSendModeTag.textContent = doEmail ? '✉ + ClickUp mode' : '🔄 ClickUp only mode';
  }

  // Fetch previews one by one (respects 5-min cache — no API flooding)
  let ready = 0, warnings = 0, noTask = 0;
  const rows = [];

  for (let i = 0; i < candidates.length; i++) {
    const site = candidates[i];
    if (cuBulkLoadingLabel) {
      cuBulkLoadingLabel.textContent =
        `Loading ${i + 1} of ${candidates.length}: ${site.websiteUrl}…`;
    }

    let preview = null;
    try {
      const params = new URLSearchParams({
        timeTrackUrl:   site.timeTrackUrl || '',
        websiteUrl:     site.websiteUrl  || '',
        accountManager: site.accountManager || '',
        month:          monthName,
      });
      const res = await fetch(`/api/clickup/preview-task?${params}`);
      if (res.ok) preview = await res.json();
    } catch (e) {
      console.warn('[CU Bulk Load]', site.websiteUrl, e.message);
    }

    const hasTask = Boolean(preview?.taskId);
    const isWarn  = preview?.statusBadge === 'warning';
    const isClosed = preview?.currentStatus?.toLowerCase() === 'closed';

    if (!hasTask)      noTask++;
    else if (isWarn)   warnings++;
    else               ready++;

    cuBulkPreviewData.push({ site, preview, selected: hasTask && !isClosed });
    rows.push({ site, preview, hasTask, isWarn, isClosed });
  }

  // Build table rows
  if (cuBulkPreviewTableBody) {
    cuBulkPreviewTableBody.innerHTML = rows.map((r, idx) => {
      const { site, preview, hasTask, isWarn, isClosed } = r;
      const isSelected = hasTask && !isClosed;
      const amLabel = preview?.accountManager?.matchedUsers?.length > 0
        ? preview.accountManager.matchedUsers.map((u) => `@${u.id} (${escapeHtml(u.name)})`).join(', ')
        : escapeHtml(site.accountManager || '—');
      const statusBadge = !hasTask
        ? '<span class="cu-badge cu-badge-no-task" style="font-size:10px">No Task URL</span>'
        : isClosed
          ? '<span class="cu-badge cu-badge-closed" style="font-size:10px">Already Closed</span>'
          : isWarn
            ? `<span class="cu-badge cu-badge-pending" style="font-size:10px">⚠ ${escapeHtml(preview?.currentStatus || 'Warning')}</span>`
            : `<span class="cu-badge cu-badge-ready" style="font-size:10px">${escapeHtml(preview?.currentStatus || 'active')}</span>`;
      const comment = preview?.commentText
        ? escapeHtml(preview.commentText).replace(/(@\d+)/g, '<mark class="cu-hl-mention">$1</mark>')
        : '<span style="color:var(--text-muted)">—</span>';
      return `
        <tr data-cu-idx="${idx}" class="${!hasTask || isClosed ? 'row-muted' : ''}">
          <td><input type="checkbox" class="cu-row-check" data-idx="${idx}" ${isSelected ? 'checked' : ''} ${!hasTask || isClosed ? 'disabled' : ''}></td>
          <td style="font-size:12px;font-weight:600">${escapeHtml(site.websiteUrl)}</td>
          <td style="font-size:11px">${amLabel}</td>
          <td style="font-size:11px;font-family:var(--font-mono)">${preview?.taskId ? '#' + preview.taskId : '—'}</td>
          <td>${statusBadge}</td>
          <td style="font-size:11px;max-width:280px;line-height:1.5">${comment}</td>
        </tr>`;
    }).join('');
  }

  // Update counts
  if (cuBulkReadyCount)   { cuBulkReadyCount.textContent   = `${ready} Ready`;    cuBulkReadyCount.style.display   = ready   > 0 ? '' : 'none'; }
  if (cuBulkWarningCount) { cuBulkWarningCount.textContent = `${warnings} ⚠`;    cuBulkWarningCount.style.display = warnings > 0 ? '' : 'none'; }
  if (cuBulkNoTaskCount)  { cuBulkNoTaskCount.textContent  = `${noTask} No URL`; cuBulkNoTaskCount.style.display  = noTask  > 0 ? '' : 'none'; }
  if (cuBulkPreviewCount) cuBulkPreviewCount.textContent = `${candidates.length} sites`;

  // Switch loading → table
  cuBulkPreviewLoading.classList.add('hidden');
  cuBulkPreviewTable.classList.remove('hidden');

  // Enable send button only if there's something to send
  const sendable = cuBulkPreviewData.filter((d) => d.selected).length;
  cuBulkSendBtn.disabled = sendable === 0;
  if (cuBulkSendBtnLabel) {
    cuBulkSendBtnLabel.textContent = `Send to ClickUp (${sendable})`;
  }

  // Mark the bar as loaded
  if (cuPreviewReadyBadge) cuPreviewReadyBadge.classList.remove('hidden');
  if (cuSendAllClickUpBtn) {
    cuSendAllClickUpBtn.disabled = false;
    cuSendAllClickUpBtn.classList.remove('disabled');
  }

  // Dry-run tag
  if (cuBulkDryRunTag) {
    const isDryRun = !preview?.autoCloseEnabled; // use last preview result
    // Check any result for autoCloseEnabled
    const anyLive = cuBulkPreviewData.some((d) => d.preview?.autoCloseEnabled);
    cuBulkDryRunTag.textContent = anyLive ? '⚡ Live Mode' : '🛡️ Dry-Run Safe';
    cuBulkDryRunTag.className = anyLive
      ? 'cu-badge cu-badge-ready'
      : 'cu-badge cu-badge-pending';
    cuBulkDryRunTag.style.fontSize = '10px';
  }

  // Row-level checkbox wiring
  cuBulkPreviewTableBody?.querySelectorAll('.cu-row-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const idx = Number(cb.dataset.idx);
      if (cuBulkPreviewData[idx]) cuBulkPreviewData[idx].selected = cb.checked;
      const count = cuBulkPreviewData.filter((d) => d.selected).length;
      cuBulkSendBtn.disabled = count === 0;
      if (cuBulkSendBtnLabel) cuBulkSendBtnLabel.textContent = `Send to ClickUp (${count})`;
    });
  });

  // Select-all checkbox
  cuBulkSelectAll?.addEventListener('change', () => {
    const checked = cuBulkSelectAll.checked;
    cuBulkPreviewTableBody?.querySelectorAll('.cu-row-check:not(:disabled)').forEach((cb) => {
      cb.checked = checked;
      const idx = Number(cb.dataset.idx);
      if (cuBulkPreviewData[idx]) cuBulkPreviewData[idx].selected = checked;
    });
    const count = cuBulkPreviewData.filter((d) => d.selected).length;
    cuBulkSendBtn.disabled = count === 0;
    if (cuBulkSendBtnLabel) cuBulkSendBtnLabel.textContent = `Send to ClickUp (${count})`;
  });
});

// "Send All to ClickUp" bar button → just open the modal (same as load)
cuSendAllClickUpBtn?.addEventListener('click', () => {
  if (cuBulkPreviewData.length === 0) {
    // Haven't loaded yet — trigger load
    cuLoadPreviewBtn?.click();
  } else {
    cuBulkPreviewModal?.classList.remove('hidden');
  }
});

// --- Step 2: Send from modal ---
cuBulkSendBtn?.addEventListener('click', async () => {
  const toSend = cuBulkPreviewData.filter((d) => d.selected && d.preview?.taskId);
  if (toSend.length === 0) {
    showToast('Nothing selected to send.', 'error');
    return;
  }

  const monthName = monthSelect?.options[monthSelect.selectedIndex]?.text || '';
  const doEmail   = globalSendMode !== 'clickup';
  const doClickUp = true; // always true here — this button is specifically for ClickUp

  if (doEmail) {
    const missingPreviews = toSend.filter((d) => !generatedPreviews.has(d.site.websiteUrl));
    if (missingPreviews.length > 0) {
      showToast(
        `⚠ ${missingPreviews.length} site${missingPreviews.length !== 1 ? 's' : ''} need email previews generated first (Step 1 on the main page).`,
        'error'
      );
      return;
    }
  }

  cuBulkSendBtn.disabled = true;
  if (cuBulkSendBtnLabel) cuBulkSendBtnLabel.textContent = 'Sending…';

  let done = 0, errors = 0;
  for (const { site, preview } of toSend) {
    try {
      const emailPreview = generatedPreviews.get(site.websiteUrl);
      const res = await fetch('/api/clickup/sync-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeTrackUrl:   site.timeTrackUrl,
          websiteUrl:     site.websiteUrl,
          accountManager: site.accountManager,
          monthName,
          sendEmail:   doEmail,
          sendClickUp: doClickUp,
          ...(doEmail && emailPreview ? {
            to:      emailPreview.contacts,
            subject: emailPreview.subject,
            html:    emailPreview.html,
            account: emailPreview.account,
          } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      recordDelivery({
        time:       new Date().toLocaleTimeString(),
        account:    site.account || '—',
        websiteUrl: site.websiteUrl,
        to:         (site.contacts || []).join(', '),
        subject:    emailPreview?.subject || '—',
        status:     'sent',
        details:    `ClickUp: ${data.clickup?.dryRun ? 'Dry-run' : 'Done'}${doEmail ? ' + Email sent' : ''}`,
        isDryRun:   data.clickup?.dryRun || false,
      });
      done++;
    } catch (err) {
      console.error(`[CU Bulk Send] ${site.websiteUrl}:`, err.message);
      errors++;
    }
    if (cuBulkSendBtnLabel) cuBulkSendBtnLabel.textContent = `Sending… ${done + errors}/${toSend.length}`;
  }

  closeCuBulkModal();
  cuBulkPreviewData = [];
  if (cuPreviewReadyBadge) cuPreviewReadyBadge.classList.add('hidden');
  if (cuSendAllClickUpBtn) {
    cuSendAllClickUpBtn.disabled = true;
    cuSendAllClickUpBtn.classList.add('disabled');
  }
  if (cuBulkSendBtnLabel) cuBulkSendBtnLabel.textContent = 'Send to ClickUp';

  showToast(
    errors === 0
      ? `✅ ClickUp messages sent for ${done} site${done !== 1 ? 's' : ''}!`
      : `⚠ ${done} sent, ${errors} failed — check console.`,
    errors > 0 ? 'error' : 'success'
  );
  updateActionButtons();
  renderStats();
  renderSitesTable();
});

// --- Send Selected from bulk bar (quick path for checked rows) ---
cuSendSelectedClickUpBtn?.addEventListener('click', () => {
  // Just trigger the load step — it will pre-select checked rows
  cuLoadPreviewBtn?.click();
});

// Keep 'Sync Selected' count updated from row checkboxes
function updateCuSelectedCount() {
  const count = selectedSites.size;
  if (cuSyncSelectedCount) cuSyncSelectedCount.textContent = count;
  if (cuSendSelectedClickUpBtn) {
    count > 0
      ? cuSendSelectedClickUpBtn.classList.remove('hidden')
      : cuSendSelectedClickUpBtn.classList.add('hidden');
  }
}

/**
 * Updates the task-count badge in the bulk bar to show how many
 * currently loaded sites have a ClickUp time-track URL in the sheet.
 */
function updateCuBulkCount() {
  if (!cuBulkTaskCount || !currentOverview) return;
  const withTask = (currentOverview.sites || []).filter(
    (s) => s.timeTrackUrl && s.timeTrackUrl.includes('clickup.com')
  ).length;
  cuBulkTaskCount.textContent = `${withTask} with task URLs`;
}

/**
 * Syncs the preview-modal checkboxes (optSendEmail / optSyncClickUp)
 * with the current globalSendMode so both controls are always in agreement.
 */
function syncModalCheckboxesToMode() {
  if (!optSendEmail || !optSyncClickUp) return;
  if (globalSendMode === 'email+clickup') {
    optSendEmail.checked  = true;
    optSyncClickUp.checked = true;
  } else if (globalSendMode === 'email') {
    optSendEmail.checked  = true;
    optSyncClickUp.checked = false;
  } else if (globalSendMode === 'clickup') {
    optSendEmail.checked  = false;
    optSyncClickUp.checked = true;
  }
  updateSendActionButtons();
}

// --- Mode Segmented Control ---
cuModeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const newMode = btn.dataset.mode;
    if (!newMode) return;
    globalSendMode = newMode;
    // Update active class
    cuModeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === newMode));
    // Sync the per-preview checkboxes if the modal happens to be open
    syncModalCheckboxesToMode();
    showToast(
      newMode === 'email+clickup' ? '✉ + ClickUp — both will run when you send'
      : newMode === 'email'       ? '✉ Email only — ClickUp sync skipped'
                                  : '🔄 ClickUp only — no email will be sent to clients',
      'info'
    );
  });
});

// --- Sync Selected (ClickUp for checked rows) ---
cuSyncSelectedBtn?.addEventListener('click', async () => {
  if (selectedSites.size === 0) {
    showToast('No rows selected — tick some checkboxes first.', 'error');
    return;
  }

  const sites = (currentOverview?.sites || []).filter((s) => selectedSites.has(s.websiteUrl));
  const withTask = sites.filter((s) => s.timeTrackUrl?.includes('clickup.com'));

  if (withTask.length === 0) {
    showToast('None of the selected sites have a ClickUp task URL in the sheet.', 'error');
    return;
  }

  const monthName = monthSelect?.options[monthSelect.selectedIndex]?.text || '';
  const doEmail   = globalSendMode !== 'clickup';
  const doClickUp = globalSendMode !== 'email';

  const confirmed = confirm(
    `${doEmail && doClickUp ? 'Send emails + sync ClickUp' : doClickUp ? 'Sync ClickUp only (no email)' : 'Send emails only (no ClickUp)'} for ${withTask.length} selected site${withTask.length !== 1 ? 's' : ''} that have task URLs?\n\n` +
    withTask.map((s) => `• ${s.websiteUrl}`).join('\n')
  );
  if (!confirmed) return;

  cuSyncSelectedBtn.disabled = true;
  let done = 0, errors = 0;
  for (const site of withTask) {
    try {
      const preview = generatedPreviews.get(site.websiteUrl);
      const res = await fetch('/api/clickup/sync-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeTrackUrl: site.timeTrackUrl,
          websiteUrl: site.websiteUrl,
          accountManager: site.accountManager,
          monthName,
          sendEmail: doEmail,
          sendClickUp: doClickUp,
          // Pass email payload if we're also emailing
          ...(doEmail && preview ? {
            to: preview.contacts,
            subject: preview.subject,
            html: preview.html,
            account: preview.account,
          } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      recordDelivery({
        time: new Date().toLocaleTimeString(),
        account: site.account || '—',
        websiteUrl: site.websiteUrl,
        to: (site.contacts || []).join(', '),
        subject: preview?.subject || '—',
        status: 'sent',
        details: doClickUp ? `ClickUp sync: ${data.clickup?.dryRun ? 'Dry-run' : 'Done'}` : 'Email sent (no ClickUp)',
        isDryRun: data.clickup?.dryRun || false,
      });
      done++;
    } catch (err) {
      console.error(`[Bulk Sync] ${site.websiteUrl}:`, err.message);
      errors++;
    }
  }
  cuSyncSelectedBtn.disabled = false;
  showToast(
    errors === 0
      ? `✅ Synced ${done} site${done !== 1 ? 's' : ''} successfully!`
      : `⚠ ${done} synced, ${errors} failed — check console for details.`,
    errors > 0 ? 'error' : 'success'
  );
  renderStats();
  renderSitesTable();
});

// --- Sync All Ready (ClickUp for all unsent ready sites with task URL) ---
cuSyncAllBtn?.addEventListener('click', async () => {
  if (!currentOverview) {
    showToast('Data not loaded yet — please wait.', 'error');
    return;
  }

  const monthName = monthSelect?.options[monthSelect.selectedIndex]?.text || '';
  const doEmail   = globalSendMode !== 'clickup';
  const doClickUp = globalSendMode !== 'email';

  // Gather ready+unsent sites that have a ClickUp task URL
  const targets = (currentOverview.sites || []).filter((s) => {
    const ready = s.status === 'ready';
    const unsent = !isSiteSent(s.websiteUrl);
    const hasTask = s.timeTrackUrl?.includes('clickup.com');
    return ready && unsent && hasTask;
  });

  if (targets.length === 0) {
    showToast('No unsent ready sites with ClickUp task URLs found.', 'error');
    return;
  }

  // If email mode: require previews to be generated first
  if (doEmail) {
    const missing = targets.filter((s) => !generatedPreviews.has(s.websiteUrl));
    if (missing.length > 0) {
      showToast(`⚠ Generate previews first — ${missing.length} site${missing.length !== 1 ? 's' : ''} not yet previewed.`, 'error');
      return;
    }
  }

  const modeLabel = doEmail && doClickUp ? 'Send Emails + Sync ClickUp'
                    : doClickUp           ? 'Sync ClickUp only (no email)'
                                          : 'Send Emails only (no ClickUp)';

  const confirmed = confirm(
    `${modeLabel} for ${targets.length} ready site${targets.length !== 1 ? 's' : ''} with task URLs?\n\n` +
    targets.slice(0, 8).map((s) => `• ${s.websiteUrl}`).join('\n') +
    (targets.length > 8 ? `\n  …and ${targets.length - 8} more` : '')
  );
  if (!confirmed) return;

  // Inject a live progress indicator into the bulk bar's right side
  cuSyncAllBtn.disabled = true;
  const progressContainer = document.createElement('div');
  progressContainer.className = 'cu-bulk-progress';
  progressContainer.innerHTML = `
    <span id="cuBulkProgressLabel">0 / ${targets.length}</span>
    <div class="cu-bulk-progress-bar"><div class="cu-bulk-progress-fill" id="cuBulkProgressFill" style="width:0%"></div></div>
  `;
  cuSyncAllBtn.parentElement?.appendChild(progressContainer);

  let done = 0, errors = 0;
  for (const site of targets) {
    try {
      const preview = generatedPreviews.get(site.websiteUrl);
      const res = await fetch('/api/clickup/sync-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeTrackUrl: site.timeTrackUrl,
          websiteUrl: site.websiteUrl,
          accountManager: site.accountManager,
          monthName,
          sendEmail: doEmail,
          sendClickUp: doClickUp,
          ...(doEmail && preview ? {
            to: preview.contacts,
            subject: preview.subject,
            html: preview.html,
            account: preview.account,
          } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      recordDelivery({
        time: new Date().toLocaleTimeString(),
        account: site.account || '—',
        websiteUrl: site.websiteUrl,
        to: (site.contacts || []).join(', '),
        subject: preview?.subject || '—',
        status: 'sent',
        details: doClickUp ? `ClickUp sync: ${data.clickup?.dryRun ? 'Dry-run' : 'Done'}` : 'Email sent',
        isDryRun: data.clickup?.dryRun || false,
      });
      done++;
    } catch (err) {
      console.error(`[Sync All] ${site.websiteUrl}:`, err.message);
      errors++;
    }
    // Update progress
    const pct = Math.round(((done + errors) / targets.length) * 100);
    const fillEl = document.getElementById('cuBulkProgressFill');
    const labelEl = document.getElementById('cuBulkProgressLabel');
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (labelEl) labelEl.textContent = `${done + errors} / ${targets.length}`;
  }

  progressContainer.remove();
  cuSyncAllBtn.disabled = false;
  showToast(
    errors === 0
      ? `✅ All ${done} site${done !== 1 ? 's' : ''} synced!`
      : `⚠ ${done} synced, ${errors} failed — check console.`,
    errors > 0 ? 'error' : 'success'
  );
  updateActionButtons();
  renderStats();
  renderSitesTable();
});

// Sync the bulk count whenever new data loads
const _origLoadOverview = window._origLoadOverview || null;
// We hook into renderStats since that's called after every data refresh
const _origRenderStats = renderStats;
// Patch renderStats to also update the ClickUp count
// (We can't easily monkey-patch since it's a function declaration, but we call it explicitly)
// Instead call updateCuBulkCount() in the load flow below.