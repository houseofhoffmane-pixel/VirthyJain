// ===========================================================================
// Virthy Jain — booking backend (no-database version).
// Plain Express. Bookings are emailed to the practitioner + patient.
// No database, no credentials to configure. `node server.js`.
// ===========================================================================

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const A = require('./availability');
const email = require('./email');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const money = (p) => '€' + p;
const serviceById = (id) => config.services.find((s) => s.id === Number(id));
const formatByKey = (k) => config.formats.find((f) => f.key === k);

// CORS for the public API.
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// tiny in-memory rate limit
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const b = hits.get(key);
  if (!b || b.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  if (b.n >= max) return true;
  b.n++; return false;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/services', (_req, res) => {
  res.json({
    services: config.services.map((s) => ({
      id: s.id, name: s.name, durationMinutes: s.duration,
      duration: `${s.duration} minutes`, price: money(s.price),
    })),
  });
});
app.get('/api/formats', (_req, res) => res.json({ formats: config.formats }));

// Availability comes straight from the weekly schedule in config.js. With no
// database there's no per-slot "taken" tracking — the practitioner deconflicts
// when she confirms each emailed request.
app.get('/api/availability', (req, res) => {
  const service = serviceById(req.query.serviceId);
  const format = formatByKey(req.query.format);
  if (!service || !format) return res.status(400).json({ error: 'bad_request' });
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : A.todayLocal();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : A.addDays(from, config.horizonDays);
  res.json({ timezone: config.timezone, days: A.computeRange(service, format.key, from, to, []) });
});

// Create a booking request -> email the practitioner and the patient.
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
  const booking = {
    serviceName: service.name, format: format.name, starts_at: b.start, ends_at: endStr,
    name: String(b.name).trim(), email: String(b.email).trim(),
    phone: b.phone || '', referrer: b.referrer || '', notes: b.notes || '',
  };

  // Best-effort email; never fail the patient's request because email is down.
  try {
    await Promise.all([email.practitionerRequested(booking), email.patientRequested(booking)]);
  } catch (e) {
    console.error('email error:', e.message);
  }
  // Always log the request to the runtime logs as a backstop.
  console.log('BOOKING REQUEST:', JSON.stringify(booking));
  res.status(201).json({ ok: true, status: 'requested' });
});

// Serve the front-end page and its root assets.
app.get('/', (_req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.type('text').send('Virthy booking API is running. See /health');
});
app.get('/:file', (req, res, next) => {
  const name = req.params.file;
  if (!/^[\w.-]+\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?)$/.test(name)) return next();
  if (['server.js', 'config.js', 'availability.js', 'email.js'].includes(name)) return next();
  const p = path.join(__dirname, name);
  if (fs.existsSync(p)) return res.sendFile(p);
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Virthy booking API listening on ${PORT}`));
