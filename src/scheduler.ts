import * as chrono from "chrono-node";
import { PRIMARY_ACCOUNT, SESSION_DURATION_MS, TIMEZONE, findAccount } from "./config";
import type { Account } from "./config";
import {
  deleteDailySchedule,
  getPendingSchedules,
  getDailySchedules,
  insertSchedule,
  insertDailySchedule,
  markScheduleFired,
  deleteSchedule,
  updateDailyScheduleNext,
} from "./db";
import { warmup } from "./warmup";
import type { Schedule, DailySchedule } from "./types";

type ScheduleCallback = (schedule: Schedule, success: boolean, error?: string) => void;
type DailyScheduleCallback = (
  schedule: DailySchedule,
  success: boolean,
  error?: string
) => void;

const timers = new Map<number, NodeJS.Timeout>();
const dailyTimers = new Map<number, NodeJS.Timeout>();

let onFire: ScheduleCallback = () => {};
let onDailyFire: DailyScheduleCallback = () => {};

export function setScheduleCallback(cb: ScheduleCallback): void {
  onFire = cb;
}

export function setDailyScheduleCallback(cb: DailyScheduleCallback): void {
  onDailyFire = cb;
}

export function restoreSchedules(): void {
  const pending = getPendingSchedules();
  for (const schedule of pending) {
    setTimer(schedule);
  }
  const daily = getDailySchedules();
  for (const schedule of daily) {
    setDailyTimer(schedule);
  }
  if (pending.length > 0) {
    console.log(`Restored ${pending.length} pending schedule(s)`);
  }
  if (daily.length > 0) {
    console.log(`Restored ${daily.length} daily schedule(s)`);
  }
}

// A schedule stored under an account that is no longer configured still has to
// fire somehow; the primary account is the safest stand-in.
function accountFor(name: string): Account {
  return findAccount(name) ?? PRIMARY_ACCOUNT;
}

export function calculateWarmupAt(targetDatetime: Date, hoursRemaining: number): Date {
  const warmupAtMs = targetDatetime.getTime() - (SESSION_DURATION_MS - hoursRemaining * 3600_000);
  return new Date(warmupAtMs);
}

export function addSchedule(
  targetDatetime: Date,
  hoursRemaining: number,
  account = PRIMARY_ACCOUNT.name
): Schedule | string {
  const warmupAt = calculateWarmupAt(targetDatetime, hoursRemaining);

  if (warmupAt.getTime() <= Date.now()) {
    return `Warmup time already passed (would have been ${warmupAt.toISOString()})`;
  }

  const schedule = insertSchedule(
    account,
    targetDatetime.toISOString(),
    hoursRemaining,
    warmupAt.toISOString()
  );

  setTimer(schedule);
  return schedule;
}

export interface DailyOccurrence {
  targetDatetime: Date;
  warmupAt: Date;
}

/** Splits `"7:29 AM, 13:00"` into individual times, trimmed and deduplicated. */
export function parseTimesOfDay(input: string): string[] {
  const seen = new Set<string>();
  const times: string[] = [];

  for (const part of input.split(",")) {
    const timeOfDay = part.trim();
    if (!timeOfDay || seen.has(timeOfDay.toLowerCase())) continue;
    seen.add(timeOfDay.toLowerCase());
    times.push(timeOfDay);
  }

  return times;
}

export function nextOccurrenceForTime(
  timeOfDay: string,
  hoursRemaining: number,
  now = new Date()
): DailyOccurrence | undefined {
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const instant = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const targetDatetime = chrono.parseDate(
      timeOfDay,
      { instant, timezone: TIMEZONE },
      { forwardDate: true }
    );

    if (!targetDatetime) {
      return undefined;
    }

    const warmupAt = calculateWarmupAt(targetDatetime, hoursRemaining);
    if (warmupAt.getTime() > now.getTime()) {
      return { targetDatetime, warmupAt };
    }
  }

  return undefined;
}

// A daily schedule can hold several times of day; the soonest upcoming warmup
// across all of them drives the timer. Unparseable times are skipped so one bad
// entry in a stored row cannot stall the rest of the schedule.
export function calculateNextDailyOccurrence(
  timesOfDay: string | string[],
  hoursRemaining: number,
  now = new Date()
): DailyOccurrence | undefined {
  const times = Array.isArray(timesOfDay) ? timesOfDay : parseTimesOfDay(timesOfDay);
  let earliest: DailyOccurrence | undefined;

  for (const timeOfDay of times) {
    const occurrence = nextOccurrenceForTime(timeOfDay, hoursRemaining, now);
    if (!occurrence) continue;
    if (!earliest || occurrence.warmupAt.getTime() < earliest.warmupAt.getTime()) {
      earliest = occurrence;
    }
  }

  return earliest;
}

