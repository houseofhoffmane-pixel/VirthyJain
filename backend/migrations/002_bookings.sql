-- ===========================================================================
-- 002_bookings.sql — the bookings table and the airtight double-booking guard.
--
-- `occupied` is the span the appointment actually blocks on the calendar:
--   [ start_at - buffer - travel , end_at + buffer + travel )
-- It is computed by the application at insert time from the *current* settings
-- and the format's travel buffer, then stored, so the exclusion constraint can
-- enforce non-overlap purely at the database level.
--
-- The partial EXCLUDE constraint below is the core guarantee: no two bookings
-- that hold a slot (pending or confirmed) may have overlapping `occupied`
-- ranges for the practitioner. This blocks identical start times AND overlaps
-- of different durations, regardless of application-level races.
-- ===========================================================================

CREATE TYPE booking_status AS ENUM
  ('pending', 'confirmed', 'cancelled', 'completed', 'no_show');

CREATE TABLE bookings (
  id              bigserial PRIMARY KEY,
  practitioner_id integer NOT NULL REFERENCES practitioners(id),
  service_id      integer NOT NULL REFERENCES services(id),
  format_key      text NOT NULL REFERENCES formats(key),

  start_at        timestamptz NOT NULL,
  end_at          timestamptz NOT NULL,
  occupied        tstzrange NOT NULL,

  status          booking_status NOT NULL DEFAULT 'pending',

  -- Patient details. `notes` holds HEALTH DATA and is encrypted at rest
  -- (AES-256-GCM) by the application; the column stores ciphertext only.
  patient_name    text NOT NULL,
  patient_email   text NOT NULL,
  patient_phone   text,
  referrer        text,
  notes_encrypted text,

  -- Single-purpose signed token lives in the URL, not the DB; we store a hash
  -- so a leaked DB cannot mint working links, and bump `token_version` to
  -- invalidate outstanding links after a reschedule.
  token_version   integer NOT NULL DEFAULT 1,

  -- Price/duration are snapshotted from the service at creation for the record,
  -- but are always re-derived from the service row on write, never trusted
  -- from the client.
  price_cents     integer NOT NULL,
  duration_minutes integer NOT NULL,

  source          text NOT NULL DEFAULT 'public',   -- 'public' | 'admin'
  decline_reason  text,
  pending_expires_at timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CHECK (end_at > start_at)
);

-- THE guard. btree_gist lets us mix `=` on practitioner_id with `&&` on range.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    practitioner_id WITH =,
    occupied WITH &&
  )
  WHERE (status IN ('pending', 'confirmed'));

CREATE INDEX idx_bookings_start ON bookings (start_at);
CREATE INDEX idx_bookings_status ON bookings (status);
CREATE INDEX idx_bookings_email ON bookings (lower(patient_email));
CREATE INDEX idx_bookings_pending_expiry
  ON bookings (pending_expires_at) WHERE status = 'pending';

-- Audit log of admin actions (who did what, to which booking).
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL,        -- admin email, or 'system'
  action     text NOT NULL,        -- 'confirm' | 'decline' | 'cancel' | ...
  entity     text NOT NULL,        -- 'booking' | 'service' | 'setting' | ...
  entity_id  text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

-- Access log for health data. Every read/decrypt of a patient's notes is
-- recorded (GDPR accountability for special-category data).
CREATE TABLE notes_access_log (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL,
  booking_id bigint,
  patient_email text,
  purpose    text NOT NULL,        -- 'admin_view' | 'gdpr_export' | 'email' | ...
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notes_access_email ON notes_access_log (lower(patient_email));
