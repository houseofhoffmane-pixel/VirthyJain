import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { pool, query } from '../src/lib/db.js';
import { migrate } from '../src/lib/migrate.js';
import {
  createBooking,
  rescheduleBooking,
  ConflictError,
} from '../src/lib/bookings.js';
import { localWallToUtc } from '../src/lib/time.js';

// These tests require a reachable Postgres (DATABASE_URL). If it isn't up, the
// suite skips rather than failing, so `npm test` is safe without a DB.
let dbUp = false;
try {
  await pool.query('SELECT 1');
  dbUp = true;
} catch {
  dbUp = false;
}

const HHMM = (h: number, m = 0) => h * 60 + m;

// A Monday ~4 weeks out (well outside the 12h notice window, a working day).
function futureMonday(): string {
  return DateTime.now().setZone('Europe/Dublin').plus({ days: 28 }).startOf('week').toISODate()!;
}

async function serviceId(name: string): Promise<number> {
  const { rows } = await query(`SELECT id FROM services WHERE name = $1`, [name]);
  return rows[0].id;
}

describe.skipIf(!dbUp)('booking concurrency guarantees', () => {
  beforeAll(async () => {
    await migrate();
    // Ensure the fixtures we rely on exist (seed is idempotent enough here).
    await query(
      `INSERT INTO services (name,duration_minutes,price_cents,sort_order)
       SELECT 'Initial assessment',55,7000,1 WHERE NOT EXISTS (SELECT 1 FROM services WHERE name='Initial assessment')`,
    );
    await query(
      `INSERT INTO services (name,duration_minutes,price_cents,sort_order)
       SELECT 'Return visit',40,5500,2 WHERE NOT EXISTS (SELECT 1 FROM services WHERE name='Return visit')`,
    );
    await query(
      `INSERT INTO formats (key,name,sort_order) VALUES ('clinic','Clinic in Dublin',1)
       ON CONFLICT (key) DO NOTHING`,
    );
    // Clinic hours Mon–Fri so our chosen slots are on the grid.
    await query(`DELETE FROM availability_templates WHERE format_key='clinic'`);
    for (let wd = 1; wd <= 5; wd++) {
      await query(
        `INSERT INTO availability_templates (format_key,weekday,start_min,end_min)
         VALUES ('clinic',$1,$2,$3),('clinic',$1,$4,$5)`,
        [wd, HHMM(8), HHMM(11, 45), HHMM(14), HHMM(17, 45)],
      );
    }
  });

  beforeEach(async () => {
    // Clean slate for bookings each test.
    await query(`DELETE FROM bookings`);
  });

  // (1) Two simultaneous requests for the SAME slot: exactly one wins.
  it('lets exactly one of two simultaneous requests win the same slot', async () => {
    const svc = await serviceId('Initial assessment');
    const startUtc = localWallToUtc(futureMonday(), HHMM(9)); // 09:00 clinic

    const mk = (email: string) =>
      createBooking({
        serviceId: svc,
        formatKey: 'clinic',
        startUtc,
        patientName: 'Test Patient',
        patientEmail: email,
        source: 'public',
      });

    const results = await Promise.allSettled([mk('a@example.com'), mk('b@example.com')]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);
    // The conflict reply carries next available times for the front end.
    expect((rejected[0].reason as ConflictError).alternatives.length).toBeGreaterThan(0);

    const count = await query(
      `SELECT count(*)::int AS n FROM bookings WHERE start_at = $1 AND status IN ('pending','confirmed')`,
      [startUtc],
    );
    expect(count.rows[0].n).toBe(1);
  });

  // (2) An overlapping booking of a DIFFERENT duration is blocked.
  //     A 40-min Return at 14:00 must block a 55-min Initial starting 14:30.
  it('blocks an overlapping booking of a different duration', async () => {
    const ret = await serviceId('Return visit'); // 40 min
    const init = await serviceId('Initial assessment'); // 55 min
    const day = futureMonday();

    await createBooking({
      serviceId: ret,
      formatKey: 'clinic',
      startUtc: localWallToUtc(day, HHMM(14)), // 14:00–14:40 (+buffer)
      patientName: 'First',
      patientEmail: 'first@example.com',
      source: 'public',
    });

    await expect(
      createBooking({
        serviceId: init,
        formatKey: 'clinic',
        startUtc: localWallToUtc(day, HHMM(14, 30)), // overlaps 14:00–14:40
        patientName: 'Second',
        patientEmail: 'second@example.com',
        source: 'public',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  // (3) Reschedule into a slot taken while the patient read the email.
  it('rejects a reschedule into a slot that was taken meanwhile', async () => {
    const svc = await serviceId('Initial assessment');
    const day = futureMonday();
    const slotX = localWallToUtc(day, HHMM(9)); // target, will be taken
    const slotY = localWallToUtc(day, HHMM(11)); // where B currently sits

    // A takes slot X.
    await createBooking({
      serviceId: svc,
      formatKey: 'clinic',
      startUtc: slotX,
      patientName: 'A',
      patientEmail: 'a@example.com',
      source: 'public',
    });

    // B is booked at slot Y.
    const b = await createBooking({
      serviceId: svc,
      formatKey: 'clinic',
      startUtc: slotY,
      patientName: 'B',
      patientEmail: 'b@example.com',
      source: 'public',
    });

    // B, reading a now-stale email, tries to move into X.
    await expect(
      rescheduleBooking({
        bookingId: b.id,
        newStartUtc: slotX,
        actor: 'patient:b@example.com',
        bySource: 'public',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // B is untouched at slot Y.
    const row = await query(`SELECT start_at FROM bookings WHERE id = $1`, [b.id]);
    expect(new Date(row.rows[0].start_at).toISOString()).toBe(new Date(slotY).toISOString());
  });
});
