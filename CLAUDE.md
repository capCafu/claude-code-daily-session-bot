# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Telegram bot that manages Claude Code Pro 5-hour session cooldowns. Schedules automated warmups via `claude` CLI so you have remaining usage at a target time.

## Commands

```bash
pnpm dev            # run with tsx --watch (hot reload)
pnpm build          # tsc → dist/
pnpm start          # run compiled dist/main.js
pnpm test           # run Vitest tests
docker compose up -d --build  # production deploy
```

Tests use Vitest and live alongside source files as `src/**/*.test.ts`.

## Architecture

TypeScript (ES2022/CommonJS, strict), SQLite via better-sqlite3 (WAL mode), Telegram API via node-telegram-bot-api.

All source files are located in `src/`:

- **main.ts** — entry point; inits DB, bot, restores pending and daily schedules
- **bot.ts** — Telegram command handlers (`/warmup`, `/schedule`, `/daily`, `/workday`, `/session`, `/cancel`, `/cancel_daily`, `/history`, `/schedules`, `/dailies`, `/accounts`)
- **warmup.ts** — spawns `claude -p "ready" --output-format json` subprocess; parses token usage and Claude API error payloads
- **scheduler.ts** — in-memory `setTimeout` timers + DB persistence; restores one-time and daily timers on restart
- **db.ts** — SQLite CRUD for `sessions`, `schedules`, and `daily_schedules` tables
- **config.ts** — env var validation (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, optional `TIMEZONE`, `DB_PATH`, `CLAUDE_ACCOUNTS`, `CLAUDE_ACCOUNTS_DIR`); `parseAccounts()` builds the account roster
- **types.ts** — interfaces: `Session`, `Schedule`, `WarmupResult`

See [README.md](README.md) for full usage details.

## Key Details

- Session duration fixed at 5 hours (`SESSION_DURATION_MS`)
- Only tracks sessions the bot starts (no external session tracking)
- Auth: only Telegram user IDs in `TELEGRAM_ALLOWED_USER_IDS` can use commands
- Date parsing via chrono-node (natural language: "tomorrow 9am", "jan 30 8:00")
- Daily schedules reschedule themselves after each warmup
- A daily schedule holds one or more times of day in `daily_schedules.times_of_day` (comma-separated, e.g. `"7:00 AM, 1:00 PM"`); `target_datetime`/`warmup_at` always track the soonest upcoming one, re-armed after each fire
- `db.ts` migrates the pre-multi-time column (`time_of_day` → `times_of_day`) in place on startup
- `/workday <start>-<end> [lead]` is sugar over `/daily`: `planWorkday()` in scheduler.ts chains 5-hour windows across the working day (first warmup at `start - (5h - lead)` so `lead` hours remain when work begins, then each next warmup at `previous + 5h + 5min` handover margin), and stores the result as one multi-time daily schedule with `hours_remaining = 5`
- The handover margin matters: a warmup fired exactly on a window boundary lands inside the still-live window and opens nothing
- Requires `claude` CLI installed and authenticated on host; Docker mounts ignored Claude credentials from `data/claude-home`

## Accounts

- One bot can drive several Claude accounts. `CLAUDE_ACCOUNTS=work,personal` (first entry is primary); unset means a single implicit account named `default` whose `configDir` is undefined, so the `claude` child inherits the ambient environment and behaviour is unchanged
- Accounts are isolated by `CLAUDE_CONFIG_DIR`, passed per spawn in warmup.ts — not by swapping global credentials
- `sessions`, `schedules` and `daily_schedules` all carry an `account` column; `migrateAccounts()` in db.ts adds it to pre-account tables, backfilling the primary account name
- Commands take an optional trailing account name, stripped by `parseAccountToken()`; `all` addresses every account. Reporting commands default to every account, acting commands to the primary
- `/workday` with no account named plans **every** account via `planStaggeredWorkday()`, offsetting account *i* by `i * (5h / n)` so windows do not reset together; naming an account plans only that one
- Account names are validated in config.ts: `all` is reserved, and hours-like names (`5h`, `2`) are rejected because they would collide with the `[hours]` argument
