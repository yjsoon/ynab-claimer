const API_BASE = ''; // Same origin when deployed, or set to worker URL for dev
const AUTH_KEY = 'claim_manager_auth';
const REMEMBER_KEY = 'claim_manager_remember';
const THEME_KEY = 'claim_manager_theme';
const THEME_CYCLE = ['light', 'dark', 'auto'];
const THEME_LABELS = { light: 'Light', dark: 'Dark', auto: 'System' };
const THEME_ICONS = {
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
};
const CLAIM_FILTER_KEY = 'claim_manager_claim_filter';

// Upload constraints (must match server)
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.pdf'];
const AMOUNT_TAG_COOLDOWN_MS = 20000;
const AMOUNT_MATCH_TOLERANCE = 0.01;
const DATE_NEAR_THRESHOLD_DAYS = 2;
const RECEIPT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const status = document.getElementById('status');
const receiptList = document.getElementById('receiptList');
const countSpan = document.getElementById('count');
const refreshBtn = document.getElementById('refreshBtn');
const themeToggle = document.getElementById('themeToggle');
const todoList = document.getElementById('todoList');
const todoCount = document.getElementById('todoCount');
const claimFilterInput = document.getElementById('claimFilterInput');
const claimFilterPills = document.getElementById('claimFilterPills');
const claimFilterClear = document.getElementById('claimFilterClear');
const authOverlay = document.getElementById('authOverlay');
const passwordInput = document.getElementById('passwordInput');
const authSubmit = document.getElementById('authSubmit');
const rememberMe = document.getElementById('rememberMe');

// Linking elements
const actionBar = document.getElementById('actionBar');
const actionText = document.getElementById('actionText');
const confirmSelection = document.getElementById('confirmSelection');
const markReadySelection = document.getElementById('markReadySelection');
const cancelSelection = document.getElementById('cancelSelection');
const tabBtns = document.querySelectorAll('.tab-btn');
const receiptsColumn = document.getElementById('receiptsColumn');
const claimsColumn = document.getElementById('claimsColumn');
const receiptBadge = document.getElementById('receiptBadge');
const claimBadge = document.getElementById('claimBadge');
const linkedList = document.getElementById('linkedList');
const linkedCount = document.getElementById('linkedCount');
const invoicesNavBadge = document.getElementById('invoicesNavBadge');

// Linking state
let sourceReceiptKey = null;
let sourceClaimId = null;
let selectedReceiptKeys = new Set();
let selectedClaimIds = new Set();
let linkingSource = null; // 'receipt' | 'claim'
let receiptsData = [];
let claimsData = [];
let amountTaggingInFlight = false;
let lastAmountTagAttempt = 0;
let claimsLoadErrorMessage = '';

const READY_CLAIM_ID_PREFIX = 'receipt-ready:';
const DEFAULT_CLAIM_FILTERS = [
  'Update with actual',
  'MYR',
  'USD',
  'Transfer',
];
let claimFilterState = {
  text: '',
  quickFilters: [],
};

// Preview modal elements
const previewOverlay = document.getElementById('previewOverlay');
const previewBackdrop = previewOverlay.querySelector('.preview-backdrop');
const previewClose = document.getElementById('previewClose');
const previewFilename = document.getElementById('previewFilename');
const previewImage = document.getElementById('previewImage');
const previewPdf = document.getElementById('previewPdf');
const previewSpinner = document.getElementById('previewSpinner');

// Auth token management
function getAuthToken() {
  return localStorage.getItem(AUTH_KEY) || sessionStorage.getItem(AUTH_KEY);
}

function setAuthToken(token, remember) {
  if (remember) {
    localStorage.setItem(AUTH_KEY, token);
    localStorage.setItem(REMEMBER_KEY, 'true');
  } else {
    sessionStorage.setItem(AUTH_KEY, token);
    localStorage.removeItem(AUTH_KEY); // Clear any previously stored token
    localStorage.removeItem(REMEMBER_KEY);
  }
}

function clearAuthToken() {
  localStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(AUTH_KEY);
}

function shouldRemember() {
  return localStorage.getItem(REMEMBER_KEY) === 'true';
}

function getThemePreference() {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
}

