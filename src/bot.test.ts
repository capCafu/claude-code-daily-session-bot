import { describe, it, expect } from "vitest";
import { fmtDuration, parseAccountToken, parseScheduleInput, resolveAccounts } from "./bot";
import { ACCOUNTS, DEFAULT_ACCOUNT_NAME, PRIMARY_ACCOUNT } from "./config";

describe("fmtDuration", () => {
  it("returns expired for 0", () => {
    expect(fmtDuration(0)).toBe("expired");
  });

  it("returns expired for negative", () => {
    expect(fmtDuration(-1000)).toBe("expired");
  });

  it("formats hours and minutes", () => {
    expect(fmtDuration(3_600_000)).toBe("1h 0m");
    expect(fmtDuration(5_400_000)).toBe("1h 30m");
    expect(fmtDuration(18_000_000)).toBe("5h 0m");
  });

  it("formats minutes only when < 1h", () => {
    expect(fmtDuration(300_000)).toBe("5m");
    expect(fmtDuration(60_000)).toBe("1m");
  });

  it("floors partial minutes", () => {
    expect(fmtDuration(90_000)).toBe("1m"); // 1.5 min
  });
});

describe("parseScheduleInput", () => {
  it("defaults to 2h when no hours token", () => {
    const result = parseScheduleInput("tomorrow 9am");
    expect(result).toEqual({ dateStr: "tomorrow 9am", hours: 2 });
  });

  it("parses explicit hours with h suffix", () => {
    const result = parseScheduleInput("tomorrow 9am 3h");
    expect(result).toEqual({ dateStr: "tomorrow 9am", hours: 3 });
  });

  it("parses explicit hours without h suffix", () => {
    const result = parseScheduleInput("tomorrow 9am 3");
    expect(result).toEqual({ dateStr: "tomorrow 9am", hours: 3 });
  });

  it("parses fractional hours", () => {
    const result = parseScheduleInput("monday 14:00 2.5h");
    expect(result).toEqual({ dateStr: "monday 14:00", hours: 2.5 });
  });

  it("rejects hours > 5 (keeps as dateStr)", () => {
    const result = parseScheduleInput("tomorrow 9am 6h");
    expect(result).toEqual({ dateStr: "tomorrow 9am 6h", hours: 2 });
  });

  it("rejects hours < 0.5 (keeps as dateStr)", () => {
    const result = parseScheduleInput("tomorrow 9am 0.1h");
    expect(result).toEqual({ dateStr: "tomorrow 9am 0.1h", hours: 2 });
  });

  it("does not parse single token as hours", () => {
    const result = parseScheduleInput("9am");
    expect(result).toEqual({ dateStr: "9am", hours: 2 });
  });

  it("handles boundary value 0.5", () => {
    const result = parseScheduleInput("tomorrow 0.5");
    expect(result).toEqual({ dateStr: "tomorrow", hours: 0.5 });
  });

  it("handles boundary value 5", () => {
    const result = parseScheduleInput("tomorrow 5h");
    expect(result).toEqual({ dateStr: "tomorrow", hours: 5 });
  });
});

describe("parseAccountToken", () => {
  const names = ["work", "personal"];

  it("strips a trailing account name", () => {
    expect(parseAccountToken("9am-6pm work", names)).toEqual({
      rest: "9am-6pm",
      selector: "work",
    });
  });

  it("strips the all selector", () => {
    expect(parseAccountToken("9am-6pm all", names)).toEqual({
      rest: "9am-6pm",
      selector: "all",
    });
  });

  it("keeps an hours argument in place before the account", () => {
    expect(parseAccountToken("7:00, 13:00 5h personal", names)).toEqual({
      rest: "7:00, 13:00 5h",
      selector: "personal",
    });
  });

  it("is case-insensitive about the account name", () => {
    expect(parseAccountToken("9am-6pm WORK", names).selector).toBe("work");
  });

  it("leaves input alone when the last word is not an account", () => {
    expect(parseAccountToken("tomorrow 9am", names)).toEqual({ rest: "tomorrow 9am" });
    expect(parseAccountToken("9am-6pm 1.5h", names)).toEqual({ rest: "9am-6pm 1.5h" });
  });

  it("never consumes a lone argument, even if it names an account", () => {
    // "/daily work" has no times, so the account must not swallow the input.
    expect(parseAccountToken("work", names)).toEqual({ rest: "work" });
  });
});

describe("resolveAccounts", () => {
  it("returns the fallback when no selector is given", () => {
    expect(resolveAccounts(undefined, [PRIMARY_ACCOUNT])).toEqual([PRIMARY_ACCOUNT]);
  });

  it("resolves a configured account by name", () => {
    expect(resolveAccounts(DEFAULT_ACCOUNT_NAME, [])).toEqual(ACCOUNTS);
  });

  it("resolves the all selector to every account", () => {
    expect(resolveAccounts("all", [])).toEqual(ACCOUNTS);
  });

  it("reports an unknown account rather than guessing", () => {
    expect(resolveAccounts("nope", [PRIMARY_ACCOUNT])).toContain("Unknown account");
  });
});
