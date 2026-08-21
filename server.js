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
const settings = require('./settings');
const A = require('./availability');
const email = require('./email');
const store = require('./store');
const users = require('./users');
const intakes = require('./intakes');
const receipt = require('./receipt');
const secure = require('./secure');
const filesStore = require('./files');
const hep = require('./hep');
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ok = /(pdf|png|jpe?g|webp|gif|msword|officedocument|plain)/i.test(file.mimetype);
    cb(ok ? null : new Error('Only PDF, image, Word or text files are allowed'), ok);
  },
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PUBLIC_URL = process.env.PUBLIC_URL || '';
const money = (p) => '€' + p;
const serviceById = (id) => settings.getServices().find((s) => s.id === Number(id));
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

// --- sessions (signed cookie, no session store) -----------------------------
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-session-secret-change-me';
const COOKIE = 'virthy_session';
const SESSION_MS = 30 * 24 * 3600e3;
function sign(s) { return crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url'); }
function setSession(res, userEmail) {
  const body = Buffer.from(userEmail.toLowerCase() + '|' + Date.now()).toString('base64url');
  res.cookie(COOKIE, body + '.' + sign(body), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_MS, path: '/',
  });
}
function clearSession(res) { res.clearCookie(COOKIE, { path: '/' }); }
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function sessionEmail(req) {
  const raw = getCookie(req, COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const body = raw.slice(0, dot), sig = raw.slice(dot + 1), expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let dec;
  try { dec = Buffer.from(body, 'base64url').toString(); } catch (e) { return null; }
  const i = dec.indexOf('|');
  const em = dec.slice(0, i), issued = Number(dec.slice(i + 1));
  if (!em || !issued || Date.now() - issued > SESSION_MS) return null;
  return em;
}
function currentUser(req) { const em = sessionEmail(req); return em ? users.findByEmail(em) : null; }

// --- auth API ---------------------------------------------------------------
app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const em = String(b.email || '').trim().toLowerCase();
  if (!String(b.name || '').trim() || !em || !String(b.phone || '').trim() || !String(b.gender || '').trim() || !String(b.age || '').trim() || !b.password)
    return res.status(400).json({ error: 'missing_fields', message: 'Please fill in all fields.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'bad_email', message: 'Please enter a valid email.' });
  if (String(b.password).length < 6) return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 6 characters.' });
  if (users.findByEmail(em)) return res.status(409).json({ error: 'email_taken', message: 'An account with this email already exists. Please sign in — or use “Forgot password” if you don’t remember it.' });
  if (users.findByPhone(b.phone)) return res.status(409).json({ error: 'phone_taken', message: 'An account with this phone number already exists. Please sign in — or use “Forgot password” if you don’t remember it.' });
  const u = users.create({ name: b.name, email: em, phone: b.phone, gender: b.gender, age: b.age, password: b.password });
  setSession(res, em);
  res.status(201).json({ ok: true, user: users.publicUser(u) });
});

app.post('/api/login', (req, res) => {
  const b = req.body || {};
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0];
  if (rateLimited('login:' + ip, 20, 3600e3)) return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts — try again later.' });
  const u = users.verify(b.email, b.password || '');
  if (!u) return res.status(401).json({ error: 'invalid_credentials', message: 'Wrong email or password.' });
  setSession(res, u.email);
  res.json({ ok: true, user: users.publicUser(u) });
});

app.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ user: users.publicUser(currentUser(req)) }));

app.post('/api/forgot', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0];
  if (rateLimited('forgot:' + ip, 10, 3600e3)) return res.status(429).json({ error: 'rate_limited' });
  const u = users.setReset(req.body && req.body.email); // null if not a registered email
  if (u) { email.passwordReset(u, `${PUBLIC_URL}/reset?token=${u.resetToken}`).catch(() => {}); }
  // Generic response either way (don't reveal whether an email is registered).
  res.json({ ok: true, message: 'If that email is registered, a reset link is on its way.' });
});

app.post('/api/profile', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  const b = req.body || {};
  if (b.name != null && !String(b.name).trim())
    return res.status(400).json({ error: 'name_required', message: 'Name cannot be empty.' });
  const u = users.update(user.email, { name: b.name, phone: b.phone, gender: b.gender, age: b.age });
  res.json({ ok: true, user: users.publicUser(u) });
});

// --- patient intake / consent form -----------------------------------------
app.get('/api/intake', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  const rec = intakes.get(user.email);
  res.json({
    fields: config.intake.fields,
    consents: config.intake.consents,
    answers: rec ? rec.answers : {},
    completed: !!rec,
    completedAt: rec ? rec.completedAt : null,
  });
});
app.post('/api/intake', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  const b = req.body || {};
  const answers = b.answers || {};
  const consents = { version: config.intake.consentVersion };
  for (const c of config.intake.consents) {
    if (!b.consents || !b.consents[c.id]) return res.status(400).json({ error: 'consent_required', message: 'Please agree to all consent statements to continue.' });
    consents[c.id] = { agreed: true, at: new Date().toISOString(), text: c.text };
  }
  intakes.save(user.email, answers, consents);
  res.json({ ok: true });
});

// Patient's single self-uploaded report (from their account health form).
app.get('/api/intake/report', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  const f = filesStore.patientReport(user.email);
  res.json({ file: f ? { id: f.id, name: f.originalName } : null });
});
app.post('/api/intake/report', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'upload_failed', message: err.message });
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Please choose a file.' });
    filesStore.removePatientReports(user.email); // only one report per patient
    filesStore.add({ bookingToken: 'patient-report', patientEmail: user.email, label: 'Patient report', originalName: req.file.originalname, mime: req.file.mimetype, buffer: req.file.buffer });
    email.practitionerReport(user, req.file.originalname).catch(() => {});
    res.json({ ok: true });
  });
});
app.post('/api/intake/report/delete', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  filesStore.removePatientReports(user.email);
  res.json({ ok: true });
});

app.post('/api/change-password', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  const b = req.body || {};
  const r = users.changePassword(user.email, b.currentPassword, b.newPassword);
  if (r.error === 'wrong_current') return res.status(400).json({ error: 'wrong_current', message: 'Your current password is incorrect.' });
  if (r.error === 'weak') return res.status(400).json({ error: 'weak_password', message: 'New password must be at least 6 characters.' });
  if (!r.ok) return res.status(400).json({ error: 'failed', message: 'Could not change password.' });
  res.json({ ok: true });
});

app.get('/api/my-bookings', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  const mine = store.readAll()
    .filter((b) => b.email === user.email)
    // Patients only see live/real appointments — not rejected, declined or cancelled ones.
    .filter((b) => !['rejected', 'declined', 'cancelled'].includes(b.status))
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .map((b) => {
      const c = secure.decrypt(b.clinicalEnc) || {};
      const files = filesStore.byBooking(b.token).map((f) => ({ id: f.id, label: f.label, name: f.originalName }));
      return { serviceName: b.serviceName, formatName: b.formatName || b.format, starts_at: b.starts_at, status: b.status, recommendation: c.recommendation || '', files: files, token: b.status === 'proposed' ? b.token : undefined };
    });
  res.json({ bookings: mine });
});

// The patient's home exercise programme (assigned by Virthy in the admin).
app.get('/api/my-hep', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  const items = hep.forPatient(user.email).map((x) => ({
    name: x.name, sets: x.sets, reps: x.reps, hold: x.hold, freq: x.freq, notes: x.notes, video: x.video,
  }));
  res.json({ exercises: items });
});

// Patient accepts / rejects a proposed time from their account (same as the
// email links). Verifies the booking belongs to the signed-in user.
app.post('/api/booking/:token/accept', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  const b = store.findByToken(req.params.token);
  if (!b || (b.email || '').toLowerCase() !== user.email.toLowerCase()) return res.status(404).json({ error: 'not_found' });
  if (b.status === 'proposed') {
    const nb = store.updateStatus(b.token, 'confirmed');
    email.patientConfirmed(nb, { needsIntake: !intakes.has(nb.email) }).catch(() => {});
  }
  res.json({ ok: true, status: 'confirmed' });
});
app.post('/api/booking/:token/reject', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required' });
  const b = store.findByToken(req.params.token);
  if (!b || (b.email || '').toLowerCase() !== user.email.toLowerCase()) return res.status(404).json({ error: 'not_found' });
  if (b.status === 'proposed') {
    const nb = store.updateStatus(b.token, 'declined');
    email.patientProposalDeclined(nb).catch(() => {});
  }
  res.json({ ok: true, status: 'declined' });
});

app.get('/health', (_req, res) => res.json({ ok: true, store: store.FILE }));

