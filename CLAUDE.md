# Agent Instructions

Guidelines for AI agents working on this codebase.

## Sensitive Data

**DO NOT commit or expose:**
- Actual Cloudflare Worker URLs (use `https://receipts.yourdomain.com` as placeholder)
- YNAB API keys or budget IDs
- Any values from `.env`

The `.env` file contains secrets. When writing documentation or examples, always use placeholders.

## Project Structure

- `upload-app/` - Cloudflare Worker for receipt uploads
- `.claude/skills/claims/SKILL.md` - Claude Code skill for processing claims
- `.env` - Local config (gitignored)
- `.env.example` - Template with placeholders (safe to commit)

## Claims Processing

The claims skill at `.claude/skills/claims/SKILL.md` handles matching YNAB transactions with uploaded receipts.

### API Authentication

All receipt worker endpoints require the `X-Auth-Token` header:

```bash
curl -H "X-Auth-Token: $R2_PASSWORD" "https://receipts.yourdomain.com/list"
```

The password is stored in `.env` as `R2_PASSWORD` and must match the worker's `AUTH_PASSWORD` secret.

### Common Pitfalls

1. **Auth header name**: Use `X-Auth-Token`, not `Authorization` or `X-Auth-Password`
2. **Worker URL**: Read from `.env` - don't hardcode; user may have custom domain
3. **YNAB amounts**: In milliunits - divide by 1000 for actual dollars
4. **Transfer duplicates**: Filter for `amount < 0` to avoid counting transfers twice
