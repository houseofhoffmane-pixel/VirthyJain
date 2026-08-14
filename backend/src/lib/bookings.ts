import { Db, pool, query, withTransaction } from './db.js';
import { getSettings, Settings } from './settings.js';
import { computeAvailability, FormatRow, occupiedBounds, travelFor } from './slots.js';
import { encryptField, makePatientToken } from './crypto.js';
import { audit } from './audit.js';
import { eachLocalDate, toLocal } from './time.js';

// Postgres error code for an exclusion-constraint violation.
const EXCLUSION_VIOLATION = '23P01';

export class ConflictError extends Error {
  alternatives: { startUtc: string; label: string; date: string }[];
  constructor(alternatives: ConflictError['alternatives']) {
    super('slot_taken');
    this.name = 'ConflictError';
    this.alternatives = alternatives;
  }
}
export class ValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface ServiceRow {
  id: number;
  name: string;
  duration_minutes: number;
  price_cents: number;
  active: boolean;
}

export async function getService(id: number, client?: Db): Promise<ServiceRow | null> {
  const runner = client ?? pool;
  const { rows } = await runner.query(`SELECT * FROM services WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
export async function getFormat(key: string, client?: Db): Promise<FormatRow | null> {
  const runner = client ?? pool;
  const { rows } = await runner.query(`SELECT * FROM formats WHERE key = $1`, [key]);
  return rows[0] ?? null;
}

/** The next N bookable start times for a service+format, for conflict replies. */
export async function nextAvailable(
  serviceDurationMinutes: number,
  format: FormatRow,
  settings: Settings,
  count = 3,
  client?: Db,
): Promise<ConflictError['alternatives']> {
  const from = toLocal(new Date().toISOString()).toISODate()!;
  const to = toLocal(new Date(Date.now() + 21 * 86400_000).toISOString()).toISODate()!;
  const days = await computeAvailability({
    serviceDurationMinutes,
    format,
    fromDate: from,
    toDate: to,
    settings,
    client,
  });
  const out: ConflictError['alternatives'] = [];
  for (const d of days) {
    for (const s of d.slots) {
      if (s.free) {
        out.push({ startUtc: s.startUtc, label: s.label, date: d.date });
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

/** Is `startUtc` a start time the availability endpoint would actually offer? */
async function assertOnGrid(
  serviceDurationMinutes: number,
  format: FormatRow,
  startUtc: string,
  settings: Settings,
  client: Db,
): Promise<void> {
  const dateISO = toLocal(startUtc).toISODate()!;
  const days = await computeAvailability({
    serviceDurationMinutes,
    format,
    fromDate: dateISO,
    toDate: dateISO,
    settings,
    client,
  });
  const day = days[0];
  const target = new Date(startUtc).getTime();
  const match = day?.slots.find((s) => new Date(s.startUtc).getTime() === target);
  if (!match) throw new ValidationError('That start time is not on the schedule.');
  // `free` may be stale by a second; the DB constraint is the real guard.
}

export interface CreateInput {
  serviceId: number;
  formatKey: string;
  startUtc: string; // ISO, UTC
  patientName: string;
  patientEmail: string;
  patientPhone?: string | null;
  referrer?: string | null;
  notes?: string | null;
  source?: 'public' | 'admin';
  autoConfirm?: boolean; // admin manual bookings can be created confirmed
}

export interface CreatedBooking {
  id: number;
  token: string;
  status: string;
  startUtc: string;
  endUtc: string;
  serviceName: string;
  formatName: string;
  priceCents: number;
  durationMinutes: number;
  pendingExpiresAt: string | null;
  patientName: string;
  patientEmail: string;
  patientPhone: string | null;
  referrer: string | null;
  notes: string | null;
}

/**
 * Create a booking. The slot is (re-)checked and locked INSIDE the transaction:
 * we never trust the availability the page saw. Concurrency is guaranteed by
 * the tstzrange EXCLUDE constraint; a violation becomes a distinct
 * ConflictError carrying the next available times.
 */
export async function createBooking(input: CreateInput): Promise<CreatedBooking> {
  const now = Date.now();
  const startMs = new Date(input.startUtc).getTime();
  if (Number.isNaN(startMs)) throw new ValidationError('Invalid start time.');
  if (startMs < now) throw new ValidationError('That time is in the past.');

  return withTransaction(async (client) => {
    const settings = await getSettings(client);
    const service = await getService(input.serviceId, client);
    if (!service || !service.active) throw new ValidationError('Unknown or inactive service.');
    const format = await getFormat(input.formatKey, client);
    if (!format || !format.active) throw new ValidationError('Unknown or inactive format.');

    // NEVER trust client price/duration/end — always from the service row.
    const duration = service.duration_minutes;
    const travel = travelFor(format, settings);

    // Minimum notice (public only; admin can override for phone bookings).
    if (input.source !== 'admin') {
      if (startMs < now + settings.min_notice_hours * 3600_000) {
        throw new ValidationError('That time is inside the minimum notice period.');
      }
      await assertOnGrid(duration, format, input.startUtc, settings, client);
    }

    const b = occupiedBounds(input.startUtc, duration, settings.buffer_minutes, travel);
    const status = input.autoConfirm ? 'confirmed' : 'pending';
    const pendingExpiresAt =
      status === 'pending'
        ? new Date(now + settings.pending_expiry_hours * 3600_000).toISOString()
        : null;

    // Savepoint so that, if the exclusion constraint fires, we can roll the
    // failed INSERT back and still query for alternatives on the same client
    // (a raw failed statement would leave the whole transaction aborted).
    let bookingId: number;
    await client.query('SAVEPOINT ins');
    try {
      const { rows } = await client.query(
        `INSERT INTO bookings
           (practitioner_id, service_id, format_key, start_at, end_at, occupied,
            status, patient_name, patient_email, patient_phone, referrer,
            notes_encrypted, price_cents, duration_minutes, source, pending_expires_at)
         VALUES (1, $1, $2, $3, $4, tstzrange($5, $6), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          service.id,
          format.key,
          b.start,
          b.end,
          b.occLower,
          b.occUpper,
          status,
          input.patientName.trim(),
          input.patientEmail.trim().toLowerCase(),
          input.patientPhone?.trim() || null,
          input.referrer?.trim() || null,
          encryptField(input.notes ?? null),
          service.price_cents,
          duration,
          input.source ?? 'public',
          pendingExpiresAt,
        ],
      );
      bookingId = rows[0].id;
      await client.query('RELEASE SAVEPOINT ins');
    } catch (err: any) {
      if (err?.code === EXCLUSION_VIOLATION) {
        await client.query('ROLLBACK TO SAVEPOINT ins');
        const alts = await nextAvailable(duration, format, settings, 3, client);
        throw new ConflictError(alts);
      }
      throw err;
    }

    const token = makePatientToken(bookingId, 1);
    await audit(input.source === 'admin' ? 'admin' : 'system', 'create', 'booking', bookingId, {
      status,
      source: input.source ?? 'public',
    }, client);

    return {
      id: bookingId,
      token,
      status,
      startUtc: b.start,
      endUtc: b.end,
      serviceName: service.name,
      formatName: format.name,
      priceCents: service.price_cents,
      durationMinutes: duration,
      pendingExpiresAt,
      patientName: input.patientName.trim(),
      patientEmail: input.patientEmail.trim().toLowerCase(),
      patientPhone: input.patientPhone?.trim() || null,
      referrer: input.referrer?.trim() || null,
      notes: input.notes ?? null,
    };
  });
}

