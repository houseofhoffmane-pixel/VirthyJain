// File-based user accounts — no database. Passwords are bcrypt-hashed.
// Stored next to the bookings file (home directory, survives redeploys).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const FILE = process.env.USERS_FILE || path.join(os.homedir(), 'virthy-users.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; }
}
function writeAll(list) {
  try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); return true; }
  catch (e) { console.error('[users] could not write', FILE, '-', e.message); return false; }
}

const norm = (e) => String(e || '').trim().toLowerCase();

function findByEmail(email) {
  const e = norm(email);
  return readAll().find((u) => u.email === e) || null;
}

// Public view of a user (never expose the password hash).
function publicUser(u) {
  if (!u) return null;
  return { name: u.name, email: u.email, phone: u.phone, gender: u.gender, age: u.age };
}

function create({ name, email, phone, gender, age, password }) {
  const list = readAll();
  const rec = {
    email: norm(email), name: String(name).trim(), phone: String(phone || '').trim(),
    gender: gender || '', age: age || '', passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
  };
  list.push(rec);
  writeAll(list);
  return rec;
}

function verify(email, password) {
  const u = findByEmail(email);
  if (!u) return null;
  return bcrypt.compareSync(password, u.passwordHash) ? u : null;
}

// Password reset: create a one-hour token, or return null if no such user.
function setReset(email) {
  const list = readAll();
  const u = list.find((x) => x.email === norm(email));
  if (!u) return null;
  u.resetToken = crypto.randomBytes(24).toString('hex');
  u.resetExpires = Date.now() + 60 * 60 * 1000;
  writeAll(list);
  return u;
}
function resetPassword(token, password) {
  const list = readAll();
  const u = list.find((x) => x.resetToken === token && x.resetExpires > Date.now());
  if (!u) return null;
  u.passwordHash = bcrypt.hashSync(password, 10);
  delete u.resetToken;
  delete u.resetExpires;
  writeAll(list);
  return u;
}
function tokenValid(token) {
  return !!readAll().find((u) => u.resetToken === token && u.resetExpires > Date.now());
}

module.exports = { FILE, findByEmail, publicUser, create, verify, setReset, resetPassword, tokenValid };
