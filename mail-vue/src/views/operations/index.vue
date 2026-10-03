<script setup>
import {ref,onMounted,onUnmounted,computed,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useSettingStore} from '@/store/setting.js';
import {useUserStore} from '@/store/user.js';
import {useAccountStore} from '@/store/account.js';
import {mailboxAddress} from '@/utils/mail-ui.js';
import {ElMessage,ElMessageBox} from 'element-plus';
import {hasPerm} from '@/perm/perm.js';
import http from '@/axios/index.js';
const admin=ref(false),busy=ref(false),mailboxes=ref([]),jobs=ref([]),domains=ref([]),status=ref(null);
const tab=ref('mailboxes'),state=ref('FAILED'),address=ref(''),domainName=ref(''),reason=ref('STORAGE_RECOVERED');
const route=useRoute(),router=useRouter(),settings=useSettingStore(),accounts=useAccountStore();
const selectedDomain=ref('');
const availableDomains=computed(()=>[...new Set((settings.domainList||[]).map(d=>d.replace(/^@/,'')))]);
const user=useUserStore();
const order=computed(()=>accounts.orderByUser[String(user.user.userId)]||[]);
const rank=id=>{const n=order.value.indexOf(id);return n<0?Number.MAX_SAFE_INTEGER:n;};
const visibleMailboxes=computed(()=>mailboxes.value.filter(row=>!row.deleted).sort((a,b)=>rank(a.accountId)-rank(b.accountId)));
function moveMailbox(row,offset){const ids=visibleMailboxes.value.map(item=>item.accountId),i=ids.indexOf(row.accountId),j=i+offset;if(i<0||j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];accounts.orderByUser[String(user.user.userId)]=[...ids,...order.value.filter(id=>!ids.includes(id))];}
const drag=ref(null),mailboxList=ref();let dragFrame;
function dragStart(event,row){
 if(busy.value||drag.value||event.button!==0)return;
 event.preventDefault();
 const elements=[...mailboxList.value.querySelectorAll('[data-mailbox-id]')];
 const positions=elements.map(el=>{const rect=el.getBoundingClientRect();return {id:Number(el.dataset.mailboxId),top:rect.top,height:rect.height};});
 const index=positions.findIndex(item=>item.id===row.accountId),scroller=mailboxList.value.closest('.operations');
 event.currentTarget.setPointerCapture(event.pointerId);
 drag.value={id:row.accountId,pointer:event.pointerId,startY:event.clientY,y:event.clientY,active:false,positions,index,targetIndex:index,offset:0,scrollStart:scroller.scrollTop};
 dragFrame=requestAnimationFrame(dragTick);
}
function updateDrag(){
 const d=drag.value;if(!d)return;
 const scroller=mailboxList.value.closest('.operations');
 d.offset=d.y-d.startY+scroller.scrollTop-d.scrollStart;
 if(Math.abs(d.y-d.startY)>3)d.active=true;
 if(!d.active)return;
 const original=d.positions[d.index],center=original.top+original.height/2+d.offset;
 d.targetIndex=d.positions.filter(item=>item.id!==d.id&&center>item.top+item.height/2).length;
}
function dragMove(event){if(!drag.value||event.pointerId!==drag.value.pointer)return;drag.value.y=event.clientY;updateDrag();}
function dragTick(){
 const d=drag.value;if(!d)return;
 if(d.active){const scroller=mailboxList.value.closest('.operations'),bounds=scroller.getBoundingClientRect();if(d.y<bounds.top+40)scroller.scrollTop-=8;else if(d.y>bounds.bottom-40)scroller.scrollTop+=8;}
 updateDrag();dragFrame=requestAnimationFrame(dragTick);
}
function rowDragStyle(id){
 const d=drag.value;if(!d?.active)return;
 const index=d.positions.findIndex(item=>item.id===id);let offset=0;
 if(id===d.id)offset=d.offset;
 else if(d.targetIndex>d.index&&index>d.index&&index<=d.targetIndex)offset=-d.positions[d.index].height;
 else if(d.targetIndex<d.index&&index>=d.targetIndex&&index<d.index)offset=d.positions[d.index].height;
 return {transform:`translate3d(0,${offset}px,0)`};
}
function dragEnd(event,cancel=false){
 const d=drag.value;if(!d||event.pointerId!==d.pointer)return;
 // Pointer-up may arrive before the next animation frame; commit its final position.
 if(!cancel&&Number.isFinite(event.clientY)){d.y=event.clientY;updateDrag();}
 if(!cancel&&d.active){const ids=d.positions.map(item=>item.id);ids.splice(d.index,1);ids.splice(d.targetIndex,0,d.id);accounts.orderByUser[String(user.user.userId)]=[...ids,...order.value.filter(id=>!ids.includes(id))];}
 drag.value=null;cancelAnimationFrame(dragFrame);
}
onUnmounted(()=>cancelAnimationFrame(dragFrame));
const fullAddress=computed(()=>mailboxAddress(address.value,selectedDomain.value));
const prefixHint=computed(()=>!address.value?'只需填写前缀，域名自动补全。':fullAddress.value?`将创建：${fullAddress.value}`:'仅填写邮箱前缀，可使用字母、数字及中间的点、下划线或短横线。');
watch(availableDomains,list=>{if(!list.includes(selectedDomain.value))selectedDomain.value=list[0]||''},{immediate:true});
watch(()=>route.query.tab,value=>{tab.value=['admin','jobs','mailboxes'].includes(value)?value:'mailboxes'},{immediate:true});
watch(tab,value=>{if(route.query.tab!==value)router.replace({query:{...route.query,tab:value}})});
async function createMailbox(){if(!fullAddress.value)return;await act(async()=>{const row=await http.post('/account/add',{email:fullAddress.value});address.value='';if(!accounts.currentAccountId){accounts.currentAccount=row;accounts.currentAccountId=row.accountId;}accounts.revision++;});}
const time=value=>value?new Date(value).toLocaleString():'—';
async function loadMailboxes(more=false){const rows=await http.get('/mailOperations/mailboxes',{params:more?{before:mailboxes.value.at(-1)?.accountId}:{}});mailboxes.value=more?[...mailboxes.value,...rows]:rows;}
async function loadJobs(more=false){const rows=await http.get('/mailOperations/jobs',{params:{state:state.value,...(more?{before:jobs.value.at(-1)?.cursor}:{})}});jobs.value=more?[...jobs.value,...rows]:rows;}
async function refresh(){await Promise.all([loadMailboxes(),loadJobs(),...(admin.value?[http.get('/mailOperations/status').then(v=>status.value=v),http.get('/mailOperations/domains').then(v=>domains.value=v)]:[])]);}
async function act(work,refreshAfter=true){if(busy.value)return;busy.value=true;try{await work();if(refreshAfter)await refresh();ElMessage.success('已保存');}catch(error){if(!['cancel','close'].includes(error)&&!error?.response)ElMessage.error('操作未完成，请刷新状态后重试');}finally{busy.value=false;}}
function mailbox(row,action){return act(async()=>{await http.post(`/mailOperations/mailboxes/${row.accountId}`,{action});accounts.revision++;});}
async function confirmAction(message,title,work){
 if(busy.value)return;
 try{await ElMessageBox.confirm(message,title,{type:'warning',confirmButtonText:'确定',cancelButtonText:'取消'});}catch{return;}
 return act(work);
}
function remove(row){return confirmAction('删除地址将停止收信，并异步永久删除其邮件。历史备份按保留期到期。','删除地址',async()=>{await http.delete('/account/delete',{params:{accountId:row.accountId}});mailboxes.value=mailboxes.value.filter(item=>item.accountId!==row.accountId);if(accounts.currentAccountId===row.accountId){accounts.currentAccountId=0;accounts.currentAccount={};}accounts.revision++;});}
function retry(row){return confirmAction('这会重新解析原件并建立新一轮有限重试。请先确认故障原因已处理。','人工重试',()=>http.post(`/mailOperations/jobs/${row.deliveryId}/retry`,{cycle:row.retryCycle,reason:reason.value}));}
onMounted(async()=>{try{admin.value=(await http.get('/mailOperations/capabilities')).admin;if(!admin.value&&tab.value==='admin')tab.value='jobs';await refresh();}catch{}});
</script>
<template>
  <section class="operations" v-loading="busy">
    <header><div><h1>{{tab==='mailboxes'?'邮箱与域名':tab==='jobs'?'处理作业':'运行概览'}}</h1><p>管理你的收件地址，查看邮局运行状态。</p></div><el-button @click="act(refresh,false)" :disabled="busy">刷新状态</el-button></header>
    <el-tabs v-model="tab">
      <el-tab-pane label="我的邮箱" name="mailboxes">
        <p>新建邮箱自动开启收信；所属域名需已启用。</p>
        <form class="mail-create-panel" v-perm="'account:add'" @submit.prevent="createMailbox"><h2>创建新邮箱</h2><div class="mail-create-fields"><el-input v-model="address" placeholder="输入邮箱地址前缀" aria-label="邮箱地址前缀" maxlength="64"/><el-select v-model="selectedDomain" placeholder="选择域名" aria-label="邮箱域名"><el-option v-for="domain in availableDomains" :key="domain" :value="domain" :label="domain"/></el-select><el-button type="primary" native-type="submit" :disabled="!fullAddress||busy">创建</el-button></div><p role="status">{{availableDomains.length?prefixHint:'尚无可用域名，请先在高级设置中配置收信域名。'}}</p></form>
        <p class="mailbox-order-hint">按住左侧把手拖动调整顺序，自动保存在当前设备，并同步到邮箱选择菜单；置顶邮箱仍优先显示。</p>
        <div ref="mailboxList" class="managed-mailboxes" :class="{'is-dragging':drag?.active}">
          <div class="managed-mailbox-labels" aria-hidden="true"><span></span><span>地址</span><span>状态</span><span>操作</span></div>
          <article v-for="row in visibleMailboxes" :key="row.accountId" :data-mailbox-id="row.accountId" class="managed-mailbox" :style="rowDragStyle(row.accountId)" :class="{'dragging':drag?.active&&drag.id===row.accountId}">
            <button class="mailbox-drag-handle" type="button" :disabled="busy" :aria-label="`拖动排序 ${row.email}`" title="拖动排序，也可用上下方向键移动" @dragstart.prevent @pointerdown="dragStart($event,row)" @pointermove="dragMove" @pointerup="dragEnd($event)" @pointercancel="dragEnd($event,true)" @lostpointercapture="dragEnd($event,true)" @keydown.up.prevent="moveMailbox(row,-1)" @keydown.down.prevent="moveMailbox(row,1)" @keydown.esc="drag&&dragEnd({pointerId:drag.pointer},true)"><svg viewBox="0 0 16 24" aria-hidden="true"><circle v-for="n in 6" :key="n" :cx="n%2?5:11" :cy="4+Math.floor((n-1)/2)*8" r="1.5" fill="currentColor"/></svg></button>
            <strong class="managed-address" :title="row.email">{{row.email}}</strong>
            <span class="managed-status">{{row.admissionPending?'待同步':row.receiveEnabled&&row.domainEnabled?'可收信':'禁收'}}</span>
            <div class="managed-actions">
              <el-dropdown class="mailbox-more" trigger="click" @command="command=>command==='delete'?remove(row):mailbox(row,row.receiveEnabled?'disable':'enable')">
                <el-button :aria-label="`更多操作 ${row.email}`" :disabled="busy">更多</el-button>
                <template #dropdown><el-dropdown-menu><el-dropdown-item command="receive" :disabled="busy||(!row.receiveEnabled&&!row.domainEnabled)">{{row.receiveEnabled?'停止收信':'启用收信'}}</el-dropdown-item><el-dropdown-item v-if="hasPerm('account:delete')" command="delete" :disabled="busy">删除</el-dropdown-item></el-dropdown-menu></template>
              </el-dropdown>
              <el-button @click="mailbox(row,row.receiveEnabled?'disable':'enable')" :disabled="busy||(!row.receiveEnabled&&!row.domainEnabled)">{{row.receiveEnabled?'停止收信':'启用收信'}}</el-button>
              <el-button type="danger" v-perm="'account:delete'" @click="remove(row)" :disabled="busy">删除</el-button>
            </div>
          </article>
          <el-empty v-if="!visibleMailboxes.length" description="暂无邮箱"/>
        </div>
        <el-button v-if="mailboxes.length&&mailboxes.length%30===0" @click="act(()=>loadMailboxes(true),false)">更多地址</el-button>
      </el-tab-pane>
      <el-tab-pane label="处理作业" name="jobs">
        <div class="actions"><el-select v-model="state" :disabled="busy" @change="act(()=>loadJobs(false),false)" aria-label="作业状态"><el-option v-for="value in ['FAILED','QUARANTINED','RECEIVED','QUEUED','PROCESSING','RETRY_WAIT']" :key="value" :value="value" :label="value"/></el-select>
          <el-select v-model="reason" :disabled="busy" aria-label="重试原因"><el-option value="STORAGE_RECOVERED" label="存储故障已恢复"/><el-option value="PARSER_UPDATED" label="解析器已修复"/><el-option value="MANUAL_REVIEW" label="人工复核完成"/></el-select></div>
        <p>普通用户仅能查看和重试自己的作业。重试请求先持久化；队列暂不可用时等待已启用的恢复任务调度。</p>
        <el-table :data="jobs"><el-table-column prop="deliveryId" label="投递 ID" min-width="300"/><el-table-column prop="state" label="状态"/><el-table-column prop="errorCode" label="错误代码" min-width="190"/><el-table-column prop="attempts" label="本轮尝试" width="95"/><el-table-column prop="retryCycle" label="重试轮次" width="95"/><el-table-column label="操作"><template #default="{row}"><el-button v-if="['FAILED','QUARANTINED'].includes(row.state)" @click="retry(row)" :disabled="busy">重试</el-button></template></el-table-column></el-table>
        <el-button v-if="jobs.length&&jobs.length%30===0" @click="act(()=>loadJobs(true),false)">更多作业</el-button>
      </el-tab-pane>
      <el-tab-pane v-if="admin" label="域与运维" name="admin">
        <div class="actions"><el-input v-model="domainName" placeholder="已配置的收信域" aria-label="域名"/><el-button @click="act(()=>http.post('/mailOperations/domains',{name:domainName,enabled:false}))" :disabled="!domainName||busy">登记域（禁收）</el-button></div>
        <el-table :data="domains"><el-table-column prop="name" label="域"/><el-table-column label="状态"><template #default="{row}">{{row.enabled?'启用':'禁收'}}</template></el-table-column><el-table-column label="操作"><template #default="{row}"><el-button @click="act(()=>http.post('/mailOperations/domains',{name:row.name,enabled:!row.enabled}))">{{row.enabled?'禁用':'启用'}}</el-button></template></el-table-column></el-table>
        <template v-if="status">
          <el-alert :closable="false" type="info" title="队列深度、未索引原件的最老年龄尚需云端监测；未显示为零。备份成功记录为执行器报告，仍需独立恢复验收。"/>
          <p>恢复调度：{{status.enabled.recovery?'已启用':'关闭'}}；删除登记：{{status.enabled.deletion?'已启用':'关闭'}}；物理清理：{{status.enabled.purge?'已启用':'关闭'}}；旧解析产物回收：{{status.enabled.generationGc?'已启用':'关闭'}}；过期处理租约：{{status.expiredLeases}}</p>
          <p>维护锁：{{status.storage?.kind}}，到期 {{time(status.storage?.expiresAt)}}。过期 PURGE 锁须停止旧运行实例后按操作手册处置。</p>
          <h2>处理与删除积压</h2><div class="panels"><el-table :data="status.processing"><el-table-column prop="state" label="处理状态"/><el-table-column prop="count" label="数量"/></el-table><el-table :data="status.deletion"><el-table-column prop="state" label="删除状态"/><el-table-column prop="count" label="数量"/></el-table></div>
          <h2>备份执行记录</h2><el-empty v-if="!status.backups.length" description="尚无备份执行记录，不能认定备份已配置"/><el-table v-else :data="status.backups"><el-table-column prop="backupId" label="作业 ID" min-width="290"/><el-table-column prop="state" label="本地快照"/><el-table-column label="异地传输"><template #default="{row}">{{({NOT_REPORTED:'未收到回执',PENDING:'传输中／待回执',COMPLETE:'执行器报告完成',FAILED:'执行器报告失败'})[row.offsiteState]||'未知'}}</template></el-table-column><el-table-column label="恢复验收"><template #default>待独立验收</template></el-table-column><el-table-column prop="errorCode" label="本地错误"/></el-table>
          <h2>批量删除登记</h2><p>COMPLETE 表示删除意图已全部登记；物理擦除仍需查看删除积压。</p><el-table :data="status.bulk"><el-table-column prop="jobId" label="作业 ID" min-width="290"/><el-table-column prop="state" label="状态"/><el-table-column prop="requestedCount" label="已登记邮件"/></el-table>
          <h2>DLQ 诊断</h2><el-table :data="status.events"><el-table-column prop="deliveryId" label="投递 ID" min-width="290"/><el-table-column prop="stage" label="阶段"/><el-table-column prop="code" label="代码"/></el-table>
          <h2>近期审计</h2><el-table :data="status.audit"><el-table-column prop="actorUserId" label="用户 ID"/><el-table-column prop="action" label="动作" min-width="180"/><el-table-column prop="targetId" label="目标" min-width="200"/><el-table-column prop="resultCode" label="结果"/></el-table>
        </template>
      </el-tab-pane>
    </el-tabs>
  </section>
