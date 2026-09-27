<script setup>
import {computed,ref} from 'vue';
import {useRoute} from 'vue-router';
import {Icon} from '@iconify/vue';
import {useUiStore} from '@/store/ui.js';
import {useUserStore} from '@/store/user.js';
import {logout} from '@/request/login.js';
import {reloadSession} from '@/auth/browser.js';
const ui=useUiStore(),user=useUserStore(),route=useRoute(),busy=ref(false);
const title=computed(()=>({statistics:'数据统计',email:'收件箱',star:'星标邮件',trash:'回收站',content:'邮件详情',operations:route.query.tab==='admin'?'运行概览':'邮箱与域名',setting:'系统设置',user:'用户管理','all-email':'全站邮件',role:'权限管理','sys-setting':'高级设置'})[route.name]||'私人邮局');
function theme(){ui.dark=!ui.dark;document.documentElement.classList.toggle('dark',ui.dark)}
async function signout(){if(busy.value)return;busy.value=true;try{await logout();reloadSession('/login')}finally{busy.value=false}}
</script>
<template>
 <header class="mail-topbar"><button class="mail-icon-button" aria-label="展开或收起导航" @click="ui.asideShow=!ui.asideShow"><Icon icon="mail-ui:panel-left"/></button><h1>{{title}}</h1><span class="mail-topbar-divider"/><p>你的邮件，井然有序。</p><div class="mail-topbar-actions"><button class="mail-icon-button" aria-label="切换深浅主题" @click="theme"><Icon :icon="ui.dark?'mail-ui:sun':'mail-ui:moon'"/></button><el-dropdown trigger="click"><button class="mail-user-button" aria-label="账号菜单">{{(user.user.email||'M').slice(0,1).toUpperCase()}}</button><template #dropdown><el-dropdown-menu><el-dropdown-item disabled>{{user.user.email}}</el-dropdown-item><el-dropdown-item :disabled="busy" @click="signout">退出登录</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div></header>
</template>
<style scoped>
.mail-topbar{height:60px;display:flex;align-items:center;gap:15px;padding:0 24px;background:var(--el-bg-color)}h1{font-size:16px;font-weight:600}p{font-size:12px;color:var(--el-text-color-secondary)}.mail-topbar-divider{width:1px;height:17px;background:var(--el-border-color)}.mail-topbar-actions{margin-left:auto;display:flex;gap:15px;align-items:center}.mail-user-button{width:30px;height:30px;border-radius:50%;background:var(--mail-selected);color:var(--el-text-color-primary);cursor:pointer}@media(max-width:700px){.mail-topbar{padding:0 15px;gap:10px}p,.mail-topbar-divider{display:none}}
</style>

