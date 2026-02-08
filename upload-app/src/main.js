const API_BASE = ''; // Same origin when deployed, or set to worker URL for dev
const AUTH_KEY = 'claim_manager_auth';
const REMEMBER_KEY = 'claim_manager_remember';

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
const todoList = document.getElementById('todoList');
const todoCount = document.getElementById('todoCount');
const authOverlay = document.getElementById('authOverlay');
const passwordInput = document.getElementById('passwordInput');
const authSubmit = document.getElementById('authSubmit');
const rememberMe = document.getElementById('rememberMe');

// Linking elements
const actionBar = document.getElementById('actionBar');
const actionText = document.getElementById('actionText');
const confirmSelection = document.getElementById('confirmSelection');
const cancelSelection = document.getElementById('cancelSelection');
const tabBtns = document.querySelectorAll('.tab-btn');
const receiptsColumn = document.getElementById('receiptsColumn');
const claimsColumn = document.getElementById('claimsColumn');
const receiptBadge = document.getElementById('receiptBadge');
const claimBadge = document.getElementById('claimBadge');

// Linking state
let selectedReceiptKey = null;
let selectedClaimId = null;
let selectedReceiptKeys = new Set();
let linkingMode = null; // 'claim-to-receipts'
let receiptsData = [];
let claimsData = [];
let amountTaggingInFlight = false;
let lastAmountTagAttempt = 0;

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
    loadReceipts();
    loadYnabTodos();
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
    // Sort: unlinked first (by date desc), then linked (by date desc)
    receiptsData = data.receipts.sort((a, b) => {
      const aLinked = !!a.linkedClaimId;
      const bLinked = !!b.linkedClaimId;
      if (aLinked !== bLinked) return aLinked ? 1 : -1;
      return new Date(b.uploaded) - new Date(a.uploaded);
    });

    countSpan.textContent = `(${receiptsData.length})`;
    receiptBadge.textContent = receiptsData.length || '';

    if (receiptsData.length === 0) {
      receiptList.innerHTML = '<li class="empty-state">No pending receipts</li>';
      applyLinkingHighlights();
      return;
    }

    receiptList.innerHTML = receiptsData
      .map(r => {
        const dateDisplay = formatReceiptDateLabel(r);
        const name = r.originalName || r.key.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}_/, '');
        const isLinked = !!r.linkedClaimId;
        const parsedTaggedAmount = Number(r.taggedAmount);
        const taggedAmount = Number.isFinite(parsedTaggedAmount) ? parsedTaggedAmount : null;
        const currencyLabel = (r.taggedCurrency || '').toUpperCase();
        const parsedFxApprox = Number(r.taggedAmountSgdApprox);
        const taggedSgdApprox = Number.isFinite(parsedFxApprox) ? parsedFxApprox : null;
        const parsedFxApproxPlus = Number(r.taggedAmountSgdApproxPlus325);
        const taggedSgdApproxPlus325 = Number.isFinite(parsedFxApproxPlus) ? parsedFxApproxPlus : null;
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

        const usdUnderName = r.taggedCurrency === 'USD' && taggedAmount !== null && !isLinked
          ? `<span class="receipt-usd-tag">${escapeHtml(formatCurrencyAmount('USD', taggedAmount))}</span>`
          : '';
        const linkedClass = isLinked ? 'linked' : '';
        const linkBtnIcon = isLinked
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
        const linkIndicator = isLinked
          ? `<div class="link-indicator">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              ${escapeHtml(r.linkedClaimDescription || 'Linked')}
            </div>`
          : '';
        return `
          <li data-key="${escapeHtml(r.key)}" data-name="${escapeHtml(name)}"
              data-linked="${r.linkedClaimId || ''}" class="${linkedClass}">
            <div class="receipt-info">
              <span class="receipt-name">${escapeHtml(name)}</span>
              ${usdUnderName}
              ${linkIndicator}
            </div>
            <div class="receipt-actions">
              <div class="receipt-meta">
                <span class="receipt-date ${dateDisplay.className}" title="${escapeHtml(dateDisplay.title)}">${dateDisplay.text}</span>
                ${primaryAmountBadge}
              </div>
              <button class="link-btn ${isLinked ? 'linked' : ''}" title="${isLinked ? 'Unlink' : 'Link to claim'}">
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
    triggerPendingAmountTagging();
  } catch (err) {
    console.error('Failed to load receipts:', err);
    receiptList.innerHTML = '<li class="empty-state">Failed to load receipts</li>';
  }
}

async function triggerPendingAmountTagging() {
  if (amountTaggingInFlight) return;
  if (Date.now() - lastAmountTagAttempt < AMOUNT_TAG_COOLDOWN_MS) return;

  const needsTagging = receiptsData.some((receipt) => !receipt.linkedClaimId && !receipt.taggedStatus);
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
    : li.querySelector('.todo-details');
  if (container) {
    container.appendChild(badge);
  }
}

function updateActionBar() {
  if (!linkingMode) {
    actionBar.classList.remove('visible');
    confirmSelection.hidden = true;
    return;
  }

  actionBar.classList.add('visible');

  if (!selectedClaimId) {
    const selectionCount = selectedReceiptKeys.size;
    actionText.textContent = `${selectionCount} receipt${selectionCount === 1 ? '' : 's'} selected. Choose a claim, then link`;
    confirmSelection.hidden = true;
    confirmSelection.disabled = true;
    return;
  }

  const selectionCount = selectedReceiptKeys.size;
  if (selectionCount === 0) {
    actionText.textContent = 'Claim selected. Choose one or more receipts, then link';
    confirmSelection.hidden = true;
    confirmSelection.disabled = true;
    return;
  }

  actionText.textContent = `Claim selected. ${selectionCount} receipt${selectionCount === 1 ? '' : 's'} selected`;
  confirmSelection.textContent = `Link ${selectionCount}`;
  confirmSelection.hidden = false;
  confirmSelection.disabled = false;
}

function applyLinkingHighlights() {
  if (selectedClaimId && !claimsData.some((claim) => claim.id === selectedClaimId)) {
    selectedClaimId = null;
  }

  selectedReceiptKeys = new Set(
    Array.from(selectedReceiptKeys).filter((key) => receiptsData.some((receipt) => receipt.key === key))
  );

  if (selectedReceiptKey && !selectedReceiptKeys.has(selectedReceiptKey)) {
    selectedReceiptKey = null;
  }

  if (!selectedClaimId && !selectedReceiptKey && selectedReceiptKeys.size > 0) {
    selectedReceiptKey = Array.from(selectedReceiptKeys)[0];
  }

  if (selectedClaimId) {
    selectedReceiptKey = null;
  }

  if (linkingMode === 'claim-to-receipts' && selectedReceiptKeys.size === 0 && !selectedClaimId) {
    linkingMode = null;
  }

  if (!linkingMode) {
    document.body.classList.remove('selecting');
  } else {
    document.body.classList.add('selecting');
  }

  updateActionBar();
  clearMatchDecorations(receiptList);
  clearMatchDecorations(todoList);

  receiptList.querySelectorAll('li[data-key]').forEach((li) => {
    const isSelectedReceipt = linkingMode === 'claim-to-receipts' && selectedReceiptKeys.has(li.dataset.key);
    li.classList.toggle('selected', Boolean(isSelectedReceipt));
  });

  todoList.querySelectorAll('.todo-item[data-claim-id]').forEach((li) => {
    const isSelectedClaim = linkingMode === 'claim-to-receipts' && selectedClaimId === li.dataset.claimId;
    li.classList.toggle('selected', isSelectedClaim);
  });

  if (linkingMode === 'claim-to-receipts' && selectedClaimId) {
    const selectedClaim = claimsData.find((claim) => claim.id === selectedClaimId);
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

  if (linkingMode === 'claim-to-receipts' && !selectedClaimId && selectedReceiptKey) {
    const selectedReceipt = receiptsData.find((receipt) => receipt.key === selectedReceiptKey);
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

    if (response.status === 401) {
      showPasswordPrompt();
      return;
    }

    const data = await response.json();

    if (data.error) {
      todoList.innerHTML = `<li class="empty-state">Error: ${escapeHtml(data.error)}</li>`;
      todoCount.textContent = '(error)';
      return;
    }

    claimsData = data.todos;
    todoCount.textContent = `(${claimsData.length})`;
    claimBadge.textContent = claimsData.length || '';

    if (claimsData.length === 0) {
      todoList.innerHTML = '<li class="empty-state">No pending claims</li>';
      applyLinkingHighlights();
      return;
    }

    // Find which claims have linked receipts
    const linkedReceiptsByClaimId = new Map();
    receiptsData
      .filter((receipt) => receipt.linkedClaimId)
      .forEach((receipt) => {
        const linkedReceipts = linkedReceiptsByClaimId.get(receipt.linkedClaimId) || [];
        linkedReceipts.push(receipt);
        linkedReceiptsByClaimId.set(receipt.linkedClaimId, linkedReceipts);
      });
    const linkedClaimIds = new Set(linkedReceiptsByClaimId.keys());

    // Sort: unlinked first (by date desc), then linked (by date desc)
    claimsData.sort((a, b) => {
      const aLinked = linkedClaimIds.has(a.id);
      const bLinked = linkedClaimIds.has(b.id);
      if (aLinked !== bLinked) return aLinked ? 1 : -1;
      return new Date(b.date) - new Date(a.date);
    });

    todoList.innerHTML = claimsData
      .map((t) => {
        const linkedReceipts = linkedReceiptsByClaimId.get(t.id) || [];
        const isLinked = linkedReceipts.length > 0;
        const linkedClass = isLinked ? 'linked' : '';
        const linkIndicator = isLinked
          ? `<div class="link-indicator">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              ${linkedReceipts.length} receipt${linkedReceipts.length === 1 ? '' : 's'} linked
            </div>`
          : '';
        const linkBtnIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>`;
        return `
        <li class="todo-item ${linkedClass}" data-claim-id="${escapeHtml(t.id)}"
            data-amount="${t.amount}" data-description="${escapeHtml(t.description)}"
            data-date="${t.date}">
          <div class="todo-content">
            <div class="todo-main">
              <span class="todo-payee">${escapeHtml(t.description)}</span>
              <span class="todo-amount">$${t.amount.toFixed(2)}</span>
            </div>
            <div class="todo-details">
              <span class="todo-desc">${escapeHtml(t.payee)}</span>
              <span class="todo-date">${formatDateForLocale(parseDateOnly(t.date) || new Date(t.date))}</span>
            </div>
            ${linkIndicator}
          </div>
          <button class="link-btn claim-link-btn" title="Link receipts to this claim">
            ${linkBtnIcon}
          </button>
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
  } catch (err) {
    console.error('Failed to load YNAB todos:', err);
    todoList.innerHTML = '<li class="empty-state">Failed to load claims</li>';
  }
}

refreshBtn.addEventListener('click', () => {
  loadReceipts();
  loadYnabTodos();
});

authSubmit.addEventListener('click', handlePasswordSubmit);
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handlePasswordSubmit();
});

// ===== Receipt-Claim Linking =====

// Handle receipt click - preview by default, toggle multi-select while linking
function handleReceiptClick(e, li) {
  if (
    e.target.closest('.link-btn') ||
    e.target.closest('.delete-btn') ||
    e.target.closest('.date-btn') ||
    e.target.closest('.receipt-date')
  ) return;

  const key = li.dataset.key;
  const name = li.dataset.name;

  if (linkingMode === 'claim-to-receipts') {
    if (selectedReceiptKeys.has(key)) {
      selectedReceiptKeys.delete(key);
    } else {
      selectedReceiptKeys.add(key);
    }
    if (!selectedClaimId) {
      selectedReceiptKey = selectedReceiptKeys.has(key)
        ? key
        : Array.from(selectedReceiptKeys)[0] || null;
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

  if (linkingMode === 'claim-to-receipts') {
    if (selectedReceiptKeys.has(key)) {
      selectedReceiptKeys.delete(key);
    } else {
      selectedReceiptKeys.add(key);
    }
    if (!selectedClaimId) {
      selectedReceiptKey = selectedReceiptKeys.has(key)
        ? key
        : Array.from(selectedReceiptKeys)[0] || null;
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
  startClaimLinkFlow(claimId);
}

// Handle claim click - choose claim target while linking
function handleClaimClick(_e, li) {
  if (linkingMode === 'claim-to-receipts') {
    selectedClaimId = li.dataset.claimId;
    if (window.innerWidth <= 700) {
      switchTab('receipts');
    }
    applyLinkingHighlights();
  }
}

// Step 1 from receipt side: seed one receipt, then choose claim
function startReceiptLinkFlow(key) {
  linkingMode = 'claim-to-receipts';
  selectedReceiptKey = key;
  selectedClaimId = null;
  selectedReceiptKeys = new Set([key]);
  document.body.classList.add('selecting');
  updateActionBar();
  applyLinkingHighlights();

  if (window.innerWidth <= 700) {
    switchTab('claims');
  }
}

// Step 1 from claim side: choose one claim as source
function startClaimLinkFlow(claimId) {
  linkingMode = 'claim-to-receipts';
  selectedClaimId = claimId;
  selectedReceiptKey = null;
  selectedReceiptKeys.clear();
  document.body.classList.add('selecting');
  updateActionBar();
  applyLinkingHighlights();

  if (window.innerWidth <= 700) {
    switchTab('receipts');
  }
}

// Clear all link selections
function clearSelection() {
  linkingMode = null;
  selectedReceiptKey = null;
  selectedClaimId = null;
  selectedReceiptKeys.clear();
  document.body.classList.remove('selecting');
  updateActionBar();
  applyLinkingHighlights();
}

async function patchReceiptLink(receiptKey, claim) {
  try {
    const response = await fetch(`${API_BASE}/receipt/${encodeURIComponent(receiptKey)}/link`, {
      method: 'PATCH',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        linkedClaimId: claim.id,
        linkedClaimDescription: claim.description,
        linkedClaimAmount: claim.amount,
        linkedClaimDate: claim.date,
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
  if (linkingMode !== 'claim-to-receipts' || !selectedClaimId || selectedReceiptKeys.size === 0) {
    return;
  }

  const claimId = selectedClaimId;
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

function handleConfirmSelection() {
  if (linkingMode === 'claim-to-receipts') {
    linkSelectedReceiptsToClaim();
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
      if (selectedReceiptKey === receiptKey) {
        selectedReceiptKey = null;
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

// Initial load with auth check
async function init() {
  if (await checkAuth()) {
    hidePasswordPrompt();
    loadReceipts();
    loadYnabTodos();
  }
}

init();
