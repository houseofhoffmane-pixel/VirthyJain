import { DateTime, Interval } from 'luxon';
import { config } from '../config.js';

export const ZONE = config.timezone; // 'Europe/Dublin'

/** A UTC instant (ISO string from Postgres or a Date) -> Luxon in Dublin time. */
export function toLocal(instant: string | Date): DateTime {
  const dt =
    instant instanceof Date
      ? DateTime.fromJSDate(instant, { zone: 'utc' })
      : DateTime.fromISO(instant, { zone: 'utc' });
  return dt.setZone(ZONE);
}

/** Local wall-clock (a Dublin calendar date + minutes-from-midnight) -> UTC ISO.
 *  Handles DST: the same wall time maps to a different UTC offset across the
 *  spring/autumn boundary. */
export function localWallToUtc(dateISO: string, minutesFromMidnight: number): string {
  const day = DateTime.fromISO(dateISO, { zone: ZONE }).startOf('day');
  const local = day.plus({ minutes: minutesFromMidnight });
  return local.toUTC().toISO()!;
}

/** UTC instant -> "HH:mm" label in Dublin time, matching the front-end slots. */
export function localTimeLabel(instant: string | Date): string {
  return toLocal(instant).toFormat('HH:mm');
}

/** Dublin weekday for a UTC instant, 0=Sunday..6=Saturday (matches templates). */
export function localWeekday(dateISO: string): number {
  // Luxon weekday: 1=Mon..7=Sun. Convert to 0=Sun..6=Sat.
  const w = DateTime.fromISO(dateISO, { zone: ZONE }).weekday;
  return w === 7 ? 0 : w;
}

export function nowUtcISO(): string {
  return DateTime.utc().toISO()!;
}

/** Inclusive list of Dublin calendar dates (YYYY-MM-DD) across [from, to]. */
export function eachLocalDate(fromISO: string, toISO: string): string[] {
  const start = DateTime.fromISO(fromISO, { zone: ZONE }).startOf('day');
  const end = DateTime.fromISO(toISO, { zone: ZONE }).startOf('day');
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur.toISODate()!);
    cur = cur.plus({ days: 1 });
  }
  return out;
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const a = Interval.fromDateTimes(DateTime.fromISO(aStart), DateTime.fromISO(aEnd));
  const b = Interval.fromDateTimes(DateTime.fromISO(bStart), DateTime.fromISO(bEnd));
  return a.overlaps(b);
}

/** Full local date label e.g. "Monday, 17 August" for emails/summaries. */
export function localFullLabel(instant: string | Date): string {
  return toLocal(instant).toFormat("cccc, d LLLL");
}
