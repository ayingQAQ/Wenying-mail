CREATE TABLE storage_maintenance (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  kind TEXT NOT NULL CHECK(kind IN ('IDLE','PURGE','BACKUP')),
  owner TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO storage_maintenance(singleton,kind) VALUES (1,'IDLE');
ALTER TABLE account ADD COLUMN retired_at INTEGER;
ALTER TABLE user ADD COLUMN retired_at INTEGER;
CREATE INDEX account_retired ON account(retired_at) WHERE retired_at IS NOT NULL;
