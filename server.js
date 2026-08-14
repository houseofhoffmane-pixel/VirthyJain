// ===========================================================================
// Virthy Jain — booking backend (simple version).
// Plain JavaScript, Express, Hostinger MySQL. No build step. `node server.js`.
// ===========================================================================

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { pool, init } = require('./db');
const A = require('./availability');
const email = require('./email');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PUBLIC_URL = process.env.PUBLIC_URL || ''; // e.g. https://aqua-trout-...hostingersite.com
const money = (p) => '€' + p;
const serviceById = (id) => config.services.find((s) => s.id === Number(id));
const formatByKey = (k) => config.formats.find((f) => f.key === k);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Open CORS for the public API (front end is hosted separately on GitHub Pages).
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- tiny in-memory rate limit (per IP) ------------------------------------
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const b = hits.get(key);
  if (!b || b.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  if (b.n >= max) return true;
  b.n++; return false;
}

// --- health -----------------------------------------------------------------
app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, db: true }); }
  catch (e) { res.status(200).json({ ok: true, db: false, error: e.code || e.message }); }
});

// --- public: services / formats --------------------------------------------
app.get('/api/services', (_req, res) => {
  res.json({
    services: config.services.map((s) => ({
      id: s.id, name: s.name, durationMinutes: s.duration,
      duration: `${s.duration} minutes`, price: money(s.price),
    })),
  });
});
app.get('/api/formats', (_req, res) => res.json({ formats: config.formats }));

// --- public: availability ---------------------------------------------------
app.get('/api/availability', async (req, res) => {
  const service = serviceById(req.query.serviceId);
  const format = formatByKey(req.query.format);
  if (!service || !format) return res.status(400).json({ error: 'bad_request' });
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : A.todayLocal();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : A.addDays(from, config.horizonDays);
  try {
    const [existing] = await pool.query(
      "SELECT starts_at,ends_at,format FROM bookings WHERE status IN ('pending','confirmed') AND starts_at >= ? AND starts_at < ?",
      [from + ' 00:00:00', A.addDays(to, 1) + ' 00:00:00'],
    );
    res.json({ timezone: config.timezone, days: A.computeRange(service, format.key, from, to, existing) });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'server_error' });
  }
});

async function nextFree(service, formatKey, count = 3) {
  const today = A.todayLocal();
  const [existing] = await pool.query(
    "SELECT starts_at,ends_at,format FROM bookings WHERE status IN ('pending','confirmed') AND starts_at >= ?",
    [today + ' 00:00:00'],
  );
  const days = A.computeRange(service, formatKey, today, A.addDays(today, config.horizonDays), existing);
  const out = [];
  for (const d of days) for (const s of d.slots) if (s.free) { out.push(s.start); if (out.length >= count) return out; }
  return out;
}

