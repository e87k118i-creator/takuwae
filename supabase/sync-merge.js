/* Pure three-way reconciliation. Never contacts a server or overwrites storage. */
import {encodeRecords,decodeRecords} from './sync-model.js';
export const canonical=v=>JSON.stringify(v,(_k,p)=>p&&typeof p==='object'&&!Array.isArray(p)
  ? Object.fromEntries(Object.keys(p).sort().map(k=>[k,p[k]])):p);
const equal=(a,b)=>canonical(a)===canonical(b);
const copy=v=>v===undefined?undefined:structuredClone(v);
export function mergeLedger(baseDb,localDb,remoteDb) {
  const maps=[baseDb,localDb,remoteDb].map(encodeRecords);
  const result=new Map(),conflicts=[];
  for(const key of new Set(maps.flatMap(m=>[...m.keys()]))) {
    if(key==='setting:global') continue;
    const [b,l,r]=maps.map(m=>m.get(key));
    if(equal(l,b)) {if(r) result.set(key,copy(r));}
    else if(equal(r,b)||equal(l,r)) {if(l) result.set(key,copy(l));}
    else conflicts.push(key);
  }
  const [bs,ls,rs]=maps.map(m=>m.get('setting:global').payload);
  const settings={};
  for(const k of new Set([...Object.keys(bs),...Object.keys(ls),...Object.keys(rs)])) {
    if(k==='__sync_order') continue;
    const [b,l,r]=[bs[k],ls[k],rs[k]];
    const value=equal(l,b)?r:equal(r,b)||equal(l,r)?l:undefined;
    if(!equal(l,b)&&!equal(r,b)&&!equal(l,r)) conflicts.push('setting:'+k);
    if(value!==undefined) settings[k]=copy(value);
  }
  const order={};
  for(const [field,type] of [['tx','transaction'],['bills','bill'],['fundCategories','fund']]) {
    const alive=new Set([...result.values()].filter(x=>x.entity_type===type).map(x=>x.entity_id));
    const [b,l,r]=[baseDb,localDb,remoteDb].map(d=>d[field].map(x=>x.id).filter(id=>alive.has(id)));
    const old=new Set(b);
    const common=b.filter(id=>l.includes(id)&&r.includes(id));
    const commonSet=new Set(common);
    const lc=l.filter(id=>commonSet.has(id)),rc=r.filter(id=>commonSet.has(id));
    const changedL=!equal(lc,common),changedR=!equal(rc,common);
    if(changedL&&changedR&&!equal(lc,rc)) conflicts.push('order:'+field);
    // Preserve exact one-sided ordering; concurrent independent additions use a
    // deterministic ID order before the surviving existing sequence.
    let ids;
    if(equal(l,b)) ids=r;
    else if(equal(r,b)||equal(l,r)) ids=l;
    else {
      const additions=[...alive].filter(id=>!old.has(id)).sort();
      const preferred=changedL?l:r;
      ids=[...additions,...preferred.filter(id=>old.has(id))];
    }
    order[field]=[...new Set([...ids,...[...alive].sort()])];
  }
  if(conflicts.length) return {status:'conflict',conflicts};
  settings.__sync_order=order;
  result.set('setting:global',{entity_type:'setting',entity_id:'global',payload:settings});
  return {status:'merged',db:decodeRecords([...result.values()])};
}
