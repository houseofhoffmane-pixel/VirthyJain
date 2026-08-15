// Tiny file-based store for bookings — no database, no credentials.
// Bookings are kept in a JSON file. By default it lives in the home directory
// (which survives redeploys on Hostinger, unlike the app folder). You can
// override the location with the DATA_FILE env var.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = process.env.DATA_FILE || path.join(os.homedir(), 'virthy-bookings.json');

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

// Bookings that currently occupy the calendar (block a slot).
function activeBookings() {
  return readAll().filter((b) => b.status === 'pending' || b.status === 'confirmed');
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

module.exports = { FILE, readAll, writeAll, activeBookings, findByToken, add, updateStatus };
