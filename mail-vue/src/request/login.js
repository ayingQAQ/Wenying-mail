import http from '@/axios/index.js';

export function login(email, password) {
    return http.post('/login', {email: email, password: password})
}

export function logout() {
    return http.delete('/logout')
}

export function currentSession() {
    return http.get('/session', { sessionBootstrap: true, noMsg: true })
}

export function loginOptions() { return http.get('/login/options', {noMsg:true}); }
export function startEmailLogin() { return http.post('/login/email/start'); }