app.get('/api/services', (_req, res) => {
  res.json({
    services: settings.getServices().map((s) => ({
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
  res.json({ timezone: config.timezone, days: A.computeRange(service, format.key, from, to, activeForAvailability(), store.blackoutMap()) });
});

function nextFree(service, formatKey, count = 3) {
  const today = A.todayLocal();
  const days = A.computeRange(service, formatKey, today, A.addDays(today, config.horizonDays), activeForAvailability(), store.blackoutMap());
  const out = [];
  for (const d of days) for (const s of d.slots) if (s.free) { out.push(s.start); if (out.length >= count) return out; }
  return out;
}

// Create a booking request. Held as pending; the slot is now taken for others.
app.post('/api/bookings', async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(202).json({ ok: true }); // honeypot

  // Must be signed in — the account is the patient's identity.
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'login_required', message: 'Please sign in or create an account to book.' });

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0];
  if (rateLimited('ip:' + ip, 10, 3600e3)) return res.status(429).json({ error: 'rate_limited' });

  const service = serviceById(b.serviceId);
  const format = formatByKey(b.format);
  if (!service || !format) return res.status(400).json({ error: 'unknown_service_or_format' });
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(b.start || ''))
    return res.status(400).json({ error: 'bad_start' });
  if (rateLimited('email:' + user.email, 5, 24 * 3600e3))
    return res.status(429).json({ error: 'rate_limited' });

  // Re-check the slot against current bookings (synchronous = no race here).
  const date = b.start.slice(0, 10);
  const sameDate = store.activeBookings().filter((x) => x.starts_at.slice(0, 10) === date)
    .map((x) => ({ starts_at: x.starts_at, ends_at: x.ends_at, format: x.format }));
  if (!A.isFreeSlot(service, format.key, b.start, sameDate, store.blackoutMap())) {
    return res.status(409).json({ error: 'slot_taken', alternatives: nextFree(service, format.key, 3) });
  }

  const endStr = `${date} ${A.toHM(A.toMin(b.start.slice(11, 16)) + service.duration)}:00`;
  const token = crypto.randomBytes(24).toString('hex');
  const booking = {
    token, status: 'pending', serviceId: service.id, serviceName: service.name,
    durationMinutes: service.duration, format: format.key, formatName: format.name,
    starts_at: b.start, ends_at: endStr,
    // Identity comes from the signed-in account, not the request body.
    name: user.name, email: user.email, phone: user.phone || b.phone || '',
    gender: user.gender || '', age: user.age || '',
    referrer: b.referrer || '', notes: b.notes || '',
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
function cancelForm(token) {
  return `<form method="POST" action="/booking/${esc(token)}/cancel" onsubmit="return confirm('Cancel this appointment and email the patient?')" style="margin-top:18px">
    <button style="background:#16201C;color:#fff;border:none;border-radius:999px;padding:11px 22px;font:inherit;cursor:pointer">Cancel this appointment</button>
  </form>`;
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
    '<p style="font-size:14px;color:#3D4A42">The patient has been emailed a confirmation. The slot stays booked.</p>' +
    '<p style="font-size:13.5px;color:#6C7A70;margin-top:18px">Need to cancel later? Do it here, or from your bookings list.</p>' +
    cancelForm(req.params.token)));
});

// Cancel a confirmed (or pending) booking -> free the slot, email the patient.
app.post('/booking/:token/cancel', async (req, res) => {
  const existing = store.findByToken(req.params.token);
  if (!existing) return res.status(404).send(resultPage('Not found', '<h2>This link is not valid.</h2>'));
  if (existing.status === 'cancelled' || existing.status === 'rejected')
    return res.send(resultPage('Already closed', '<h2>This booking is already closed.</h2>' + bookingSummary(existing)));
  const b = store.updateStatus(req.params.token, 'cancelled');
  email.patientCancelled(b).catch(() => {});
  res.send(resultPage('Cancelled', '<h2 style="color:#B4562F">Cancelled</h2>' + bookingSummary(b) +
    '<p style="font-size:14px;color:#3D4A42">The slot is open again for booking, and the patient has been emailed.</p>'));
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

// Reschedule (change the time) -> updates the booking and emails the patient.
app.post('/booking/:token/reschedule', async (req, res) => {
  const existing = store.findByToken(req.params.token);
  if (!existing) return res.status(404).send(resultPage('Not found', '<h2>This link is not valid.</h2>'));
  const local = String((req.body && req.body.datetime) || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local))
    return res.send(resultPage('Invalid', '<h2>Please pick a valid date and time.</h2>'));
  const date = local.slice(0, 10), hm = local.slice(11, 16);
  const list = store.readAll();
  const b = list.find((x) => x.token === existing.token);
  b.starts_at = `${date} ${hm}:00`;
  b.ends_at = `${date} ${A.toHM(A.toMin(hm) + (b.durationMinutes || 45))}:00`;
  b.status = 'confirmed';
  b.updated_at = new Date().toISOString();
  store.writeAll(list);
  email.patientRescheduled(b).catch(() => {});
  res.send(resultPage('Time updated', '<h2 style="color:#4E7A5E">Time updated</h2>' + bookingSummary(b) +
    '<p style="font-size:14px;color:#3D4A42">The patient has been emailed the new time.</p>'));
});

// --- password reset pages ---------------------------------------------------
function resetPage(errorMsg, token) {
  const err = errorMsg ? `<div style="background:#F7E4DE;border:1px solid #B4562F;color:#8a3f22;padding:10px 12px;border-radius:8px;margin-bottom:14px;font-size:14px">${esc(errorMsg)}</div>` : '';
  if (!token) {
    return resultPage('Reset password', `<h2>Reset your password</h2>${err}<p style="font-size:14px;color:#3D4A42">Please request a new reset link from the sign-in screen.</p><p><a href="/#book">Back to the site</a></p>`);
  }
  return resultPage('Reset password', `<h2>Choose a new password</h2>${err}
    <form method="POST" action="/reset" style="display:grid;gap:12px;margin-top:8px">
      <input type="hidden" name="token" value="${esc(token)}">
      <input type="password" name="password" placeholder="New password (min 6 characters)" required minlength="6" style="padding:12px;border:1px solid #C9C2B2;border-radius:8px;font:inherit">
      <button style="background:#B4562F;color:#fff;border:none;border-radius:999px;padding:12px;font:inherit;cursor:pointer">Set new password</button>
    </form>`);
}
app.get('/reset', (req, res) => {
  const token = String(req.query.token || '');
  res.type('text/html').send(users.tokenValid(token) ? resetPage(null, token) : resetPage('This reset link is invalid or has expired.', null));
});
app.post('/reset', (req, res) => {
  const { token, password } = req.body || {};
  res.type('text/html');
  if (!password || String(password).length < 6) return res.send(resetPage('Password must be at least 6 characters.', token));
  const u = users.resetPassword(token, password);
  if (!u) return res.send(resetPage('This reset link is invalid or has expired.', null));
  setSession(res, u.email);
  res.send(resultPage('Password updated', '<h2 style="color:#4E7A5E">Password updated</h2><p style="font-size:15px">You\'re signed in with your new password.</p><p style="margin-top:14px"><a href="/#book" style="background:#16201C;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px">Back to the site</a></p>'));
});

// ===========================================================================
// Admin dashboard (session login, for Virthy)
// ===========================================================================
const ADMIN_COOKIE = 'virthy_admin';
function setAdmin(res) {
  const body = Buffer.from('admin|' + Date.now()).toString('base64url');
  res.cookie(ADMIN_COOKIE, body + '.' + sign('a:' + body), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 3600e3, path: '/',
  });
}
function clearAdmin(res) { res.clearCookie(ADMIN_COOKIE, { path: '/' }); }
function adminAuthed(req) {
  const raw = getCookie(req, ADMIN_COOKIE);
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return false;
  const bodyPart = raw.slice(0, dot), sig = raw.slice(dot + 1), expected = sign('a:' + bodyPart);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try { return Date.now() - Number(Buffer.from(bodyPart, 'base64url').toString().split('|')[1]) < 12 * 3600e3; }
  catch (e) { return false; }
}

// Shared booking actions (also used by the email links above).
function actAccept(token) { const e = store.findByToken(token); if (!e) return; if (['confirmed', 'rejected', 'cancelled'].includes(e.status)) return; const b = store.updateStatus(token, 'confirmed'); email.patientConfirmed(b, { needsIntake: !intakes.has(b.email) }).catch(() => {}); }
function actReject(token) { const e = store.findByToken(token); if (!e || e.status === 'rejected') return; const b = store.updateStatus(token, 'rejected'); email.patientRejected(b).catch(() => {}); }
function actCancel(token) { const e = store.findByToken(token); if (!e || ['cancelled', 'rejected'].includes(e.status)) return; const b = store.updateStatus(token, 'cancelled'); email.patientCancelled(b).catch(() => {}); }
function actComplete(token) { const e = store.findByToken(token); if (!e) return; const b = store.updateStatus(token, 'completed'); email.patientSessionDone(b).catch(() => {}); }
// Another active booking overlapping the proposed [startMin,endMin] on `date`,
// excluding `token`. Includes the inter-appointment buffer.
function conflictingBooking(token, date, startMin, endMin) {
  const buffer = config.bufferMinutes || 0;
  return store.activeBookings().find((o) => {
    if (o.token === token || o.starts_at.slice(0, 10) !== date) return false;
    const oS = A.toMin(o.starts_at.slice(11, 16));
    const oE = A.toMin(o.ends_at.slice(11, 16));
    return startMin < oE + buffer && oS < endMin + buffer;
  }) || null;
}
function actReschedule(token, local) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local || '')) return { error: 'bad_time' };
  const date = local.slice(0, 10), hm = local.slice(11, 16);
  const list = store.readAll();
  const b = list.find((x) => x.token === token);
  if (!b) return { error: 'not_found' };
  const startMin = A.toMin(hm);
  const endMin = startMin + (b.durationMinutes || 45);
  const clash = conflictingBooking(token, date, startMin, endMin);
  if (clash) return { conflict: clash };
  b.starts_at = `${date} ${hm}:00`;
  b.ends_at = `${date} ${A.toHM(endMin)}:00`;
  b.status = 'confirmed';
  b.updated_at = new Date().toISOString();
  store.writeAll(list);
  email.patientRescheduled(b).catch(() => {});
  return { ok: true };
}

