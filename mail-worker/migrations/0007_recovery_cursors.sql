CREATE TABLE recovery_cursors (
  job_name TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL DEFAULT 0,
  partition_at INTEGER NOT NULL DEFAULT 0,
  prefix TEXT NOT NULL DEFAULT 'raw/',
  cursor TEXT,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
