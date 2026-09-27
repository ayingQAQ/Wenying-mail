// Stop on the first failed request: successful chunks are reconciled immediately,
// and the untouched selection remains available for a deliberate retry.
export async function runMailBatch(ids,work,{size=1,onSuccess=()=>{},isStopped=()=>false}={}) {
 const pending=[...new Set(ids)],done=[];
 for(let index=0;index<pending.length;index+=size){
  if(isStopped())break;
  const chunk=pending.slice(index,index+size);
  try{await work(chunk);}catch{return {done,remaining:pending.filter(id=>!done.includes(id)),failed:true};}
  done.push(...chunk);onSuccess(chunk);
 }
 return {done,remaining:pending.filter(id=>!done.includes(id)),failed:false};
}
