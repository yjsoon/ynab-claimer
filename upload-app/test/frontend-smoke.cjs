const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..', 'src');
const port = 8789;
const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
};

const receiptsPageOne = [
  {
    key: 'receipt-1.pdf',
    originalName: 'Receipt One.pdf',
    uploaded: '2026-06-24T00:00:00Z',
    linkedClaimIds: [],
    taggedAmount: 12.34,
    taggedCurrency: 'SGD',
    taggedVendor: 'Vendor A',
    taggedPurpose: 'Software',
    taggedGstShown: false,
    detectedReceiptDate: '2026-06-24',
  },
  {
    key: 'receipt-2.pdf',
    originalName: 'Invoice Line.pdf',
    uploaded: '2026-06-25T00:00:00Z',
    linkedClaimIds: ['claim-1'],
    taggedAmount: 50,
    taggedCurrency: 'MYR',
    taggedAmountSgdApprox: 15,
    taggedVendor: 'Vendor B',
    taggedPurpose: 'Subscription',
    taggedGstShown: false,
    xeroPendingInvoiceId: 'pending-bill-1',
    xeroPendingInvoiceNumber: 'DRAFT-1',
  },
];

const receiptsPageTwo = [
  {
    key: 'receipt-3.pdf',
    originalName: 'Paged Receipt.pdf',
    uploaded: '2026-06-26T00:00:00Z',
    linkedClaimIds: [],
    taggedAmount: 7,
    taggedCurrency: 'SGD',
    taggedVendor: 'Vendor C',
    taggedPurpose: 'Tooling',
    taggedGstShown: false,
  },
  {
    key: 'receipt-4.pdf',
    originalName: 'Already Claimed.pdf',
    uploaded: '2026-06-27T00:00:00Z',
    linkedClaimIds: ['claim-archived'],
    taggedAmount: 20,
    taggedCurrency: 'SGD',
    taggedVendor: 'Vendor D',
    taggedPurpose: 'Archived claim',
    taggedGstShown: false,
    xeroInvoiceId: 'xero-invoice-1',
  },
];

const todos = [
  {
    id: 'claim-1',
    date: '2026-06-25',
    payee: 'Vendor B',
    description: 'Subscription',
    amount: 15,
    accountName: 'Work Refundables',
  },
  {
    id: 'claim-2',
    date: '2026-06-24',
    payee: 'Vendor A',
    description: 'Software',
    amount: 12.34,
    accountName: 'Work Refundables',
  },
];

