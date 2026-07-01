import { API_BASE, INVOICES_PATH } from './lib/constants.js';
import {
  authHeaders,
  getAuthToken,
  showPasswordPrompt,
  showStatus,
  escapeHtml,
  formatCurrencyAmount,
} from './lib/core.js';
import { receiptsData, claimsData, claimsLoadErrorMessage } from './lib/state.js';
import {
  getLinkedClaimIds,
  getReceiptMatchDate,
  isReadyOnlyClaimId,
  getReceiptDisplayName,
  getComparableReceiptAmounts,
} from './lib/match.js';
import { openPreview } from './lib/preview.js';
import { clearSelection, loadReceipts, loadYnabTodos } from './claims.js';

const claimsView = document.getElementById('claimsView');
const navClaims = document.getElementById('navClaims');
const navInvoices = document.getElementById('navInvoices');
const invoicesView = document.getElementById('invoicesView');
const xeroStatusEl = document.getElementById('xeroStatus');
const invoicesRefreshBtn = document.getElementById('invoicesRefreshBtn');
const detectGstBtn = document.getElementById('detectGstBtn');
const invoicesSectionsEl = document.getElementById('invoicesSections');
const invoicesEmpty = document.getElementById('invoicesEmpty');
const invoicesLoadingEl = document.getElementById('invoicesLoading');

const INVOICE_BUCKETS = ['gst', 'nongst', 'transport'];
const BUCKET_HEADING = {
  gst: 'GST claims — DRAFT bill',
  nongst: 'Non-GST claims — DRAFT bill',
  transport: 'Transport claims — DRAFT bill',
};
const BUCKET_LABEL = { gst: 'GST', nongst: 'Non-GST', transport: 'Transport' };
const INVOICE_SECTIONS_KEY = 'claim_manager_invoice_sections';
const EYE_ICON = '<svg class="inv-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

let invoiceLines = [];
let invoicesActive = false;
let invoicesLoading = false;
let invoiceLoadingRequests = 0;
let xeroConnected = false;
let xeroAccounts = null;
let activeInvoiceEditCell = null;
let invoiceRenderGeneration = 0;
let invoicePushResultsEl = null;
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
  const currency = (line.currency || 'SGD').toUpperCase();
  return currency !== 'SGD' && currency !== 'UNKNOWN' ? 'OPINPUT' : 'NRINPUT';
}

function lineBucket(line) {
  if (TRANSPORT_CODES.includes(line.accountCode)) return 'transport';
  return line.gstShown ? 'gst' : 'nongst';
}

function getLineSection(line) {
  return line.section || lineBucket(line);
}

function setLineSection(line, section) {
  if (getLineSection(line) !== section && isLineReviewed(line)) {
    line.reviewed = false;
    saveInvoiceEdit(line.id, { reviewed: false });
  }
  line.section = section;
  if (section === 'transport') {
    if (!TRANSPORT_CODES.includes(line.accountCode)) line.accountCode = '451';
    line.gstShown = false;
  } else if (section === 'gst') {
    line.gstShown = true;
    if (TRANSPORT_CODES.includes(line.accountCode)) line.accountCode = '463';
  } else {
    line.gstShown = false;
    if (TRANSPORT_CODES.includes(line.accountCode)) line.accountCode = '463';
  }
  saveInvoiceEdit(line.id, {
    section: line.section,
    gstShown: line.gstShown,
    accountCode: line.accountCode,
  });
}

function defaultForeignCurrencyRemark(receipt) {
  const currency = (receipt.taggedCurrency || 'SGD').toUpperCase();
  if (currency === 'SGD') return '';
  const amount = Number(receipt.taggedAmount);
  if (!Number.isFinite(amount)) return '';
  return formatCurrencyAmount(currency, amount);
}

function loadSectionCollapsedState() {
  try {
    return JSON.parse(localStorage.getItem(INVOICE_SECTIONS_KEY) || '{}') || {};
  } catch (_err) {
    return {};
  }
}

