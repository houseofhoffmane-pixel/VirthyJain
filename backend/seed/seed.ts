import { migrate } from '../src/lib/migrate.js';
import { pool } from '../src/lib/db.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';

const HHMM = (h: number, m = 0) => h * 60 + m;

async function seed() {
  await migrate();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Services (idempotent by name) -------------------------------------
    const services: [string, number, number, number][] = [
      // name, duration_minutes, price_cents, sort_order
      ['Initial assessment', 55, 7000, 1],
      ['Return visit', 40, 5500, 2],
      ["Women's health", 50, 7000, 3],
      ['Sports and return-to-play', 50, 6500, 4],
    ];
    for (const [name, dur, price, sort] of services) {
      await client.query(
        `INSERT INTO services (name, duration_minutes, price_cents, sort_order, active)
         SELECT $1,$2,$3,$4,true
         WHERE NOT EXISTS (SELECT 1 FROM services WHERE name = $1)`,
        [name, dur, price, sort],
      );
    }

    // --- Formats -----------------------------------------------------------
    // Home visits leave travel_buffer at 0 so they inherit the global setting.
    const formats: [string, string, number, number][] = [
      ['clinic', 'Clinic in Dublin', 0, 1],
      ['home', 'Home visit', 0, 2],
      ['telehealth', 'Telehealth', 0, 3],
    ];
    for (const [key, name, travel, sort] of formats) {
      await client.query(
        `INSERT INTO formats (key, name, travel_buffer_minutes, sort_order, active)
         VALUES ($1,$2,$3,$4,true)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name`,
        [key, name, travel, sort],
      );
    }

    // --- Weekly templates (one per format), Monday..Friday -----------------
    // weekday: 0=Sun..6=Sat, so Mon..Fri = 1..5. Times are local minutes.
    // NOTE: window ends are CLOSING times — the appointment (plus its duration)
    // must finish by then; this is what enforces the service-duration rule.
    // Hours are fully editable in the admin panel afterwards.
    const windows: Record<string, [number, number][]> = {
      // Clinic: 08:00–11:45 and 14:00–17:45
      clinic: [[HHMM(8), HHMM(11, 45)], [HHMM(14), HHMM(17, 45)]],
      // Home: afternoons + evenings, up to 19:15 (travel buffer applied to span)
      home: [[HHMM(14), HHMM(19, 15)]],
      // Telehealth: mornings + two evening slots (18:30 & 19:15)
      telehealth: [[HHMM(8), HHMM(11, 45)], [HHMM(18, 30), HHMM(20, 15)]],
    };
    await client.query(`DELETE FROM availability_templates`);
    for (const [fmt, wins] of Object.entries(windows)) {
      for (let weekday = 1; weekday <= 5; weekday++) {
        for (const [start, end] of wins) {
          await client.query(
            `INSERT INTO availability_templates (format_key, weekday, start_min, end_min)
             VALUES ($1,$2,$3,$4)`,
            [fmt, weekday, start, end],
          );
        }
      }
    }

    // --- Default settings --------------------------------------------------
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO NOTHING`,
        [k, String(v)],
      );
    }

    await client.query('COMMIT');
    console.log('Seed complete: 4 services, 3 format templates (Mon–Fri), defaults.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

seed()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
