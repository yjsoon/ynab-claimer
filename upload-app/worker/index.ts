import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
// @ts-ignore
import manifestJSON from '__STATIC_CONTENT_MANIFEST';

const assetManifest = JSON.parse(manifestJSON);

interface Env {
  RECEIPTS: R2Bucket;
  __STATIC_CONTENT: KVNamespace;
  AUTH_PASSWORD: string;
  YNAB_API_KEY: string;
  YNAB_BUDGET_ID: string;
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

// Generate timestamped filename
function generateKey(filename: string): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '');
  const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${date}_${time}_${safeName}`;
}

// CORS headers for cross-origin requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
};

// Validate auth token
function validateAuth(request: Request, env: Env): boolean {
  const token = request.headers.get('X-Auth-Token');
  return token === env.AUTH_PASSWORD;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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

        const key = generateKey(file.name);
        const arrayBuffer = await file.arrayBuffer();

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

      // GET /list - List all receipts
      if (path === '/list' && request.method === 'GET') {
        const listed = await env.RECEIPTS.list();
        const receipts = listed.objects.map((obj) => ({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded.toISOString(),
        }));

        return new Response(JSON.stringify({ receipts }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
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
      if (path.startsWith('/receipt/') && request.method === 'DELETE') {
        const key = decodeURIComponent(path.replace('/receipt/', ''));
        await env.RECEIPTS.delete(key);

        return new Response(JSON.stringify({ success: true, deleted: key }), {
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

          // Filter for transactions with "TODO:" in memo
          // For transfers, only keep the outflow side (negative amount) to avoid duplicates
          const todos: YnabTodo[] = data.data.transactions
            .filter((t) => t.memo && t.memo.toUpperCase().startsWith('TODO:'))
            .filter((t) => !t.transfer_transaction_id || t.amount < 0)
            .map((t) => ({
              id: t.id,
              date: t.date,
              payee: t.payee_name || 'Unknown',
              amount: Math.abs(t.amount) / 1000,
              description: t.memo!.replace(/^TODO:\s*/i, '').trim(),
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
