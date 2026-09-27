import setting from '../entity/setting';
import orm from '../entity/orm';
import BizError from '../error/biz-error';
import {settingsView,settingsUpdate} from './receive-only-settings.js';

const settingService = {
  async refresh(c) {
    c.set?.('setting', undefined);
    return this.query(c);
  },
  async query(c) {
    if(c.get?.('setting'))return c.get('setting');
    // D1 remains authoritative; no cached provider secrets decide configuration.
    const rows=await orm(c).select().from(setting).limit(2).all();
    if(rows.length!==1)throw new BizError('INVALID_SETTING_STATE',503);
    const value=rows[0];let domains=c.env.domain;
    try {
      if(typeof domains==='string')domains=JSON.parse(domains);
      value.resendTokens=JSON.parse(value.resendTokens);
    } catch {throw new BizError('INVALID_SETTING_CONFIGURATION',503);}
    if(!Array.isArray(domains)||!domains.length||domains.some(domain=>typeof domain!=='string'||domain.length>253||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))||new Set(domains).size!==domains.length)
      throw new BizError('INVALID_DOMAIN_CONFIGURATION',503);
    if(!value.resendTokens||typeof value.resendTokens!=='object'||Array.isArray(value.resendTokens)||
      Object.values(value.resendTokens).some(token=>typeof token!=='string'))throw new BizError('INVALID_SETTING_CONFIGURATION',503);
    value.domainList=domains.map(domain=>'@'+domain);
    value.projectLink=c.env.project_link!==false&&c.env.project_link!=='false';
    value.emailPrefixFilter=value.emailPrefixFilter.split(',').filter(Boolean);
    // Old settings cannot revive retired integrations or their challenge flows.
    Object.assign(value,{register:1,send:1,registerVerify:1,addEmailVerify:1,forwardStatus:1,tgBotStatus:1,
      webhookStatus:1,linuxdoSwitch:1,githubSwitch:1,googleSwitch:1,aiCode:1,noRecipient:1});
    c.set?.('setting',value);
    return value;
  },
  async get(c) {
    return {...settingsView(await this.query(c),{admin:true,authenticated:!!c.get?.('session')}),
      tgBotStatus:c.env.TELEGRAM_NOTIFICATION?0:1,tgManaged:true};
  },
  async updateAllowed(c,input,blacklist=false) {
    const values=settingsUpdate(input,{blacklist});
    await this.query(c);
    const keys=Object.keys(values),columns=keys.map(key=>key.replace(/[A-Z]/g,char=>'_'+char.toLowerCase()));
    await c.env.db.batch([
      c.env.db.prepare("SELECT CASE WHEN (SELECT count(*) FROM setting)=1 THEN 1 ELSE json('INVALID_SETTING_STATE') END"),
      c.env.db.prepare('UPDATE setting SET '+columns.map(name=>'"'+name+'"=?').join(',')).bind(...keys.map(key=>values[key])),
      c.env.db.prepare("INSERT INTO audit_logs(actor_user_id,action,result_code,created_at) VALUES(?,'setting.changed','RECEIVE_ONLY',unixepoch()*1000)")
        .bind(c.get?.('user')?.userId??null),
    ]);
    await this.refresh(c);
  },
  async set(c,input) {await this.updateAllowed(c,input);},
  async setBlacklist(c,input) {await this.updateAllowed(c,input,true);return this.get(c);},
  async setBackground() {throw new BizError('NOT_FOUND',404);},
  async deleteBackground() {throw new BizError('NOT_FOUND',404);},
  async websiteConfig(c) {
    return settingsView(await this.query(c),{authenticated:!!c.get?.('session')});
  },
};
export default settingService;
