<script setup>
import {computed, ref, watch, onMounted, onUnmounted} from 'vue';
import {Icon} from '@iconify/vue';
import {ElMessageBox,ElMessage} from 'element-plus';
import {hasPerm} from '@/perm/perm.js';
import {emailList, emailLatest, emailRead, emailDelete} from '@/request/email.js';
import {starList, starAdd, starCancel} from '@/request/star.js';
import {useAccountStore} from '@/store/account.js';
import {useEmailStore} from '@/store/email.js';
import {subscribeMailEvents} from '@/utils/mail-events.js';
import {verificationCode} from '@/utils/mail-ui.js';
import {runMailBatch} from '@/utils/mail-batch.js';
import {fromNow} from '@/utils/day.js';
import VerificationCode from './verification-code.vue';
import MailContent from '@/views/content/index.vue';
const props=defineProps({starred:Boolean});
const accounts=useAccountStore(), store=useEmailStore();
const rows=ref([]), selected=ref(null), loading=ref(false), failed=ref(false), more=ref(false), total=ref(null), search=ref(''), filter=ref('all');
const acting=ref(new Set()),checked=ref([]),bulkBusy=ref(false);
const selectionMode=ref(false);
function spotlight(event){
 if(event.pointerType==='touch')return;
 const element=event.currentTarget,rect=element.getBoundingClientRect();
 element.style.setProperty('--pointer-x',`${event.clientX-rect.left}px`);
 element.style.setProperty('--pointer-y',`${event.clientY-rect.top}px`);
}
function toggleSelection(){if(bulkBusy.value)return;selectionMode.value=!selectionMode.value;checked.value=[];}
const allChecked=computed(()=>visible.value.length>0&&visible.value.every(row=>checked.value.includes(row.emailId)));
function toggleAll(value){checked.value=value?visible.value.map(row=>row.emailId):[];}
async function bulkAction(action){
 if(bulkBusy.value||!checked.value.length)return;
 const ids=[...checked.value],startedScope=scope.value;bulkBusy.value=true;epoch++;loading.value=false;
 try{
  if(action==='delete')await ElMessageBox.confirm(`将选中的 ${ids.length} 封邮件移到回收站？`,'批量删除',{confirmButtonText:'移入回收站',cancelButtonText:'取消',type:'warning'});
  const result=await runMailBatch(ids,chunk=>action==='delete'?emailDelete(chunk):emailRead(chunk),{size:50,isStopped:()=>closed,onSuccess:chunk=>{
   if(closed||scope.value!==startedScope)return;
   checked.value=checked.value.filter(id=>!chunk.includes(id));
   if(action==='delete'){remove(chunk);chunk.forEach(id=>delete store.detailMap[id]);}
   else chunk.forEach(id=>{store.markListRead(id);if(store.contentData.email?.emailId===id)store.contentData.email.unread=1;});
  }});
  if(!closed){if(result.failed)ElMessage.warning(`已完成 ${result.done.length} 封，其余 ${result.remaining.length} 封保留选中，可重试`);else ElMessage.success(`已处理 ${result.done.length} 封邮件`);}
 }catch(error){if(error!=='cancel'&&error!=='close')ElMessage.error('批量操作未完成');}finally{bulkBusy.value=false;if(!closed&&scope.value!==startedScope)load(true);else flushEvent();}
}
async function quickAction(mail,action){
 if(bulkBusy.value||acting.value.has(mail.emailId))return;acting.value.add(mail.emailId);
 try{
  if(action==='delete'){await ElMessageBox.confirm('将这封邮件移到回收站？','移到回收站',{confirmButtonText:'移入',cancelButtonText:'取消',type:'warning'});await emailDelete([mail.emailId]);store.deleteIds=[mail.emailId];delete store.detailMap[mail.emailId];}
  if(action==='read'){await emailRead([mail.emailId]);mail.unread=1;store.markListRead(mail.emailId);if(store.contentData.email?.emailId===mail.emailId)store.contentData.email.unread=1;}
  if(action==='star'){const starred=!mail.isStar;await (starred?starAdd:starCancel)(mail.emailId);mail.isStar=Number(starred);if(store.contentData.email?.emailId===mail.emailId)store.contentData.email.isStar=mail.isStar;if(props.starred&&!starred)remove([mail.emailId]);}
 }catch(error){if(error!=='cancel'&&error!=='close')ElMessage.error('操作未完成，请重试')}finally{acting.value.delete(mail.emailId)}
}
let epoch=0,closed=false,unsubscribe,polling=false,eventPending=false,retryTimer,retryDelay=3000;
function onMailEvent(){eventPending=true;flushEvent();}
function flushEvent(){if(eventPending&&!closed&&!loading.value&&!bulkBusy.value&&!polling){eventPending=false;poll();}}
const scope=computed(()=>`${accounts.currentAccountId}:${accounts.allMailboxes}`);
const visible=computed(()=>rows.value.filter(m=>(!props.starred||accounts.allMailboxes||m.toEmail===accounts.currentAccount.email)&&(filter.value!=='unread'||m.unread===0)&&(!search.value||[m.name,m.sendEmail,m.subject,m.listText].join(' ').toLowerCase().includes(search.value.trim().toLowerCase()))));
function decorate(list){return list.map(m=>({...m,code:verificationCode(m)}))}
async function load(reset=true,preserveReader=false){
  if(bulkBusy.value||(!reset&&loading.value))return;
  const request=++epoch; loading.value=true;failed.value=false;
  if(reset){checked.value=[];rows.value=[];if(!preserveReader)selected.value=null;total.value=null;more.value=false;}
  try{
    if(!accounts.currentAccountId)return;
    const cursor=reset?0:rows.value.at(-1)?.emailId;
    const page=props.starred?await starList(cursor,30,0):await emailList(accounts.currentAccountId,accounts.allMailboxes?1:0,cursor,0,30,0,0);
    if(request!==epoch||closed)return;
    const list=decorate(page.list||[]);rows.value=reset?list:[...rows.value,...list];more.value=list.length===30;
    if(page.total!==undefined)total.value=page.total;
  }catch{if(request===epoch&&!closed)failed.value=true}finally{if(request===epoch&&!closed){loading.value=false;flushEvent();}}
}
function select(mail){selected.value=mail.emailId;store.contentData={email:store.toContentEmail(mail),delType:'logic',showStar:true,showReply:false,showUnread:true};}
function close(){selected.value=null;}
function remove(ids){const removed=rows.value.filter(m=>ids.includes(m.emailId)).length;checked.value=checked.value.filter(id=>!ids.includes(id));rows.value=rows.value.filter(m=>!ids.includes(m.emailId));if(total.value!==null)total.value=Math.max(0,total.value-removed);if(ids.includes(selected.value))close();}
const bridge={refreshList:()=>load(true),deleteEmail:remove,get emailList(){return rows.value}};
watch(scope,()=>{epoch++;selectionMode.value=false;checked.value=[];rows.value=[];selected.value=null;search.value='';load(true)});
watch([search,filter],()=>{checked.value=[];});
watch(()=>store.deleteIds,ids=>{if(Array.isArray(ids))remove(ids)});
watch(()=>store.cancelStarEmailId,id=>{const row=rows.value.find(m=>m.emailId===id);if(row)row.isStar=0;if(props.starred&&id)remove([id])});
watch(()=>store.addStarEmailId,id=>{const row=rows.value.find(m=>m.emailId===id);if(row)row.isStar=1});
async function poll(){
  if(closed||polling||loading.value||bulkBusy.value||props.starred||document.hidden||!accounts.currentAccountId)return;
  const captured=epoch;polling=true;
  try{
    const list=await emailLatest(rows.value[0]?.emailId||0,accounts.currentAccountId,accounts.allMailboxes?1:0);
    if(closed||captured!==epoch)return;
    if((list||[]).length>=20){await load(true,true);return;}
    const additions=decorate(list||[]).filter(m=>!rows.value.some(x=>x.emailId===m.emailId));
    rows.value=[...additions,...rows.value].sort((a,b)=>b.emailId-a.emailId);
    if(total.value!==null)total.value+=additions.length;
  retryDelay=3000;clearTimeout(retryTimer);
  }catch{if(!closed){clearTimeout(retryTimer);retryTimer=setTimeout(onMailEvent,retryDelay);retryDelay=Math.min(60000,retryDelay*2);}}finally{polling=false;flushEvent();}
}
onMounted(()=>{if(props.starred)store.starScroll=bridge;else store.emailScroll=bridge;load();if(!props.starred)unsubscribe=subscribeMailEvents(onMailEvent)});
onUnmounted(()=>{closed=true;epoch++;unsubscribe?.();clearTimeout(retryTimer);if(props.starred)store.starScroll=null;else store.emailScroll=null});
</script>
<template>
 <section class="mail-workspace" :class="{reading:selected,selecting:selectionMode}">
  <div class="mail-list-column">
   <div class="inbox-search-row"><div class="mail-search"><Icon icon="mail-ui:search"/><input v-model="search" :disabled="bulkBusy" aria-label="搜索已加载邮件" placeholder="搜索发件人、主题、摘要…"/></div><button class="inbox-filter" :disabled="bulkBusy" :aria-pressed="filter==='unread'" @click="filter=filter==='unread'?'all':'unread'"><Icon icon="mail-ui:sliders-horizontal"/>筛选</button></div>
   <header class="inbox-subnav"><div class="inbox-list-title"><input v-if="selectionMode" class="mail-select" type="checkbox" aria-label="全选当前列表" :checked="allChecked" :indeterminate="checked.length>0&&!allChecked" :disabled="bulkBusy||!visible.length" @change="toggleAll($event.target.checked)"/><h2>{{starred?'星标邮件':'收件箱'}}</h2><button class="mail-icon-button" aria-label="刷新邮件" :disabled="loading||bulkBusy" @click="load()"><Icon icon="mail-ui:refresh-cw"/></button><span v-if="total!==null" class="inbox-count">{{total}}</span></div><div class="mail-filters"><button :disabled="bulkBusy" :aria-pressed="selectionMode" @click="toggleSelection">{{selectionMode?'完成':'多选'}}</button><button :disabled="bulkBusy" :class="{active:filter==='all'}" @click="filter='all'">全部</button><button :disabled="bulkBusy" :class="{active:filter==='unread'}" @click="filter='unread'">未读</button></div></header>
   <div v-if="checked.length" class="mail-bulk-toolbar" role="status"><span>已选 {{checked.length}} 封</span><button :disabled="bulkBusy" @click="bulkAction('read')">标为已读</button><button v-if="hasPerm('email:delete')" :disabled="bulkBusy" @click="bulkAction('delete')">移到回收站</button><button :disabled="bulkBusy" @click="checked=[]">取消选择</button></div>
   <div class="mail-list-scroll">
    <article v-for="mail in visible" :key="mail.emailId" class="mail-item" @pointermove="spotlight" :class="{selected:selected===mail.emailId,unread:mail.unread===0}">
     <input v-if="selectionMode" class="mail-select mail-row-select" type="checkbox" v-model="checked" :value="mail.emailId" :disabled="bulkBusy" :aria-label="`选择邮件：${mail.subject||'无主题'}`" @click.stop/>
     <button class="mail-open" :aria-label="`${mail.name||mail.sendEmail}：${mail.subject||'无主题'}`" :aria-pressed="selected===mail.emailId" @click="select(mail)">
      <div class="mail-item-top"><strong>{{mail.name||mail.sendEmail}}</strong><time>{{fromNow(mail.createTime)}}</time></div>
      <h3>{{mail.subject||'（无主题）'}}</h3>
     </button>
     <div class="mail-item-preview"><VerificationCode v-if="mail.code" :code="mail.code" compact/><button class="mail-preview-open" :aria-label="`阅读摘要：${mail.subject||'无主题'}`" @click="select(mail)">{{mail.listText||' '}}</button></div>
     <div class="mail-row-actions" aria-label="邮件快捷操作">
      <button v-if="hasPerm('email:delete')" class="mail-icon-button" title="移到回收站" aria-label="移到回收站" :disabled="bulkBusy||acting.has(mail.emailId)" @click.stop="quickAction(mail,'delete')"><Icon icon="mail-ui:trash-2"/></button>
      <button v-if="mail.unread===0" class="mail-icon-button" title="标为已读" aria-label="标为已读" :disabled="bulkBusy||acting.has(mail.emailId)" @click.stop="quickAction(mail,'read')"><Icon icon="mail-ui:mail-open"/></button>
      <button class="mail-icon-button" :title="mail.isStar?'取消星标':'添加星标'" :aria-label="mail.isStar?'取消星标':'添加星标'" :class="{starred:mail.isStar}" :disabled="bulkBusy||acting.has(mail.emailId)" @click.stop="quickAction(mail,'star')"><Icon icon="mail-ui:star"/></button>
     </div>
    </article>
    <div v-if="loading" role="status" aria-label="正在加载邮件"><template v-if="!rows.length"><div v-for="n in 4" :key="n" class="mail-skeleton-row" aria-hidden="true"><span/><span/><span/></div></template><p v-else class="mail-list-state">正在加载邮件…</p></div>
    <div v-else-if="failed" class="mail-list-state" role="alert">邮件加载失败 <button @click="load(!rows.length)">重试</button></div>
    <div v-else-if="!visible.length" class="mail-list-state"><Icon icon="mail-ui:inbox"/><p>{{accounts.currentAccountId?'没有符合条件的邮件':'在邮箱与域名中创建第一个地址'}}</p></div>
    <button v-if="more&&!loading" class="mail-load-more" @click="load(false)">加载更多邮件</button>
    <p v-else-if="rows.length&&!loading" class="mail-list-end">所有邮件已加载</p>
   </div>
   <footer v-if="search||filter==='unread'" class="mail-list-foot">筛选已加载的 {{rows.length}} 封邮件</footer>
  </div>
  <div class="mail-reading-pane"><MailContent v-if="selected" embedded @close="close"/><div v-else class="mail-reader-empty"><Icon icon="mail-ui:mail-open"/><h3>选择一封邮件阅读</h3><p>你的下一封重要来信，就在这里。</p></div></div>
 </section>
