# Claim Manager

Expense claim management system with YNAB integration and Cloudflare R2 storage.

## Features

- **Receipt Upload**: Drag-and-drop web interface for uploading receipts
- **Receipt-Claim Linking**: Pre-link receipts to YNAB transactions in the web UI for faster processing, including claim-first multi-select linking
- **AI Amount + Date Tagging**: Gemini auto-tags receipt totals and receipt dates for pending receipts
- **AI Vendor + Purpose Label**: Gemini adds best-effort vendor and short purpose labels for faster scanning
- **USD Matching Assist**: For USD receipts, the app shows approximate SGD values at day rate and day rate + 3.25%
- **Smart Match Highlighting**: During linking, the UI highlights exact and near matches by amount and date
- **YNAB Integration**: View pending claims (transactions marked with `TODO:`) directly in the web app
- **Volopay Automation**: Playwright script auto-fills Volopay claim forms
- **Password Protection**: Simple auth gate for the web app and API
- **iOS Shortcut**: Upload receipts directly from the Share Sheet
- **Claude Code Skill**: Interactive claim processing via `/claims` command

## Components

### 1. Receipt Upload App (`upload-app/`)

Web app for uploading receipts and viewing pending YNAB claims.

**Stack**: Cloudflare Workers + R2

**Endpoints**:
- `POST /upload` - Upload receipt file
- `GET /list` - List pending receipts (includes link metadata)
- `GET /ynab/todos` - Fetch pending claims from YNAB
- `GET /receipt/:key` - Download receipt
- `DELETE /receipt/:key` - Delete receipt
- `PATCH /receipt/:key/link` - Link receipt to a YNAB transaction
- `PATCH /receipt/:key/receipt-date` - Set/clear manual receipt date override (`YYYY-MM-DD`)
- `POST /receipt/:key/tag-amount` - Run Gemini amount tagging for one receipt
- `POST /amount-tags/pending?limit=3` - Tag a batch of pending receipts

All endpoints require `X-Auth-Token` header.

### 2. Volopay Automation (`scripts/`)

Playwright script to auto-fill Volopay expense claim forms.

```bash
cd scripts
npm install
npm run submit -- claim.json
```

The script fills all form fields and pauses for review before submit. If a dropdown option isn't found, it shows an alert and pauses for manual selection.

### 3. Claude Code Skill (`/claims`)

Interactive claim processing workflow run via Claude Code.

## Setup

### Prerequisites

- Cloudflare account (free tier)
- YNAB account with API access
- Node.js 18+

### 1. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values
```

Required values:
- `YNAB_API_KEY` - Get from https://app.ynab.com/settings/developer
- `YNAB_BUDGET_ID` - From URL when viewing budget: `app.ynab.com/{budget_id}/...`
- `GEMINI_API_KEY` - Gemini API key for AI amount tagging
- `R2_WORKER_URL` - Your deployed worker URL (e.g. `https://receipts.yourdomain.com`)
- `R2_PASSWORD` - Same as AUTH_PASSWORD you set in worker secrets

### 2. Deploy Upload App

```bash
cd upload-app
npm install

# Create R2 bucket (one-time)
npx wrangler r2 bucket create receipts

# Deploy
npm run deploy
```

### 3. Configure Secrets

Set the required Cloudflare Worker secrets:

```bash
cd upload-app

# Set your chosen password for the web app
wrangler secret put AUTH_PASSWORD

# Set YNAB credentials (copy from .env)
wrangler secret put YNAB_API_KEY
wrangler secret put YNAB_BUDGET_ID

# Optional but recommended: enable AI amount tagging
wrangler secret put GEMINI_API_KEY
# Optional model override (defaults to gemini-3-flash-preview)
wrangler secret put GEMINI_MODEL
```

### 4. Custom Domain (Optional)

To use a custom domain, add to `wrangler.toml`:

```toml
routes = [
  { pattern = "receipts.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

Then add a DNS record in Cloudflare: `AAAA` record, name: `receipts`, content: `100::`, proxied.

### 5. Use

1. **Visit the web app**: Enter your password to authenticate
2. **Upload receipts**: Drag and drop or tap to upload
3. **View pending claims**: YNAB transactions with `TODO:` memos appear automatically
4. **Process claims**: Run `/claims` in Claude Code to match receipts to transactions

## Workflow

```
Mobile/Desktop                    YNAB
     │                              │
     │ Upload receipts              │ Mark with TODO:
     ▼                              ▼
┌─────────┐                   ┌──────────┐
│   R2    │◄──── /claims ────►│  YNAB    │
│ Storage │     (Claude)      │   API    │
└─────────┘                   └──────────┘
     │                              │
     │ Delete when done             │ Update to CLAIMED:
     ▼                              ▼
  Cleaned up                   Marked complete
```

## iOS Shortcut

Create an Apple Shortcut to upload receipts directly from the Share Sheet:

1. Open **Shortcuts** app → tap **+** to create new shortcut
2. Dismiss the action picker popup
3. Tap **ⓘ** at the bottom middle → enable **Show in Share Sheet** → under "Receive", select **Images**, **PDFs**, and **Files**
4. Tap **Done**, then add the **Get Contents of URL** action:
   - URL: `https://your-domain.com/upload` (your worker URL or custom domain)
   - Show More → Method: **POST**
   - Headers → Add new field:
      - Key: `X-Auth-Token`
      - Value: your password (same as AUTH_PASSWORD secret)
   - Request Body: **Form**
   - Add new field → choose **File** type:
      - Key: `file`
      - Value: tap and choose **Shortcut Input**
5. Add **Show Notification** action: `Receipt uploaded`
6. Rename shortcut to "Upload Receipt"

Now share any receipt image/PDF → choose **Upload Receipt** from the share sheet.
