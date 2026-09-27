<script setup>
import {computed, ref, onMounted, onUnmounted, watch} from 'vue';
import {Icon} from '@iconify/vue';
import {ElMessage} from 'element-plus';
import {accountList} from '@/request/account.js';
import {useAccountStore} from '@/store/account.js';
import {useUserStore} from '@/store/user.js';
const store=useAccountStore(), user=useUserStore();
const open=ref(false), query=ref(''), rows=ref([]), busy=ref(false), more=ref(true), failed=ref(false), search=ref();
const picker=ref(),dropdownWidth=ref(240);let resizeObserver,closed=false,pendingReset=false,epoch=0;
const order=computed(()=>store.orderByUser[String(user.user.userId)]||[]);
const rank=id=>{const n=order.value.indexOf(id);return n<0?Number.MAX_SAFE_INTEGER:n;};
const pins=computed(()=>store.pinnedByUser[String(user.user.userId)]||[]);
const label=computed(()=>store.allMailboxes?'全部邮箱':store.currentAccount.email||'选择邮箱');
const filtered=computed(()=>rows.value.filter(row=>row.email.toLowerCase().includes(query.value.trim().toLowerCase())).sort((a,b)=>Number(pins.value.includes(b.accountId))-Number(pins.value.includes(a.accountId)) || rank(a.accountId)-rank(b.accountId)));
async function load(reset=false){
  if(closed)return;
  if(busy.value){if(reset){pendingReset=true;epoch++;}return;}
  const request=++epoch;busy.value=true;failed.value=false;
  try{const last=reset?null:rows.value.at(-1);const data=await accountList(last?.accountId||0,30,last?.sort??undefined);if(closed||request!==epoch)return;rows.value=reset?data:[...rows.value,...data];more.value=data.length===30;
    if(reset){const current=rows.value.find(r=>r.accountId===store.currentAccountId);if(current)store.currentAccount=current;else if(!store.currentAccountId&&rows.value.length)choose(rows.value[0]);}
  }catch{if(!closed&&request===epoch)failed.value=true}finally{busy.value=false;if(pendingReset&&!closed){pendingReset=false;await load(true);}}
}
function choose(row){store.allMailboxes=!row;store.currentAccount=row||rows.value[0]||{};store.currentAccountId=store.currentAccount.accountId||0;store.selectionByUser[String(user.user.userId)]={id:store.currentAccountId,all:store.allMailboxes};open.value=false;}
function pin(row){const key=String(user.user.userId);store.pinnedByUser[key]=pins.value.includes(row.accountId)?pins.value.filter(id=>id!==row.accountId):[...pins.value,row.accountId];}
async function copy(){try{await navigator.clipboard.writeText(store.currentAccount.email);ElMessage.success('邮箱地址已复制')}catch{ElMessage.error('复制失败，请手动复制')}}
watch(open,value=>{if(value)query.value=''});
function focusSearch(){if(open.value)search.value?.input?.focus({preventScroll:true})}
watch(()=>store.revision,()=>load(true));
onMounted(()=>{load(true);resizeObserver=new ResizeObserver(()=>{dropdownWidth.value=picker.value.getBoundingClientRect().width;});resizeObserver.observe(picker.value);});
onUnmounted(()=>{closed=true;epoch++;resizeObserver?.disconnect();});
</script>
<template>
 <div ref="picker" class="mailbox-picker">
  <el-popover v-model:visible="open" trigger="click" placement="bottom-start" :width="dropdownWidth" popper-class="mailbox-dropdown" :persistent="true" :show-after="0" :hide-after="0" :show-arrow="false" transition="mailbox-fade" @after-enter="focusSearch">
   <template #reference><button class="mailbox-trigger" :aria-expanded="open" :title="label"><Icon icon="mail-ui:mail"/><span>{{label}}</span><Icon icon="mail-ui:chevron-down"/></button></template>
   <div @keydown.esc="open=false"><el-input ref="search" v-model="query" placeholder="搜索邮箱…" aria-label="搜索邮箱" clearable/>
    <button class="mailbox-choice all-choice" :class="{selected:store.allMailboxes}" @click="choose(null)"><Icon icon="mail-ui:mail"/>全部邮箱</button>
    <div class="mailbox-options">
     <div v-for="row in filtered" :key="row.accountId" class="mailbox-option" :class="{selected:!store.allMailboxes&&store.currentAccountId===row.accountId}">
      <button class="mailbox-choice" :aria-pressed="!store.allMailboxes&&store.currentAccountId===row.accountId" @click="choose(row)"><Icon icon="mail-ui:mail"/><span>{{row.email}}</span></button>
      <button class="mailbox-pin" :class="{pinned:pins.includes(row.accountId)}" :aria-label="`${pins.includes(row.accountId)?'取消置顶':'置顶'} ${row.email}`" :aria-pressed="pins.includes(row.accountId)" @click="pin(row)"><Icon icon="mail-ui:pin"/></button>
     </div>
     <p v-if="!filtered.length&&!busy" class="mailbox-empty">{{failed?'邮箱加载失败':'没有匹配的邮箱'}}</p>
     <el-button v-if="more||failed" text :loading="busy" @click="load()">{{failed?'重试':'加载更多邮箱'}}</el-button>
    </div><small v-if="more&&query">搜索已加载的邮箱，可继续加载更多。</small>
   </div>
  </el-popover>
  <button class="mailbox-copy" title="复制邮箱地址" aria-label="复制邮箱地址" :disabled="store.allMailboxes||!store.currentAccount.email" @click="copy"><Icon icon="mail-ui:copy"/></button>
 </div>
