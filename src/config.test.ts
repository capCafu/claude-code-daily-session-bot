import { describe, it, expect } from "vitest";
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_USER_IDS,
  TIMEZONE,
  SESSION_DURATION_MS,
  DB_PATH,
  ACCOUNTS,
  PRIMARY_ACCOUNT,
  IS_MULTI_ACCOUNT,
  DEFAULT_ACCOUNT_NAME,
  parseAccounts,
} from "./config";

describe("config", () => {
  it("TELEGRAM_BOT_TOKEN from env", () => {
    expect(TELEGRAM_BOT_TOKEN).toBe("test-token");
  });

  it("ALLOWED_USER_IDS parsed from comma-separated string", () => {
    expect(ALLOWED_USER_IDS).toEqual([111, 222]);
  });

  it("TIMEZONE defaults to UTC", () => {
    expect(TIMEZONE).toBe("UTC");
  });

  it("SESSION_DURATION_MS is 5 hours", () => {
    expect(SESSION_DURATION_MS).toBe(5 * 60 * 60 * 1000);
  });

  it("DB_PATH from env", () => {
    expect(DB_PATH).toBe(":memory:");
  });
});

describe("accounts", () => {
  it("falls back to one implicit account when CLAUDE_ACCOUNTS is unset", () => {
    // test/setup.ts leaves CLAUDE_ACCOUNTS unset.
    expect(ACCOUNTS).toEqual([{ name: DEFAULT_ACCOUNT_NAME }]);
    expect(PRIMARY_ACCOUNT.name).toBe(DEFAULT_ACCOUNT_NAME);
    expect(IS_MULTI_ACCOUNT).toBe(false);
  });

  it("the implicit account has no config dir, so the child env is untouched", () => {
    expect(parseAccounts(undefined)).toEqual([{ name: DEFAULT_ACCOUNT_NAME }]);
    expect(parseAccounts("  ")).toEqual([{ name: DEFAULT_ACCOUNT_NAME }]);
  });

  it("resolves bare names under the accounts dir", () => {
    expect(parseAccounts("work,personal", "/data/accounts")).toEqual([
      { name: "work", configDir: "/data/accounts/work" },
      { name: "personal", configDir: "/data/accounts/personal" },
    ]);
  });

  it("accepts an explicit config dir per account", () => {
    expect(parseAccounts("work:/srv/a,personal:/srv/b", "/unused")).toEqual([
      { name: "work", configDir: "/srv/a" },
      { name: "personal", configDir: "/srv/b" },
    ]);
  });

  it("lowercases names and ignores surrounding whitespace", () => {
    expect(parseAccounts(" Work , PERSONAL ", "/d")).toEqual([
      { name: "work", configDir: "/d/work" },
      { name: "personal", configDir: "/d/personal" },
    ]);
  });

  it("keeps the first entry as the primary account", () => {
    const accounts = parseAccounts("personal,work", "/d");
    if (typeof accounts === "string") throw new Error(accounts);
    expect(accounts[0].name).toBe("personal");
  });

  it("rejects a duplicate account", () => {
    expect(parseAccounts("work,work", "/d")).toContain("Duplicate account");
  });

  it("rejects the reserved name used to address every account", () => {
    expect(parseAccounts("all,work", "/d")).toContain("reserved");
  });

  it("rejects a name that would be read as an hours argument", () => {
    expect(parseAccounts("5h,work", "/d")).toContain("looks like an hours argument");
    expect(parseAccounts("2,work", "/d")).toContain("looks like an hours argument");
  });

  it("rejects a name with unusable characters", () => {
    expect(parseAccounts("my account", "/d")).toContain("Invalid account name");
    expect(parseAccounts("-work", "/d")).toContain("Invalid account name");
  });

  it("rejects an empty config dir", () => {
    expect(parseAccounts("work:", "/d")).toContain("empty config dir");
  });

  it("ignores stray commas", () => {
    expect(parseAccounts("work,,personal,", "/d")).toHaveLength(2);
  });

  it("rejects a list with no usable entries", () => {
    expect(parseAccounts(",,", "/d")).toContain("lists no accounts");
  });
});
