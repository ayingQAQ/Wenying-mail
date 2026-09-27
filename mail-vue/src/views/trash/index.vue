<template>
 <section class="trash-view">
  <header class="trash-heading"><div><h1>回收站</h1><p>恢复的邮件会回到收件箱。</p></div><el-button :loading="loading" :disabled="busy" @click="load(true)">刷新</el-button></header>
  <p class="trash-policy" v-if="policy">{{policy.expirationEnabled?'邮件保留满 30 天后进入永久清理。':'自动到期清理尚未开启，可手动永久删除。'}}</p>
  <div class="trash-toolbar"><label><input class="mail-select" type="checkbox" aria-label="全选当前列表" :checked="allChecked" :indeterminate="checked.length>0&&!allChecked" :disabled="busy||loading||!rows.length" @change="checked=$event.target.checked?rows.map(row=>row.emailId):[]"/>全选当前列表</label><span>已选 {{checked.length}} 封</span><div class="trash-bulk-actions"><el-button v-perm="'email:delete'" :disabled="!checked.length||busy||loading" @click="act('restore',checked)">恢复所选</el-button><el-button v-perm="'email:delete'" type="danger" plain :disabled="!checked.length||busy||loading" @click="act('delete',checked)">永久删除所选</el-button></div></div>
  <p v-if="busy" class="trash-progress" role="status">正在处理 {{completed}} / {{requested}} 封邮件…</p>
  <el-alert v-if="failed" title="回收站加载失败，请重试。" type="error" :closable="false"/>
  <el-empty v-if="!loading&&!failed&&!rows.length" description="回收站为空"/>
  <article v-for="row in rows" :key="row.emailId" class="trash-row">
   <input class="mail-select" type="checkbox" v-model="checked" :value="row.emailId" :disabled="busy||loading" :aria-label="`选择邮件：${row.subject||'无主题'}`"/>
   <div class="trash-summary"><strong>{{row.subject||'（无主题）'}}</strong><p>{{row.name||row.sendEmail}}</p></div>
   <div class="trash-row-actions"><el-button v-perm="'email:delete'" :disabled="busy||loading" @click="act('restore',[row.emailId])">恢复</el-button><el-button v-perm="'email:delete'" type="danger" plain :disabled="busy||loading" @click="act('delete',[row.emailId])">永久删除</el-button></div>
  </article>
  <el-button v-if="hasMore" :loading="loading" :disabled="busy" @click="load(false)">加载更多</el-button>
  <details v-if="deletions.length" class="deletion-status"><summary>最近清理状态</summary><p v-for="item in deletions" :key="item.emailId">邮件 #{{item.emailId}} · {{item.state==='PURGED'?'在线副本已清除':item.retrying?'等待重试清理':'已隐藏，等待清理'}}</p></details>
 </section>
