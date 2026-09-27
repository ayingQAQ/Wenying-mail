import {sql} from 'drizzle-orm';
import email from '../entity/email.js';

export const mailVisibility=sql`${email.deleteState}='ACTIVE'
  AND EXISTS(SELECT 1 FROM account ma JOIN user mu ON mu.user_id=ma.user_id
    WHERE ma.account_id=${email.accountId} AND ma.user_id=${email.userId}
      AND ma.is_del=0 AND ma.retired_at IS NULL AND mu.is_del=0 AND mu.retired_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM mail_deletion_jobs md WHERE md.email_id=${email.emailId} OR md.delivery_id=${email.deliveryId})
  AND NOT EXISTS(SELECT 1 FROM mail_tombstones mt WHERE mt.delivery_id=${email.deliveryId})`;