function resolveTheme(preference) {
  if (preference === 'auto') {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return preference;
}

function updateThemeToggleUi(preference) {
  if (!themeToggle) return;
  const label = THEME_LABELS[preference] || 'System';
  themeToggle.innerHTML = THEME_ICONS[preference] || THEME_ICONS.auto;
  themeToggle.setAttribute('aria-label', `Colour theme: ${label}. Click to change.`);
  themeToggle.setAttribute('title', `${label} theme`);
}

function applyTheme(preference) {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.body.dataset.theme = resolved;
  updateThemeToggleUi(preference);
}

function cycleTheme() {
  const current = getThemePreference();
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

function authHeaders() {
  const token = getAuthToken();
  return token ? { 'X-Auth-Token': token } : {};
}

// Auth UI
function showPasswordPrompt() {
  authOverlay.style.display = 'flex';
  rememberMe.checked = shouldRemember();
  passwordInput.focus();
}

function hidePasswordPrompt() {
  authOverlay.style.display = 'none';
}

async function checkAuth() {
  const token = getAuthToken();
  if (!token) {
    showPasswordPrompt();
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/list`, {
      headers: authHeaders(),
    });
    if (response.status === 401) {
      clearAuthToken();
      showPasswordPrompt();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function handlePasswordSubmit() {
  const password = passwordInput.value.trim();
  if (!password) return;

  setAuthToken(password, rememberMe.checked);

  try {
    const response = await fetch(`${API_BASE}/list`, {
      headers: authHeaders(),
    });
    if (response.status === 401) {
      clearAuthToken();
      showStatus('error', 'Invalid password');
      passwordInput.value = '';
      return;
    }
    hidePasswordPrompt();
    loadReceipts().then(() => loadYnabTodos());
  } catch {
    showStatus('error', 'Connection failed');
  }
}

// Validate file before upload
function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return `${file.name}: exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`;
  }

  const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `${file.name}: invalid type (${ext || 'no extension'})`;
  }

  return null; // Valid
}

// Upload a single file
async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE}/upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Upload failed');
  }

  return response.json();
}

// Truncate error list for display
function formatErrors(errors, max = 3) {
  if (errors.length <= max) return errors.join(', ');
  return errors.slice(0, max).join(', ') + ` ... and ${errors.length - max} more`;
}

// Upload files in parallel with pre-validation
async function uploadFiles(files) {
  if (files.length === 0) return;

  // Single-pass validation
  const validated = Array.from(files).map((file) => ({
    file,
    error: validateFile(file),
  }));

  const validFiles = validated.filter((v) => !v.error).map((v) => v.file);
  const validationErrors = validated.filter((v) => v.error).map((v) => v.error);

  if (validFiles.length === 0) {
    showStatus('error', formatErrors(validationErrors));
    return;
  }

  const skippedCount = validationErrors.length;
  showStatus('uploading', `Uploading ${validFiles.length} file(s)...`);

  const results = await Promise.allSettled(validFiles.map(uploadFile));

  const successCount = results.filter((r) => r.status === 'fulfilled').length;
  const failures = results.filter((r) => r.status === 'rejected');

  if (failures.length === 0 && skippedCount === 0) {
    showStatus('success', `Uploaded ${successCount} receipt(s)`);
  } else if (failures.length === 0) {
    showStatus('success', `Uploaded ${successCount}, skipped ${skippedCount} invalid`);
  } else {
    const errorMsgs = failures.map((r) => r.reason.message);
    showStatus('error', `${successCount} uploaded, ${failures.length} failed: ${formatErrors(errorMsgs)}`);
  }

  // Refresh list after upload
  loadReceipts();
}

// Load receipt list
async function loadReceipts() {
  try {
    const response = await fetch(`${API_BASE}/list`, {
      headers: authHeaders(),
    });

    if (response.status === 401) {
      showPasswordPrompt();
      return;
    }

    const data = await response.json();
    // Sort: unlinked first, then linked.
    // Unlinked receipts use effective receipt date (manual/AI/upload fallback) descending.
    receiptsData = data.receipts.sort((a, b) => {
      const aLinked = getLinkedClaimIds(a).length > 0;
      const bLinked = getLinkedClaimIds(b).length > 0;
      if (aLinked !== bLinked) return aLinked ? 1 : -1;

      if (!aLinked && !bLinked) {
        const aDate = getReceiptMatchDate(a).date;
        const bDate = getReceiptMatchDate(b).date;
        const aTime = aDate ? aDate.getTime() : 0;
        const bTime = bDate ? bDate.getTime() : 0;
        if (aTime !== bTime) return bTime - aTime;
      }

      return new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime();
    });

    const outstandingReceipts = receiptsData.filter((receipt) => getLinkedClaimIds(receipt).length === 0);
    countSpan.textContent = `(${outstandingReceipts.length})`;
    receiptBadge.textContent = outstandingReceipts.length || '';

    if (outstandingReceipts.length === 0) {
      receiptList.innerHTML = '<li class="empty-state">No outstanding receipts</li>';
      applyLinkingHighlights();
      renderLinkedPairs();
      triggerPendingAmountTagging();
      return;
    }

    receiptList.innerHTML = outstandingReceipts
      .map(r => {
        const dateDisplay = formatReceiptDateLabel(r);
        const name = getReceiptDisplayName(r);
        const parsedTaggedAmount = Number(r.taggedAmount);
        const taggedAmount = Number.isFinite(parsedTaggedAmount) ? parsedTaggedAmount : null;
        const currencyLabel = (r.taggedCurrency || '').toUpperCase();
        const parsedFxApprox = Number(r.taggedAmountSgdApprox);
        const taggedSgdApprox = Number.isFinite(parsedFxApprox) ? parsedFxApprox : null;
        const parsedFxApproxPlus = Number(r.taggedAmountSgdApproxPlus325);
        const taggedSgdApproxPlus325 = Number.isFinite(parsedFxApproxPlus) ? parsedFxApproxPlus : null;
        const vendor = (r.taggedVendor || '').trim();
        const purpose = (r.taggedPurpose || '').trim();
        const titleLabel = vendor && purpose ? `${vendor} - ${purpose}` : (vendor || purpose);
        const sgdLabel = taggedSgdApprox !== null
          ? `S$${taggedSgdApprox.toFixed(2)}${taggedSgdApproxPlus325 !== null ? ` (S$${taggedSgdApproxPlus325.toFixed(2)})` : ''}`
          : '';

        const primaryAmountBadge = taggedAmount !== null
          ? r.taggedCurrency === 'USD'
            ? sgdLabel
              ? `<span class="receipt-sgd-tag">${sgdLabel}</span>`
              : '<span class="receipt-ai-tag pending">SGD pending</span>'
            : `<span class="receipt-sgd-tag">${escapeHtml(formatCurrencyAmount(currencyLabel, taggedAmount))}</span>`
          : r.taggedStatus === 'missing'
            ? '<span class="receipt-ai-tag missing">No total</span>'
            : r.taggedStatus === 'error'
              ? `<span class="receipt-ai-tag error" title="${escapeHtml(r.taggedError || 'Tagging failed')}">Failed</span>`
              : '<span class="receipt-ai-tag pending">Pending</span>';

        const usdUnderName = r.taggedCurrency === 'USD' && taggedAmount !== null
          ? `<span class="receipt-usd-tag">${escapeHtml(formatCurrencyAmount('USD', taggedAmount))}</span>`
          : '';
        const titleUnderName = titleLabel
          ? `<span class="receipt-title-tag">${escapeHtml(titleLabel)}</span>`
          : '';
        const linkBtnIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>`;
        const deleteBtnIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <line x1="10" y1="11" x2="10" y2="17"/>
              <line x1="14" y1="11" x2="14" y2="17"/>
            </svg>`;
        return `
          <li data-key="${escapeHtml(r.key)}" data-name="${escapeHtml(name)}"
              data-linked="">
            <span class="select-indicator receipt-selector" aria-hidden="true">
              <span class="checkmark">✓</span>
            </span>
            <div class="receipt-info">
              <span class="receipt-name">${escapeHtml(name)}</span>
              ${titleUnderName}
              ${usdUnderName}
            </div>
            <div class="receipt-actions">
              <div class="receipt-meta">
                <span class="receipt-date ${dateDisplay.className}" title="${escapeHtml(dateDisplay.title)}">${dateDisplay.text}</span>
                ${primaryAmountBadge}
              </div>
              <button class="link-btn" title="Link to claim">
                ${linkBtnIcon}
              </button>
              <button class="delete-btn" title="Delete receipt">
                ${deleteBtnIcon}
              </button>
            </div>
          </li>
        `;
      })
      .join('');

    // Attach click handlers
    receiptList.querySelectorAll('li[data-key]').forEach(li => {
      li.addEventListener('click', (e) => handleReceiptClick(e, li));
      li.querySelector('.receipt-date').addEventListener('click', (e) => handleDateOverrideClick(e, li));
      li.querySelector('.link-btn').addEventListener('click', (e) => handleLinkBtnClick(e, li));
      li.querySelector('.delete-btn').addEventListener('click', (e) => handleDeleteBtnClick(e, li));
    });

    applyLinkingHighlights();
    renderLinkedPairs();
    triggerPendingAmountTagging();
  } catch (err) {
    console.error('Failed to load receipts:', err);
    receiptList.innerHTML = '<li class="empty-state">Failed to load receipts</li>';
  }
}

async function triggerPendingAmountTagging() {
  if (amountTaggingInFlight) return;
  if (Date.now() - lastAmountTagAttempt < AMOUNT_TAG_COOLDOWN_MS) return;

  const needsTagging = receiptsData.some((receipt) => getLinkedClaimIds(receipt).length === 0 && !receipt.taggedStatus);
  if (!needsTagging) return;

  amountTaggingInFlight = true;
  lastAmountTagAttempt = Date.now();

  try {
    const response = await fetch(`${API_BASE}/amount-tags/pending?limit=3`, {
      method: 'POST',
      headers: authHeaders(),
    });

    if (!response.ok || response.status === 401) {
      return;
    }

    const result = await response.json().catch(() => null);
    if (result && result.tagged > 0) {
      await loadReceipts();
    }
  } catch (error) {
    console.warn('Amount tagging trigger failed:', error);
  } finally {
    amountTaggingInFlight = false;
  }
}

// Show status message
function showStatus(type, message) {
  status.className = `status ${type}`;
  status.textContent = message;

  if (type === 'success') {
    setTimeout(() => {
      status.className = 'status';
    }, 3000);
  }
}

// Escape HTML
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function normaliseFilterTerm(term) {
  return String(term || '').trim().toLowerCase();
}

function loadClaimFilterState() {
  try {
    const stored = JSON.parse(localStorage.getItem(CLAIM_FILTER_KEY) || '{}');
    return {
      text: typeof stored.text === 'string' ? stored.text : '',
      quickFilters: Array.isArray(stored.quickFilters)
        ? stored.quickFilters.filter((term) => typeof term === 'string' && term.trim())
        : [],
    };
  } catch {
    return { text: '', quickFilters: [] };
  }
}

function saveClaimFilterState() {
  try {
    localStorage.setItem(CLAIM_FILTER_KEY, JSON.stringify(claimFilterState));
  } catch (error) {
    console.warn('Claim filter preferences could not be saved:', error);
  }
}

function getManualClaimFilterTerms() {
  return claimFilterState.text
    .split(/[,;\n]+/)
    .map(normaliseFilterTerm)
    .filter(Boolean);
}

function getClaimFilterTerms() {
  const quickTerms = claimFilterState.quickFilters.map(normaliseFilterTerm).filter(Boolean);
  return Array.from(new Set([...getManualClaimFilterTerms(), ...quickTerms]));
}

function getClaimSearchText(claim) {
  return [
    claim.description,
    claim.payee,
    claim.accountName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function claimMatchesHideFilter(claim, terms) {
  if (terms.length === 0) return false;
  const text = getClaimSearchText(claim);
  return terms.some((term) => {
    if (term === 'transfer') {
      return /^\s*transfer\s*:/i.test(claim.payee || '');
    }
    return text.includes(term);
  });
}

function renderClaimFilterControls() {
  if (!claimFilterInput || !claimFilterPills || !claimFilterClear) return;

  if (document.activeElement !== claimFilterInput && claimFilterInput.value !== claimFilterState.text) {
    claimFilterInput.value = claimFilterState.text;
  }
  const activeQuickFilters = new Set(claimFilterState.quickFilters.map(normaliseFilterTerm));
  claimFilterPills.innerHTML = DEFAULT_CLAIM_FILTERS.map((term) => {
    const isActive = activeQuickFilters.has(normaliseFilterTerm(term));
    return `
      <button
        class="claim-filter-pill${isActive ? ' active' : ''}"
        type="button"
        data-filter="${escapeHtml(term)}"
        aria-pressed="${isActive ? 'true' : 'false'}"
      >${escapeHtml(term)}</button>
    `;
  }).join('');

  const hasFilters = claimFilterState.text.trim() || claimFilterState.quickFilters.length > 0;
  claimFilterClear.hidden = !hasFilters;
}

function pruneClaimSelectionToVisibleClaims(visibleClaims) {
  const visibleClaimIds = new Set(visibleClaims.map((claim) => claim.id));

  if (linkingSource === 'receipt') {
    selectedClaimIds = new Set(
      Array.from(selectedClaimIds).filter((claimId) => visibleClaimIds.has(claimId))
    );
  }

  if (linkingSource === 'claim' && sourceClaimId && !visibleClaimIds.has(sourceClaimId)) {
    linkingSource = null;
    sourceClaimId = null;
    selectedClaimIds.clear();
    selectedReceiptKeys.clear();
  }
}

function renderClaimLoadError(message) {
  todoList.innerHTML = `<li class="empty-state">${escapeHtml(message)}</li>`;
  todoCount.textContent = '(error)';
  claimBadge.textContent = '';
}

function resetClaimsAfterLoadFailure(message) {
  claimsLoadErrorMessage = message || 'Failed to load claims';
  claimsData = [];
  clearSelection();
  renderClaimLoadError(claimsLoadErrorMessage);
  linkedCount.textContent = '(error)';
  linkedList.innerHTML = '<li class="empty-state">Claims unavailable</li>';
  renderInvoiceClaimLoadError();
}

function formatDateForLocale(date) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatCurrencyAmount(currency, amount) {
  if (!Number.isFinite(amount)) return '';
  if (currency === 'SGD') return `S$${amount.toFixed(2)}`;
  if (currency) return `${currency} ${amount.toFixed(2)}`;
  return amount.toFixed(2);
}

function parseDateOnly(value) {
  if (!value) return null;
  const normalised = RECEIPT_DATE_RE.test(value) ? `${value}T00:00:00Z` : value;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs(dateA.getTime() - dateB.getTime()) / msPerDay);
}

function getReceiptMatchDate(receipt) {
  const explicitDate = parseDateOnly(receipt.receiptDate);
  if (explicitDate) {
    return {
      date: explicitDate,
      source: receipt.receiptDateSource || 'manual',
    };
  }

  const detectedDate = parseDateOnly(receipt.detectedReceiptDate);
  if (detectedDate) {
    return {
      date: detectedDate,
      source: 'ai',
    };
  }

  const uploadedDate = parseDateOnly(receipt.uploaded);
  if (uploadedDate) {
    return {
      date: uploadedDate,
      source: 'upload',
    };
  }

  return { date: null, source: null };
}

function getLinkedClaimIds(receipt) {
  if (Array.isArray(receipt.linkedClaimIds)) {
    return receipt.linkedClaimIds.filter((claimId) => typeof claimId === 'string' && claimId.length > 0);
  }
  if (typeof receipt.linkedClaimId === 'string' && receipt.linkedClaimId.length > 0) {
    return [receipt.linkedClaimId];
  }
  return [];
}

function getReadyClaimId(receipt) {
  return `${READY_CLAIM_ID_PREFIX}${receipt.key}`;
}

function isReadyOnlyClaimId(claimId) {
  return typeof claimId === 'string' && claimId.startsWith(READY_CLAIM_ID_PREFIX);
}

function getReceiptDisplayName(receipt) {
  const key = typeof receipt.key === 'string' ? receipt.key : '';
  const originalName = typeof receipt.originalName === 'string' ? receipt.originalName.trim() : '';
  if (originalName) return originalName;
  const keyWithoutPrefix = key.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}_/, '');
  return keyWithoutPrefix || key || 'Receipt';
}

function getLinkedClaimJumpLabel(receipt, claimId, index = 0) {
  if (isReadyOnlyClaimId(claimId)) {
    return 'Receipt ready';
  }

  const linkedClaim = claimsData.find((claim) => claim.id === claimId);
  if (linkedClaim) {
    const description = (linkedClaim.description || '').trim();
    if (description) return description;
    const payee = (linkedClaim.payee || '').trim();
    if (payee) return payee;
  }

  const linkedClaimIds = getLinkedClaimIds(receipt);
  const fallbackDescription = (receipt.linkedClaimDescription || '').trim();
  if (fallbackDescription && linkedClaimIds.length === 1) {
    return fallbackDescription;
  }

  const shortId = typeof claimId === 'string' && claimId.length >= 6
    ? claimId.slice(-6)
    : `${index + 1}`;
  return `Claim ${shortId}`;
}

function formatLinkedPairReceiptAmount(receipt) {
  const taggedAmount = Number(receipt.taggedAmount);
  if (!Number.isFinite(taggedAmount)) return 'Amount pending';

  const currency = (receipt.taggedCurrency || '').toUpperCase();
  if (currency !== 'USD') {
    return formatCurrencyAmount(currency, taggedAmount);
  }

  const fxApproxPlus = Number(receipt.taggedAmountSgdApproxPlus325);
  const fxApprox = Number(receipt.taggedAmountSgdApprox);
  if (Number.isFinite(fxApproxPlus)) {
    return `${formatCurrencyAmount('USD', taggedAmount)} (~S$${fxApproxPlus.toFixed(2)})`;
  }
  if (Number.isFinite(fxApprox)) {
    return `${formatCurrencyAmount('USD', taggedAmount)} (~S$${fxApprox.toFixed(2)})`;
  }
  return formatCurrencyAmount('USD', taggedAmount);
}

function countReadyToClaimPairs() {
  if (claimsLoadErrorMessage) return 0;
  let count = 0;
  receiptsData.forEach((receipt) => {
    count += getLinkedClaimIds(receipt).length;
  });
  return count;
}

function updateInvoicesNavBadge() {
  if (!invoicesNavBadge) return;
  const count = countReadyToClaimPairs();
  if (count > 0) {
    invoicesNavBadge.textContent = String(count);
    invoicesNavBadge.hidden = false;
  } else {
    invoicesNavBadge.hidden = true;
  }
}

function renderLinkedPairs() {
  if (claimsLoadErrorMessage) {
    linkedCount.textContent = '(error)';
    linkedList.innerHTML = '<li class="empty-state">Claims unavailable</li>';
    updateInvoicesNavBadge();
    return;
  }

  const claimsById = new Map(claimsData.map((claim) => [claim.id, claim]));
  const linkedPairs = [];

  receiptsData.forEach((receipt) => {
    getLinkedClaimIds(receipt).forEach((claimId, index) => {
      linkedPairs.push({
        receipt,
        claimId,
        index,
        claim: claimsById.get(claimId) || null,
      });
    });
  });

  linkedPairs.sort((a, b) => {
    const aClaimDate = parseDateOnly(a.claim?.date);
    const bClaimDate = parseDateOnly(b.claim?.date);
    const aReceiptDate = getReceiptMatchDate(a.receipt).date;
    const bReceiptDate = getReceiptMatchDate(b.receipt).date;
    const aDate = aClaimDate || aReceiptDate || new Date(0);
    const bDate = bClaimDate || bReceiptDate || new Date(0);
    return bDate.getTime() - aDate.getTime();
  });

  linkedCount.textContent = `(${linkedPairs.length})`;
  updateInvoicesNavBadge();

  if (linkedPairs.length === 0) {
    linkedList.innerHTML = '<li class="empty-state">No linked claim-receipt pairs yet</li>';
    return;
  }

  linkedList.innerHTML = linkedPairs
    .map((pair) => {
      const { receipt, claim, claimId, index } = pair;
      const isReadyOnly = isReadyOnlyClaimId(claimId);
      const claimTitle = claim
        ? (claim.description || claim.payee || getLinkedClaimJumpLabel(receipt, claimId, index))
        : getLinkedClaimJumpLabel(receipt, claimId, index);
      const claimSub = claim
        ? (claim.payee || (claim.accountName || 'Unknown account'))
        : isReadyOnly
          ? 'No YNAB claim linked'
          : 'Claim details unavailable';
      const claimDate = claim
        ? formatDateForLocale(parseDateOnly(claim.date) || new Date(claim.date))
        : isReadyOnly
          ? 'Ready'
          : 'Unknown date';
      const claimAmount = claim && Number.isFinite(Number(claim.amount))
        ? `$${Number(claim.amount).toFixed(2)}`
        : isReadyOnly
          ? 'Receipt amount'
          : 'Unknown amount';

      const receiptName = getReceiptDisplayName(receipt);
      const receiptTitle = [receipt.taggedVendor, receipt.taggedPurpose]
        .filter((part) => typeof part === 'string' && part.trim())
        .map((part) => part.trim())
        .join(' - ');
      const receiptDateInfo = formatReceiptDateLabel(receipt);
      const receiptAmount = formatLinkedPairReceiptAmount(receipt);

      return `
        <li class="linked-pair-item" data-receipt-key="${escapeHtml(receipt.key)}" data-claim-id="${escapeHtml(claimId)}">
          <div class="linked-pair-side linked-pair-claim">
            <span class="linked-pair-title">${escapeHtml(claimTitle)}</span>
            <span class="linked-pair-sub">${escapeHtml(claimSub)}</span>
            <span class="linked-pair-meta">${escapeHtml(claimDate)} · ${escapeHtml(claimAmount)}</span>
          </div>
          <div class="linked-pair-connector" aria-hidden="true">${isReadyOnly ? '✓' : '↔'}</div>
          <button type="button" class="linked-pair-side linked-pair-receipt"
              data-receipt-key="${escapeHtml(receipt.key)}"
              data-receipt-name="${escapeHtml(receiptName)}"
              title="Preview receipt">
            <span class="linked-pair-title">${escapeHtml(receiptName)}</span>
            <span class="linked-pair-sub">${escapeHtml(receiptTitle || 'Receipt')}</span>
            <span class="linked-pair-meta">${escapeHtml(receiptDateInfo.text)} · ${escapeHtml(receiptAmount)}</span>
          </button>
          <button type="button" class="linked-pair-unlink"
              data-receipt-key="${escapeHtml(receipt.key)}"
              data-claim-id="${escapeHtml(claimId)}">Unlink</button>
        </li>
      `;
    })
    .join('');

  linkedList.querySelectorAll('.linked-pair-receipt').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const key = btn.dataset.receiptKey;
      const name = btn.dataset.receiptName;
      if (!key || !name) return;
      openPreview(key, name);
    });
  });

  linkedList.querySelectorAll('.linked-pair-unlink').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const receiptKey = btn.dataset.receiptKey;
      const claimId = btn.dataset.claimId;
      if (!receiptKey || !claimId) return;

      const receipt = receiptsData.find((item) => item.key === receiptKey);
      const linkedCountForReceipt = receipt ? getLinkedClaimIds(receipt).length : 1;
      const confirmation = linkedCountForReceipt > 1
        ? `This receipt is linked to ${linkedCountForReceipt} claims. Unlink only this pair?`
        : 'Unlink this claim-receipt pair?';

      if (!window.confirm(confirmation)) return;
      await unlinkClaimFromReceipt(receiptKey, claimId);
    });
  });
}

function formatReceiptDateLabel(receipt) {
  const matchDate = getReceiptMatchDate(receipt);
  if (!matchDate.date) {
    return { text: 'Unknown date', className: '', title: 'No date available' };
  }

  const formatted = formatDateForLocale(matchDate.date);
  if (matchDate.source === 'manual') {
    return {
      text: `Manual ${formatted}`,
      className: 'receipt-date-manual',
      title: 'Manually overridden receipt date',
    };
  }
  if (matchDate.source === 'ai') {
    return {
      text: formatted,
      className: 'receipt-date-ai',
      title: 'AI detected receipt date',
    };
  }

  return { text: formatted, className: '', title: 'Upload date fallback' };
}

function getComparableReceiptAmounts(receipt) {
  const baseAmount = Number(receipt.taggedAmount);
  const fxAmount = Number(receipt.taggedAmountSgdApprox);
  const fxAmountPlus325 = Number(receipt.taggedAmountSgdApproxPlus325);
  const values = [];

  if (Number.isFinite(baseAmount)) {
    values.push({ value: baseAmount, kind: 'base' });
  }
  if (Number.isFinite(fxAmount)) {
    values.push({ value: fxAmount, kind: 'fx' });
  }
  if (Number.isFinite(fxAmountPlus325)) {
    values.push({ value: fxAmountPlus325, kind: 'fx-plus' });
  }

  return values;
}

function scoreReceiptClaimMatch(receipt, claim) {
  const claimAmount = Number(claim.amount);
  const hasClaimAmount = Number.isFinite(claimAmount);
  const comparableAmounts = getComparableReceiptAmounts(receipt);
  const matchedAmount = hasClaimAmount
    ? comparableAmounts.find((candidate) => Math.abs(claimAmount - candidate.value) <= AMOUNT_MATCH_TOLERANCE)
    : null;
  const amountMatch = Boolean(matchedAmount);

  const claimDate = parseDateOnly(claim.date);
  const receiptDateInfo = getReceiptMatchDate(receipt);
  const dayDiff = daysBetween(claimDate, receiptDateInfo.date);
  const isExactDate = dayDiff === 0;
  const isNearDate = dayDiff !== null && dayDiff >= 1 && dayDiff <= DATE_NEAR_THRESHOLD_DAYS;

  if (amountMatch && (isExactDate || isNearDate)) {
    return {
      className: 'match-best',
      label: matchedAmount && matchedAmount.kind.startsWith('fx') ? 'Best FX match' : 'Best match',
    };
  }
  if (amountMatch) {
    return {
      className: 'match-amount',
      label: matchedAmount && matchedAmount.kind.startsWith('fx') ? 'FX amount match' : 'Amount match',
    };
  }
  if (isExactDate) {
    return { className: 'match-date', label: 'Date match' };
  }
  if (isNearDate) {
    return { className: 'match-date-near', label: 'Near date' };
  }
  return { className: '', label: '' };
}

function clearMatchDecorations(root) {
  root.querySelectorAll('.match-badge').forEach((badge) => badge.remove());
  root.querySelectorAll('.match-best, .match-amount, .match-date, .match-date-near').forEach((item) => {
    item.classList.remove('match-best', 'match-amount', 'match-date', 'match-date-near');
  });
}

function appendMatchBadge(li, label, listType) {
  if (!label) return;
  const badge = document.createElement('span');
  badge.className = 'match-badge';
  badge.textContent = label;
  const container = listType === 'receipt'
    ? li.querySelector('.receipt-meta')
    : li.querySelector('.todo-meta');
  if (container) {
    container.appendChild(badge);
  }
}

function updateActionBar() {
  if (!linkingSource) {
    actionBar.classList.remove('visible');
    confirmSelection.hidden = true;
    confirmSelection.disabled = true;
    markReadySelection.hidden = true;
    markReadySelection.disabled = true;
    return;
  }

  actionBar.classList.add('visible');

  if (linkingSource === 'receipt') {
    const selectionCount = selectedClaimIds.size;
    if (selectionCount === 0) {
      actionText.textContent = 'Receipt selected. Tick a claim or mark ready';
      confirmSelection.hidden = true;
      confirmSelection.disabled = true;
      markReadySelection.textContent = 'Mark ready';
      markReadySelection.hidden = false;
      markReadySelection.disabled = false;
      return;
    }

    actionText.textContent = `${selectionCount} claim${selectionCount === 1 ? '' : 's'} selected`;
    confirmSelection.textContent = `Link ${selectionCount}`;
    confirmSelection.hidden = false;
    confirmSelection.disabled = false;
    markReadySelection.hidden = true;
    markReadySelection.disabled = true;
    return;
  }

  markReadySelection.hidden = true;
  markReadySelection.disabled = true;

  const selectionCount = selectedReceiptKeys.size;
  if (selectionCount === 0) {
    actionText.textContent = 'Claim selected. Tick receipt(s) to link';
    confirmSelection.hidden = true;
    confirmSelection.disabled = true;
    return;
  }

  actionText.textContent = `${selectionCount} receipt${selectionCount === 1 ? '' : 's'} selected`;
  confirmSelection.textContent = `Link ${selectionCount}`;
  confirmSelection.hidden = false;
  confirmSelection.disabled = false;
}

function applyLinkingHighlights() {
  if (sourceClaimId && !claimsData.some((claim) => claim.id === sourceClaimId)) {
    sourceClaimId = null;
  }

  if (sourceReceiptKey && !receiptsData.some((receipt) => receipt.key === sourceReceiptKey)) {
    sourceReceiptKey = null;
  }

  selectedReceiptKeys = new Set(
    Array.from(selectedReceiptKeys).filter((key) => receiptsData.some((receipt) => receipt.key === key))
  );
  selectedClaimIds = new Set(
    Array.from(selectedClaimIds).filter((claimId) => claimsData.some((claim) => claim.id === claimId))
  );

  if (linkingSource === 'receipt') {
    selectedReceiptKeys = sourceReceiptKey ? new Set([sourceReceiptKey]) : new Set();
    if (!sourceReceiptKey) {
      linkingSource = null;
    }
  }

  if (linkingSource === 'claim') {
    selectedClaimIds.clear();
    if (!sourceClaimId) {
      linkingSource = null;
    }
  }

  if (!linkingSource) {
    selectedReceiptKeys.clear();
    selectedClaimIds.clear();
  }

  if (!linkingSource) {
    document.body.classList.remove('selecting');
  } else {
    document.body.classList.add('selecting');
  }

  updateActionBar();
  clearMatchDecorations(receiptList);
  clearMatchDecorations(todoList);

  receiptList.querySelectorAll('li[data-key]').forEach((li) => {
    const key = li.dataset.key;
    const isChecked = linkingSource === 'claim' && selectedReceiptKeys.has(key);
    const isSource = linkingSource === 'receipt' && sourceReceiptKey === key;
    li.classList.remove('selected');
    li.classList.toggle('show-selector', linkingSource === 'claim');
    li.classList.toggle('checked', isChecked);
    li.classList.toggle('source-selected', isSource);
  });

  todoList.querySelectorAll('.todo-item[data-claim-id]').forEach((li) => {
    const claimId = li.dataset.claimId;
    const isChecked = linkingSource === 'receipt' && selectedClaimIds.has(claimId);
    const isSource = linkingSource === 'claim' && sourceClaimId === claimId;
    li.classList.remove('selected');
    li.classList.toggle('show-selector', linkingSource === 'receipt');
    li.classList.toggle('checked', isChecked);
    li.classList.toggle('source-selected', isSource);
  });

  if (linkingSource === 'claim' && sourceClaimId) {
    const selectedClaim = claimsData.find((claim) => claim.id === sourceClaimId);
    if (!selectedClaim) return;

    receiptList.querySelectorAll('li[data-key]').forEach((li) => {
      const receipt = receiptsData.find((item) => item.key === li.dataset.key);
      if (!receipt) return;
      const match = scoreReceiptClaimMatch(receipt, selectedClaim);
      if (!match.className) return;
      li.classList.add(match.className);
      appendMatchBadge(li, match.label, 'receipt');
    });
  }

  if (linkingSource === 'receipt' && sourceReceiptKey) {
    const selectedReceipt = receiptsData.find((receipt) => receipt.key === sourceReceiptKey);
    if (!selectedReceipt) return;

    todoList.querySelectorAll('.todo-item[data-claim-id]').forEach((li) => {
      const claim = claimsData.find((item) => item.id === li.dataset.claimId);
      if (!claim) return;
      const match = scoreReceiptClaimMatch(selectedReceipt, claim);
      if (!match.className) return;
      li.classList.add(match.className);
      appendMatchBadge(li, match.label, 'claim');
    });
  }
}

// Preview modal functions
async function openPreview(key, displayName) {
  previewFilename.textContent = displayName;
  previewImage.classList.remove('visible');
  previewPdf.classList.remove('visible');
  previewSpinner.classList.add('loading');
  previewOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';

  const url = `${API_BASE}/receipt/${encodeURIComponent(key)}`;
  const isPdf = key.toLowerCase().endsWith('.pdf');

  try {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error('Failed to load');

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    if (isPdf) {
      previewPdf.src = blobUrl;
      previewPdf.onload = () => {
        previewSpinner.classList.remove('loading');
        previewPdf.classList.add('visible');
      };
    } else {
      previewImage.src = blobUrl;
      previewImage.onload = () => {
        previewSpinner.classList.remove('loading');
        previewImage.classList.add('visible');
      };
    }
  } catch (err) {
    previewSpinner.classList.remove('loading');
    previewFilename.textContent = `${displayName} (failed to load)`;
    console.error('Preview failed:', err);
  }
}

function closePreview() {
  previewOverlay.classList.remove('active');
  document.body.style.overflow = '';
  // Clean up after animation
  setTimeout(() => {
    // Revoke blob URLs to free memory
    if (previewImage.src.startsWith('blob:')) URL.revokeObjectURL(previewImage.src);
    if (previewPdf.src.startsWith('blob:')) URL.revokeObjectURL(previewPdf.src);
    previewImage.src = '';
    previewPdf.src = '';
    previewImage.classList.remove('visible');
    previewPdf.classList.remove('visible');
  }, 250);
}

// Preview event listeners
previewClose.addEventListener('click', closePreview);
previewBackdrop.addEventListener('click', closePreview);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewOverlay.classList.contains('active')) {
    closePreview();
  }
});
if (themeToggle) {
  themeToggle.addEventListener('click', cycleTheme);
}
applyTheme(getThemePreference());
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemePreference() === 'auto') applyTheme('auto');
  });
}

// Event listeners
fileInput.addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = ''; // Reset for re-upload
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  uploadFiles(e.dataTransfer.files);
});

// Load YNAB TODOs
async function loadYnabTodos() {
  todoList.innerHTML = '<li class="loading-state"><span class="spinner"></span> Loading...</li>';

  try {
    const response = await fetch(`${API_BASE}/ynab/todos`, {
      headers: authHeaders(),
    });

    const data = await response.json().catch(() => null);

    if (response.status === 401 && (!data || data.error === 'Unauthorized')) {
      clearAuthToken();
      resetClaimsAfterLoadFailure('Authentication required');
      showPasswordPrompt();
      return;
    }

    if (!data) {
      throw new Error(`Failed to fetch claims (${response.status})`);
    }

    if (data.error) {
      resetClaimsAfterLoadFailure(`Error: ${data.error}`);
      return;
    }

    claimsLoadErrorMessage = '';
    claimsData = data.todos.sort((a, b) => new Date(b.date) - new Date(a.date));
    renderOutstandingClaims();
    renderLinkedPairs();
  } catch (err) {
    console.error('Failed to load YNAB todos:', err);
    resetClaimsAfterLoadFailure('Failed to load claims');
  }
}

function getOutstandingClaims() {
  const linkedReceiptsByClaimId = new Map();
  receiptsData.forEach((receipt) => {
    const linkedClaimIds = getLinkedClaimIds(receipt);
    linkedClaimIds.forEach((linkedClaimId) => {
      const linkedReceipts = linkedReceiptsByClaimId.get(linkedClaimId) || [];
      linkedReceipts.push(receipt);
      linkedReceiptsByClaimId.set(linkedClaimId, linkedReceipts);
    });
  });

  return claimsData.filter((claim) => !linkedReceiptsByClaimId.has(claim.id));
}

function renderOutstandingClaims() {
  renderClaimFilterControls();

  if (claimsLoadErrorMessage) {
    renderClaimLoadError(claimsLoadErrorMessage);
    applyLinkingHighlights();
    return;
  }

  const outstandingClaims = getOutstandingClaims();
  const filterTerms = getClaimFilterTerms();
  const visibleClaims = outstandingClaims.filter((claim) => !claimMatchesHideFilter(claim, filterTerms));
  pruneClaimSelectionToVisibleClaims(visibleClaims);

  todoCount.textContent = filterTerms.length > 0
    ? `(${visibleClaims.length} of ${outstandingClaims.length})`
    : `(${outstandingClaims.length})`;
  claimBadge.textContent = filterTerms.length > 0 && outstandingClaims.length > 0
    ? `${visibleClaims.length}/${outstandingClaims.length}`
    : outstandingClaims.length || '';

  if (outstandingClaims.length === 0) {
    todoList.innerHTML = '<li class="empty-state">No outstanding claims</li>';
    applyLinkingHighlights();
    return;
  }

  if (visibleClaims.length === 0) {
    todoList.innerHTML = '<li class="empty-state">No outstanding claims match the current filters</li>';
    applyLinkingHighlights();
    return;
  }

  todoList.innerHTML = visibleClaims
    .map((t) => {
      const accountName = (t.accountName || '').trim();
      const accountLabel = accountName || 'Unknown account';
      const linkBtnIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>`;
      return `
        <li class="todo-item" data-claim-id="${escapeHtml(t.id)}"
            data-amount="${t.amount}" data-description="${escapeHtml(t.description)}"
            data-date="${t.date}">
          <span class="select-indicator claim-selector" aria-hidden="true">
            <span class="checkmark">✓</span>
          </span>
          <div class="todo-content">
            <span class="todo-payee">${escapeHtml(t.description)}</span>
            <span class="todo-desc">${escapeHtml(t.payee)}</span>
            <span class="todo-account">Account: ${escapeHtml(accountLabel)}</span>
          </div>
          <div class="todo-actions">
            <div class="todo-meta">
              <span class="todo-date">${formatDateForLocale(parseDateOnly(t.date) || new Date(t.date))}</span>
              <span class="todo-amount">$${t.amount.toFixed(2)}</span>
            </div>
            <button class="link-btn claim-link-btn" title="Link receipts to this claim">
              ${linkBtnIcon}
            </button>
          </div>
        </li>
      `;
    })
    .join('');

  // Attach click handlers for linking
  todoList.querySelectorAll('.todo-item[data-claim-id]').forEach(li => {
    li.addEventListener('click', (e) => handleClaimClick(e, li));
    li.querySelector('.claim-link-btn').addEventListener('click', (e) => handleClaimLinkBtnClick(e, li));
  });
  applyLinkingHighlights();
}

refreshBtn.addEventListener('click', async () => {
  await loadReceipts();
  await loadYnabTodos();
});

if (claimFilterInput) {
  claimFilterState = loadClaimFilterState();
  renderClaimFilterControls();

  claimFilterInput.addEventListener('input', () => {
    claimFilterState.text = claimFilterInput.value;
    saveClaimFilterState();
    renderOutstandingClaims();
  });
}

if (claimFilterPills) {
  claimFilterPills.addEventListener('click', (event) => {
    const button = event.target.closest('.claim-filter-pill');
    if (!button) return;
    const filter = button.dataset.filter || '';
    const normalisedFilter = normaliseFilterTerm(filter);
    const activeQuickFilters = new Set(claimFilterState.quickFilters.map(normaliseFilterTerm));
    if (activeQuickFilters.has(normalisedFilter)) {
      claimFilterState.quickFilters = claimFilterState.quickFilters
        .filter((term) => normaliseFilterTerm(term) !== normalisedFilter);
    } else {
      claimFilterState.quickFilters = [...claimFilterState.quickFilters, filter];
    }
    saveClaimFilterState();
    renderOutstandingClaims();
    Array.from(claimFilterPills.querySelectorAll('.claim-filter-pill'))
      .find((pill) => pill.dataset.filter === filter)
      ?.focus();
  });
}

if (claimFilterClear) {
  claimFilterClear.addEventListener('click', () => {
    claimFilterState = { text: '', quickFilters: [] };
    saveClaimFilterState();
    renderOutstandingClaims();
    claimFilterInput?.focus();
  });
}

authSubmit.addEventListener('click', handlePasswordSubmit);
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handlePasswordSubmit();
});

