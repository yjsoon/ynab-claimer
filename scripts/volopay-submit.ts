#!/usr/bin/env npx tsx

import { chromium, type Page } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from parent directory
config({ path: resolve(__dirname, '../.env') });

const VOLOPAY_BASE_URL = process.env.VOLOPAY_URL || 'https://yourcompany.volopay.co';

interface ClaimData {
  merchant: string;
  amount: number;
  currency?: string; // defaults to SGD
  date: string; // YYYY-MM-DD
  volopayCategory?: string; // defaults to "Software"
  memo: string;
  xeroCategory: string; // e.g., "Computer Software (463)"
  xeroTaxCode: string; // e.g., "INPUTY24:Standard-Rated Purchases"
  xeroBizUnit?: string; // defaults to "Classes"
  receiptPath: string; // local file path
}

const VOLOPAY_URL = `${VOLOPAY_BASE_URL}/my-volopay/reimbursement/claims?createReimbursement=true`;
const AUTH_FILE = resolve(__dirname, '.volopay-auth.json');

async function submitClaim(page: Page, claim: ClaimData) {
  console.log(`Submitting claim: ${claim.merchant} - $${claim.amount}`);

  // Navigate to claim form
  await page.goto(VOLOPAY_URL);
  await page.waitForLoadState('networkidle');

  // Check if we need to log in
  if (page.url().includes('login')) {
    console.log('Not logged in. Attempting Google login...');

    // Check if we hit the login-exceeded page (already logged in elsewhere)
    if (page.url().includes('login-exceeded')) {
      console.log('  Session exceeded, logging out first...');
      await page.getByRole('button', { name: 'logout-button-' }).click();
      await page.waitForLoadState('networkidle');
    }

    // Click Google login
    const googleBtn = page.getByRole('button', { name: 'Login with Google' });
    if (await googleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await googleBtn.click();
      await page.waitForTimeout(1000);

      // Fill email if prompted
      const emailInput = page.getByRole('textbox', { name: 'Email or phone' });
      if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await emailInput.fill('yjsoon@tinkertanker.com');
        await emailInput.press('Enter');
        console.log('  Entered email, waiting for auth...');
        // Wait for redirect back to Volopay
        await page.waitForURL(/volopay/, { timeout: 60000 });
      }
    }

    // If still on login page, pause for manual intervention
    if (page.url().includes('login')) {
      console.log('  Auto-login failed. Please complete login manually...');
      await page.pause();
      return false;
    }

    // Navigate to claim form after login
    await page.goto(VOLOPAY_URL);
    await page.waitForLoadState('networkidle');
  }

  // Wait for modal to be ready
  await page.waitForSelector('text=Create claim', { timeout: 15000 });
  console.log('  Modal loaded.');

  // === MERCHANT ===
  console.log('  Filling merchant...');
  // Click the merchant dropdown (from codegen: .vp-input-select__value-container)
  await page.locator('.vp-input-select__value-container').first().click();
  await page.waitForTimeout(300);
  // Type in the focused react-select input
  await page.keyboard.type(claim.merchant);
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  // === AMOUNT ===
  console.log('  Filling amount...');
  await page.getByRole('spinbutton', { name: 'Amount *' }).fill(claim.amount.toString());

  // === CURRENCY (if not SGD) ===
  if (claim.currency && claim.currency !== 'SGD') {
    console.log(`  Setting currency to ${claim.currency}...`);
    await page.locator('.w-1\\/2 > .relative > .grow > .react-select > .vp-input-select__control').click();
    await page.waitForTimeout(200);
    const currencyInput = page.locator('input[id^="react-select-"][id$="-input"]').last();
    await currencyInput.fill(claim.currency);
    await currencyInput.press('Enter');
    await page.waitForTimeout(300);
  }

  // === VOLOPAY CATEGORY ===
  console.log('  Selecting Volopay category...');
  const category = claim.volopayCategory || 'Software';
  // Scroll to make category visible
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(300);
  // Click the dropdown chevron (SVG icon) - it's the 3rd SVG on the form
  await page.locator('svg').nth(3).click();
  await page.waitForTimeout(500);
  // Select by exact text - pause if not found
  try {
    await page.getByText(category, { exact: true }).click({ timeout: 5000 });
  } catch {
    console.log(`  ⚠️  Category "${category}" not found - please select manually`);
    await page.evaluate((cat) => alert(`Category "${cat}" not found - please select manually, then click Resume in Playwright`), category);
    await page.pause();
  }
  await page.waitForTimeout(300);

  // === TRANSACTION DATE ===
  console.log('  Filling date...');
  // Click the date button to open picker
  await page.getByRole('button', { name: /Transaction date/i }).click();
  await page.waitForTimeout(500);
  // The date picker shows a calendar grid - click the day number
  const dateObj = new Date(claim.date + 'T00:00:00');
  const dayNum = dateObj.getDate();
  // Find the day in the calendar grid (use getByText with exact match)
  await page.getByText(String(dayNum), { exact: true }).click();
  await page.waitForTimeout(300);

  // === RECEIPT UPLOAD ===
  console.log('  Uploading receipt...');
  const receiptPath = resolve(claim.receiptPath);
  // Find the hidden file input element
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(receiptPath);
  await page.waitForTimeout(1500); // Wait for upload

  // === MEMO ===
  console.log('  Filling memo...');
  // Click "No memo added" to reveal textarea
  await page.locator('div').filter({ hasText: /^No memo added$/ }).first().click();
  await page.waitForTimeout(300);
  await page.locator('textarea[name="remarks"]').fill(claim.memo);

  // Scroll down to see Xero fields
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);

  // === XERO CATEGORY ===
  console.log('  Selecting Xero category...');
  await page.locator('.flex > div > .grow > .react-select > .vp-input-select__control').first().click();
  await page.waitForTimeout(300);
  try {
    await page.getByText(claim.xeroCategory, { exact: true }).click({ timeout: 5000 });
  } catch {
    console.log(`  ⚠️  Xero category "${claim.xeroCategory}" not found - please select manually`);
    await page.evaluate((cat) => alert(`Xero category "${cat}" not found - please select manually, then click Resume`), claim.xeroCategory);
    await page.pause();
  }
  await page.waitForTimeout(300);

  // === XERO TAX CODE ===
  console.log('  Selecting Xero tax code...');
  // Click the tax code dropdown (2nd in the Xero section)
  await page.locator('div:nth-child(2) > .grow > .react-select > .vp-input-select__control > .vp-input-select__indicators > .vp-input-select__indicator').click();
  await page.waitForTimeout(300);
  try {
    await page.getByText(claim.xeroTaxCode, { exact: true }).click({ timeout: 5000 });
  } catch {
    console.log(`  ⚠️  Tax code "${claim.xeroTaxCode}" not found - please select manually`);
    await page.evaluate((code) => alert(`Tax code "${code}" not found - please select manually, then click Resume`), claim.xeroTaxCode);
    await page.pause();
  }
  await page.waitForTimeout(300);

  // === XERO BIZ UNIT ===
  console.log('  Selecting Xero biz unit...');
  const bizUnit = claim.xeroBizUnit || 'Classes';
  await page.locator('div:nth-child(4) > .grow > .react-select > .vp-input-select__control').click();
  await page.waitForTimeout(300);
  await page.getByRole('option', { name: bizUnit }).click();
  await page.waitForTimeout(300);

  // === DONE - PAUSE FOR REVIEW ===
  console.log('  Form filled! Pausing for review...');
  console.log('  Click Continue manually when ready, then close browser to finish.');
  await page.pause();

  return true;
}

