<script setup>
import {ref,onMounted,onUnmounted,computed} from 'vue';
import {Icon} from '@iconify/vue';
import http from '@/axios/index.js';
const data=ref(null),busy=ref(false),error=ref(false);let controller;
function resetTilt(event){
 const shell=event.currentTarget;
 shell.style.removeProperty('--tilt-x');shell.style.removeProperty('--tilt-y');
 shell.style.removeProperty('--lift');
 shell.style.removeProperty('--glare');shell.style.removeProperty('--gx');shell.style.removeProperty('--gy');
}
function tilt(event){
 if(event.pointerType!=='mouse'||!window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches){resetTilt(event);return;}
 // Measure the stationary wrapper so the rotated card cannot feed back into its own angle.
 const shell=event.currentTarget,r=shell.getBoundingClientRect();
 const px=Math.max(0,Math.min(1,(event.clientX-r.left)/r.width));
 const py=Math.max(0,Math.min(1,(event.clientY-r.top)/r.height));
 shell.style.setProperty('--tilt-x',`${(0.5-py)*16}deg`);
 shell.style.setProperty('--tilt-y',`${(px-0.5)*16}deg`);
 shell.style.setProperty('--lift','40px');
 shell.style.setProperty('--gx',`${px*100}%`);shell.style.setProperty('--gy',`${py*100}%`);
 shell.style.setProperty('--glare','1');
}
async function load(){
 if(busy.value)return;busy.value=true;error.value=false;controller=new AbortController();
 try{data.value=await http.get('/email/statistics',{signal:controller.signal});}
 catch{if(!controller.signal.aborted)error.value=true;}
 finally{busy.value=false;}
}
function bytes(value){if(value<1024)return `${value} B`;if(value<1024**2)return `${(value/1024).toFixed(1)} KB`;if(value<1024**3)return `${(value/1024**2).toFixed(1)} MB`;return `${(value/1024**3).toFixed(2)} GB`;}
const cards=computed(()=>[
 {label:'总收件',icon:'inbox',value:data.value?.received,note:'当前保留的收件，含回收站'},
 {label:'总发件',icon:'send',value:data.value?.sent,note:'当前为只收模式'},
 {label:'未读邮件',icon:'mail',value:data.value?.unread,note:'所有邮箱的收件箱未读'},
 {label:'原件用量',icon:'database',value:data.value?bytes(data.value.rawBytes):null,note:'原始邮件大小，不含派生副本'},
]);
onMounted(load);onUnmounted(()=>controller?.abort());
</script>
<template>
 <section class="mail-statistics">
  <header><div><h2>数据统计</h2><p>当前账号 · 全部邮箱</p></div><button class="mail-icon-button" aria-label="刷新统计" :disabled="busy" @click="load"><Icon icon="mail-ui:refresh-cw"/></button></header>
  <div v-if="error" class="statistics-error" role="alert">统计加载失败，请点击刷新重试。</div>
  <div class="statistics-grid" :aria-busy="busy">
   <div v-for="card in cards" :key="card.label" class="statistics-card-shell" @pointermove="tilt" @pointerleave="resetTilt" @pointercancel="resetTilt"><article class="statistics-card"><span class="statistics-icon"><Icon :icon="`mail-ui:${card.icon}`"/></span><div><p>{{card.label}}</p><strong>{{card.value??'—'}}</strong><small>{{card.note}}</small></div></article></div>
  </div>
  <p class="statistics-note">已永久删除或所属邮箱已删除的邮件不计入。原件用量不是云存储账单，也不代表账户配额；未记录原件大小的旧邮件不计入该数值。</p>
 </section>
</template>
<style scoped>
.statistics-card-shell{min-width:0;display:flex}
.statistics-card-shell>.statistics-card{position:relative;width:100%;box-sizing:border-box;background:linear-gradient(135deg,var(--el-bg-color),var(--mail-soft));transform-style:preserve-3d;transform:perspective(800px) rotateX(var(--tilt-x,0deg)) rotateY(var(--tilt-y,0deg));transition:transform 150ms ease-out,box-shadow 150ms ease-out;box-shadow:0 8px 24px rgb(25 35 50 / calc(var(--glare,0)*0.09))}
.statistics-card::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:radial-gradient(circle at var(--gx,50%) var(--gy,50%),rgb(255 255 255 / 50%),transparent 65%);opacity:var(--glare,0);transform:translateZ(1px);transition:opacity 150ms ease-out}
.statistics-card>.statistics-icon,.statistics-card>div{transform:translateZ(var(--lift,0px));transition:transform 150ms ease-out}
@media(prefers-reduced-motion:reduce),(hover:none),(pointer:coarse){.statistics-card-shell>.statistics-card,.statistics-card>.statistics-icon,.statistics-card>div{transform:none;transition:none}}
@media(prefers-reduced-motion:reduce),(hover:none),(pointer:coarse){.statistics-card::after{display:none}.statistics-card-shell>.statistics-card{box-shadow:none}}
.mail-statistics{padding:28px;overflow:auto;height:100%;background:var(--el-bg-color)}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;gap:16px}h2{font-size:20px;font-weight:650}header p,.statistics-note{font-size:13px;color:var(--el-text-color-secondary);line-height:1.7;margin-top:8px}.statistics-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}.statistics-card{display:flex;align-items:center;gap:16px;padding:26px 22px;border:1px solid var(--el-border-color);border-radius:12px;min-width:0}.statistics-icon{display:grid;place-items:center;width:48px;height:48px;flex-shrink:0;border-radius:11px;background:var(--mail-soft)}.statistics-icon svg{width:24px;height:24px}.statistics-card>div{min-width:0}.statistics-card p{font-size:14px;color:var(--el-text-color-secondary)}.statistics-card strong{display:block;font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;margin:7px 0;overflow-wrap:anywhere}.statistics-card small{display:block;font-size:11px;color:var(--el-text-color-secondary);line-height:1.6}.statistics-note{margin-top:22px}.statistics-error{padding:12px;margin-bottom:16px;color:var(--el-color-danger)}@media(max-width:1100px){.statistics-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:500px){.mail-statistics{padding:16px}.statistics-grid{gap:12px}.statistics-card{padding:16px 12px;gap:10px;align-items:flex-start}.statistics-icon{width:32px;height:32px}.statistics-icon svg{width:19px;height:19px}.statistics-card strong{font-size:22px}}@media(max-width:340px){.statistics-grid{grid-template-columns:1fr}}
</style>