// ===== Receipt-Claim Linking =====

// Handle receipt click - preview by default, toggle target selection while linking from claim
function handleReceiptClick(e, li) {
  if (
    e.target.closest('.link-btn') ||
    e.target.closest('.delete-btn') ||
    e.target.closest('.date-btn') ||
    e.target.closest('.receipt-date')
  ) return;

  const key = li.dataset.key;
  const name = li.dataset.name;

  if (linkingSource === 'claim' && sourceClaimId) {
    if (selectedReceiptKeys.has(key)) {
      selectedReceiptKeys.delete(key);
    } else {
      selectedReceiptKeys.add(key);
    }
    applyLinkingHighlights();
    return;
  }

  openPreview(key, name);
}

async function handleDateOverrideClick(e, li) {
  e.stopPropagation();
  const receiptKey = li.dataset.key;
  const receipt = receiptsData.find((item) => item.key === receiptKey);
  if (!receipt) return;

  const suggestedValue =
    receipt.receiptDateSource === 'manual'
      ? receipt.receiptDate || ''
      : receipt.receiptDate || receipt.detectedReceiptDate || '';
  const entered = window.prompt('Set receipt date (YYYY-MM-DD). Leave empty to clear manual override.', suggestedValue);
  if (entered === null) return;

  const nextValue = entered.trim();
  if (nextValue && !RECEIPT_DATE_RE.test(nextValue)) {
    showStatus('error', 'Date must be in YYYY-MM-DD format');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/receipt/${encodeURIComponent(receiptKey)}/receipt-date`, {
      method: 'PATCH',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receiptDate: nextValue || null,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showStatus('error', data.error || 'Failed to update receipt date');
      return;
    }

    showStatus('success', nextValue ? 'Receipt date updated' : 'Manual date override cleared');
    loadReceipts().then(() => loadYnabTodos());
  } catch (error) {
    console.error('Date override failed:', error);
    showStatus('error', 'Failed to update receipt date');
  }
}

// Handle receipt link button click
function handleLinkBtnClick(e, li) {
  e.stopPropagation();
  const key = li.dataset.key;
  const isLinked = li.dataset.linked;

  if (isLinked) {
    if (confirm('Unlink this receipt from its claim?')) {
      unlinkReceipt(key);
    }
    return;
  }

  if (linkingSource === 'claim' && sourceClaimId) {
    if (selectedReceiptKeys.has(key)) {
      selectedReceiptKeys.delete(key);
    } else {
      selectedReceiptKeys.add(key);
    }
    applyLinkingHighlights();
    return;
  }

  startReceiptLinkFlow(key);
}

async function handleDeleteBtnClick(e, li) {
  e.stopPropagation();
  const key = li.dataset.key;
  const isLinked = Boolean(li.dataset.linked);
  const prompt = isLinked
    ? 'Delete this linked receipt? The link will be removed too.'
    : 'Delete this receipt?';

  if (!confirm(prompt)) return;
  await deleteReceipt(key);
}

function handleClaimLinkBtnClick(e, li) {
  e.stopPropagation();
  const claimId = li.dataset.claimId;

  if (linkingSource === 'receipt' && sourceReceiptKey) {
    if (selectedClaimIds.has(claimId)) {
      selectedClaimIds.delete(claimId);
    } else {
      selectedClaimIds.add(claimId);
    }
    applyLinkingHighlights();
    return;
  }

  startClaimLinkFlow(claimId);
}

// Handle claim click - toggle target selection while linking from receipt
function handleClaimClick(_e, li) {
  if (linkingSource === 'receipt' && sourceReceiptKey) {
    const claimId = li.dataset.claimId;
    if (selectedClaimIds.has(claimId)) {
      selectedClaimIds.delete(claimId);
    } else {
      selectedClaimIds.add(claimId);
    }
    applyLinkingHighlights();
  }
}

// Step 1 from receipt side: pick source receipt, then choose claim target(s)
function startReceiptLinkFlow(key) {
  linkingSource = 'receipt';
  sourceReceiptKey = key;
  sourceClaimId = null;
  selectedClaimIds.clear();
  selectedReceiptKeys = new Set([key]);
  document.body.classList.add('selecting');
  applyLinkingHighlights();

  if (window.innerWidth <= 700) {
    switchTab('claims');
  }
}

// Step 1 from claim side: pick source claim, then choose receipt target(s)
function startClaimLinkFlow(claimId) {
  linkingSource = 'claim';
  sourceClaimId = claimId;
  sourceReceiptKey = null;
  selectedReceiptKeys.clear();
  selectedClaimIds.clear();
  document.body.classList.add('selecting');
  applyLinkingHighlights();

  if (window.innerWidth <= 700) {
    switchTab('receipts');
  }
}

// Clear all link selections
function clearSelection() {
  linkingSource = null;
  sourceReceiptKey = null;
  sourceClaimId = null;
  selectedReceiptKeys.clear();
  selectedClaimIds.clear();
  document.body.classList.remove('selecting');
  applyLinkingHighlights();
}

async function patchReceiptLink(receiptKey, claim) {
  return patchReceiptLinks(receiptKey, [claim]);
}

async function patchReceiptLinks(receiptKey, claims) {
  try {
    const response = await fetch(`${API_BASE}/receipt/${encodeURIComponent(receiptKey)}/link`, {
      method: 'PATCH',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        linkedClaims: claims.map((claim) => ({
          id: claim.id,
          description: claim.description,
          amount: claim.amount,
          date: claim.date,
        })),
      }),
    });

    if (response.ok) {
      return { ok: true };
    }

    const data = await response.json().catch(() => ({}));
    return { ok: false, error: data.error || 'Failed to link' };
  } catch (err) {
    console.error('Link failed:', err);
    return { ok: false, error: 'Failed to link receipt' };
  }
}

async function linkSelectedReceiptsToClaim() {
  if (linkingSource !== 'claim' || !sourceClaimId || selectedReceiptKeys.size === 0) {
    return;
  }

  const claimId = sourceClaimId;
  const claim = claimsData.find((item) => item.id === claimId);
  if (!claim) {
    showStatus('error', 'Selected claim not found');
    return;
  }

  const receiptKeys = Array.from(selectedReceiptKeys);
  showStatus('uploading', `Linking ${receiptKeys.length} receipt(s)...`);

  const results = await Promise.all(receiptKeys.map((key) => patchReceiptLink(key, claim)));
  const successCount = results.filter((result) => result.ok).length;
  const failedResults = results.filter((result) => !result.ok);

  if (failedResults.length === 0) {
    showStatus('success', `Linked ${successCount} receipt(s)`);
  } else {
    const errorSummary = failedResults
      .slice(0, 2)
      .map((result) => result.error)
      .join(', ');
    showStatus(
      'error',
      `Linked ${successCount}, failed ${failedResults.length}${errorSummary ? `: ${errorSummary}` : ''}`
    );
  }

  clearSelection();
  loadReceipts().then(() => loadYnabTodos());
}

async function linkSourceReceiptToClaim() {
  if (linkingSource !== 'receipt' || !sourceReceiptKey || selectedClaimIds.size === 0) {
    return;
  }

  const claims = Array.from(selectedClaimIds)
    .map((claimId) => claimsData.find((item) => item.id === claimId))
    .filter(Boolean);
  if (claims.length === 0) {
    showStatus('error', 'Selected claim not found');
    return;
  }

  showStatus('uploading', `Linking ${claims.length} claim(s)...`);
  const result = await patchReceiptLinks(sourceReceiptKey, claims);

  if (result.ok) {
    showStatus('success', `Linked ${claims.length} claim(s)`);
  } else {
    showStatus('error', result.error || 'Failed to link');
  }

  clearSelection();
  loadReceipts().then(() => loadYnabTodos());
}

function buildReadyClaimPayload(receipt) {
  const receiptName = getReceiptDisplayName(receipt);
  const title = [receipt.taggedVendor, receipt.taggedPurpose]
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim())
    .join(' - ');
  const dateInfo = getReceiptMatchDate(receipt);
  const comparableAmounts = getComparableReceiptAmounts(receipt);
  const preferredAmount = comparableAmounts.find((amount) => amount.kind === 'fx-plus') ||
    comparableAmounts.find((amount) => amount.kind === 'fx') ||
    comparableAmounts[0];

  return {
    id: getReadyClaimId(receipt),
    description: title || receiptName || 'Receipt ready',
    amount: preferredAmount?.value,
    date: dateInfo.date ? dateInfo.date.toISOString().slice(0, 10) : undefined,
  };
}

async function markSourceReceiptReady() {
  if (linkingSource !== 'receipt' || !sourceReceiptKey || selectedClaimIds.size > 0) {
    return;
  }

  const receipt = receiptsData.find((item) => item.key === sourceReceiptKey);
  if (!receipt) {
    showStatus('error', 'Selected receipt not found');
    return;
  }

  showStatus('uploading', 'Marking receipt ready...');
  const result = await patchReceiptLink(sourceReceiptKey, buildReadyClaimPayload(receipt));

  if (result.ok) {
    showStatus('success', 'Receipt marked ready');
  } else {
    showStatus('error', result.error || 'Failed to mark ready');
  }

  clearSelection();
  loadReceipts().then(() => loadYnabTodos());
}

function handleConfirmSelection() {
  if (linkingSource === 'claim') {
    linkSelectedReceiptsToClaim();
    return;
  }
  if (linkingSource === 'receipt') {
    linkSourceReceiptToClaim();
  }
}

async function deleteReceipt(receiptKey) {
  try {
    const response = await fetch(`${API_BASE}/receipt/${encodeURIComponent(receiptKey)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });

    if (response.ok) {
      selectedReceiptKeys.delete(receiptKey);
      if (sourceReceiptKey === receiptKey) {
        clearSelection();
      }
      showStatus('success', 'Receipt deleted');
      loadReceipts().then(() => loadYnabTodos());
      return;
    }

    const data = await response.json().catch(() => ({}));
    showStatus('error', data.error || 'Failed to delete receipt');
  } catch (err) {
    console.error('Delete failed:', err);
    showStatus('error', 'Failed to delete receipt');
  }
}