const ADMIN_CSS = `
  *{box-sizing:border-box}
  body{margin:0;background:#F2EEE6;color:#16201C;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  a{color:#B4562F}
  .app{display:flex;min-height:100vh}
  .side{width:220px;flex-shrink:0;background:#16201C;color:#F2EEE6;padding:18px 14px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column}
  .side .brand{font-weight:700;font-size:15px;letter-spacing:.02em;margin:4px 8px 18px}
  .side a{display:block;color:#C9D0CB;text-decoration:none;padding:10px 12px;border-radius:8px;margin-bottom:4px;font-size:14px}
  .side a:hover{background:rgba(255,255,255,.08);color:#fff}
  .side a.active{background:#B4562F;color:#fff}
  .side .spacer{flex:1}
  .signout{width:100%;background:transparent;border:1px solid rgba(255,255,255,.35);color:#F2EEE6;border-radius:8px;padding:9px;cursor:pointer;font:inherit;margin:0}
  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .topbar{position:sticky;top:0;z-index:5;background:#F2EEE6;border-bottom:1px solid #DCD5C7;padding:15px 24px;font-weight:600;font-size:16px}
  .content{padding:22px 24px;max-width:1080px;width:100%;margin:0 auto}
  .stat{display:inline-block;background:#FFFDF8;border:1px solid #DCD5C7;border-radius:10px;padding:10px 16px;margin:0 8px 8px 0;min-width:96px}
  .stat b{font-size:22px;display:block;line-height:1.1}.stat span{font-size:12px;color:#6C7A70}
  .card{background:#FFFDF8;border:1px solid #DCD5C7;border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .card.pending{border-left:4px solid #B4562F}
  .pill{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#fff;padding:3px 9px;border-radius:999px}
  h2{font-size:16px;margin:22px 0 10px}
  .muted{color:#6C7A70;font-size:13px}
  .notes{background:#F7F4EE;border:1px solid #E4DED1;border-radius:8px;padding:8px 10px;font-size:13px;margin-top:8px;white-space:pre-wrap}
  button{font:inherit;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;margin:6px 6px 0 0}
  .green{background:#4E7A5E;color:#fff}.red{background:#B4562F;color:#fff}.dark{background:#16201C;color:#fff}.ghost{background:#fff;border:1px solid #999;color:#16201C}
  input[type=datetime-local]{font:inherit;padding:6px;border:1px solid #ccc;border-radius:6px;font-size:13px;margin-top:6px}
  form{display:inline}
  .calweek{display:grid;gap:12px;grid-template-columns:1fr}
  .calweek .card{margin-bottom:0}
  @media(min-width:760px){.calweek{grid-template-columns:repeat(7,1fr)}}
  @media(min-width:760px) and (max-width:1080px){.calweek{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
  @media(max-width:820px){
    .app{flex-direction:column}
    .side{position:sticky;top:0;width:auto;height:auto;flex-direction:row;align-items:center;gap:6px;overflow-x:auto;padding:10px 12px;z-index:6}
    .side .brand,.side .spacer{display:none}
    .side a{margin:0;padding:8px 12px;white-space:nowrap}
    .side form{margin-left:auto}
    .signout{width:auto;padding:8px 12px;white-space:nowrap}
    .topbar{padding:14px 16px}
    .content{padding:16px}
  }
`;
const ADMIN_NAV = [
  ['/admin', 'Dashboard', 'dashboard'],
  ['/admin/patients', 'Patients', 'patients'],
  ['/admin/calendar', 'Calendar', 'calendar'],
  ['/admin/all', 'All bookings', 'all'],
  ['/admin/blackouts', 'Block off days', 'blackouts'],
  ['/admin/file-labels', 'File labels', 'filelabels'],
  ['/admin/settings', 'Services & hours', 'settings'],
];
function adminShell(title, inner, active) {
  const nav = ADMIN_NAV.map(([href, label, key]) => `<a href="${href}"${active === key ? ' class="active"' : ''}>${label}</a>`).join('');
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>${esc(title)} — Virthy Admin</title><style>${ADMIN_CSS}</style><body>
  <div class="app">
    <nav class="side">
      <div class="brand">Virthy · Admin</div>
      ${nav}
      <div class="spacer"></div>
      <form method="POST" action="/admin/logout"><button class="signout">Sign out</button></form>
    </nav>
    <div class="main">
      <div class="topbar">${esc(title)}</div>
      <div class="content">${inner}</div>
    </div>
  </div></body>`;
}
function adminShellBare(inner) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Admin — Virthy Jain</title><style>${ADMIN_CSS}</style><body style="background:#16201C">${inner}</body>`;
}
function backLink(href, label) { return `<a href="${href}" style="display:inline-block;margin-bottom:12px;font-size:13px">← ${esc(label)}</a>`; }
function adminLoginPage(err) {
  return adminShellBare(`<div style="max-width:360px;margin:60px auto;background:#FFFDF8;border-radius:14px;padding:28px">
    <h2 style="margin:0 0 12px">Virthy · Admin</h2>
    ${err ? '<p style="color:#B4562F;font-size:14px">Wrong password.</p>' : ''}
    ${!process.env.ADMIN_PASSWORD ? '<p style="color:#B4562F;font-size:13px">Set an ADMIN_PASSWORD environment variable to enable admin login.</p>' : ''}
    <form method="POST" action="/admin/login">
      <input type="password" name="password" placeholder="Admin password" required style="width:100%;padding:12px;border:1px solid #C9C2B2;border-radius:8px;font:inherit;box-sizing:border-box">
      <button class="dark" style="width:100%;margin-top:10px;padding:12px">Sign in</button>
    </form></div>`);
}
function fbtn(token, action, label, cls, confirm) {
  return `<form method="POST" action="/admin/booking/${esc(token)}/${action}"${confirm ? ` onsubmit="return confirm('${label} and email the patient?')"` : ''}><button class="${cls}">${label}</button></form>`;
}
function reForm(b) {
  const val = b.starts_at ? b.starts_at.slice(0, 10) + 'T' + b.starts_at.slice(11, 16) : '';
  return `<form method="POST" action="/admin/booking/${esc(b.token)}/reschedule" style="display:inline-flex;gap:4px;align-items:center"><input type="datetime-local" name="datetime" value="${esc(val)}" required><button class="ghost">Change time</button></form>`;
}
function proposeLink(token) {
  return `<a href="/admin/booking/${esc(token)}/propose" style="display:inline-block;background:#fff;border:1px solid #999;color:#16201C;border-radius:8px;padding:8px 14px;font-size:13px;margin:6px 6px 0 0;text-decoration:none">Propose new time</a>`;
}
// Delete requires typing "delete" to confirm; permanently removes the booking.
function deleteBtn(token, backEmail) {
  return `<form method="POST" action="/admin/booking/${esc(token)}/delete" style="display:inline" onsubmit="return (prompt('Type delete to permanently remove this booking and all its data')||'').trim().toLowerCase()==='delete'">${backEmail ? `<input type="hidden" name="back" value="${esc(backEmail)}">` : ''}<button class="ghost" style="color:#B4562F;border-color:#B4562F">Delete</button></form>`;
}
function paidControl(b) {
  const svc = serviceById(b.serviceId);
  const val = b.paid ? (b.paidAmount != null ? b.paidAmount : '') : (svc ? svc.price : '');
  return `<form method="POST" action="/admin/booking/${esc(b.token)}/paid" style="display:inline-flex;gap:4px;align-items:center;margin:6px 6px 0 0">
    <span style="font-size:13px">€</span><input type="number" step="0.01" min="0" name="amount" value="${esc(val)}" style="width:78px;padding:6px;border:1px solid #ccc;border-radius:6px;font-size:13px">
    <button class="${b.paid ? 'ghost' : 'green'}">${b.paid ? 'Update paid' : 'Mark paid'}</button>
    ${b.paid ? `<button formaction="/admin/booking/${esc(b.token)}/unpaid" class="ghost">Unpaid</button>` : ''}
  </form>`;
}
function bookingCard(b) {
  const col = b.status === 'confirmed' ? '#4E7A5E' : b.status === 'pending' ? '#B4562F' : b.status === 'proposed' ? '#8a6d3b' : b.status === 'completed' ? '#3E5170' : '#8A9188';
  const svc = serviceById(b.serviceId);
  const price = svc ? ' · €' + svc.price : '';
  const actions = b.status === 'pending'
    ? fbtn(b.token, 'accept', 'Accept', 'green') + fbtn(b.token, 'reject', 'Reject', 'red', true) + fbtn(b.token, 'cancel', 'Cancel', 'dark', true) + proposeLink(b.token)
    : b.status === 'proposed'
    ? '<span class="muted" style="margin-right:6px">Waiting on patient to accept…</span>' + fbtn(b.token, 'cancel', 'Cancel', 'dark', true) + proposeLink(b.token)
    : b.status === 'confirmed'
    ? fbtn(b.token, 'complete', 'Session done', 'dark', true) + fbtn(b.token, 'cancel', 'Cancel', 'ghost', true) + reForm(b) + '<div>' + paidControl(b) + '</div>'
    : b.status === 'completed' ? paidControl(b) : '';
  const payPill = ['confirmed', 'completed'].includes(b.status)
    ? (b.paid ? `<span class="pill" style="background:#4E7A5E;margin-left:6px">Paid €${esc(b.paidAmount != null ? b.paidAmount : '')}</span>` : '<span class="pill" style="background:#8A9188;margin-left:6px">Unpaid</span>')
    : '';
  const meta = [b.gender, b.age ? b.age + ' yrs' : ''].filter(Boolean).join(' · ');
  return `<div class="card${b.status === 'pending' ? ' pending' : ''}">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
      <div><b style="font-size:15px">${esc(b.starts_at.slice(0, 16))}</b> · ${esc(b.serviceName)}${price} <span class="muted">${b.durationMinutes ? '(' + b.durationMinutes + ' min)' : ''}</span></div>
      <span><span class="pill" style="background:${col}">${esc(b.status)}</span>${payPill}</span>
    </div>
    <div class="muted" style="margin-top:4px">${esc(b.name)} · <a href="mailto:${esc(b.email)}">${esc(b.email)}</a>${b.phone ? ' · <a href="tel:' + esc(b.phone) + '">' + esc(b.phone) + '</a>' : ''} · ${esc(b.formatName || b.format)}</div>
    ${meta ? `<div class="muted">${esc(meta)}</div>` : ''}
    <div class="muted"><a href="/admin/patient/${encodeURIComponent(b.email)}">Patient &amp; health form ${intakes.has(b.email) ? '✓' : '⚠ not completed'}</a></div>
    ${b.referrer ? `<div class="muted">Referred by: ${esc(b.referrer)}</div>` : ''}
    ${b.notes ? `<div class="notes">${esc(b.notes)}</div>` : ''}
    <div style="margin-top:6px">${actions}${deleteBtn(b.token)}</div>
  </div>`;
}

