import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
// @ts-ignore
import manifestJSON from '__STATIC_CONTENT_MANIFEST';

const assetManifest = JSON.parse(manifestJSON);

interface Env {
  RECEIPTS: R2Bucket;
  __STATIC_CONTENT: KVNamespace;
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
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
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
