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
        <td colspan="9" class="table-loading">
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
        <td colspan="9" style="text-align: center; color: #ef4444; padding: 32px;">
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

  // Selection Button
  if (selectedSites.size > 0) {
    sendSelectedBtn.classList.remove('hidden');
    selectionBar.classList.remove('hidden');
    selectedCountText.textContent = selectedSites.size;
    selectionText.textContent = `${selectedSites.size} website${selectedSites.size > 1 ? 's' : ''} selected`;
  } else {
    sendSelectedBtn.classList.add('hidden');
    selectionBar.classList.add('hidden');
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
        <td colspan="9" style="text-align:center; padding: 40px; color: var(--text-muted);">
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

  currentPreviewSite.contacts = toRecipients;
  currentPreviewSite.subject = subject;
  currentPreviewSite.html = html;
  currentPreviewSite.isCustomEdited = true;

  generatedPreviews.set(currentPreviewSite.websiteUrl, currentPreviewSite);
  modalEditedTag.classList.remove('hidden');
  showToast('Custom changes saved for this report! It will be used when sending.');
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

  if (!confirm(`Are you sure you want to send this report via ${acct} (${fromEmailDisplay}) to ${toRecipients.join(', ')}?`)) {
    return;
  }

  modalSendSingleBtn.disabled = true;
  modalSendSingleBtn.textContent = 'Sending email...';

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
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to send email');
    }

    const data = await res.json();
    recordDelivery({
      time: new Date().toLocaleTimeString(),
      account: acct,
      websiteUrl: currentPreviewSite.websiteUrl,
      to: toRecipients.join(', '),
      subject,
      status: 'sent',
      details: `Sent via ${acct} SMTP (${fromEmailDisplay})`,
      isDryRun: false,
    });

    showToast(`✅ Email successfully sent via ${acct} to ${toRecipients.join(', ')}!`);
    previewModal.classList.add('hidden');
    updateActionButtons();
    renderStats();
    renderSitesTable();
  } catch (err) {
    console.error('Send error:', err);
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
    modalSendSingleBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
      Send This Email Now
    `;
  }
});

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
      } catch (e) {}
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

// --- Refresh Button ---
refreshBtn.addEventListener('click', () => {
  loadOverview(monthSelect.value || null, selectedAccount);
});

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

// Initial Load
fetchAccounts();
loadOverview();

