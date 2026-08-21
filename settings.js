// Admin-editable practice settings: the service list and weekly opening hours.
// config.js holds the DEFAULTS; anything the physio changes in the admin is
// saved to a JSON file in the home directory (survives redeploys) and wins.

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const FILE = process.env.SETTINGS_FILE || path.join(os.homedir(), 'virthy-settings.json');

function readOverrides() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}
function writeOverrides(obj) {
  try { fs.writeFileSync(FILE, JSON.stringify(obj, null, 2)); return true; }
  catch (e) { console.error('[settings] write', e.message); return false; }
}

// --- services --------------------------------------------------------------
function getServices() {
  const o = readOverrides();
  return Array.isArray(o.services) && o.services.length ? o.services : config.services;
}
// Accepts [{id?, name, duration, price}]. Keeps existing ids, assigns new ones,
// drops blank rows. Bookings store the service name at creation, so renaming a
// service never rewrites history.
function saveServices(rows) {
  const existing = getServices();
  let maxId = existing.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
  const clean = (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const name = String(r.name || '').trim();
      const duration = Math.round(Number(r.duration));
      const price = Math.round(Number(r.price));
      if (!name || !(duration > 0) || !(price >= 0)) return null;
      const id = Number(r.id) > 0 ? Number(r.id) : ++maxId;
      return { id, name, duration, price };
    })
    .filter(Boolean);
  if (!clean.length) return false; // never allow zero services
  const o = readOverrides();
  o.services = clean;
  return writeOverrides(o);
}

// --- hours -----------------------------------------------------------------
function getHours() {
  const o = readOverrides();
  return o.hours && typeof o.hours === 'object' ? o.hours : config.hours;
}
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
// Parse "08:00-11:45, 14:00-17:45" -> [["08:00","11:45"],["14:00","17:45"]].
// Blank/invalid pieces are skipped; a valid window needs open < close.
function parseWindows(text) {
  return String(text || '')
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => chunk.split(/[-–]/).map((s) => s.trim()))
    .filter((pair) => pair.length === 2 && HM.test(pair[0]) && HM.test(pair[1]) && pair[0] < pair[1])
    .map((pair) => [pair[0], pair[1]]);
}
// hoursInput: { clinic: {1:"08:00-11:45, 14:00-17:45", 2:"", …}, home:{…} }.
function saveHours(hoursInput, formatKeys) {
  const out = {};
  for (const fmt of formatKeys) {
    const perDay = (hoursInput && hoursInput[fmt]) || {};
    const days = {};
    for (let d = 0; d <= 6; d++) {
      const w = parseWindows(perDay[d]);
      if (w.length) days[d] = w;
    }
    out[fmt] = days;
  }
  const o = readOverrides();
  o.hours = out;
  return writeOverrides(o);
}
// For the editor: "08:00-11:45, 14:00-17:45" for one format+weekday.
function windowsText(fmt, weekday) {
  const w = (getHours()[fmt] || {})[weekday] || [];
  return w.map((pair) => `${pair[0]}-${pair[1]}`).join(', ');
}

// Wipe overrides -> fall back to config.js defaults.
function resetAll() { return writeOverrides({}); }

module.exports = { FILE, getServices, saveServices, getHours, saveHours, windowsText, resetAll };