function buildLinkedClaimPayload(receipt, claimId, index) {
  const claim = claimsData.find((item) => item.id === claimId);
  const fallbackDescription = getLinkedClaimJumpLabel(receipt, claimId, index);
  const description = (claim?.description || claim?.payee || fallbackDescription || '').trim();

  return {
    id: claimId,
    description,
    amount: claim && Number.isFinite(Number(claim.amount)) ? Number(claim.amount) : undefined,
    date: claim?.date || undefined,
  };
}

async function unlinkClaimFromReceipt(receiptKey, claimId) {
  const receipt = receiptsData.find((item) => item.key === receiptKey);
  if (!receipt) {
    showStatus('error', 'Linked receipt not found');
    return;
  }

  const existingClaimIds = getLinkedClaimIds(receipt);
  if (!existingClaimIds.includes(claimId)) {
    showStatus('error', 'Linked claim not found');
    return;
  }

  const remainingClaimIds = existingClaimIds.filter((id) => id !== claimId);
  if (remainingClaimIds.length === 0) {
    await unlinkReceipt(receiptKey);
    return;
  }

  const remainingClaims = remainingClaimIds.map((id, index) => buildLinkedClaimPayload(receipt, id, index));
  showStatus('uploading', 'Updating linked claims...');
  const result = await patchReceiptLinks(receiptKey, remainingClaims);
  if (!result.ok) {
    showStatus('error', result.error || 'Failed to unlink pair');
    return;
  }

  clearSelection();
  showStatus('success', 'Unlinked claim-receipt pair');
  loadReceipts().then(() => loadYnabTodos());
}

