import {
  RECEIPT_DATE_RE,
  AMOUNT_MATCH_TOLERANCE,
  DATE_NEAR_THRESHOLD_DAYS,
  READY_CLAIM_ID_PREFIX,
} from './constants.js';
import { claimsData } from './state.js';
import { formatDateForLocale, formatCurrencyAmount } from './core.js';

export function parseDateOnly(value) {
  if (!value) return null;
  const normalised = RECEIPT_DATE_RE.test(value) ? `${value}T00:00:00Z` : value;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

export function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs(dateA.getTime() - dateB.getTime()) / msPerDay);
}

export function getReceiptMatchDate(receipt) {
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

export function getLinkedClaimIds(receipt) {
  if (Array.isArray(receipt.linkedClaimIds)) {
    return receipt.linkedClaimIds.filter((claimId) => typeof claimId === 'string' && claimId.length > 0);
  }
  if (typeof receipt.linkedClaimId === 'string' && receipt.linkedClaimId.length > 0) {
    return [receipt.linkedClaimId];
  }
  return [];
}

export function getReadyClaimId(receipt) {
  return `${READY_CLAIM_ID_PREFIX}${receipt.key}`;
}

export function isReadyOnlyClaimId(claimId) {
  return typeof claimId === 'string' && claimId.startsWith(READY_CLAIM_ID_PREFIX);
}

export function getReceiptDisplayName(receipt) {
  const key = typeof receipt.key === 'string' ? receipt.key : '';
  const originalName = typeof receipt.originalName === 'string' ? receipt.originalName.trim() : '';
  if (originalName) return originalName;
  const keyWithoutPrefix = key.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}_/, '');
  return keyWithoutPrefix || key || 'Receipt';
}

export function getLinkedClaimJumpLabel(receipt, claimId, index = 0) {
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

export function formatLinkedPairReceiptAmount(receipt) {
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

export function formatReceiptDateLabel(receipt) {
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

export function getComparableReceiptAmounts(receipt) {
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

export function scoreReceiptClaimMatch(receipt, claim) {
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
