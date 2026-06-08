// Xero REST integration for Cloudflare Workers.
//
// The official `xero-node` SDK does not run in the Workers runtime, so this
// talks to Xero over raw `fetch` + Web Crypto only. It implements the standard
// OAuth 2.0 Authorization Code flow, persists the (rotating) refresh token in a
// KV namespace, and exposes a small authed-fetch wrapper plus helpers for
// creating ACCPAY (bill) drafts and uploading receipt attachments.
//
// Reference for conventions (token/credentials shape, SG GST): the local
// `xero/` project's `.claude/skills/xero-quote/lib/xero-client.ts`.

export interface XeroEnv {
  XERO_TOKENS: KVNamespace;
  XERO_CLIENT_ID: string;
  XERO_CLIENT_SECRET: string;
  XERO_SCOPES?: string;
  XERO_INPUT_TAXTYPE?: string;
}

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

// accounting.transactions: create bills. accounting.contacts: find/create the
// "Soon Yin Jie" contact. accounting.attachments: upload receipts.
// accounting.settings.read: read TaxRates + Accounts to populate the editor.
const DEFAULT_SCOPES =
  'openid profile email accounting.transactions accounting.contacts accounting.attachments accounting.settings.read offline_access';

const TOKENS_KEY = 'xero_auth';
const STATE_PREFIX = 'xero_state:';
const STATE_TTL_SECONDS = 600;
const EXPIRY_BUFFER_SECONDS = 300;

export interface XeroTokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
}

export interface XeroAuth {
  tokenSet: XeroTokenSet;
  tenantId: string;
  tenantName?: string;
  updatedAt: string;
}

// In-isolate cache so a refresh is immediately visible to later calls in the
// same request without waiting on KV's eventual consistency.
let cachedAuth: XeroAuth | null | undefined;

function scopes(env: XeroEnv): string {
  return env.XERO_SCOPES || DEFAULT_SCOPES;
}

function basicAuth(env: XeroEnv): string {
  return btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
}

// Callback URL is derived from the request origin so the same code works on
// receipts.soon.sg and on a local `wrangler dev` host — both must be registered
// as redirect URIs on the Xero app.
export function redirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/xero/callback`;
}

async function loadAuth(env: XeroEnv): Promise<XeroAuth | null> {
  if (cachedAuth !== undefined) return cachedAuth;
  const raw = await env.XERO_TOKENS.get(TOKENS_KEY);
  cachedAuth = raw ? (JSON.parse(raw) as XeroAuth) : null;
  return cachedAuth;
}

async function saveAuth(env: XeroEnv, auth: XeroAuth): Promise<void> {
  cachedAuth = auth;
  await env.XERO_TOKENS.put(TOKENS_KEY, JSON.stringify(auth));
}

export async function clearAuth(env: XeroEnv): Promise<void> {
  cachedAuth = null;
  await env.XERO_TOKENS.delete(TOKENS_KEY);
}

// --- OAuth: connect ---------------------------------------------------------

export async function createState(env: XeroEnv): Promise<string> {
  const state = crypto.randomUUID();
  await env.XERO_TOKENS.put(`${STATE_PREFIX}${state}`, '1', { expirationTtl: STATE_TTL_SECONDS });
  return state;
}

export async function consumeState(env: XeroEnv, state: string | null): Promise<boolean> {
  if (!state) return false;
  const found = await env.XERO_TOKENS.get(`${STATE_PREFIX}${state}`);
  if (!found) return false;
  await env.XERO_TOKENS.delete(`${STATE_PREFIX}${state}`);
  return true;
}

export function buildAuthorizeUrl(env: XeroEnv, requestUrl: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.XERO_CLIENT_ID,
    redirect_uri: redirectUri(requestUrl),
    scope: scopes(env),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function tokenRequest(env: XeroEnv, body: Record<string, string>): Promise<XeroTokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(env)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(`Xero token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in?: number };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 1800),
  };
}

async function pickTenant(accessToken: string): Promise<{ tenantId: string; tenantName?: string }> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Xero /connections ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const conns = (await res.json()) as Array<{ tenantId: string; tenantName?: string; tenantType?: string }>;
  const orgs = conns.filter((c) => c.tenantType === 'ORGANISATION');
  const chosen = orgs[0] || conns[0];
  if (!chosen) throw new Error('No Xero organisation is connected to this app.');
  return { tenantId: chosen.tenantId, tenantName: chosen.tenantName };
}