</template>
<style>
.mailbox-dropdown{max-width:calc(100vw - 24px);padding:9px!important}.mailbox-dropdown svg,.mailbox-picker svg{width:16px;height:16px;flex-shrink:0}.mailbox-picker{display:flex;gap:5px;margin:0 12px 20px}.mailbox-trigger,.mailbox-copy{display:flex;align-items:center;gap:7px;height:39px;border:1px solid var(--el-border-color);border-radius:7px;background:var(--el-bg-color);color:var(--el-text-color-primary);cursor:pointer;padding:0 8px}.mailbox-trigger{flex:1;min-width:0;font-size:12px}.mailbox-trigger span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}.mailbox-copy{width:32px;justify-content:center}.mailbox-copy:disabled{opacity:.4;cursor:default}.mailbox-options{max-height:330px;overflow:auto}.mailbox-choice{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:12px 7px;text-align:left;color:var(--el-text-color-primary);cursor:pointer}.mailbox-choice span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.all-choice{width:100%;margin-top:7px;border-bottom:1px solid var(--el-border-color-lighter)}.mailbox-option{display:flex;align-items:center}.mailbox-option:hover,.mailbox-option.selected,.all-choice.selected{background:var(--mail-soft)}.mailbox-pin{padding:6px;color:var(--el-text-color-secondary);cursor:pointer}.mailbox-pin.pinned{color:#bc8026}.mailbox-empty{padding:20px;text-align:center;color:var(--el-text-color-secondary)}.mailbox-dropdown small{color:var(--el-text-color-secondary);font-size:11px}

.mailbox-dropdown.el-popper{border-radius:var(--mail-radius-panel);box-shadow:var(--mail-shadow);border-color:var(--el-border-color);transform-origin:top left!important}
.mailbox-dropdown .el-input__inner:focus-visible{outline:none!important;outline-offset:0!important}
.mailbox-dropdown .el-input__wrapper{box-shadow:0 0 0 1px var(--el-border-color) inset!important;border-radius:6px;transition:box-shadow 100ms ease}
.mailbox-dropdown .el-input__wrapper.is-focus{box-shadow:0 0 0 1px var(--mail-focus) inset,0 0 0 3px var(--mail-focus-halo)!important}
.mailbox-fade-enter-active,.mailbox-fade-leave-active{transition:opacity var(--mail-enter) var(--mail-ease),translate var(--mail-enter) var(--mail-ease)!important}
.mailbox-fade-leave-active{transition-duration:var(--mail-leave)!important}
.mailbox-fade-enter-from,.mailbox-fade-leave-to{opacity:0;translate:0 -3px}
.mailbox-fade-enter-to,.mailbox-fade-leave-from{opacity:1;translate:0 0}
@media(prefers-reduced-motion:reduce){.mailbox-fade-enter-active,.mailbox-fade-leave-active{transition:none!important}}
</style>
