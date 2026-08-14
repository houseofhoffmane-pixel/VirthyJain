import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith('CHANGE_ME')) {
    throw new Error(`Missing/placeholder env var: ${name}`);
  }
  return v;
}
function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  env: opt('NODE_ENV', 'development'),
  port: Number(opt('PORT', '3000')),
  publicBaseUrl: opt('PUBLIC_BASE_URL', 'http://localhost:3000'),

  databaseUrl: opt('DATABASE_URL', 'postgres://virthy:virthy@localhost:5432/virthy'),
  databaseSsl: opt('DATABASE_SSL', 'disable') === 'require',

  // Comma-separated base64 32-byte keys; first is the active encryption key.
  dataEncryptionKeys: opt('DATA_ENCRYPTION_KEYS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  tokenSigningSecret: opt('TOKEN_SIGNING_SECRET', 'dev-token-secret-change-me'),
  sessionSecret: opt('SESSION_SECRET', 'dev-session-secret-change-me'),

  adminEmail: opt('ADMIN_EMAIL', 'virthy@virthyjain.ie'),
  adminPasswordHash: opt('ADMIN_PASSWORD_HASH', ''),

  smtp: {
    host: opt('SMTP_HOST', 'localhost'),
    port: Number(opt('SMTP_PORT', '587')),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  mailFrom: opt('MAIL_FROM', 'Virthy Jain Physiotherapy <bookings@virthyjain.ie>'),
  practitionerNotifyEmail: opt('PRACTITIONER_NOTIFY_EMAIL', 'virthy@virthyjain.ie'),
  mailDryRun: opt('MAIL_DRY_RUN', 'true') === 'true',

  retentionMonths: Number(opt('RETENTION_MONTHS', '84')),

  // The single practitioner. Fixed id — there is exactly one calendar.
  practitionerId: 1,
  timezone: 'Europe/Dublin',
};

export function assertProductionSecrets() {
  if (config.env === 'production') {
    req('DATA_ENCRYPTION_KEYS');
    req('TOKEN_SIGNING_SECRET');
    req('SESSION_SECRET');
    req('ADMIN_PASSWORD_HASH');
  }
}
