-- Legacy source rows/objects remain intact. These records track verified copies,
-- including pending reservations so interrupted writes always have an owner.
CREATE TABLE legacy_backfill_runs (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  upper_id INTEGER NOT NULL,
  cursor_id INTEGER NOT NULL DEFAULT 0,
  CHECK(cursor_id>=0 AND cursor_id<=upper_id)
);
CREATE TABLE legacy_backfill_jobs (
  email_id INTEGER PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  object_count INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'COPYING' CHECK(state IN ('COPYING','PUBLISHED')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE TABLE legacy_backfill_objects (
  email_id INTEGER NOT NULL,
  part TEXT NOT NULL,
  source_backend TEXT NOT NULL,
  source_key TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','VERIFIED')),
  PRIMARY KEY(email_id,part)
);