const server = http.createServer((req, res) => {
  let pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/' || pathname === '/invoices' || pathname === '/invoices/') {
    pathname = '/index.html';
  }

  const file = path.join(root, pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

async function main() {
  await new Promise((resolve) => server.listen(port, resolve));
  const browser = await chromium.launch({ headless: true });
  let uploadCount = 0;
  const markClaimRequests = [];
  const linkRequests = [];

  async function setupMockApi(page) {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const isAuthed = route.request().headers()['x-auth-token'] === 'test';

      if (url.pathname === '/list') {
        if (!isAuthed) return route.fulfill({ status: 401, json: { error: 'unauthorised' } });
        const cursor = url.searchParams.get('cursor');
        const body = cursor === 'page-2'
          ? { receipts: receiptsPageTwo, hasMore: false }
          : { receipts: receiptsPageOne, hasMore: true, cursor: 'page-2' };
        return route.fulfill({ json: body });
      }

      if (url.pathname === '/upload') {
        uploadCount += 1;
        return route.fulfill({ json: { success: true, key: 'blob.png' } });
      }

      if (url.pathname === '/ynab/todos') return route.fulfill({ json: { todos } });
      if (url.pathname.startsWith('/receipt/') && url.pathname.endsWith('/link') && route.request().method() === 'PATCH') {
        const key = decodeURIComponent(url.pathname.slice('/receipt/'.length, -'/link'.length));
        const body = JSON.parse(route.request().postData() || '{}');
        const linkedIds = Array.isArray(body.linkedClaims)
          ? body.linkedClaims.map((claim) => claim.id).filter(Boolean)
          : [];
        const receipt = [...receiptsPageOne, ...receiptsPageTwo].find((item) => item.key === key);
        if (receipt) {
          receipt.linkedClaimIds = linkedIds;
          receipt.linkedClaimId = linkedIds[0] || undefined;
        }
        linkRequests.push({ key, linkedIds });
        return route.fulfill({ json: { success: true } });
      }
      if (url.pathname === '/xero/status') return route.fulfill({ json: { connected: true, tenantName: 'Test Xero' } });
      if (url.pathname === '/xero/meta') {
        return route.fulfill({
          json: {
            accounts: [],
            taxRates: [
              { taxType: 'INPUTY24', name: 'Standard-Rated Purchases' },
              { taxType: 'NONE', name: 'No Tax' },
              { taxType: 'NRINPUT', name: 'Purchases from Non-GST Registered Suppliers' },
              { taxType: 'OPINPUT', name: 'Out Of Scope Purchases' },
            ],
          },
        });
      }
      if (url.pathname === '/xero/invoices/mark-claimed') {
        const body = JSON.parse(route.request().postData() || '{}');
        markClaimRequests.push(body);
        return route.fulfill({
          json: {
            success: true,
            claimedDate: '2026-07-02',
            taggedReceipts: [{ key: 'receipt-2.pdf', status: 'tagged' }],
            claimedYnab: [{ id: 'claim-1', status: 'claimed' }],
          },
        });
      }
      if (url.pathname === '/amount-tags/pending') return route.fulfill({ json: { processed: 0, remaining: 0, tagged: 0 } });
      return route.continue();
    });
  }

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const failedSubresources = [];
  page.on('response', (response) => {
    const type = response.request().resourceType();
    if (response.status() >= 400 && ['document', 'script', 'stylesheet'].includes(type)) {
      failedSubresources.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.addInitScript(() => {
    localStorage.setItem('claim_manager_auth', 'test');
    localStorage.setItem('claim_manager_remember', 'true');
  });
  await setupMockApi(page);

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#matchReviewSection:not([hidden]) .match-review-item');
  const matchCountText = await page.locator('#matchReviewCount').textContent();
  if (matchCountText !== '(1)') throw new Error(`expected one match suggestion, got ${matchCountText}`);
  await page.locator('.match-review-item .match-reject-btn').click();
  await page.waitForFunction(() => document.querySelectorAll('#matchReviewList .match-review-item').length === 0);
  await page.locator('#findMatchesBtn').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('No matches'));
  await page.locator('#clearDismissedMatchesBtn').click();
  await page.waitForSelector('#matchReviewSection:not([hidden]) .match-review-item');
  // Leave the suggestion in place for now so invoice counts stay stable; Change opens claim-link flow.
  await page.locator('.match-review-item .match-change-btn').click();
  await page.waitForSelector('#linkingDock:not([hidden])');
  const receiptChecked = await page.locator('#receiptList li[data-key="receipt-1.pdf"]').evaluate((el) => el.classList.contains('checked'));
  if (!receiptChecked) throw new Error('Change should pre-select the suggested receipt');
  await page.locator('#cancelSelection').click();

  await page.locator('.tab-btn[data-tab="receipts"]').click();
  await page.waitForSelector('#receiptList li[data-key="receipt-3.pdf"]', { state: 'attached' });

  const countText = await page.locator('#count').textContent();
  if (countText !== '(2)') throw new Error(`expected paginated receipts to load, got count ${countText}`);
  const readyCountText = await page.locator('#linkedCount').textContent();
  if (readyCountText !== '(1)') throw new Error(`invoiced receipts should not count as ready, got ${readyCountText}`);
  const invoiceBadgeText = await page.locator('#invoicesNavBadge').textContent();
  if (invoiceBadgeText !== '1') throw new Error(`invoice badge should ignore invoiced receipts, got ${invoiceBadgeText}`);
  const invoicedReadyVisible = await page.locator('#linkedList li[data-receipt-key="receipt-4.pdf"]').count();
  if (invoicedReadyVisible !== 0) throw new Error('invoiced receipt should not appear in Ready to Claim');

  const compact = await page.locator('#dropzone').evaluate((el) => el.classList.contains('is-compact'));
  if (!compact) throw new Error('dropzone did not compact with outstanding work');

  await page.locator('#fileInput').setInputFiles({
    name: 'blob',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  await page.waitForFunction(() => document.querySelector('#status')?.classList.contains('success'));
  if (uploadCount !== 1) throw new Error('extensionless image upload was not attempted');

  await page.locator('#fileInput').setInputFiles({
    name: 'receipt.exe',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  await page.waitForFunction(() => document.querySelector('#status')?.classList.contains('error'));
  if (uploadCount !== 1) throw new Error('disallowed extension should fail before upload');

  await page.locator('#receiptList li[data-key="receipt-1.pdf"] .link-btn').click();
  await page.waitForSelector('#linkingDock:not([hidden])');
  await page.locator('#todoList .todo-item[data-claim-id="claim-2"]').click();
  const confirmVisible = await page.locator('#confirmSelection:not([hidden])').isVisible();
  if (!confirmVisible) throw new Error('link confirm button did not become visible');
  await page.locator('#cancelSelection').click();

  await page.locator('#findMatchesBtn').click();
  await page.waitForSelector('#matchReviewSection:not([hidden]) .match-accept-btn');
  await page.locator('.match-review-item .match-accept-btn').click();
  await page.waitForFunction(() => document.querySelector('#matchReviewSection')?.hidden);
  if (linkRequests.length !== 1 || linkRequests[0].key !== 'receipt-1.pdf' || linkRequests[0].linkedIds[0] !== 'claim-2') {
    throw new Error(`expected accept to link receipt-1 to claim-2, got ${JSON.stringify(linkRequests)}`);
  }

  // Restore unlinked state for invoice tests that expect the original ready set.
  const receiptOne = receiptsPageOne.find((item) => item.key === 'receipt-1.pdf');
  if (receiptOne) {
    receiptOne.linkedClaimIds = [];
    delete receiptOne.linkedClaimId;
  }

  await page.goto(`http://127.0.0.1:${port}/invoices/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  const meta = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-section-meta').textContent();
  if (!meta.includes('1 bill lines') || !meta.includes('0/1 reviewed')) throw new Error(`unexpected invoice meta: ${meta}`);

  const disabledBefore = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled();
  if (!disabledBefore) throw new Error('push should be disabled before review');

  await page.locator('.invoice-section[data-bucket="nongst"] .inv-review-btn').click();
  const disabledAfter = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled();
  if (disabledAfter) throw new Error('push should enable after review');

  const accountText = await page.locator('.invoice-section[data-bucket="nongst"] [data-label="Account"] .inv-cell-text').textContent();
  if (accountText !== 'Computer Software - 463') throw new Error(`account label should be name-code, got ${accountText}`);

  await page.locator('.invoice-section[data-bucket="nongst"] .invoice-claim-checked-btn').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Marked 1 checked Non-GST item claimed'));
  if (markClaimRequests.length !== 1) throw new Error(`expected one mark-claimed request, got ${markClaimRequests.length}`);
  if (markClaimRequests[0].invoiceID !== 'pending-bill-1') {
    throw new Error(`mark claimed should use pending receipt invoice id, got ${markClaimRequests[0].invoiceID}`);
  }

  let taxCell = page.locator('.invoice-section[data-bucket="nongst"] [data-label="Tax"]');
  const taxText = await taxCell.locator('.inv-cell-text').textContent();
  if (!taxText.startsWith('OPINPUT')) throw new Error(`foreign non-GST tax type should be OPINPUT, got ${taxText}`);

  await taxCell.click();
  const taxOptions = await taxCell.locator('select option').evaluateAll((options) => options.map((option) => option.value));
  if (taxOptions.join(',') !== 'NRINPUT,INPUTY24,OPINPUT') {
    throw new Error(`tax type dropdown should only show purchase tax types, got ${taxOptions.join(',')}`);
  }
  await page.keyboard.press('Escape');
  await taxCell.locator('.inv-cell-text').waitFor();

  await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem('claim_manager_invoice_edits') || '{}');
    const entry = store['receipt-2.pdf::claim-1'];
    if (!entry) throw new Error('missing persisted invoice review');
    entry.reviewedSourceSnapshot = {
      ...entry.reviewedSourceSnapshot,
      accountCode: '999',
      taxType: 'LEGACYTAX',
      section: 'gst',
    };
    localStorage.setItem('claim_manager_invoice_edits', JSON.stringify(store));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  const metaAfterReload = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-section-meta').textContent();
  if (!metaAfterReload.includes('1/1 reviewed')) {
    throw new Error(`review should survive legacy derived snapshot differences, got ${metaAfterReload}`);
  }
  const disabledAfterReload = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled();
  if (disabledAfterReload) throw new Error('push should remain enabled after legacy derived snapshot differences');

  const sortSelect = page.locator('.invoice-section[data-bucket="nongst"] .invoice-sort-select');
  await sortSelect.selectOption('date-desc');
  const storedSort = await page.evaluate(() => JSON.parse(localStorage.getItem('claim_manager_invoice_sorts') || '{}').nongst);
  if (storedSort !== 'date-desc') throw new Error(`invoice sort choice should persist, got ${storedSort}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');
  const selectedSort = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-sort-select').inputValue();
  if (selectedSort !== 'date-desc') throw new Error(`invoice sort choice should restore after reload, got ${selectedSort}`);

  taxCell = page.locator('.invoice-section[data-bucket="nongst"] [data-label="Tax"]');
  await taxCell.click();
  await taxCell.locator('select').selectOption('NRINPUT');
  const editedTaxText = await taxCell.locator('.inv-cell-text').textContent();
  if (!editedTaxText.startsWith('NRINPUT')) throw new Error(`tax type should be editable to NRINPUT, got ${editedTaxText}`);

  const disabledAfterTaxEdit = await page.locator('.invoice-section[data-bucket="nongst"] .invoice-push-btn').isDisabled();
  if (!disabledAfterTaxEdit) throw new Error('editing the tax type should require review again before push');
  if (failedSubresources.length > 0) throw new Error(`subresource load failures: ${failedSubresources.join(', ')}`);

  const authPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await setupMockApi(authPage);
  await authPage.goto(`http://127.0.0.1:${port}/invoices`, { waitUntil: 'networkidle' });
  await authPage.locator('#passwordInput').fill('test');
  await authPage.locator('#authSubmit').click();
  await authPage.waitForSelector('.invoice-section[data-bucket="nongst"] tr[data-id]');

  await browser.close();
  server.close();
  console.log('frontend smoke passed');
}

main().catch(async (err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