// --- public: create a booking (double-book safe) ---------------------------
app.post('/api/bookings', async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(202).json({ ok: true }); // honeypot
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0];
  if (rateLimited('ip:' + ip, 10, 3600e3)) return res.status(429).json({ error: 'rate_limited' });

  const service = serviceById(b.serviceId);
  const format = formatByKey(b.format);
  if (!service || !format) return res.status(400).json({ error: 'unknown_service_or_format' });
  if (!b.name || !b.email) return res.status(400).json({ error: 'name_and_email_required' });
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(b.start || ''))
    return res.status(400).json({ error: 'bad_start' });
  if (rateLimited('email:' + String(b.email).toLowerCase(), 5, 24 * 3600e3))
    return res.status(429).json({ error: 'rate_limited' });

  const date = b.start.slice(0, 10);
  const endStr = `${date} ${A.toHM(A.toMin(b.start.slice(11, 16)) + service.duration)}:00`;

  const conn = await pool.getConnection();
  try {
    // Serialize all booking writes (single practitioner) so two people tapping
    // the same slot can't both succeed.
    await conn.query("SELECT GET_LOCK('virthy_booking', 10) AS l");
    const [existing] = await conn.query(
      "SELECT starts_at,ends_at,format FROM bookings WHERE status IN ('pending','confirmed') AND DATE(starts_at)=?",
      [date],
    );
    if (!A.isFreeSlot(service, format.key, b.start, existing)) {
      const alternatives = await nextFree(service, format.key, 3);
      return res.status(409).json({ error: 'slot_taken', alternatives });
    }
    const token = crypto.randomBytes(24).toString('hex');
    const [result] = await conn.query(
      `INSERT INTO bookings (service_id,format,starts_at,ends_at,status,name,email,phone,referrer,notes,token)
       VALUES (?,?,?,?,'pending',?,?,?,?,?,?)`,
      [service.id, format.key, b.start, endStr, String(b.name).trim(),
       String(b.email).trim().toLowerCase(), b.phone || null, b.referrer || null, b.notes || null, token],
    );
    const booking = {
      id: result.insertId, serviceName: service.name, format: format.name,
      starts_at: b.start, ends_at: endStr, name: b.name, email: b.email,
      phone: b.phone, referrer: b.referrer, notes: b.notes,
    };
    const manageUrl = `${PUBLIC_URL}/manage/${token}`;
    email.patientRequested(booking, manageUrl).catch(() => {});
    email.practitionerRequested(booking).catch(() => {});
    res.status(201).json({ ok: true, id: booking.id, status: 'pending' });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'server_error' });
  } finally {
    await conn.query("SELECT RELEASE_LOCK('virthy_booking')").catch(() => {});
    conn.release();
  }
});

