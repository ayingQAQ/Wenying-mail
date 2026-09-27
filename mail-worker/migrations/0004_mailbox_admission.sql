-- Explicit admission only: existing mailboxes remain disabled until reviewed.
CREATE TABLE domains (
  domain_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
ALTER TABLE account ADD COLUMN domain_id INTEGER;
ALTER TABLE account ADD COLUMN receive_enabled INTEGER NOT NULL DEFAULT 0 CHECK(receive_enabled IN (0,1));
ALTER TABLE account ADD COLUMN disabled_at INTEGER;
CREATE INDEX account_domain_id ON account(domain_id);
