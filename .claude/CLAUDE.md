# Claim Manager

Expense claim management system using YNAB + Cloudflare R2.

## Project Structure

- `upload-app/` - Cloudflare Worker + static site for receipt uploads
- `scripts/` - Volopay Playwright automation
- `.claude/skills/claims/SKILL.md` - Skill for processing claims (auto-invoked)
- `.env` - Configuration (YNAB API key, budget ID, worker URL)

## Usage

Say "help me with claims" or "process expenses" - the claims skill auto-invokes.

## Volopay Automation

```bash
cd scripts
npm run submit -- claim.json
```

The Playwright script fills the Volopay form and pauses for review before submit.

## Configuration

Required in `.env`:
- `YNAB_API_KEY` - From https://app.ynab.com/settings/developer
- `YNAB_BUDGET_ID` - From YNAB URL when viewing budget
- `R2_WORKER_URL` - Deployed worker URL
- `R2_PASSWORD` - Auth token for R2 worker

## YNAB Memo Convention

- `TODO: description` - Pending claim
- `CLAIMED: description` - Processed claim

## Tax Code Rules (CRITICAL)

**Only use INPUTY24 if receipt shows explicit GST line item. Never assume GST.**

| Condition | Tax Code |
|-----------|----------|
| Receipt shows GST amount | INPUTY24:Standard-Rated Purchases |
| No GST + Foreign currency | OPINPUT:Out Of Scope Purchases |
| No GST + SGD | NRINPUT:Purchases from Non-GST Registered Suppliers |

## Category Mappings

**Volopay**: Software, Equipment & hardware, Entertainment

**Xero**:
- Software → Computer Software (463)
- IMDA VIBE / "for class" → Cost of Sales (320)
- Hardware → Computer Hardware & Accessories (464)
