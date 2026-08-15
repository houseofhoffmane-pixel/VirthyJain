// ===========================================================================
// Virthy Jain — booking backend.
// Express + a small JSON file store (no database, no credentials).
// Request -> pending (slot held) -> Virthy Accepts/Rejects by email link.
// `node server.js`.
// ===========================================================================

require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const A = require('./availability');
const email = require('./email');
const store = require('./store');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PUBLIC_URL = process.env.PUBLIC_URL || '';
const money = (p) => '€' + p;
const serviceById = (id) => config.services.find((s) => s.id === Number(id));
const formatByKey = (k) => config.formats.find((f) => f.key === k);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const b = hits.get(key);
  if (!b || b.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  if (b.n >= max) return true;
  b.n++; return false;
}

// existing bookings shaped for availability.js (starts_at/ends_at/format).
function activeForAvailability() {
  return store.activeBookings().map((b) => ({ starts_at: b.starts_at, ends_at: b.ends_at, format: b.format }));
}

app.get('/health', (_req, res) => res.json({ ok: true, store: store.FILE }));

app.get('/api/services', (_req, res) => {
  res.json({
    services: config.services.map((s) => ({
      id: s.id, name: s.name, durationMinutes: s.duration,
      duration: `${s.duration} minutes`, price: money(s.price),
    })),
  });
});
app.get('/api/formats', (_req, res) => res.json({ formats: config.formats }));

// Availability minus pending/confirmed bookings (rejected slots are free again).
app.get('/api/availability', (req, res) => {
  const service = serviceById(req.query.serviceId);
  const format = formatByKey(req.query.format);
  if (!service || !format) return res.status(400).json({ error: 'bad_request' });
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : A.todayLocal();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : A.addDays(from, config.horizonDays);
  res.json({ timezone: config.timezone, days: A.computeRange(service, format.key, from, to, activeForAvailability()) });
});

function nextFree(service, formatKey, count = 3) {
  const today = A.todayLocal();
  const days = A.computeRange(service, formatKey, today, A.addDays(today, config.horizonDays), activeForAvailability());
  const out = [];
  for (const d of days) for (const s of d.slots) if (s.free) { out.push(s.start); if (out.length >= count) return out; }
  return out;
}

// Create a booking request. Held as pending; the slot is now taken for others.
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

  // Re-check the slot against current bookings (synchronous = no race here).
  const date = b.start.slice(0, 10);
  const sameDate = store.activeBookings().filter((x) => x.starts_at.slice(0, 10) === date)
    .map((x) => ({ starts_at: x.starts_at, ends_at: x.ends_at, format: x.format }));
  if (!A.isFreeSlot(service, format.key, b.start, sameDate)) {
    return res.status(409).json({ error: 'slot_taken', alternatives: nextFree(service, format.key, 3) });
  }

  const endStr = `${date} ${A.toHM(A.toMin(b.start.slice(11, 16)) + service.duration)}:00`;
  const token = crypto.randomBytes(24).toString('hex');
  const booking = {
    token, status: 'pending', serviceId: service.id, serviceName: service.name,
    durationMinutes: service.duration, format: format.key, formatName: format.name,
    starts_at: b.start, ends_at: endStr,
    name: String(b.name).trim(), email: String(b.email).trim(),
    phone: b.phone || '', referrer: b.referrer || '', notes: b.notes || '',
    created_at: new Date().toISOString(),
  };
  store.add(booking);

  const acceptUrl = `${PUBLIC_URL}/booking/${token}/accept`;
  const rejectUrl = `${PUBLIC_URL}/booking/${token}/reject`;
  try {
    await Promise.all([email.practitionerRequested(booking, acceptUrl, rejectUrl), email.patientRequested(booking)]);
  } catch (e) { console.error('email error:', e.message); }
  console.log('BOOKING REQUEST:', JSON.stringify(booking));
  res.status(201).json({ ok: true, status: 'pending' });
});

// --- Virthy clicks Accept / Reject from her email ---------------------------
function resultPage(title, body) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><body style="font-family:system-ui;background:#F2EEE6;color:#16201C;margin:0;padding:32px">
  <div style="max-width:520px;margin:40px auto;background:#FFFDF8;border:1px solid #DCD5C7;border-radius:10px;padding:28px">${body}</div>`;
}
function bookingSummary(b) {
  return `<p style="font-size:15px;line-height:1.6"><b>${esc(b.serviceName)}</b> — ${esc(b.formatName || b.format)}<br>
    ${esc(b.starts_at.slice(0, 16))} (Irish time)<br>${esc(b.name)} · ${esc(b.email)}</p>`;
}

app.get('/booking/:token/accept', async (req, res) => {
  const existing = store.findByToken(req.params.token);
  if (!existing) return res.status(404).send(resultPage('Not found', '<h2>This link is not valid.</h2>'));
  if (existing.status === 'confirmed')
    return res.send(resultPage('Already confirmed', '<h2>Already confirmed</h2>' + bookingSummary(existing)));
  if (existing.status === 'rejected')
    return res.send(resultPage('Already rejected', '<h2>This was already rejected.</h2>' + bookingSummary(existing)));
  const b = store.updateStatus(req.params.token, 'confirmed');
  email.patientConfirmed(b).catch(() => {});
  res.send(resultPage('Confirmed', '<h2 style="color:#4E7A5E">✓ Confirmed</h2>' + bookingSummary(b) +
    '<p style="font-size:14px;color:#3D4A42">The patient has been emailed a confirmation. The slot stays booked.</p>'));
});

app.get('/booking/:token/reject', async (req, res) => {
  const existing = store.findByToken(req.params.token);
  if (!existing) return res.status(404).send(resultPage('Not found', '<h2>This link is not valid.</h2>'));
  if (existing.status === 'rejected')
    return res.send(resultPage('Already rejected', '<h2>Already rejected</h2>' + bookingSummary(existing)));
  const b = store.updateStatus(req.params.token, 'rejected');
  email.patientRejected(b).catch(() => {});
  res.send(resultPage('Rejected', '<h2 style="color:#B4562F">✕ Rejected</h2>' + bookingSummary(b) +
    '<p style="font-size:14px;color:#3D4A42">The slot is open again for booking, and the patient has been emailed.</p>'));
});

// --- optional: a simple read-only list of requests --------------------------
app.get('/bookings', (req, res) => {
  if (process.env.ADMIN_PASSWORD && req.query.key !== process.env.ADMIN_PASSWORD)
    return res.status(401).send('Add ?key=YOUR_ADMIN_PASSWORD to the URL.');
  const rows = store.readAll().sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  res.send(resultPage('Bookings', '<h2>All requests</h2>' + (rows.length ? rows.map((b) =>
    '<div style="border-bottom:1px solid #eee;padding:8px 0;font-size:14px"><b>' + esc(b.status) + '</b> · ' +
    esc(b.starts_at.slice(0, 16)) + ' · ' + esc(b.name) + ' · ' + esc(b.serviceName) + '</div>').join('') : '<p>None yet.</p>')));
});

// --- front end + assets -----------------------------------------------------
app.get('/', (_req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.type('text').send('Virthy booking API is running. See /health');
});
app.get('/:file', (req, res, next) => {
  const name = req.params.file;
  if (!/^[\w.-]+\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?)$/.test(name)) return next();
  if (['server.js', 'config.js', 'availability.js', 'email.js', 'store.js'].includes(name)) return next();
  const p = path.join(__dirname, name);
  if (fs.existsSync(p)) return res.sendFile(p);
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Virthy booking API listening on ${PORT} · store: ${store.FILE}`));
