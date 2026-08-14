import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Field-level encryption for health data (the `notes` field).
// AES-256-GCM. Payload format (base64):  v1:<keyIdx>:<iv>:<tag>:<ciphertext>
// Keys come from DATA_ENCRYPTION_KEYS (comma-separated base64, newest first).
// Rotation: encrypt with key[0]; decrypt tries the recorded key index.
// ---------------------------------------------------------------------------

function keys(): Buffer[] {
  const ks = config.dataEncryptionKeys;
  if (ks.length === 0) {
    if (config.env === 'production') {
      throw new Error('DATA_ENCRYPTION_KEYS is required in production');
    }
    // Deterministic dev key so local data survives restarts. NOT for prod.
    return [Buffer.alloc(32, 7)];
  }
  return ks.map((k) => {
    const b = Buffer.from(k, 'base64');
    if (b.length !== 32) throw new Error('Each data encryption key must be 32 bytes (base64)');
    return b;
  });
}

export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') return null;
  const key = keys()[0];
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    '0',
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

export function decryptField(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length !== 5 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted field');
  }
  const keyIdx = Number(parts[1]);
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const data = Buffer.from(parts[4], 'base64');
  const key = keys()[keyIdx] ?? keys()[0];
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Single-purpose signed tokens for account-free cancel / reschedule links.
// Format:  <base64url(payload)>.<base64url(hmac)>
// payload = { b: bookingId, p: purpose, v: tokenVersion, e: expiryEpoch }
// The token is bound to the booking's current token_version so that a
// reschedule (which bumps the version) invalidates any older link.
// ---------------------------------------------------------------------------

type TokenPurpose = 'manage'; // one link that can both cancel and reschedule

interface TokenPayload {
  b: number;
  p: TokenPurpose;
  v: number;
  e: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(data: string): string {
  return b64url(createHmac('sha256', config.tokenSigningSecret).update(data).digest());
}

export function makePatientToken(
  bookingId: number,
  tokenVersion: number,
  ttlDays = 400,
): string {
  const payload: TokenPayload = {
    b: bookingId,
    p: 'manage',
    v: tokenVersion,
    e: Math.floor(Date.now() / 1000) + ttlDays * 86400,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body)}`;
}

export function verifyPatientToken(token: string): TokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return null;
  }
  if (payload.p !== 'manage') return null;
  if (payload.e < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
