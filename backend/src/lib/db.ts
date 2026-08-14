import pg from 'pg';
import { config } from '../config.js';

// All timestamps are stored as UTC (timestamptz). node-postgres returns
// timestamptz as JS Date objects (correctly offset-aware); we convert to the
// Dublin zone for presentation via Luxon in lib/time.ts. We deliberately do
// NOT override the type parser — the default Date is unambiguous UTC, whereas
// the raw text form ("... +00") is not valid ISO for Luxon/Date.

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Managed Postgres (Supabase/Neon) requires TLS. We keep the connection
  // encrypted but don't verify the CA chain by default, since providers use
  // certs not always in the system trust store (avoids "self-signed cert in
  // chain" errors). Set DATABASE_SSL=verify for strict CA verification.
  ssl: config.databaseSsl
    ? { rejectUnauthorized: config.databaseSslVerify }
    : undefined,
  max: 10,
});

export type Db = pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: any[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Run `fn` inside a transaction. `isolation` defaults to SERIALIZABLE, which —
 * together with the tstzrange EXCLUDE constraint — is what makes concurrent
 * booking of the same slot safe. On a serialization failure (40001) or a
 * deadlock (40P01) the whole transaction is retried a few times.
 */
export async function withTransaction<T>(
  fn: (client: Db) => Promise<T>,
  isolation: 'SERIALIZABLE' | 'READ COMMITTED' = 'SERIALIZABLE',
  retries = 5,
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      const code = err?.code;
      if ((code === '40001' || code === '40P01') && attempt < retries) {
        attempt++;
        // small jittered backoff
        await new Promise((r) => setTimeout(r, 15 * attempt + Math.random() * 20));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function closePool() {
  await pool.end();
}