</template>
<style scoped>
.operations{padding:24px;overflow:auto;height:100%;box-sizing:border-box}header,.actions,.panels{display:flex;gap:16px;align-items:center}.actions{margin:16px 0;max-width:700px}header{justify-content:space-between}h1{font-size:22px}h2{font-size:17px;margin-top:28px}p{line-height:1.7}.panels>*{min-width:0;flex:1}@media(max-width:700px){.operations{padding:12px}.actions,.panels{flex-direction:column;align-items:stretch}}

.managed-mailboxes{border:1px solid var(--el-border-color);border-radius:12px;overflow:hidden;max-width:100%}
.managed-mailbox,.managed-mailbox-labels{display:grid;grid-template-columns:32px minmax(0,1fr) 72px minmax(160px,1fr);gap:12px;align-items:center;padding:14px}
.managed-mailbox+.managed-mailbox{border-top:1px solid var(--el-border-color-lighter)}
.managed-mailbox-labels{background:var(--mail-soft);color:var(--el-text-color-secondary)}
.managed-address{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.managed-actions{display:flex;flex-wrap:wrap;gap:8px;min-width:0}
.managed-actions :deep(.el-button){margin:0}
.mailbox-order-hint{font-size:12px;color:var(--el-text-color-secondary);margin:12px 0}
.mailbox-more{display:none}
@media(max-width:1000px){.managed-mailbox{grid-template-columns:28px minmax(0,1fr) auto auto;gap:8px;padding:10px 8px}.managed-mailbox-labels{display:none}.managed-actions>.el-button{display:none}.mailbox-more{display:inline-flex}.managed-status{font-size:12px}.managed-actions{flex-wrap:nowrap}.mailbox-drag-handle{width:28px}}
@media(max-width:700px){header{flex-wrap:wrap}.operations{min-width:0}.mail-create-fields{flex-wrap:wrap}}
.managed-mailbox{position:relative;transition:transform 180ms ease,background-color 120ms ease}
.mailbox-drag-handle{width:32px;min-height:44px;display:grid;place-items:center;cursor:grab;touch-action:none;user-select:none;color:var(--el-text-color-secondary);border-radius:8px}
.mailbox-drag-handle svg{width:12px;height:22px;pointer-events:none}
.mailbox-drag-handle:hover,.mailbox-drag-handle:focus-visible{background:var(--mail-soft)}
.managed-mailboxes.is-dragging{overflow:visible;user-select:none}.managed-mailbox.dragging{z-index:5;transition:none;background:var(--el-bg-color);box-shadow:0 8px 24px #0002;border-radius:10px;outline:1px solid var(--el-border-color)}.dragging .mailbox-drag-handle{cursor:grabbing}
.drop-before::before,.drop-after::after{content:'';position:absolute;left:12px;right:12px;height:2px;background:var(--mail-focus);pointer-events:none}
.drop-before::before{top:0}.drop-after::after{bottom:0}
@media(prefers-reduced-motion:reduce){.managed-mailbox{transition:none}}
</style>