function saveSectionCollapsed(bucket, collapsed) {
  const state = loadSectionCollapsedState();
  state[bucket] = collapsed;
  try {
    localStorage.setItem(INVOICE_SECTIONS_KEY, JSON.stringify(state));
  } catch (_err) {
    /* ignore */
  }
}

function setInvoicesLoading(loading) {
  invoicesLoading = loading;
  updateInvoicesVisibility();
}

function updateInvoicesVisibility() {
  if (invoicesLoadingEl) invoicesLoadingEl.hidden = !invoicesLoading;
  if (invoicesSectionsEl) invoicesSectionsEl.hidden = invoicesLoading;
  if (invoicesEmpty) invoicesEmpty.hidden = invoicesLoading || invoiceLines.length > 0;
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

function lineReviewSnapshot(line) {
  return {
    amount: Number(line.amount || 0).toFixed(2),
    date: line.date || '',
    description: line.description || '',
    accountCode: line.accountCode || '',
    gstShown: line.gstShown === true,
    remark: line.remark || '',
    section: getLineSection(line),
  };
}

function snapshotsMatch(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

// Re-apply saved manual edits onto freshly-built lines, and prune saved edits
// for lines that no longer exist (e.g. once a receipt has been invoiced).
function applySavedInvoiceEdits(lines) {
  const store = loadInvoiceEdits();
  const liveIds = new Set(lines.map((l) => l.id));
  lines.forEach((line) => {
    const saved = store[line.id];
    if (!saved) return;
    const sourceSnapshot = lineReviewSnapshot(line);
    line.sourceSnapshot = sourceSnapshot;
    Object.assign(line, saved);
    if (line.reviewed !== true) return;

    const effectiveSnapshot = lineReviewSnapshot(line);
    const missingReviewSnapshot = !saved.reviewedSnapshot || !saved.reviewedSourceSnapshot;
    const sourceChanged = !snapshotsMatch(sourceSnapshot, saved.reviewedSourceSnapshot);
    const effectiveChanged = !snapshotsMatch(effectiveSnapshot, saved.reviewedSnapshot);
    if (missingReviewSnapshot || sourceChanged || effectiveChanged) {
      store[line.id] = {
        ...saved,
        reviewed: false,
        reviewedSnapshot: null,
        reviewedSourceSnapshot: null,
        reviewInvalidated: true,
      };
      Object.assign(line, store[line.id]);
    }
  });
  const pruned = {};
  Object.keys(store).forEach((id) => {
    if (liveIds.has(id)) pruned[id] = store[id];
  });
  writeInvoiceEdits(pruned);
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
        // Default excluded when there's no usable amount yet, so we never push $0.00.
        include: Number.isFinite(amount) && amount > 0,
        date,
        payee,
        description,
        currency,
        amount: Number.isFinite(amount) ? Number(amount) : 0,
        accountCode: guessAccountCode(`${payee} ${description}`),
        gstShown: receipt.taggedGstShown === true,
        remark: defaultForeignCurrencyRemark(receipt),
      });
      lines[lines.length - 1].sourceSnapshot = lineReviewSnapshot(lines[lines.length - 1]);
    });
  });

  lines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  applySavedInvoiceEdits(lines);
  invoiceLines = lines;
}

export function renderInvoiceClaimLoadError() {
  invoiceLines = [];
  if (invoicesSectionsEl) invoicesSectionsEl.innerHTML = '';
  if (invoicesEmpty) invoicesEmpty.textContent = INVOICE_CLAIMS_UNAVAILABLE_TEXT;
  if (invoiceLoadingRequests === 0) setInvoicesLoading(false);
  else updateInvoicesVisibility();
}

function accountLabel(code, accounts) {
  const match = accounts.find((a) => a.code === code);
  return match ? `${match.code} ${match.name}` : code;
}

function isLineReviewed(line) {
  return line.reviewed === true;
}

function bucketReviewState(bucket) {
  const pushable = pushableBucketLines(bucket);
  const reviewedCount = pushable.filter(isLineReviewed).length;
  return {
    pushable,
    reviewedCount,
    allReviewed: pushable.length > 0 && reviewedCount === pushable.length,
  };
}

