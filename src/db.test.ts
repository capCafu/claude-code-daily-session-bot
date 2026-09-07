import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  initDb,
  insertSession,
  getActiveSession,
  getSessionHistory,
  insertSchedule,
  getPendingSchedules,
  markScheduleFired,
  deleteSchedule,
  insertDailySchedule,
  getDailySchedules,
  updateDailyScheduleNext,
  deleteDailySchedule,
} from "./db";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeEach(() => {
  initDb(":memory:");
});

describe("sessions", () => {
  const futureDate = new Date(Date.now() + 3_600_000).toISOString();
  const pastDate = new Date(Date.now() - 3_600_000).toISOString();
  const now = new Date().toISOString();

  it("insertSession returns session with all fields", () => {
    const s = insertSession("s1", now, futureDate, 100, 50, 10, 5, 0.05);
    expect(s.id).toBeDefined();
    expect(s.session_id).toBe("s1");
    expect(s.started_at).toBe(now);
    expect(s.expires_at).toBe(futureDate);
    expect(s.input_tokens).toBe(100);
    expect(s.output_tokens).toBe(50);
    expect(s.cache_creation_tokens).toBe(10);
    expect(s.cache_read_tokens).toBe(5);
    expect(s.cost_usd).toBe(0.05);
  });

  it("getActiveSession returns active session", () => {
    insertSession("s1", now, futureDate, 0, 0, 0, 0, 0);
    const active = getActiveSession();
    expect(active).toBeDefined();
    expect(active!.session_id).toBe("s1");
  });

  it("getActiveSession returns undefined for expired session", () => {
    insertSession("s1", pastDate, pastDate, 0, 0, 0, 0, 0);
    expect(getActiveSession()).toBeUndefined();
  });

  it("getActiveSession returns most recent when multiple active", () => {
    const farFuture = new Date(Date.now() + 7_200_000).toISOString();
    insertSession("s1", pastDate, futureDate, 0, 0, 0, 0, 0);
    insertSession("s2", now, farFuture, 0, 0, 0, 0, 0);
    const active = getActiveSession();
    expect(active!.session_id).toBe("s2");
  });

  it("getSessionHistory returns sessions DESC ordered", () => {
    insertSession("s1", "2025-01-01T00:00:00Z", futureDate, 0, 0, 0, 0, 0);
    insertSession("s2", "2025-01-02T00:00:00Z", futureDate, 0, 0, 0, 0, 0);
    insertSession("s3", "2025-01-03T00:00:00Z", futureDate, 0, 0, 0, 0, 0);
    const history = getSessionHistory(10);
    expect(history.map((s) => s.session_id)).toEqual(["s3", "s2", "s1"]);
  });

  it("getSessionHistory respects limit", () => {
    insertSession("s1", "2025-01-01T00:00:00Z", futureDate, 0, 0, 0, 0, 0);
    insertSession("s2", "2025-01-02T00:00:00Z", futureDate, 0, 0, 0, 0, 0);
    insertSession("s3", "2025-01-03T00:00:00Z", futureDate, 0, 0, 0, 0, 0);
    expect(getSessionHistory(2)).toHaveLength(2);
  });
});

describe("schedules", () => {
  const futureWarmup = new Date(Date.now() + 3_600_000).toISOString();
  const futureTarget = new Date(Date.now() + 7_200_000).toISOString();
  const pastWarmup = new Date(Date.now() - 3_600_000).toISOString();

  it("insertSchedule returns schedule with all fields", () => {
    const s = insertSchedule(futureTarget, 2, futureWarmup);
    expect(s.id).toBeDefined();
    expect(s.target_datetime).toBe(futureTarget);
    expect(s.hours_remaining).toBe(2);
    expect(s.warmup_at).toBe(futureWarmup);
    expect(s.fired).toBe(0);
  });

  it("getPendingSchedules returns unfired future schedules", () => {
    insertSchedule(futureTarget, 2, futureWarmup);
    const pending = getPendingSchedules();
    expect(pending).toHaveLength(1);
  });

  it("getPendingSchedules excludes fired schedules", () => {
    const s = insertSchedule(futureTarget, 2, futureWarmup);
    markScheduleFired(s.id);
    expect(getPendingSchedules()).toHaveLength(0);
  });

  it("getPendingSchedules excludes past warmup_at", () => {
    insertSchedule(futureTarget, 2, pastWarmup);
    expect(getPendingSchedules()).toHaveLength(0);
  });

  it("markScheduleFired sets fired flag", () => {
    const s = insertSchedule(futureTarget, 2, futureWarmup);
    markScheduleFired(s.id);
    expect(getPendingSchedules()).toHaveLength(0);
  });

  it("deleteSchedule removes unfired schedule", () => {
    const s = insertSchedule(futureTarget, 2, futureWarmup);
    expect(deleteSchedule(s.id)).toBe(true);
    expect(getPendingSchedules()).toHaveLength(0);
  });

  it("deleteSchedule returns false for fired schedule", () => {
    const s = insertSchedule(futureTarget, 2, futureWarmup);
    markScheduleFired(s.id);
    expect(deleteSchedule(s.id)).toBe(false);
  });

  it("deleteSchedule returns false for non-existent id", () => {
    expect(deleteSchedule(999)).toBe(false);
  });
});