app.get('/admin', (req, res) => {
  res.type('text/html');
  if (!adminAuthed(req)) return res.send(adminLoginPage(req.query.err));
  const all = store.readAll();
  const today = A.todayLocal();
  const requests = all.filter((b) => b.status === 'pending' || b.status === 'proposed').sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const upcoming = all.filter((b) => b.status === 'confirmed' && b.starts_at.slice(0, 10) >= today).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const toWrapUp = all.filter((b) => b.status === 'confirmed' && b.starts_at.slice(0, 10) < today).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  const pendingCount = all.filter((b) => b.status === 'pending').length;
  const inner = `
      <div style="margin-bottom:8px"><span class="stat"><b>${pendingCount}</b><span>Pending</span></span><span class="stat"><b>${upcoming.length}</b><span>Upcoming</span></span></div>
      <h2>Requests</h2>
      ${requests.length ? requests.map(bookingCard).join('') : '<p class="muted">No requests waiting.</p>'}
      <h2>Upcoming appointments</h2>
      ${upcoming.length ? upcoming.map(bookingCard).join('') : '<p class="muted">Nothing upcoming.</p>'}
      ${toWrapUp.length ? '<h2>To wrap up (past sessions)</h2>' + toWrapUp.map(bookingCard).join('') : ''}`;
  res.send(adminShell('Dashboard', inner, 'dashboard'));
});
app.get('/admin/blackouts', (req, res) => {
  res.type('text/html');
  if (!adminAuthed(req)) return res.redirect('/admin');
  const blackouts = store.readBlackouts().sort((a, b) => a.from.localeCompare(b.from));
  const dinput = 'padding:8px;border:1px solid #ccc;border-radius:6px;font:inherit';
  const blk = blackouts.length
    ? blackouts.map((bl) => {
        const range = esc(bl.from) + (bl.to && bl.to !== bl.from ? ' → ' + esc(bl.to) : '');
        const time = (bl.startTime && bl.endTime) ? ` <b>${esc(bl.startTime)}–${esc(bl.endTime)}</b>` : ' <span class="muted">(all day)</span>';
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid #E4DED1;padding:8px 0"><span>${range}${time}${bl.reason ? ' <span class="muted">· ' + esc(bl.reason) + '</span>' : ''}</span><form method="POST" action="/admin/blackout/${esc(bl.id)}/delete"><button class="ghost" style="margin:0">Remove</button></form></div>`;
      }).join('')
    : '<p class="muted">No days blocked.</p>';
  const inner = `<div class="card">
      <form method="POST" action="/admin/blackout" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div><div class="muted">From</div><input type="date" name="from" required style="${dinput}"></div>
        <div><div class="muted">To (optional)</div><input type="date" name="to" style="${dinput}"></div>
        <div><div class="muted">Start time (optional)</div><input type="time" name="startTime" style="${dinput}"></div>
        <div><div class="muted">End time (optional)</div><input type="time" name="endTime" style="${dinput}"></div>
        <div style="flex:1 1 140px"><div class="muted">Reason</div><input type="text" name="reason" placeholder="Holiday, course…" style="width:100%;${dinput}"></div>
        <button class="dark" style="margin:0">Block</button>
      </form>
      <div class="muted" style="margin-top:6px">Leave the times blank to block whole days. Set a start &amp; end time to block just that window (applies to every day in the range).</div>
      <div style="margin-top:12px">${blk}</div>
    </div>`;
  res.send(adminShell('Block off days', inner, 'blackouts'));
});
app.get('/admin/all', (req, res) => {
  res.type('text/html');
  if (!adminAuthed(req)) return res.redirect('/admin');
  const q = String(req.query.q || '').trim().toLowerCase();
  let all = store.readAll().sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  if (q) all = all.filter((b) => (b.name || '').toLowerCase().includes(q) || (b.email || '').toLowerCase().includes(q) || (b.phone || '').toLowerCase().includes(q));
  const search = `<form method="GET" action="/admin/all" style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap"><input type="text" name="q" value="${esc(req.query.q || '')}" placeholder="Search name, email or phone" style="flex:1 1 220px;padding:10px;border:1px solid #C9C2B2;border-radius:8px;font:inherit"><button class="dark" style="margin:0">Search</button></form>`;
  res.send(adminShell('All bookings', `${search}${all.length ? all.map(bookingCard).join('') : '<p class="muted">No matches.</p>'}`, 'all'));
});
app.post('/admin/login', (req, res) => {
  const pw = (req.body && req.body.password) || '';
  if (process.env.ADMIN_PASSWORD && pw === process.env.ADMIN_PASSWORD) { setAdmin(res); return res.redirect('/admin'); }
  res.redirect('/admin?err=1');
});
app.post('/admin/logout', (req, res) => { clearAdmin(res); res.redirect('/admin'); });
function guard(req, res) { if (!adminAuthed(req)) { res.redirect('/admin'); return false; } return true; }
app.post('/admin/booking/:token/accept', (req, res) => { if (!guard(req, res)) return; actAccept(req.params.token); res.redirect('/admin'); });
app.post('/admin/booking/:token/reject', (req, res) => { if (!guard(req, res)) return; actReject(req.params.token); res.redirect('/admin'); });
app.post('/admin/booking/:token/cancel', (req, res) => { if (!guard(req, res)) return; actCancel(req.params.token); res.redirect('/admin'); });
app.post('/admin/booking/:token/reschedule', (req, res) => {
  if (!guard(req, res)) return;
  const r = actReschedule(req.params.token, (req.body && req.body.datetime) || '');
  if (r && r.conflict) {
    const c = r.conflict;
    res.type('text/html');
    return res.send(adminShell('Time clash', backLink('/admin', 'Dashboard') +
      `<div class="card"><h2 style="margin-top:0;color:#B4562F">Already booked at that time</h2>
        <p style="font-size:15px">There's already a booking then: <b>${esc(c.name)}</b> — ${esc(c.serviceName)} at ${esc(c.starts_at.slice(0, 16))} <span class="pill" style="background:#4E7A5E">${esc(c.status)}</span></p>
        <p class="muted">Cancel or delete that booking first, then change this one to that time.</p>
        <a href="/admin/patient/${encodeURIComponent(c.email)}" style="display:inline-block;margin-top:6px">Open that patient →</a></div>`, 'dashboard'));
  }
  res.redirect('/admin');
});
app.post('/admin/booking/:token/complete', (req, res) => { if (!guard(req, res)) return; actComplete(req.params.token); res.redirect('/admin'); });
app.post('/admin/booking/:token/clinical', (req, res) => {
  if (!guard(req, res)) return;
  const bd = req.body || {};
  const soap = { s: bd.s || '', o: bd.o || '', a: bd.a || '', p: bd.p || '' };
  const recommendation = String(bd.recommendation || '');
  const outcomes = {};
  for (const m of config.outcomes) {
    const v = bd['out_' + m.id];
    if (v != null && String(v).trim() !== '' && Number.isFinite(Number(v))) outcomes[m.id] = Number(v);
  }
  const b = store.patch(req.params.token, { clinicalEnc: secure.encrypt({ soap, recommendation, outcomes }) });
  if (b && bd.notify && recommendation.trim()) email.patientRecommendation(b, recommendation).catch(() => {});
  res.redirect(b ? '/admin/patient/' + encodeURIComponent(b.email) : '/admin');
});
app.post('/admin/booking/:token/paid', async (req, res) => {
  if (!guard(req, res)) return;
  const raw = (req.body && req.body.amount != null) ? String(req.body.amount).trim() : '';
  const amount = raw === '' ? null : Number(raw);
  const finalAmount = Number.isFinite(amount) ? amount : null;
  const b = store.patch(req.params.token, { paid: true, paidAmount: finalAmount });
  if (b && finalAmount != null) {
    try {
      const pdf = await receipt.buildReceipt(b, finalAmount);
      email.patientReceipt(b, finalAmount, pdf).catch(() => {});
    } catch (e) { console.error('receipt error:', e.message); }
  }
  res.redirect('/admin');
});
app.post('/admin/booking/:token/unpaid', (req, res) => { if (!guard(req, res)) return; store.patch(req.params.token, { paid: false, paidAmount: null }); res.redirect('/admin'); });

