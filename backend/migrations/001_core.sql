-- ===========================================================================
-- 001_core.sql — extensions, practitioner, services, formats, templates,
--                blackouts, settings.
-- All timestamps are timestamptz and stored as UTC. Local presentation
-- (Europe/Dublin, with DST) happens in the application layer.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- gist over scalar cols for EXCLUDE
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()

-- Exactly one practitioner => exactly one calendar.
CREATE TABLE practitioners (
  id         integer PRIMARY KEY,
  name       text NOT NULL,
  coru_reg   text,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO practitioners (id, name, coru_reg)
VALUES (1, 'Virthy Jain', 'CORU registered physiotherapist')
ON CONFLICT (id) DO NOTHING;

-- Services are editable in the admin panel, never hardcoded.
CREATE TABLE services (
  id               serial PRIMARY KEY,
  name             text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  price_cents      integer NOT NULL CHECK (price_cents >= 0),
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Formats (ways to meet). Home visits carry a travel buffer on each side.
CREATE TABLE formats (
  key                   text PRIMARY KEY,           -- 'clinic' | 'home' | 'telehealth'
  name                  text NOT NULL,              -- display name used by the front end
  active                boolean NOT NULL DEFAULT true,
  travel_buffer_minutes integer NOT NULL DEFAULT 0 CHECK (travel_buffer_minutes >= 0),
  sort_order            integer NOT NULL DEFAULT 0
);

-- Weekly recurring template per format. weekday: 0=Sunday .. 6=Saturday.
-- start_min / end_min are minutes from local midnight (Europe/Dublin).
CREATE TABLE availability_templates (
  id         serial PRIMARY KEY,
  format_key text NOT NULL REFERENCES formats(key) ON DELETE CASCADE,
  weekday    integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min  integer NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
  end_min    integer NOT NULL CHECK (end_min BETWEEN 0 AND 1440),
  CHECK (end_min > start_min)
);
CREATE INDEX idx_templates_format_weekday
  ON availability_templates (format_key, weekday);

-- Blackout ranges: holidays, courses, ad-hoc closures. Stored in UTC.
CREATE TABLE blackouts (
  id         serial PRIMARY KEY,
  start_at   timestamptz NOT NULL,
  end_at     timestamptz NOT NULL,
  reason     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX idx_blackouts_range ON blackouts USING gist (tstzrange(start_at, end_at));

-- Key/value settings (buffer, min notice, expiry window, cancel cutoff, ...).
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
