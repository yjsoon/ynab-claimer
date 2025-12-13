# Claim Manager

Expense claim management system using YNAB + Cloudflare R2.

## Project Structure

- `upload-app/` - Cloudflare Worker + static site for receipt uploads
- `.claude/commands/claims.md` - Skill for processing claims interactively
- `.env` - Configuration (YNAB API key, budget ID, worker URL)

## Key Commands

- `/claims` - Start interactive claim processing

## Configuration

Required in `.env`:
- `YNAB_API_KEY` - From https://app.ynab.com/settings/developer
- `YNAB_BUDGET_ID` - From YNAB URL when viewing budget
- `R2_WORKER_URL` - Deployed worker URL

## YNAB Memo Convention

- `TODO: description` - Pending claim
- `CLAIMED: description` - Processed claim
