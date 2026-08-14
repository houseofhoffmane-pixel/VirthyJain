import { Db, pool } from './db.js';

export async function audit(
  actor: string,
  action: string,
  entity: string,
  entityId: string | number | null,
  detail: Record<string, unknown> = {},
  client?: Db,
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, entity, entityId == null ? null : String(entityId), detail],
  );
}

/** Record any access to a patient's health notes (GDPR accountability). */
export async function logNotesAccess(
  actor: string,
  purpose: string,
  bookingId: number | null,
  patientEmail: string | null,
  client?: Db,
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO notes_access_log (actor, purpose, booking_id, patient_email)
     VALUES ($1, $2, $3, $4)`,
    [actor, purpose, bookingId, patientEmail],
  );
}
