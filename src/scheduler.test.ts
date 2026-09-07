import { describe, it, expect } from "vitest";
import {
  addDailySchedule,
  calculateNextDailyOccurrence,
  calculateWarmupAt,
  parseTimesOfDay,
} from "./scheduler";

const FIVE_HOURS = 5 * 60 * 60 * 1000;

describe("calculateWarmupAt", () => {
  const target = new Date("2025-01-15T10:00:00.000Z");

  it("2h remaining: warmup 3h before target", () => {
    const result = calculateWarmupAt(target, 2);
    // warmup = target - (5h - 2h) = target - 3h
    expect(result.getTime()).toBe(target.getTime() - 3 * 3600_000);
    expect(result.toISOString()).toBe("2025-01-15T07:00:00.000Z");
  });

  it("5h remaining: warmup at target time", () => {
    const result = calculateWarmupAt(target, 5);
    // warmup = target - (5h - 5h) = target
    expect(result.getTime()).toBe(target.getTime());
  });

  it("0h remaining: warmup 5h before target", () => {
    const result = calculateWarmupAt(target, 0);
    // warmup = target - 5h
    expect(result.getTime()).toBe(target.getTime() - FIVE_HOURS);
    expect(result.toISOString()).toBe("2025-01-15T05:00:00.000Z");
  });

  it("fractional hours (2.5h remaining)", () => {
    const result = calculateWarmupAt(target, 2.5);
    // warmup = target - (5h - 2.5h) = target - 2.5h
    expect(result.getTime()).toBe(target.getTime() - 2.5 * 3600_000);
  });

  it("1h remaining", () => {
    const result = calculateWarmupAt(target, 1);
    // warmup = target - 4h
    expect(result.toISOString()).toBe("2025-01-15T06:00:00.000Z");
  });
});

describe("calculateNextDailyOccurrence", () => {
  it("uses today's time when the warmup has not passed", () => {
    const now = new Date("2025-01-15T06:00:00.000Z");
    const result = calculateNextDailyOccurrence("10:00", 5, now);

    expect(result).toBeDefined();
    expect(result!.targetDatetime.toISOString()).toBe("2025-01-15T10:00:00.000Z");
    expect(result!.warmupAt.toISOString()).toBe("2025-01-15T10:00:00.000Z");
  });

  it("uses tomorrow when today's warmup time has already passed", () => {
    const now = new Date("2025-01-15T09:00:00.000Z");
    const result = calculateNextDailyOccurrence("10:00", 2, now);

    expect(result).toBeDefined();
    expect(result!.targetDatetime.toISOString()).toBe("2025-01-16T10:00:00.000Z");
    expect(result!.warmupAt.toISOString()).toBe("2025-01-16T07:00:00.000Z");
  });

  it("returns undefined for invalid time input", () => {
    const now = new Date("2025-01-15T09:00:00.000Z");

    expect(calculateNextDailyOccurrence("not a time", 5, now)).toBeUndefined();
  });
});

describe("parseTimesOfDay", () => {
  it("returns a single time unchanged", () => {
    expect(parseTimesOfDay("7:29 AM")).toEqual(["7:29 AM"]);
  });

  it("splits and trims a comma-separated list", () => {
    expect(parseTimesOfDay("07:00, 13:00 ,18:00")).toEqual(["07:00", "13:00", "18:00"]);
  });

  it("drops empty entries from stray commas", () => {
    expect(parseTimesOfDay("07:00, , 13:00,")).toEqual(["07:00", "13:00"]);
  });

  it("deduplicates times case-insensitively", () => {
    expect(parseTimesOfDay("7:00 AM, 07:00, 7:00 am")).toEqual(["7:00 AM", "07:00"]);
  });

  it("returns an empty list for no times", () => {
    expect(parseTimesOfDay("  ,  ")).toEqual([]);
  });
});

describe("calculateNextDailyOccurrence with multiple times", () => {
  it("picks the soonest upcoming time of day", () => {
    const now = new Date("2025-01-15T06:00:00.000Z");
    const result = calculateNextDailyOccurrence("18:00, 10:00, 13:00", 5, now);

    expect(result!.warmupAt.toISOString()).toBe("2025-01-15T10:00:00.000Z");
  });

  it("skips times whose warmup already passed today and rolls them to tomorrow", () => {
    const now = new Date("2025-01-15T14:00:00.000Z");
    const result = calculateNextDailyOccurrence("10:00, 18:00", 5, now);

    // 10:00 has passed today, so 18:00 today is the soonest.
    expect(result!.warmupAt.toISOString()).toBe("2025-01-15T18:00:00.000Z");
  });

  it("rolls to the earliest time tomorrow once every time has passed", () => {
    const now = new Date("2025-01-15T19:00:00.000Z");
    const result = calculateNextDailyOccurrence("10:00, 18:00", 5, now);

    expect(result!.warmupAt.toISOString()).toBe("2025-01-16T10:00:00.000Z");
  });

  it("applies hours_remaining to every time", () => {
    const now = new Date("2025-01-15T06:00:00.000Z");
    const result = calculateNextDailyOccurrence("10:00, 18:00", 2, now);

    // warmup = target - 3h, so 10:00 target -> 07:00 warmup
    expect(result!.targetDatetime.toISOString()).toBe("2025-01-15T10:00:00.000Z");
    expect(result!.warmupAt.toISOString()).toBe("2025-01-15T07:00:00.000Z");
  });

  it("ignores an unparseable time when others are valid", () => {
    const now = new Date("2025-01-15T06:00:00.000Z");
    const result = calculateNextDailyOccurrence("not a time, 10:00", 5, now);

    expect(result!.warmupAt.toISOString()).toBe("2025-01-15T10:00:00.000Z");
  });

  it("returns undefined when no time is parseable", () => {
    const now = new Date("2025-01-15T06:00:00.000Z");

    expect(calculateNextDailyOccurrence("not a time, also bad", 5, now)).toBeUndefined();
  });

  it("accepts a pre-split list of times", () => {
    const now = new Date("2025-01-15T06:00:00.000Z");
    const result = calculateNextDailyOccurrence(["18:00", "10:00"], 5, now);

    expect(result!.warmupAt.toISOString()).toBe("2025-01-15T10:00:00.000Z");
  });
});

// These inputs are rejected before any DB write, so no database is needed.
describe("addDailySchedule validation", () => {
  it("rejects input with no times", () => {
    expect(addDailySchedule(" , ", 5)).toContain("No daily times given");
  });

  it("names the single unparseable time", () => {
    const result = addDailySchedule("not a time", 5);

    expect(result).toContain("Could not parse daily time:");
    expect(result).toContain("not a time");
  });

  it("names every unparseable time in a list", () => {
    const result = addDailySchedule("07:00, nope, 13:00, also bad", 5);

    expect(result).toContain("Could not parse daily times:");
    expect(result).toContain("nope, also bad");
  });
});