function invoicePushNote(bucket) {
  const { pushable, reviewedCount, allReviewed } = bucketReviewState(bucket);
  if (pushable.length === 0) return '';
  if (allReviewed) return 'Creates a DRAFT bill in Xero and attaches the receipts.';
  return `Review every line before pushing (${reviewedCount}/${pushable.length} reviewed).`;
}

function invoiceSectionMeta(bucket, lines, total) {
  const { pushable, reviewedCount } = bucketReviewState(bucket);
  const amount = `S$${total.toFixed(2)}`;
  if (pushable.length === 0) return `${lines.length} items · ${amount}`;
  if (pushable.length === lines.length) {
    return `${pushable.length} bill lines · ${amount} · ${reviewedCount}/${pushable.length} reviewed`;
  }
  return `${lines.length} items · ${pushable.length} will push · ${amount} · ${reviewedCount}/${pushable.length} reviewed`;
}

function setLineReviewed(line, reviewed, btn) {
  line.reviewed = reviewed;
  line.reviewInvalidated = false;
  saveInvoiceEdit(line.id, {
    reviewed,
    reviewedSnapshot: reviewed ? lineReviewSnapshot(line) : null,
    reviewedSourceSnapshot: reviewed ? (line.sourceSnapshot || lineReviewSnapshot(line)) : null,
    reviewInvalidated: false,
  });
  if (btn) {
    btn.classList.toggle('is-reviewed', reviewed);
    btn.setAttribute('aria-pressed', reviewed ? 'true' : 'false');
    btn.setAttribute(
      'aria-label',
      reviewed ? 'Marked reviewed — tap to unmark' : 'Mark line as reviewed after checking receipt',
    );
  }
  const row = btn?.closest('tr[data-id]');
  if (row) {
    row.classList.toggle('inv-row-reviewed', reviewed);
    if (reviewed) {
      row.classList.remove('inv-row-stale');
      row.querySelector('.inv-review-stale')?.remove();
    }
  }
  updateSectionHeaders();
}

function invalidateLineReviewAfterEdit(line, contextEl) {
  if (!isLineReviewed(line)) return;
  line.reviewInvalidated = true;
  const tr = contextEl?.closest?.('tr[data-id]');
  const btn = tr?.querySelector('.inv-review-btn');
  setLineReviewed(line, false, btn);
  line.reviewInvalidated = true;
  saveInvoiceEdit(line.id, { reviewInvalidated: true });
  if (!tr) return;
  tr.classList.add('inv-row-stale');
  const reviewedCell = tr.querySelector('.col-reviewed');
  if (reviewedCell && !reviewedCell.querySelector('.inv-review-stale')) {
    const notice = document.createElement('p');
    notice.className = 'inv-review-stale';
    notice.textContent = 'Edited — open the receipt, then mark reviewed again.';
    reviewedCell.appendChild(notice);
  }
}

function renderInvoiceLineRow(line, accounts) {
  const section = getLineSection(line);
  const reviewed = isLineReviewed(line);
  const invalidated = line.reviewInvalidated === true;
  return `
    <tr data-id="${escapeHtml(line.id)}" class="${reviewed ? 'inv-row-reviewed' : ''}${invalidated ? ' inv-row-stale' : ''}">
      <td class="col-reviewed" data-label="Reviewed">
        <button type="button" class="inv-review-btn${reviewed ? ' is-reviewed' : ''}"
            aria-pressed="${reviewed ? 'true' : 'false'}"
            aria-label="${reviewed ? 'Marked reviewed — tap to unmark' : 'Mark line as reviewed after checking receipt'}">
          <span class="inv-review-check" aria-hidden="true">✓</span>
        </button>
        ${invalidated ? '<p class="inv-review-stale">Receipt data changed — review again before pushing.</p>' : ''}
      </td>
      <td class="inv-cell-editable" data-label="Date" data-field="date" data-input="text" title="Tap to edit"><span class="inv-cell-text">${escapeHtml(line.date || '—')}</span></td>
      <td class="inv-cell-editable" data-label="Description" data-field="description" data-input="text" title="Tap to edit"><span class="inv-cell-text">${escapeHtml(line.description || '—')}</span></td>
      <td class="inv-cell-editable" data-label="Account" data-field="accountCode" data-input="select" title="Tap to edit"><span class="inv-cell-text">${escapeHtml(accountLabel(line.accountCode, accounts))}</span></td>
      <td class="inv-cell-editable" data-label="Type" data-field="section" data-input="type" title="Tap to edit"><span class="inv-cell-text">${escapeHtml(BUCKET_LABEL[section])}</span></td>
      <td class="inv-cell-editable" data-label="Remark" data-field="remark" data-input="text" title="Tap to edit"><span class="inv-cell-text">${escapeHtml(line.remark || '—')}</span></td>
      <td data-label="Tax" class="inv-cell-readonly"><span class="inv-cell-static">${escapeHtml(deriveTaxType(line))}</span></td>
      <td class="num inv-cell-editable" data-label="Amount" data-field="amount" data-input="text" title="Tap to edit"><span class="inv-cell-text">S$${Number(line.amount).toFixed(2)}</span></td>
      <td class="col-preview" data-label="Receipt"><button type="button" class="inv-preview-btn" title="Preview receipt" aria-label="Preview receipt">${EYE_ICON}</button></td>
    </tr>`;
}

