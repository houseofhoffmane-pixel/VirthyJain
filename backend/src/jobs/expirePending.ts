import { query } from '../lib/db.js';
import { getBookingFull } from '../lib/bookings.js';
import { audit } from '../lib/audit.js';
import { emailPendingExpired } from '../email/notifications.js';

/**
 * Expire pending requests past their hold window. Expiring flips status to
 * 'cancelled', which drops the row out of the EXCLUDE constraint's WHERE
 * clause and so releases the slot immediately. The patient is notified.
 * Idempotent and safe to run on an interval and/or via cron.
 */
export async function expirePending(): Promise<number> {
  const { rows } = await query(
    `UPDATE bookings
        SET status = 'cancelled', pending_expires_at = NULL, updated_at = now(),
            decline_reason = 'expired'
      WHERE status = 'pending' AND pending_expires_at IS NOT NULL
        AND pending_expires_at < now()
      RETURNING id`,
  );
  for (const r of rows as { id: number }[]) {
    await audit('system', 'expire', 'booking', r.id, {});
    const b = await getBookingFull(r.id);
    if (b) emailPendingExpired(b).catch(() => {});
  }
  return rows.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { closePool } = await import('../lib/db.js');
  const n = await expirePending();
  console.log(`Expired ${n} pending booking(s).`);
  await closePool();
}