function dayLabel(dateStr) { return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' }); }
function mondayOf(dateStr) { const w = new Date(dateStr + 'T12:00:00Z').getUTCDay(); return A.addDays(dateStr, w === 0 ? -6 : 1 - w); }

// Propose a new time (from available slots) for a pending/proposed booking.
app.get('/admin/booking/:token/propose', (req, res) => {
  res.type('text/html');
  if (!adminAuthed(req)) return res.redirect('/admin');
  const b = store.findByToken(req.params.token);
  if (!b) return res.send(adminShell('Propose new time', '<div class="card">Not found.</div>', 'dashboard'));
  const service = serviceById(b.serviceId), format = formatByKey(b.format);
  const today = A.todayLocal();
  const days = A.computeRange(service, format.key, today, A.addDays(today, config.horizonDays), activeForAvailability(), store.blackoutMap());
  let opts = '';
  for (const d of days) for (const s of d.slots) if (s.free) opts += `<option value="${esc(s.start)}">${esc(dayLabel(d.date))} · ${esc(s.label)}</option>`;
  const summary = `<p style="font-size:15px;line-height:1.6"><b>${esc(b.serviceName)}</b> — ${esc(b.formatName || b.format)}<br>Requested: ${esc(b.starts_at.slice(0, 16))}<br>${esc(b.name)} · ${esc(b.email)}${b.phone ? ' · ' + esc(b.phone) : ''}</p>`;
  const inner = `${backLink('/admin', 'Dashboard')}<div class="card">${summary}
      <form method="POST" action="/admin/booking/${esc(req.params.token)}/propose" style="margin-top:14px">
        <div class="muted">Choose an available slot to offer the patient</div>
        <select name="start" required style="width:100%;padding:12px;border:1px solid #C9C2B2;border-radius:8px;font:inherit;margin-top:6px">${opts || '<option value="">No free slots in the next ' + config.horizonDays + ' days</option>'}</select>
        <button class="green" style="margin-top:12px"${opts ? '' : ' disabled'}>Propose this time to the patient</button>
      </form>
      <p class="muted" style="margin-top:12px">The patient gets an email to accept or decline. Accepting confirms it; declining releases the slot and asks them to contact you.</p>
    </div>`;
  res.send(adminShell('Propose new time', inner, 'dashboard'));
});
app.post('/admin/booking/:token/propose', (req, res) => {
  if (!guard(req, res)) return;
  const start = String((req.body && req.body.start) || '');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(start)) return res.redirect('/admin/booking/' + req.params.token + '/propose');
  const list = store.readAll();
  const b = list.find((x) => x.token === req.params.token);
  if (!b) return res.redirect('/admin');
  const date = start.slice(0, 10), hm = start.slice(11, 16);
  b.starts_at = start;
  b.ends_at = `${date} ${A.toHM(A.toMin(hm) + (b.durationMinutes || 45))}:00`;
  b.status = 'proposed';
  b.updated_at = new Date().toISOString();
  store.writeAll(list);
  email.patientProposed(b, `${PUBLIC_URL}/booking/${b.token}/patient-accept`, `${PUBLIC_URL}/booking/${b.token}/patient-reject`).catch(() => {});
  res.redirect('/admin');
});

// Patient responds to a proposed time (from their email).
app.get('/booking/:token/patient-accept', (req, res) => {
  const b = store.findByToken(req.params.token);
  if (!b) return res.status(404).send(resultPage('Not found', '<h2>This link is not valid.</h2>'));
  if (b.status === 'confirmed') return res.send(resultPage('Confirmed', '<h2 style="color:#4E7A5E">Already confirmed</h2>' + bookingSummary(b)));
  if (b.status !== 'proposed') return res.send(resultPage('Not active', '<h2>This offer is no longer active.</h2>'));
  const nb = store.updateStatus(req.params.token, 'confirmed');
  email.patientConfirmed(nb, { needsIntake: !intakes.has(nb.email) }).catch(() => {});
  res.send(resultPage('Confirmed', '<h2 style="color:#4E7A5E">✓ Confirmed</h2>' + bookingSummary(nb) + '<p style="font-size:14px;color:#3D4A42">Thanks — your appointment is confirmed. See you then.</p>'));
});
app.get('/booking/:token/patient-reject', (req, res) => {
  const b = store.findByToken(req.params.token);
  if (!b) return res.status(404).send(resultPage('Not found', '<h2>This link is not valid.</h2>'));
  if (b.status !== 'proposed') return res.send(resultPage('Thanks', '<h2>Thanks for letting us know.</h2>'));
  const nb = store.updateStatus(req.params.token, 'declined');
  email.patientProposalDeclined(nb).catch(() => {});
  res.send(resultPage('Noted', '<h2 style="color:#B4562F">No problem</h2>' + bookingSummary(nb) + '<p style="font-size:14px;color:#3D4A42">That time is released. Please contact Virthy to arrange one that suits — her details are in the email we just sent — then rebook.</p>'));
});

// Block-out (holiday) management.
app.post('/admin/blackout', (req, res) => {
  if (!guard(req, res)) return;
  const b = req.body || {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(b.from || '')) {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(b.to || '') && b.to >= b.from ? b.to : b.from;
    const okTime = /^\d{2}:\d{2}$/.test(b.startTime || '') && /^\d{2}:\d{2}$/.test(b.endTime || '') && b.endTime > b.startTime;
    store.addBlackout(b.from, to, b.reason || '', okTime ? b.startTime : '', okTime ? b.endTime : '');
  }
  res.redirect('/admin/blackouts');
});
app.post('/admin/blackout/:id/delete', (req, res) => { if (!guard(req, res)) return; store.removeBlackout(req.params.id); res.redirect('/admin/blackouts'); });

// --- session file attachments ----------------------------------------------
app.post('/admin/booking/:token/file', (req, res) => {
  if (!guard(req, res)) return;
  upload.single('file')(req, res, (err) => {
    res.type('text/html');
    const b = store.findByToken(req.params.token);
    if (err) return res.send(adminShell('Upload error', backLink(b ? '/admin/patient/' + encodeURIComponent(b.email) : '/admin', 'Back') + `<div class="card"><p style="color:#B4562F">Upload failed: ${esc(err.message)}</p></div>`, 'patients'));
    if (!req.file || !b) return res.redirect('/admin');
    filesStore.add({ bookingToken: b.token, patientEmail: b.email, label: String(req.body.label || 'File'), originalName: req.file.originalname, mime: req.file.mimetype, buffer: req.file.buffer });
    res.redirect('/admin/patient/' + encodeURIComponent(b.email));
  });
});
app.post('/admin/file/:id/delete', (req, res) => {
  if (!guard(req, res)) return;
  const f = filesStore.byId(req.params.id);
  filesStore.remove(req.params.id);
  res.redirect(f ? '/admin/patient/' + encodeURIComponent(f.patientEmail) : '/admin');
});
// Download — the owning patient or the admin only. Streams decrypted.
app.get('/files/:id', (req, res) => {
  const f = filesStore.byId(req.params.id);
  if (!f) return res.status(404).send('Not found');
  const user = currentUser(req);
  const isOwner = user && (f.patientEmail || '').toLowerCase() === user.email.toLowerCase();
  if (!isOwner && !adminAuthed(req)) return res.status(403).send('Not allowed');
  const buf = filesStore.readBuffer(req.params.id);
  if (!buf) return res.status(500).send('Could not read file');
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${(f.originalName || 'file').replace(/[^\w.\- ]/g, '_')}"`);
  res.send(buf);
});

// --- file label management (editable dropdown values) ----------------------
app.get('/admin/file-labels', (req, res) => {
  res.type('text/html');
  if (!adminAuthed(req)) return res.redirect('/admin');
  const labels = store.readFileLabels();
  const list = labels.length
    ? labels.map((l) => `<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #E4DED1;padding:8px 0"><span>${esc(l)}</span><form method="POST" action="/admin/file-label/delete"><input type="hidden" name="label" value="${esc(l)}"><button class="ghost" style="margin:0">Remove</button></form></div>`).join('')
    : '<p class="muted">No labels.</p>';
  const inner = `<div class="card">
      <p class="muted">These are the options in the file-upload dropdown on a patient's session.</p>
      <form method="POST" action="/admin/file-label" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="text" name="label" placeholder="e.g. Neck, Knee…" required style="padding:9px;border:1px solid #C9C2B2;border-radius:8px;font:inherit">
        <button class="dark" style="margin:0">Add label</button>
      </form>
      <div style="margin-top:12px">${list}</div>
    </div>`;
  res.send(adminShell('File labels', inner, 'filelabels'));
});
app.post('/admin/file-label', (req, res) => { if (!guard(req, res)) return; store.addFileLabel((req.body && req.body.label) || ''); res.redirect('/admin/file-labels'); });
app.post('/admin/file-label/delete', (req, res) => { if (!guard(req, res)) return; store.removeFileLabel((req.body && req.body.label) || ''); res.redirect('/admin/file-labels'); });

