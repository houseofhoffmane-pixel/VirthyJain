import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Simple signed-cookie session for the single admin user. The cookie holds
// the admin email + an HMAC; no server-side session store needed.
const COOKIE = 'virthy_admin';

function sign(value: string): string {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

export function issueSession(reply: FastifyReply, email: string): void {
  const issued = Date.now().toString();
  const value = `${email}|${issued}`;
  const cookie = `${Buffer.from(value).toString('base64url')}.${sign(value)}`;
  reply.setCookie(COOKIE, cookie, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: 60 * 60 * 12, // 12h
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

export function getSessionEmail(req: FastifyRequest): string | null {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const value = Buffer.from(body, 'base64url').toString('utf8');
  const expected = sign(value);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [email, issued] = value.split('|');
  if (!email || !issued) return null;
  if (Date.now() - Number(issued) > 12 * 3600_000) return null;
  return email;
}

export async function verifyCredentials(email: string, password: string): Promise<boolean> {
  if (email.trim().toLowerCase() !== config.adminEmail.toLowerCase()) return false;
  if (!config.adminPasswordHash) {
    // Dev convenience only: allow "changeme" when no hash is configured.
    return config.env !== 'production' && password === 'changeme';
  }
  return bcrypt.compare(password, config.adminPasswordHash);
}

/** Guard for admin routes. Redirects browsers to /admin/login, 401s API calls. */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): string | null {
  const email = getSessionEmail(req);
  if (email) return email;
  if (req.headers.accept?.includes('text/html')) {
    reply.redirect('/admin/login');
  } else {
    reply.code(401).send({ error: 'unauthorized' });
  }
  return null;
}
