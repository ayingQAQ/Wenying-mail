import {isIP} from 'node:net';
export function privateBindAddress(value='127.0.0.1'){
  if(isIP(value)!==4)throw new Error('INVALID_VPS_BIND_ADDRESS');
  const [a,b]=value.split('.').map(Number);
  if(value!=='127.0.0.1'&&a!==10&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168))throw new Error('INVALID_VPS_BIND_ADDRESS');
  return value;
}