describe("daily schedules", () => {
  const target = new Date(Date.now() + 7_200_000).toISOString();
  const warmup = new Date(Date.now() + 3_600_000).toISOString();
  const nextTarget = new Date(Date.now() + 24 * 3_600_000 + 7_200_000).toISOString();
  const nextWarmup = new Date(Date.now() + 24 * 3_600_000 + 3_600_000).toISOString();

  it("insertDailySchedule returns schedule with all fields", () => {
    const s = insertDailySchedule("7:29 AM", 5, target, warmup);
    expect(s.id).toBeDefined();
    expect(s.times_of_day).toBe("7:29 AM");
    expect(s.hours_remaining).toBe(5);
    expect(s.target_datetime).toBe(target);
    expect(s.warmup_at).toBe(warmup);
    expect(s.last_fired_at).toBeNull();
  });

  it("getDailySchedules returns schedules ordered by next warmup", () => {
    insertDailySchedule("10:00", 5, nextTarget, nextWarmup);
    insertDailySchedule("7:29 AM", 5, target, warmup);

    const daily = getDailySchedules();

    expect(daily.map((s) => s.times_of_day)).toEqual(["7:29 AM", "10:00"]);
  });

  it("updateDailyScheduleNext updates next occurrence and last fired time", () => {
    const s = insertDailySchedule("7:29 AM", 5, target, warmup);
    const firedAt = new Date().toISOString();

    const updated = updateDailyScheduleNext(s.id, nextTarget, nextWarmup, firedAt);

    expect(updated).toBeDefined();
    expect(updated!.target_datetime).toBe(nextTarget);
    expect(updated!.warmup_at).toBe(nextWarmup);
    expect(updated!.last_fired_at).toBe(firedAt);
  });

  it("deleteDailySchedule removes schedule", () => {
    const s = insertDailySchedule("7:29 AM", 5, target, warmup);

    expect(deleteDailySchedule(s.id)).toBe(true);
    expect(getDailySchedules()).toHaveLength(0);
  });

  it("deleteDailySchedule returns false for non-existent id", () => {
    expect(deleteDailySchedule(999)).toBe(false);
  });

  it("stores several times of day on one schedule", () => {
    const s = insertDailySchedule("07:00, 13:00, 18:00", 5, target, warmup);

    expect(getDailySchedules()[0].times_of_day).toBe("07:00, 13:00, 18:00");
    expect(s.times_of_day).toBe("07:00, 13:00, 18:00");
  });
});

describe("daily schedule migration", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-bot-test-"));
    dbPath = join(dir, "legacy.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renames a legacy time_of_day column, preserving existing rows", () => {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE daily_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time_of_day TEXT NOT NULL,
        hours_remaining REAL NOT NULL,
        target_datetime TEXT NOT NULL,
        warmup_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_fired_at TEXT
      );
    `);
    legacy
      .prepare(
        `INSERT INTO daily_schedules (time_of_day, hours_remaining, target_datetime, warmup_at, created_at)
         VALUES ('7:00 AM', 5, '2026-09-07T22:00:00.000Z', '2026-09-07T22:00:00.000Z', '2026-06-25T00:18:41.696Z')`
      )
      .run();
    legacy.close();

    initDb(dbPath);
    const daily = getDailySchedules();

    expect(daily).toHaveLength(1);
    expect(daily[0].times_of_day).toBe("7:00 AM");
    expect(daily[0].hours_remaining).toBe(5);
  });

  it("is a no-op on a fresh database", () => {
    initDb(dbPath);
    initDb(dbPath);

    const s = insertDailySchedule("07:00, 13:00", 5, "2026-09-07T22:00:00.000Z", "2026-09-07T22:00:00.000Z");
    expect(s.times_of_day).toBe("07:00, 13:00");
  });
});