/**
 * Reschedule an existing booking to a new start. Goes through EXACTLY the same
 * concurrency guard as a new booking (the new span must be free), then bumps
 * token_version to invalidate the old link.
 */
export async function rescheduleBooking(opts: {
  bookingId: number;
  newStartUtc: string;
  actor: string;
  bySource: 'public' | 'admin';
}): Promise<CreatedBooking> {
  const now = Date.now();
  const startMs = new Date(opts.newStartUtc).getTime();
  if (Number.isNaN(startMs)) throw new ValidationError('Invalid start time.');
  if (startMs < now) throw new ValidationError('That time is in the past.');

  return withTransaction(async (client) => {
    const settings = await getSettings(client);
    // Lock the row we are moving.
    const { rows } = await client.query(
      `SELECT * FROM bookings WHERE id = $1 FOR UPDATE`,
      [opts.bookingId],
    );
    const existing = rows[0];
    if (!existing) throw new ValidationError('Booking not found.');
    if (['cancelled', 'completed', 'no_show'].includes(existing.status)) {
      throw new ValidationError('This booking can no longer be changed.');
    }

    const service = await getService(existing.service_id, client);
    const format = await getFormat(existing.format_key, client);
    if (!service || !format) throw new ValidationError('Service/format missing.');
    const duration = existing.duration_minutes;
    const travel = travelFor(format, settings);

    if (opts.bySource !== 'admin') {
      if (startMs < now + settings.min_notice_hours * 3600_000) {
        throw new ValidationError('That time is inside the minimum notice period.');
      }
      await assertOnGrid(duration, format, opts.newStartUtc, settings, client);
    }

    const b = occupiedBounds(opts.newStartUtc, duration, settings.buffer_minutes, travel);

    await client.query('SAVEPOINT resched');
    try {
      await client.query(
        `UPDATE bookings
           SET start_at = $1, end_at = $2, occupied = tstzrange($3, $4),
               token_version = token_version + 1, updated_at = now()
         WHERE id = $5`,
        [b.start, b.end, b.occLower, b.occUpper, opts.bookingId],
      );
      await client.query('RELEASE SAVEPOINT resched');
    } catch (err: any) {
      if (err?.code === EXCLUSION_VIOLATION) {
        await client.query('ROLLBACK TO SAVEPOINT resched');
        const alts = await nextAvailable(duration, format, settings, 3, client);
        throw new ConflictError(alts);
      }
      throw err;
    }

    const { rows: after } = await client.query(`SELECT * FROM bookings WHERE id = $1`, [
      opts.bookingId,
    ]);
    const row = after[0];
    const token = makePatientToken(row.id, row.token_version);
    await audit(opts.actor, 'reschedule', 'booking', row.id, {
      to: b.start,
      from: existing.start_at,
    }, client);

    return {
      id: row.id,
      token,
      status: row.status,
      startUtc: b.start,
      endUtc: b.end,
      serviceName: service.name,
      formatName: format.name,
      priceCents: row.price_cents,
      durationMinutes: duration,
      pendingExpiresAt: row.pending_expires_at,
      patientName: row.patient_name,
      patientEmail: row.patient_email,
      patientPhone: row.patient_phone,
      referrer: row.referrer,
      notes: null,
    };
  });
}