const DAILY_TIME_HINT = "Try: \`7:29 AM\`, \`07:29, 13:00\`, or \`19:29\`";

export function addDailySchedule(
  timesInput: string,
  hoursRemaining: number,
  account = PRIMARY_ACCOUNT.name
): DailySchedule | string {
  const times = parseTimesOfDay(timesInput);
  if (times.length === 0) {
    return `No daily times given. ${DAILY_TIME_HINT}`;
  }

  const now = new Date();
  const invalid = times.filter((timeOfDay) => !nextOccurrenceForTime(timeOfDay, hoursRemaining, now));
  if (invalid.length > 0) {
    const label = invalid.length === 1 ? "time" : "times";
    return `Could not parse daily ${label}: ${invalid.join(", ")}. ${DAILY_TIME_HINT}`;
  }

  const next = calculateNextDailyOccurrence(times, hoursRemaining, now);
  if (!next) {
    return `Could not parse daily times. ${DAILY_TIME_HINT}`;
  }

  const schedule = insertDailySchedule(
    account,
    times.join(", "),
    hoursRemaining,
    next.targetDatetime.toISOString(),
    next.warmupAt.toISOString()
  );

  setDailyTimer(schedule);
  return schedule;
}

// A workday is covered by chaining 5-hour windows. The first warmup is placed so
// that `leadHours` of an already-running window remain when the workday starts —
// that window was opened by a trivial "ready" prompt, so its quota is untouched
// and gets spent on the first stretch of work. Each later warmup sits just past
// the previous window's expiry; without that margin it would land inside the
// still-live window and open nothing at all.
const WINDOW_HANDOVER_MARGIN_MS = 5 * 60 * 1000;
const MAX_WORKDAY_WARMUPS = 8;
const SESSION_HOURS = SESSION_DURATION_MS / 3_600_000;

const WORKDAY_RANGE = /^\s*(.+?)\s*(?:-|–|—|\bto\b|\buntil\b)\s*(.+?)\s*$/i;

const timeOfDayFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface WorkdayPlan {
  startLabel: string;
  endLabel: string;
  leadHours: number;
  overnight: boolean;
  times: string[];
}

const WORKDAY_HINT = "Try: \`/workday 9am-6pm\` or \`/workday 9:00-18:00 1.5h\`";

// Bare hours are common shorthand, but chrono needs a colon: "9-18" -> "9:00-18:00".
// When both sides are bare, an end that is not after the start reads as the
// afternoon rather than as an overnight shift, so "9-6" means 09:00-18:00.
function normalizeWorkdayTimes(startInput: string, endInput: string): [string, string] {
  const isBareHour = (input: string) => /^\d{1,2}$/.test(input);
  if (!isBareHour(startInput) && !isBareHour(endInput)) {
    return [startInput, endInput];
  }

  let start = startInput;
  let end = endInput;

  if (isBareHour(start) && isBareHour(end)) {
    const startHour = parseInt(start, 10);
    let endHour = parseInt(end, 10);
    if (endHour <= startHour && endHour + 12 > startHour && endHour + 12 <= 23) {
      endHour += 12;
    }
    return [`${startHour}:00`, `${endHour}:00`];
  }

  if (isBareHour(start)) start = `${start}:00`;
  if (isBareHour(end)) end = `${end}:00`;
  return [start, end];
}

export function planWorkday(
  workdayInput: string,
  leadHours: number,
  now = new Date(),
  offsetMs = 0
): WorkdayPlan | string {
  const range = workdayInput.match(WORKDAY_RANGE);
  if (!range) {
    return `Could not read a start and end time from \`${workdayInput}\`. ${WORKDAY_HINT}`;
  }

  if (leadHours <= 0 || leadHours > SESSION_HOURS) {
    return `Lead hours must be between 0.5 and ${SESSION_HOURS}. ${WORKDAY_HINT}`;
  }

  const [startInput, endInput] = normalizeWorkdayTimes(range[1], range[2]);
  const parse = (input: string) =>
    chrono.parseDate(input, { instant: now, timezone: TIMEZONE });
  const start = parse(startInput);
  const end = parse(endInput);
  if (!start || !end) {
    const bad = [!start ? range[1] : undefined, !end ? range[2] : undefined].filter(Boolean);
    return `Could not parse workday ${bad.length === 1 ? "time" : "times"}: ${bad.join(", ")}. ${WORKDAY_HINT}`;
  }

  // An end at or before the start means an overnight shift, so roll it forward.
  const overnight = end.getTime() <= start.getTime();
  const endTime = overnight ? end.getTime() + 24 * 60 * 60 * 1000 : end.getTime();

  const warmups: Date[] = [new Date(calculateWarmupAt(start, leadHours).getTime() + offsetMs)];
  while (warmups.length < MAX_WORKDAY_WARMUPS) {
    const previous = warmups[warmups.length - 1];
    const next = new Date(
      previous.getTime() + SESSION_DURATION_MS + WINDOW_HANDOVER_MARGIN_MS
    );
    if (next.getTime() >= endTime) break;
    warmups.push(next);
  }

  return {
    startLabel: timeOfDayFmt.format(start),
    endLabel: timeOfDayFmt.format(new Date(endTime)),
    leadHours,
    overnight,
    times: warmups.map((w) => timeOfDayFmt.format(w)),
  };
}

