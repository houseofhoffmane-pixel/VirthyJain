// Dev seed entry: `npm run seed`. Applies migrations then the initial data.
// In production (compiled, no tsx) use SEED_ON_BOOT=true for one deploy instead.
import { migrate } from '../src/lib/migrate.js';
import { seedInitialData } from '../src/lib/seed.js';
import { pool } from '../src/lib/db.js';

migrate()
  .then(() => seedInitialData())
  .then(() => {
    console.log('Seed complete: 4 services, 3 format templates (Mon–Fri), defaults.');
    return pool.end();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
