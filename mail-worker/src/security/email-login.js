import {verifyAccess} from './access.js';
import {createSession,readSession,revokeSession} from './session.js';
import {sessionSubject} from './application-auth.js';

export const EMAIL_LOGIN_PATHS = ['/api/login/options','/api/login/email/start','/api/login/access/callback'];
const FLOW_COOKIE='__Host-cloudmail_login';
const lifetime=10*60*1000;
const clearFlow=`${FLOW_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const json=(code,status,data)=>Response.json({code,...(data?{data}:{})},{status,headers});

function configured(env){
  return env.MAIL_AUTH_MODE==='either' && typeof env.admin==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.admin)
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN??'')
    && typeof env.ACCESS_AUD==='string' && !!env.ACCESS_AUD.trim();
}
function validFlow(request){
  const url=new URL(request.url),states=url.searchParams.getAll('state');
  const cookies=(request.headers.get('Cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(FLOW_COOKIE+'='));
  if(states.length!==1||cookies.length!==1||cookies[0].slice(FLOW_COOKIE.length+1)!==states[0])return false;
  const match=/^[A-Za-z0-9_-]{43}\.([0-9]{13})$/.exec(states[0]);
  return !!match && Number(match[1])<=Date.now() && Date.now()-Number(match[1])<lifetime;
}
function finish(location,session){
  const response=new Response(null,{status:303,headers:{...headers,Location:location}});
  response.headers.append('Set-Cookie',clearFlow);
  if(session)response.headers.append('Set-Cookie',session.cookie);
  return response;
}

// These are the only unauthenticated application login routes. The callback
// still verifies the signed Access assertion, nonce cookie, allowlist and DB user.
export async function emailLogin(request,env){
  const path=new URL(request.url).pathname;
  if(path===EMAIL_LOGIN_PATHS[0])return request.method==='GET'
    ?json(200,200,{emailCode:configured(env)}):json('METHOD_NOT_ALLOWED',405);
  if(!configured(env))return json('EMAIL_LOGIN_NOT_CONFIGURED',503);
  if(path===EMAIL_LOGIN_PATHS[1]){
    if(request.method!=='POST')return json('METHOD_NOT_ALLOWED',405);
    if(request.headers.get('Origin')!==env.APP_ORIGIN)return json('ORIGIN_NOT_ALLOWED',403);
    const nonce=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const state=`${nonce}.${Date.now()}`;
    const response=json(200,200,{url:`${EMAIL_LOGIN_PATHS[2]}?state=${state}`});
    response.headers.append('Set-Cookie',`${FLOW_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
    return response;
  }
  if(request.method!=='GET')return json('METHOD_NOT_ALLOWED',405);
  if(!validFlow(request))return finish('/login?emailLogin=failed');
  try{
    const access=await verifyAccess(request,env);
    const email=access.identity?.email;
    if(access.response||typeof email!=='string'||email.toLowerCase()!==env.admin.toLowerCase())return finish('/login?emailLogin=failed');
    const user=await env.db.prepare('SELECT user_id AS userId,email,password,salt,status,is_del AS isDel FROM user WHERE email=? COLLATE NOCASE AND status=0 AND is_del=0 AND retired_at IS NULL').bind(email).first();
    if(!user)return finish('/login?emailLogin=failed');
    const subject=sessionSubject(env),previous=await readSession(env.db,request,subject);
    const session=await createSession(env.db,user,subject);
    if(previous)await revokeSession(env.db,previous.tokenHash,'ROTATED');
    return finish('/inbox',session);
  }catch{return finish('/login?emailLogin=failed');}
}
