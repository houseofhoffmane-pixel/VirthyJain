// Works out bookable start times from config, minus existing bookings, a buffer
// between appointments, and a minimum-notice window. All times are Irish local
// ('YYYY-MM-DD HH:MM:SS' strings) — no timezone maths, no libraries.

const config = require('./config');

// --- small local-time helpers ----------------------------------------------
function fmtDublin(date) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const nowLocal = () => fmtDublin(new Date());                       // "YYYY-MM-DD HH:MM"
const localOfInstant = (ms) => fmtDublin(new Date(ms));
const todayLocal = () => nowLocal().slice(0, 10);

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekdayOf(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay(); // 0=Sun..6=Sat
}
const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const toHM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// --- overlap check between a candidate slot and one existing booking --------
function conflicts(candStartMin, candEndMin, candFormat, existing) {
  const eStart = toMin(existing.starts_at.slice(11, 16));
  const eEnd = toMin(existing.ends_at.slice(11, 16));
  const travel =
    candFormat === 'home' || existing.format === 'home' ? config.homeTravelMinutes : 0;
  const pad = config.bufferMinutes + travel;
  // No conflict if there's at least `pad` clear minutes between the two.
  const clear = eEnd + pad <= candStartMin || candEndMin + pad <= eStart;
  return !clear;
}

// --- slots for one date/service/format -------------------------------------
function slotsForDate(service, formatKey, dateStr, existingSameDate, blackout) {
  // A blocked-off day (holiday / course) is treated as non-working.
  if (blackout && blackout.has(dateStr)) return { date: dateStr, working: false, slots: [] };
  const windows = (config.hours[formatKey] || {})[weekdayOf(dateStr)] || [];
  const working = windows.length > 0;
  const threshold = localOfInstant(Date.now() + config.minNoticeHours * 3600e3); // "YYYY-MM-DD HH:MM"
  const slots = [];

  for (const [open, close] of windows) {
    const openMin = toMin(open);
    const closeMin = toMin(close);
    for (let m = openMin; m + service.duration <= closeMin; m += config.slotStepMinutes) {
      const label = toHM(m);
      const startStr = `${dateStr} ${label}`;
      if (startStr < threshold) continue; // past or inside notice window

      const free = !existingSameDate.some((b) =>
        conflicts(m, m + service.duration, formatKey, b),
      );
      slots.push({ label, start: `${startStr}:00`, free });
    }
  }
  // de-dup (overlapping windows) keeping the "taken" state if any
  const byStart = new Map();
  for (const s of slots) {
    const prev = byStart.get(s.start);
    if (!prev || (prev.free && !s.free)) byStart.set(s.start, s);
  }
  return { date: dateStr, working, slots: [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start)) };
}

// --- a range of days --------------------------------------------------------
function computeRange(service, formatKey, fromDate, toDate, existing, blackout) {
  const byDate = new Map();
  for (const b of existing) {
    const d = b.starts_at.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(b);
  }
  const days = [];
  let d = fromDate;
  let guard = 0;
  while (d <= toDate && guard++ < 400) {
    days.push(slotsForDate(service, formatKey, d, byDate.get(d) || [], blackout));
    d = addDays(d, 1);
  }
  return days;
}

// Is `startStr` ("YYYY-MM-DD HH:MM:SS") an actually-offered free slot right now?
function isFreeSlot(service, formatKey, startStr, existingSameDate, blackout) {
  const date = startStr.slice(0, 10);
  const day = slotsForDate(service, formatKey, date, existingSameDate, blackout);
  return day.slots.some((s) => s.start === startStr && s.free);
}

module.exports = {
  computeRange,
  slotsForDate,
  isFreeSlot,
  nowLocal,
  localOfInstant,
  todayLocal,
  addDays,
  toMin,
  toHM,
};
