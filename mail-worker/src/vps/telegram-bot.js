import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

export async function createTelegramBot({env,path,request=fetch}){
  const config=env.TELEGRAM_NOTIFICATION;
  if(!config)return null;
  const scope=`${config.token.split(':')[0]}:${config.chatId}:${config.owner}`;
  let state={scope,offset:0,excluded:[]};
  try{
    const saved=JSON.parse(await readFile(path,'utf8'));
    if(saved.scope!==scope)throw new Error('TELEGRAM_STATE_SCOPE_CHANGED');
    if(!Number.isSafeInteger(saved.offset)||saved.offset<0||!Array.isArray(saved.excluded)||saved.excluded.length>10000||saved.excluded.some(id=>!Number.isSafeInteger(id)||id<1))throw new Error('TELEGRAM_STATE_INVALID');
    state=saved;
  }catch(error){if(error.code!=='ENOENT')throw new Error('TELEGRAM_STATE_INVALID');}
  async function save(next){
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path+'.tmp',JSON.stringify(next),{mode:0o600});
    await rename(path+'.tmp',path);state=next;
  }
  async function api(method,body,signal){
    try{
      const response=await request(`https://api.telegram.org/bot${config.token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(method==='getUpdates'?35000:10000)]):AbortSignal.timeout(10000)});
      const data=await response.json();
      if(!response.ok||data.ok!==true){
        if(method==='editMessageText'&&data.description?.includes('message is not modified'))return;
        throw new Error('TELEGRAM_API_FAILED');
      }
      return data.result;
    }catch{throw new Error('TELEGRAM_API_FAILED');}
  }
  const owned=`FROM account a JOIN user u ON u.user_id=a.user_id WHERE lower(u.email)=? AND u.is_del=0 AND u.status=0 AND u.retired_at IS NULL AND a.is_del=0 AND a.retired_at IS NULL AND a.domain_id IS NOT NULL`;
  const allowed=id=>!state.excluded.includes(id);
  async function panel(page=0,messageId,signal){
    const {results}=await env.db.prepare(`SELECT a.account_id,a.email ${owned} ORDER BY a.account_id LIMIT 11 OFFSET ?`).bind(config.owner,page*10).all();
    if(!results.length&&page>0)return panel(0,messageId,signal);
    const buttons=results.slice(0,10).map(row=>[{text:`${allowed(row.account_id)?'✅':'⬜'} ${row.email}`,callback_data:`mb:${allowed(row.account_id)?'off':'on'}:${row.account_id}:${page}`}]);
    const nav=[];
    if(page)nav.push({text:'上一页',callback_data:`mb:page:${page-1}`});
    if(results.length>10)nav.push({text:'下一页',callback_data:`mb:page:${page+1}`});
    if(nav.length)buttons.push(nav);
    const payload={chat_id:config.chatId,text:results.length?'选择要推送的邮箱\n✅ 已开启 · ⬜ 已关闭\n点击立即保存；仅影响 Telegram 通知，邮箱正常收信。\n新建邮箱默认开启推送。':'暂无可配置的邮箱。',reply_markup:{inline_keyboard:buttons}};
    return api(messageId?'editMessageText':'sendMessage',{...payload,...(messageId?{message_id:messageId}:{})},signal);
  }
  function authorized(from,chat){return !from?.is_bot&&String(from?.id)===config.chatId&&String(chat?.id)===config.chatId&&chat?.type==='private';}
  async function handle(update,signal){
    const callback=update.callback_query;
    if(callback){
      if(!authorized(callback.from,callback.message?.chat))return;
      const data=callback.data||'';
      const change=/^mb:(on|off):([1-9]\d{0,14}):(\d{1,6})$/.exec(data),page=/^mb:page:(\d{1,6})$/.exec(data);
      if(!change&&!page){await api('answerCallbackQuery',{callback_query_id:callback.id,text:'请重新发送 /mailboxes'},signal);return;}
      if(change){
        const id=Number(change[2]);
        const row=await env.db.prepare(`SELECT a.account_id ${owned} AND a.account_id=?`).bind(config.owner,id).first();
        if(!row){await api('answerCallbackQuery',{callback_query_id:callback.id,text:'邮箱已不存在或不可用'},signal);return;}
        const excluded=state.excluded.filter(value=>value!==id);
        if(change[1]==='off')excluded.push(id);
        if(excluded.length>10000)throw new Error('TELEGRAM_SELECTION_LIMIT');
        await save({...state,excluded});
      }
      await api('answerCallbackQuery',{callback_query_id:callback.id,text:change?'已保存':'已翻页'},signal);
      await panel(Number(change?change[3]:page[1]),callback.message.message_id,signal);return;
    }
    const message=update.message;
    if(!authorized(message?.from,message?.chat))return;
    const command=/^\/(mailboxes|test)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(message.text||'')?.[1];
    if(command==='mailboxes')await panel(0,undefined,signal);
    if(command==='test')await api('sendMessage',{chat_id:config.chatId,text:'✅ Wengying mail 测试通知\n机器人连接正常。邮箱推送范围可通过 /mailboxes 调整。'},signal);
  }
  async function run(signal){
    let ready=false;
    while(!signal.aborted){
      try{
        if(!ready){
          const webhook=await api('getWebhookInfo',{},signal);
          if(webhook.url)throw new Error('TELEGRAM_WEBHOOK_EXISTS');
          await api('setMyCommands',{scope:{type:'chat',chat_id:config.chatId},commands:[{command:'mailboxes',description:'选择哪些邮箱推送'},{command:'test',description:'发送测试通知'}]},signal);
          ready=true;console.log('{"stage":"telegram-bot","code":"READY"}');
        }
        const updates=await api('getUpdates',{offset:state.offset,timeout:25,limit:20,allowed_updates:['message','callback_query']},signal);
        if(!Array.isArray(updates))throw new Error('TELEGRAM_UPDATE_INVALID');
        for(const update of updates){
          if(signal.aborted)break;
          if(!Number.isSafeInteger(update.update_id)||update.update_id<state.offset)continue;
          try{await handle(update,signal);}catch{if(signal.aborted)break;console.error('{"stage":"telegram-bot","code":"COMMAND_FAILED"}');}
          await save({...state,offset:update.update_id+1});
        }
      }catch{if(signal.aborted)break;console.error('{"stage":"telegram-bot","code":"RETRY_LATER"}');try{await sleep(5000,undefined,{signal});}catch{break;}}
    }
  }
  return {run,handle,panel,allowed};
}