// Unlink a receipt from its claim
async function unlinkReceipt(receiptKey) {
  try {
    const response = await fetch(`${API_BASE}/receipt/${encodeURIComponent(receiptKey)}/link`, {
      method: 'DELETE',
      headers: authHeaders(),
    });

    if (response.ok) {
      showStatus('success', 'Receipt unlinked');
      loadReceipts().then(() => loadYnabTodos());
    } else {
      const data = await response.json();
      showStatus('error', data.error || 'Failed to unlink');
    }
  } catch (err) {
    console.error('Unlink failed:', err);
    showStatus('error', 'Failed to unlink receipt');
  }
}

// Cancel selection button
cancelSelection.addEventListener('click', clearSelection);
confirmSelection.addEventListener('click', handleConfirmSelection);
markReadySelection.addEventListener('click', markSourceReceiptReady);

// ===== Mobile Tab Toggle =====

function switchTab(tab) {
  tabBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  receiptsColumn.classList.toggle('active', tab === 'receipts');
  claimsColumn.classList.toggle('active', tab === 'claims');
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
  });
});

// ===== Invoices (Xero claim bills) =====

const claimsView = document.getElementById('claimsView');
const navClaims = document.getElementById('navClaims');
const navInvoices = document.getElementById('navInvoices');
const INVOICES_PATH = '/invoices';
const invoicesView = document.getElementById('invoicesView');
const xeroStatusEl = document.getElementById('xeroStatus');
const invoicesRefreshBtn = document.getElementById('invoicesRefreshBtn');
const detectGstBtn = document.getElementById('detectGstBtn');
const invoiceRows = document.getElementById('invoiceRows');
const invoicesEmpty = document.getElementById('invoicesEmpty');
const invoicePreview = document.getElementById('invoicePreview');
const bucketMetaEls = {
  gst: document.getElementById('bucketGst'),
  nongst: document.getElementById('bucketNongst'),
  transport: document.getElementById('bucketTransport'),
};
const invoicesBucketsEl = document.querySelector('.invoices-buckets');
const BUCKET_BTN_LABEL = {
  gst: 'Generate GST invoice',
  nongst: 'Generate non-GST invoice',
  transport: 'Generate transport invoice',
};
let invoicePreviewBusy = false;
let activeInvoiceBucket = null;
const TRANSPORT_CODES = ['451', '452'];
const FALLBACK_ACCOUNTS = [
  { code: '463', name: 'Computer Software' },
  { code: '320', name: 'Cost of Sales' },
  { code: '464', name: 'Computer Hardware & Accessories' },
  { code: '460', name: 'Books, Magazines, Journals' },
  { code: '451', name: 'Local Public Transport (incl Taxi)' },
  { code: '452', name: 'Overseas Transport' },
  { code: '467', name: 'Telephone & Internet' },
];
// Best-effort default account from the payee/description. Always editable.
const ACCOUNT_HINTS = [
  { code: '451', re: /\b(grab|gojek|gocar|taxi|cab|comfort|cdg|ez-?link|simplygo|mrt|\bbus\b|transport|\bride\b|fare|tada|ryde)\b/i },
  { code: '464', re: /\b(hardware|cable|adapter|charger|keyboard|mouse|monitor|\bcase\b|ipad|laptop|ssd|usb|dongle|battery|webcam)\b/i },
  { code: '460', re: /\b(book|books|magazine|journal|ebook)\b/i },
  { code: '467', re: /\b(phone|mobile|telco|singtel|starhub|\bm1\b|internet|broadband|data plan|\bsim\b)\b/i },
  { code: '463', re: /\b(subscription|software|saas|\bapp\b|\bai\b|\bapi\b|github|openai|chatgpt|claude|anthropic|lovable|figma|notion|adobe|cloud|domain|hosting)\b/i },
];
const BUCKET_LABEL = { gst: 'GST', nongst: 'Non-GST', transport: 'Transport' };

