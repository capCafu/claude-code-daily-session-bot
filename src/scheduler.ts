import * as chrono from "chrono-node";
import { SESSION_DURATION_MS, TIMEZONE } from "./config";
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

export function calculateWarmupAt(targetDatetime: Date, hoursRemaining: number): Date {
  const warmupAtMs = targetDatetime.getTime() - (SESSION_DURATION_MS - hoursRemaining * 3600_000);
  return new Date(warmupAtMs);
}

export function addSchedule(targetDatetime: Date, hoursRemaining: number): Schedule | string {
  const warmupAt = calculateWarmupAt(targetDatetime, hoursRemaining);

  if (warmupAt.getTime() <= Date.now()) {
    return `Warmup time already passed (would have been ${warmupAt.toISOString()})`;
  }

  const schedule = insertSchedule(
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
  hoursRemaining: number
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
    times.join(", "),
    hoursRemaining,
    next.targetDatetime.toISOString(),
    next.warmupAt.toISOString()
  );

  setDailyTimer(schedule);
  return schedule;
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

    const { result } = await warmup();
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

    const { result } = await warmup();
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
