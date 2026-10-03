-- A separate edge-only schema. Do not add to the business migration history.
CREATE TABLE IF NOT EXISTS edge_admission_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL DEFAULT 0,
 ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1))
);
INSERT OR IGNORE INTO edge_admission_control(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS edge_mailboxes (
 email TEXT PRIMARY KEY COLLATE NOCASE,
 account_id INTEGER NOT NULL CHECK(account_id>0),
 user_id INTEGER NOT NULL CHECK(user_id>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision>=0)
);