function renderInvoiceSection(bucket, lines, accounts) {
  const total = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const collapsed = Boolean(loadSectionCollapsedState()[bucket]);
  const rowsHtml = lines.map((line) => renderInvoiceLineRow(line, accounts)).join('');
  const { pushable, allReviewed } = bucketReviewState(bucket);
  const noteClass = pushable.length > 0 && !allReviewed ? 'invoice-doc-note invoice-doc-note-warn' : 'invoice-doc-note';
  const actionsHtml = pushable.length > 0
    ? `<div class="invoice-doc-actions">
          <button type="button" class="btn-primary invoice-push-btn" data-bucket="${bucket}" ${allReviewed ? '' : 'disabled'}>Push to Xero (draft)</button>
          <span class="${noteClass}">${escapeHtml(invoicePushNote(bucket))}</span>
        </div>`
    : '';
  return `
    <details class="invoice-section invoice-section-${bucket}" data-bucket="${bucket}" ${collapsed ? '' : 'open'}>
      <summary class="invoice-section-header">
        <span class="invoice-section-title">${BUCKET_HEADING[bucket]}</span>
        <span class="invoice-section-meta" aria-live="polite">${invoiceSectionMeta(bucket, lines, total)}</span>
      </summary>
      <div class="invoice-section-body">
        <p class="invoice-doc-sub">Payee: <strong>Soon Yin Jie</strong> · tax-inclusive</p>
        <div class="invoice-section-table-wrap">
          <table class="invoice-doc-table">
            <thead>
              <tr>
                <th class="col-reviewed" aria-label="Reviewed">✓</th>
                <th>Date</th>
                <th>Description</th>
                <th>Account</th>
                <th>Type</th>
                <th>Remark</th>
                <th>Tax</th>
                <th class="num">Amount</th>
                <th class="col-preview"></th>
              </tr>
            </thead>
            <tbody>${rowsHtml || `<tr><td colspan="9" class="empty-state">No ${BUCKET_LABEL[bucket]} items yet.</td></tr>`}</tbody>
            <tfoot>
              <tr>
                <td colspan="7" class="num"><strong>Total</strong></td>
                <td class="num"><strong>S$${total.toFixed(2)}</strong></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div class="invoice-section-status" role="status" aria-live="polite"></div>
        ${actionsHtml}
      </div>
    </details>`;
}

function closeActiveInvoiceEdit({ commit = false } = {}) {
  if (!activeInvoiceEditCell) return;
  if (commit && activeInvoiceEditCell._commitEdit) {
    activeInvoiceEditCell._commitEdit();
  } else if (activeInvoiceEditCell._cancelEdit) {
    activeInvoiceEditCell._cancelEdit();
  }
}

function commitActiveInvoiceEdit() {
  closeActiveInvoiceEdit({ commit: true });
}

