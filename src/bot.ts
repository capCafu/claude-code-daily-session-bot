import TelegramBot from "node-telegram-bot-api";
import * as chrono from "chrono-node";
import {
  ACCOUNTS,
  ACCOUNT_NAMES,
  ALLOWED_USER_IDS,
  ALL_ACCOUNTS_TOKEN,
  IS_MULTI_ACCOUNT,
  PRIMARY_ACCOUNT,
  TIMEZONE,
  findAccount,
} from "./config";
import type { Account } from "./config";
import {
  getActiveSession,
  getActiveSessions,
  getSessionHistory,
  getPendingSchedules,
  getDailySchedules,
} from "./db";
import { warmup } from "./warmup";
import {
  addDailySchedule,
  addSchedule,
  addWorkdaySchedules,
  cancelDailySchedule,
  cancelSchedule,
  parseTimesOfDay,
} from "./scheduler";

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function isAllowed(msg: TelegramBot.Message): boolean {
  return !!msg.from && ALLOWED_USER_IDS.includes(msg.from.id);
}

/** Output stays identical to a single-account setup when only one is configured. */
function accountTag(name: string): string {
  return IS_MULTI_ACCOUNT ? `[${name}] ` : "";
}

function unknownAccount(name: string): string {
  return `Unknown account \`${name}\`. Configured: ${ACCOUNT_NAMES.join(", ")}${
    IS_MULTI_ACCOUNT ? `, or \`${ALL_ACCOUNTS_TOKEN}\`` : ""
  }.`;
}

/**
 * Resolves the account selector that trails a command. `all` means every
 * account; omitting it falls back to `fallback` — the primary account for
 * commands that act, every account for commands that only report.
 */
export function resolveAccounts(
  selector: string | undefined,
  fallback: Account[]
): Account[] | string {
  if (!selector) return fallback;
  if (selector.toLowerCase() === ALL_ACCOUNTS_TOKEN) return ACCOUNTS;
  const account = findAccount(selector);
  return account ? [account] : unknownAccount(selector);
}

/**
 * Splits a trailing account name off a longer argument, so `9am-6pm work` and
 * `7:00, 13:00 5h personal` both work. Only strips it when something else
 * remains, which keeps a lone argument intact.
 */
export function parseAccountToken(
  input: string,
  accountNames: string[] = ACCOUNT_NAMES
): { rest: string; selector?: string } {
  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) return { rest: input.trim() };

  const last = parts[parts.length - 1].toLowerCase();
  if (last === ALL_ACCOUNTS_TOKEN || accountNames.includes(last)) {
    return { rest: parts.slice(0, -1).join(" "), selector: last };
  }
  return { rest: input.trim() };
}

export function parseScheduleInput(input: string): { dateStr: string; hours: number } {
  const parts = input.split(/\s+/);
  let hours = 2;
  let dateStr = input;
  const hoursMatch = parts[parts.length - 1].match(/^(\d+(?:\.\d+)?)h?$/);
  if (hoursMatch && parts.length > 1) {
    const val = parseFloat(hoursMatch[1]);
    if (val >= 0.5 && val <= 5) {
      hours = val;
      dateStr = parts.slice(0, -1).join(" ");
    }
  }
  return { dateStr, hours };
}

export function createBot(token: string): TelegramBot {
  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/(help|start)/, (msg) => {
    if (!isAllowed(msg)) return;
    const text = [
      `*Claude Code Session Bot*`,
      ``,
      `\`/warmup\` \`[account]\` — Start a session now`,
      `\`/session\` \`[account]\` — Show active session info`,
      `\`/schedule\` \`<datetime>\` \`[hours]\` — Schedule a warmup`,
      `\`/schedules\` — List pending schedules`,
      `\`/daily\` \`<time[, time...]>\` \`[hours]\` — Schedule daily warmups`,
      `\`/workday\` \`<start>-<end>\` \`[lead]\` — Plan warmups around your working hours`,
      `\`/dailies\` — List daily schedules`,
      `\`/cancel_daily\` \`<id>\` — Cancel a daily schedule`,
      `\`/cancel\` \`<id>\` — Cancel a schedule`,
      `\`/history\` \`[account]\` — Recent session history`,
      ...(IS_MULTI_ACCOUNT ? [`\`/accounts\` — List configured accounts`] : []),
      `\`/help\` — Show this message`,
      ``,
      `*Schedule examples*`,
      `/schedule tomorrow 9am`,
      `/schedule monday 14:00 3h`,
      `/schedule jan 30 8:00 4h`,
      `/daily 7:29 AM 5h`,
      `/daily 7:00, 13:00, 18:00 5h`,
      `/workday 9am-6pm`,
      ...(IS_MULTI_ACCOUNT
        ? [
            ``,
            `*Accounts*`,
            `Commands take an optional account name (\`${ACCOUNT_NAMES.join("`, `")}\`).`,
            `\`/warmup ${ACCOUNT_NAMES[1] ?? ALL_ACCOUNTS_TOKEN}\`, \`/warmup ${ALL_ACCOUNTS_TOKEN}\`, \`/workday 9am-6pm ${ACCOUNT_NAMES[0]}\``,
            `\`/workday\` with no account staggers every account.`,
          ]
        : []),
    ];
    bot.sendMessage(msg.chat.id, text.join("\n"), { parse_mode: "Markdown" });
  });

  bot.onText(/\/session(?:\s+(\S+))?/, (msg, match) => {
    if (!isAllowed(msg)) return;
    const targets = resolveAccounts(match?.[1], ACCOUNTS);
    if (typeof targets === "string") {
      bot.sendMessage(msg.chat.id, targets, { parse_mode: "Markdown" });
      return;
    }

    const sessions = getActiveSessions(targets.map((a) => a.name));
    if (sessions.length === 0) {
      const scope = targets.length === 1 ? ` for ${targets[0].name}` : "";
      bot.sendMessage(msg.chat.id, `No active session${scope}.`);
      return;
    }

    const blocks = sessions.map((session) => {
      const remaining = new Date(session.expires_at).getTime() - Date.now();
      return [
        `*Active Session*${IS_MULTI_ACCOUNT ? ` — ${session.account}` : ""}`,
        `Session: \`${session.session_id}\``,
        `Started: ${fmt.format(new Date(session.started_at))}`,
        `Expires: ${fmt.format(new Date(session.expires_at))}`,
        `Remaining: *${fmtDuration(remaining)}*`,
        ``,
        `*Tokens*`,
        `Input: ${session.input_tokens.toLocaleString()}`,
        `Output: ${session.output_tokens.toLocaleString()}`,
        `Cache create: ${session.cache_creation_tokens.toLocaleString()}`,
        `Cache read: ${session.cache_read_tokens.toLocaleString()}`,
      ].join("\n");
    });

    const missing = targets.filter((a) => !sessions.some((s) => s.account === a.name));
    if (missing.length > 0 && IS_MULTI_ACCOUNT) {
      blocks.push(`No active session: ${missing.map((a) => a.name).join(", ")}`);
    }

    bot.sendMessage(msg.chat.id, blocks.join("\n\n"), { parse_mode: "Markdown" });
  });

  bot.onText(/\/accounts/, (msg) => {
    if (!isAllowed(msg)) return;
    const lines = [`*Accounts*`];
    for (const account of ACCOUNTS) {
      const session = getActiveSession(account.name);
      const state = session
        ? `${fmtDuration(new Date(session.expires_at).getTime() - Date.now())} left`
        : "no active session";
      const primary = account.name === PRIMARY_ACCOUNT.name ? " (primary)" : "";
      lines.push(`*${account.name}*${primary} — ${state}`);
      lines.push(`  config: \`${account.configDir ?? "ambient environment"}\``);
    }
    bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.onText(/\/warmup(?:\s+(\S+))?/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const targets = resolveAccounts(match?.[1], [PRIMARY_ACCOUNT]);
    if (typeof targets === "string") {
      bot.sendMessage(msg.chat.id, targets, { parse_mode: "Markdown" });
      return;
    }

    bot.sendMessage(
      msg.chat.id,
      targets.length > 1
        ? `Warming up ${targets.length} accounts: ${targets.map((a) => a.name).join(", ")}...`
        : `Warming up${IS_MULTI_ACCOUNT ? ` ${targets[0].name}` : ""}...`
    );

    for (const account of targets) {
      const { result, session } = await warmup(account);
      const tag = accountTag(account.name);
      if (!result.success) {
        bot.sendMessage(msg.chat.id, `${tag}Warmup failed: ${result.error}`);
        continue;
      }
      const remaining = session
        ? fmtDuration(new Date(session.expires_at).getTime() - Date.now())
        : "5h 0m";
      bot.sendMessage(
        msg.chat.id,
        `${tag}Session started! *${remaining}* remaining.\nTokens used: ${result.usage?.input_tokens ?? 0} in / ${result.usage?.output_tokens ?? 0} out`,
        { parse_mode: "Markdown" }
      );
    }
  });

  bot.onText(/\/schedule (.+)/, (msg, match) => {
    if (!isAllowed(msg)) return;
    const { rest, selector } = parseAccountToken(match![1].trim());
    const targets = resolveAccounts(selector, [PRIMARY_ACCOUNT]);
    if (typeof targets === "string") {
      bot.sendMessage(msg.chat.id, targets, { parse_mode: "Markdown" });
      return;
    }
    const account = targets[0].name;
    const { dateStr, hours } = parseScheduleInput(rest);

    const targetDate = chrono.parseDate(dateStr, { instant: new Date(), timezone: TIMEZONE }, { forwardDate: true });
    if (!targetDate) {
      bot.sendMessage(msg.chat.id, "Could not parse datetime. Try: `tomorrow 9am`, `monday 14:00`, `jan 30 8:00`", { parse_mode: "Markdown" });
      return;
    }

    const result = addSchedule(targetDate, hours, account);
    if (typeof result === "string") {
      bot.sendMessage(msg.chat.id, result);
      return;
    }

    const lines = [
      `${accountTag(account)}Schedule created (ID: ${result.id})`,
      `Target: ${fmt.format(targetDate)} with *${hours}h* remaining`,
      `Warmup at: *${fmt.format(new Date(result.warmup_at))}*`,
    ];
    bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.onText(/\/schedules/, (msg) => {
    if (!isAllowed(msg)) return;
    const pending = getPendingSchedules();
    if (pending.length === 0) {
      bot.sendMessage(msg.chat.id, "No pending schedules.");
      return;
    }
    const lines = pending.map(
      (s) =>
        `${accountTag(s.account)}ID ${s.id}: warmup at ${fmt.format(new Date(s.warmup_at))} (target: ${fmt.format(new Date(s.target_datetime))}, ${s.hours_remaining}h remaining)`
    );
    bot.sendMessage(msg.chat.id, lines.join("\n"));
  });

  bot.onText(/\/daily (.+)/, (msg, match) => {
    if (!isAllowed(msg)) return;
    const { rest, selector } = parseAccountToken(match![1].trim());
    const targets = resolveAccounts(selector, [PRIMARY_ACCOUNT]);
    if (typeof targets === "string") {
      bot.sendMessage(msg.chat.id, targets, { parse_mode: "Markdown" });
      return;
    }
    const account = targets[0].name;
    const { dateStr, hours } = parseScheduleInput(rest);

    const result = addDailySchedule(dateStr, hours, account);
    if (typeof result === "string") {
      bot.sendMessage(msg.chat.id, result, { parse_mode: "Markdown" });
      return;
    }

    const perDay = parseTimesOfDay(result.times_of_day).length;
    const lines = [
      `${accountTag(account)}Daily schedule created (ID: ${result.id})`,
      `Target: every day at *${result.times_of_day}* with *${hours}h* remaining`,
      ...(perDay > 1 ? [`${perDay} warmups per day`] : []),
      `Next warmup at: *${fmt.format(new Date(result.warmup_at))}*`,
    ];
    bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.onText(/\/workday (.+)/, (msg, match) => {
    if (!isAllowed(msg)) return;
    const { rest, selector } = parseAccountToken(match![1].trim());
    // With no account given, every account is planned and staggered.
    const targets = resolveAccounts(selector, ACCOUNTS);
    if (typeof targets === "string") {
      bot.sendMessage(msg.chat.id, targets, { parse_mode: "Markdown" });
      return;
    }
    const { dateStr, hours } = parseScheduleInput(rest);

    const result = addWorkdaySchedules(
      dateStr,
      hours,
      targets.map((a) => a.name)
    );
    if (typeof result === "string") {
      bot.sendMessage(msg.chat.id, result, { parse_mode: "Markdown" });
      return;
    }

    const { plan, created } = result;
    const lines = [
      created.length > 1
        ? `Workday schedules created (IDs: ${created.map((c) => c.id).join(", ")})`
        : `${accountTag(created[0].account)}Workday schedule created (ID: ${created[0].id})`,
      `Working *${plan.startLabel}-${plan.endLabel}*${plan.overnight ? " (overnight)" : ""}, *${plan.leadHours}h* left in the window when you start`,
    ];
    for (const schedule of created) {
      const count = parseTimesOfDay(schedule.times_of_day).length;
      lines.push(
        created.length > 1
          ? `*${schedule.account}*: ${schedule.times_of_day} (${count} per day)`
          : `Warmups: *${schedule.times_of_day}* (${count} per day)`
      );
    }
    if (created.length > 1) {
      lines.push(`Accounts are offset so their windows do not reset together.`);
    }
    const soonest = created.reduce((a, b) => (a.warmup_at <= b.warmup_at ? a : b));
    lines.push(`Next warmup at: *${fmt.format(new Date(soonest.warmup_at))}*${created.length > 1 ? ` (${soonest.account})` : ""}`);
    bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.onText(/\/dailies/, (msg) => {
    if (!isAllowed(msg)) return;
    const daily = getDailySchedules();
    if (daily.length === 0) {
      bot.sendMessage(msg.chat.id, "No daily schedules.");
      return;
    }
    const lines = daily.map(
      (s) =>
        `${accountTag(s.account)}ID ${s.id}: every day at ${s.times_of_day} (${s.hours_remaining}h remaining), next warmup at ${fmt.format(new Date(s.warmup_at))}`
    );
    bot.sendMessage(msg.chat.id, lines.join("\n"));
  });

  bot.onText(/\/cancel_daily (\d+)/, (msg, match) => {
    if (!isAllowed(msg)) return;
    const id = parseInt(match![1], 10);
    const ok = cancelDailySchedule(id);
    bot.sendMessage(msg.chat.id, ok ? `Daily schedule ${id} cancelled.` : `Daily schedule ${id} not found.`);
  });

  bot.onText(/\/cancel (\d+)/, (msg, match) => {
    if (!isAllowed(msg)) return;
    const id = parseInt(match![1], 10);
    const ok = cancelSchedule(id);
    bot.sendMessage(msg.chat.id, ok ? `Schedule ${id} cancelled.` : `Schedule ${id} not found or already fired.`);
  });

  bot.onText(/\/history(?:\s+(\S+))?/, (msg, match) => {
    if (!isAllowed(msg)) return;
    const selector = match?.[1];
    const targets = resolveAccounts(selector, ACCOUNTS);
    if (typeof targets === "string") {
      bot.sendMessage(msg.chat.id, targets, { parse_mode: "Markdown" });
      return;
    }
    // One account named explicitly filters; otherwise the newest across all.
    const sessions =
      selector && selector.toLowerCase() !== ALL_ACCOUNTS_TOKEN
        ? getSessionHistory(5, targets[0].name)
        : getSessionHistory(5);
    if (sessions.length === 0) {
      bot.sendMessage(msg.chat.id, "No session history.");
      return;
    }
    const lines = sessions.map((s) => {
      const expired = new Date(s.expires_at).getTime() < Date.now();
      const status = expired ? "expired" : `${fmtDuration(new Date(s.expires_at).getTime() - Date.now())} left`;
      return `${accountTag(s.account)}${fmt.format(new Date(s.started_at))} - ${status} (${s.output_tokens} out tokens)`;
    });
    bot.sendMessage(msg.chat.id, `*Recent Sessions*\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  });

  bot.on("polling_error", (err) => {
    console.error("Polling error:", err.message);
  });

  return bot;
}
