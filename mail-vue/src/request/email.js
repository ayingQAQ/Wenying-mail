import http from '@/axios/index.js';

export function emailList(accountId, allReceive, emailId, timeSort, size, type, full) {
    return http.get('/email/list', {params: {accountId, allReceive, emailId, timeSort, size, type, full,
        includeSummary: Number(emailId) > 0 ? 0 : 1}})
}

export function emailDelete(emailIds) {
    return http.delete('/email/delete?emailIds=' + emailIds)
}

export function emailLatest(emailId, accountId, allReceive) {
    return http.get('/email/latest', {params: {emailId, accountId, allReceive}, noMsg: true, timeout: 35 * 1000})
}

export function emailRead(emailIds) {
    return http.put('/email/read', {emailIds})
}

export function emailSend(form,progress) {
    return http.post('/email/send', form,{
        onUploadProgress: (e) => {
            progress(e)
        },
        noMsg: true
    })
}
export const emailDetail = (id, signal) => http.get(`/email/${id}`, {signal});
export const emailBody = (id, format, signal) => http.get(`/email/${id}/body`, {params: {format}, signal});
export const emailInline = (id, signal) => http.get(`/attachment/${id}/inline`, {responseType: 'blob', signal, noMsg: true});

export const emailTrashList = (before, signal) => http.get('/email/trash', {params: {before, limit: 30}, signal});
export const emailRestore = id => http.post(`/email/${id}/restore`);

export const emailPermanentDelete = id => http.delete(`/email/${id}/permanent`);
export const emailDeletionStatus = signal => http.get('/email/deletions', {signal});
export const emailTrashPolicy = signal => http.get('/email/trash-policy', {signal});
