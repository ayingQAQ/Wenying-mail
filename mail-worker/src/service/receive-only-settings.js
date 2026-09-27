import BizError from '../error/biz-error.js';

const publicFields=['title','manyEmail','addEmail','autoRefresh','loginOpacity','loginDomain','minEmailPrefix','projectLink'];
const administrativeFields=['emailPrefixFilter','blackSubject','blackContent','blackFrom'];
export function settingsView(value,{admin=false,authenticated=false}={}){
  const result=Object.fromEntries([...publicFields,...(admin?administrativeFields:[])].map(key=>[key,value[key]]));
  return {...result,domainList:!authenticated&&value.loginDomain===1?[]:value.domainList,
    register:1,send:1,registerVerify:1,addEmailVerify:1,regKey:1,regVerifyOpen:false,addVerifyOpen:false,
    r2Domain:'',siteKey:null,background:'',notice:0,linuxdoSwitch:1,githubSwitch:1,googleSwitch:1};
}
export function settingsUpdate(input,{blacklist=false}={}){
  const fail=()=>{throw new BizError('INVALID_SETTING_UPDATE',400);};
  const fields=blacklist?['blackSubject','blackContent','blackFrom']:
    ['title','manyEmail','addEmail','autoRefresh','loginOpacity','loginDomain','minEmailPrefix','emailPrefixFilter'];
  if(!input||typeof input!=='object'||Array.isArray(input)||!Object.keys(input).length||Object.keys(input).some(key=>!fields.includes(key)))fail();
  const result={};
  for(const [key,value] of Object.entries(input)){
    if(['manyEmail','addEmail','loginDomain'].includes(key)){if(![0,1].includes(value))fail();}
    else if(key==='autoRefresh'){if(!Number.isInteger(value)||value<0||value>3600)fail();}
    else if(key==='minEmailPrefix'){if(!Number.isInteger(value)||value<0||value>64)fail();}
    else if(key==='loginOpacity'){if(typeof value!=='number'||!Number.isFinite(value)||value<0.2||value>1)fail();}
    else if(key==='emailPrefixFilter'){
      if(!Array.isArray(value)||value.length>100||value.some(item=>typeof item!=='string'||!item.length||item.length>64||!item.isWellFormed()||/[\x00-\x1f\x7f,]/.test(item)))fail();
      result[key]=[...new Set(value)].join(',');continue;
    } else if(typeof value!=='string'||value.length>(key==='title'?120:4096)||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||!value.isWellFormed())fail();
    result[key]=value;
  }
  return result;
}
