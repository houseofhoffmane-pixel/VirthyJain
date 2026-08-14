import { pool } from './db.js';
import { DEFAULT_SETTINGS } from './settings.js';

const HHMM = (h: number, m = 0) => h * 60 + m;

/**
 * Insert the initial services, formats, weekly templates and default settings.
 * Idempotent and NON-destructive: existing rows are left alone, and templates
 * are only seeded for a format that has none yet — so hours edited in the admin
 * panel are never overwritten, even if this runs again. Assumes migrations have
 * already been applied.
 */
export async function seedInitialData(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const services: [string, number, number, number][] = [
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

    // Window ends are CLOSING times (appointment + duration must finish by then).
    const windows: Record<string, [number, number][]> = {
      clinic: [[HHMM(8), HHMM(11, 45)], [HHMM(14), HHMM(17, 45)]],
      home: [[HHMM(14), HHMM(19, 15)]],
      telehealth: [[HHMM(8), HHMM(11, 45)], [HHMM(18, 30), HHMM(20, 15)]],
    };
    for (const [fmt, wins] of Object.entries(windows)) {
      const existing = await client.query(
        `SELECT 1 FROM availability_templates WHERE format_key = $1 LIMIT 1`,
        [fmt],
      );
      if ((existing.rowCount ?? 0) > 0) continue; // preserve admin-edited hours
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

    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO NOTHING`,
        [k, String(v)],
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Run directly: `npm run seed` (applies migrations first, then seeds).
if (import.meta.url === `file://${process.argv[1]}`) {
  const run = async () => {
    const { migrate } = await import('./migrate.js');
    await migrate();
    await seedInitialData();
    await pool.end();
    console.log('Seed complete: 4 services, 3 format templates (Mon–Fri), defaults.');
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
