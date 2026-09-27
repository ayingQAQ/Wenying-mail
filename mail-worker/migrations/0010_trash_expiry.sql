CREATE INDEX email_trash_expiry ON email(trashed_at,email_id) WHERE folder='TRASH' AND delete_state='ACTIVE' AND is_del=0;
CREATE INDEX mail_deletion_owner_time ON mail_deletion_jobs(user_id,requested_at DESC);
