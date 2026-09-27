CREATE TABLE backup_offsite_runs (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  backup_id TEXT NOT NULL REFERENCES backup_runs(backup_id),
  target_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','COMPLETE','FAILED')),
  catalog_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX backup_offsite_by_backup ON backup_offsite_runs(backup_id,created_at);
