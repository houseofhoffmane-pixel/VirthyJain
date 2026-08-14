// Entry point for hosts that run `server.js` (e.g. Hostinger's Node app).
// The real application is the compiled TypeScript in dist/, which is built
// automatically by the "postinstall" script during `npm install`.
// Importing it starts the server as a side effect (dist/server.js calls
// start() on load), so we must NOT call start() again here — that would try to
// listen twice and fail with EADDRINUSE.
import './dist/server.js';
