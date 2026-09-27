export async function mailStatistics(db,userId){
  return db.prepare(`SELECT
    coalesce(sum(CASE WHEN e.type=0 THEN 1 ELSE 0 END),0) AS received,
    coalesce(sum(CASE WHEN e.type=1 THEN 1 ELSE 0 END),0) AS sent,
    coalesce(sum(CASE WHEN e.type=0 AND e.folder='INBOX' AND e.unread=0 THEN 1 ELSE 0 END),0) AS unread,
    coalesce(sum(CASE WHEN e.storage_version='r2-v1' THEN coalesce(e.raw_size,0) ELSE 0 END),0) AS rawBytes
    FROM email e WHERE e.user_id=? AND e.is_del=0 AND e.delete_state='ACTIVE'
      AND e.processing_status IN ('PROCESSED','LEGACY')
      AND EXISTS(SELECT 1 FROM account a JOIN user u ON u.user_id=a.user_id
        WHERE a.account_id=e.account_id AND a.user_id=e.user_id AND a.is_del=0 AND a.retired_at IS NULL
          AND u.is_del=0 AND u.retired_at IS NULL AND u.status=0)
      AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs d WHERE d.email_id=e.email_id OR d.delivery_id=e.delivery_id)
      AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.delivery_id=e.delivery_id)`)
    .bind(userId).first();
}