export async function exchangeCode(env: XeroEnv, requestUrl: string, code: string): Promise<XeroAuth> {
  const tokenSet = await tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(requestUrl),
  });
  const { tenantId, tenantName } = await pickTenant(tokenSet.access_token);
  const auth: XeroAuth = { tokenSet, tenantId, tenantName, updatedAt: new Date().toISOString() };
  await saveAuth(env, auth);
  return auth;
}

// --- OAuth: token lifecycle -------------------------------------------------

async function refreshAuth(env: XeroEnv, auth: XeroAuth): Promise<XeroAuth> {
  const tokenSet = await tokenRequest(env, {
    grant_type: 'refresh_token',
    refresh_token: auth.tokenSet.refresh_token,
  });
  // Refresh tokens rotate: persist the new one immediately or the next call fails.
  const refreshed: XeroAuth = { ...auth, tokenSet, updatedAt: new Date().toISOString() };
  await saveAuth(env, refreshed);
  return refreshed;
}

// Loads stored auth and refreshes proactively when the access token is within
// EXPIRY_BUFFER_SECONDS of expiry. Call once up front for a batch of requests.
export async function getValidAuth(env: XeroEnv): Promise<XeroAuth> {
  const auth = await loadAuth(env);
  if (!auth) {
    throw new Error('Xero is not connected. Open the Invoices tab and click "Connect Xero".');
  }
  const now = Math.floor(Date.now() / 1000);
  if (now < auth.tokenSet.expires_at - EXPIRY_BUFFER_SECONDS) return auth;
  return refreshAuth(env, auth);
}

export interface XeroStatus {
  connected: boolean;
  tenantName?: string;
  updatedAt?: string;
}

export async function getStatus(env: XeroEnv): Promise<XeroStatus> {
  const auth = await loadAuth(env);
  if (!auth) return { connected: false };
  return { connected: true, tenantName: auth.tenantName, updatedAt: auth.updatedAt };
}

// --- Authed fetch wrapper ---------------------------------------------------

export interface XeroFetchInit extends Omit<RequestInit, 'body'> {
  body?: BodyInit;
}

// Calls the Xero API with auth + tenant headers. Retries once on 401 (force
// refresh) and honours 429 Retry-After. `path` is relative to API_BASE unless
// it starts with http.
export async function xeroFetch(env: XeroEnv, path: string, init: XeroFetchInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const auth = await getValidAuth(env);

  const attempt = (accessToken: string): Promise<Response> =>
    fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': auth.tenantId,
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });

  let res = await attempt(auth.tokenSet.access_token);

  if (res.status === 401) {
    const refreshed = await refreshAuth(env, auth);
    res = await attempt(refreshed.tokenSet.access_token);
  }

  // Basic 429 handling: respect Retry-After once (Xero limit: 60/min, 5 concurrent).
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') || '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 30) * 1000));
    const current = await getValidAuth(env);
    res = await attempt(current.tokenSet.access_token);
  }

  return res;
}

// --- Metadata: tax rates + expense accounts (for the editor dropdowns) ------

export interface XeroTaxRate {
  taxType: string;
  name: string;
  rate: number;
}

export interface XeroAccount {
  code: string;
  name: string;
  type: string;
  taxType?: string;
}

export async function getTaxRates(env: XeroEnv): Promise<XeroTaxRate[]> {
  const res = await xeroFetch(env, '/TaxRates');
  if (!res.ok) throw new Error(`Xero /TaxRates ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    TaxRates?: Array<{ Name?: string; TaxType?: string; Status?: string; EffectiveRate?: number }>;
  };
  return (data.TaxRates || [])
    .filter((r) => r.TaxType && (r.Status || 'ACTIVE') === 'ACTIVE')
    .map((r) => ({ taxType: r.TaxType as string, name: r.Name || (r.TaxType as string), rate: r.EffectiveRate || 0 }));
}

export async function getExpenseAccounts(env: XeroEnv): Promise<XeroAccount[]> {
  const res = await xeroFetch(env, '/Accounts?where=' + encodeURIComponent('Class=="EXPENSE"'));
  if (!res.ok) throw new Error(`Xero /Accounts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    Accounts?: Array<{ Code?: string; Name?: string; Type?: string; TaxType?: string; Status?: string }>;
  };
  return (data.Accounts || [])
    .filter((a) => a.Code && (a.Status || 'ACTIVE') === 'ACTIVE')
    .map((a) => ({ code: a.Code as string, name: a.Name || '', type: a.Type || '', taxType: a.TaxType }));
}
