import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
// @ts-ignore
import manifestJSON from '__STATIC_CONTENT_MANIFEST';
import * as xero from './xero';
import { PDFDocument } from 'pdf-lib';

const assetManifest = JSON.parse(manifestJSON);

// Upload constraints
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.pdf'];
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const DEFAULT_AMOUNT_TAG_BATCH = 3;
const MAX_AMOUNT_TAG_BATCH = 8;
const RECEIPT_METADATA_CONCURRENCY = 25;
const FX_API_BASE = 'https://api.frankfurter.dev/v1';
const USD_SURCHARGE_RATE = 0.0325;
const FX_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Magic byte signatures for file type validation
// Each entry is [offset, bytes[]] to check
const MAGIC_BYTES: Record<string, { offset: number; bytes: number[] }> = {
  'image/jpeg': { offset: 0, bytes: [0xff, 0xd8, 0xff] },
  'image/png': { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/gif': { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  'image/webp': { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  'application/pdf': { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  'image/heic': { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ftyp at offset 4
  'image/heif': { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ftyp at offset 4
};

// Validate file magic bytes
function validateMagicBytes(buffer: ArrayBuffer, mimeType: string): boolean {
  const sig = MAGIC_BYTES[mimeType];
  if (!sig) return true; // No signature defined, skip check

  const bytes = new Uint8Array(buffer.slice(0, 12));
  return sig.bytes.every((b, i) => bytes[sig.offset + i] === b);
}

// Validate file extension
function getExtension(filename: string): string {
  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : '';
}

interface Env {
  RECEIPTS: R2Bucket;
  __STATIC_CONTENT: KVNamespace;
  AUTH_PASSWORD: string;
  YNAB_API_KEY: string;
  YNAB_BUDGET_ID: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  CORS_ORIGIN?: string; // Optional: lock CORS to specific origin
  // Xero integration (see worker/xero.ts). Client id/secret are secrets;
  // XERO_TOKENS stores the rotating refresh token.
  XERO_TOKENS: KVNamespace;
  XERO_CLIENT_ID: string;
  XERO_CLIENT_SECRET: string;
  XERO_SCOPES?: string;
  XERO_INPUT_TAXTYPE?: string;
}

interface YnabTransaction {
  id: string;
  date: string;
  amount: number;
  account_name: string | null;
  payee_name: string | null;
  memo: string | null;
  category_name?: string | null;
  transfer_transaction_id: string | null;
  subtransactions?: YnabSubtransaction[];
}

interface YnabSubtransaction {
  id: string;
  transaction_id: string;
  amount: number;
  memo: string | null;
  payee_name?: string | null;
  category_name?: string | null;
}

interface YnabTodo {
  id: string;
  date: string;
  payee: string;
  amount: number;
  description: string;
  accountName: string;
  categoryName?: string;
  source: 'transaction' | 'subtransaction';
  parentTransactionId?: string;
}

interface GeminiAmountResult {
  amount: number | null;
  confidence: number;
  currency: string;
  receiptDate: string | null;
  receiptDateConfidence: number;
  vendor: string | null;
  purpose: string | null;
  model: string;
}

interface AmountTagResult {
  key: string;
  status: 'tagged' | 'skipped' | 'failed';
  amount?: number;
  reason?: string;
}

interface FxRateResult {
  rate: number;
  dateUsed: string;
}

interface LinkedClaimPayload {
  id: string;
  description: string;
  amount?: number;
  date?: string;
}

interface PushLineItem {
  receiptKey: string;
  ynabClaimId?: string | null;
  date: string;
  description: string;
  accountCode: string;
  taxType: string;
  amount: number;
}

interface ReceiptSummary {
  key: string;
  size: number;
  uploaded: string;
  storageUploaded: string;
  originalName?: string;
  linkedClaimId?: string;
  linkedClaimIds: string[];
  linkedClaimDescription?: string;
  receiptDate?: string;
  receiptDateSource?: string;
  detectedReceiptDate?: string;
  detectedReceiptDateConfidence?: number;
  taggedAmount?: number;
  taggedCurrency?: string;
  taggedConfidence?: number;
  taggedVendor?: string;
  taggedPurpose?: string;
  taggedStatus?: string;
  taggedModel?: string;
  taggedAt?: string;
  taggedError?: string;
  taggedFxStatus?: string;
  taggedFxError?: string;
  taggedFxBaseDate?: string;
  taggedFxDateUsed?: string;
  taggedFxRateUsdSgd?: number;
  taggedAmountSgdApprox?: number;
  taggedAmountSgdApproxPlus325?: number;
  // Set once a Xero draft bill has been created for this receipt.
  xeroInvoiceId?: string;
  invoicedAt?: string;
}

interface ReceiptListResult {
  receipts: ReceiptSummary[];
  cursor: string | null;
  hasMore: boolean;
}

class YnabApiError extends Error {
  status: number;
  details: string;

  constructor(status: number, details: string) {
    super('YNAB API error');
    this.status = status;
    this.details = details;
  }
}

const fxRateCache = new Map<string, { value: FxRateResult; expiresAt: number }>();

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function parseMetadataNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitiseLabel(value: string | null | undefined, maxLength = 80): string | null {
  if (!value) return null;
  const cleaned = value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s&.,'()\-\/]/g, '')
    .slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

function parseLinkedClaimIds(
  linkedClaimIdsValue: string | undefined,
  linkedClaimIdValue: string | undefined
): string[] {
  const parsed: string[] = [];

  if (linkedClaimIdsValue) {
    try {
      const json = JSON.parse(linkedClaimIdsValue);
      if (Array.isArray(json)) {
        json.forEach((value) => {
          if (typeof value === 'string' && value.trim().length > 0) {
            parsed.push(value.trim());
          }
        });
      }
    } catch {
      // Ignore malformed legacy metadata and fall back to single-link field.
    }
  }

  if (linkedClaimIdValue && linkedClaimIdValue.trim().length > 0) {
    parsed.unshift(linkedClaimIdValue.trim());
  }

  return Array.from(new Set(parsed));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseConfidence(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '0'));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function extractIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (ISO_DATE_RE.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function getDateFromIsoDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  if (ISO_DATE_RE.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 180);
}

function getDefaultYnabSinceDate(): string {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  return sixMonthsAgo.toISOString().split('T')[0];
}

function parseTodoDescription(memo: string | null | undefined): string | null {
  if (!memo) return null;
  const todoPattern = /^TODO[:\s]/i;
  if (!todoPattern.test(memo)) return null;
  const description = memo.replace(/^TODO[:\s]\s*/i, '').trim();
  return description || 'Claim';
}

function toYnabTodoFromTransaction(transaction: YnabTransaction): YnabTodo | null {
  const description = parseTodoDescription(transaction.memo);
  if (!description) return null;

  // For transfers, only keep the outflow side to avoid duplicate TODOs.
  if (transaction.transfer_transaction_id && transaction.amount >= 0) {
    return null;
  }

  return {
    id: transaction.id,
    date: transaction.date,
    payee: transaction.payee_name || 'Unknown',
    amount: Math.abs(transaction.amount) / 1000,
    description,
    accountName: transaction.account_name || 'Unknown account',
    categoryName: transaction.category_name || undefined,
    source: 'transaction',
  };
}

function toYnabTodoFromSubtransaction(parent: YnabTransaction, subtransaction: YnabSubtransaction): YnabTodo | null {
  const description = parseTodoDescription(subtransaction.memo);
  if (!description) return null;

  return {
    id: subtransaction.id,
    date: parent.date,
    payee: subtransaction.payee_name || parent.payee_name || 'Unknown',
    amount: Math.abs(subtransaction.amount) / 1000,
    description,
    accountName: parent.account_name || 'Unknown account',
    categoryName: subtransaction.category_name || parent.category_name || undefined,
    source: 'subtransaction',
    parentTransactionId: parent.id,
  };
}

function sortYnabTodos(todos: YnabTodo[]): YnabTodo[] {
  return todos.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

async function fetchYnabTodos(env: Env, sinceDate = getDefaultYnabSinceDate()): Promise<YnabTodo[]> {
  const ynabResponse = await fetch(
    `https://api.ynab.com/v1/budgets/${encodeURIComponent(env.YNAB_BUDGET_ID)}/transactions?since_date=${encodeURIComponent(sinceDate)}`,
    {
      headers: {
        Authorization: `Bearer ${env.YNAB_API_KEY}`,
      },
    }
  );

  if (!ynabResponse.ok) {
    const errorText = await ynabResponse.text();
    throw new YnabApiError(ynabResponse.status, errorText);
  }

  const data = (await ynabResponse.json()) as { data: { transactions: YnabTransaction[] } };
  const todos: YnabTodo[] = [];

  data.data.transactions.forEach((transaction) => {
    const subtransactionTodos: YnabTodo[] = [];
    (transaction.subtransactions || []).forEach((subtransaction) => {
      const subtransactionTodo = toYnabTodoFromSubtransaction(transaction, subtransaction);
      if (subtransactionTodo) subtransactionTodos.push(subtransactionTodo);
    });

    const todo = toYnabTodoFromTransaction(transaction);
    if (todo && subtransactionTodos.length === 0) {
      todos.push(todo);
    }
    todos.push(...subtransactionTodos);
  });

  return sortYnabTodos(todos);
}

async function listReceiptSummaries(
  env: Env,
  options: { limit?: number; cursor?: string } = {}
): Promise<ReceiptListResult> {
  const limit = Math.min(Math.max(options.limit || 100, 1), 1000);
  const listed = await env.RECEIPTS.list({ limit, cursor: options.cursor });

  // Fetch metadata for each receipt (R2 list() doesn't return customMetadata)
  const receipts = await mapWithConcurrency(
    listed.objects,
    RECEIPT_METADATA_CONCURRENCY,
    async (obj): Promise<ReceiptSummary> => {
      const head = await env.RECEIPTS.head(obj.key);
      const metadata = head?.customMetadata || {};
      const linkedClaimIds = parseLinkedClaimIds(metadata.linkedClaimIds, metadata.linkedClaimId);
      const primaryLinkedClaimId = linkedClaimIds[0];
      return {
        key: obj.key,
        size: obj.size,
        // Keep original upload time stable even when metadata is updated.
        uploaded: metadata.uploadedAt || obj.uploaded.toISOString(),
        storageUploaded: obj.uploaded.toISOString(),
        originalName: metadata.originalName,
        linkedClaimId: primaryLinkedClaimId,
        linkedClaimIds,
        linkedClaimDescription: metadata.linkedClaimDescription,
        receiptDate: metadata.receiptDate,
        receiptDateSource: metadata.receiptDateSource,
        detectedReceiptDate: metadata.detectedReceiptDate,
        detectedReceiptDateConfidence: parseMetadataNumber(metadata.detectedReceiptDateConfidence),
        taggedAmount: parseMetadataNumber(metadata.taggedAmount),
        taggedCurrency: metadata.taggedCurrency,
        taggedConfidence: parseMetadataNumber(metadata.taggedConfidence),
        taggedVendor: metadata.taggedVendor,
        taggedPurpose: metadata.taggedPurpose,
        taggedStatus: metadata.taggedStatus,
        taggedModel: metadata.taggedModel,
        taggedAt: metadata.taggedAt,
        taggedError: metadata.taggedError,
        taggedFxStatus: metadata.taggedFxStatus,
        taggedFxError: metadata.taggedFxError,
        taggedFxBaseDate: metadata.taggedFxBaseDate,
        taggedFxDateUsed: metadata.taggedFxDateUsed,
        taggedFxRateUsdSgd: parseMetadataNumber(metadata.taggedFxRateUsdSgd),
        taggedAmountSgdApprox: parseMetadataNumber(metadata.taggedAmountSgdApprox),
        taggedAmountSgdApproxPlus325: parseMetadataNumber(metadata.taggedAmountSgdApproxPlus325),
        xeroInvoiceId: metadata.xeroInvoiceId,
        invoicedAt: metadata.invoicedAt,
      };
    }
  );

  return {
    receipts,
    cursor: listed.truncated ? listed.cursor || null : null,
    hasMore: listed.truncated,
  };
}

async function listAllReceiptSummaries(env: Env, maxReceipts = 5000): Promise<{
  receipts: ReceiptSummary[];
  truncated: boolean;
}> {
  const receipts: ReceiptSummary[] = [];
  let cursor: string | undefined;
  let hasMore = false;

  do {
    const page = await listReceiptSummaries(env, {
      limit: Math.min(1000, maxReceipts - receipts.length),
      cursor,
    });
    receipts.push(...page.receipts);
    cursor = page.cursor || undefined;
    hasMore = page.hasMore;
  } while (cursor && receipts.length < maxReceipts);

  return {
    receipts,
    truncated: hasMore && receipts.length >= maxReceipts,
  };
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatGmailDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function buildReceiptSearchHints(todo: YnabTodo): {
  payee: string;
  description: string;
  amount: number;
  dateWindow: { from: string; to: string } | null;
  gmailQuery: string;
} {
  const parsedDate = extractIsoDate(todo.date);
  const date = parsedDate ? new Date(`${parsedDate}T00:00:00Z`) : null;
  const dateWindow = date
    ? {
        from: addDays(date, -3).toISOString().slice(0, 10),
        to: addDays(date, 4).toISOString().slice(0, 10),
      }
    : null;

  const queryParts = [todo.payee, todo.description]
    .map((part) => part.trim())
    .filter((part) => part && part !== 'Unknown')
    .map((part) => `"${part.replace(/"/g, '')}"`);

  if (date) {
    queryParts.push(`after:${formatGmailDate(addDays(date, -3))}`);
    queryParts.push(`before:${formatGmailDate(addDays(date, 4))}`);
  }

  return {
    payee: todo.payee,
    description: todo.description,
    amount: todo.amount,
    dateWindow,
    gmailQuery: queryParts.join(' '),
  };
}

function parseGeminiJson(
  rawText: string
): {
  amount: number | null;
  confidence: number;
  currency: string;
  receiptDate: string | null;
  receiptDateConfidence: number;
  vendor: string | null;
  purpose: string | null;
} | null {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fencedMatch?.[1]?.trim() || trimmed;

  try {
    const parsed = JSON.parse(jsonText) as {
      amount?: number | string | null;
      confidence?: number | string;
      currency?: string;
      receiptDate?: string | null;
      receiptDateConfidence?: number | string;
      vendor?: string | null;
      purpose?: string | null;
    };

    let amount: number | null = null;
    if (parsed.amount !== null && parsed.amount !== undefined && parsed.amount !== '') {
      const parsedAmount = typeof parsed.amount === 'number' ? parsed.amount : Number.parseFloat(String(parsed.amount));
      if (Number.isFinite(parsedAmount) && parsedAmount >= 0) {
        amount = Math.round(parsedAmount * 100) / 100;
      }
    }

    const confidence = parseConfidence(parsed.confidence);
    const currency = String(parsed.currency || 'UNKNOWN').toUpperCase().slice(0, 12);
    const receiptDate = extractIsoDate(parsed.receiptDate);
    const receiptDateConfidence = parseConfidence(parsed.receiptDateConfidence);
    const vendor = sanitiseLabel(parsed.vendor, 60);
    const purpose = sanitiseLabel(parsed.purpose, 100);

    return { amount, confidence, currency, receiptDate, receiptDateConfidence, vendor, purpose };
  } catch {
    return null;
  }
}

async function getUsdSgdRate(date: string): Promise<FxRateResult> {
  const cached = fxRateCache.get(date);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const response = await fetch(`${FX_API_BASE}/${encodeURIComponent(date)}?base=USD&symbols=SGD`);
  if (!response.ok) {
    const details = (await response.text()).slice(0, 180);
    throw new Error(`FX API ${response.status}: ${details}`);
  }

  const payload = (await response.json()) as {
    date?: string;
    rates?: Record<string, number>;
  };
  const rate = payload.rates?.SGD;
  const dateUsed = extractIsoDate(payload.date) || date;

  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('FX API returned invalid SGD rate');
  }

  const safeRate = Number(rate);
  const result = { rate: safeRate, dateUsed };
  fxRateCache.set(date, {
    value: result,
    expiresAt: Date.now() + FX_CACHE_TTL_MS,
  });
  return result;
}

async function patchReceiptMetadata(
  env: Env,
  key: string,
  metadataPatch: Record<string, string | undefined>
): Promise<boolean> {
  const existing = await env.RECEIPTS.get(key);
  if (!existing) return false;

  const content = await existing.arrayBuffer();
  const mergedMetadata: Record<string, string> = {
    ...(existing.customMetadata || {}),
  };

  Object.entries(metadataPatch).forEach(([metaKey, value]) => {
    if (value === undefined) {
      delete mergedMetadata[metaKey];
      return;
    }
    mergedMetadata[metaKey] = value;
  });

  await env.RECEIPTS.put(key, content, {
    httpMetadata: existing.httpMetadata,
    customMetadata: mergedMetadata,
  });

  return true;
}

async function extractAmountWithGemini(env: Env, fileBuffer: ArrayBuffer, mimeType: string): Promise<GeminiAmountResult> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY');
  }

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const prompt = [
    'Extract the final payable total amount, receipt date, vendor, and purpose from this receipt.',
    'Return strict JSON only with this schema:',
    '{"amount": number|null, "currency": "ISO-4217-or-UNKNOWN", "confidence": number, "receiptDate": "YYYY-MM-DD"|null, "receiptDateConfidence": number, "vendor": string|null, "purpose": string|null}',
    'Rules:',
    '- amount must be the final charged total, no currency symbols.',
    '- use null if the amount is unreadable or ambiguous.',
    '- receiptDate should be purchase/transaction date in YYYY-MM-DD.',
    '- use null for receiptDate if date is unreadable/ambiguous.',
    '- vendor should be merchant/vendor name only.',
    '- purpose should be a short label (2-6 words) for what this expense is for.',
    '- confidence must be between 0 and 1.',
    '- receiptDateConfidence must be between 0 and 1.',
  ].join('\n');

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType || 'application/octet-stream',
                  data: toBase64(fileBuffer),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!geminiResponse.ok) {
    const details = (await geminiResponse.text()).slice(0, 300);
    throw new Error(`Gemini API ${geminiResponse.status}: ${details}`);
  }

  const payload = (await geminiResponse.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const textOutput = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim();

  if (!textOutput) {
    throw new Error('Gemini response did not contain text output');
  }

  const parsed = parseGeminiJson(textOutput);
  if (!parsed) {
    throw new Error('Gemini response was not valid JSON');
  }

  return {
    ...parsed,
    model,
  };
}

async function tagReceiptAmount(env: Env, key: string, options: { force?: boolean } = {}): Promise<AmountTagResult> {
  if (!env.GEMINI_API_KEY) {
    return { key, status: 'skipped', reason: 'missing_gemini_api_key' };
  }

  const object = await env.RECEIPTS.get(key);
  if (!object) {
    return { key, status: 'failed', reason: 'receipt_not_found' };
  }

  const metadata = object.customMetadata || {};
  const linkedClaimIds = parseLinkedClaimIds(metadata.linkedClaimIds, metadata.linkedClaimId);
  if (linkedClaimIds.length > 0) {
    return { key, status: 'skipped', reason: 'already_linked' };
  }
  if (!options.force && (metadata.taggedStatus === 'ok' || metadata.taggedStatus === 'missing')) {
    return { key, status: 'skipped', reason: 'already_tagged' };
  }

  const fileBuffer = await object.arrayBuffer();
  const mimeType = object.httpMetadata?.contentType || 'application/octet-stream';

  try {
    const gemini = await extractAmountWithGemini(env, fileBuffer, mimeType);
    const status = gemini.amount === null ? 'missing' : 'ok';
    const detectedReceiptDate = gemini.receiptDate;
    const hasManualDateOverride = metadata.receiptDateSource === 'manual' && !!metadata.receiptDate;

    const nextReceiptDate = hasManualDateOverride
      ? metadata.receiptDate
      : detectedReceiptDate || metadata.receiptDate;
    const nextReceiptDateSource = hasManualDateOverride ? 'manual' : nextReceiptDate ? 'ai' : undefined;

    const fxBaseDate =
      nextReceiptDate || getDateFromIsoDateTime(metadata.uploadedAt) || new Date().toISOString().slice(0, 10);

    let fxStatus: string | undefined;
    let fxDateUsed: string | undefined;
    let fxRate: string | undefined;
    let fxApprox: string | undefined;
    let fxApproxPlus325: string | undefined;
    let fxError: string | undefined;

    if (gemini.amount !== null && gemini.currency === 'USD') {
      try {
        const fx = await getUsdSgdRate(fxBaseDate);
        const sgdApprox = roundMoney(gemini.amount * fx.rate);
        const sgdApproxWithFee = roundMoney(sgdApprox * (1 + USD_SURCHARGE_RATE));
        fxStatus = 'ok';
        fxDateUsed = fx.dateUsed;
        fxRate = fx.rate.toFixed(6);
        fxApprox = sgdApprox.toFixed(2);
        fxApproxPlus325 = sgdApproxWithFee.toFixed(2);
      } catch (error) {
        fxStatus = 'error';
        fxError = cleanError(error);
      }
    } else if (gemini.amount !== null) {
      fxStatus = 'not_usd';
    }

    await patchReceiptMetadata(env, key, {
      taggedStatus: status,
      taggedAmount: gemini.amount === null ? undefined : gemini.amount.toFixed(2),
      taggedCurrency: gemini.currency,
      taggedConfidence: gemini.confidence.toFixed(2),
      detectedReceiptDate: detectedReceiptDate || undefined,
      detectedReceiptDateConfidence: gemini.receiptDateConfidence.toFixed(2),
      receiptDate: nextReceiptDate || undefined,
      receiptDateSource: nextReceiptDateSource,
      taggedVendor: gemini.vendor || undefined,
      taggedPurpose: gemini.purpose || undefined,
      taggedModel: gemini.model,
      taggedAt: new Date().toISOString(),
      taggedFxBaseDate: gemini.amount === null ? undefined : fxBaseDate,
      taggedFxDateUsed: fxDateUsed,
      taggedFxRateUsdSgd: fxRate,
      taggedFxStatus: fxStatus,
      taggedFxError: fxError,
      taggedAmountSgdApprox: fxApprox,
      taggedAmountSgdApproxPlus325: fxApproxPlus325,
      taggedError: undefined,
    });

    if (gemini.amount === null) {
      return { key, status: 'skipped', reason: 'amount_not_found' };
    }

    return {
      key,
      status: 'tagged',
      amount: gemini.amount,
    };
  } catch (error) {
    const reason = cleanError(error);
    await patchReceiptMetadata(env, key, {
      taggedStatus: 'error',
      taggedAt: new Date().toISOString(),
      taggedFxStatus: 'error',
      taggedFxError: reason,
      taggedAmountSgdApprox: undefined,
      taggedAmountSgdApproxPlus325: undefined,
      taggedFxRateUsdSgd: undefined,
      taggedFxDateUsed: undefined,
      taggedFxBaseDate: undefined,
      taggedError: reason,
    });
    return { key, status: 'failed', reason };
  }
}

async function tagPendingReceipts(env: Env, limit: number): Promise<{
  requested: number;
  processed: number;
  tagged: number;
  skipped: number;
  failed: number;
  results: AmountTagResult[];
}> {
  const scanLimit = Math.min(Math.max(limit * 4, limit), 200);
  const listed = await env.RECEIPTS.list({ limit: scanLimit });
  const candidateKeys: string[] = [];

  for (const object of listed.objects) {
    const head = await env.RECEIPTS.head(object.key);
    const metadata = head?.customMetadata || {};
    const linkedClaimIds = parseLinkedClaimIds(metadata.linkedClaimIds, metadata.linkedClaimId);
    if (linkedClaimIds.length > 0) continue;
    if (metadata.taggedStatus === 'ok' || metadata.taggedStatus === 'missing') continue;
    candidateKeys.push(object.key);
    if (candidateKeys.length >= limit) break;
  }

  const results: AmountTagResult[] = [];
  for (const key of candidateKeys) {
    // Process sequentially to avoid hitting Gemini rate limits.
    const result = await tagReceiptAmount(env, key);
    results.push(result);
  }

  return {
    requested: limit,
    processed: results.length,
    tagged: results.filter((r) => r.status === 'tagged').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
}

// Generate timestamped filename with UUID to prevent collisions
function generateKey(filename: string): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '');
  const uuid = crypto.randomUUID().slice(0, 8); // Short UUID suffix
  const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${date}_${time}_${uuid}_${safeName}`;
}

// Build CORS headers - same-origin by default, configurable via CORS_ORIGIN env var
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const selfOrigin = new URL(request.url).origin;
  const allowedOrigin = env.CORS_ORIGIN || selfOrigin;

  // Allow if: no Origin header (CLI/curl), or origin matches allowed origin
  const effectiveOrigin = !origin ? '*' : origin === allowedOrigin ? origin : '';

  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
    Vary: 'Origin', // Prevent caches from serving wrong CORS headers
  };
}

// Validate auth token
function validateAuth(request: Request, env: Env): boolean {
  const token = request.headers.get('X-Auth-Token');
  return token === env.AUTH_PASSWORD;
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// --- Xero claim-bill push: attachment building + YNAB cleanup --------------

const XERO_ATTACH_MAX_BYTES = 3 * 1024 * 1024;
const XERO_ATTACH_MAX_COUNT = 10;
const COMBINED_PDF_CHUNK_BYTES = Math.floor(2.6 * 1024 * 1024);
const EMBEDDABLE_MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);

const EXT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif',
};
const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/heic': '.heic', 'image/heif': '.heif',
};

function sanitiseFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9 _.-]/g, ' ').replace(/\s+/g, ' ').trim();
}

interface ReceiptFile {
  key: string;
  name: string;
  bytes: ArrayBuffer;
  mime: string;
}

async function loadReceiptFile(env: Env, key: string, label: string): Promise<ReceiptFile | null> {
  const obj = await env.RECEIPTS.get(key);
  if (!obj) return null;
  const bytes = await obj.arrayBuffer();
  const mime = (obj.httpMetadata?.contentType || EXT_MIME[getExtension(key)] || 'application/octet-stream').toLowerCase();
  const ext = MIME_EXT[mime] || getExtension(key) || '';
  const base = sanitiseFileName(label).slice(0, 80) || sanitiseFileName(key) || 'receipt';
  return { key, name: `${base}${ext}`, bytes, mime };
}

async function buildCombinedPdf(files: ReceiptFile[]): Promise<{ bytes: Uint8Array; skipped: string[] }> {
  const doc = await PDFDocument.create();
  const skipped: string[] = [];
  for (const f of files) {
    try {
      if (f.mime === 'application/pdf') {
        const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true });
        const pages = await doc.copyPages(src, src.getPageIndices());
        pages.forEach((p) => doc.addPage(p));
      } else if (f.mime === 'image/png') {
        const img = await doc.embedPng(f.bytes);
        doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      } else if (f.mime === 'image/jpeg' || f.mime === 'image/jpg') {
        const img = await doc.embedJpg(f.bytes);
        doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
    } catch (_err) {
      skipped.push(f.name);
    }
  }
  return { bytes: await doc.save(), skipped };
}

interface AttachmentUpload {
  name: string;
  bytes: ArrayBuffer | Uint8Array;
  mime: string;
}

// Prepares receipt attachments within Xero's caps (3 MB each, 10 per bill).
// Within caps -> individual named files; otherwise merge embeddable receipts
// into chunked combined PDFs and warn about anything that can't be attached.
async function buildClaimAttachments(
  env: Env,
  lineItems: PushLineItem[],
  bucketLabel: string
): Promise<{ uploads: AttachmentUpload[]; warnings: string[] }> {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const files: ReceiptFile[] = [];

  for (const li of lineItems) {
    if (!li.receiptKey || seen.has(li.receiptKey)) continue;
    seen.add(li.receiptKey);
    const file = await loadReceiptFile(env, li.receiptKey, `${li.date || ''} ${li.description || ''}`);
    if (!file) {
      warnings.push(`Receipt not found, skipped: ${li.receiptKey}`);
      continue;
    }
    files.push(file);
  }

  // Only PDF/JPG/PNG can be attached — uploaded raw when within caps, or merged
  // into a combined PDF otherwise. Anything else (HEIC/HEIF/WEBP/GIF/TIFF) is
  // flagged for manual re-upload as PDF/JPG/PNG.
  const supported: ReceiptFile[] = [];
  for (const f of files) {
    if (EMBEDDABLE_MIME.has(f.mime)) supported.push(f);
    else warnings.push(`Not attachable (${f.mime}); re-upload as PDF/JPG/PNG: ${f.name}`);
  }

  // Within caps: attach individually with logical names.
  if (supported.length <= XERO_ATTACH_MAX_COUNT && supported.every((f) => f.bytes.byteLength <= XERO_ATTACH_MAX_BYTES)) {
    return { uploads: supported.map((f) => ({ name: f.name, bytes: f.bytes, mime: f.mime })), warnings };
  }

  // Otherwise merge into chunked combined PDFs (all remaining files are embeddable).
  const groups: ReceiptFile[][] = [];
  let current: ReceiptFile[] = [];
  let currentBytes = 0;
  for (const f of supported) {
    if (current.length > 0 && currentBytes + f.bytes.byteLength > COMBINED_PDF_CHUNK_BYTES) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(f);
    currentBytes += f.bytes.byteLength;
  }
  if (current.length > 0) groups.push(current);

  const uploads: AttachmentUpload[] = [];
  for (let i = 0; i < groups.length; i++) {
    const { bytes: pdf, skipped } = await buildCombinedPdf(groups[i]);
    for (const s of skipped) warnings.push(`Could not embed ${s} into the combined PDF; attach it manually.`);
    if (pdf.byteLength > XERO_ATTACH_MAX_BYTES) {
      warnings.push(`Combined receipts PDF ${i + 1} exceeds 3 MB; attach those receipts manually.`);
      continue;
    }
    const name = groups.length === 1
      ? `${bucketLabel} receipts.pdf`
      : `${bucketLabel} receipts ${i + 1} of ${groups.length}.pdf`;
    uploads.push({ name, bytes: pdf, mime: 'application/pdf' });
  }

  if (uploads.length > XERO_ATTACH_MAX_COUNT) {
    warnings.push(`More than ${XERO_ATTACH_MAX_COUNT} attachments; only the first ${XERO_ATTACH_MAX_COUNT} were uploaded.`);
    uploads.length = XERO_ATTACH_MAX_COUNT;
  }
  return { uploads, warnings };
}

// Flip a YNAB transaction memo from "TODO: ..." to "CLAIMED: ...".
async function markYnabClaimed(env: Env, transactionId: string): Promise<'claimed' | 'skipped' | 'failed'> {
  if (transactionId.includes('_st_')) return 'skipped'; // subtransaction: update manually
  try {
    const base = `https://api.ynab.com/v1/budgets/${encodeURIComponent(env.YNAB_BUDGET_ID)}/transactions/${encodeURIComponent(transactionId)}`;
    const getRes = await fetch(base, { headers: { Authorization: `Bearer ${env.YNAB_API_KEY}` } });
    if (!getRes.ok) return 'failed';
    const getData = (await getRes.json()) as { data?: { transaction?: { memo?: string | null } } };
    const memo = getData.data?.transaction?.memo || '';
    if (/^\s*CLAIMED:/i.test(memo)) return 'claimed'; // already done
    const newMemo = /^\s*TODO:?/i.test(memo)
      ? memo.replace(/^\s*TODO:?\s*/i, 'CLAIMED: ')
      : `CLAIMED: ${memo}`.trim();
    const putRes = await fetch(base, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.YNAB_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: { memo: newMemo } }),
    });
    return putRes.ok ? 'claimed' : 'failed';
  } catch (_err) {
    return 'failed';
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = getCorsHeaders(request, env);

    // Block cross-origin requests from disallowed origins
    const origin = request.headers.get('Origin');
    if (origin && corsHeaders['Access-Control-Allow-Origin'] === '') {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Check auth for API routes. /xero/* is gated too, EXCEPT /xero/callback,
    // which Xero itself calls and which is trusted via its one-time state cookie.
    // (/xero/connect is a header-authed POST so the auth token never lands in a URL.)
    const isApiRoute =
      ['/upload', '/list', '/receipt/', '/ynab/', '/amount-tags/', '/agent/'].some(
        (route) => path === route || path.startsWith(route)
      ) ||
      (path.startsWith('/xero/') && path !== '/xero/callback');

    if (isApiRoute && !validateAuth(request, env)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      // API routes
      // POST /upload - Upload a receipt
      if (path === '/upload' && request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
          return new Response(JSON.stringify({ error: 'No file provided' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Validate file size
        if (file.size > MAX_FILE_SIZE) {
          return new Response(
            JSON.stringify({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Validate file extension
        const ext = getExtension(file.name);
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
          return new Response(
            JSON.stringify({ error: `Invalid file extension: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const key = generateKey(file.name);
        const arrayBuffer = await file.arrayBuffer();

        // Validate magic bytes match claimed type
        if (!validateMagicBytes(arrayBuffer, file.type)) {
          return new Response(
            JSON.stringify({ error: 'File content does not match declared type' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        await env.RECEIPTS.put(key, arrayBuffer, {
          httpMetadata: {
            contentType: file.type,
          },
          customMetadata: {
            originalName: file.name,
            uploadedAt: new Date().toISOString(),
          },
        });

        // Tag amount in background for newly uploaded receipts.
        ctx.waitUntil(tagReceiptAmount(env, key));

        return new Response(JSON.stringify({ success: true, key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /list - List receipts with optional pagination
      if (path === '/list' && request.method === 'GET') {
        const limitParam = parseInt(url.searchParams.get('limit') || '100', 10);
        const limit = Math.min(Math.max(isNaN(limitParam) ? 100 : limitParam, 1), 1000);
        const cursor = url.searchParams.get('cursor') || undefined;

        const result = await listReceiptSummaries(env, { limit, cursor });

        return new Response(
          JSON.stringify({
            receipts: result.receipts,
            cursor: result.cursor,
            hasMore: result.hasMore,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // POST /amount-tags/pending - Tag a batch of untagged, unlinked pending receipts
      if (path === '/amount-tags/pending' && request.method === 'POST') {
        if (!env.GEMINI_API_KEY) {
          return new Response(JSON.stringify({ error: 'GEMINI_API_KEY is not configured' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const requestedLimit = parseInt(url.searchParams.get('limit') || String(DEFAULT_AMOUNT_TAG_BATCH), 10);
        const limit = Math.min(
          Math.max(Number.isNaN(requestedLimit) ? DEFAULT_AMOUNT_TAG_BATCH : requestedLimit, 1),
          MAX_AMOUNT_TAG_BATCH
        );

        const result = await tagPendingReceipts(env, limit);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /receipt/:key/tag-amount - Tag amount for one receipt
      if (path.startsWith('/receipt/') && path.endsWith('/tag-amount') && request.method === 'POST') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/tag-amount', ''));
        const result = await tagReceiptAmount(env, key, { force: true });
        const statusCode = result.status === 'failed' ? 500 : 200;

        return new Response(JSON.stringify(result), {
          status: statusCode,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // PATCH /receipt/:key/receipt-date - Manually override receipt date
      if (path.startsWith('/receipt/') && path.endsWith('/receipt-date') && request.method === 'PATCH') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/receipt-date', ''));
        const body = (await request.json()) as { receiptDate?: string | null };
        const manualDate = body.receiptDate ? extractIsoDate(body.receiptDate) : null;

        if (body.receiptDate && !manualDate) {
          return new Response(JSON.stringify({ error: 'receiptDate must be YYYY-MM-DD' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const head = await env.RECEIPTS.head(key);
        if (!head) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const detectedDate = extractIsoDate(head.customMetadata?.detectedReceiptDate);
        const fallbackDate = detectedDate || undefined;
        const fallbackSource = detectedDate ? 'ai' : undefined;

        const updated = await patchReceiptMetadata(env, key, {
          receiptDate: manualDate || fallbackDate,
          receiptDateSource: manualDate ? 'manual' : fallbackSource,
        });
        if (!updated) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({
            success: true,
            key,
            receiptDate: manualDate || fallbackDate || null,
            receiptDateSource: manualDate ? 'manual' : fallbackSource || null,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /receipt/:key - Download a receipt
      if (path.startsWith('/receipt/') && request.method === 'GET') {
        const key = decodeURIComponent(path.replace('/receipt/', ''));
        const object = await env.RECEIPTS.get(key);

        if (!object) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const headers = new Headers(corsHeaders);
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('Content-Disposition', `inline; filename="${key}"`);

        return new Response(object.body, { headers });
      }

      // DELETE /receipt/:key - Delete a receipt
      if (path.startsWith('/receipt/') && request.method === 'DELETE' && !path.endsWith('/link')) {
        const key = decodeURIComponent(path.replace('/receipt/', ''));
        await env.RECEIPTS.delete(key);

        return new Response(JSON.stringify({ success: true, deleted: key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // PATCH /receipt/:key/link - Link a receipt to a YNAB claim
      if (path.startsWith('/receipt/') && path.endsWith('/link') && request.method === 'PATCH') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/link', ''));
        const body = (await request.json()) as {
          linkedClaimId?: string;
          linkedClaimDescription?: string;
          linkedClaimAmount?: number;
          linkedClaimDate?: string;
          linkedClaims?: LinkedClaimPayload[];
        };

        const linkedClaims = Array.isArray(body.linkedClaims) && body.linkedClaims.length > 0
          ? body.linkedClaims
          : body.linkedClaimId && body.linkedClaimDescription
            ? [
                {
                  id: body.linkedClaimId,
                  description: body.linkedClaimDescription,
                  amount: body.linkedClaimAmount,
                  date: body.linkedClaimDate,
                },
              ]
            : [];

        const normalisedClaims = linkedClaims
          .map((claim) => ({
            id: String(claim.id || '').trim(),
            description: String(claim.description || '').trim(),
            amount: Number.isFinite(claim.amount) ? Number(claim.amount) : undefined,
            date: extractIsoDate(claim.date || undefined) || undefined,
          }))
          .filter((claim) => claim.id && claim.description);

        if (normalisedClaims.length === 0) {
          return new Response(JSON.stringify({ error: 'At least one claim is required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const dedupedClaims = Array.from(
          new Map(normalisedClaims.map((claim) => [claim.id, claim])).values()
        );
        const primaryClaim = dedupedClaims[0];
        const linkedClaimDescription = dedupedClaims.length === 1
          ? primaryClaim.description
          : `${dedupedClaims.length} claims linked`;

        const updated = await patchReceiptMetadata(env, key, {
          linkedClaimId: primaryClaim.id,
          linkedClaimIds: JSON.stringify(dedupedClaims.map((claim) => claim.id)),
          linkedClaimDescription,
          linkedClaimAmount:
            typeof primaryClaim.amount === 'number' ? String(primaryClaim.amount) : undefined,
          linkedClaimDate: primaryClaim.date,
        });
        if (!updated) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // DELETE /receipt/:key/link - Unlink a receipt from a claim
      if (path.startsWith('/receipt/') && path.endsWith('/link') && request.method === 'DELETE') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/link', ''));

        const updated = await patchReceiptMetadata(env, key, {
          linkedClaimId: undefined,
          linkedClaimIds: undefined,
          linkedClaimDescription: undefined,
          linkedClaimAmount: undefined,
          linkedClaimDate: undefined,
        });
        if (!updated) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /ynab/todos - Fetch pending claims from YNAB
      if (path === '/ynab/todos' && request.method === 'GET') {
        try {
          const sinceDate = extractIsoDate(url.searchParams.get('since_date')) || getDefaultYnabSinceDate();
          const todos = await fetchYnabTodos(env, sinceDate);

          return new Response(JSON.stringify({ todos }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          if (error instanceof YnabApiError) {
            return new Response(JSON.stringify({ error: 'YNAB API error', details: error.details }), {
              status: error.status,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const message = error instanceof Error ? error.message : 'Failed to fetch YNAB data';
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /agent/unclaimed-expenditures - Agent-friendly report of TODO claims without linked receipts
      if (path === '/agent/unclaimed-expenditures' && request.method === 'GET') {
        try {
          const sinceDate = extractIsoDate(url.searchParams.get('since_date')) || getDefaultYnabSinceDate();
          const [todos, receiptResult] = await Promise.all([
            fetchYnabTodos(env, sinceDate),
            listAllReceiptSummaries(env),
          ]);

          const linkedReceiptsByClaimId = new Map<string, ReceiptSummary[]>();
          receiptResult.receipts.forEach((receipt) => {
            receipt.linkedClaimIds.forEach((claimId) => {
              const linkedReceipts = linkedReceiptsByClaimId.get(claimId) || [];
              linkedReceipts.push(receipt);
              linkedReceiptsByClaimId.set(claimId, linkedReceipts);
            });
          });

          const missingReceiptClaims = todos
            .filter((todo) => !linkedReceiptsByClaimId.has(todo.id))
            .map((todo) => ({
              ...todo,
              receiptSearchHints: buildReceiptSearchHints(todo),
            }));
          const linkedClaims = todos
            .filter((todo) => linkedReceiptsByClaimId.has(todo.id))
            .map((todo) => ({
              ...todo,
              linkedReceipts: linkedReceiptsByClaimId.get(todo.id) || [],
            }));
          const unlinkedReceipts = receiptResult.receipts.filter((receipt) => receipt.linkedClaimIds.length === 0);

          return new Response(
            JSON.stringify({
              generatedAt: new Date().toISOString(),
              sinceDate,
              summary: {
                todoClaimCount: todos.length,
                missingReceiptClaimCount: missingReceiptClaims.length,
                linkedClaimCount: linkedClaims.length,
                unlinkedReceiptCount: unlinkedReceipts.length,
                receiptScanTruncated: receiptResult.truncated,
              },
              missingReceiptClaims,
              linkedClaims,
              unlinkedReceipts,
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
          );
        } catch (error) {
          if (error instanceof YnabApiError) {
            return new Response(JSON.stringify({ error: 'YNAB API error', details: error.details }), {
              status: error.status,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const message = error instanceof Error ? error.message : 'Failed to build agent claim report';
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // --- Xero integration ---------------------------------------------

      // POST /xero/connect - begin the OAuth flow. Header-authed (X-Auth-Token,
      // via the API-route gate); returns the authorize URL for the SPA to
      // navigate to. The CSRF state is set as an HttpOnly cookie (not KV) so the
      // callback can verify it without depending on KV propagation, and the auth
      // token never appears in a navigable URL.
      if (path === '/xero/connect' && request.method === 'POST') {
        if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET || !env.XERO_TOKENS) {
          return new Response(
            JSON.stringify({
              error:
                'Xero is not configured on this deployment (needs the XERO_CLIENT_ID/XERO_CLIENT_SECRET secrets and the XERO_TOKENS KV binding — see setup).',
            }),
            { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const state = crypto.randomUUID();
        const authorizeUrl = xero.buildAuthorizeUrl(env, request.url, state);
        const secure = url.protocol === 'https:' ? '; Secure' : '';
        return new Response(JSON.stringify({ authorizeUrl }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Set-Cookie': `xero_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`,
          },
        });
      }

      // GET /xero/callback - OAuth redirect target. Trusted via the one-time
      // state cookie set by /xero/connect (Xero calls this directly).
      if (path === '/xero/callback' && request.method === 'GET') {
        // The callback URL carries the one-time OAuth code — keep it out of
        // caches and referrers.
        const noLeak = { ...corsHeaders, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          return new Response(`Xero authorisation failed: ${oauthError}`, { status: 400, headers: noLeak });
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const cookieState = parseCookie(request.headers.get('Cookie'), 'xero_oauth_state');
        if (!code || !state || !cookieState || state !== cookieState) {
          return new Response('Invalid or expired authorisation state.', { status: 400, headers: noLeak });
        }
        try {
          await xero.exchangeCode(env, request.url, code);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Xero token exchange failed';
          return new Response(message, { status: 502, headers: noLeak });
        }
        return new Response(null, {
          status: 302,
          headers: {
            ...noLeak,
            Location: `${url.origin}/?xero=connected#invoices`,
            'Set-Cookie': 'xero_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
          },
        });
      }

      // GET /xero/status - connection status for the UI
      if (path === '/xero/status' && request.method === 'GET') {
        return new Response(JSON.stringify(await xero.getStatus(env)), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /xero/disconnect - forget stored tokens
      if (path === '/xero/disconnect' && request.method === 'POST') {
        await xero.clearAuth(env);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /xero/meta - tax rates + expense accounts for the editor dropdowns
      if (path === '/xero/meta' && request.method === 'GET') {
        try {
          const [taxRates, accounts] = await Promise.all([xero.getTaxRates(env), xero.getExpenseAccounts(env)]);
          return new Response(JSON.stringify({ taxRates, accounts }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to load Xero metadata';
          return new Response(JSON.stringify({ error: message }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // POST /xero/invoices/push - create a DRAFT bill, attach receipts,
      // tag the receipts as invoiced, and flip linked YNAB TODOs to CLAIMED.
      if (path === '/xero/invoices/push' && request.method === 'POST') {
        try {
          const body = (await request.json()) as {
            bucket?: string;
            reference?: string;
            markClaimed?: boolean;
            lineItems?: PushLineItem[];
          };
          const lineItems = (Array.isArray(body.lineItems) ? body.lineItems : [])
            .filter(
              (l) =>
                l &&
                typeof l.receiptKey === 'string' && l.receiptKey &&
                typeof l.description === 'string' && l.description.trim() &&
                typeof l.accountCode === 'string' && l.accountCode &&
                typeof l.taxType === 'string' && l.taxType &&
                Number(l.amount) > 0
            )
            .map((l) => ({
              receiptKey: l.receiptKey,
              ynabClaimId: typeof l.ynabClaimId === 'string' ? l.ynabClaimId : null,
              date: typeof l.date === 'string' ? l.date : '',
              description: l.description.trim(),
              accountCode: l.accountCode,
              taxType: l.taxType,
              amount: Number(l.amount),
            }));
          if (lineItems.length === 0) {
            return new Response(JSON.stringify({ error: 'No valid line items to invoice (each needs a positive amount, account and tax code)' }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const bucketLabel = body.bucket === 'gst' ? 'GST' : body.bucket === 'transport' ? 'Transport' : 'Non-GST';
          const today = new Date().toISOString().slice(0, 10);
          // Deterministic key over the full line shape (sorted, order-independent):
          // an identical re-push dedupes, but editing account/tax/description/amount
          // produces a new key so edits aren't silently swallowed by Xero.
          const lineKeys = lineItems
            .map((l) => `${l.receiptKey}:${Number(l.amount).toFixed(2)}:${l.accountCode}:${l.taxType}:${l.description}`)
            .sort();
          const idem = await xero.idempotencyKey(['claim-bill', body.bucket || '', body.reference || '', ...lineKeys]);

          const bill = await xero.createBill(env, {
            contactName: 'Soon Yin Jie',
            date: today,
            reference: body.reference || `${bucketLabel} claims`,
            idempotencyKey: idem,
            lineItems: lineItems.map((l) => ({
              description: l.description,
              accountCode: l.accountCode,
              taxType: l.taxType,
              amount: Number(l.amount),
            })),
          });

          // Attach receipts serially (Xero allows 5 concurrent; serial is safe).
          const { uploads, warnings } = await buildClaimAttachments(env, lineItems, `${bucketLabel} ${today}`);
          const attachments: Array<{ name: string; status: string }> = [];
          for (const up of uploads) {
            try {
              await xero.attachToInvoice(env, bill.invoiceID, up.name, up.bytes, up.mime);
              attachments.push({ name: up.name, status: 'attached' });
            } catch (err) {
              attachments.push({ name: up.name, status: `failed: ${err instanceof Error ? err.message : 'error'}` });
            }
          }

          // Tag receipts as invoiced so they drop off the Invoices tab.
          const invoicedAt = new Date().toISOString();
          const uniqueKeys = Array.from(new Set(lineItems.map((l) => l.receiptKey)));
          for (const key of uniqueKeys) {
            await patchReceiptMetadata(env, key, { xeroInvoiceId: bill.invoiceID, invoicedAt });
          }

          // Flip linked YNAB TODOs to CLAIMED.
          const claimedYnab: Array<{ id: string; status: string }> = [];
          if (body.markClaimed !== false) {
            const claimIds = Array.from(
              new Set(
                lineItems
                  .map((l) => l.ynabClaimId)
                  .filter((id): id is string => typeof id === 'string' && id.length > 0)
              )
            );
            for (const id of claimIds) {
              claimedYnab.push({ id, status: await markYnabClaimed(env, id) });
            }
          }

          return new Response(
            JSON.stringify({
              invoiceID: bill.invoiceID,
              invoiceNumber: bill.invoiceNumber,
              url: bill.url,
              attachments,
              claimedYnab,
              warnings,
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to push invoice to Xero';
          return new Response(JSON.stringify({ error: message }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Serve static assets for all other routes
      return await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        {
          ASSET_NAMESPACE: env.__STATIC_CONTENT,
          ASSET_MANIFEST: assetManifest,
        }
      );
    } catch (error) {
      // If asset not found, return 404
      if (error instanceof Error && error.message.includes('could not find')) {
        return new Response('Not found', { status: 404 });
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
