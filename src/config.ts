import "dotenv/config";

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
export const ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
  .split(",")
  .map((id) => parseInt(id.trim(), 10))
  .filter((id) => !isNaN(id));
export const TIMEZONE = process.env.TIMEZONE ?? "UTC";
process.env.TZ = TIMEZONE;

export const SESSION_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours
export const DB_PATH = process.env.DB_PATH ?? "data/bot.db";

export interface Account {
  name: string;
  /** Value for the child process's CLAUDE_CONFIG_DIR. Undefined means the
   *  ambient environment is used, which is how a single-account setup runs. */
  configDir?: string;
}

/** Used when CLAUDE_ACCOUNTS is unset, so single-account setups keep working. */
export const DEFAULT_ACCOUNT_NAME = "default";

/** Addresses every account at once in a command. */
export const ALL_ACCOUNTS_TOKEN = "all";

export const ACCOUNTS_DIR = process.env.CLAUDE_ACCOUNTS_DIR ?? "data/accounts";

const ACCOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
// An account named "5h" or "2" would be indistinguishable from the [hours]
// argument that trails several commands.
const HOURS_LIKE = /^\d+(?:\.\d+)?h?$/;

/**
 * Parses CLAUDE_ACCOUNTS: a comma-separated list of `name` or `name:configDir`
 * entries, e.g. `work,personal` or `work:/data/work,personal:/data/personal`.
 * A bare name resolves its config dir under `accountsDir`. The first entry is
 * the primary account. Returns an error message rather than throwing.
 */
export function parseAccounts(
  raw: string | undefined,
  accountsDir = ACCOUNTS_DIR
): Account[] | string {
  if (!raw || !raw.trim()) {
    return [{ name: DEFAULT_ACCOUNT_NAME }];
  }

  const accounts: Account[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;

    const separator = entry.indexOf(":");
    const name = (separator === -1 ? entry : entry.slice(0, separator)).trim().toLowerCase();
    const configDir = separator === -1 ? undefined : entry.slice(separator + 1).trim();

    if (!ACCOUNT_NAME_PATTERN.test(name)) {
      return `Invalid account name \`${name}\` in CLAUDE_ACCOUNTS. Use letters, digits, dashes or underscores, e.g. \`work,personal\`.`;
    }
    if (name === ALL_ACCOUNTS_TOKEN) {
      return `Account name \`${ALL_ACCOUNTS_TOKEN}\` is reserved; it addresses every account at once.`;
    }
    if (HOURS_LIKE.test(name)) {
      return `Account name \`${name}\` looks like an hours argument; pick a name that is not a number.`;
    }
    if (seen.has(name)) {
      return `Duplicate account \`${name}\` in CLAUDE_ACCOUNTS.`;
    }
    if (separator !== -1 && !configDir) {
      return `Account \`${name}\` in CLAUDE_ACCOUNTS has an empty config dir.`;
    }

    seen.add(name);
    accounts.push({ name, configDir: configDir ?? `${accountsDir}/${name}` });
  }

  if (accounts.length === 0) {
    return "CLAUDE_ACCOUNTS is set but lists no accounts.";
  }

  return accounts;
}

function loadAccounts(): Account[] {
  const parsed = parseAccounts(process.env.CLAUDE_ACCOUNTS);
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exit(1);
  }
  return parsed;
}

export const ACCOUNTS = loadAccounts();
export const ACCOUNT_NAMES = ACCOUNTS.map((a) => a.name);
export const PRIMARY_ACCOUNT = ACCOUNTS[0];
export const IS_MULTI_ACCOUNT = ACCOUNTS.length > 1;

export function findAccount(name: string): Account | undefined {
  const wanted = name.trim().toLowerCase();
  return ACCOUNTS.find((a) => a.name === wanted);
}

if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

if (ALLOWED_USER_IDS.length === 0) {
  console.error("TELEGRAM_ALLOWED_USER_IDS is required");
  process.exit(1);
}