/** Load a booking joined with service/format, optionally decrypting notes.
 *  Pass `withNotes` + an actor to record the health-data access. */
export async function getBookingFull(
  bookingId: number,
  opts: { withNotes?: boolean; actor?: string; purpose?: string } = {},
): Promise<(CreatedBooking & { statusRaw: string; tokenVersion: number }) | null> {
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name, f.name AS format_name
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       JOIN formats  f ON f.key = b.format_key
      WHERE b.id = $1`,
    [bookingId],
  );
  const row = rows[0];
  if (!row) return null;

  let notes: string | null = null;
  if (opts.withNotes) {
    const { decryptField } = await import('./crypto.js');
    notes = decryptField(row.notes_encrypted);
    const { logNotesAccess } = await import('./audit.js');
    await logNotesAccess(opts.actor ?? 'system', opts.purpose ?? 'read', row.id, row.patient_email);
  }

  const { makePatientToken } = await import('./crypto.js');
  return {
    id: row.id,
    token: makePatientToken(row.id, row.token_version),
    tokenVersion: row.token_version,
    status: row.status,
    statusRaw: row.status,
    startUtc: new Date(row.start_at).toISOString(),
    endUtc: new Date(row.end_at).toISOString(),
    serviceName: row.service_name,
    formatName: row.format_name,
    priceCents: row.price_cents,
    durationMinutes: row.duration_minutes,
    pendingExpiresAt: row.pending_expires_at ? new Date(row.pending_expires_at).toISOString() : null,
    patientName: row.patient_name,
    patientEmail: row.patient_email,
    patientPhone: row.patient_phone,
    referrer: row.referrer,
    notes,
  };
}

/** Cancel enforcing the configurable cutoff (used by the patient link). */
export async function cancelWithCutoff(
  bookingId: number,
  actor: string,
  enforceCutoff: boolean,
): Promise<void> {
  await withTransaction(async (client) => {
    const settings = await getSettings(client);
    const { rows } = await client.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [
      bookingId,
    ]);
    const row = rows[0];
    if (!row) throw new ValidationError('Booking not found.');
    if (['cancelled', 'completed', 'no_show'].includes(row.status)) {
      throw new ValidationError('This booking is already closed.');
    }
    if (enforceCutoff) {
      const startMs = new Date(row.start_at).getTime();
      if (startMs - Date.now() < settings.cancel_cutoff_hours * 3600_000) {
        throw new ValidationError(
          `Appointments can't be cancelled within ${settings.cancel_cutoff_hours} hours of the start. Please phone the practice.`,
        );
      }
    }
    await client.query(
      `UPDATE bookings SET status = 'cancelled', pending_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [bookingId],
    );
    await audit(actor, 'cancel', 'booking', bookingId, { enforceCutoff }, client);
  });
}

export async function setStatus(
  bookingId: number,
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show',
  actor: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE bookings SET status = $1, updated_at = now(),
          decline_reason = COALESCE($3, decline_reason),
          pending_expires_at = NULL
        WHERE id = $2`,
      [status, bookingId, (detail.reason as string) ?? null],
    );
    await audit(actor, status === 'confirmed' ? 'confirm' : status, 'booking', bookingId, detail, client);
  });
}