let invoiceLines = [];
let invoicesActive = false;
let xeroConnected = false;
let xeroAccounts = null; // populated from /xero/meta when connected
const INVOICE_EMPTY_TEXT = 'No ready-to-claim items. Mark receipts ready or link them to YNAB claims first.';
const INVOICE_CLAIMS_UNAVAILABLE_TEXT = 'Claims unavailable. Refresh claims before creating Xero bills.';

function invoiceAccounts() {
  return xeroAccounts && xeroAccounts.length ? xeroAccounts : FALLBACK_ACCOUNTS;
}

function guessAccountCode(text) {
  const hay = (text || '').toLowerCase();
  for (const hint of ACCOUNT_HINTS) {
    if (hint.re.test(hay)) return hint.code;
  }
  return '463';
}

// Input tax code: GST shown -> standard-rated; USD with no GST -> out of scope;
// SGD with no GST -> non-GST-registered supplier.
function deriveTaxType(line) {
  if (line.gstShown) return 'INPUTY24';
  return line.currency === 'USD' ? 'OPINPUT' : 'NRINPUT';
}

function lineBucket(line) {
  if (TRANSPORT_CODES.includes(line.accountCode)) return 'transport';
  return line.gstShown ? 'gst' : 'nongst';
}

// Build the editable model from the currently loaded ready-to-claim data:
// receipts with a non-empty linkedClaimIds, joined to their YNAB claim.
// --- Persisted manual edits (survive refresh / tab toggle / reload) ---------
const INVOICE_EDITS_KEY = 'claim_manager_invoice_edits';

function loadInvoiceEdits() {
  try {
    return JSON.parse(localStorage.getItem(INVOICE_EDITS_KEY) || '{}') || {};
  } catch (_err) {
    return {};
  }
}

function writeInvoiceEdits(store) {
  try {
    localStorage.setItem(INVOICE_EDITS_KEY, JSON.stringify(store));
  } catch (_err) {
    /* ignore storage quota / availability errors */
  }
}

