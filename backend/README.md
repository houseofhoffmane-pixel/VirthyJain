# Virthy Jain — booking backend (simple)

Plain Node.js + Express + **MySQL**. No build step, no TypeScript. The file
Hostinger runs (`server.js`) **is** the app.

## Files
- `config.js` — services, prices, formats, weekly hours, buffers. **Edit here.**
- `db.js` — MySQL connection + creates the one `bookings` table on start.
- `availability.js` — works out free slots.
- `email.js` — optional confirmations (does nothing if SMTP not set).
- `server.js` — the whole app + admin panel.

## Deploy on Hostinger
1. **Databases → create a MySQL database** and note the name, user, password, host.
2. In the Node app **Settings**:
   - Root directory: `backend`
   - Entry file: `server.js`
   - Build command: *(none)* — there's no build step.
3. **Environment variables** — see `.env.example`. Minimum to run:
   `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `ADMIN_PASSWORD`, `PUBLIC_URL`.
4. Deploy. Check `PUBLIC_URL/health` → `{"ok":true,"db":true}`.
5. Admin panel: `PUBLIC_URL/admin` (log in with `ADMIN_USER` / `ADMIN_PASSWORD`).

## API (for the front end)
- `GET /api/services`
- `GET /api/formats`
- `GET /api/availability?serviceId=1&format=clinic&from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /api/bookings` — body: `{ serviceId, format, start:"YYYY-MM-DD HH:MM:SS", name, email, phone?, referrer?, notes?, website?("" honeypot) }`
  - `201` created (pending), `409 slot_taken` with `alternatives`, `429` rate-limited.
- `GET /manage/:token` — patient cancel page (link emailed to them).

## Double-booking
All booking writes take a MySQL named lock (`GET_LOCK`) for the single
practitioner and re-check the slot before inserting, so two people can't grab
the same time. Overlaps of different durations and the buffer/travel gap are
checked too. Times are Irish local; no timezone conversion.

## Local run
```
cp .env.example .env   # fill in a local MySQL
npm install
npm start
```
