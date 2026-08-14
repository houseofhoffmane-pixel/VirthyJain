import { DateTime } from 'luxon';
import { Db, pool } from './db.js';
import { Settings } from './settings.js';
import { ZONE, localWallToUtc, localWeekday, toLocal } from './time.js';

// ---------------------------------------------------------------------------
// Occupied-span math. Shared by the availability endpoint and the booking
// transaction so they can never disagree about what a slot blocks.
//
//   occupied = [ start - travel , end + buffer + travel )
//
// Travel padding is applied on BOTH sides (a home visit needs travel to and
// from the address). The inter-appointment buffer is applied ONCE, on the end,
// so the gap between any two appointments is exactly one buffer rather than
// two. `travel` is 0 for clinic/telehealth.
// ---------------------------------------------------------------------------
export function occupiedBounds(
  startISO: string,
  durationMinutes: number,
  bufferMinutes: number,
  travelMinutes: number,
): { start: string; end: string; occLower: string; occUpper: string } {
  const start = DateTime.fromISO(startISO, { zone: 'utc' });
  const end = start.plus({ minutes: durationMinutes });
  const occLower = start.minus({ minutes: travelMinutes });
  const occUpper = end.plus({ minutes: bufferMinutes + travelMinutes });
  return {
    start: start.toISO()!,
    end: end.toISO()!,
    occLower: occLower.toISO()!,
    occUpper: occUpper.toISO()!,
  };
}

export interface FormatRow {
  key: string;
  name: string;
  active: boolean;
  travel_buffer_minutes: number;
}

export function travelFor(format: FormatRow, settings: Settings): number {
  if (format.key !== 'home') return 0;
  // A per-format value overrides the global default when set (>0).
  return format.travel_buffer_minutes > 0
    ? format.travel_buffer_minutes
    : settings.travel_buffer_minutes;
}

export interface DaySlots {
  date: string; // YYYY-MM-DD (Dublin)
  weekday: string; // "Mon"
  working: boolean; // is this within her weekly template for this format?
  slots: { label: string; startUtc: string; free: boolean }[];
}

/**
 * Compute bookable start times for one service+format over a date range.
 * Returns one entry per calendar day, with `working` distinguishing a day
 * outside the weekly template (closed) from a working day that is simply full.
 */
export async function computeAvailability(opts: {
  serviceDurationMinutes: number;
  format: FormatRow;
  fromDate: string; // YYYY-MM-DD Dublin
  toDate: string;
  settings: Settings;
  client?: Db;
}): Promise<DaySlots[]> {
  const { serviceDurationMinutes, format, fromDate, toDate, settings } = opts;
  const runner = opts.client ?? pool;
  const travel = travelFor(format, settings);
  const grid = settings.slot_granularity_minutes;

  // Templates for this format, grouped by weekday.
  const templates = (
    await runner.query(
      `SELECT weekday, start_min, end_min FROM availability_templates
       WHERE format_key = $1 ORDER BY weekday, start_min`,
      [format.key],
    )
  ).rows as { weekday: number; start_min: number; end_min: number }[];
  const byWeekday = new Map<number, { start_min: number; end_min: number }[]>();
  for (const t of templates) {
    if (!byWeekday.has(t.weekday)) byWeekday.set(t.weekday, []);
    byWeekday.get(t.weekday)!.push(t);
  }

  // Window bounds in UTC to fetch existing bookings + blackouts once.
  const rangeStart = localWallToUtc(fromDate, 0);
  const rangeEnd = DateTime.fromISO(localWallToUtc(toDate, 0), { zone: 'utc' })
    .plus({ days: 1 })
    .toISO()!;

  // Pull occupancy and blackout bounds as epoch-millis so we never parse
  // Postgres range/timestamp text on the JS side.
  const existing = (
    await runner.query(
      `SELECT extract(epoch from lower(occupied)) * 1000 AS lo,
              extract(epoch from upper(occupied)) * 1000 AS hi
         FROM bookings
        WHERE practitioner_id = 1
          AND status IN ('pending','confirmed')
          AND occupied && tstzrange($1, $2)`,
      [rangeStart, rangeEnd],
    )
  ).rows as { lo: string; hi: string }[];
  const occupiedRanges = existing.map((r) => ({ lower: Number(r.lo), upper: Number(r.hi) }));

  const blackouts = (
    await runner.query(
      `SELECT extract(epoch from start_at) * 1000 AS lo,
              extract(epoch from end_at) * 1000 AS hi
         FROM blackouts
        WHERE tstzrange(start_at, end_at) && tstzrange($1, $2)`,
      [rangeStart, rangeEnd],
    )
  ).rows as { lo: string; hi: string }[];
  const blackoutRanges = blackouts.map((r) => ({ lower: Number(r.lo), upper: Number(r.hi) }));

  const nowMs = Date.now();
  const minNoticeMs = settings.min_notice_hours * 3600_000;

  const days: DaySlots[] = [];
  let cursor = DateTime.fromISO(fromDate, { zone: ZONE }).startOf('day');
  const last = DateTime.fromISO(toDate, { zone: ZONE }).startOf('day');

  while (cursor <= last) {
    const dateISO = cursor.toISODate()!;
    const weekday = localWeekday(localWallToUtc(dateISO, 0));
    const windows = byWeekday.get(weekday) ?? [];
    const working = windows.length > 0;
    const slots: DaySlots['slots'] = [];

    for (const w of windows) {
      for (let m = w.start_min; m + serviceDurationMinutes <= w.end_min; m += grid) {
        const startISO = localWallToUtc(dateISO, m);
        const startMs = new Date(startISO).getTime();

        // Past and minimum-notice guard.
        if (startMs < nowMs + minNoticeMs) continue;

        const b = occupiedBounds(startISO, serviceDurationMinutes, settings.buffer_minutes, travel);
        const oL = new Date(b.occLower).getTime();
        const oU = new Date(b.occUpper).getTime();

        // Blocked by an existing booking's occupied span?
        const clash = occupiedRanges.some((r) => rangeOverlap(oL, oU, r.lower, r.upper));

        // Blocked by a blackout (compare the appointment span itself)?
        const sMs = new Date(b.start).getTime();
        const eMs = new Date(b.end).getTime();
        const inBlackout = blackoutRanges.some((bl) => rangeOverlap(sMs, eMs, bl.lower, bl.upper));

        slots.push({
          label: toLocal(startISO).toFormat('HH:mm'),
          startUtc: startISO,
          free: !clash && !inBlackout,
        });
      }
    }

    // De-dup by start (overlapping template windows) and sort.
    const seen = new Map<string, DaySlots['slots'][number]>();
    for (const s of slots) {
      const prev = seen.get(s.startUtc);
      if (!prev || (prev.free && !s.free)) seen.set(s.startUtc, s);
    }
    const merged = [...seen.values()].sort((a, b2) => a.startUtc.localeCompare(b2.startUtc));

    days.push({
      date: dateISO,
      weekday: cursor.setLocale('en-IE').toFormat('ccc'),
      working,
      slots: merged,
    });
    cursor = cursor.plus({ days: 1 });
  }

  return days;
}

function rangeOverlap(aL: number, aU: number, bL: number, bU: number): boolean {
  return aL < bU && bL < aU;
}
