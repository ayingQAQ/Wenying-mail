import axios from 'axios';
import i18n from '@/i18n/index.js';
import { useSettingStore } from '@/store/setting.js';
import { authState, installSessionTransport } from '@/auth/session.js';
import { reloadSession } from '@/auth/browser.js';
import { shouldNotifyRequestFailure } from './request-errors.js';

// The application and API share one origin and secure session cookie.
const http = axios.create({ baseURL: '/api' });
installSessionTransport(http, authState, {
    origin: window.location.origin,
    onExpired: () => reloadSession('/login'),
});
http.interceptors.request.use(config => {
    config.headers['accept-language'] = useSettingStore().lang;
    return config;
});

function showError(data, config, status) {
    if (config?.noMsg) return;
    ElMessage({
        message: data?.message || i18n.global.t('reqFailErrorMsg'),
        type: status === 403 ? 'warning' : 'error',
        plain: true,
        grouping: true,
    });
}
http.interceptors.response.use(response => {
    if (response.config.responseType === 'blob' && response.status === 200) return response.data;
    if (response.data?.code === 200) return response.data.data;
    showError(response.data, response.config, response.data?.code);
    return Promise.reject(response.data);
}, error => {
    // Intentional cancellation and superseded sessions are not request failures.
    if (shouldNotifyRequestFailure(error)) {
        showError(error.response?.data, error.config, error.response?.status);
    }
    return Promise.reject(error);
});
export default http;
