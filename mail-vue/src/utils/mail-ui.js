// Only recognize codes near explicit verification wording, never arbitrary numbers.
export function verificationCode(mail = {}, plainText = '') {
  if (/^[A-Za-z0-9-]{4,12}$/.test(String(mail.code || ''))) return String(mail.code);
  const source = [mail.subject, mail.listText || mail.text, plainText].filter(Boolean).join('\n').slice(0, 16000);
  const label = '(?:验证码|校验码|动态密码|一次性密码|verification\\s+code|security\\s+code|login\\s+code|one[- ]time\\s+(?:code|password)|your\\s+code)';
  const after = new RegExp(label + '[^\\n\\d]{0,24}([0-9]{4,8})(?![0-9])', 'gi');
  const before = new RegExp('(?<![0-9])([0-9]{4,8})[^\\n\\d]{0,16}(?:is\\s+your\\s+)' + label, 'gi');
  const matches = [...source.matchAll(after), ...source.matchAll(before)].map(m => m[1]);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : '';
}

export function mailboxAddress(prefix, domain) {
  const local = String(prefix || '').trim().toLowerCase();
  const host = String(domain || '').replace(/^@/, '').toLowerCase();
  if (!local || local.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(local)) return '';
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(host)) return '';
  return `${local}@${host}`;
}
