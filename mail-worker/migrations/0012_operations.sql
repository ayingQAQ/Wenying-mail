ALTER TABLE account ADD COLUMN retired_through INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user ADD COLUMN retired_through INTEGER NOT NULL DEFAULT 0;
UPDATE account SET retired_through=coalesce(retired_at,0);
UPDATE user SET retired_through=coalesce(retired_at,0);
CREATE INDEX processing_owner_status ON mail_processing(user_id,state,updated_at);
CREATE TABLE operations_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT,
  stage TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX operations_events_time ON operations_events(created_at,event_id);
CREATE TABLE backup_runs (
  backup_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('RUNNING','COPIED','COMPLETE','FAILED')),
  hold_until INTEGER NOT NULL,
  snapshot_id TEXT,
  snapshot_at INTEGER,
  manifest_hash TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_code TEXT
);
CREATE TABLE bulk_deletion_runs (
  job_id TEXT PRIMARY KEY NOT NULL,
  actor_user_id INTEGER NOT NULL,
  filters TEXT NOT NULL,
  upper_id INTEGER NOT NULL,
  cursor_id INTEGER NOT NULL DEFAULT 0,
  requested_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','COMPLETE','FAILED')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  error_code TEXT
);
