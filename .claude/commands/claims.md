# Claim Processing Workflow

Process expense claims by matching YNAB transactions with uploaded receipts.

## Instructions

You are helping the user process expense claims. Follow this workflow:

### 1. Load Configuration

Use the Read tool to read `.env` in the project root. Extract these values:
- `YNAB_API_KEY` - API key for YNAB
- `YNAB_BUDGET_ID` - Budget ID to query
- `R2_WORKER_URL` - URL of the receipt upload worker

If `.env` is missing or incomplete, ask the user to set it up using `.env.example` as a template.

**Important**: When using these values in curl commands, substitute them directly into the command (don't rely on shell variable expansion from `source .env` as it doesn't handle comments well).

### 2. Fetch YNAB Transactions

Use curl to fetch transactions marked with "TODO" in the memo:

```bash
curl -s -H "Authorization: Bearer <YNAB_API_KEY>" \
  "https://api.ynab.com/v1/budgets/<YNAB_BUDGET_ID>/transactions" \
  | jq '[.data.transactions[] | select(.memo) | select(.memo | ascii_downcase | contains("todo"))]'
```

Note: Filter for `amount < 0` (outflows) to avoid duplicate transfer entries.

Parse the response to extract:
- `id` - Transaction ID (for updating later)
- `date` - Transaction date
- `amount` - Amount in milliunits (divide by 1000 for actual amount)
- `payee_name` - Merchant/payee
- `memo` - Contains "TODO: description"
- `category_name` - Category

### 3. Fetch Pending Receipts

List receipts from R2:

```bash
curl -s "<R2_WORKER_URL>/list" | jq '.receipts'
```

### 4. Match Analysis

Compare TODOs against uploaded receipts and show a summary:

**Matching criteria:**
- Date proximity (within 3 days)
- Amount match (exact or within 10%)

**Present the overview:**
```
=== CLAIMS OVERVIEW ===

✅ READY TO PROCESS (X items) - have matching receipts:
   - [date] [description] $[amount]
   ...

❌ MISSING RECEIPTS (Y items) - need to find:
   - 3x Cold Storage (~$40-60 each, Oct-Nov)
   - 2x Grab rides (~$30-40, Nov)
   - 1x GitHub ($133, Nov 4)
   ...

📎 UNMATCHED RECEIPTS (Z items) - uploaded but no matching TODO:
   - [filename] [date]
   ...
```

**Ask the user:**
1. Process ready items now?
2. Or pause to find missing receipts first?

### 5. Group Similar Items

For items ready to process, identify groups:
- Same merchant (e.g., multiple Cold Storage trips)
- Same category
- Same date range

Ask if they want to process grouped items together or individually.

### 6. Process Each Claim

For each TODO transaction:

1. **Show transaction details**:
   - Date: [date]
   - Payee: [payee_name]
   - Amount: [amount / 1000] (with currency)
   - Description: [memo without "TODO:" prefix]
   - Category: [category_name]

2. **Find matching receipt(s)** by:
   - Date proximity (within 3 days)
   - Amount match (exact or close)
   - Show top matches and let user confirm

3. **Display the receipt** using the Read tool:
   ```
   Download: curl -s "<R2_WORKER_URL>/receipt/[key]" -o /tmp/receipt_[key]
   Then use Read tool to view the image
   ```

4. **Extract from receipt**:
   - Merchant name
   - Date
   - Total amount
   - Tax breakdown (GST/VAT if visible)
   - Any other relevant details

5. **Present formatted claim summary**:
   ```
   === CLAIM SUMMARY ===
   Date: [date]
   Merchant: [merchant]
   Description: [description from memo]
   Amount: [amount]
   Tax: [tax amount if found, or "included" / "not shown"]
   Receipt: [filename]
   ```

6. **Wait for user confirmation**. When confirmed:
   - Update YNAB memo from "TODO: X" to "CLAIMED: X":
     ```bash
     curl -s -X PUT -H "Authorization: Bearer <YNAB_API_KEY>" \
       -H "Content-Type: application/json" \
       -d '{"transaction": {"memo": "CLAIMED: [description]"}}' \
       "https://api.ynab.com/v1/budgets/<YNAB_BUDGET_ID>/transactions/<TRANSACTION_ID>"
     ```
   - Delete receipt from R2:
     ```bash
     curl -s -X DELETE "<R2_WORKER_URL>/receipt/[key]"
     ```

7. Move to the next claim.

### 7. Handle Edge Cases

- **No matching receipt**: Flag for manual review, ask user if they want to skip or mark without receipt
- **Multiple matches**: Show all options and let user pick
- **Unmatched receipts**: At the end, list any receipts that weren't matched to transactions

### 8. Summary

When all claims are processed, show:
- Number of claims processed
- Any skipped items
- Any orphaned receipts remaining

---

## Quick Reference

**YNAB API**: https://api.ynab.com/v1/
**Transaction amounts**: In milliunits (divide by 1000)
**Negative amounts**: Outflows (expenses)
**Positive amounts**: Inflows

**Receipt filename format**: `YYYY-MM-DD_HHMMSS_originalname.ext`
