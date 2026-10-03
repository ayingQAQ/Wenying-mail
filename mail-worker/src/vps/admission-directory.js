const fail=()=>new Error('ADMISSION_SYNC_UNAVAILABLE');
const guard=db=>db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM edge_admission_control WHERE singleton=1 AND revision=?) THEN 1 ELSE json('ADMISSION_FENCE_LOST') END");
function snapshot(rows){
 if(!Array.isArray(rows)||rows.length>10000)throw fail();
 const seen=new Set();
 for(const row of rows){
  if(typeof row.email!=='string'||row.email.length>254||row.email!==row.email.toLowerCase()||! /^[^@\s]+@[^@\s]+$/.test(row.email)||! /^[\x21-\x7e]+$/.test(row.email)||seen.has(row.email)||
   !Number.isSafeInteger(row.accountId)||row.accountId<1||!Number.isSafeInteger(row.userId)||row.userId<1)throw fail();
  seen.add(row.email);
 }
 return JSON.stringify(rows);
}
// Rare mailbox/owner/domain mutations use D1; page reads never use this channel.
// Allocation fences delayed HTTP responses across retries and process restarts.
export function admissionDirectory(db){
 return {
  async prepare(rows){
   const payload=snapshot(rows);
   const value=await db.prepare('UPDATE edge_admission_control SET revision=revision+1 WHERE singleton=1 RETURNING revision').first();
   const revision=value?.revision;if(!Number.isSafeInteger(revision)||revision<1)throw fail();
   await db.batch([
    guard(db).bind(revision),
    db.prepare(`UPDATE edge_mailboxes SET enabled=0,revision=? WHERE NOT EXISTS(
      SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.email')=edge_mailboxes.email
       AND json_extract(j.value,'$.accountId')=edge_mailboxes.account_id AND json_extract(j.value,'$.userId')=edge_mailboxes.user_id)`)
     .bind(revision,payload),
   ]);
   return {revision,payload};
  },
  async publish({revision,payload}){
   if(!Number.isSafeInteger(revision)||revision<1||typeof payload!=='string')throw fail();
   snapshot(JSON.parse(payload));
   await db.batch([
    guard(db).bind(revision),
    db.prepare(`INSERT INTO edge_mailboxes(email,account_id,user_id,enabled,revision)
      SELECT json_extract(value,'$.email'),json_extract(value,'$.accountId'),json_extract(value,'$.userId'),1,?
      FROM json_each(?) WHERE true ON CONFLICT(email) DO UPDATE SET account_id=excluded.account_id,
      user_id=excluded.user_id,enabled=1,revision=excluded.revision WHERE edge_mailboxes.revision<=excluded.revision`)
      .bind(revision,payload),
    db.prepare('UPDATE edge_admission_control SET ready=1 WHERE singleton=1 AND revision=?').bind(revision),
   ]);
  },
 };
}