function saveInvoiceEdit(lineId, patch) {
  const store = loadInvoiceEdits();
  store[lineId] = { ...(store[lineId] || {}), ...patch };
  writeInvoiceEdits(store);
}

// Re-apply saved manual edits onto freshly-built lines, and prune saved edits
// for lines that no longer exist (e.g. once a receipt has been invoiced).
function applySavedInvoiceEdits(lines) {
  const store = loadInvoiceEdits();
  const liveIds = new Set(lines.map((l) => l.id));
  lines.forEach((line) => {
    if (store[line.id]) Object.assign(line, store[line.id]);
  });
  const pruned = {};
  Object.keys(store).forEach((id) => {
    if (liveIds.has(id)) pruned[id] = store[id];
  });
  if (Object.keys(pruned).length !== Object.keys(store).length) writeInvoiceEdits(pruned);
}

function buildInvoiceLines() {
  if (claimsLoadErrorMessage) {
    invoiceLines = [];
    return;
  }

  const claimsById = new Map(claimsData.map((claim) => [claim.id, claim]));
  const lines = [];

  receiptsData.forEach((receipt) => {
    if (receipt.xeroInvoiceId) return; // already billed
    getLinkedClaimIds(receipt).forEach((claimId) => {
      const claim = claimsById.get(claimId) || null;
      const isReadyOnly = isReadyOnlyClaimId(claimId);
      if (!claim && !isReadyOnly) return;
      const matchDate = getReceiptMatchDate(receipt).date;
      const date = (claim && claim.date) || (matchDate ? matchDate.toISOString().slice(0, 10) : '');
      const payee = (claim && claim.payee) || receipt.taggedVendor || 'Unknown payee';
      const description = (claim && claim.description) || receipt.taggedPurpose || getReceiptDisplayName(receipt);
      const currency = (receipt.taggedCurrency || 'SGD').toUpperCase();

      // SGD is the source of truth: prefer the YNAB claim amount, else the
      // receipt's SGD approximation, else the tagged amount.
      let amount = NaN;
      if (claim && Number.isFinite(Number(claim.amount))) {
        amount = Number(claim.amount);
      } else {
        const comparables = getComparableReceiptAmounts(receipt);
        const pref = comparables.find((c) => c.kind === 'fx-plus')
          || comparables.find((c) => c.kind === 'fx')
          || comparables[0];
        if (pref) amount = pref.value;
      }

      lines.push({
        id: `${receipt.key}::${claimId}`,
        receiptKey: receipt.key,
        receiptName: getReceiptDisplayName(receipt),
        ynabClaimId: isReadyOnly ? null : claimId,
        // Default to excluded when there's no usable amount yet, so we never
        // silently push a $0.00 line.
        include: Number.isFinite(amount) && amount > 0,
        date,
        payee,
        description,
        currency,
        amount: Number.isFinite(amount) ? Number(amount) : 0,
        accountCode: guessAccountCode(`${payee} ${description}`),
        // Default from the AI GST verdict (MiniMax/Gemini); the checkbox stays
        // the manual override.
        gstShown: receipt.taggedGstShown === true,
        remark: '',
      });
    });
  });

  lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  applySavedInvoiceEdits(lines);
  invoiceLines = lines;
}

function renderInvoiceClaimLoadError() {
  invoiceLines = [];
  invoiceRows.innerHTML = '';
  invoicesEmpty.hidden = false;
  invoicesEmpty.textContent = INVOICE_CLAIMS_UNAVAILABLE_TEXT;
  invoicePreview.hidden = true;
  activeInvoiceBucket = null;
  invoicePreviewBusy = false;
  updateBucketButtonUi();
  renderBucketSummary();
}

function renderInvoiceEditor() {
  if (claimsLoadErrorMessage) {
    renderInvoiceClaimLoadError();
    return;
  }

  const accounts = invoiceAccounts();
  invoicesEmpty.hidden = invoiceLines.length > 0;
  invoicesEmpty.textContent = INVOICE_EMPTY_TEXT;

  invoiceRows.innerHTML = invoiceLines
    .map((line) => {
      const options = accounts
        .map((a) => `<option value="${escapeHtml(a.code)}" ${a.code === line.accountCode ? 'selected' : ''}>${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`)
        .join('');
      const usdNote = line.currency === 'USD' ? ' <span class="usd-note">(USD)</span>' : '';
      const bucket = lineBucket(line);
      return `
        <tr data-id="${escapeHtml(line.id)}" class="${line.include ? '' : 'row-excluded'}">
          <td class="col-incl"><input type="checkbox" class="inv-include" ${line.include ? 'checked' : ''}></td>
          <td><input type="date" class="inv-date" value="${escapeHtml(line.date || '')}"></td>
          <td><input type="text" class="inv-desc" value="${escapeHtml(line.description)}"></td>
          <td><select class="inv-account">${options}</select></td>
          <td class="num"><input type="number" step="0.01" min="0" class="inv-amount" value="${line.amount.toFixed(2)}">${usdNote}</td>
          <td><input type="text" class="inv-remark" placeholder="optional" value="${escapeHtml(line.remark)}"></td>
          <td class="col-gst"><input type="checkbox" class="inv-gst" ${line.gstShown ? 'checked' : ''}></td>
          <td class="col-bucket"><span class="bucket-chip bucket-${bucket}">${BUCKET_LABEL[bucket]}</span></td>
          <td><button type="button" class="inv-preview-btn" title="Preview receipt">view</button></td>
        </tr>`;
    })
    .join('');

  invoiceRows.querySelectorAll('tr[data-id]').forEach((tr) => {
    const line = invoiceLines.find((l) => l.id === tr.dataset.id);
    if (!line) return;
    tr.querySelector('.inv-include').addEventListener('change', (e) => {
      line.include = e.target.checked;
      tr.classList.toggle('row-excluded', !line.include);
      saveInvoiceEdit(line.id, { include: line.include });
      renderBucketSummary();
    });
    tr.querySelector('.inv-date').addEventListener('change', (e) => {
      line.date = e.target.value;
      saveInvoiceEdit(line.id, { date: line.date });
    });
    tr.querySelector('.inv-desc').addEventListener('input', (e) => {
      line.description = e.target.value;
      saveInvoiceEdit(line.id, { description: line.description });
    });
    tr.querySelector('.inv-remark').addEventListener('input', (e) => {
      line.remark = e.target.value;
      saveInvoiceEdit(line.id, { remark: line.remark });
    });
    tr.querySelector('.inv-amount').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      line.amount = Number.isFinite(v) ? v : 0;
      saveInvoiceEdit(line.id, { amount: line.amount });
      renderBucketSummary();
    });
    tr.querySelector('.inv-account').addEventListener('change', (e) => {
      line.accountCode = e.target.value;
      saveInvoiceEdit(line.id, { accountCode: line.accountCode });
      updateRowBucket(tr, line);
      renderBucketSummary();
    });
    tr.querySelector('.inv-gst').addEventListener('change', (e) => {
      line.gstShown = e.target.checked;
      saveInvoiceEdit(line.id, { gstShown: line.gstShown });
      updateRowBucket(tr, line);
      renderBucketSummary();
    });
    tr.querySelector('.inv-preview-btn').addEventListener('click', () => openPreview(line.receiptKey, line.receiptName));
  });

  renderBucketSummary();
}

function updateRowBucket(tr, line) {
  const chip = tr.querySelector('.bucket-chip');
  const bucket = lineBucket(line);
  chip.className = `bucket-chip bucket-${bucket}`;
  chip.textContent = BUCKET_LABEL[bucket];
}

function bucketLines(bucket) {
  return invoiceLines.filter((l) => l.include && lineBucket(l) === bucket);
}

// Group by account code, then date ascending within the account.
function sortBucketLines(lines) {
  return lines.slice().sort((a, b) => {
    if (a.accountCode !== b.accountCode) return a.accountCode < b.accountCode ? -1 : 1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
}

function renderBucketSummary() {
  ['gst', 'nongst', 'transport'].forEach((bucket) => {
    const lines = bucketLines(bucket);
    const total = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
    bucketMetaEls[bucket].textContent = `(${lines.length} · S$${total.toFixed(2)})`;
  });
}

// YNAB transfer transactions carry a payee like "Transfer : Work Refundables",
// which is internal noise — don't append it (or the date) to the line.
function isTransferPayee(payee) {
  return /^\s*transfer\s*:/i.test(payee || '');
}

function lineToDescription(line) {
  const hasRealPayee = line.payee && !isTransferPayee(line.payee);
  const base = hasRealPayee ? `${line.description} — ${line.payee} (${line.date})` : line.description;
  return line.remark ? `${base} — ${line.remark}` : base;
}

function bucketButtonEls() {
  return invoicesBucketsEl ? [...invoicesBucketsEl.querySelectorAll('.bucket-btn')] : [];
}

function updateBucketButtonUi() {
  bucketButtonEls().forEach((btn) => {
    const bucket = btn.dataset.bucket;
    const isActive = activeInvoiceBucket === bucket && !invoicePreview.hidden;
    const isGenerating = invoicePreviewBusy && activeInvoiceBucket === bucket;
    btn.classList.toggle('bucket-btn-active', isActive);
    btn.disabled = invoicePreviewBusy;
    btn.setAttribute('aria-busy', isGenerating ? 'true' : 'false');
    const labelEl = btn.querySelector('.bucket-btn-label');
    if (labelEl) {
      labelEl.textContent = isGenerating
        ? 'Generating preview…'
        : (BUCKET_BTN_LABEL[bucket] || 'Generate invoice');
    }
  });
}

function renderInvoicePreviewDoc(bucket) {
  const lines = sortBucketLines(bucketLines(bucket));
  activeInvoiceBucket = bucket;
  invoicePreview.hidden = false;

  if (lines.length === 0) {
    invoicePreview.innerHTML = `<p class="empty-state">No ${BUCKET_LABEL[bucket]} items selected. Tick the include column for lines you want in this bill.</p>`;
    updateBucketButtonUi();
    return;
  }

  const accounts = invoiceAccounts();
  const accName = (code) => (accounts.find((a) => a.code === code) || {}).name || '';
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const rowsHtml = lines
    .map((l) => `
      <tr>
        <td>${escapeHtml(l.date)}</td>
        <td>${escapeHtml(lineToDescription(l))}</td>
        <td>${escapeHtml(l.accountCode)} ${escapeHtml(accName(l.accountCode))}</td>
        <td>${escapeHtml(deriveTaxType(l))}</td>
        <td class="num">S$${Number(l.amount).toFixed(2)}</td>
      </tr>`)
    .join('');

  invoicePreview.innerHTML = `
    <div class="invoice-doc">
      <div class="invoice-doc-head">
        <h3>${BUCKET_LABEL[bucket]} claims — DRAFT bill</h3>
        <p>Payee: <strong>Soon Yin Jie</strong> · ${lines.length} line items · tax-inclusive</p>
      </div>
      <table class="invoice-doc-table">
        <thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Tax</th><th class="num">Amount</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot><tr><td colspan="4" class="num"><strong>Total</strong></td><td class="num"><strong>S$${total.toFixed(2)}</strong></td></tr></tfoot>
      </table>
      <div class="invoice-doc-actions">
        <button type="button" id="pushInvoiceBtn" class="btn-primary" data-bucket="${bucket}">Push to Xero (draft)</button>
        <span class="invoice-doc-note">Creates a DRAFT bill in Xero and attaches the receipts. You can still edit it in Xero before approving.</span>
      </div>
    </div>`;

  const pushBtn = document.getElementById('pushInvoiceBtn');
  if (pushBtn) pushBtn.addEventListener('click', () => pushInvoice(bucket, pushBtn));
  updateBucketButtonUi();
}

function generateInvoice(bucket) {
  if (invoicePreviewBusy) return;

  invoicePreviewBusy = true;
  activeInvoiceBucket = bucket;
  invoicePreview.hidden = false;
  invoicePreview.innerHTML = `<p class="invoice-preview-loading" role="status">Building ${BUCKET_LABEL[bucket]} preview…</p>`;
  updateBucketButtonUi();
  invoicePreview.scrollIntoView({ block: 'nearest' });

  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        renderInvoicePreviewDoc(bucket);
      } finally {
        invoicePreviewBusy = false;
        updateBucketButtonUi();
        renderBucketSummary();
      }
    }, 0);
  });
}

