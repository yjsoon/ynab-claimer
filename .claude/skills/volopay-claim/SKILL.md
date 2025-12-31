# Volopay Claim Form Automation

Automate filling out expense claims on Volopay using browser automation.

## Prerequisites

- Claude in Chrome extension connected
- Logged into tinkertanker.volopay.co
- Receipt file downloaded locally (e.g., in /tmp/claims/)

## Instructions

You are automating the Volopay claim submission form. Use browser automation tools (mcp__claude-in-chrome__*).

### 1. Navigate to Claims

```
Navigate to: https://tinkertanker.volopay.co/my-volopay/reimbursement/claims?createReimbursement=true
```

Or from dashboard, click "Request claim" in Quick Access.

### 2. Fill Claim Form

The form has these fields:

**Basic Details:**
| Field | How to fill |
|-------|-------------|
| Claim type | "Out of pocket" (default, leave as is) |
| Merchant | Type merchant name in combobox |
| Amount | Enter number (e.g., 99.98) |
| Currency | SGD (default) or select other |
| Volopay category | Select "Software" for subscriptions, or appropriate category |
| Transaction date | Click date picker, select date |
| Link claim to | Department (default) |

**Receipt:**
- User must manually drag/drop or browse to upload receipt file
- Cannot be automated due to browser security

**Memo:**
- Click "No memo added" to reveal textbox
- Type description (e.g., "Padlet Platinum Annual subscription")

**Accounting (Xero fields):**

| Field | Selection Logic |
|-------|-----------------|
| Xero category | Software subscriptions → "Computer Software (463)" |
| Xero tax codes | See tax code rules below |
| Xero Job Code | Leave empty unless specified |
| Xero Biz Unit | Always "Classes" |

### 3. Tax Code Rules

| Condition | Tax Code |
|-----------|----------|
| Receipt shows GST/tax | INPUTY24:Standard-Rated Purchases |
| No GST + Foreign currency (USD, etc.) | OPINPUT:Out Of Scope Purchases |
| No GST + SGD | NRINPUT:Purchases from Non-GST Registered Suppliers |

**Decision flow:**
1. Does receipt show GST? → **Standard-Rated**
2. No GST - what currency?
   - USD/foreign → **Out of Scope** (overseas vendor)
   - SGD → **Non-GST Registered** (SG vendor not registered for GST)

### 4. Xero Category Mapping

| Expense Type | Xero Category |
|--------------|---------------|
| Software/SaaS subscriptions | Computer Software (463) |
| Hardware, gadgets | Computer Hardware & Accessories (464) |
| Books, learning materials | Books, Magazines, Journals (460) |
| Marketing, ads | Advertising, Marketing (400) |
| Meals, entertainment | (check available options) |
| Travel, transport | (check available options) |

### 5. Submit

1. Click "Continue" button
2. Review summary on next page
3. Confirm submission

### 6. Form Field References (for automation)

These element patterns are typical but may change:

```
Merchant: combobox near "Merchant" label
Amount: textbox type="number" near "Amount" label
Date: button containing "Transaction date"
Memo: textbox after clicking "No memo added"
Xero category: combobox near "Xero category" label
Xero tax codes: combobox near "Xero tax codes" label
Xero Biz Unit: combobox near "Xero Biz Unit" label
Continue: button type="submit" with "Continue"
```

### 7. Automation Tips

1. **Use read_page** to get current element refs before interacting
2. **Type to search** in comboboxes - they filter as you type
3. **Wait briefly** after typing in comboboxes for options to appear
4. **Click option elements** when dropdown shows matches
5. **Screenshot** to verify form state if unsure
6. **form_input** tool works for setting text values directly

### 8. Example Claim Data

```yaml
merchant: "Padlet"
amount: 99.98
currency: "SGD"
date: "2025-12-25"
volopay_category: "Software"
memo: "Padlet Platinum Annual subscription"
xero_category: "Computer Software (463)"
xero_tax_code: "INPUTY24:Standard-Rated Purchases"  # Has GST
xero_biz_unit: "Classes"
receipt_path: "/tmp/claims/padlet-25dec-99.98.png"
```

### 9. Known Limitations

- **Receipt upload**: Cannot be automated; user must manually upload
- **Extension conflicts**: Occasional "Cannot access chrome-extension://" errors; retry or ask user to interact manually
- **Dropdown selection**: Sometimes need to click option after typing; use read_page to find option refs

---

## Integration with Claims Skill

This skill works with the main `/claims` skill:

1. `/claims` fetches YNAB TODOs and R2 receipts
2. `/claims` identifies and matches receipts to transactions
3. This skill automates filling the Volopay form for each claim
4. After submission, `/claims` updates YNAB memo and deletes R2 receipt

## Quick Reference

**URL**: https://tinkertanker.volopay.co/my-volopay/reimbursement/claims?createReimbursement=true

**Required fields**: Merchant, Amount, Date, Receipt, Xero category, Xero tax codes, Xero Biz Unit

**Biz Unit**: Always "Classes"
