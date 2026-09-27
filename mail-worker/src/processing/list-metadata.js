import sanitizeHtml from 'sanitize-html';

export function listMetadata(subject, text, html='') {
  const plain=(text?.trim()?text:sanitizeHtml(html.replace(/<\/(?:p|div|tr|h[1-6])\s*>|<br\s*\/?>/gi,' '),{allowedTags:[],allowedAttributes:{}}))
    .replace(/\s+/g,' ').trim();
  const source=[subject,plain].filter(Boolean).join(' ').slice(0,16000);
  const label='(?:验证码|校验码|动态密码|一次性密码|verification\\s+code|security\\s+code|login\\s+code|one[- ]time\\s+(?:code|password)|your\\s+code)';
  const after=new RegExp(label+'[^\\d]{0,24}([0-9]{4,8})(?![0-9])','gi');
  const before=new RegExp('(?<![0-9])([0-9]{4,8})[^\\d]{0,16}(?:is\\s+your\\s+)'+label,'gi');
  const codes=[...new Set([...source.matchAll(after),...source.matchAll(before)].map(m=>m[1]))];
  return {snippet:plain.slice(0,300),code:codes.length===1?codes[0]:''};
}

export async function readListMetadata(bucket,{subject,text,html}) {
  async function read(object) {
    if(!object?.key)return '';
    const stored=await bucket.get(object.key);
    if(!stored)throw new Error('GENERATION_INCOMPLETE');
    if(stored.size>4*1024*1024){await stored.body?.cancel();throw new Error('MIME_LIMIT_EXCEEDED');}
    return stored.text();
  }
  const plain=await read(text);
  return listMetadata(subject,plain,plain.trim()?'':await read(html));
}