async function main() {
  // Read claim data from stdin or file arg
  let claimJson: string;

  if (process.argv[2]) {
    // File path provided
    claimJson = readFileSync(process.argv[2], 'utf-8');
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    claimJson = Buffer.concat(chunks).toString('utf-8');
  }

  const claim: ClaimData = JSON.parse(claimJson);

  // Validate required fields
  const required = ['merchant', 'amount', 'date', 'memo', 'xeroCategory', 'xeroTaxCode', 'receiptPath'];
  for (const field of required) {
    if (!(field in claim)) {
      console.error(`Missing required field: ${field}`);
      process.exit(1);
    }
  }

  // Launch browser (headed so user can see/intervene)
  const browser = await chromium.launch({
    headless: false,
    slowMo: 50, // Slight delay for stability
  });

  // Try to load saved auth state
  let context;
  if (existsSync(AUTH_FILE)) {
    try {
      context = await browser.newContext({ storageState: AUTH_FILE });
      console.log('Loaded saved auth state.');
    } catch {
      context = await browser.newContext();
    }
  } else {
    context = await browser.newContext();
  }

  const page = await context.newPage();

  try {
    const success = await submitClaim(page, claim);

    // Save auth state for future runs
    await context.storageState({ path: AUTH_FILE });
    console.log('Auth state saved.');

    if (!success) {
      console.log('Please run again after logging in.');
    }
  } catch (err) {
    console.error('Error:', err);
    await page.screenshot({ path: 'error-screenshot.png' });
    console.log('Screenshot saved to error-screenshot.png');
  } finally {
    await browser.close();
  }
}

main();
