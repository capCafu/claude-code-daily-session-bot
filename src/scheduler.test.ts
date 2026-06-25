import { describe, it, expect } from "vitest";
import { calculateNextDailyOccurrence, calculateWarmupAt } from "./scheduler";

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
