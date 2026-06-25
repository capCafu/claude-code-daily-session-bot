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

export function calculateNextDailyOccurrence(
  timeOfDay: string,
  hoursRemaining: number,
  now = new Date()
): { targetDatetime: Date; warmupAt: Date } | undefined {
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

export function addDailySchedule(
  timeOfDay: string,
  hoursRemaining: number
): DailySchedule | string {
  const next = calculateNextDailyOccurrence(timeOfDay, hoursRemaining);
  if (!next) {
    return `Could not parse daily time. Try: \`7:29 AM\`, \`07:29\`, or \`19:29\``;
  }

  const schedule = insertDailySchedule(
    timeOfDay,
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
      nextSchedule.time_of_day,
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
      nextSchedule.time_of_day,
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
