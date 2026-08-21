// Home Exercise Programme. Exercises the physio assigns to a patient; the
// patient sees them in their account. Plain JSON file in the home directory
// (survives redeploys). Not health-sensitive free text beyond what the physio
// types, so stored in clear like bookings.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.HEP_FILE || path.join(os.homedir(), 'virthy-hep.json');

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } }
function writeAll(list) { try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); return true; } catch (e) { console.error('[hep] write', e.message); return false; } }

const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '');

function forPatient(email) {
  const e = (email || '').toLowerCase();
  return readAll().filter((x) => x.patientEmail === e).sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));
}
function add({ patientEmail, name, sets, reps, hold, freq, notes, video }) {
  const rec = {
    id: crypto.randomBytes(8).toString('hex'),
    patientEmail: (patientEmail || '').toLowerCase(),
    name: String(name || '').trim(),
    sets: String(sets || '').trim(),
    reps: String(reps || '').trim(),
    hold: String(hold || '').trim(),
    freq: String(freq || '').trim(),
    notes: String(notes || '').trim(),
    video: safeUrl(video),
    addedAt: new Date().toISOString(),
  };
  if (!rec.name) return null;
  const list = readAll();
  list.push(rec);
  writeAll(list);
  return rec;
}
function remove(id) { writeAll(readAll().filter((x) => x.id !== id)); }

module.exports = { FILE, forPatient, add, remove };