</template>
<script setup>
import {ref,computed,onMounted,onUnmounted} from 'vue';
import {ElMessageBox,ElMessage} from 'element-plus';
import {emailTrashList,emailRestore,emailPermanentDelete,emailDeletionStatus,emailTrashPolicy} from '@/request/email.js';
import {useEmailStore} from '@/store/email.js';
import {runMailBatch} from '@/utils/mail-batch.js';
const rows=ref([]),checked=ref([]),loading=ref(false),busy=ref(false),failed=ref(false),hasMore=ref(false),deletions=ref([]),policy=ref(null),completed=ref(0),requested=ref(0);
const allChecked=computed(()=>rows.value.length>0&&rows.value.every(row=>checked.value.includes(row.emailId)));
const store=useEmailStore();let controller,epoch=0,closed=false,nextBefore;
async function load(reset){
 if(busy.value)return;
 controller?.abort();controller=new AbortController();const current=++epoch;loading.value=true;failed.value=false;
 if(reset)checked.value=[];
 try{
  const [page,states,configuration]=await Promise.all([emailTrashList(reset?undefined:nextBefore,controller.signal),emailDeletionStatus(controller.signal),emailTrashPolicy(controller.signal)]);
  if(closed||current!==epoch)return;
  rows.value=reset?page:[...rows.value,...page];nextBefore=page.at(-1)?.emailId;hasMore.value=page.length===30;deletions.value=states;policy.value=configuration;
 }catch{if(!closed&&current===epoch)failed.value=true;}finally{if(current===epoch)loading.value=false;}
}
async function act(action,selection){
 if(busy.value||loading.value||!selection.length)return;
 const ids=[...selection];busy.value=true;completed.value=0;requested.value=ids.length;
 try{
  if(action==='delete')await ElMessageBox.confirm(`永久删除选中的 ${ids.length} 封邮件？删除后无法恢复。`,'确认永久删除',{confirmButtonText:'永久删除',cancelButtonText:'取消',type:'warning',closeOnClickModal:false});
  const result=await runMailBatch(ids,([id])=>action==='restore'?emailRestore(id):emailPermanentDelete(id),{isStopped:()=>closed,onSuccess:chunk=>{
   chunk.forEach(id=>delete store.detailMap[id]);
   if(chunk.includes(store.contentData.email?.emailId))store.contentData.email=null;
   if(closed)return;
   rows.value=rows.value.filter(row=>!chunk.includes(row.emailId));checked.value=checked.value.filter(id=>!chunk.includes(id));completed.value+=chunk.length;
  }});
  if(closed)return;
  if(result.failed){checked.value=result.remaining;ElMessage.warning(`已完成 ${result.done.length} 封，其余 ${result.remaining.length} 封保留选中，可重试`);}
  else ElMessage.success(`已${action==='restore'?'恢复':'删除'} ${result.done.length} 封邮件`);
 }catch(error){if(error!=='cancel'&&error!=='close')ElMessage.error('操作未完成，请重试');}finally{busy.value=false;}
}
onMounted(()=>load(true));onUnmounted(()=>{closed=true;epoch++;controller?.abort();});
</script>
<style scoped>
.trash-view{padding:24px 28px;overflow:auto;height:100%;box-sizing:border-box;color:var(--el-text-color-primary)}
.trash-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.trash-heading h1{font-size:21px;margin:0;font-weight:650}.trash-heading p,.trash-policy{font-size:12px;color:var(--el-text-color-secondary);margin:8px 0}.trash-policy{margin-bottom:20px}
.trash-toolbar{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px 14px;background:var(--mail-soft);border-radius:10px;font-size:12px}.trash-toolbar label{display:flex;gap:10px;align-items:center;cursor:pointer}.trash-toolbar>span{color:var(--el-text-color-secondary)}.trash-bulk-actions{margin-left:auto;display:flex;gap:8px}
.trash-row{display:grid;grid-template-columns:16px minmax(0,1fr) 200px;align-items:center;gap:16px;padding:18px 14px;border-bottom:1px solid var(--el-border-color-lighter)}.trash-summary{min-width:0}.trash-summary strong{display:block;font-size:13px;line-height:1.6;overflow-wrap:anywhere;font-weight:550}.trash-summary p{font-size:12px;color:var(--el-text-color-secondary);margin:5px 0 0;overflow-wrap:anywhere}
.trash-row-actions{display:grid;grid-template-columns:76px 112px;gap:12px}.trash-row-actions .el-button,.trash-bulk-actions .el-button{margin-left:0;width:100%;height:32px}.trash-bulk-actions .el-button{width:auto}.trash-progress{font-size:12px;color:var(--el-text-color-secondary);padding:10px}.deletion-status{margin-top:24px;font-size:12px;color:var(--el-text-color-secondary)}.deletion-status summary{cursor:pointer}.deletion-status p{margin-top:8px}
@media(max-width:600px){.trash-view{padding:16px 12px}.trash-row{grid-template-columns:16px minmax(0,1fr);gap:10px;padding:14px 4px}.trash-row-actions{grid-column:2;justify-self:end}.trash-toolbar{gap:12px}.trash-bulk-actions{width:100%;justify-content:flex-end}.trash-heading h1{font-size:20px}}
</style>