// --- services & opening hours (admin-editable; defaults live in config.js) --
const WEEK = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']];
app.get('/admin/settings', (req, res) => {
  res.type('text/html');
  if (!adminAuthed(req)) return res.redirect('/admin');
  const saved = req.query.saved ? '<div style="background:#EDF1E9;border:1px solid #4E7A5E;border-radius:10px;padding:10px 14px;margin-bottom:14px">Saved.</div>' : '';
  const din = 'padding:9px;border:1px solid #C9C2B2;border-radius:8px;font:inherit';
  const svc = settings.getServices();
  const svcRow = (s) => `<tr class="svcrow">
      <td><input name="services[__i__][id]" type="hidden" value="${esc(s ? s.id : '')}"><input name="services[__i__][name]" value="${esc(s ? s.name : '')}" placeholder="Service name" style="width:100%;${din}"></td>
      <td><input name="services[__i__][duration]" type="number" min="5" step="5" value="${esc(s ? s.duration : '')}" placeholder="min" style="width:80px;${din}"></td>
      <td><input name="services[__i__][price]" type="number" min="0" step="1" value="${esc(s ? s.price : '')}" placeholder="€" style="width:80px;${din}"></td>
      <td><button type="button" class="ghost" style="margin:0" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>`;
  // Render existing rows with real indexes so nested form parses cleanly.
  const svcRows = svc.map((s, i) => svcRow(s).replace(/__i__/g, i)).join('');
  const servicesCard = `<div class="card">
    <h3 style="margin:0 0 4px">Services</h3>
    <p class="muted" style="margin:0 0 10px">Name, length in minutes, and price in euro. Renaming a service never changes past bookings.</p>
    <form method="POST" action="/admin/settings/services">
      <table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left"><th class="muted">Service</th><th class="muted">Minutes</th><th class="muted">Price €</th><th></th></tr></thead>
      <tbody id="svcBody">${svcRows}</tbody></table>
      <button type="button" class="ghost" style="margin:10px 0" onclick="addSvc()">+ Add service</button><br>
      <button class="dark" style="margin:0">Save services</button>
    </form>
    <template id="svcTpl">${svcRow(null)}</template>
    <script>
      function addSvc(){var t=document.getElementById('svcTpl').innerHTML;var i=document.querySelectorAll('#svcBody .svcrow').length + Math.floor(Math.random()*1e6);var tr=document.createElement('tbody');tr.innerHTML=t.replace(/__i__/g,i);document.getElementById('svcBody').appendChild(tr.firstElementChild);}
    </script>
  </div>`;

  const hoursCards = config.formats.map((f) => {
    const rows = WEEK.map(([d, label]) => `<div style="display:flex;gap:10px;align-items:center;margin-bottom:6px">
        <div style="width:90px" class="muted">${label}</div>
        <input name="hours[${f.key}][${d}]" value="${esc(settings.windowsText(f.key, d))}" placeholder="closed" style="flex:1;${din}">
      </div>`).join('');
    return `<div class="card">
      <h3 style="margin:0 0 4px">${esc(f.name)} hours</h3>
      <p class="muted" style="margin:0 0 10px">One or more windows, e.g. <code>08:00-11:45, 14:00-17:45</code>. Leave a day blank to close it.</p>
      ${rows}</div>`;
  }).join('');
  const hoursForm = `<form method="POST" action="/admin/settings/hours">${hoursCards}<button class="dark" style="margin:0">Save hours</button></form>`;

  const resetCard = `<div class="card"><h3 style="margin:0 0 4px">Reset</h3>
    <p class="muted" style="margin:0 0 10px">Discard your changes and go back to the built-in defaults.</p>
    <form method="POST" action="/admin/settings/reset" onsubmit="return confirm('Reset services and hours to the defaults?')"><button class="ghost" style="margin:0">Reset to defaults</button></form></div>`;

  res.send(adminShell('Services & hours', `${saved}${servicesCard}${hoursForm}${resetCard}`, 'settings'));
});
const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
app.post('/admin/settings/services', (req, res) => {
  if (!guard(req, res)) return;
  settings.saveServices(asArray(req.body && req.body.services));
  res.redirect('/admin/settings?saved=1');
});
app.post('/admin/settings/hours', (req, res) => {
  if (!guard(req, res)) return;
  settings.saveHours((req.body && req.body.hours) || {}, config.formats.map((f) => f.key));
  res.redirect('/admin/settings?saved=1');
});
app.post('/admin/settings/reset', (req, res) => { if (!guard(req, res)) return; settings.resetAll(); res.redirect('/admin/settings?saved=1'); });

// --- home exercise programme (admin adds; patient sees in their account) ----
app.post('/admin/hep', (req, res) => {
  if (!guard(req, res)) return;
  const b = req.body || {};
  const email = String(b.email || '');
  if (email) hep.add({ patientEmail: email, name: b.name, sets: b.sets, reps: b.reps, hold: b.hold, freq: b.freq, notes: b.notes, video: b.video });
  res.redirect('/admin/patient/' + encodeURIComponent(email));
});
app.post('/admin/hep/:id/delete', (req, res) => {
  if (!guard(req, res)) return;
  hep.remove(req.params.id);
  res.redirect('/admin/patient/' + encodeURIComponent(String((req.body && req.body.email) || '')));
});

// Permanently delete a booking and its data.
app.post('/admin/booking/:token/delete', (req, res) => {
  if (!guard(req, res)) return;
  store.remove(req.params.token);
  const back = req.body && req.body.back ? '/admin/patient/' + encodeURIComponent(req.body.back) : '/admin';
  res.redirect(back);
});