</template>
<style scoped>
.mail-workspace{display:grid;grid-template-columns:350px minmax(0,1fr);height:100%;min-height:0}.mail-list-column{min-width:0;border-right:1px solid var(--el-border-color);min-height:0;display:flex;flex-direction:column}.mail-list-heading{display:flex;justify-content:space-between;align-items:center;padding:24px 20px 16px;gap:8px}.mail-list-heading h2{font-size:20px;font-weight:600}.mail-list-heading p{font-size:11px;color:var(--el-text-color-secondary);margin-top:6px;overflow-wrap:anywhere}.mail-search{margin:0 20px 13px;border:1px solid var(--el-border-color);border-radius:7px;padding:8px 10px;display:flex;align-items:center;gap:8px}.mail-search svg{width:16px;color:var(--el-text-color-secondary)}.mail-search input{width:100%;min-width:0;font-size:12px;color:var(--el-text-color-primary)}.mail-filters{display:flex;gap:3px;background:var(--mail-soft);border-radius:7px;margin:0 20px 15px;padding:3px}.mail-filters button{flex:1;padding:6px;border-radius:5px;color:var(--el-text-color-secondary);font-size:12px;cursor:pointer}.mail-filters .active{background:var(--el-bg-color);color:var(--el-text-color-primary);box-shadow:0 1px 4px #0001}.mail-list-scroll{flex:1;overflow:auto;min-height:0}.mail-item{border-top:1px solid var(--el-border-color-lighter);border-left:3px solid transparent;padding:16px 18px}.mail-item:hover,.mail-item.selected{background:var(--mail-soft)}.mail-item.selected{border-left-color:transparent}.mail-open{display:block;width:100%;text-align:left;color:var(--el-text-color-primary);cursor:pointer}.mail-item-top{display:flex;gap:7px;align-items:center}.mail-item-top strong{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.unread .mail-item-top strong,.unread h3{font-weight:650}.mail-item time{font-size:10px;color:var(--el-text-color-secondary);margin-left:auto;white-space:nowrap}.mail-item h3{font-size:13px;font-weight:500;margin:9px 0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mail-item p{font-size:11px;color:var(--el-text-color-secondary);line-height:1.8;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.mail-unread-dot{width:5px;height:5px;border-radius:50%;background:var(--el-text-color-primary);flex-shrink:0}.mail-item-meta{display:flex;align-items:center;gap:8px;margin-top:9px}.mail-star{margin-left:auto;width:15px;height:15px;color:#bc8026}.mail-reading-pane{min-width:0;min-height:0}.mail-reader-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;color:var(--el-text-color-secondary)}.mail-reader-empty svg{width:35px;height:35px}.mail-reader-empty h3{font-size:15px;font-weight:500}.mail-reader-empty p{font-size:12px}.mail-list-state{text-align:center;padding:32px 16px;color:var(--el-text-color-secondary);font-size:12px}.mail-list-state svg{width:26px;height:26px;margin-bottom:10px}.mail-list-state button{color:var(--el-text-color-primary);text-decoration:underline;cursor:pointer}.mail-load-more{display:block;padding:18px;width:100%;color:var(--el-text-color-primary);cursor:pointer;font-size:12px}.mail-list-end,.mail-list-foot{text-align:center;padding:12px;color:var(--el-text-color-secondary);font-size:10px}.mail-list-foot{border-top:1px solid var(--el-border-color)}@media(min-width:1600px){.mail-workspace{grid-template-columns:400px minmax(0,1fr)}}@media(max-width:1150px){.mail-workspace{grid-template-columns:300px minmax(0,1fr)}}@media(max-width:700px){.mail-workspace{grid-template-columns:minmax(0,1fr)}.mail-reading-pane{display:none}.mail-workspace.reading .mail-list-column{display:none}.mail-workspace.reading .mail-reading-pane{display:block}.mail-list-column{border:0}}

.mail-item{position:relative;padding:23px 20px 22px;transition:background-color 110ms ease}
.mail-item:hover{background:var(--mail-soft)}.mail-item.selected{background:var(--mail-selected)}
.mail-item-top{min-height:22px}.mail-item-top strong{font-size:15px;font-weight:650;max-width:calc(100% - 98px)}
.mail-item time{font-size:12px}.mail-item h3{font-size:14px;margin:9px 0 7px;font-weight:400!important}
.mail-item-preview{display:flex;align-items:center;gap:9px;min-height:24px;min-width:0}
.mail-item-preview :deep(.verification-chip){flex-shrink:0;background:transparent;padding:2px 7px}
.mail-preview-open{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:left;color:var(--el-text-color-secondary);font-size:12px;cursor:pointer}
.mail-row-actions{position:absolute;right:16px;top:19px;display:flex;gap:3px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity 100ms ease;background:var(--mail-soft)}
.mail-item.selected .mail-row-actions{background:var(--mail-selected)}
.mail-item:hover .mail-row-actions,.mail-item:focus-within .mail-row-actions{opacity:1;visibility:visible;pointer-events:auto}
.mail-item:hover time,.mail-item:focus-within time{visibility:hidden}
.mail-row-actions .mail-icon-button{width:28px;height:28px}.mail-row-actions .starred{color:#bc8026}
@media(hover:none){.mail-row-actions{position:static;opacity:1;visibility:visible;pointer-events:auto;justify-content:flex-end;background:none!important;margin-top:6px}.mail-item:hover time,.mail-item:focus-within time{visibility:visible}.mail-item{padding:18px 20px}}
</style>
