import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { query, withTransaction } from '../lib/db.js';
import { config } from '../config.js';
import {
  clearSession,
  issueSession,
  requireAdmin,
  verifyCredentials,
} from '../middleware/auth.js';
import { layout, esc, money } from '../admin/ui.js';
import {
  createBooking,
  getBookingFull,
  rescheduleBooking,
  setStatus,
  cancelWithCutoff,
  ConflictError,
  ValidationError,
} from '../lib/bookings.js';
import { getSettings, setSetting, Settings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { localWallToUtc, toLocal, localFullLabel, localTimeLabel, ZONE } from '../lib/time.js';
import {
  emailConfirmed,
  emailDeclined,
  emailCancelled,
  emailRescheduled,
} from '../email/notifications.js';

function flashFrom(req: FastifyRequest): { ok?: string; err?: string } {
  const q = req.query as any;
  return { ok: q?.ok, err: q?.err };
}
function redir(reply: FastifyReply, path: string, msg?: { ok?: string; err?: string }) {
  const qs = msg?.ok ? `?ok=${encodeURIComponent(msg.ok)}` : msg?.err ? `?err=${encodeURIComponent(msg.err)}` : '';
  reply.redirect(path + qs);
}

export async function adminRoutes(app: FastifyInstance) {
  // --- Auth ----------------------------------------------------------------
  app.get('/admin/login', async (req, reply) => {
    reply.type('text/html').send(`<!doctype html><meta charset=utf-8>
      <meta name=viewport content="width=device-width, initial-scale=1">
      <title>Sign in · Virthy admin</title>
      <body style="font-family:system-ui;background:#F2EEE6;display:grid;place-items:center;height:100vh;margin:0">
      <form method="POST" action="/admin/login" style="background:#FFFDF8;border:1px solid #DCD5C7;padding:28px;border-radius:8px;width:320px">
        <h1 style="font-size:20px;margin:0 0 16px">Virthy admin</h1>
        ${(req.query as any)?.err ? '<p style="color:#B4562F;font-size:13px">Wrong email or password.</p>' : ''}
        <input name="email" type="email" placeholder="Email" required style="width:100%;padding:11px;margin-bottom:8px;border:1px solid #C9C2B2;border-radius:4px">
        <input name="password" type="password" placeholder="Password" required style="width:100%;padding:11px;margin-bottom:12px;border:1px solid #C9C2B2;border-radius:4px">
        <button style="width:100%;padding:12px;border:none;border-radius:999px;background:#B4562F;color:#FFF8F0;font:inherit;cursor:pointer">Sign in</button>
      </form></body>`);
  });

  app.post('/admin/login', async (req, reply) => {
    const body = z.object({ email: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return redir(reply, '/admin/login', { err: '1' });
    const ok = await verifyCredentials(body.data.email, body.data.password);
    if (!ok) {
      await audit(body.data.email, 'login_failed', 'session', null, {});
      return reply.redirect('/admin/login?err=1');
    }
    issueSession(reply, config.adminEmail);
    await audit(config.adminEmail, 'login', 'session', null, {});
    reply.redirect('/admin');
  });

  app.post('/admin/logout', async (req, reply) => {
    clearSession(reply);
    reply.redirect('/admin/login');
  });

  // Guard everything else under /admin.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/admin')) return;
    if (req.url.startsWith('/admin/login') || req.url.startsWith('/admin/logout')) return;
    const email = requireAdmin(req, reply);
    if (!email) return reply; // requireAdmin already redirected/401'd
    (req as any).adminEmail = email;
  });

  // --- Week view -----------------------------------------------------------
  app.get('/admin', async (req, reply) => {
    const weekParam = (req.query as any)?.week as string | undefined;
    const anchor = weekParam
      ? DateTime.fromISO(weekParam, { zone: ZONE })
      : DateTime.now().setZone(ZONE);
    const monday = anchor.startOf('week'); // Luxon week starts Monday
    const startUtc = monday.toUTC().toISO()!;
    const endUtc = monday.plus({ days: 7 }).toUTC().toISO()!;

    const { rows } = await query(
      `SELECT b.id, b.start_at, b.end_at, b.status, b.patient_name, b.format_key,
              s.name AS service_name
         FROM bookings b JOIN services s ON s.id=b.service_id
        WHERE b.start_at >= $1 AND b.start_at < $2
          AND b.status IN ('pending','confirmed','completed','no_show')
        ORDER BY b.start_at`,
      [startUtc, endUtc],
    );

    const byDay = new Map<string, any[]>();
    for (let i = 0; i < 7; i++) byDay.set(monday.plus({ days: i }).toISODate()!, []);
    for (const r of rows) {
      const d = toLocal(r.start_at).toISODate()!;
      byDay.get(d)?.push(r);
    }
    const pendingCount = rows.filter((r: any) => r.status === 'pending').length;

    const daysHtml = [...byDay.entries()]
      .map(([date, appts]) => {
        const head = DateTime.fromISO(date, { zone: ZONE }).toFormat('ccc d LLL');
        const items = appts.length
          ? appts
              .map(
                (a) => `<div class="appt">
              <div><a href="/admin/booking/${a.id}"><strong>${localTimeLabel(a.start_at)}</strong> ${esc(a.patient_name)}</a>
                <div class="muted">${esc(a.service_name)} · ${esc(a.format_key)}</div></div>
              <span class="pill ${a.status}">${a.status}</span></div>`,
              )
              .join('')
          : '<div class="appt muted">—</div>';
        return `<div class="day"><h3>${head}</h3>${items}</div>`;
      })
      .join('');

    const body = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h1>Week of ${monday.toFormat('d LLL yyyy')}</h1>
        <div>
          <a class="btn ghost small" href="/admin?week=${monday.minus({ days: 7 }).toISODate()}">← Prev</a>
          <a class="btn ghost small" href="/admin?week=${monday.plus({ days: 7 }).toISODate()}">Next →</a>
        </div>
      </div>
      ${pendingCount ? `<div class="flash err">${pendingCount} request(s) awaiting your confirmation.</div>` : ''}
      <div class="cols week">${daysHtml}</div>`;
    reply.type('text/html').send(layout('/admin', 'Week', body, flashFrom(req)));
  });

  // --- Booking detail + patient history ------------------------------------
  app.get('/admin/booking/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const actor = (req as any).adminEmail as string;
    const b = await getBookingFull(id, { withNotes: true, actor, purpose: 'admin_view' });
    if (!b) return reply.code(404).type('text/html').send(layout('/admin', 'Not found', '<h1>Booking not found</h1>'));

    const history = (
      await query(
        `SELECT id, start_at, status, service_id FROM bookings
          WHERE lower(patient_email)=lower($1) AND id<>$2 ORDER BY start_at DESC LIMIT 20`,
        [b.patientEmail, id],
      )
    ).rows;

    const when = `${localFullLabel(b.startUtc)}, ${localTimeLabel(b.startUtc)}`;
    const actions =
      b.statusRaw === 'pending'
        ? `
        <form class="grid" method="POST" action="/admin/booking/${id}/confirm">
          <label>Optional note to the patient</label><input name="note" placeholder="e.g. Please arrive 5 minutes early">
          <button class="primary" type="submit">Confirm request</button>
        </form>
        <form class="grid" method="POST" action="/admin/booking/${id}/decline" style="margin-top:8px">
          <label>Reason (optional, included in email)</label><input name="note">
          <button class="dark" type="submit">Decline</button>
        </form>`
        : b.statusRaw === 'confirmed'
        ? `<form class="inline" method="POST" action="/admin/booking/${id}/complete"><button class="ghost small">Mark completed</button></form>
           <form class="inline" method="POST" action="/admin/booking/${id}/no-show"><button class="ghost small">No show</button></form>`
        : '';

    const canMove = ['pending', 'confirmed'].includes(b.statusRaw);
    const body = `
      <p><a href="/admin">← Week</a></p>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h1 style="margin:0">${esc(b.patientName)}</h1><span class="pill ${b.statusRaw}">${b.statusRaw}</span>
        </div>
        <div class="row"><span class="muted">Service</span><span>${esc(b.serviceName)} · ${b.durationMinutes} min · ${money(b.priceCents)}</span></div>
        <div class="row"><span class="muted">Format</span><span>${esc(b.formatName)}</span></div>
        <div class="row"><span class="muted">When</span><span>${when}</span></div>
        <div class="row"><span class="muted">Email</span><span>${esc(b.patientEmail)}</span></div>
        <div class="row"><span class="muted">Phone</span><span>${esc(b.patientPhone ?? '—')}</span></div>
        <div class="row"><span class="muted">Referred by</span><span>${esc(b.referrer ?? '—')}</span></div>
        <div style="margin-top:10px"><div class="muted">Notes (health data — this view is logged)</div>
          <div style="white-space:pre-wrap;background:#F7F4EE;border:1px solid #E4DED1;padding:10px;border-radius:4px;margin-top:4px">${esc(b.notes ?? '(none)')}</div></div>
      </div>
      <div class="card"><h2>Actions</h2>${actions || '<p class="muted">No actions for this status.</p>'}
        ${
          canMove
            ? `<hr style="border:none;border-top:1px solid #EFEAE0;margin:12px 0">
        <form class="grid" method="POST" action="/admin/booking/${id}/reschedule">
          <label>Move to (date &amp; time, Irish)</label>
          <input name="localDateTime" type="datetime-local" required>
          <button class="ghost" type="submit">Move appointment</button>
        </form>
        <form class="inline" method="POST" action="/admin/booking/${id}/cancel" onsubmit="return confirm('Cancel and notify patient?')" style="margin-top:8px">
          <button class="dark" type="submit">Cancel appointment</button></form>`
            : ''
        }
      </div>
      <div class="card"><h2>Patient history</h2>
        ${
          history.length
            ? `<table>${history
                .map(
                  (h: any) =>
                    `<tr><td><a href="/admin/booking/${h.id}">${localFullLabel(h.start_at)} ${localTimeLabel(h.start_at)}</a></td><td><span class="pill ${h.status}">${h.status}</span></td></tr>`,
                )
                .join('')}</table>`
            : '<p class="muted">No other bookings for this email.</p>'
        }
      </div>`;
    reply.type('text/html').send(layout('/admin', b.patientName, body, flashFrom(req)));
  });

  // --- Booking status actions ---------------------------------------------
  async function withBooking(id: number) {
    return getBookingFull(id);
  }

  app.post('/admin/booking/:id/confirm', async (req, reply) => {
    const id = Number((req.params as any).id);
    const note = ((req.body as any)?.note as string) || undefined;
    const actor = (req as any).adminEmail;
    await setStatus(id, 'confirmed', actor, { note });
    const b = await withBooking(id);
    if (b) emailConfirmed(b, note).catch(() => {});
    redir(reply, `/admin/booking/${id}`, { ok: 'Confirmed and patient emailed.' });
  });

  app.post('/admin/booking/:id/decline', async (req, reply) => {
    const id = Number((req.params as any).id);
    const note = ((req.body as any)?.note as string) || undefined;
    const actor = (req as any).adminEmail;
    const b = await withBooking(id);
    await setStatus(id, 'cancelled', actor, { reason: note, declined: true });
    if (b) emailDeclined(b, note).catch(() => {});
    redir(reply, '/admin', { ok: 'Declined and patient emailed.' });
  });

  app.post('/admin/booking/:id/cancel', async (req, reply) => {
    const id = Number((req.params as any).id);
    const actor = (req as any).adminEmail;
    const b = await withBooking(id);
    await cancelWithCutoff(id, actor, false); // admin may override cutoff
    if (b) emailCancelled(b, 'the practice').catch(() => {});
    redir(reply, '/admin', { ok: 'Cancelled and patient emailed.' });
  });

  app.post('/admin/booking/:id/complete', async (req, reply) => {
    await setStatus(Number((req.params as any).id), 'completed', (req as any).adminEmail);
    redir(reply, `/admin/booking/${(req.params as any).id}`, { ok: 'Marked completed.' });
  });
  app.post('/admin/booking/:id/no-show', async (req, reply) => {
    await setStatus(Number((req.params as any).id), 'no_show', (req as any).adminEmail);
    redir(reply, `/admin/booking/${(req.params as any).id}`, { ok: 'Marked no-show.' });
  });

  app.post('/admin/booking/:id/reschedule', async (req, reply) => {
    const id = Number((req.params as any).id);
    const local = (req.body as any)?.localDateTime as string; // e.g. 2026-08-20T14:30
    if (!local) return redir(reply, `/admin/booking/${id}`, { err: 'Pick a time.' });
    const [date, time] = local.split('T');
    const mins = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const startUtc = localWallToUtc(date, mins);
    try {
      const updated = await rescheduleBooking({
        bookingId: id,
        newStartUtc: startUtc,
        actor: (req as any).adminEmail,
        bySource: 'admin',
      });
      emailRescheduled(updated).catch(() => {});
      redir(reply, `/admin/booking/${id}`, { ok: 'Moved and patient emailed.' });
    } catch (e) {
      const msg = e instanceof ConflictError ? 'That time overlaps another booking.' : (e as Error).message;
      redir(reply, `/admin/booking/${id}`, { err: msg });
    }
  });

  // --- Manual booking (patient phoned) ------------------------------------
  app.get('/admin/new', async (req, reply) => {
    const services = (await query(`SELECT id,name FROM services WHERE active ORDER BY sort_order`)).rows;
    const formats = (await query(`SELECT key,name FROM formats WHERE active ORDER BY sort_order`)).rows;
    const body = `<h1>Add a booking</h1>
      <div class="card"><form class="grid" method="POST" action="/admin/new">
        <label>Service</label><select name="serviceId">${services
          .map((s: any) => `<option value="${s.id}">${esc(s.name)}</option>`)
          .join('')}</select>
        <label>Format</label><select name="format">${formats
          .map((f: any) => `<option value="${esc(f.key)}">${esc(f.name)}</option>`)
          .join('')}</select>
        <label>Date &amp; time (Irish)</label><input name="localDateTime" type="datetime-local" required>
        <label>Patient name</label><input name="name" required>
        <label>Email</label><input name="email" type="email" required>
        <label>Phone</label><input name="phone">
        <label>Referred by</label><input name="referrer">
        <label>Notes</label><textarea name="notes" rows="3"></textarea>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="confirm" checked style="width:auto"> Create as confirmed</label>
        <button class="primary" type="submit">Create booking</button>
      </form></div>`;
    reply.type('text/html').send(layout('/admin/new', 'Add booking', body, flashFrom(req)));
  });

  app.post('/admin/new', async (req, reply) => {
    const b = req.body as any;
    const [date, time] = String(b.localDateTime).split('T');
    if (!date || !time) return redir(reply, '/admin/new', { err: 'Invalid date/time.' });
    const mins = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    try {
      const created = await createBooking({
        serviceId: Number(b.serviceId),
        formatKey: b.format,
        startUtc: localWallToUtc(date, mins),
        patientName: b.name,
        patientEmail: b.email,
        patientPhone: b.phone || null,
        referrer: b.referrer || null,
        notes: b.notes || null,
        source: 'admin',
        autoConfirm: !!b.confirm,
      });
      if (b.confirm) emailConfirmed(created).catch(() => {});
      redir(reply, `/admin/booking/${created.id}`, { ok: 'Booking created.' });
    } catch (e) {
      const msg = e instanceof ConflictError ? 'That time overlaps another booking.' : (e as Error).message;
      redir(reply, '/admin/new', { err: msg });
    }
  });

  // --- Upcoming list -------------------------------------------------------
  app.get('/admin/upcoming', async (req, reply) => {
    const { rows } = await query(
      `SELECT b.id,b.start_at,b.status,b.patient_name,b.format_key,s.name AS service_name
         FROM bookings b JOIN services s ON s.id=b.service_id
        WHERE b.start_at >= now() AND b.status IN ('pending','confirmed')
        ORDER BY b.start_at LIMIT 100`,
    );
    const body = `<h1>Upcoming</h1><div class="card">${
      rows.length
        ? `<table><tr><th>When</th><th>Patient</th><th>Service</th><th></th></tr>${rows
            .map(
              (r: any) =>
                `<tr><td>${localFullLabel(r.start_at)} ${localTimeLabel(r.start_at)}</td><td><a href="/admin/booking/${r.id}">${esc(r.patient_name)}</a></td><td>${esc(r.service_name)}</td><td><span class="pill ${r.status}">${r.status}</span></td></tr>`,
            )
            .join('')}</table>`
        : '<p class="muted">Nothing upcoming.</p>'
    }</div>`;
    reply.type('text/html').send(layout('/admin/upcoming', 'Upcoming', body, flashFrom(req)));
  });

  // --- Blackouts -----------------------------------------------------------
  app.get('/admin/blackouts', async (req, reply) => {
    const rows = (await query(`SELECT * FROM blackouts ORDER BY start_at DESC`)).rows;
    const body = `<h1>Blackouts</h1>
      <div class="card"><h2>Add a blackout</h2>
        <form class="grid" method="POST" action="/admin/blackouts">
          <label>From (Irish)</label><input name="from" type="datetime-local" required>
          <label>To (Irish)</label><input name="to" type="datetime-local" required>
          <label>Reason</label><input name="reason" placeholder="Holiday, course, ...">
          <button class="primary">Add</button>
        </form></div>
      <div class="card"><h2>Current</h2>${
        rows.length
          ? rows
              .map(
                (r: any) => `<div class="row"><span>${localFullLabel(r.start_at)} ${localTimeLabel(r.start_at)} → ${localFullLabel(r.end_at)} ${localTimeLabel(r.end_at)} <span class="muted">${esc(r.reason)}</span></span>
                <form class="inline" method="POST" action="/admin/blackouts/${r.id}/delete"><button class="ghost small">Remove</button></form></div>`,
              )
              .join('')
          : '<p class="muted">None.</p>'
      }</div>`;
    reply.type('text/html').send(layout('/admin/blackouts', 'Blackouts', body, flashFrom(req)));
  });

  app.post('/admin/blackouts', async (req, reply) => {
    const b = req.body as any;
    const toUtc = (s: string) => {
      const [d, t] = s.split('T');
      return localWallToUtc(d, Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
    };
    await query(`INSERT INTO blackouts(start_at,end_at,reason) VALUES ($1,$2,$3)`, [
      toUtc(b.from),
      toUtc(b.to),
      b.reason || '',
    ]);
    await audit((req as any).adminEmail, 'create', 'blackout', null, { reason: b.reason });
    redir(reply, '/admin/blackouts', { ok: 'Blackout added.' });
  });
  app.post('/admin/blackouts/:id/delete', async (req, reply) => {
    await query(`DELETE FROM blackouts WHERE id=$1`, [Number((req.params as any).id)]);
    await audit((req as any).adminEmail, 'delete', 'blackout', (req.params as any).id, {});
    redir(reply, '/admin/blackouts', { ok: 'Removed.' });
  });

  // --- Weekly templates (hours) per format ---------------------------------
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  app.get('/admin/templates', async (req, reply) => {
    const formats = (await query(`SELECT key,name FROM formats ORDER BY sort_order`)).rows;
    const templates = (await query(`SELECT * FROM availability_templates ORDER BY format_key,weekday,start_min`)).rows;
    const fmtBlocks = formats
      .map((f: any) => {
        const rows = templates.filter((t: any) => t.format_key === f.key);
        const list = rows.length
          ? rows
              .map(
                (t: any) => `<div class="row"><span>${WD[t.weekday]} ${fmtMin(t.start_min)}–${fmtMin(t.end_min)}</span>
                <form class="inline" method="POST" action="/admin/templates/${t.id}/delete"><button class="ghost small">Remove</button></form></div>`,
              )
              .join('')
          : '<p class="muted">No hours set.</p>';
        return `<div class="card"><h2>${esc(f.name)}</h2>${list}
          <form class="grid" method="POST" action="/admin/templates" style="margin-top:10px">
            <input type="hidden" name="format" value="${esc(f.key)}">
            <label>Weekday</label><select name="weekday">${WD.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select>
            <div style="display:flex;gap:8px"><div style="flex:1"><label>Start</label><input name="start" type="time" required></div>
            <div style="flex:1"><label>End</label><input name="end" type="time" required></div></div>
            <button class="ghost">Add hours</button>
          </form></div>`;
      })
      .join('');
    reply.type('text/html').send(layout('/admin/templates', 'Hours', `<h1>Weekly hours</h1>${fmtBlocks}`, flashFrom(req)));
  });

  app.post('/admin/templates', async (req, reply) => {
    const b = req.body as any;
    const s = Number(b.start.slice(0, 2)) * 60 + Number(b.start.slice(3, 5));
    const e = Number(b.end.slice(0, 2)) * 60 + Number(b.end.slice(3, 5));
    if (e <= s) return redir(reply, '/admin/templates', { err: 'End must be after start.' });
    await query(
      `INSERT INTO availability_templates(format_key,weekday,start_min,end_min) VALUES ($1,$2,$3,$4)`,
      [b.format, Number(b.weekday), s, e],
    );
    await audit((req as any).adminEmail, 'create', 'template', null, { format: b.format });
    redir(reply, '/admin/templates', { ok: 'Hours added.' });
  });
  app.post('/admin/templates/:id/delete', async (req, reply) => {
    await query(`DELETE FROM availability_templates WHERE id=$1`, [Number((req.params as any).id)]);
    redir(reply, '/admin/templates', { ok: 'Removed.' });
  });

  // --- Services ------------------------------------------------------------
  app.get('/admin/services', async (req, reply) => {
    const rows = (await query(`SELECT * FROM services ORDER BY sort_order,id`)).rows;
    const list = rows
      .map(
        (s: any) => `<div class="card"><form class="grid" method="POST" action="/admin/services/${s.id}">
        <div style="display:flex;justify-content:space-between"><h2 style="margin:0">${esc(s.name)}</h2>${s.active ? '<span class="pill confirmed">active</span>' : '<span class="pill cancelled">inactive</span>'}</div>
        <label>Name</label><input name="name" value="${esc(s.name)}">
        <div style="display:flex;gap:8px"><div style="flex:1"><label>Duration (min)</label><input name="duration" type="number" value="${s.duration_minutes}"></div>
        <div style="flex:1"><label>Price (€)</label><input name="price" type="number" step="0.01" value="${(s.price_cents / 100).toFixed(2)}"></div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="primary small" type="submit">Save</button>
        <button class="ghost small" formaction="/admin/services/${s.id}/toggle" formmethod="POST" type="submit">${s.active ? 'Deactivate' : 'Reactivate'}</button></div>
      </form></div>`,
      )
      .join('');
    const add = `<div class="card"><h2>Add a service</h2><form class="grid" method="POST" action="/admin/services">
      <label>Name</label><input name="name" required>
      <div style="display:flex;gap:8px"><div style="flex:1"><label>Duration (min)</label><input name="duration" type="number" required></div>
      <div style="flex:1"><label>Price (€)</label><input name="price" type="number" step="0.01" required></div></div>
      <button class="primary">Add service</button></form></div>`;
    reply.type('text/html').send(layout('/admin/services', 'Services', `<h1>Services</h1>${list}${add}`, flashFrom(req)));
  });

  app.post('/admin/services', async (req, reply) => {
    const b = req.body as any;
    await query(
      `INSERT INTO services(name,duration_minutes,price_cents,sort_order) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM services))`,
      [b.name, Number(b.duration), Math.round(Number(b.price) * 100)],
    );
    await audit((req as any).adminEmail, 'create', 'service', null, { name: b.name });
    redir(reply, '/admin/services', { ok: 'Service added.' });
  });
  app.post('/admin/services/:id', async (req, reply) => {
    const b = req.body as any;
    const id = Number((req.params as any).id);
    await query(
      `UPDATE services SET name=$1,duration_minutes=$2,price_cents=$3,updated_at=now() WHERE id=$4`,
      [b.name, Number(b.duration), Math.round(Number(b.price) * 100), id],
    );
    await audit((req as any).adminEmail, 'update', 'service', id, { name: b.name });
    redir(reply, '/admin/services', { ok: 'Saved.' });
  });
  app.post('/admin/services/:id/toggle', async (req, reply) => {
    const id = Number((req.params as any).id);
    await query(`UPDATE services SET active = NOT active WHERE id=$1`, [id]);
    await audit((req as any).adminEmail, 'toggle_active', 'service', id, {});
    redir(reply, '/admin/services', { ok: 'Updated (history preserved).' });
  });

  // --- Settings ------------------------------------------------------------
  app.get('/admin/settings', async (req, reply) => {
    const s = await getSettings();
    const field = (k: keyof Settings, label: string) =>
      `<label>${label}</label><input name="${k}" type="number" value="${s[k]}">`;
    const body = `<h1>Settings</h1><div class="card"><form class="grid" method="POST" action="/admin/settings">
      ${field('buffer_minutes', 'Buffer between appointments (min)')}
      ${field('min_notice_hours', 'Minimum notice (hours)')}
      ${field('travel_buffer_minutes', 'Home-visit travel buffer (min)')}
      ${field('pending_expiry_hours', 'Pending request expiry (hours)')}
      ${field('cancel_cutoff_hours', 'Cancellation cutoff (hours)')}
      ${field('slot_granularity_minutes', 'Slot grid granularity (min)')}
      <button class="primary">Save settings</button></form></div>`;
    reply.type('text/html').send(layout('/admin/settings', 'Settings', body, flashFrom(req)));
  });

  app.post('/admin/settings', async (req, reply) => {
    const b = req.body as any;
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (b[k] != null && b[k] !== '') await setSetting(k, Number(b[k]));
    }
    await audit((req as any).adminEmail, 'update', 'settings', null, b);
    redir(reply, '/admin/settings', { ok: 'Settings saved.' });
  });

  // --- Patient / GDPR (export & delete everything for one email) -----------
  app.get('/admin/patient', async (req, reply) => {
    const email = (req.query as any)?.email as string | undefined;
    let result = '';
    if (email) {
      const rows = (
        await query(`SELECT id,start_at,status,service_id,format_key FROM bookings WHERE lower(patient_email)=lower($1) ORDER BY start_at DESC`, [email])
      ).rows;
      await audit((req as any).adminEmail, 'gdpr_lookup', 'patient', email, {});
      result = `<div class="card"><h2>${esc(email)}</h2>
        <p class="muted">${rows.length} booking(s) on record.</p>
        ${rows
          .map((r: any) => `<div class="row"><a href="/admin/booking/${r.id}">${localFullLabel(r.start_at)} ${localTimeLabel(r.start_at)}</a><span class="pill ${r.status}">${r.status}</span></div>`)
          .join('')}
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <a class="btn primary small" href="/admin/patient/export?email=${encodeURIComponent(email)}">Download export (JSON)</a>
          <form class="inline" method="POST" action="/admin/patient/delete" onsubmit="return confirm('Permanently erase ALL data for this patient? This cannot be undone.')">
            <input type="hidden" name="email" value="${esc(email)}">
            <button class="dark small" type="submit">Erase all data</button></form>
        </div></div>`;
    }
    const body = `<h1>Patient records · GDPR</h1>
      <div class="card"><form method="GET" action="/admin/patient" class="grid">
        <label>Patient email</label><input name="email" type="email" value="${esc(email ?? '')}" placeholder="patient@email.com">
        <button class="ghost">Look up</button></form></div>${result}`;
    reply.type('text/html').send(layout('/admin/patient', 'Patient / GDPR', body, flashFrom(req)));
  });

  app.get('/admin/patient/export', async (req, reply) => {
    const email = (req.query as any)?.email as string;
    if (!email) return redir(reply, '/admin/patient', { err: 'No email.' });
    const bookings = (await query(`SELECT * FROM bookings WHERE lower(patient_email)=lower($1) ORDER BY start_at`, [email])).rows;
    const { decryptField } = await import('../lib/crypto.js');
    const out = bookings.map((b: any) => ({
      ...b,
      notes: decryptField(b.notes_encrypted),
      notes_encrypted: undefined,
    }));
    await audit((req as any).adminEmail, 'gdpr_export', 'patient', email, { count: out.length });
    const { logNotesAccess } = await import('../lib/audit.js');
    await logNotesAccess((req as any).adminEmail, 'gdpr_export', null, email);
    reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="patient-${email}.json"`)
      .send(JSON.stringify({ patientEmail: email, exportedAt: new Date().toISOString(), bookings: out }, null, 2));
  });

  app.post('/admin/patient/delete', async (req, reply) => {
    const email = (req.body as any)?.email as string;
    if (!email) return redir(reply, '/admin/patient', { err: 'No email.' });
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM bookings WHERE lower(patient_email)=lower($1)`, [email]);
      await client.query(`DELETE FROM notes_access_log WHERE lower(patient_email)=lower($1)`, [email]);
      await audit((req as any).adminEmail, 'gdpr_erase', 'patient', email, {}, client);
    });
    redir(reply, '/admin/patient', { ok: `All data for ${email} erased.` });
  });
}

function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
