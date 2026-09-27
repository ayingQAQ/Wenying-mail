<script setup>
import { Icon } from '@iconify/vue';
import { ElMessage } from 'element-plus';
const props = defineProps({code: String, compact: Boolean});
async function copy() {
  try { await navigator.clipboard.writeText(props.code); ElMessage.success('验证码已复制'); }
  catch { ElMessage.error('复制失败，请手动选择验证码'); }
}
</script>
<template>
  <button v-if="compact && code" type="button" class="verification-chip" :aria-label="`复制验证码 ${code}`" @click.stop="copy" @keydown.stop>
    <Icon icon="mail-ui:key-round"/><span>复制验证码</span><strong>{{ code }}</strong><Icon icon="mail-ui:copy"/>
  </button>
  <div v-else-if="code" class="verification-banner">
    <span class="verification-key"><Icon icon="mail-ui:key-round"/></span>
    <div class="verification-description"><strong>检测到验证码</strong><p>点击复制，不会改变邮件已读状态</p></div>
    <button type="button" :aria-label="`复制验证码 ${code}`" @click.stop="copy"><b>{{ code }}</b><Icon icon="mail-ui:copy"/><span>复制</span></button>
  </div>
</template>
<style scoped>
button{cursor:pointer;color:var(--el-text-color-primary)}svg{width:15px;height:15px;flex-shrink:0}.verification-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--el-border-color);border-radius:5px;padding:3px 7px;background:var(--el-bg-color);font-size:11px;max-width:100%}.verification-chip strong{letter-spacing:.5px}.verification-banner{display:flex;align-items:center;gap:13px;background:var(--mail-soft);border:1px solid var(--el-border-color);border-radius:8px;margin:20px 0;padding:16px 18px}.verification-key{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;background:var(--el-border-color-lighter);flex-shrink:0}.verification-key svg{width:21px;height:21px}.verification-banner strong{font-size:14px}.verification-banner p{font-size:11px;color:var(--el-text-color-secondary);margin-top:4px}.verification-banner button{margin-left:auto;display:flex;align-items:center;gap:8px;padding:8px;border-radius:5px}.verification-banner b{font-size:22px;letter-spacing:1px;font-variant-numeric:tabular-nums}button:hover{background:var(--el-fill-color)}@media(max-width:700px){.verification-banner{flex-wrap:wrap}.verification-banner button{margin-left:44px;padding:0}.verification-banner b{font-size:24px}}
</style>
