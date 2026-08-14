# Virthy Jain — booking backend

Backend for the single-practitioner physiotherapy booking site. The public
front end (`../index.html`) is unchanged; this service provides the API,
database, transactional email (with ICS), and a mobile-first admin panel.

**One practitioner ⇒ exactly one calendar.** All times are stored in **UTC** and
presented in **Europe/Dublin** with correct DST handling (Luxon).

## Stack

- Node 20 + TypeScript + Fastify
- PostgreSQL (raw SQL migrations; `btree_gist`, `pgcrypto`)
- Luxon (timezone/DST), Nodemailer (email), Zod (validation), bcryptjs (admin auth)

## Quick start

```bash
cp .env.example .env          # then fill in secrets (see below)
docker compose up -d db       # local Postgres (use EU-region managed PG in prod)
npm install
npm run migrate               # apply schema
npm run seed                  # 4 services + 3 weekly templates + defaults
npm run hash -- "a password"  # -> paste into ADMIN_PASSWORD_HASH
npm run dev                   # http://localhost:3000  (front end served at /)
```

Generate secrets:

```bash
openssl rand -base64 32   # DATA_ENCRYPTION_KEYS
openssl rand -base64 48   # TOKEN_SIGNING_SECRET / SESSION_SECRET
```

- Public site: `http://localhost:3000/`
- Admin panel: `http://localhost:3000/admin`
- Patient self-service: `http://localhost:3000/manage?token=…` (link is emailed)
- Emails in dev: written to `./outbox` (set `MAIL_DRY_RUN=false` to send).

## The concurrency guarantee (double booking)

This is enforced at the **database** level, not just in application checks:

- Every booking stores an `occupied` `tstzrange` =
  `[start − travel, end + buffer + travel)`. Travel applies on both sides for
  home visits; the inter-appointment buffer applies once (on the end).
- A **partial `EXCLUDE` constraint** (`bookings_no_overlap`, `migrations/002`)
  forbids any two **pending/confirmed** bookings for the practitioner from
  having overlapping `occupied` ranges. This blocks identical start times **and**
  overlaps of different durations (a 40-min 14:00 booking blocks a 55-min 14:30
  one), with buffer/travel counted as occupied.
- Writes run in a **SERIALIZABLE** transaction that re-checks the slot; we never
  trust the availability the page saw. A constraint violation is caught and
  returned as a distinct **409 `slot_taken`** carrying the **next three**
  available times. Reschedules go through the exact same guard and additionally
  bump `token_version` (invalidating the old email link).

Covered by `tests/concurrency.test.ts`:
1. two simultaneous requests for one slot → exactly one wins;
2. an overlapping booking of a different duration → blocked;
3. a reschedule into a slot taken meanwhile → rejected with `ConflictError`.

```bash
docker compose up -d db && npm test
```

## Booking lifecycle

`pending → confirmed → completed | no_show`, plus `cancelled`.

- New public requests are **pending** but **hold the slot** (pending is in the
  EXCLUDE constraint's `WHERE`). The site promises confirmation within 24h.
- On creation: patient gets a confirmation email (what to wear/bring + **ICS**),
  Virthy gets the request with the patient's notes.
- Pending requests **auto-expire** after `pending_expiry_hours` (releases the
  slot, emails the patient). Runs in-process every 5 min and via `npm run expire`
  (wire to cron).
- Every booking carries a **signed single-purpose token** → account-free
  cancel/reschedule at `/manage`. Cancellation is blocked inside
  `cancel_cutoff_hours`.

## Validation & abuse

Server-side validation on everything (Zod). Price, duration and end time are
**always looked up from the service row**, never taken from the client. Start
times must be on the grid the availability endpoint produced; past times and
times inside `min_notice_hours` are rejected. Rate limited **by IP and by
email**; a **honeypot** field (`website`) drops bots.

## API (public)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/services` | active services (id, name, durationMinutes, priceCents) |
| GET | `/api/formats` | active formats (key, name) |
| GET | `/api/availability?serviceId=&format=&from=&to=` | per-day slots |
| POST | `/api/bookings` | create; `201` ok, `409 slot_taken` with `alternatives`, `429` rate-limited |

`/api/availability` returns one entry per day with a **`working`** flag, so the
front end can tell a **fully-booked working day** (slots present, all `free:false`)
from a **non-working day** (`working:false`). Each slot: `{ label, startUtc, free }`.

```jsonc
// POST /api/bookings body
{ "serviceId": 1, "format": "clinic", "startUtc": "2026-09-14T08:00:00.000Z",
  "name": "…", "email": "…", "phone": "…", "referrer": "…", "notes": "…",
  "website": "" /* honeypot: must be empty */ }
```

## Wiring the existing front end (no redesign)

`index.html` currently mocks its data client-side. To go live, only the data
sources in the `<script type="text/x-dc">` block change — no markup/redesign:

- `services` / `modes` ← `GET /api/services` and `/api/formats`.
- `slotTimes(dayIdx, mode)` ← `GET /api/availability`; map each slot to the
  existing `{ label, disabled }` shape (`disabled = !slot.free`). Non-working
  days render no slot grid (use `working`).
- `submit` ← `POST /api/bookings` with `startUtc` (the chosen slot's UTC).
  On `409`, show `alternatives`; the existing "booked" panel is the success state.

The success copy, ICS, and "confirmed within 24 hours" wording already match the
lifecycle above.

## Admin panel (`/admin`)

Cookie-session auth (single user). Mobile-first. Week view (pending shown
distinctly from confirmed); one-tap **confirm/decline** with an optional line
that goes into the email; **add a manual booking**; **move/cancel** (notifies
patient); **blackouts** (holidays/courses); **weekly hours per format**;
**services** (edit name/duration/price, deactivate without deleting history);
**settings** (buffer, min notice, travel buffer, pending expiry, cancel cutoff);
**upcoming** list; **patient history** on any booking.

## Health data & GDPR (not optional)

- **Encryption at rest:** the `notes` field (special-category health data) is
  encrypted with **AES-256-GCM** (`DATA_ENCRYPTION_KEYS`, rotatable). Ciphertext
  only is stored.
- **Access logging:** every decrypt/read of notes is recorded in
  `notes_access_log`; all admin actions in `audit_log`.
- **Retention:** default **`RETENTION_MONTHS` = 84** (7 years, typical for Irish
  clinical records). Document/adjust to Virthy's policy; purge job can be added
  alongside `expirePending`.
- **Right to access / erasure:** Admin → *Patient / GDPR* exports everything held
  about one email as JSON, or **erases** it permanently.
- **No third-party analytics or session recording** on any page carrying the
  form. Serve the site and API from the **EU**; keep the database in the EU.
- **Email** is sent from a **real domain** (`MAIL_FROM`), never the personal
  Gmail shown as the public contact.

## Data model

`services`, `formats`, `availability_templates`, `blackouts`, `bookings`
(with `occupied tstzrange`, `status`, encrypted notes, token version, price/
duration snapshot), `settings`, `audit_log`, `notes_access_log`. See
`migrations/`.

## Production notes

- Set all `CHANGE_ME` secrets; `NODE_ENV=production` enforces their presence.
- `DATABASE_SSL=require`, run behind an EU reverse proxy (TLS), keep DB in EU.
- Run `npm run build` then `npm start`; schedule `npm run expire` via cron.