export interface AccountWorkdayPlan {
  account: string;
  times: string[];
}

/**
 * Spreads a workday across several accounts. Each extra account is offset by an
 * even fraction of a session, so their windows do not all reset at the same
 * moment: with two accounts a fresh window arrives every 2.5 hours instead of
 * every 5. A single account is simply the unstaggered plan.
 */
export function planStaggeredWorkday(
  workdayInput: string,
  leadHours: number,
  accountNames: string[],
  now = new Date()
): { plan: WorkdayPlan; perAccount: AccountWorkdayPlan[] } | string {
  if (accountNames.length === 0) {
    return "No accounts to schedule.";
  }

  const stride = SESSION_DURATION_MS / accountNames.length;
  const perAccount: AccountWorkdayPlan[] = [];
  let firstPlan: WorkdayPlan | undefined;

  for (const [index, account] of accountNames.entries()) {
    const plan = planWorkday(workdayInput, leadHours, now, index * stride);
    if (typeof plan === "string") return plan;
    if (!firstPlan) firstPlan = plan;
    perAccount.push({ account, times: plan.times });
  }

  return { plan: firstPlan!, perAccount };
}

export function addWorkdaySchedules(
  workdayInput: string,
  leadHours: number,
  accountNames: string[]
): { plan: WorkdayPlan; created: DailySchedule[] } | string {
  const staggered = planStaggeredWorkday(workdayInput, leadHours, accountNames);
  if (typeof staggered === "string") return staggered;

  const created: DailySchedule[] = [];
  for (const { account, times } of staggered.perAccount) {
    // An offset account can have no warmup left inside a short workday.
    if (times.length === 0) continue;
    const schedule = addDailySchedule(times.join(", "), SESSION_HOURS, account);
    if (typeof schedule === "string") return schedule;
    created.push(schedule);
  }

  if (created.length === 0) {
    return "That workday is too short to fit a warmup for any account.";
  }

  return { plan: staggered.plan, created };
}

export function cancelSchedule(id: number): boolean {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  return deleteSchedule(id);
}

export function cancelDailySchedule(id: number): boolean {
  const timer = dailyTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    dailyTimers.delete(id);
  }
  return deleteDailySchedule(id);
}

function setTimer(schedule: Schedule): void {
  const delay = new Date(schedule.warmup_at).getTime() - Date.now();
  if (delay <= 0) return;

  const timer = setTimeout(async () => {
    timers.delete(schedule.id);
    markScheduleFired(schedule.id);

    const { result } = await warmup(accountFor(schedule.account));
    onFire(schedule, result.success, result.error);
  }, delay);

  timers.set(schedule.id, timer);
}

function setDailyTimer(schedule: DailySchedule): void {
  let nextSchedule = schedule;
  let delay = new Date(nextSchedule.warmup_at).getTime() - Date.now();

  if (delay <= 0) {
    const next = calculateNextDailyOccurrence(
      nextSchedule.times_of_day,
      nextSchedule.hours_remaining
    );
    if (!next) return;

    const updated = updateDailyScheduleNext(
      nextSchedule.id,
      next.targetDatetime.toISOString(),
      next.warmupAt.toISOString(),
      nextSchedule.last_fired_at
    );
    if (!updated) return;

    nextSchedule = updated;
    delay = new Date(nextSchedule.warmup_at).getTime() - Date.now();
    if (delay <= 0) return;
  }

  const timer = setTimeout(async () => {
    dailyTimers.delete(nextSchedule.id);

    const { result } = await warmup(accountFor(nextSchedule.account));
    const next = calculateNextDailyOccurrence(
      nextSchedule.times_of_day,
      nextSchedule.hours_remaining
    );
    const updated = next
      ? updateDailyScheduleNext(
          nextSchedule.id,
          next.targetDatetime.toISOString(),
          next.warmupAt.toISOString(),
          new Date().toISOString()
        )
      : undefined;

    if (updated) {
      setDailyTimer(updated);
      onDailyFire(updated, result.success, result.error);
    } else {
      onDailyFire(nextSchedule, result.success, result.error);
    }
  }, delay);

  dailyTimers.set(nextSchedule.id, timer);
}