function attachTextEditCell(cell, line, field, { inputType = 'text', inputAttrs = '', format, parse }) {
  const renderDisplay = () => {
    cell.classList.remove('is-editing');
    const value = format ? format(line[field]) : (line[field] ?? '');
    cell.innerHTML = `<span class="inv-cell-text">${escapeHtml(String(value ?? '—'))}</span>`;
    cell.onclick = () => startEdit();
  };

  const startEdit = () => {
    if (cell.classList.contains('is-editing')) return;
    closeActiveInvoiceEdit({ commit: true });
    activeInvoiceEditCell = cell;
    cell.classList.add('is-editing');
    const original = line[field];
    const editValue = inputType === 'number' ? Number(original).toFixed(2) : (original ?? '');
    cell.innerHTML = `
      <div class="inv-edit-wrap">
        <input type="${inputType}" class="inv-edit-input" value="${escapeHtml(String(editValue))}" ${inputAttrs}>
        <div class="inv-edit-actions">
          <button type="button" class="inv-edit-confirm" title="Save">Save</button>
          <button type="button" class="inv-edit-cancel" title="Cancel">✕</button>
        </div>
      </div>`;
    const input = cell.querySelector('.inv-edit-input');
    input.focus();
    if (inputType !== 'date') input.select();

    const commit = () => {
      const parsed = parse ? parse(input.value) : input.value;
      const changed = parsed !== original;
      line[field] = parsed;
      saveInvoiceEdit(line.id, { [field]: parsed });
      if (changed) invalidateLineReviewAfterEdit(line, cell);
      activeInvoiceEditCell = null;
      renderDisplay();
      updateSectionHeaders();
    };

    const cancel = () => {
      line[field] = original;
      activeInvoiceEditCell = null;
      renderDisplay();
    };
    cell._cancelEdit = cancel;
    cell._commitEdit = commit;

    cell.querySelector('.inv-edit-confirm').addEventListener('click', (e) => {
      e.stopPropagation();
      commit();
    });
    cell.querySelector('.inv-edit-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      cancel();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (cell.classList.contains('is-editing') && !cell.contains(document.activeElement)) commit();
      }, 0);
    });
  };

  renderDisplay();
}

function attachAccountEditCell(cell, line, accounts) {
  const renderDisplay = () => {
    cell.classList.remove('is-editing');
    cell.innerHTML = `<span class="inv-cell-text">${escapeHtml(accountLabel(line.accountCode, accounts))}</span>`;
    cell.onclick = () => startEdit();
  };

  const startEdit = () => {
    if (cell.classList.contains('is-editing')) return;
    closeActiveInvoiceEdit({ commit: true });
    activeInvoiceEditCell = cell;
    cell.classList.add('is-editing');
    const options = accounts
      .map((a) => `<option value="${escapeHtml(a.code)}" ${a.code === line.accountCode ? 'selected' : ''}>${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`)
      .join('');
    cell.innerHTML = `<select class="inv-edit-select">${options}</select>`;
    const select = cell.querySelector('.inv-edit-select');
    select.focus();
    const originalCode = line.accountCode;
    const commit = () => {
      const nextCode = select.value;
      if (nextCode !== originalCode) invalidateLineReviewAfterEdit(line, cell);
      line.accountCode = nextCode;
      saveInvoiceEdit(line.id, { accountCode: line.accountCode });
      activeInvoiceEditCell = null;
      const prevSection = getLineSection(line);
      if (TRANSPORT_CODES.includes(line.accountCode) && getLineSection(line) !== 'transport') {
        setLineSection(line, 'transport');
        renderInvoiceEditor();
        return;
      }
      if (line.section === 'transport' && !TRANSPORT_CODES.includes(line.accountCode)) {
        line.section = line.gstShown ? 'gst' : 'nongst';
        saveInvoiceEdit(line.id, { section: line.section, accountCode: line.accountCode });
        renderInvoiceEditor();
        return;
      }
      renderDisplay();
      if (getLineSection(line) !== prevSection) renderInvoiceEditor();
      else updateSectionHeaders();
    };
    cell._cancelEdit = () => {
      activeInvoiceEditCell = null;
      renderDisplay();
    };
    cell._commitEdit = commit;
    select.addEventListener('change', commit);
    select.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (cell.classList.contains('is-editing')) commit();
      }, 0);
    });
    select.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cell._cancelEdit();
      }
    });
  };

  renderDisplay();
}

