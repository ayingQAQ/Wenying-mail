import { useUserStore } from '@/store/user.js';
import { useSettingStore } from '@/store/setting.js';
import { useAccountStore } from '@/store/account.js';
import { loginUserInfo } from '@/request/my.js';
import { currentSession } from '@/request/login.js';
import { authState } from '@/auth/session.js';
import { permsToRouter } from '@/perm/perm.js';
import router from '@/router';
import { websiteConfig } from '@/request/setting.js';
import {accountList} from '@/request/account.js';
import i18n from '@/i18n/index.js';

export async function init() {
    document.title = 'Wengying mail';
    const settingStore = useSettingStore();
    if (!settingStore.lang) settingStore.lang = navigator.language.startsWith('zh') ? 'zh' : 'en';
    i18n.global.locale.value = settingStore.lang;

    // Both are read-only bootstrap requests. Wait for both before changing the
    // auth generation, otherwise the public config response becomes stale.
    const [sessionResult, configResult] = await Promise.allSettled([
        currentSession(), websiteConfig(),
    ]);
    if (sessionResult.status === 'fulfilled') {
        authState.accept(sessionResult.value);
    } else {
        const error = sessionResult.reason;
        if (error.response?.status !== 401) throw error;
        authState.clear();
    }
    if (configResult.status === 'rejected') throw configResult.reason;
    const setting = configResult.value;
    setting.title = 'Wengying mail';
    settingStore.settings = setting;
    settingStore.domainList = setting.domainList;
    document.title = setting.title;

    if (authState.authenticated) {
        const user = await loginUserInfo();
        const accountStore = useAccountStore();
        accountStore.currentAccountId = user.account?.accountId ?? 0;
        accountStore.currentAccount = user.account ?? {};
        useUserStore().user = user;
        const saved = accountStore.selectionByUser[String(user.userId)];
        accountStore.allMailboxes = saved?.all === true;
        if (saved?.id && saved.id !== accountStore.currentAccountId) {
            let cursor = 0, lastSort;
            while (true) {
                const page = await accountList(cursor, 30, lastSort);
                const found = page.find(row => row.accountId === saved.id);
                if (found) {accountStore.currentAccount = found; accountStore.currentAccountId = found.accountId; break;}
                if (page.length < 30 || page.at(-1).accountId === cursor) break;
                cursor = page.at(-1).accountId; lastSort = page.at(-1).sort;
            }
        }
        permsToRouter(user.permKeys).forEach(route => router.addRoute('layout', route));
    }
}