// --- patient self-service via token ----------------------------------------
async function bookingByToken(token) {
  const [rows] = await pool.query('SELECT * FROM bookings WHERE token=? LIMIT 1', [token]);
  return rows[0] || null;
}
function pageWrap(title, body) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><body style="font-family:system-ui;background:#F2EEE6;color:#16201C;margin:0;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#FFFDF8;border:1px solid #DCD5C7;border-radius:8px;padding:24px">${body}</div>`;
}

app.get('/manage/:token', async (req, res) => {
  const bk = await bookingByToken(req.params.token);
  if (!bk) return res.status(404).send(pageWrap('Not found', '<h2>Link not valid</h2>'));
  const svc = serviceById(bk.service_id);
  const closed = ['cancelled', 'completed'].includes(bk.status);
  res.send(pageWrap('Your appointment', `
    <h2>Your appointment</h2>
    <p><b>${esc(svc ? svc.name : '')}</b> — ${esc(bk.format)}<br>${esc(bk.starts_at.slice(0, 16))} (Irish time)<br>Status: ${esc(bk.status)}</p>
    ${closed ? '<p>This appointment is closed.</p>' :
      `<form method="POST" action="/manage/${esc(req.params.token)}/cancel" onsubmit="return confirm('Cancel this appointment?')">
        <button style="background:#16201C;color:#fff;border:none;border-radius:999px;padding:12px 20px;cursor:pointer">Cancel appointment</button>
      </form>`}`));
});

app.post('/manage/:token/cancel', async (req, res) => {
  const bk = await bookingByToken(req.params.token);
  if (!bk) return res.status(404).send(pageWrap('Not found', '<h2>Link not valid</h2>'));
  const startMs = Date.parse(bk.starts_at.replace(' ', 'T'));
  if (startMs - Date.now() < config.cancelCutoffHours * 3600e3)
    return res.send(pageWrap('Too late', `<h2>Can't cancel online</h2><p>It's within ${config.cancelCutoffHours} hours of the appointment. Please phone the practice.</p>`));
  await pool.query("UPDATE bookings SET status='cancelled' WHERE id=?", [bk.id]);
  email.patientCancelled(bk).catch(() => {});
  res.send(pageWrap('Cancelled', '<h2>Cancelled</h2><p>Your appointment has been cancelled.</p>'));
});

// --- admin (HTTP basic auth) ------------------------------------------------
function adminAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const [, b64] = hdr.split(' ');
  const [user, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
  if (user === (process.env.ADMIN_USER || 'admin') && pass && pass === process.env.ADMIN_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="Virthy admin"').status(401).send('Auth required');
}

app.get('/admin', adminAuth, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM bookings WHERE starts_at >= ? ORDER BY starts_at LIMIT 200",
    [A.todayLocal() + ' 00:00:00'],
  );
  const row = (b) => {
    const svc = serviceById(b.service_id);
    const actions = b.status === 'pending'
      ? `<form method=POST action="/admin/${b.id}/confirm" style="display:inline"><button>Confirm</button></form>
         <form method=POST action="/admin/${b.id}/decline" style="display:inline"><button>Decline</button></form>`
      : b.status === 'confirmed'
      ? `<form method=POST action="/admin/${b.id}/cancel" style="display:inline" onsubmit="return confirm('Cancel & notify patient?')"><button>Cancel</button></form>`
      : '';
    return `<tr>
      <td>${esc(b.starts_at.slice(0, 16))}</td>
      <td>${esc(b.name)}<br><small>${esc(b.email)} ${esc(b.phone || '')}</small></td>
      <td>${esc(svc ? svc.name : '')}<br><small>${esc(b.format)}</small></td>
      <td><span style="padding:2px 8px;border-radius:10px;background:${b.status === 'pending' ? '#F7E9DE' : b.status === 'confirmed' ? '#EDF1E9' : '#eee'}">${esc(b.status)}</span></td>
      <td><small>${esc(b.notes || '')}</small></td>
      <td>${actions}</td></tr>`;
  };
  res.send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
    <title>Admin</title><body style="font-family:system-ui;margin:0;padding:16px;background:#F2EEE6">
    <h1 style="font-size:20px">Upcoming bookings</h1>
    <p><small>${rows.filter((r) => r.status === 'pending').length} pending</small></p>
    <div style="overflow:auto"><table style="width:100%;border-collapse:collapse;background:#fff" border=0>
    <tr style="text-align:left;border-bottom:2px solid #ddd"><th>When</th><th>Patient</th><th>Service</th><th>Status</th><th>Notes</th><th></th></tr>
    ${rows.map(row).join('')}</table></div>
    <style>td,th{padding:8px;border-bottom:1px solid #eee;font-size:14px;vertical-align:top}
    button{font:inherit;padding:6px 12px;border:1px solid #999;border-radius:6px;background:#fff;cursor:pointer;margin:2px}</style>`);
});

async function adminAction(req, res, status, notify) {
  const [rows] = await pool.query('SELECT * FROM bookings WHERE id=?', [req.params.id]);
  const bk = rows[0];
  if (bk) {
    await pool.query('UPDATE bookings SET status=? WHERE id=?', [status, bk.id]);
    if (notify) {
      const svc = serviceById(bk.service_id);
      const full = { ...bk, serviceName: svc ? svc.name : '' };
      notify(full, `${PUBLIC_URL}/manage/${bk.token}`).catch(() => {});
    }
  }
  res.redirect('/admin');
}
app.post('/admin/:id/confirm', adminAuth, (req, res) => adminAction(req, res, 'confirmed', email.patientConfirmed));
app.post('/admin/:id/decline', adminAuth, (req, res) => adminAction(req, res, 'cancelled', email.patientCancelled));
app.post('/admin/:id/cancel', adminAuth, (req, res) => adminAction(req, res, 'cancelled', email.patientCancelled));

app.get('/', (_req, res) => res.type('text').send('Virthy booking API is running. See /health'));

// --- boot -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Virthy booking API listening on ${PORT}`);
  init()
    .then(() => console.log('MySQL ready.'))
    .catch((e) => console.error('MySQL init failed (check DB_* env vars):', e.code || e.message));
});
