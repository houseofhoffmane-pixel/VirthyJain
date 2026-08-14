import { Db, pool, query } from './db.js';

// Configurable operational settings, all editable in the admin panel.
export interface Settings {
  buffer_minutes: number;          // gap enforced between appointments
  min_notice_hours: number;        // nobody books inside the next N hours
  travel_buffer_minutes: number;   // default home-visit travel (per format overrides)
  pending_expiry_hours: number;    // auto-expire a pending request after N hours
  cancel_cutoff_hours: number;     // cannot cancel inside N hours of the start
  slot_granularity_minutes: number;// grid spacing for offered start times
}

export const DEFAULT_SETTINGS: Settings = {
  buffer_minutes: 10,
  min_notice_hours: 12,
  travel_buffer_minutes: 30,
  pending_expiry_hours: 24,
  cancel_cutoff_hours: 12,
  slot_granularity_minutes: 15,
};

const NUMERIC_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export async function getSettings(client?: Db): Promise<Settings> {
  const runner = client ?? pool;
  const { rows } = await runner.query('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows as { key: string; value: string }[]) {
    if ((NUMERIC_KEYS as string[]).includes(r.key)) {
      const n = Number(r.value);
      if (!Number.isNaN(n)) (out as any)[r.key] = n;
    }
  }
  return out;
}

export async function setSetting(key: keyof Settings, value: number): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)],
  );
}
