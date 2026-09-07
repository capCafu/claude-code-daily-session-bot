# Claude Code Session Bot

Telegram bot to warm up Claude Code sessions and track session timing.

[blog post](https://dev.to/sleeyax/stop-wasting-hours-on-claude-code-pros-session-cooldown-4mak)

## Why?

Claude Code Pro's 5-hour session cooldown means hours of dead time between sessions. If you exhaust your session at 3pm, you can't use Claude Code again until 8pm. That's half a workday gone.

This bot starts sessions while you sleep. Schedule `/schedule tomorrow 9am` and the bot warms up at 6am — by 9am you still have 2 hours of usage left, enough for a productive morning. By 11am the session expires, the cooldown starts, and by the afternoon you have a fresh session ready to go.

## Commands

| Command                        | Description                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `/warmup [account]`            | Start a session now via `claude -p` (`all` warms every account)                  |
| `/session [account]`           | Show active session info (time remaining, tokens, expiry)                        |
| `/schedule <datetime> [hours]` | Schedule a warmup. At `<datetime>`, you'll have `[hours]` remaining (default: 2) |
| `/schedules`                   | List pending scheduled warmups                                                   |
| `/cancel <id>`                 | Cancel a scheduled warmup                                                        |
| `/daily <time[, time...]> [hours]` | Schedule daily warmups. At each `<time>`, you'll have `[hours]` remaining   |
| `/workday <start>-<end> [lead]` | Plan a day's warmups around your working hours (`[lead]` hours left at `<start>`, default: 2) |
| `/dailies`                     | List daily scheduled warmups                                                     |
| `/cancel_daily <id>`           | Cancel a daily scheduled warmup                                                  |
| `/history [account]`           | Show recent session history                                                      |
| `/accounts`                    | List configured accounts and their current windows                               |

<details>
<summary>Click to show screenshots</summary>

![telegram screenshot 1](./docs/images/2026-01-27_21-03.png)

![telegram screenshot 2](./docs/images/2026-01-27_21-02.png)

</details>

### Schedule examples

```
/schedule tomorrow 9am        # 2h remaining at 9am → warmup at 6am
/schedule monday 14:00 3      # 3h remaining at 14:00 → warmup at 12:00
/schedule jan 30 8:00 4h      # 4h remaining at 8:00 → warmup at 7:00
/daily 7:00 AM 5h             # warm up every day at 7:00am
/daily 9:00 AM 2h             # warm up every day at 6:00am
/daily 7:00, 13:00, 18:00 5h  # warm up three times a day
/workday 9am-6pm              # plan a 9-to-6 day (warmups at 06:00, 11:05, 16:10)
/workday 9:00-18:00 1.5h      # same day, 1.5h left on the clock at 9:00
```

The bot computes: `warmup_time = target - (5h - hours_remaining)`.

A daily schedule can hold several times of day, separated by commas. All of its
times share the same `[hours]` value, and the whole group is one ID — `/dailies`
lists it on a single line and `/cancel_daily <id>` cancels every time in it. The
bot always arms a timer for the soonest upcoming time, then re-arms for the next
one after each warmup.

### Working hours

`/workday` plans a whole day for you instead of making you pick times by hand:

```
/workday 9am-6pm
→ Warmups: 06:00, 11:05, 16:10 (3 per day)
```

It works backwards from two facts about the 5-hour window. First, a window
opened by a `"ready"` prompt has essentially untouched quota, so the best state
to start work in is a window that is *already running* with a couple of hours
left — you spend that quota on your first stretch of work, and the next reset
lands inside your day rather than after it. `[lead]` is how much of that window
is left when you clock in (default 2h), so the first warmup goes at
`start - (5h - lead)`.

Second, each later warmup has to land *just past* the previous window's expiry.
A warmup fired exactly on the boundary lands inside the window that is still
live — it opens nothing and is silently wasted — so `/workday` adds a 5-minute
handover margin and keeps chaining until another window would start after your
day ends.

For a 9-to-6 day that yields three separate quota allowances covering 8.8 of
your 9 working hours, versus two if you simply warm up at 9:00. Ranges can be
written `9am-6pm`, `9:00-18:00`, `9-18`, `9-6`, or `9am to 6pm`; overnight
shifts (`21:00-06:00`) work too.

## Multiple accounts

One bot can drive several Claude accounts. Set `CLAUDE_ACCOUNTS` to a
comma-separated list of names — the first is the primary:

```
CLAUDE_ACCOUNTS=work,personal
CLAUDE_ACCOUNTS_DIR=/data/accounts
```

Each account is isolated by its own `CLAUDE_CONFIG_DIR`, which the bot passes to
the `claude` child process. Log each one in once, on the host:

```bash
CLAUDE_CONFIG_DIR="$PWD/data/accounts/work" claude auth login
CLAUDE_CONFIG_DIR="$PWD/data/accounts/personal" claude auth login
```

`data/` is already mounted at `/data` in the container, so no extra mount is
needed. Credentials refresh themselves in place, and each account keeps its own
session transcripts.

Commands then take an optional trailing account name. Listings cover every
account; commands that act default to the primary:

```
/warmup                       # primary account
/warmup personal              # that account
/warmup all                   # every account
/session                      # every account's window
/daily 7:00, 13:00 5h work    # schedule for one account
/accounts                     # names, config dirs, current windows
```

`/workday` is the exception: with no account named it plans **every** account and
staggers them, offsetting each by an even fraction of a session so their windows
do not all reset together:

```
/workday 9am-6pm
→ work:     06:00, 11:05, 16:10
  personal: 08:30, 13:35
```

Read as a single timeline, a fresh window now arrives at 06:00, 08:30, 11:05,
13:35 and 16:10 — every ~2.5 hours instead of every 5, with two live windows at
any moment. Name an account (`/workday 9am-6pm work`) to plan just that one.

Leaving `CLAUDE_ACCOUNTS` unset runs a single account exactly as before, with no
account labels in any output. Existing rows are attributed to the primary
account when the database is migrated.

## How it works

1. **Warmup**: Runs `claude -p "ready" --output-format json` which sends a minimal prompt to Claude, starting the 5-hour session timer. The JSON response includes `session_id` and token usage.
2. **Session tracking**: Each warmup is recorded in a local SQLite database with start time, expiry (start + 5h), and token usage.
3. **Scheduling**: One-time and daily schedules are persisted in SQLite and restored on bot restart using `setTimeout`.
4. **Auth**: Only Telegram user IDs listed in `TELEGRAM_ALLOWED_USER_IDS` can use the bot.

### Limitations

Session tracking is **self-managed** — the bot records when it starts a session and computes time remaining locally. There is no Anthropic API to query session status, and we intentionally avoid reverse-engineering internal endpoints to prevent account bans.

This means:

- Sessions started outside the bot (e.g. from your dev machine) are **not tracked**. The bot only knows about sessions it started itself.
- If you start a session manually and then ask the bot, it may show "no active session" or stale data.
- The bot is designed to be the **sole session starter** — use it from a dedicated VPS for best results.

## Setup

### Prerequisites

- **Claude Code CLI** must be installed and authenticated on the host machine (or inside the Docker container).

### Installation

```bash
# edit .env with your values
cp .env.example .env
pnpm install
pnpm build
pnpm start
```

### Environment variables

| Variable                    | Description                                         |
| --------------------------- | --------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`        | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs                   |
| `TIMEZONE`                  | Display timezone (default: `UTC`)                   |
| `DB_PATH`                   | SQLite database path (default: `data/bot.db`)       |

## Docker

First copy your local Claude CLI auth files into the ignored `data/` directory:

```bash
mkdir -p data/claude-home
cp -a ~/.claude data/claude-home/.claude
cp ~/.claude.json data/claude-home/.claude.json
```

Then start the container:

```bash
docker compose up -d --build
```

Do not commit `data/claude-home` or `.env`; they contain local credentials and are ignored by git.
