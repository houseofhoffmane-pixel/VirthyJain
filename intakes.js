// Encrypted, file-based store for patient intake / health forms.
// The health answers are encrypted at rest (AES-256-GCM). Consent records
// (which statement, when) are kept in the clear as they're the legal record.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.INTAKES_FILE || path.join(os.homedir(), 'virthy-intakes.json');

function key() {
  const k = process.env.INTAKE_ENCRYPTION_KEY;
  if (k) {
    const b = Buffer.from(k, 'base64');
    if (b.length === 32) return b;
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('[intakes] INTAKE_ENCRYPTION_KEY missing/invalid (need 32 bytes base64) — using insecure fallback');
  }
  return Buffer.alloc(32, 7); // dev-only fallback
}

function enc(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + data.toString('base64');
}
function dec(payload) {
  if (!payload) return null;
  const p = payload.split(':');
  if (p.length !== 4 || p[0] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(p[1], 'base64'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8'));
  } catch (e) { return null; }
}

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } }
function writeAll(list) { try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); return true; } catch (e) { console.error('[intakes] write', e.message); return false; } }
const norm = (e) => String(e || '').toLowerCase();

function get(email) {
  const r = readAll().find((x) => x.email === norm(email));
  if (!r) return null;
  return { email: r.email, completedAt: r.completedAt, version: r.version, consents: r.consents || {}, answers: dec(r.dataEnc) || {} };
}
function has(email) { return !!readAll().find((x) => x.email === norm(email)); }
function save(email, answers, consents) {
  const list = readAll();
  let r = list.find((x) => x.email === norm(email));
  if (!r) { r = { email: norm(email) }; list.push(r); }
  r.dataEnc = enc(answers || {});
  r.consents = consents || {};
  r.version = (consents && consents.version) || 'v1';
  r.completedAt = new Date().toISOString();
  writeAll(list);
  return get(email);
}
function remove(email) { writeAll(readAll().filter((x) => x.email !== norm(email))); }

module.exports = { get, has, save, remove };
