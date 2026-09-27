import {createApp} from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { init } from '@/init/init.js';
import { createPinia } from 'pinia';
import piniaPersistedState from 'pinia-plugin-persistedstate';
import 'element-plus/theme-chalk/dark/css-vars.css';
import 'nprogress/nprogress.css';
// Service APIs are imported explicitly, so their styles must be explicit too.
import 'element-plus/theme-chalk/el-message-box.css';
import 'element-plus/theme-chalk/el-message.css';
import 'element-plus/theme-chalk/el-notification.css';
import 'element-plus/theme-chalk/el-loading.css';
import './ui-system.css';
import './inbox-reference.css';
import perm from "@/perm/perm.js";
const pinia = createPinia().use(piniaPersistedState)
import i18n from "@/i18n/index.js";
import {clearLegacyCredentials, watchSessionChanges} from '@/auth/browser.js';
import {authState} from '@/auth/session.js';
import {retireOfflineCache} from '@/auth/offline.js';
import {startApplication} from '@/init/startup.js';
clearLegacyCredentials();
watchSessionChanges();
const app = createApp(App).use(pinia)
await startApplication({
    initialize: async () => { await retireOfflineCache(); await init(); },
    mount() {
        app.use(router).use(i18n).directive('perm', perm);
        app.config.devtools = true;
        app.mount('#app');
    },
    showFailure() {
        authState.clear();
        document.getElementById('loading-first')?.remove();
        const panel = document.createElement('section');
        panel.className = 'startup-error';
        panel.setAttribute('role', 'alert');
        const heading = document.createElement('h1');
        heading.textContent = i18n.global.t('startupUnavailable');
        const message = document.createElement('p');
        message.textContent = i18n.global.t('startupRetryHint');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = i18n.global.t('startupReload');
        retry.addEventListener('click', () => window.location.reload());
        panel.append(heading, message, retry);
        document.title = heading.textContent;
        document.getElementById('app').replaceChildren(panel);
    },
});
