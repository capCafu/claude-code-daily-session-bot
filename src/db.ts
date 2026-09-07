import Database from "better-sqlite3";
import { DB_PATH, PRIMARY_ACCOUNT } from "./config";
import type { Session, Schedule, DailySchedule } from "./types";

let db: Database.Database;

export function initDb(path?: string): void {
  db = new Database(path ?? DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      account TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_datetime TEXT NOT NULL,
      hours_remaining REAL NOT NULL,
      warmup_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      fired INTEGER DEFAULT 0,
      account TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      times_of_day TEXT NOT NULL,
      hours_remaining REAL NOT NULL,
      target_datetime TEXT NOT NULL,
      warmup_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_fired_at TEXT,
      account TEXT NOT NULL
    );
  `);

  migrateDailySchedules();
  migrateAccounts();
}

function columnNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name
  );
}

// Rows predate multi-account support, so they belong to the primary account.
// The name is validated by config.parseAccounts, so it is safe to inline.
function migrateAccounts(): void {
  for (const table of ["sessions", "schedules", "daily_schedules"]) {
    if (columnNames(table).includes("account")) continue;
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN account TEXT NOT NULL DEFAULT '${PRIMARY_ACCOUNT.name}'`
    );
  }
}

// Daily schedules used to hold a single `time_of_day`; they now hold a
// comma-separated list, so existing rows only need the column renamed.
function migrateDailySchedules(): void {
  const columns = columnNames("daily_schedules");
  const hasLegacyColumn = columns.includes("time_of_day");
  const hasCurrentColumn = columns.includes("times_of_day");

  if (hasLegacyColumn && !hasCurrentColumn) {
    db.exec("ALTER TABLE daily_schedules RENAME COLUMN time_of_day TO times_of_day");
  }
}

export function insertSession(
  account: string,
  sessionId: string,
  startedAt: string,
  expiresAt: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  costUsd: number
): Session {
  const stmt = db.prepare(`
    INSERT INTO sessions (account, session_id, started_at, expires_at, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    account,
    sessionId,
    startedAt,
    expiresAt,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    costUsd
  );
  return db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(result.lastInsertRowid) as Session;
}

export function getActiveSession(account: string): Session | undefined {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE account = ? AND expires_at > ? ORDER BY started_at DESC LIMIT 1"
    )
    .get(account, new Date().toISOString()) as Session | undefined;
}

/** The newest live session for each account that has one, primary order. */
export function getActiveSessions(accounts: string[]): Session[] {
  return accounts
    .map((account) => getActiveSession(account))
    .filter((s): s is Session => s !== undefined);
}

export function getSessionHistory(limit = 10, account?: string): Session[] {
  if (account === undefined) {
    return db
      .prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Session[];
  }
  return db
    .prepare("SELECT * FROM sessions WHERE account = ? ORDER BY started_at DESC LIMIT ?")
    .all(account, limit) as Session[];
}

export function insertSchedule(
  account: string,
  targetDatetime: string,
  hoursRemaining: number,
  warmupAt: string
): Schedule {
  const stmt = db.prepare(`
    INSERT INTO schedules (account, target_datetime, hours_remaining, warmup_at, created_at, fired)
    VALUES (?, ?, ?, ?, ?, 0)
  `);
  const result = stmt.run(
    account,
    targetDatetime,
    hoursRemaining,
    warmupAt,
    new Date().toISOString()
  );
  return db
    .prepare("SELECT * FROM schedules WHERE id = ?")
    .get(result.lastInsertRowid) as Schedule;
}

export function getPendingSchedules(): Schedule[] {
  return db
    .prepare("SELECT * FROM schedules WHERE fired = 0 AND warmup_at > ? ORDER BY warmup_at ASC")
    .all(new Date().toISOString()) as Schedule[];
}

export function markScheduleFired(id: number): void {
  db.prepare("UPDATE schedules SET fired = 1 WHERE id = ?").run(id);
}

export function deleteSchedule(id: number): boolean {
  const result = db.prepare("DELETE FROM schedules WHERE id = ? AND fired = 0").run(id);
  return result.changes > 0;
}

export function insertDailySchedule(
  account: string,
  timesOfDay: string,
  hoursRemaining: number,
  targetDatetime: string,
  warmupAt: string
): DailySchedule {
  const stmt = db.prepare(`
    INSERT INTO daily_schedules (account, times_of_day, hours_remaining, target_datetime, warmup_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    account,
    timesOfDay,
    hoursRemaining,
    targetDatetime,
    warmupAt,
    new Date().toISOString()
  );
  return db
    .prepare("SELECT * FROM daily_schedules WHERE id = ?")
    .get(result.lastInsertRowid) as DailySchedule;
}

export function getDailySchedules(): DailySchedule[] {
  return db
    .prepare("SELECT * FROM daily_schedules ORDER BY warmup_at ASC")
    .all() as DailySchedule[];
}

export function updateDailyScheduleNext(
  id: number,
  targetDatetime: string,
  warmupAt: string,
  lastFiredAt: string | null
): DailySchedule | undefined {
  db.prepare(`
    UPDATE daily_schedules
    SET target_datetime = ?, warmup_at = ?, last_fired_at = ?
    WHERE id = ?
  `).run(targetDatetime, warmupAt, lastFiredAt, id);
  return db.prepare("SELECT * FROM daily_schedules WHERE id = ?").get(id) as
    | DailySchedule
    | undefined;
}

export function deleteDailySchedule(id: number): boolean {
  const result = db.prepare("DELETE FROM daily_schedules WHERE id = ?").run(id);
  return result.changes > 0;
}
