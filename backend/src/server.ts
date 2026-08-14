import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { config, assertProductionSecrets } from './config.js';
import { publicRoutes } from './routes/public.js';
import { manageRoutes } from './routes/manage.js';
import { adminRoutes } from './routes/admin.js';
import { expirePending } from './jobs/expirePending.js';
import { migrate } from './lib/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', '..', 'index.html'); // the existing front end

export async function buildServer() {
  assertProductionSecrets();
  const app = Fastify({
    logger: config.env === 'production' ? true : { transport: undefined },
    trustProxy: true, // behind an EU reverse proxy / load balancer
  });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(formbody); // admin/manage forms post urlencoded
  await app.register(rateLimit, { global: false, max: 300, timeWindow: '1 minute' });

  // Minimal CORS for the public API (same-origin in production; permissive in dev).
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api')) {
      const origin = config.env === 'production' ? config.publicBaseUrl : (req.headers.origin || '*');
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') reply.code(204).send();
    }
  });

  await app.register(publicRoutes);
  await app.register(manageRoutes);
  await app.register(adminRoutes);

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // Serve the existing front end at / (unchanged).
  app.get('/', async (_req, reply) => {
    try {
      const html = await readFile(INDEX_HTML, 'utf8');
      reply.type('text/html').send(html);
    } catch {
      reply.code(404).send('Front end not found');
    }
  });

  return app;
}

// Boot when run directly.
/**
 * Full boot: migrate (idempotent), optional one-time seed, then listen.
 * Exported so a plain `server.js` entry file can start the app on hosts that
 * expect one, and called directly when this file itself is the entry point.
 */
export async function start() {
  // Apply DB migrations on boot (idempotent). SKIP_MIGRATE_ON_BOOT=true opts out.
  if (process.env.SKIP_MIGRATE_ON_BOOT !== 'true') {
    await migrate();
  }
  // One-time seeding: set SEED_ON_BOOT=true for a single deploy, then remove it.
  // Non-destructive, so leaving it on won't clobber admin edits.
  if (process.env.SEED_ON_BOOT === 'true') {
    const { seedInitialData } = await import('./lib/seed.js');
    await seedInitialData();
  }

  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`Virthy booking backend on :${config.port} (${config.env})`);

  // In-process safety net for expiring pending holds every 5 minutes.
  setInterval(() => {
    expirePending().catch((e) => app.log.error(e));
  }, 5 * 60_000).unref();

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
