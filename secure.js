// Shared AES-256-GCM encryption for health data (intake, clinical notes).
// Uses INTAKE_ENCRYPTION_KEY (32 bytes, base64). Payload: v1:iv:tag:data(base64).

const crypto = require('crypto');

function key() {
  const k = process.env.INTAKE_ENCRYPTION_KEY;
  if (k) {
    const b = Buffer.from(k, 'base64');
    if (b.length === 32) return b;
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('[secure] INTAKE_ENCRYPTION_KEY missing/invalid (need 32 bytes base64) — using insecure fallback');
  }
  return Buffer.alloc(32, 7); // dev-only fallback
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + data.toString('base64');
}

function decrypt(payload) {
  if (!payload) return null;
  const p = payload.split(':');
  if (p.length !== 4 || p[0] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(p[1], 'base64'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8'));
  } catch (e) { return null; }
}

module.exports = { encrypt, decrypt };
