// Deployment-owned bot credentials never enter settings responses or URLs shown to users.
export function telegramConfig(source) {
  const token=source.TELEGRAM_BOT_TOKEN||'',chatId=source.TELEGRAM_CHAT_ID||'';
  if(!token&&!chatId)return null;
  const owner=(source.MAIL_ADMIN_EMAIL||'').trim().toLowerCase();
  if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)||! /^-?\d{1,20}$/.test(chatId)||!owner.includes('@'))
    throw new Error('INVALID_TELEGRAM_CONFIGURATION');
  return {token,chatId,owner};
}

const clean=(value,limit)=>Array.from(String(value??'').replace(/[\x00-\x1f\x7f]/g,' ')).slice(0,limit).join('');
export function telegramPayload(row,origin,chatId){
  const site=new URL(origin);
  if(site.protocol!=='https:')throw new Error('INVALID_APP_ORIGIN');
  const code=clean(row.code,64);
  const keyboard=[[{text:'打开收件箱',url:new URL('/inbox',site).href}]];
  if(code)keyboard.unshift([{text:`复制验证码 ${code}`,copy_text:{text:code}}]);
  return {chat_id:chatId,text:[
    'Wengying mail · 新邮件',
    `发件人：${clean(row.name,100)} ${clean(row.send_email,254)}`.trim(),
    `收件邮箱：${clean(row.envelope_to,254)}`,
    `主题：${clean(row.subject||'（无主题）',300)}`,
    ...(code?[`验证码：${code}`]:[]),
  ].join('\n'),link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:keyboard}};
}

export async function sendTelegram(config,payload,request=fetch){
  // Do not log provider responses or fetch errors: they may contain the bot URL/token.
  let response;
  try{response=await request(`https://api.telegram.org/bot${config.token}/sendMessage`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000),
  });const result=await response.json();return result.ok===true&&response.ok?'SENT':`REJECTED_${response.status}`;}
  catch{return 'UNAVAILABLE';}
}

export async function notifyTelegram(env,deliveryId,request=fetch){
  if(!env.TELEGRAM_NOTIFICATION)return;
  try{
    const config=env.TELEGRAM_NOTIFICATION;
    const row=await env.db.prepare(`SELECT e.account_id,e.name,e.send_email,e.envelope_to,e.subject,e.code
      FROM email e JOIN user u ON u.user_id=e.user_id
      WHERE e.delivery_id=? AND lower(u.email)=? AND u.is_del=0 AND u.status=0
        AND u.retired_at IS NULL AND e.processing_status='PROCESSED'
        AND e.delete_state='ACTIVE' AND e.is_del=0 AND e.folder='INBOX'`)
      .bind(deliveryId,config.owner).first();
    if(!row)return;
    if(env.TELEGRAM_MAILBOX_ALLOWED&&!env.TELEGRAM_MAILBOX_ALLOWED(row.account_id))return;
    const code=await sendTelegram(config,telegramPayload(row,env.APP_ORIGIN,config.chatId),request);
    await env.db.prepare("INSERT INTO operations_events(delivery_id,stage,code) VALUES(?,'TELEGRAM',?)").bind(deliveryId,code).run();
  }catch{console.error('{"stage":"telegram","code":"NOTIFICATION_FAILED"}');}
}
