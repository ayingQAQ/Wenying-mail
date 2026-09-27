<template>
 <main class="login-screen">
  <section class="login-cover"><div class="login-brand"><img src="/wengying-mail.svg" alt="" width="33" height="33"/><div>{{settingStore.settings.title||'Wengying mail'}}<small>PRIVATE MAIL</small></div></div><div class="login-statement"><p class="kicker">A SPACE OF YOUR OWN</p><h1>每一封来信，<br>都有自己的位置。</h1><p>一个安静、有序的邮件空间。<br>专注于重要的信息，掌握自己的通信。</p></div><footer>私人邮件空间</footer></section>
  <section class="login-main"><form class="login-form" @submit.prevent="submit"><h2>欢迎回来</h2><p>登录你的私人邮局</p><div v-if="emailCodeAvailable" class="login-tabs"><button type="button" :class="{active:loginMode==='password'}" @click="loginMode='password'">密码登录</button><button type="button" :class="{active:loginMode==='code'}" @click="loginMode='code';form.password=''">邮箱验证码</button></div><template v-if="loginMode==='password'"><label for="loginEmail">邮箱地址</label><el-input id="loginEmail" v-model="form.email" type="email" placeholder="输入管理员邮箱" autocomplete="username" aria-label="邮箱地址"/><label for="loginPassword">邮局密码</label><el-input id="loginPassword" v-model="form.password" type="password" show-password placeholder="输入独立邮局密码" autocomplete="current-password" aria-label="邮局密码"/></template><p v-else class="login-code-info">通过管理员邮箱接收一次性验证码。继续后，在验证页面输入邮箱并完成验证。</p><el-button type="primary" native-type="submit" :loading="loginLoading||emailLoading">{{loginMode==='password'?'登录邮局':'继续邮箱验证'}}<Icon icon="mail-ui:arrow-right"/></el-button><small class="login-hint">{{loginMode==='password'?'使用独立的邮局密码登录。':'验证成功后将自动返回邮局。'}}</small></form></section>
 </main>
</template>
<script setup>
import { computed, reactive, ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { login, loginOptions, startEmailLogin } from '@/request/login.js';
import { reloadSession } from '@/auth/browser.js';
import { isEmail } from '@/utils/verify-utils.js';
import { useSettingStore } from '@/store/setting.js';
import { useUiStore } from '@/store/ui.js';
import {Icon} from '@iconify/vue';

const { t } = useI18n();
const settingStore = useSettingStore();
const uiStore = useUiStore();
const loginMode=ref('password');
const form = reactive({ email: '', password: '' });
const loginLoading = ref(false);
const emailLoading=ref(false),emailCodeAvailable=ref(false);
onMounted(async()=>{
  if(new URLSearchParams(window.location.search).get('emailLogin')==='failed')
    ElMessage({message:t('emailLoginFailed'),type:'error',plain:true});
  try { emailCodeAvailable.value=(await loginOptions()).emailCode===true; } catch { /* Password login remains available. */ }
});
async function emailLogin(){
  if(emailLoading.value||loginLoading.value)return;
  emailLoading.value=true;
  try {
    const {url}=await startEmailLogin();
    if(typeof url!=='string'||!/^\/api\/login\/access\/callback\?state=[A-Za-z0-9_-]{43}\.[0-9]{13}$/.test(url))throw new Error('INVALID_LOGIN_DESTINATION');
    window.location.assign(url);
  } catch {emailLoading.value=false;}
}
async function submit() {
  if(loginMode.value==='code'){await emailLogin();return;}
  if (loginLoading.value||emailLoading.value) return;
  const email = form.email.trim();
  if (!isEmail(email) || !form.password) {
    ElMessage({ message: t(!isEmail(email) ? 'notEmailMsg' : 'emptyPwdMsg'), type: 'error', plain: true });
    return;
  }
  loginLoading.value = true;
  try {
    await login(email, form.password);
    form.password = '';
    reloadSession('/inbox');
  } catch {
    // The request layer presents authentication failures without storing credentials.
  } finally {
    loginLoading.value = false;
  }
}
</script>
<style scoped>
.login-screen{min-height:100dvh;display:grid;grid-template-columns:1fr 1fr;background:var(--el-bg-color)}.login-cover{background:var(--mail-side);border-right:1px solid var(--el-border-color);padding:44px 50px;display:flex;flex-direction:column}.login-brand{display:flex;align-items:center;gap:12px;font-size:17px;font-weight:600}.login-brand>svg{width:33px;height:33px;padding:7px;background:var(--el-text-color-primary);color:var(--el-bg-color);border-radius:8px}.login-brand small{display:block;font-size:9px;letter-spacing:2px;color:var(--el-text-color-secondary);font-weight:400;margin-top:3px}.login-statement{margin:auto 0;max-width:430px}.login-statement .kicker{font-size:10px;letter-spacing:3px;margin-bottom:25px}.login-statement h1{font-size:44px;font-weight:550;letter-spacing:-1.5px;line-height:1.4}.login-statement p{font-size:13px;color:var(--el-text-color-secondary);line-height:2;margin-top:22px}.login-cover footer{font-size:10px;color:var(--el-text-color-secondary)}.login-main{display:flex;align-items:center;justify-content:center;padding:35px}.login-form{width:340px;max-width:100%}.login-form h2{font-size:25px;font-weight:600}.login-form>p{font-size:12px;color:var(--el-text-color-secondary);margin:10px 0 28px}.login-tabs{display:flex;gap:3px;background:var(--mail-soft);border-radius:7px;padding:3px;margin-bottom:26px}.login-tabs button{flex:1;border-radius:5px;padding:8px;color:var(--el-text-color-regular);font-size:12px;cursor:pointer}.login-tabs button.active{background:var(--el-bg-color);color:var(--el-text-color-primary);box-shadow:0 1px 4px #0001}.login-form label{display:block;font-size:11px;margin-bottom:9px}.login-form .el-input{height:41px;margin-bottom:20px}.login-form .el-button{width:100%;height:41px;margin-top:4px}.login-form .el-button svg{width:16px;margin-left:10px}.login-hint{display:block;text-align:center;font-size:10px;color:var(--el-text-color-secondary);margin-top:22px}.login-code-info{line-height:1.9;padding:16px;background:var(--mail-soft);border-radius:7px}@media(max-width:850px){.login-cover{padding:30px}.login-statement h1{font-size:32px}}@media(max-width:620px){.login-screen{display:block}.login-cover{display:none}.login-main{min-height:100dvh;padding:30px}}
</style>