// A session in the patient file: status, payment, reason, and clinical notes.
function sessionFileRow(b) {
  const svc = serviceById(b.serviceId);
  const col = b.status === 'confirmed' ? '#4E7A5E' : b.status === 'pending' ? '#B4562F' : b.status === 'proposed' ? '#8a6d3b' : b.status === 'completed' ? '#3E5170' : '#8A9188';
  const pay = b.paid
    ? `<span class="pill" style="background:#4E7A5E;margin-left:6px">Paid €${esc(b.paidAmount != null ? b.paidAmount : '')}</span>`
    : (['confirmed', 'completed'].includes(b.status) ? '<span class="pill" style="background:#8A9188;margin-left:6px">Unpaid</span>' : '');
  return `<div class="card">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
      <div><b>${esc(b.starts_at.slice(0, 16))}</b> · ${esc(b.serviceName)}${svc ? ' · €' + svc.price : ''}</div>
      <span><span class="pill" style="background:${col}">${esc(b.status)}</span>${pay}</span>
    </div>
    ${b.notes ? `<div class="muted" style="margin-top:6px">Reason given: ${esc(b.notes)}</div>` : ''}
    ${['confirmed', 'completed'].includes(b.status) ? clinicalForm(b) + filesSection(b) : ''}
    <div style="margin-top:8px">${deleteBtn(b.token, b.email)}</div>
  </div>`;
}
function filesSection(b) {
  const files = filesStore.byBooking(b.token);
  const labels = store.readFileLabels();
  const list = files.length
    ? files.map((f) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #EFEAE0"><span>📄 <b>${esc(f.label)}</b> · <a href="/files/${esc(f.id)}">${esc(f.originalName)}</a></span><form method="POST" action="/admin/file/${esc(f.id)}/delete" onsubmit="return confirm('Delete this file?')"><button class="ghost" style="margin:0">Remove</button></form></div>`).join('')
    : '<div class="muted">No files yet.</div>';
  return `<div style="margin-top:12px">
    <div style="font-weight:600;font-size:13px">Files for the patient</div>
    ${list}
    <form method="POST" action="/admin/booking/${esc(b.token)}/file" enctype="multipart/form-data" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select name="label" required style="padding:8px;border:1px solid #C9C2B2;border-radius:8px;font:inherit">${labels.map((l) => `<option>${esc(l)}</option>`).join('')}</select>
      <input type="file" name="file" required style="font-size:13px">
      <button class="dark" style="margin:0">Upload</button>
    </form>
    <a href="/admin/file-labels" style="font-size:12px">Manage labels →</a>
  </div>`;
}
function clinicalForm(b) {
  const clinical = secure.decrypt(b.clinicalEnc) || {};
  const soap = clinical.soap || (b.sessionNotes ? { s: b.sessionNotes } : {});
  const ta = (name, label, val) => `<div style="margin-top:6px"><div class="muted">${label}</div><textarea name="${name}" rows="2" style="width:100%;padding:8px;border:1px solid #C9C2B2;border-radius:8px;font:inherit;box-sizing:border-box">${esc(val || '')}</textarea></div>`;
  return `<form method="POST" action="/admin/booking/${esc(b.token)}/clinical" style="margin-top:10px">
    <div style="font-weight:600;font-size:13px">Clinical notes — private (SOAP)</div>
    ${ta('s', 'Subjective', soap.s)}${ta('o', 'Objective', soap.o)}${ta('a', 'Assessment', soap.a)}${ta('p', 'Plan', soap.p)}
    <div style="font-weight:600;font-size:13px;margin-top:12px">Outcome measures</div>
    <div>${config.outcomes.map((m) => {
      const v = (clinical.outcomes && clinical.outcomes[m.id] != null) ? clinical.outcomes[m.id] : '';
      return `<span style="display:inline-block;margin:6px 12px 0 0"><div class="muted">${esc(m.label)}</div><input type="number" name="out_${esc(m.id)}" value="${esc(v)}"${m.min != null ? ` min="${m.min}"` : ''}${m.max != null ? ` max="${m.max}"` : ''} step="any" style="width:96px;padding:8px;border:1px solid #C9C2B2;border-radius:8px;font:inherit"></span>`;
    }).join('')}</div>
    <div style="font-weight:600;font-size:13px;margin-top:12px">Recommendation for the patient <span class="muted" style="font-weight:400">(they can see this)</span></div>
    <textarea name="recommendation" rows="2" style="width:100%;padding:8px;border:1px solid #C9C2B2;border-radius:8px;font:inherit;box-sizing:border-box;margin-top:6px">${esc(clinical.recommendation || '')}</textarea>
    <label style="display:block;font-size:12px;color:#6C7A70;margin-top:8px"><input type="checkbox" name="notify" style="width:auto;margin-right:6px">Email this recommendation to the patient</label>
    <button class="dark" style="margin-top:8px">Save</button>
  </form>`;
}

// Hand-rolled inline SVG line chart for one outcome measure over sessions.
function outcomeChart(label, series, min, max) {
  if (!series.length) return '';
  const W = 320, H = 96, padL = 8, padR = 8, padT = 16, padB = 20;
  const n = series.length;
  const xAt = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (n - 1));
  const lo = min != null ? min : Math.min(...series.map((s) => s.v));
  const hi = max != null ? max : Math.max(...series.map((s) => s.v));
  const span = (hi - lo) || 1;
  const yAt = (v) => padT + (H - padT - padB) * (1 - (v - lo) / span);
  const pts = series.map((s, i) => [xAt(i), yAt(s.v)]);
  const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const dots = pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="#4E7A5E"/><text x="${p[0].toFixed(1)}" y="${(p[1] - 6).toFixed(1)}" font-size="9" fill="#3D4A42" text-anchor="middle">${esc(series[i].v)}</text>`).join('');
  return `<div style="margin-bottom:14px"><div style="font-size:13px;font-weight:600;margin-bottom:4px">${esc(label)}</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:440px;height:auto;background:#FFFDF8;border:1px solid #E4DED1;border-radius:8px">
      <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#E4DED1"/>
      <path d="${path}" fill="none" stroke="#4E7A5E" stroke-width="2"/>${dots}
      <text x="${padL}" y="${H - 5}" font-size="9" fill="#8A9188">${esc(series[0].date)}</text>
      <text x="${W - padR}" y="${H - 5}" font-size="9" fill="#8A9188" text-anchor="end">${esc(series[n - 1].date)}</text>
    </svg></div>`;
}
function progressCard(bookings) {
  const asc = bookings.slice().sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .map((b) => ({ date: b.starts_at.slice(0, 10), c: secure.decrypt(b.clinicalEnc) || {} }));
  let charts = '';
  for (const m of config.outcomes) {
    const series = asc
      .filter((x) => x.c.outcomes && x.c.outcomes[m.id] != null && x.c.outcomes[m.id] !== '')
      .map((x) => ({ date: x.date, v: Number(x.c.outcomes[m.id]) }))
      .filter((x) => Number.isFinite(x.v));
    if (series.length) charts += outcomeChart(m.label, series, m.min, m.max);
  }
  return charts ? `<div class="card"><div class="muted" style="margin-bottom:8px">Progress</div>${charts}</div>` : '';
}

// Patients directory — searchable by name.
app.get('/admin/patients', (req, res) => {
  res.type('text/html');
  if (!adminAuthed(req)) return res.redirect('/admin');
  const bookings = store.readAll();
  const byEmail = new Map();
  (users.list() || []).forEach((u) => byEmail.set(u.email, { name: u.name, email: u.email, phone: u.phone }));
  bookings.forEach((b) => { if (b.email && !byEmail.has(b.email)) byEmail.set(b.email, { name: b.name, email: b.email, phone: b.phone }); });
  const today = A.todayLocal();
  let patients = [...byEmail.values()].map((p) => {
    const mine = bookings.filter((b) => b.email === p.email);
    const completed = mine.filter((b) => b.status === 'completed').length;
    const next = mine.filter((b) => ['confirmed', 'pending', 'proposed'].includes(b.status) && b.starts_at.slice(0, 10) >= today).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
    return { ...p, completed, next };
  });
  patients.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const rows = patients.length ? patients.map((p) => `<a class="patrow" data-search="${esc(((p.name || '') + ' ' + (p.email || '') + ' ' + (p.phone || '')).toLowerCase())}" href="/admin/patient/${encodeURIComponent(p.email)}" style="display:block;text-decoration:none;color:inherit"><div class="card" style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
      <div><b>${esc(p.name || p.email)}</b><br><span class="muted">${esc(p.email)}${p.phone ? ' · ' + esc(p.phone) : ''}</span></div>
      <div class="muted" style="text-align:right">${p.completed} session${p.completed === 1 ? '' : 's'}${p.next ? '<br><span style="color:#4E7A5E">Next: ' + esc(p.next.starts_at.slice(0, 16)) + '</span>' : ''}</div>
    </div></a>`).join('') : '<p class="muted">No patients yet.</p>';
  const search = `<div style="margin-bottom:14px"><input id="patSearch" type="text" oninput="filterPatients()" value="${esc(req.query.q || '')}" placeholder="Search by name, email or phone…" autocomplete="off" style="width:100%;padding:10px;border:1px solid #C9C2B2;border-radius:8px;font:inherit"></div>`;
  const script = `<p id="patNone" class="muted" style="display:none">No patients match your search.</p>
<script>function filterPatients(){var q=document.getElementById('patSearch').value.trim().toLowerCase();var rows=document.querySelectorAll('.patrow');var shown=0;rows.forEach(function(el){var hit=!q||el.getAttribute('data-search').indexOf(q)>-1;el.style.display=hit?'block':'none';if(hit)shown++;});var none=document.getElementById('patNone');if(none)none.style.display=(rows.length&&!shown)?'block':'none';}filterPatients();</script>`;
  res.send(adminShell('Patients', `${search}${rows}${script}`, 'patients'));
});

// One patient's digital file: summary, health form, and session history.
app.get('/admin/patient/:email', (req, res) => {
  res.type('text/html');
  if (!adminAuthed(req)) return res.redirect('/admin');
  const email = String(req.params.email || '');
  const user = users.findByEmail(email);
  const bookings = store.readAll().filter((b) => (b.email || '').toLowerCase() === email.toLowerCase()).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  const today = A.todayLocal();
  const name = (user && user.name) || (bookings[0] && bookings[0].name) || email;
  const phone = (user && user.phone) || (bookings[0] && bookings[0].phone) || '';
  const genderAge = user ? [user.gender, user.age ? user.age + ' yrs' : ''].filter(Boolean).join(' · ') : '';
  const completed = bookings.filter((b) => b.status === 'completed').length;
  const totalPaid = bookings.filter((b) => b.paid).reduce((s, b) => s + (Number(b.paidAmount) || 0), 0);
  const upcoming = bookings.filter((b) => ['confirmed', 'pending', 'proposed'].includes(b.status) && b.starts_at.slice(0, 10) >= today).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];

  const summary = `<div class="card">
    <h2 style="margin:0 0 4px">${esc(name)}</h2>
    <div class="muted">${esc(email)}${phone ? ' · <a href="tel:' + esc(phone) + '">' + esc(phone) + '</a>' : ''}${genderAge ? ' · ' + esc(genderAge) : ''}</div>
    <div style="margin-top:10px">
      <span class="stat"><b>${completed}</b><span>Sessions done</span></span>
      <span class="stat"><b>${bookings.length}</b><span>Total bookings</span></span>
      <span class="stat"><b>€${totalPaid.toFixed(0)}</b><span>Paid to date</span></span>
    </div>
    ${upcoming
      ? `<div style="margin-top:12px;background:#EDF1E9;border:1px solid #4E7A5E;border-radius:10px;padding:10px 14px"><b>Upcoming:</b> ${esc(upcoming.starts_at.slice(0, 16))} · ${esc(upcoming.serviceName)} <span class="pill" style="background:${upcoming.status === 'confirmed' ? '#4E7A5E' : '#B4562F'};margin-left:6px">${esc(upcoming.status)}</span></div>`
      : '<div class="muted" style="margin-top:12px">No upcoming session booked.</div>'}
  </div>`;

  const rec = intakes.get(email);
  let intakeHtml;
  if (!rec) {
    intakeHtml = '<p class="muted">No health form completed yet.</p>';
  } else {
    intakeHtml = config.intake.fields.map((f) => `<div style="padding:7px 0;border-bottom:1px solid #E4DED1"><div class="muted">${esc(f.label)}</div><div style="white-space:pre-wrap">${esc(rec.answers[f.id] || '—')}</div></div>`).join('');
    const consentBits = config.intake.consents.map((c) => {
      const cc = rec.consents && rec.consents[c.id];
      return `<div style="font-size:12px;color:#6C7A70;margin-top:6px">${cc && cc.agreed ? '✓ agreed' : '✗ not agreed'} — ${esc(c.text)}${cc && cc.at ? ' <em>(' + esc(new Date(cc.at).toLocaleString('en-IE')) + ')</em>' : ''}</div>`;
    }).join('');
    intakeHtml += `<div style="margin-top:12px"><div class="muted">Consent (version ${esc(rec.version || '')})</div>${consentBits}</div>`;
  }

  const report = filesStore.patientReport(email);
  const reportHtml = report
    ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #E4DED1"><div class="muted">Report uploaded by patient</div>📄 <a href="/files/${esc(report.id)}">${esc(report.originalName)}</a></div>`
    : '';

  const hepDin = 'padding:9px;border:1px solid #C9C2B2;border-radius:8px;font:inherit';
  const exercises = hep.forPatient(email);
  const hepList = exercises.length
    ? exercises.map((x) => {
        const bits = [x.sets && x.sets + ' sets', x.reps && x.reps + ' reps', x.hold && 'hold ' + x.hold, x.freq].filter(Boolean).join(' · ');
        return `<div style="border-bottom:1px solid #E4DED1;padding:10px 0;display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div><b>${esc(x.name)}</b>${bits ? '<br><span class="muted">' + esc(bits) + '</span>' : ''}${x.notes ? '<br><span style="white-space:pre-wrap">' + esc(x.notes) + '</span>' : ''}${x.video ? '<br>🎬 <a href="' + esc(x.video) + '" target="_blank" rel="noopener">Video</a>' : ''}</div>
          <form method="POST" action="/admin/hep/${esc(x.id)}/delete"><input type="hidden" name="email" value="${esc(email)}"><button class="ghost" style="margin:0">Remove</button></form>
        </div>`;
      }).join('')
    : '<p class="muted">No exercises assigned yet.</p>';
  const hepCard = `<div class="card"><div class="muted" style="margin-bottom:8px">Home exercise programme</div>
      ${hepList}
      <form method="POST" action="/admin/hep" style="margin-top:12px;display:grid;gap:8px">
        <input type="hidden" name="email" value="${esc(email)}">
        <input name="name" placeholder="Exercise name (e.g. Glute bridge)" required style="${hepDin}">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input name="sets" placeholder="Sets" style="width:90px;${hepDin}">
          <input name="reps" placeholder="Reps" style="width:90px;${hepDin}">
          <input name="hold" placeholder="Hold (e.g. 10s)" style="width:120px;${hepDin}">
          <input name="freq" placeholder="Frequency (e.g. 2×/day)" style="flex:1 1 140px;${hepDin}">
        </div>
        <textarea name="notes" placeholder="Notes / cues (optional)" rows="2" style="${hepDin}"></textarea>
        <input name="video" placeholder="Video link (optional, https://…)" style="${hepDin}">
        <button class="dark" style="margin:0;justify-self:start">Add exercise</button>
      </form></div>`;

  const inner = `${backLink('/admin/patients', 'Patients')}
      ${summary}
      ${progressCard(bookings)}
      <div class="card"><div class="muted" style="margin-bottom:8px">Health &amp; consent form</div>${intakeHtml}${reportHtml}</div>
      ${hepCard}
      <h2>Session history</h2>
      ${bookings.length ? bookings.map(sessionFileRow).join('') : '<p class="muted">No sessions yet.</p>'}`;
  res.send(adminShell('Patient file', inner, 'patients'));
});

