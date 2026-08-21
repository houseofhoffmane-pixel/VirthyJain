// Per-session file attachments. Binary files are encrypted at rest (AES-256-GCM)
// and stored in a folder in the home directory (survives redeploys). Metadata
// (label, original name, which booking/patient) is kept in a JSON index.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const secure = require('./secure');

const DIR = process.env.FILES_DIR || path.join(os.homedir(), 'virthy-files');
const META = path.join(DIR, 'files-index.json');

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* ignore */ } }
function readMeta() { try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch (e) { return []; } }
function writeMeta(list) { ensureDir(); try { fs.writeFileSync(META, JSON.stringify(list, null, 2)); return true; } catch (e) { console.error('[files] meta write', e.message); return false; } }

function add({ bookingToken, patientEmail, label, originalName, mime, buffer }) {
  ensureDir();
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(DIR, id + '.enc'), secure.encryptBuffer(buffer));
  const rec = {
    id, bookingToken, patientEmail: (patientEmail || '').toLowerCase(),
    label: label || 'File', originalName: originalName || 'file', mime: mime || 'application/octet-stream',
    size: buffer.length, uploadedAt: new Date().toISOString(),
  };
  const list = readMeta();
  list.push(rec);
  writeMeta(list);
  return rec;
}
function byId(id) { return readMeta().find((f) => f.id === id) || null; }
function byBooking(token) { return readMeta().filter((f) => f.bookingToken === token); }
function readBuffer(id) {
  try { return secure.decryptBuffer(fs.readFileSync(path.join(DIR, id + '.enc'))); } catch (e) { return null; }
}
function remove(id) {
  const rec = byId(id);
  if (rec) { try { fs.unlinkSync(path.join(DIR, rec.id + '.enc')); } catch (e) { /* ignore */ } }
  writeMeta(readMeta().filter((f) => f.id !== id));
}

module.exports = { DIR, add, byId, byBooking, readBuffer, remove };
