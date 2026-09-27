CREATE TABLE mail_processing (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  raw_key TEXT UNIQUE NOT NULL,
  email_id INTEGER,
  user_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  raw_size INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('RECEIVED','QUEUED','PROCESSING','RETRY_WAIT','PROCESSED','FAILED','QUARANTINED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  parse_failures INTEGER NOT NULL DEFAULT 0,
  retry_cycle INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  processor_version TEXT,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mail_processing_due ON mail_processing(state,next_attempt_at);
CREATE INDEX mail_processing_lease ON mail_processing(lease_until) WHERE state='PROCESSING';
CREATE TABLE mail_tombstones (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  deleted_at INTEGER NOT NULL,
  reason_code TEXT NOT NULL
);
CREATE TABLE mail_deletion_jobs (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  email_id INTEGER,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mail_deletion_due ON mail_deletion_jobs(state,next_attempt_at);
