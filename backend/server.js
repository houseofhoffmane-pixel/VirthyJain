// Entry point for hosts that run `server.js` (e.g. Hostinger's Node app).
// The real application is the compiled TypeScript in dist/, which is built
// automatically by the "postinstall" script during `npm install`.
import { start } from './dist/server.js';

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
