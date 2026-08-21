// Tiny file-based store for bookings — no database, no credentials.
// Bookings are kept in a JSON file. By default it lives in the home directory
// (which survives redeploys on Hostinger, unlike the app folder). You can
// override the location with the DATA_FILE env var.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = process.env.DATA_FILE || path.join(os.homedir(), 'virthy-bookings.json');
const BLACKOUTS_FILE = process.env.BLACKOUTS_FILE || path.join(os.homedir(), 'virthy-blackouts.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return []; // no file yet, or unreadable -> start empty
  }
}

function writeAll(list) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
    return true;
  } catch (e) {
    console.error('[store] could not write', FILE, '-', e.message);
    return false;
  }
}

// Bookings that currently occupy the calendar (block a slot). A 'proposed'
// booking (Virthy offered a new time, patient hasn't replied) still holds it.
function activeBookings() {
  return readAll().filter((b) => ['pending', 'confirmed', 'proposed'].includes(b.status));
}

// --- holiday / day block-outs ----------------------------------------------
function addOneDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function readBlackouts() {
  try { return JSON.parse(fs.readFileSync(BLACKOUTS_FILE, 'utf8')); } catch (e) { return []; }
}
function writeBlackouts(list) {
  try { fs.writeFileSync(BLACKOUTS_FILE, JSON.stringify(list, null, 2)); return true; }
  catch (e) { console.error('[store] blackouts write', e.message); return false; }
}
// startTime/endTime are optional 'HH:MM'. Both present => only that window is
// blocked each day; otherwise the whole day is blocked.
function addBlackout(from, to, reason, startTime, endTime) {
  const list = readBlackouts();
  const rec = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    from, to: to || from, reason: reason || '',
    startTime: startTime || '', endTime: endTime || '',
  };
  list.push(rec);
  writeBlackouts(list);
  return rec;
}
function removeBlackout(id) { writeBlackouts(readBlackouts().filter((x) => x.id !== id)); }
const hmToMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
// Map of 'YYYY-MM-DD' -> array of [startMin, endMin] blocked windows.
// A whole-day block is [0, 1440].
function blackoutMap() {
  const map = new Map();
  for (const bl of readBlackouts()) {
    const win = (bl.startTime && bl.endTime) ? [hmToMin(bl.startTime), hmToMin(bl.endTime)] : [0, 1440];
    let d = bl.from; const end = bl.to || bl.from; let guard = 0;
    while (d <= end && guard++ < 400) {
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(win);
      d = addOneDay(d);
    }
  }
  return map;
}
// Backward-compat: Set of days that are blocked for the WHOLE day.
function blackoutDates() {
  const set = new Set();
  for (const [d, wins] of blackoutMap()) if (wins.some((w) => w[0] <= 0 && w[1] >= 1440)) set.add(d);
  return set;
}

function findByToken(token) {
  return readAll().find((b) => b.token === token) || null;
}

function add(booking) {
  const list = readAll();
  list.push(booking);
  return writeAll(list);
}

function updateStatus(token, status) {
  const list = readAll();
  const b = list.find((x) => x.token === token);
  if (!b) return null;
  b.status = status;
  b.updated_at = new Date().toISOString();
  writeAll(list);
  return b;
}

// Permanently delete a booking (and its data) by token.
function remove(token) { return writeAll(readAll().filter((b) => b.token !== token)); }

// Set arbitrary fields on a booking (e.g. { paid: true }).
function patch(token, fields) {
  const list = readAll();
  const b = list.find((x) => x.token === token);
  if (!b) return null;
  Object.assign(b, fields);
  b.updated_at = new Date().toISOString();
  writeAll(list);
  return b;
}

module.exports = {
  FILE, readAll, writeAll, activeBookings, findByToken, add, updateStatus, patch, remove,
  readBlackouts, addBlackout, removeBlackout, blackoutDates, blackoutMap,
};
