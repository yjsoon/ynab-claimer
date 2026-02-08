import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
// @ts-ignore
import manifestJSON from '__STATIC_CONTENT_MANIFEST';

const assetManifest = JSON.parse(manifestJSON);

// Upload constraints
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.pdf'];
const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
const DEFAULT_AMOUNT_TAG_BATCH = 3;
const MAX_AMOUNT_TAG_BATCH = 8;
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
}

interface YnabTransaction {
  id: string;
  date: string;
  amount: number;
  payee_name: string | null;
  memo: string | null;
  transfer_transaction_id: string | null;
}

interface YnabTodo {
  id: string;
  date: string;
  payee: string;
  amount: number;
  description: string;
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

    // Check auth for API routes
    const isApiRoute = ['/upload', '/list', '/receipt/', '/ynab/', '/amount-tags/'].some(
      (route) => path === route || path.startsWith(route)
    );

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

        const listed = await env.RECEIPTS.list({ limit, cursor });

        // Fetch metadata for each receipt (R2 list() doesn't return customMetadata)
        const receipts = await Promise.all(
          listed.objects.map(async (obj) => {
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
            };
          })
        );

        return new Response(
          JSON.stringify({
            receipts,
            cursor: listed.truncated ? listed.cursor : null,
            hasMore: listed.truncated,
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
          // Only fetch transactions from the last 6 months
          const sixMonthsAgo = new Date();
          sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
          const sinceDate = sixMonthsAgo.toISOString().split('T')[0];

          const ynabResponse = await fetch(
            `https://api.ynab.com/v1/budgets/${env.YNAB_BUDGET_ID}/transactions?since_date=${sinceDate}`,
            {
              headers: {
                Authorization: `Bearer ${env.YNAB_API_KEY}`,
              },
            }
          );

          if (!ynabResponse.ok) {
            const errorText = await ynabResponse.text();
            return new Response(JSON.stringify({ error: 'YNAB API error', details: errorText }), {
              status: ynabResponse.status,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const data = (await ynabResponse.json()) as { data: { transactions: YnabTransaction[] } };

          // Filter for transactions with "TODO:" or "TODO " in memo
          // For transfers, only keep the outflow side (negative amount) to avoid duplicates
          const todoPattern = /^TODO[:\s]/i;
          const todos: YnabTodo[] = data.data.transactions
            .filter((t) => t.memo && todoPattern.test(t.memo))
            .filter((t) => !t.transfer_transaction_id || t.amount < 0)
            .map((t) => ({
              id: t.id,
              date: t.date,
              payee: t.payee_name || 'Unknown',
              amount: Math.abs(t.amount) / 1000,
              description: t.memo!.replace(/^TODO[:\s]\s*/i, '').trim(),
            }))
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

          return new Response(JSON.stringify({ todos }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to fetch YNAB data';
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
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
