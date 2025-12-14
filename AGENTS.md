# Agent Instructions

Guidelines for AI agents working on this codebase.

## Sensitive Data

**DO NOT commit or expose:**
- Actual Cloudflare Worker URLs (use `https://your-worker-url.workers.dev` as placeholder)
- YNAB API keys or budget IDs
- Any values from `.env`

The `.env` file contains secrets. When writing documentation or examples, always use placeholders.

## Project Structure

- `upload-app/` - Cloudflare Worker for receipt uploads
- `.claude/commands/claims.md` - Claude Code skill for processing claims
- `.env` - Local config (gitignored)
- `.env.example` - Template with placeholders (safe to commit)