function attachTypeEditCell(cell, line) {
  const renderDisplay = () => {
    cell.classList.remove('is-editing');
    cell.innerHTML = `<span class="inv-cell-text">${escapeHtml(BUCKET_LABEL[getLineSection(line)])}</span>`;
    cell.onclick = () => startEdit();
  };

  const startEdit = () => {
    if (cell.classList.contains('is-editing')) return;
    closeActiveInvoiceEdit({ commit: true });
    activeInvoiceEditCell = cell;
    cell.classList.add('is-editing');
    const current = getLineSection(line);
    const options = INVOICE_BUCKETS
      .map((b) => `<option value="${b}" ${b === current ? 'selected' : ''}>${escapeHtml(BUCKET_LABEL[b])}</option>`)
      .join('');
    cell.innerHTML = `<select class="inv-edit-select">${options}</select>`;
    const select = cell.querySelector('.inv-edit-select');
    select.focus();
    const commit = () => {
      const next = select.value;
      if (next !== current) invalidateLineReviewAfterEdit(line, cell);
      activeInvoiceEditCell = null;
      if (next !== getLineSection(line)) {
        setLineSection(line, next);
        renderInvoiceEditor();
      } else {
        renderDisplay();
      }
    };
    cell._cancelEdit = () => {
      activeInvoiceEditCell = null;
      renderDisplay();
    };
    cell._commitEdit = commit;
    select.addEventListener('change', commit);
    select.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (cell.classList.contains('is-editing')) commit();
      }, 0);
    });
    select.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cell._cancelEdit();
      }
    });
  };

  renderDisplay();
}

function attachInvoiceRowEditors(tr, line, accounts) {
  const reviewBtn = tr.querySelector('.inv-review-btn');
  if (reviewBtn) {
    reviewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setLineReviewed(line, !isLineReviewed(line), reviewBtn);
    });
  }
  attachTextEditCell(tr.querySelector('[data-field="date"]'), line, 'date', { inputType: 'date' });
  attachTextEditCell(tr.querySelector('[data-field="description"]'), line, 'description', { inputType: 'text' });
  attachAccountEditCell(tr.querySelector('[data-field="accountCode"]'), line, accounts);
  attachTypeEditCell(tr.querySelector('[data-field="section"]'), line);
  attachTextEditCell(tr.querySelector('[data-field="remark"]'), line, 'remark', { inputType: 'text' });
  attachTextEditCell(tr.querySelector('[data-field="amount"]'), line, 'amount', {
    inputType: 'number',
    inputAttrs: 'step="0.01" min="0"',
    format: (v) => `S$${Number(v).toFixed(2)}`,
    parse: (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    },
  });
  tr.querySelector('.inv-preview-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openPreview(line.receiptKey, line.receiptName);
  });
}

function updateSectionHeaders() {
  if (!invoicesSectionsEl) return;
  INVOICE_BUCKETS.forEach((bucket) => {
    const section = invoicesSectionsEl.querySelector(`.invoice-section[data-bucket="${bucket}"]`);
    if (!section) return;
    const lines = sortBucketLines(bucketLines(bucket));
    const total = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
    const { pushable, allReviewed } = bucketReviewState(bucket);
    const meta = section.querySelector('.invoice-section-meta');
    if (meta) meta.textContent = invoiceSectionMeta(bucket, lines, total);
    const pushBtn = section.querySelector('.invoice-push-btn');
    if (pushBtn) pushBtn.disabled = pushable.length === 0 || !allReviewed;
    const note = section.querySelector('.invoice-doc-note');
    if (note) {
      note.textContent = invoicePushNote(bucket);
      note.classList.toggle('invoice-doc-note-warn', pushable.length > 0 && !allReviewed);
    }
    const totalCell = section.querySelector('tfoot tr td.num + td.num strong');
    if (totalCell) totalCell.textContent = `S$${total.toFixed(2)}`;
  });
}

