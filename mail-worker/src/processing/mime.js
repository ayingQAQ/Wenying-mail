import PostalMime from 'postal-mime';
import { sanitizeMailHtml, SANITIZER_VERSION } from './html-sanitizer.js';

export const PROCESSOR_VERSION = `mime-v1-postal-2.4.4-${SANITIZER_VERSION}`;
const encoder=new TextEncoder();
function bounded(value, limit) {
  const text=typeof value==='string' ? value : '';
  if (encoder.encode(text).length<=limit) return text;
  let bytes=0, result='';
  for (const character of text) {
    bytes+=encoder.encode(character).length;
    if (bytes>limit) break;
    result+=character;
  }
  return result;
}
export async function parseRawMail(raw) {
  if (!(raw instanceof Uint8Array) || raw.byteLength>25*1024*1024) throw new Error('MIME_LIMIT_EXCEEDED');
  let parsed;
  try { parsed=await PostalMime.parse(raw, {attachmentEncoding:'arraybuffer',forceRfc822Attachments:true}); }
  catch { throw new Error('PARSE_UNKNOWN'); }
  const truncated=[];
  const field=(name,value,max=1024) => {
    const result=bounded(value,max);
    if (typeof value==='string' && result!==value) truncated.push(name);
    return result;
  };
  if (parsed.attachments.length>100 || encoder.encode(parsed.text || '').length>4*1024*1024) throw new Error('MIME_LIMIT_EXCEEDED');
  const headers={headerFrom:parsed.from || null,headerTo:parsed.to || [],cc:parsed.cc || [],bcc:parsed.bcc || []};
  if (encoder.encode(JSON.stringify(headers)).length>64*1024) throw new Error('MIME_LIMIT_EXCEEDED');
  const sanitized=sanitizeMailHtml(parsed.html || '');
  let attachmentBytes=0;
  const attachments=parsed.attachments.map((item,index) => {
    if (!(item.content instanceof ArrayBuffer)) throw new Error('INVALID_MIME');
    attachmentBytes+=item.content.byteLength;
    if (attachmentBytes>25*1024*1024) throw new Error('MIME_LIMIT_EXCEEDED');
    return {partId:`part-${index+1}`,filename:bounded((item.filename || 'attachment').replace(/[\x00-\x1f\x7f/\\]/g,'_'),255),
      mimeType:bounded(item.mimeType,128),disposition:item.disposition,
      contentId:bounded(item.contentId || '',254),content:item.content};
  });
  return {...headers,subject:field('subject',parsed.subject),messageId:field('messageId',parsed.messageId),
    inReplyTo:field('inReplyTo',parsed.inReplyTo),text:parsed.text || '',html:sanitized.html,
    images:sanitized.images,attachments,truncated};
}
