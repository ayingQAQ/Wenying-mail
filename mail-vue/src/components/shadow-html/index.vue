<template>
  <div class="mail-body">
    <button v-if="images.some(image => image.kind === 'remote') && !remote" @click="remote = true">
      {{ english ? 'Load external images (may reveal that you opened this message)' : '加载外部图片（可能向发件人透露你已阅读邮件）' }}
    </button>
    <iframe class="mail-frame" :srcdoc="documentHtml" sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer" :title="english ? 'Message body' : '邮件正文'" />
  </div>
</template>
<script setup>
import { computed, ref, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { emailInline } from '@/request/email.js';
import { inlineImageUrl } from '@/utils/inline-image.js';
const props=defineProps({html:{type:String,required:true},images:{type:Array,default:()=>[]}});
const {locale}=useI18n();
const english=computed(()=>locale.value.startsWith('en'));
const remote=ref(false),sources=ref({});
let controller,epoch=0;
function clear() { controller?.abort(); sources.value={}; }
watch(()=>[props.html,props.images],async()=>{
  const current=++epoch; clear(); remote.value=false; controller=new AbortController();
  for (const image of props.images.filter(image=>image.kind==='cid')) {
    try {
      const blob=await emailInline(image.attId,controller.signal);
      const url=await inlineImageUrl(blob);
      if (current!==epoch) return;
      sources.value={...sources.value,[image.id]:url};
    } catch { if (current!==epoch) return; }
  }
},{immediate:true});
onUnmounted(()=>{epoch++;clear();});
const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const documentHtml=computed(()=>{
  const urls={...sources.value};
  if (remote.value) for (const image of props.images) {
    if (image.kind==='remote') {
      try { const url=new URL(image.source); if (url.protocol==='https:' && !url.username && !url.password) urls[image.id]=url.href; } catch {}
    }
  }
  const html=props.html.replace(/data-mail-image="(image-[1-9]\d*)"/g,(marker,id)=>urls[id] ? `${marker} src="${escape(urls[id])}" referrerpolicy="no-referrer"`:marker);
  const policy=`default-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src data:${remote.value ? ' https:':''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>body{font:14px/1.6 sans-serif;overflow-wrap:anywhere;margin:12px;color:#18212a;background:white}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{max-width:100%}
@media(max-width:700px){
  html{width:100%;box-sizing:border-box}
  body{margin:12px;min-width:0!important;width:auto!important}
  body *{box-sizing:border-box;max-width:100%!important;min-width:0!important;overflow-wrap:anywhere!important}
  table{width:100%!important;table-layout:fixed!important}
  td,th{width:auto!important;white-space:normal!important}
  pre{white-space:pre-wrap!important}
}</style></head><body>${html}</body></html>`;
});
</script>
<style scoped>
.mail-body{min-width:0;max-width:100%;overflow-wrap:anywhere}
.mail-frame{display:block;max-width:100%;width:100%;min-height:60vh;border:0;background:white}
button{max-width:calc(100% - 16px);white-space:normal;overflow-wrap:anywhere;margin:8px;padding:8px;cursor:pointer}
</style>
