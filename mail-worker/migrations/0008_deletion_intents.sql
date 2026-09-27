ALTER TABLE mail_deletion_jobs ADD COLUMN user_id INTEGER;
ALTER TABLE mail_deletion_jobs ADD COLUMN account_id INTEGER;
ALTER TABLE mail_deletion_jobs ADD COLUMN raw_key TEXT;
ALTER TABLE mail_deletion_jobs ADD COLUMN storage_version TEXT;
ALTER TABLE mail_deletion_jobs ADD COLUMN wait_until INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX mail_deletion_email ON mail_deletion_jobs(email_id) WHERE email_id IS NOT NULL;