// Week calendar view.
app.get('/admin/calendar', (req, res) => {
  res.type('text/html');
  if (!adminAuthed(req)) return res.redirect('/admin');
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : A.todayLocal();
  const monday = mondayOf(anchor);
  const prev = A.addDays(monday, -7), next = A.addDays(monday, 7);
  const active = store.activeBookings();
  const blkMap = store.blackoutMap();
  const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  let daysHtml = '';
  for (let i = 0; i < 7; i++) {
    const d = A.addDays(monday, i);
    const wins = blkMap.get(d);
    const fullDay = wins && wins.some((w) => w[0] <= 0 && w[1] >= 1440);
    const blockNote = !wins ? '' : fullDay
      ? '<div style="color:#B4562F;font-size:13px;font-weight:600">Blocked off (all day)</div>'
      : wins.map((w) => `<div style="color:#B4562F;font-size:12px">Blocked ${fmtMin(w[0])}–${fmtMin(w[1])}</div>`).join('');
    const dayBookings = active.filter((b) => b.starts_at.slice(0, 10) === d).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const items = fullDay
      ? blockNote
      : (blockNote + (dayBookings.length
      ? dayBookings.map((b) => {
          const col = b.status === 'confirmed' ? '#4E7A5E' : b.status === 'pending' ? '#B4562F' : '#8a6d3b';
          return `<a href="/admin/patient/${encodeURIComponent(b.email)}" style="display:block;text-decoration:none;color:inherit;padding:8px 0;border-top:1px solid #EFEAE0">
            <div style="font-weight:700;font-size:14px">${esc(b.starts_at.slice(11, 16))}</div>
            <div style="font-size:13px;color:#3D4A42;margin:2px 0 5px;overflow-wrap:anywhere">${esc(b.name)} · ${esc(b.serviceName)}</div>
            <span class="pill" style="background:${col}">${esc(b.status)}</span></a>`;
        }).join('')
      : (blockNote ? '' : '<div class="muted">—</div>')));
    daysHtml += `<div class="card"><div style="font-weight:700;margin-bottom:4px">${esc(dayLabel(d))}</div>${items}</div>`;
  }
  const inner = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><a class="ghost" style="text-decoration:none;padding:8px 12px;border-radius:8px" href="/admin/calendar?week=${prev}">← Prev</a><b>Week of ${esc(dayLabel(monday))}</b><a class="ghost" style="text-decoration:none;padding:8px 12px;border-radius:8px" href="/admin/calendar?week=${next}">Next →</a></div>
      <div class="calweek">${daysHtml}</div>`;
  res.send(adminShell('Calendar', inner, 'calendar'));
});

// --- optional: a simple read-only list of requests --------------------------
app.get('/bookings', (req, res) => {
  if (process.env.ADMIN_PASSWORD && req.query.key !== process.env.ADMIN_PASSWORD)
    return res.status(401).send('Add ?key=YOUR_ADMIN_PASSWORD to the URL.');
  const rows = store.readAll().sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const badge = (s) => {
    const col = s === 'confirmed' ? '#4E7A5E' : s === 'pending' ? '#B4562F' : '#8A9188';
    return `<span style="display:inline-block;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;color:#fff;background:${col};padding:3px 9px;border-radius:999px">${esc(s)}</span>`;
  };
  const link = (href, label, col) => `<a href="${href}" style="display:inline-block;font-size:13px;color:#fff;background:${col};padding:7px 13px;border-radius:8px;text-decoration:none;margin-right:6px">${label}</a>`;
  const cancelBtn = (t) => `<form method="POST" action="/booking/${esc(t)}/cancel" onsubmit="return confirm('Cancel and email the patient?')" style="display:inline"><button style="font-size:13px;color:#fff;background:#16201C;border:none;padding:7px 13px;border-radius:8px;cursor:pointer">Cancel</button></form>`;
  const reBtn = (t) => `<form method="POST" action="/booking/${esc(t)}/reschedule" style="display:inline-flex;gap:4px;align-items:center;margin-left:6px"><input type="datetime-local" name="datetime" required style="font-size:12px;padding:4px;border:1px solid #ccc;border-radius:6px"><button style="font-size:13px;color:#16201C;background:#fff;border:1px solid #999;padding:6px 11px;border-radius:8px;cursor:pointer">Change time</button></form>`;
  const body = rows.length ? rows.map((b) => {
    const actions = b.status === 'pending'
      ? link(`/booking/${b.token}/accept`, 'Accept', '#4E7A5E') + link(`/booking/${b.token}/reject`, 'Reject', '#B4562F') + cancelBtn(b.token) + reBtn(b.token)
      : b.status === 'confirmed' ? cancelBtn(b.token) + reBtn(b.token) : '';
    return `<div style="border-bottom:1px solid #E4DED1;padding:12px 0">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <div style="font-size:14px"><b>${esc(b.starts_at.slice(0, 16))}</b> · ${esc(b.serviceName)}<br>
          <span style="color:#6C7A70;font-size:13px">${esc(b.name)} · ${esc(b.email)}${b.phone ? ' · ' + esc(b.phone) : ''} · ${esc(b.formatName || b.format)}</span></div>
        <div>${badge(b.status)}</div></div>
      ${actions ? `<div style="margin-top:8px">${actions}</div>` : ''}</div>`;
  }).join('') : '<p>No requests yet.</p>';
  res.send(resultPage('Bookings', '<h2>Bookings</h2>' + body));
});

// --- front end + assets -----------------------------------------------------
app.get('/', (_req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.type('text').send('Virthy booking API is running. See /health');
});
app.get('/account', (_req, res) => {
  const p = path.join(__dirname, 'account.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.redirect('/');
});
app.get('/:file', (req, res, next) => {
  const name = req.params.file;
  if (!/^[\w.-]+\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?)$/.test(name)) return next();
  if (['server.js', 'config.js', 'availability.js', 'email.js', 'store.js', 'users.js', 'intakes.js', 'receipt.js', 'secure.js', 'files.js'].includes(name)) return next();
  const p = path.join(__dirname, name);
  if (fs.existsSync(p)) return res.sendFile(p);
  next();
});

// --- appointment reminders --------------------------------------------------
// Emails a reminder ~config.reminderHours before a confirmed appointment.
// Runs on an interval; a per-booking flag prevents duplicates.
function sendDueReminders() {
  try {
    const now = A.nowLocal(); // "YYYY-MM-DD HH:MM"
    const upto = A.localOfInstant(Date.now() + config.reminderHours * 3600e3);
    const list = store.readAll();
    let changed = false;
    for (const b of list) {
      if (b.status !== 'confirmed' || b.reminderSent) continue;
      const start = (b.starts_at || '').slice(0, 16);
      if (start > now && start <= upto) {
        email.patientReminder(b).catch(() => {});
        b.reminderSent = true;
        changed = true;
      }
    }
    if (changed) store.writeAll(list);
  } catch (e) { console.error('reminder job error:', e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Virthy booking API listening on ${PORT} · store: ${store.FILE}`);
  setTimeout(sendDueReminders, 15000);                 // shortly after boot
  setInterval(sendDueReminders, 20 * 60 * 1000);       // then every 20 minutes
});
