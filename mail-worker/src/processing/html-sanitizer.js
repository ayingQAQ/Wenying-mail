import sanitizeHtml from 'sanitize-html';

export const SANITIZER_VERSION = 'mail-html-v2-sanitize-2.17.7';
function safeUrl(value, protocols) {
  if (typeof value !== 'string' || value.length>2048 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url=new URL(value);
    return protocols.includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function contentId(value) {
  if (typeof value!=='string' || !/^cid:/i.test(value)) return null;
  try {
    const decoded=decodeURIComponent(value.slice(4));
    return /^[\x21-\x7e]{1,254}$/.test(decoded) ? decoded:null;
  } catch { return null; }
}
export function sanitizeMailHtml(source,{resolveLegacyImage=()=>null}={}) {
  if (typeof source!=='string' || new TextEncoder().encode(source).length>4*1024*1024) throw new Error('MIME_LIMIT_EXCEEDED');
  const images=[];
  const html=sanitizeHtml(source, {
    allowedTags:['p','div','span','br','hr','b','strong','i','em','u','s','blockquote','pre','code','ul','ol','li','table','thead','tbody','tfoot','tr','td','th','caption','h1','h2','h3','h4','h5','h6','a','img'],
    allowedAttributes:{a:['href','target','rel'],img:['alt','data-mail-image'],td:['colspan','rowspan'],th:['colspan','rowspan']},
    allowedSchemes:['https','http','mailto'],allowProtocolRelative:false,
    nonTextTags:['style','script','textarea','option','xmp','noscript','svg','math','iframe','object','embed','form','template'],
    nestingLimit:100,
    transformTags:{
      a(tag,attrs) {
        const href=safeUrl(attrs.href,['https:','http:','mailto:']);
        return {tagName:'a',attribs:href ? {href,target:'_blank',rel:'noopener noreferrer'} : {}};
      },
      img(tag,attrs) {
        const attribs={alt:(attrs.alt || '').slice(0,256)};
        const legacy=resolveLegacyImage(attrs.src);
        const remote=legacy ? null:safeUrl(attrs.src,['https:']);
        const cid=legacy || contentId(attrs.src);
        if (remote || cid) {
          if (images.length>=200) throw new Error('MIME_LIMIT_EXCEEDED');
          const id=`image-${images.length+1}`;
          images.push({id,kind:remote ? 'remote':'cid',source:remote || cid});
          attribs['data-mail-image']=id;
        }
        return {tagName:'img',attribs};
      },
    },
  });
  // Link safety attributes and HTML escaping can expand a valid-size source.
  // Every published body must remain within the private content read limit.
  if (new TextEncoder().encode(html).length>4*1024*1024) throw new Error('MIME_LIMIT_EXCEEDED');
  return {html,images};
}
