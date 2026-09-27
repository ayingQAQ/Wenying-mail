export const RETIRED_API_PATHS = Object.freeze([
  '/register', '/oss', '/oauth', '/init', '/public', '/webhooks', '/telegram', '/test',
  '/email/send', '/user/resetSendCount', '/regKey', '/analysis',
  '/setting/setBackground', '/setting/deleteBackground',
]);
const permissions = Object.freeze([
  'email:delete', 'my:delete', 'account:query', 'account:add', 'account:delete',
  'user:query', 'user:add', 'user:set-pwd', 'user:set-status', 'user:set-type', 'user:delete',
  'role:query', 'role:add', 'role:set', 'role:delete',
  'all-email:query', 'all-email:delete', 'setting:query', 'setting:set',
]);

export function receiveOnlyPermissions(keys) {
  if (!Array.isArray(keys)) return [];
  return keys.includes('*') ? [...permissions] : [...new Set(keys.filter(key => permissions.includes(key)))];
}