function bindInvoiceSectionEvents() {
  if (!invoicesSectionsEl) return;
  invoicesSectionsEl.querySelectorAll('.invoice-section').forEach((section) => {
    const bucket = section.dataset.bucket;
    section.addEventListener('toggle', () => {
      saveSectionCollapsed(bucket, !section.open);
    });
    const pushBtn = section.querySelector('.invoice-push-btn');
    if (pushBtn) {
      pushBtn.addEventListener('click', () => pushInvoice(bucket, pushBtn));
    }
    const tbody = section.querySelector('tbody');
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      const line = invoiceLines.find((l) => l.id === tr.dataset.id);
      if (line) attachInvoiceRowEditors(tr, line, invoiceAccounts());
    });
  });
}

function renderInvoiceEditor() {
  if (claimsLoadErrorMessage) {
    renderInvoiceClaimLoadError();
    return;
  }

  commitActiveInvoiceEdit();

  const accounts = invoiceAccounts();
  const generation = ++invoiceRenderGeneration;
  if (invoicesEmpty) invoicesEmpty.textContent = INVOICE_EMPTY_TEXT;
  updateInvoicesVisibility();

  if (!invoicesSectionsEl) return;

  if (invoiceLines.length === 0) {
    invoicesSectionsEl.innerHTML = '';
    return;
  }

  invoicesSectionsEl.innerHTML = INVOICE_BUCKETS
    .map((bucket) => renderInvoiceSection(bucket, sortBucketLines(bucketLines(bucket)), accounts))
    .join('');

  if (generation !== invoiceRenderGeneration) return;
  bindInvoiceSectionEvents();
}

function renderInvoiceEditorDeferred() {
  const generation = ++invoiceRenderGeneration;
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (generation === invoiceRenderGeneration) renderInvoiceEditor();
        resolve();
      }, 0);
    });
  });
}

async function refreshInvoicesView({ showLoading = true } = {}) {
  commitActiveInvoiceEdit();
  if (showLoading) {
    invoiceLoadingRequests += 1;
    setInvoicesLoading(true);
  }
  try {
    await loadReceipts();
    await loadYnabTodos();
    buildInvoiceLines();
    await renderInvoiceEditorDeferred();
  } finally {
    if (showLoading) {
      invoiceLoadingRequests = Math.max(0, invoiceLoadingRequests - 1);
      if (invoiceLoadingRequests === 0) setInvoicesLoading(false);
    }
  }
}

