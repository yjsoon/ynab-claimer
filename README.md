# Claim Manager

Two-component system for managing expense claims with YNAB integration.

## Components

### 1. Receipt Upload App (`upload-app/`)

Simple web app for uploading receipts to Cloudflare R2 storage.

**Stack**: Cloudflare Pages + Workers + R2

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

Update `R2_WORKER_URL` in `.env` with your deployed worker URL.

### 3. Use

1. **Upload receipts**: Visit your deployed upload app URL and upload receipt images/PDFs
2. **Mark transactions**: In YNAB, add "TODO: description" to transaction memos you want to claim
3. **Process claims**: In this directory, run `/claims` in Claude Code

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

## iOS Shortcut (Optional)

Create an Apple Shortcut to upload receipts directly from the Share Sheet:

1. Open **Shortcuts** app → tap **+** to create new shortcut
2. Dismiss the action picker popup
3. Tap **ⓘ** at the bottom middle → enable **Show in Share Sheet** → under "Receive", select **Images**, **PDFs**, and **Files**
4. Tap **Done**, then add the **Get Contents of URL** action:
   - URL: `https://your-worker-url.workers.dev/upload`
   - Show More → Method: **POST**
   - Request Body: **Form**
   - Tap **Add new field** → choose **File** type first
   - Key (left field): `file`
   - Value: tap and choose **Shortcut Input** from the popup
5. Add **Show Notification** action: `Receipt uploaded`
6. Rename shortcut to "Upload Receipt"

Now share any receipt image/PDF → choose **Upload Receipt** from the share sheet.
