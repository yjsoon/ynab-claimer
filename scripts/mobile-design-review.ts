/**
 * Mobile design review harness: serves the static web app with mocked API
 * fixtures and captures screenshots across claim-processing workflows.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page, type BrowserContext } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../upload-app/src');
const ARTIFACT_DIR = '/opt/cursor/artifacts/screenshots/mobile-review';
const AUTH_TOKEN = 'design-review';
const PORT = 4173;

const MOCK_TODOS = [
  {
    id: 'claim-chatgpt',
    date: '2026-06-18',
    payee: 'OpenAI',
    amount: 28.5,
    description: 'ChatGPT Plus subscription',
    accountName: 'Work Refundables',
    categoryName: 'Computer Software',
    source: 'transaction',
  },
  {
    id: 'claim-grab',
    date: '2026-06-20',
    payee: 'Grab',
    amount: 14.2,
    description: 'Ride to client meeting',
    accountName: 'Work Refundables',
    categoryName: 'Transport',
    source: 'transaction',
  },
  {
    id: 'claim-aws',
    date: '2026-06-22',
    payee: 'Amazon Web Services',
    amount: 156.88,
    description: 'AWS hosting — June',
    accountName: 'Work Refundables',
    categoryName: 'Computer Software',
    source: 'transaction',
  },
  {
    id: 'claim-lunch',
    date: '2026-06-25',
    payee: 'KFC',
    amount: 12.4,
    description: 'Team lunch while travelling',
    accountName: 'Work Refundables',
    categoryName: 'Entertainment',
    source: 'transaction',
  },
];

const MOCK_RECEIPTS = [
  {
    key: '2026-06-18_120000_abc1_openai.pdf',
    size: 84210,
    uploaded: '2026-06-18T12:00:00.000Z',
    storageUploaded: '2026-06-18T12:00:00.000Z',
    originalName: 'openai_june.pdf',
    linkedClaimIds: [],
    taggedAmount: 28.5,
    taggedCurrency: 'SGD',
    taggedVendor: 'OpenAI',
    taggedPurpose: 'ChatGPT Plus',
    taggedStatus: 'tagged',
    receiptDate: '2026-06-18',
    receiptDateSource: 'ai',
    taggedGstShown: false,
  },
  {
    key: '2026-06-20_090000_def2_grab.pdf',
    size: 45120,
    uploaded: '2026-06-20T09:00:00.000Z',
    storageUploaded: '2026-06-20T09:00:00.000Z',
    originalName: 'grab_2026-06-20_14.20.pdf',
    linkedClaimIds: [],
    taggedAmount: 14.2,
    taggedCurrency: 'SGD',
    taggedVendor: 'Grab',
    taggedPurpose: 'Ride',
    taggedStatus: 'tagged',
    receiptDate: '2026-06-20',
    receiptDateSource: 'ai',
    taggedGstShown: true,
    taggedGstAmount: 1.17,
  },
  {
    key: '2026-06-22_150000_ghi3_fireworks.pdf',
    size: 120340,
    uploaded: '2026-06-22T15:00:00.000Z',
    storageUploaded: '2026-06-22T15:00:00.000Z',
    originalName: 'fireworks_invoice.pdf',
    linkedClaimIds: ['claim-aws'],
    linkedClaimDescription: 'AWS hosting — June',
    taggedAmount: 42.0,
    taggedCurrency: 'USD',
    taggedAmountSgdApprox: 56.2,
    taggedAmountSgdApproxPlus325: 58.03,
    taggedVendor: 'Fireworks AI',
    taggedPurpose: 'API credits',
    taggedStatus: 'tagged',
    receiptDate: '2026-06-22',
    receiptDateSource: 'manual',
    taggedGstShown: true,
    taggedGstAmount: 4.82,
  },
  {
    key: '2026-06-24_110000_jkl4_hardware.jpg',
    size: 2100000,
    uploaded: '2026-06-24T11:00:00.000Z',
    storageUploaded: '2026-06-24T11:00:00.000Z',
    originalName: 'apple_store_receipt.jpg',
    linkedClaimIds: ['receipt-ready:2026-06-24_110000_jkl4_hardware.jpg'],
    taggedAmount: 1899.0,
    taggedCurrency: 'SGD',
    taggedVendor: 'Apple',
    taggedPurpose: 'Magic Keyboard',
    taggedStatus: 'tagged',
    receiptDate: '2026-06-24',
    receiptDateSource: 'ai',
    taggedGstShown: true,
    taggedGstAmount: 156.58,
  },
  {
    key: '2026-06-25_080000_mno5_lunch.jpg',
    size: 980000,
    uploaded: '2026-06-25T08:00:00.000Z',
    storageUploaded: '2026-06-25T08:00:00.000Z',
    originalName: 'kfc_receipt.jpg',
    linkedClaimIds: ['claim-lunch'],
    linkedClaimDescription: 'Team lunch while travelling',
    taggedAmount: 12.4,
    taggedCurrency: 'SGD',
    taggedVendor: 'KFC',
    taggedPurpose: 'Lunch',
    taggedStatus: 'tagged',
    receiptDate: '2026-06-25',
    receiptDateSource: 'ai',
    taggedGstShown: false,
  },
];

const MOCK_XERO_META = {
  accounts: [
    { code: '320', name: 'Cost of Sales' },
    { code: '463', name: 'Computer Software' },
    { code: '464', name: 'Computer Hardware & Accessories' },
    { code: '467', name: 'Telephone & Internet' },
    { code: '471', name: 'Transport' },
  ],
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function startStaticServer() {
  return new Promise<ReturnType<typeof createServer>>((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === '/list' && req.method === 'GET') {
        return json(res, { receipts: MOCK_RECEIPTS, cursor: null, hasMore: false });
      }
      if (pathname === '/ynab/todos' && req.method === 'GET') {
        return json(res, { todos: MOCK_TODOS });
      }
      if (pathname === '/xero/status' && req.method === 'GET') {
        return json(res, { connected: true, tenantName: 'Soon Pte Ltd (Demo)' });
      }
      if (pathname === '/xero/meta' && req.method === 'GET') {
        return json(res, MOCK_XERO_META);
      }
      if (pathname.startsWith('/receipt/') && req.method === 'GET') {
        // Tiny red PNG placeholder for preview modal
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
          'base64',
        );
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(png);
      }
      if (pathname === '/amount-tags/pending' && req.method === 'POST') {
        return json(res, { tagged: 0, remaining: 0 });
      }
      if (pathname === '/gst-tags/pending' && req.method === 'POST') {
        return json(res, { tagged: 0, remaining: 0 });
      }

      const rel = pathname === '/' ? '/index.html' : pathname;
      const filePath = path.join(SRC_DIR, rel);
      if (!filePath.startsWith(SRC_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      try {
        const data = await readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function shot(page: Page, name: string) {
  const file = path.join(ARTIFACT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${file}`);
  return file;
}

async function waitForClaimsLoaded(page: Page) {
  await page.waitForSelector('#todoList .todo-item, #todoList .empty-state', { timeout: 15000 });
  await page.waitForTimeout(400);
}

async function waitForReceiptsLoaded(page: Page) {
  await page.click('.tab-btn[data-tab="receipts"]');
  await page.waitForSelector('#receiptsColumn.active', { timeout: 5000 });
  await page.waitForSelector('#receiptList li[data-key], #receiptList .empty-state', {
    state: 'visible',
    timeout: 15000,
  });
  await page.waitForTimeout(400);
}

async function seedAuth(context: BrowserContext) {
  await context.addInitScript((token) => {
    localStorage.setItem('claim_manager_auth', token);
    localStorage.setItem('claim_manager_remember', 'true');
    localStorage.setItem('claim_manager_theme', 'light');
  }, AUTH_TOKEN);
}

async function runWorkflows() {
  await import('node:fs/promises').then((fs) => fs.mkdir(ARTIFACT_DIR, { recursive: true }));
  const server = await startStaticServer();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await seedAuth(context);
  const page = await context.newPage();

  const screenshots: string[] = [];

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await waitForClaimsLoaded(page);
    screenshots.push(await shot(page, '01-claims-home'));

    await waitForReceiptsLoaded(page);
    screenshots.push(await shot(page, '02-receipts-tab'));

    const firstLinkBtn = page.locator('#receiptList .link-btn').first();
    await firstLinkBtn.click();
    await page.waitForSelector('#linkingDock:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(350);
    screenshots.push(await shot(page, '03-linking-from-receipt'));

    await page.locator('#todoList .todo-item').first().click();
    await page.waitForTimeout(300);
    screenshots.push(await shot(page, '04-linking-claim-selected'));

    await page.click('#cancelSelection');
    await page.waitForTimeout(250);

    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    await page.waitForTimeout(350);
    screenshots.push(await shot(page, '05-ready-to-claim'));

    await page.click('#navInvoices');
    await page.waitForSelector('#invoicesSections .invoice-section', { timeout: 15000 });
    await page.waitForTimeout(500);
    screenshots.push(await shot(page, '06-invoices-overview'));

    const gstSection = page.locator('.invoice-section[data-bucket="gst"]');
    if (await gstSection.count()) {
      await gstSection.evaluate((el: HTMLDetailsElement) => {
        el.open = true;
      });
      await page.waitForTimeout(350);
      screenshots.push(await shot(page, '07-invoices-gst-cards'));

      const gstPush = page.locator('.invoice-section[data-bucket="gst"] .invoice-push-btn');
      const reviewBtns = page.locator('.invoice-section[data-bucket="gst"] .inv-review-btn');
      const reviewCount = await reviewBtns.count();
      if (reviewCount > 0) {
        if (await gstPush.isEnabled()) {
          throw new Error('GST push should be disabled until all lines are reviewed');
        }
        for (let i = 0; i < reviewCount; i++) {
          await reviewBtns.nth(i).click();
          await page.waitForTimeout(120);
        }
        if (!(await gstPush.isEnabled())) {
          throw new Error('GST push should be enabled after all lines are reviewed');
        }
        await page.waitForTimeout(250);
        screenshots.push(await shot(page, '07b-invoices-all-reviewed'));
      }
    }

    await page.click('#themeToggle');
    await page.waitForTimeout(250);
    screenshots.push(await shot(page, '08-invoices-dark-mode'));

    await page.click('#navClaims');
    await waitForClaimsLoaded(page);
    await waitForReceiptsLoaded(page);
    const receiptRow = page.locator('#receiptList li[data-key]').first();
    await receiptRow.click({ position: { x: 120, y: 20 } });
    await page.waitForSelector('#previewOverlay.active', { timeout: 5000 });
    await page.waitForTimeout(400);
    screenshots.push(await shot(page, '09-receipt-preview'));
  } finally {
    await browser.close();
    server.close();
  }

  return screenshots;
}

runWorkflows()
  .then((files) => {
    console.log('Screenshots:', files.join('\n'));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
