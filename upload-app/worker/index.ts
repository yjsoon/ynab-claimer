import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
// @ts-ignore
import manifestJSON from '__STATIC_CONTENT_MANIFEST';

const assetManifest = JSON.parse(manifestJSON);

// Upload constraints
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.pdf'];

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
    const isApiRoute = ['/upload', '/list', '/receipt/', '/ynab/'].some(
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
            return {
              key: obj.key,
              size: obj.size,
              uploaded: obj.uploaded.toISOString(),
              originalName: head?.customMetadata?.originalName,
              linkedClaimId: head?.customMetadata?.linkedClaimId,
              linkedClaimDescription: head?.customMetadata?.linkedClaimDescription,
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
          linkedClaimId: string;
          linkedClaimDescription: string;
          linkedClaimAmount?: number;
          linkedClaimDate?: string;
        };

        // Get existing object
        const existing = await env.RECEIPTS.get(key);
        if (!existing) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Re-put with updated metadata (must consume body first)
        const content = await existing.arrayBuffer();
        await env.RECEIPTS.put(key, content, {
          httpMetadata: existing.httpMetadata,
          customMetadata: {
            ...existing.customMetadata,
            linkedClaimId: body.linkedClaimId,
            linkedClaimDescription: body.linkedClaimDescription,
            linkedClaimAmount: body.linkedClaimAmount ? String(body.linkedClaimAmount) : undefined,
            linkedClaimDate: body.linkedClaimDate,
          },
        });

        return new Response(JSON.stringify({ success: true, key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // DELETE /receipt/:key/link - Unlink a receipt from a claim
      if (path.startsWith('/receipt/') && path.endsWith('/link') && request.method === 'DELETE') {
        const key = decodeURIComponent(path.replace('/receipt/', '').replace('/link', ''));

        // Get existing object
        const existing = await env.RECEIPTS.get(key);
        if (!existing) {
          return new Response(JSON.stringify({ error: 'Receipt not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Re-put without link metadata
        const content = await existing.arrayBuffer();
        const { linkedClaimId, linkedClaimDescription, linkedClaimAmount, linkedClaimDate, ...keepMetadata } =
          existing.customMetadata || {};
        await env.RECEIPTS.put(key, content, {
          httpMetadata: existing.httpMetadata,
          customMetadata: keepMetadata,
        });

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
