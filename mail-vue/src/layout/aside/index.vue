<script setup>
import {Icon} from '@iconify/vue';
import {useRoute,useRouter} from 'vue-router';
import {useUserStore} from '@/store/user.js';
import {useSettingStore} from '@/store/setting.js';
import {hasPerm} from '@/perm/perm.js';
import MailboxPicker from '@/components/mailbox-picker.vue';
const route=useRoute(),router=useRouter(),user=useUserStore(),settings=useSettingStore();
const mailNav=[['email','inbox','收件箱'],['star','star','星标邮件'],['trash','trash-2','回收站']];
const adminNav=[['operations','activity','运行概览',null,'admin'],['operations','mail','邮箱与域名',null,'mailboxes'],['setting','settings','系统设置'],['user','users','用户管理','user:query'],['all-email','mails','全站邮件','all-email:query'],['role','shield','权限管理','role:query'],['sys-setting','sliders-horizontal','高级设置','setting:query']];
function active(name,tab){return route.name===name&&(!tab||(route.query.tab||'mailboxes')===tab)}
function go(name,tab){router.push({name,query:tab?{tab}:{}})}
</script>
<template>
 <div class="mail-sidebar">
  <div class="mail-brand"><img class="mail-brand-icon" src="/wengying-mail.svg" alt=""/><div>{{settings.settings.title||'Wengying mail'}}<small>PRIVATE MAIL</small></div></div>
  <MailboxPicker v-if="hasPerm('account:query')"/>
  <p class="mail-nav-label">邮件夹</p>
  <nav aria-label="邮件导航"><button v-for="[name,icon,label] in mailNav" :key="name" :class="{active:active(name)}" @click="go(name)"><Icon :icon="`mail-ui:${icon}`"/>{{label}}</button></nav>
  <p class="mail-nav-label management-label">管理</p>
  <nav aria-label="管理导航"><template v-for="[name,icon,label,perm,tab] in adminNav" :key="label"><button v-if="!perm||hasPerm(perm)" :class="{active:active(name,tab)}" @click="go(name,tab)"><Icon :icon="`mail-ui:${icon}`"/>{{label}}</button></template></nav>
  <footer><span class="mail-profile-avatar">{{(user.user.email||'M').slice(0,1).toUpperCase()}}</span><div><strong>我的邮局</strong><small>{{user.user.role?.name||'个人邮箱'}}</small></div></footer>
 </div>
</template>
<style scoped>
.mail-sidebar{width:238px;height:100%;display:flex;flex-direction:column;background:var(--mail-side);border-right:1px solid var(--el-border-color);overflow:auto;padding:24px 0 12px}.mail-brand{display:flex;gap:10px;align-items:center;font-size:16px;font-weight:600;padding:0 22px 25px}.mail-brand>span{display:grid;place-items:center;background:var(--el-text-color-primary);color:var(--el-bg-color);border-radius:9px;width:32px;height:32px;flex-shrink:0}.mail-brand-icon{width:32px;height:32px;flex-shrink:0}.mail-brand svg{width:19px;height:19px}.mail-brand small{display:block;font-size:9px;letter-spacing:2px;font-weight:400;color:var(--el-text-color-secondary);margin-top:3px}.mail-nav-label{padding:12px 24px 8px;font-size:10px;color:var(--el-text-color-secondary);letter-spacing:1px}.management-label{margin-top:18px}nav{display:flex;flex-direction:column;gap:4px;padding:0 12px}nav button{display:flex;align-items:center;gap:12px;text-align:left;border-radius:7px;padding:10px 12px;font-size:12px;color:var(--el-text-color-regular);cursor:pointer}nav button:hover{background:var(--mail-soft)}nav button.active{background:var(--mail-selected);color:var(--el-text-color-primary);font-weight:600}nav svg{width:17px;height:17px}footer{margin: auto 18px 0;padding:22px 6px 4px;display:flex;gap:10px;align-items:center}footer strong{font-size:12px;font-weight:500}footer small{display:block;font-size:10px;color:var(--el-text-color-secondary);margin-top:3px}.mail-profile-avatar{border-radius:50%;width:32px;height:32px;background:var(--mail-selected);display:grid;place-items:center;font-size:12px}
</style>