async function pushInvoice(bucket, btn) {
  if (claimsLoadErrorMessage) {
    showStatus('error', INVOICE_CLAIMS_UNAVAILABLE_TEXT);
    return;
  }

  const lines = sortBucketLines(bucketLines(bucket));
  if (lines.length === 0) return;
  if (!xeroConnected) {
    showStatus('error', 'Connect Xero first.');
    return;
  }
  const reference = window.prompt(`Reference / note for the ${BUCKET_LABEL[bucket]} bill:`, `${BUCKET_LABEL[bucket]} claims`);
  if (reference === null) return; // cancelled

  btn.disabled = true;
  btn.textContent = 'Pushing…';
  try {
    const payload = {
      bucket,
      reference,
      markClaimed: true,
      lineItems: lines.map((l) => ({
        receiptKey: l.receiptKey,
        ynabClaimId: l.ynabClaimId,
        date: l.date,
        description: lineToDescription(l),
        accountCode: l.accountCode,
        taxType: deriveTaxType(l),
        amount: Number(l.amount),
      })),
    };
    const res = await fetch(`${API_BASE}/xero/invoices/push`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    const attachedCount = attachments.filter((a) => a.status === 'attached').length;
    if (data.allAttached === false) {
      showStatus('error', `Draft bill ${data.invoiceNumber || ''} created, but not all receipts were attached — items kept in the tab for retry (see notes).`);
    } else {
      showStatus('success', `Created draft bill ${data.invoiceNumber || ''} (${attachedCount} receipts attached).`);
    }
    invoicePreview.innerHTML = `
      <div class="invoice-doc">
        <p>Draft created: <a href="${escapeHtml(data.url || '#')}" target="_blank" rel="noopener">open in Xero ↗</a></p>
        <ul class="attach-list">${attachments.map((a) => `<li>${escapeHtml(a.name)} — ${escapeHtml(a.status)}</li>`).join('')}</ul>
        ${warnings.length ? `<ul class="attach-list">${warnings.map((w) => `<li>⚠️ ${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
      </div>`;

    await loadReceipts();
    await loadYnabTodos();
    buildInvoiceLines();
    renderInvoiceEditor();
  } catch (err) {
    showStatus('error', `Push failed: ${err instanceof Error ? err.message : String(err)}`);
    btn.disabled = false;
    btn.textContent = 'Push to Xero (draft)';
  }
}

async function loadXeroStatus() {
  try {
    const res = await fetch(`${API_BASE}/xero/status`, { headers: authHeaders() });
    const data = await res.json();
    xeroConnected = Boolean(data.connected);
    if (xeroConnected) {
      xeroStatusEl.innerHTML = `Connected to <strong>${escapeHtml(data.tenantName || 'Xero')}</strong> · <button type="button" id="xeroDisconnectBtn" class="link-button">disconnect</button>`;
      const dc = document.getElementById('xeroDisconnectBtn');
      if (dc) dc.addEventListener('click', disconnectXero);
      loadXeroMeta();
    } else {
      xeroStatusEl.innerHTML = `Not connected to Xero. <button type="button" id="xeroConnectBtn" class="btn-primary btn-connect">Connect Xero</button>`;
      const cb = document.getElementById('xeroConnectBtn');
      if (cb) cb.addEventListener('click', connectXero);
    }
  } catch (err) {
    xeroStatusEl.textContent = 'Could not check Xero status.';
  }
}

async function loadXeroMeta() {
  try {
    const res = await fetch(`${API_BASE}/xero/meta`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.accounts) && data.accounts.length) {
      xeroAccounts = data.accounts.map((a) => ({ code: a.code, name: a.name }));
      if (invoicesActive) renderInvoiceEditor();
    }
  } catch (_err) {
    /* keep fallback accounts */
  }
}

async function connectXero() {
  try {
    const res = await fetch(`${API_BASE}/xero/connect`, { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.authorizeUrl) throw new Error(data.error || `HTTP ${res.status}`);
    window.location.href = data.authorizeUrl;
  } catch (err) {
    showStatus('error', `Could not start Xero connect: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function disconnectXero() {
  await fetch(`${API_BASE}/xero/disconnect`, { method: 'POST', headers: authHeaders() });
  await loadXeroStatus();
}

function isInvoicesPath(pathname = location.pathname) {
  return pathname === INVOICES_PATH || pathname === INVOICES_PATH + '/';
}

function updateModeNav(activeInvoices) {
  if (navClaims) {
    navClaims.classList.toggle('active', !activeInvoices);
    if (!activeInvoices) navClaims.setAttribute('aria-current', 'page');
    else navClaims.removeAttribute('aria-current');
  }
  if (navInvoices) {
    navInvoices.classList.toggle('active', activeInvoices);
    if (activeInvoices) navInvoices.setAttribute('aria-current', 'page');
    else navInvoices.removeAttribute('aria-current');
  }
}

function updateAppTitle(invoices) {
  document.title = invoices ? 'Invoices — Receipt Upload' : 'Claims — Receipt Upload';
}

function navigateToMode(invoices, { replace = false } = {}) {
  const targetPath = invoices ? INVOICES_PATH : '/';
  const state = { mode: invoices ? 'invoices' : 'claims' };
  if (replace) {
    history.replaceState(state, '', targetPath);
  } else if (location.pathname !== targetPath) {
    history.pushState(state, '', targetPath);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  showInvoicesView(invoices);
}

function showInvoicesView(show) {
  invoicesActive = show;
  if (claimsView) claimsView.hidden = show;
  invoicesView.hidden = !show;
  updateModeNav(show);
  updateAppTitle(show);
  if (show) {
    invoicePreview.hidden = true;
    activeInvoiceBucket = null;
    invoicePreviewBusy = false;
    updateBucketButtonUi();
    loadXeroStatus();
    buildInvoiceLines();
    renderInvoiceEditor();
  }
}

document.querySelectorAll('.app-nav-link').forEach((link) => {
  link.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    navigateToMode(link.dataset.mode === 'invoices');
  });
});

window.addEventListener('popstate', () => {
  showInvoicesView(isInvoicesPath());
});
invoicesRefreshBtn.addEventListener('click', async () => {
  await loadReceipts();
  await loadYnabTodos();
  buildInvoiceLines();
  renderInvoiceEditor();
  loadXeroStatus();
});

// Backfill GST verdicts in worker-sized batches until nothing is left, then
// rebuild the editor so the GST checkboxes pick up the new defaults.
detectGstBtn.addEventListener('click', async () => {
  detectGstBtn.disabled = true;
  let tagged = 0;
  let failed = 0;
  try {
    for (let round = 0; round < 30; round++) {
      detectGstBtn.textContent = `Detecting… (${tagged})`;
      const response = await fetch(`${API_BASE}/gst-tags/pending?limit=8`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (response.status === 401) {
        showPasswordPrompt();
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `GST tagging failed (${response.status})`);
      }
      const result = await response.json();
      tagged += result.tagged;
      failed += result.failed;
      // Stop when done, or when a round makes no progress (all failures)
      // so persistent provider errors don't spin the loop.
      if (result.remaining <= 0 || result.processed === 0 || result.tagged === 0) break;
    }
    detectGstBtn.textContent = failed ? `Done: ${tagged} tagged, ${failed} failed` : `Done: ${tagged} tagged`;
    await loadReceipts();
    buildInvoiceLines();
    renderInvoiceEditor();
  } catch (error) {
    detectGstBtn.textContent = 'Detect GST failed';
    console.error('GST detection failed', error);
  } finally {
    detectGstBtn.disabled = false;
    setTimeout(() => { detectGstBtn.textContent = 'Detect GST'; }, 4000);
  }
});
if (invoicesBucketsEl) {
  invoicesBucketsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.bucket-btn');
    if (!btn || btn.disabled) return;
    generateInvoice(btn.dataset.bucket);
  });
}

// Apply route on first paint so /invoices shows the invoice shell immediately.
showInvoicesView(isInvoicesPath());

// Initial load with auth check
async function init() {
  if (await checkAuth()) {
    hidePasswordPrompt();
    await loadReceipts();
    await loadYnabTodos();
    const xeroJustConnected = new URLSearchParams(location.search).get('xero') === 'connected';
    if (xeroJustConnected) {
      navigateToMode(true, { replace: true });
    } else {
      showInvoicesView(isInvoicesPath());
    }
  }
}

init();
