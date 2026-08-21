// Encrypted, file-based store for patient intake / health forms.
// The health answers are encrypted at rest (AES-256-GCM). Consent records
// (which statement, when) are kept in the clear as they're the legal record.

const fs = require('fs');
const os = require('os');
const path = require('path');
const secure = require('./secure');

const FILE = process.env.INTAKES_FILE || path.join(os.homedir(), 'virthy-intakes.json');
const enc = secure.encrypt;
const dec = secure.decrypt;

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
