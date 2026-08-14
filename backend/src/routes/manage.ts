import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyPatientToken } from '../lib/crypto.js';
import {
  cancelWithCutoff,
  getBookingFull,
  rescheduleBooking,
  ConflictError,
  ValidationError,
} from '../lib/bookings.js';
import { localFullLabel, localTimeLabel } from '../lib/time.js';
import { emailCancelled, emailRescheduled } from '../email/notifications.js';

/** Resolve a token to a booking, checking the token_version binding. */
async function resolve(token: string) {
  const payload = verifyPatientToken(token);
  if (!payload) return null;
  const booking = await getBookingFull(payload.b);
  if (!booking) return null;
  if (booking.tokenVersion !== payload.v) return null; // stale link (rescheduled)
  return booking;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body{margin:0;background:#F2EEE6;color:#16201C;font-family:system-ui,sans-serif;padding:24px}
    .card{max-width:560px;margin:0 auto;background:#FFFDF8;border:1px solid #DCD5C7;padding:28px}
    h1{font-size:22px;margin:0 0 12px} .muted{color:#6C7A70;font-size:14px}
    .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #E4DED1}
    button,.btn{font:inherit;border:none;border-radius:999px;padding:12px 20px;cursor:pointer}
    .primary{background:#B4562F;color:#FFF8F0}.danger{background:#16201C;color:#F2EEE6}
    select,input{font:inherit;padding:10px;border:1px solid #C9C2B2;border-radius:3px;background:#FFFDF8}
    .err{background:#F7E4DE;border:1px solid #B4562F;padding:12px;border-radius:3px;margin:12px 0}
    .ok{background:#EDF1E9;border:1px solid #4E7A5E;padding:12px;border-radius:3px;margin:12px 0}
  </style></head><body><div class="card">${body}</div></body></html>`;
}

export async function manageRoutes(app: FastifyInstance) {
  app.get('/manage', async (req, reply) => {
    const token = (req.query as any)?.token as string;
    const booking = token ? await resolve(token) : null;
    reply.type('text/html');
    if (!booking) {
      return page('Link expired', `<h1>This link is no longer valid</h1>
        <p class="muted">It may have expired or the appointment may have changed. Please book again on the site.</p>
        <p><a class="btn primary" href="/#book">Go to booking</a></p>`);
    }
    const closed = ['cancelled', 'completed', 'no_show'].includes(booking.statusRaw);
    const when = `${localFullLabel(booking.startUtc)}, ${localTimeLabel(booking.startUtc)}`;
    return page('Your appointment', `
      <h1>Your appointment</h1>
      <div class="row"><span class="muted">Service</span><span>${booking.serviceName}</span></div>
      <div class="row"><span class="muted">Format</span><span>${booking.formatName}</span></div>
      <div class="row"><span class="muted">When</span><span>${when}</span></div>
      <div class="row"><span class="muted">Status</span><span>${booking.statusRaw}</span></div>
      ${
        closed
          ? `<p class="muted" style="margin-top:16px">This appointment is closed. <a href="/#book">Book another</a>.</p>`
          : `
      <h2 style="font-size:16px;margin-top:22px">Move to a new time</h2>
      <form method="POST" action="/manage/reschedule">
        <input type="hidden" name="token" value="${token}">
        <p class="muted">Pick a new slot, then confirm.</p>
        <select name="startUtc" id="slotSelect" required style="width:100%"><option>Loading times…</option></select>
        <p style="margin-top:12px"><button class="primary" type="submit">Confirm new time</button></p>
      </form>
      <h2 style="font-size:16px;margin-top:22px">Cancel</h2>
      <form method="POST" action="/manage/cancel" onsubmit="return confirm('Cancel this appointment?')">
        <input type="hidden" name="token" value="${token}">
        <button class="danger" type="submit">Cancel appointment</button>
      </form>
      <script>
        (async () => {
          const sel = document.getElementById('slotSelect');
          try {
            const data = await (await fetch('/api/manage-slots?token=${encodeURIComponent(token)}')).json();
            sel.innerHTML='';
            for (const s of data.slots) { const o=document.createElement('option'); o.value=s.startUtc; o.textContent=s.label; sel.appendChild(o); }
            if(!data.slots.length){ sel.innerHTML='<option value="">No times available</option>'; }
          } catch(e){ sel.innerHTML='<option value="">Could not load times</option>'; }
        })();
      </script>`
      }`);
  });

  // Slots for the booking's own service+format, for the reschedule dropdown.
  app.get('/api/manage-slots', async (req, reply) => {
    const token = (req.query as any)?.token as string;
    const payload = token ? verifyPatientToken(token) : null;
    if (!payload) return reply.code(400).send({ error: 'invalid_token' });
    const { rows } = await import('../lib/db.js').then((m) =>
      m.query(`SELECT b.service_id, b.format_key, s.duration_minutes
                 FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=$1`, [payload.b]),
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const { getFormat } = await import('../lib/bookings.js');
    const { getSettings } = await import('../lib/settings.js');
    const { computeAvailability } = await import('../lib/slots.js');
    const { toLocal } = await import('../lib/time.js');
    const fmt = await getFormat(row.format_key);
    const settings = await getSettings();
    const from = toLocal(new Date().toISOString()).toISODate()!;
    const to = toLocal(new Date(Date.now() + 21 * 864e5).toISOString()).toISODate()!;
    const days = await computeAvailability({
      serviceDurationMinutes: row.duration_minutes,
      format: fmt!,
      fromDate: from,
      toDate: to,
      settings,
    });
    const slots: { startUtc: string; label: string }[] = [];
    for (const d of days)
      for (const s of d.slots)
        if (s.free) slots.push({ startUtc: s.startUtc, label: `${d.weekday} ${d.date} · ${s.label}` });
    return { slots };
  });

  const tokenBody = z.object({ token: z.string().min(10), startUtc: z.string().optional() });

  app.post('/manage/cancel', async (req, reply) => {
    const parsed = tokenBody.safeParse(req.body);
    reply.type('text/html');
    if (!parsed.success) return reply.code(400).send(page('Error', '<h1>Invalid request</h1>'));
    const booking = await resolve(parsed.data.token);
    if (!booking) return reply.code(400).send(page('Error', '<h1>Link expired</h1>'));
    try {
      await cancelWithCutoff(booking.id, `patient:${booking.patientEmail}`, true);
      const fresh = await getBookingFull(booking.id);
      if (fresh) emailCancelled(fresh, 'you').catch(() => {});
      return page('Cancelled', `<h1>Your appointment is cancelled</h1>
        <div class="ok">We've let Virthy know. You can <a href="/#book">book another time</a> whenever suits.</div>`);
    } catch (e) {
      const msg = e instanceof ValidationError ? e.message : 'Something went wrong.';
      return reply.code(400).send(page('Could not cancel', `<h1>We couldn't cancel that</h1><div class="err">${msg}</div><p><a href="/manage?token=${encodeURIComponent(parsed.data.token)}">Back</a></p>`));
    }
  });

  app.post('/manage/reschedule', async (req, reply) => {
    const parsed = tokenBody.safeParse(req.body);
    reply.type('text/html');
    if (!parsed.success || !parsed.data.startUtc) {
      return reply.code(400).send(page('Error', '<h1>Please choose a new time</h1>'));
    }
    const booking = await resolve(parsed.data.token);
    if (!booking) return reply.code(400).send(page('Error', '<h1>Link expired</h1>'));
    try {
      const updated = await rescheduleBooking({
        bookingId: booking.id,
        newStartUtc: parsed.data.startUtc,
        actor: `patient:${booking.patientEmail}`,
        bySource: 'public',
      });
      emailRescheduled(updated).catch(() => {});
      return page('Moved', `<h1>Your appointment is moved</h1>
        <div class="ok">New time: ${localFullLabel(updated.startUtc)}, ${localTimeLabel(updated.startUtc)}. A confirmation is on its way.</div>`);
    } catch (e) {
      if (e instanceof ConflictError) {
        return reply.code(409).send(page('Just taken', `<h1>That time was just taken</h1>
          <div class="err">Please <a href="/manage?token=${encodeURIComponent(parsed.data.token)}">go back</a> and pick another.</div>`));
      }
      const msg = e instanceof ValidationError ? e.message : 'Something went wrong.';
      return reply.code(400).send(page('Could not move', `<h1>We couldn't move that</h1><div class="err">${msg}</div>`));
    }
  });
}
