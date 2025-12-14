# Claim Manager

Expense claim management system with YNAB integration and Cloudflare R2 storage.

## Features

- **Receipt Upload**: Drag-and-drop web interface for uploading receipts
- **YNAB Integration**: View pending claims (transactions marked with `TODO:`) directly in the web app
- **Password Protection**: Simple auth gate for the web app and API
- **iOS Shortcut**: Upload receipts directly from the Share Sheet
- **Claude Code Skill**: Interactive claim processing via `/claims` command

## Components

### 1. Receipt Upload App (`upload-app/`)

Web app for uploading receipts and viewing pending YNAB claims.

**Stack**: Cloudflare Workers + R2

**Endpoints**:
- `POST /upload` - Upload receipt file
- `GET /list` - List pending receipts
- `GET /ynab/todos` - Fetch pending claims from YNAB
- `GET /receipt/:key` - Download receipt
- `DELETE /receipt/:key` - Delete receipt

All endpoints require `X-Auth-Token` header.

### 2. Claude Code Skill (`/claims`)

Interactive claim processing workflow run via Claude Code.

## Setup

### Prerequisites

- Cloudflare account (free tier)
- YNAB account with API access
- Node.js 18+

### 1. Configure Environment

```bash
cp .env.example .env
# Edit .env with your YNAB API key and budget ID
```

Get your YNAB API key from: https://app.ynab.com/settings/developer

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