// Group by account code, then date ascending within the account.
function sortBucketLines(lines) {
  return lines.slice().sort((a, b) => {
    if (a.accountCode !== b.accountCode) return a.accountCode < b.accountCode ? -1 : 1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
}

function bucketLines(bucket) {
  return invoiceLines.filter((l) => l.include && getLineSection(l) === bucket);
}

function pushableBucketLines(bucket) {
  return sortBucketLines(bucketLines(bucket)).filter((l) => (Number(l.amount) || 0) > 0);
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

function ensureInvoicePushResultsEl() {
  if (!invoicePushResultsEl && invoicesSectionsEl) {
    invoicePushResultsEl = document.createElement('div');
    invoicePushResultsEl.id = 'invoicePushResults';
    invoicePushResultsEl.className = 'invoice-push-results';
    invoicesSectionsEl.insertAdjacentElement('beforebegin', invoicePushResultsEl);
  }
  return invoicePushResultsEl;
}

function showSectionPushResult(bucket, data, warnings) {
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const html = `
    <div class="invoice-push-result">
      <p>Draft created: <a href="${escapeHtml(data.url || '#')}" target="_blank" rel="noopener">open in Xero ↗</a></p>
      <ul class="attach-list">${attachments.map((a) => `<li>${escapeHtml(a.name)} — ${escapeHtml(a.status)}</li>`).join('')}</ul>
      ${warnings.length ? `<ul class="attach-list">${warnings.map((w) => `<li>⚠️ ${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
    </div>`;
  const section = invoicesSectionsEl?.querySelector(`.invoice-section[data-bucket="${bucket}"]`);
  const statusEl = section?.querySelector('.invoice-section-status');
  if (statusEl) {
    if (invoicePushResultsEl) invoicePushResultsEl.innerHTML = '';
    statusEl.innerHTML = html;
    return;
  }
  const container = ensureInvoicePushResultsEl();
  if (!container) return;
  container.innerHTML = `<div class="invoice-section-status" role="status" aria-live="polite">${html}</div>`;
}

function invoicePushSummary(bucket, lines) {
  const total = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const receiptCount = new Set(lines.map((line) => line.receiptKey)).size;
  const lineLabel = lines.length === 1 ? '1 line' : `${lines.length} lines`;
  const receiptLabel = receiptCount === 1 ? '1 receipt' : `${receiptCount} receipts`;
  return [
    `${lineLabel} · S$${total.toFixed(2)} → Soon Yin Jie (${BUCKET_LABEL[bucket]}, draft)`,
    `Attaches ${receiptLabel}; tax-inclusive.`,
    'On success, linked YNAB TODO memos become CLAIMED and these items leave the tab.',
  ].join('\n');
}

async function pushInvoice(bucket, btn) {
  if (claimsLoadErrorMessage) {
    showStatus('error', INVOICE_CLAIMS_UNAVAILABLE_TEXT);
    return;
  }

  commitActiveInvoiceEdit();

  const lines = pushableBucketLines(bucket);
  if (lines.length === 0) {
    showStatus('error', `No ${BUCKET_LABEL[bucket]} lines with an amount above S$0.00 to push.`);
    return;
  }
  const unreviewed = lines.filter((l) => !isLineReviewed(l));
  if (unreviewed.length > 0) {
    showStatus(
      'error',
      `Review all ${BUCKET_LABEL[bucket]} lines before pushing (${lines.length - unreviewed.length}/${lines.length} reviewed).`,
    );
    return;
  }
  if (!xeroConnected) {
    showStatus('error', 'Connect Xero first.');
    return;
  }
  const reference = window.prompt(
    `${invoicePushSummary(bucket, lines)}\n\nReference / note for this Xero DRAFT bill:`,
    `${BUCKET_LABEL[bucket]} claims`,
  );
  if (reference === null) return;

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
    showSectionPushResult(bucket, data, warnings);

    try {
      await refreshInvoicesView({ showLoading: false });
      showSectionPushResult(bucket, data, warnings);
    } catch (refreshErr) {
      showStatus(
        'error',
        `Draft created, but refreshing the list failed — reload before pushing again: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`,
      );
      btn.disabled = false;
      btn.textContent = 'Push to Xero (draft)';
    }
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

export function isInvoicesPath(pathname = location.pathname) {
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

export function navigateToMode(invoices, { replace = false } = {}) {
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

export function showInvoicesView(show, { refresh = true } = {}) {
  if (show) {
    clearSelection();
  }
  invoicesActive = show;
  if (claimsView) claimsView.hidden = show;
  invoicesView.hidden = !show;
  updateModeNav(show);
  updateAppTitle(show);
  if (show) {
    closeActiveInvoiceEdit({ commit: true });
    loadXeroStatus();
    if (refresh && getAuthToken()) {
      refreshInvoicesView({ showLoading: true });
    }
  } else {
    closeActiveInvoiceEdit({ commit: true });
  }
}

export function initInvoices() {
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
    await refreshInvoicesView({ showLoading: true });
    loadXeroStatus();
  });

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
        if (result.remaining <= 0 || result.processed === 0 || result.tagged === 0) break;
      }
      detectGstBtn.textContent = failed ? `Done: ${tagged} tagged, ${failed} failed` : `Done: ${tagged} tagged`;
      await refreshInvoicesView({ showLoading: false });
    } catch (error) {
      detectGstBtn.textContent = 'Detect GST failed';
      console.error('GST detection failed', error);
    } finally {
      detectGstBtn.disabled = false;
      setTimeout(() => { detectGstBtn.textContent = 'Detect GST'; }, 4000);
    }
  });
}
