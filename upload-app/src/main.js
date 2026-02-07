const API_BASE = ''; // Same origin when deployed, or set to worker URL for dev
const AUTH_KEY = 'claim_manager_auth';
const REMEMBER_KEY = 'claim_manager_remember';

// Upload constraints (must match server)
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.pdf'];
const AMOUNT_TAG_COOLDOWN_MS = 20000;

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
const cancelSelection = document.getElementById('cancelSelection');
const tabBtns = document.querySelectorAll('.tab-btn');
const receiptsColumn = document.getElementById('receiptsColumn');
const claimsColumn = document.getElementById('claimsColumn');
const receiptBadge = document.getElementById('receiptBadge');
const claimBadge = document.getElementById('claimBadge');

// Linking state
let selectedReceiptKey = null;
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
      return;
    }

    receiptList.innerHTML = receiptsData
      .map(r => {
        const date = new Date(r.uploaded).toLocaleDateString();
        const name = r.originalName || r.key.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}_/, '');
        const isLinked = !!r.linkedClaimId;
        const parsedTaggedAmount = Number(r.taggedAmount);
        const taggedAmount = Number.isFinite(parsedTaggedAmount) ? parsedTaggedAmount : null;
        const amountBadge = taggedAmount !== null
          ? `<span class="receipt-ai-tag ok">AI $${taggedAmount.toFixed(2)}</span>`
          : r.taggedStatus === 'missing'
            ? '<span class="receipt-ai-tag missing">AI no total</span>'
            : r.taggedStatus === 'error'
              ? `<span class="receipt-ai-tag error" title="${escapeHtml(r.taggedError || 'Tagging failed')}">AI failed</span>`
              : '<span class="receipt-ai-tag pending">AI pending</span>';
        const linkedClass = isLinked ? 'linked' : '';
        const linkBtnIcon = isLinked
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
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
              ${linkIndicator}
            </div>
            <div class="receipt-actions">
              <div class="receipt-meta">
                <span class="receipt-date">${date}</span>
                ${amountBadge}
              </div>
              <button class="link-btn ${isLinked ? 'linked' : ''}" title="${isLinked ? 'Unlink' : 'Link to claim'}">
                ${linkBtnIcon}
              </button>
            </div>
          </li>
        `;
      })
      .join('');

    // Attach click handlers
    receiptList.querySelectorAll('li[data-key]').forEach(li => {
      li.addEventListener('click', (e) => handleReceiptClick(e, li));
      li.querySelector('.link-btn').addEventListener('click', (e) => handleLinkBtnClick(e, li));
    });

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
      return;
    }

    // Find which claims have linked receipts
    const linkedClaimIds = new Set(
      receiptsData.filter(r => r.linkedClaimId).map(r => r.linkedClaimId)
    );

    // Sort: unlinked first (by date desc), then linked (by date desc)
    claimsData.sort((a, b) => {
      const aLinked = linkedClaimIds.has(a.id);
      const bLinked = linkedClaimIds.has(b.id);
      if (aLinked !== bLinked) return aLinked ? 1 : -1;
      return new Date(b.date) - new Date(a.date);
    });

    todoList.innerHTML = claimsData
      .map((t) => {
        const isLinked = linkedClaimIds.has(t.id);
        const linkedClass = isLinked ? 'linked' : '';
        const linkedReceipt = isLinked
          ? receiptsData.find(r => r.linkedClaimId === t.id)
          : null;
        const linkIndicator = isLinked && linkedReceipt
          ? `<div class="link-indicator">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              ${escapeHtml(linkedReceipt.originalName || 'Receipt')}
            </div>`
          : '';
        return `
        <li class="todo-item ${linkedClass}" data-claim-id="${escapeHtml(t.id)}"
            data-amount="${t.amount}" data-description="${escapeHtml(t.description)}"
            data-date="${t.date}">
          <div class="todo-main">
            <span class="todo-payee">${escapeHtml(t.description)}</span>
            <span class="todo-amount">$${t.amount.toFixed(2)}</span>
          </div>
          <div class="todo-details">
            <span class="todo-desc">${escapeHtml(t.payee)}</span>
            <span class="todo-date">${new Date(t.date).toLocaleDateString()}</span>
          </div>
          ${linkIndicator}
        </li>
      `;
      })
      .join('');

    // Attach click handlers for linking
    todoList.querySelectorAll('.todo-item[data-claim-id]').forEach(li => {
      li.addEventListener('click', (e) => handleClaimClick(e, li));
    });
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

// Handle receipt click - open preview (unless clicking link button)
function handleReceiptClick(e, li) {
  // If clicking the link/unlink button, don't open preview
  if (e.target.closest('.link-btn')) {
    return;
  }

  const key = li.dataset.key;
  const name = li.dataset.name;

  // If already selected, deselect
  if (selectedReceiptKey === key) {
    clearSelection();
    return;
  }

  // Open preview
  openPreview(key, name);
}

// Handle link button click
function handleLinkBtnClick(e, li) {
  e.stopPropagation();
  const key = li.dataset.key;
  const isLinked = li.dataset.linked;

  if (isLinked) {
    if (confirm('Unlink this receipt from its claim?')) {
      unlinkReceipt(key);
    }
  } else {
    selectReceipt(key);
  }
}

// Handle claim click - link if receipt selected, or show details
function handleClaimClick(e, li) {
  const claimId = li.dataset.claimId;

  // If a receipt is selected, link it to this claim
  if (selectedReceiptKey) {
    const claim = {
      id: claimId,
      description: li.dataset.description,
      amount: parseFloat(li.dataset.amount),
      date: li.dataset.date,
    };
    linkReceiptToClaim(selectedReceiptKey, claim);
    return;
  }

  // Check if this claim already has a linked receipt - offer to unlink
  const linkedReceipt = receiptsData.find(r => r.linkedClaimId === claimId);
  if (linkedReceipt) {
    if (confirm(`Unlink receipt "${linkedReceipt.originalName}" from this claim?`)) {
      unlinkReceipt(linkedReceipt.key);
    }
  }
}

// Select a receipt for linking
function selectReceipt(key) {
  selectedReceiptKey = key;
  document.body.classList.add('selecting');

  // Update visual selection
  receiptList.querySelectorAll('li').forEach(li => {
    li.classList.toggle('selected', li.dataset.key === key);
  });

  // Show action bar
  actionBar.classList.add('visible');
  actionText.textContent = 'Now select a claim to link';

  // On mobile, switch to claims tab
  if (window.innerWidth <= 700) {
    switchTab('claims');
  }
}

// Clear selection
function clearSelection() {
  selectedReceiptKey = null;
  document.body.classList.remove('selecting');

  // Remove visual selection
  receiptList.querySelectorAll('li').forEach(li => {
    li.classList.remove('selected');
  });

  // Hide action bar
  actionBar.classList.remove('visible');
}

// Link a receipt to a claim via API
async function linkReceiptToClaim(receiptKey, claim) {
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
      showStatus('success', 'Receipt linked to claim');
      clearSelection();
      loadReceipts().then(() => loadYnabTodos());
    } else {
      const data = await response.json();
      showStatus('error', data.error || 'Failed to link');
    }
  } catch (err) {
    console.error('Link failed:', err);
    showStatus('error', 'Failed to link receipt');
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
