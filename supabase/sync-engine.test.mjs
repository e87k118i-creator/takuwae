import test from 'node:test';
import assert from 'node:assert/strict';
import {makeSyncEngine} from './sync-engine.js';
import {encodeRecords,decodeRecords,diffRecords} from './sync-model.js';
import {MIGRATION_CONFIRMATION} from './first-import.js';
import {mergeLedger} from './sync-merge.js';
const owner='550e8400-e29b-41d4-a716-446655440000';
const initial=()=>({initial:{s1:5000,r:1000},fundInitial:{repair:0},fundCategories:[{id:'repair',name:'修理',goal:10000}],bills:[],months:{},tx:[],monthly:30000,bonus:0,payday:25,weeklyBuffer:0});
const transaction=(id,amount=100)=>({id,date:'2026-11-22',kind:'income',to:'s1',amount});
const copy=v=>structuredClone(v);
function setup({empty=false}={}) {
 let rows=empty?[]:[...encodeRecords(initial()).values()].map(r=>({...r,revision:1,deleted_at:null}));
 const receipts=new Map(),calls=[];let offline=false,drop=false,beforeApply=null;
 const transport={
  async fetchRows(){if(offline)throw Error('offline');return copy(rows)},
  async applyBatch(batch){
   calls.push(copy(batch));if(offline)throw Error('offline');
   if(beforeApply){const fn=beforeApply;beforeApply=null;await fn()}
   if(receipts.has(batch.batchId))return copy(receipts.get(batch.batchId));
   const get=op=>rows.find(r=>r.entity_type===op.entity_type&&r.entity_id===op.entity_id);
   const conflicts=batch.operations.filter(op=>(get(op)?.revision??null)!==op.expected_revision);
   if(conflicts.length)return {status:'conflict',conflicts:copy(conflicts)};
   const records=batch.operations.map(op=>{
    const old=get(op),next={entity_type:op.entity_type,entity_id:op.entity_id,payload:copy(op.payload),revision:(old?.revision??0)+1,deleted_at:op.deleted?'deleted':null};
    if(old)rows[rows.indexOf(old)]=next;else rows.push(next);
    return {entity_type:op.entity_type,entity_id:op.entity_id,revision:next.revision,deleted:op.deleted};
   });
   const result={status:'applied',records};receipts.set(batch.batchId,copy(result));
   if(drop){drop=false;throw Error('response lost after commit')}
   return result;
  }
 };
 let id=0;
 function device() {
  const data=new Map();let quota=false;
  const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>{if(quota)throw Error('quota');data.set(k,v)}};
  // Serialize both local edits and network operations, just like Web Locks.
  let tail=Promise.resolve();const withLock=(_name,fn)=>{const next=tail.then(fn);tail=next.catch(()=>{});return next};
  const create=()=>makeSyncEngine({storage,ownerId:owner,transport,withLock,randomUUID:()=>`550e8400-e29b-41d4-a716-${String(++id).padStart(12,'0')}`});
  return {engine:create(),create,data,storage,setQuota:v=>quota=v};
 }
 return {device,transport,calls,get rows(){return copy(rows)},setRows:r=>rows=copy(r),setOffline:v=>offline=v,dropResponse:()=>drop=true,beforeApply:fn=>beforeApply=fn};
}
test('uninitialized device never uploads an empty ledger; receive requires confirmation',async()=>{
 const env=setup({empty:true}),d=env.device();
 await assert.rejects(d.engine.receiveInitial(),/確認/);
 await assert.rejects(d.engine.receiveInitial({confirmReceive:true}),/空/);
 await assert.rejects(d.engine.sync(),/初回/);assert.equal(env.calls.length,0);assert.equal(d.data.size,0);
});
test('iPad receives only, and protects an already initialized local ledger',async()=>{
 const env=setup(),d=env.device();
 assert.equal((await d.engine.receiveInitial({confirmReceive:true})).status,'received');
 assert.equal(env.calls.length,0);assert.equal(d.engine.snapshot().localDb.initial.s1,5000);
 await assert.rejects(d.engine.receiveInitial({confirmReceive:true}),/上書き/);
});
test('explicit initial import preparation does not write server, survives reload then verifies',async()=>{
 const env=setup({empty:true}),d=env.device();
 await assert.rejects(d.engine.prepareInitialImport({localDb:initial()}),/バックアップ/);
 const result=await d.engine.prepareInitialImport({localDb:initial(),confirmation:MIGRATION_CONFIRMATION,hasExternalBackup:true});
 assert.equal(result.status,'prepared');assert.equal(env.calls.length,0);assert.equal(env.rows.length,0);
 const reloaded=d.create();assert.ok(reloaded.snapshot().pending);
 assert.equal((await reloaded.sync()).status,'synced');assert.deepEqual(decodeRecords(env.rows),initial());
 assert.equal(reloaded.snapshot().pending,null);
});
test('two devices add independently, both transactions survive after convergence',async()=>{
 const env=setup(),a=env.device().engine,b=env.device().engine;
 await a.receiveInitial({confirmReceive:true});await b.receiveInitial({confirmReceive:true});
 const da=a.snapshot().localDb,db=b.snapshot().localDb;
 da.tx.unshift(transaction('phone',300));db.tx.unshift(transaction('tablet',500));
 await a.saveLocal(da,{expectedLocalDb:a.snapshot().localDb});await b.saveLocal(db,{expectedLocalDb:b.snapshot().localDb});
 assert.equal((await a.sync()).status,'synced');assert.equal((await b.sync()).status,'synced');
 await a.sync();assert.deepEqual(a.snapshot().localDb,b.snapshot().localDb);
 assert.equal(a.snapshot().localDb.tx.length,2);assert.equal(a.snapshot().localDb.initial.s1,5000);
});
test('same record changes on two devices stop without overwriting either edit',async()=>{
 const env=setup(),a=env.device().engine,b=env.device().engine;
 await a.receiveInitial({confirmReceive:true});await b.receiveInitial({confirmReceive:true});
 const da=a.snapshot().localDb,db=b.snapshot().localDb;da.weeklyBuffer=100;db.weeklyBuffer=200;
 await a.saveLocal(da,{expectedLocalDb:a.snapshot().localDb});await b.saveLocal(db,{expectedLocalDb:b.snapshot().localDb});await a.sync();
 assert.equal((await b.sync()).status,'conflict');assert.equal(b.snapshot().localDb.weeklyBuffer,200);
 assert.equal(decodeRecords(env.rows).weeklyBuffer,100);
 const calls=env.calls.length;await b.sync();assert.equal(env.calls.length,calls);
 await assert.rejects(b.saveLocal(db,{expectedLocalDb:b.snapshot().localDb}),/競合/);
});
test('lost successful response retries exact batch ID and operations after restart',async()=>{
 const env=setup(),d=env.device(),a=d.engine;await a.receiveInitial({confirmReceive:true});
 const db=a.snapshot().localDb;db.tx.push(transaction('once'));await a.saveLocal(db,{expectedLocalDb:a.snapshot().localDb});env.dropResponse();
 assert.equal((await a.sync()).status,'retry_later');const request=copy(env.calls[0]);
 const restored=d.create();assert.equal((await restored.sync()).status,'synced');
 assert.deepEqual(env.calls[1],request);assert.equal(decodeRecords(env.rows).tx.length,1);
});
test('new edits after lost response are retained and receive fresh revisions',async()=>{
 const env=setup(),a=env.device().engine;await a.receiveInitial({confirmReceive:true});
 const db=a.snapshot().localDb;db.weeklyBuffer=100;await a.saveLocal(db,{expectedLocalDb:a.snapshot().localDb});env.dropResponse();await a.sync();
 db.weeklyBuffer=200;await a.saveLocal(db,{expectedLocalDb:a.snapshot().localDb});await a.sync();
 assert.equal(decodeRecords(env.rows).weeklyBuffer,200);assert.equal(a.snapshot().localDb.weeklyBuffer,200);
 assert.equal(env.calls.length,3);assert.equal(env.calls[2].operations[0].expected_revision,2);
});
test('offline edits survive process restart without changing legacy storage',async()=>{
 const env=setup(),d=env.device();d.storage.setItem('takuwae-v1','sentinel');
 await d.engine.receiveInitial({confirmReceive:true});const db=d.engine.snapshot().localDb;
 db.tx.push(transaction('offline'));await d.engine.saveLocal(db,{expectedLocalDb:d.engine.snapshot().localDb});env.setOffline(true);
 assert.equal((await d.engine.sync()).status,'retry_later');assert.equal(d.create().snapshot().localDb.tx.length,1);
 env.setOffline(false);await d.create().sync();assert.equal(decodeRecords(env.rows).tx.length,1);
 assert.equal(d.storage.getItem('takuwae-v1'),'sentinel');
});
test('storage quota before staging prevents all network writes',async()=>{
 const env=setup(),d=env.device();await d.engine.receiveInitial({confirmReceive:true});
 const db=d.engine.snapshot().localDb;db.tx.push(transaction('quota'));await d.engine.saveLocal(db,{expectedLocalDb:d.engine.snapshot().localDb});
 d.setQuota(true);await assert.rejects(d.engine.sync(),/quota/);assert.equal(env.calls.length,0);
});
test('storage failure after server acknowledgement preserves retry receipt on disk',async()=>{
 const env=setup(),d=env.device();await d.engine.receiveInitial({confirmReceive:true});
 const db=d.engine.snapshot().localDb;db.tx.push(transaction('ack'));await d.engine.saveLocal(db,{expectedLocalDb:d.engine.snapshot().localDb});
 env.beforeApply(()=>d.setQuota(true));await assert.rejects(d.engine.sync(),/quota/);
 assert.ok(d.engine.snapshot().pending);d.setQuota(false);await d.create().sync();
 assert.equal(env.calls[0].batchId,env.calls[1].batchId);assert.equal(decodeRecords(env.rows).tx.length,1);
});
test('revision race stops whole batch atomically',async()=>{
 const env=setup(),d=env.device();await d.engine.receiveInitial({confirmReceive:true});
 const db=d.engine.snapshot().localDb;db.tx.push(transaction('race'));await d.engine.saveLocal(db,{expectedLocalDb:d.engine.snapshot().localDb});
 env.beforeApply(()=>env.setRows(env.rows.map(r=>r.entity_type==='setting'?{...r,revision:2}:r)));
 assert.equal((await d.engine.sync()).status,'conflict');assert.equal(decodeRecords(env.rows).tx.length,0);
 assert.ok(d.engine.snapshot().pending);assert.equal(d.engine.snapshot().localDb.tx.length,1);
});
test('bad revisions and owner mismatch fail closed on first receive',async()=>{
 const env=setup(),d=env.device();env.setRows(env.rows.map(r=>({...r,revision:0})));
 await assert.rejects(d.engine.receiveInitial({confirmReceive:true}),/版番号/);
 const env2=setup(),d2=env2.device();env2.setRows(env2.rows.map(r=>({...r,owner_id:'different'})));
 await assert.rejects(d2.engine.receiveInitial({confirmReceive:true}),/別のユーザー/);
});
test('corrupted state is never reset or overwritten',async()=>{
 const env=setup(),d=env.device();d.data.set(d.engine.key,'{broken');
 await assert.rejects(d.engine.receiveInitial({confirmReceive:true}),/破損/);
 assert.equal(d.data.get(d.engine.key),'{broken');assert.equal(env.calls.length,0);
});
test('delete sync uses tombstone; repeated sync does not issue another delete; resurrection uses current revision',async()=>{
 const db=initial();db.tx.push(transaction('delete'));const rows=[...encodeRecords(db).values()].map(r=>({...r,revision:1}));
 const env=setup();env.setRows(rows);const d=env.device().engine;await d.receiveInitial({confirmReceive:true});
 const deleted=d.snapshot().localDb;deleted.tx=[];await d.saveLocal(deleted,{expectedLocalDb:d.snapshot().localDb});await d.sync();
 const calls=env.calls.length;await d.sync();assert.equal(env.calls.length,calls);
 await d.saveLocal(db,{expectedLocalDb:d.snapshot().localDb});await d.sync();assert.equal(decodeRecords(env.rows).tx.length,1);
 assert.equal(env.rows.find(r=>r.entity_id==='delete').revision,3);
});
test('sync entrypoints serialize concurrent requests',async()=>{
 const env=setup(),d=env.device().engine;await d.receiveInitial({confirmReceive:true});
 const db=d.snapshot().localDb;db.tx.push(transaction('serialized'));await d.saveLocal(db,{expectedLocalDb:d.snapshot().localDb});
 await Promise.all([d.sync(),d.sync()]);assert.equal(env.calls.length,1);
});
test('unsupported server rows and mismatched payload IDs are rejected',()=>{
 const rows=[...encodeRecords(initial()).values()];
 assert.throws(()=>decodeRecords([...rows,{entity_type:'closing',entity_id:'x',payload:{}}]),/未対応/);
 assert.throws(()=>decodeRecords([...rows,{entity_type:'transaction',entity_id:'a',payload:transaction('b')}]),/一致/);
});
test('deletion versus concurrent edit is a conflict, never a silent resurrection',()=>{
 const base=initial();base.tx=[transaction('shared')];
 const local=copy(base),remote=copy(base);local.tx=[];remote.tx[0].amount=999;
 assert.equal(mergeLedger(base,local,remote).status,'conflict');
});
test('manual conflict resolution requires backups and rejects cloud changes after review',async()=>{
 const env=setup(),a=env.device().engine,b=env.device().engine;
 await a.receiveInitial({confirmReceive:true});await b.receiveInitial({confirmReceive:true});
 const da=a.snapshot().localDb,db=b.snapshot().localDb;da.weeklyBuffer=1;db.weeklyBuffer=2;
 await a.saveLocal(da,{expectedLocalDb:a.snapshot().localDb});await b.saveLocal(db,{expectedLocalDb:b.snapshot().localDb});await a.sync();await b.sync();
 const review=await b.previewConflict();
 await assert.rejects(b.resolveConflict({resolvedDb:db}),/退避/);
 const resolve={resolvedDb:db,expectedRemoteRows:review.remoteRows,hasExternalBackup:true,confirmation:'退避後に競合を解決する'};
 env.setRows(env.rows.map(r=>r.entity_type==='setting'?{...r,revision:r.revision+1}:r));
 await assert.rejects(b.resolveConflict(resolve),/確認後/);assert.ok(b.snapshot().conflict);
 const updated=await b.previewConflict();const calls=env.calls.length;
 await b.resolveConflict({...resolve,expectedRemoteRows:updated.remoteRows});assert.equal(env.calls.length,calls);
 await b.sync();assert.equal(decodeRecords(env.rows).weeklyBuffer,2);
});
test('an incorrect applied reply never acknowledges or discards the journal',async()=>{
 const env=setup(),d=env.device();await d.engine.receiveInitial({confirmReceive:true});
 const db=d.engine.snapshot().localDb;db.tx.push(transaction('invalid-reply'));await d.engine.saveLocal(db,{expectedLocalDb:d.engine.snapshot().localDb});
 const apply=env.transport.applyBatch;env.transport.applyBatch=async()=>({status:'applied',records:[]});
 assert.equal((await d.engine.sync()).status,'retry_later');assert.ok(d.engine.snapshot().pending);
 env.transport.applyBatch=apply;await d.engine.sync();assert.equal(decodeRecords(env.rows).tx.length,1);
});
test('a corrupted immutable request is rejected without server writes',async()=>{
 const env=setup(),d=env.device();await d.engine.receiveInitial({confirmReceive:true});
 const db=d.engine.snapshot().localDb;db.weeklyBuffer=1;await d.engine.saveLocal(db,{expectedLocalDb:d.engine.snapshot().localDb});env.dropResponse();await d.engine.sync();
 const saved=JSON.parse(d.storage.getItem(d.engine.key));saved.pending.operations[0].payload.weeklyBuffer=999;
 d.storage.setItem(d.engine.key,JSON.stringify(saved));const calls=env.calls.length;
 await assert.rejects(d.create().sync(),/一致しません/);assert.equal(env.calls.length,calls);
});
test('an over-limit financial action is retained locally and never split into partial writes',async()=>{
 const env=setup(),d=env.device().engine;await d.receiveInitial({confirmReceive:true});
 const db=d.snapshot().localDb;db.tx=Array.from({length:250},(_,i)=>transaction('bulk-'+i));await d.saveLocal(db,{expectedLocalDb:d.snapshot().localDb});
 await assert.rejects(d.sync(),/上限/);assert.equal(env.calls.length,0);assert.equal(d.snapshot().localDb.tx.length,250);
});
test('initial upload remains stopped if server payload verification fails',async()=>{
 const env=setup({empty:true}),d=env.device().engine;
 await d.prepareInitialImport({localDb:initial(),confirmation:MIGRATION_CONFIRMATION,hasExternalBackup:true});
 const fetch=env.transport.fetchRows;env.transport.fetchRows=async()=>{
  const rows=await fetch();return rows.map(r=>r.entity_type==='setting'?{...r,payload:{...r.payload,weeklyBuffer:987}}:r);
 };
 assert.equal((await d.sync()).status,'conflict');assert.equal(d.snapshot().conflict.kind,'initial_verification');
 assert.equal(d.snapshot().localDb.weeklyBuffer,0);
});
test('compound transfer and saving retain exact ledger values on both devices',async()=>{
 const env=setup(),a=env.device().engine,b=env.device().engine;
 await a.receiveInitial({confirmReceive:true});await b.receiveInitial({confirmReceive:true});
 const db=a.snapshot().localDb;
 db.tx=[{id:'move',kind:'transfer',date:'2026-11-22',from:'s1',to:'r',amount:500},
  {id:'fund',kind:'saving',date:'2026-11-22',from:'s1',to:'s2',purpose:'repair',amount:1000},
  {id:'spend',kind:'expense',date:'2026-11-22',from:'r',amount:200,settled:true}];
 db.savingMonths={'2026-10':'zero'};
 await a.saveLocal(db,{expectedLocalDb:a.snapshot().localDb});await a.sync();await b.sync();assert.deepEqual(b.snapshot().localDb,db);
 const restored=b.snapshot().localDb;const balance={...restored.initial};
 for(const t of restored.tx){if(t.kind==='expense')balance[t.from]-=t.amount;else{balance[t.from]-=t.amount;balance[t.to]=(balance[t.to]||0)+t.amount}}
 assert.deepEqual(balance,{s1:3500,r:1300,s2:1000});
 assert.equal(restored.savingMonths['2026-10'],'zero');
});
test('stale form snapshots cannot overwrite a later local edit',async()=>{
 const env=setup(),d=env.device().engine;await d.receiveInitial({confirmReceive:true});
 const old=d.snapshot().localDb,next=copy(old);next.weeklyBuffer=10;
 await d.edit(db=>{db.tx.push(transaction('other-tab'));});
 await assert.rejects(d.saveLocal(next,{expectedLocalDb:old}),/ローカルデータが変更/);
 assert.equal(d.snapshot().localDb.tx.length,1);assert.equal(d.snapshot().localDb.weeklyBuffer,0);
});
test('simultaneous local edits serialize from the latest durable value',async()=>{
 const env=setup(),d=env.device().engine;await d.receiveInitial({confirmReceive:true});
 await Promise.all([d.edit(db=>{db.tx.push(transaction('tab-a'))}),d.edit(db=>{db.tx.push(transaction('tab-b'))})]);
 assert.equal(d.snapshot().localDb.tx.length,2);await d.sync();assert.equal(decodeRecords(env.rows).tx.length,2);
});
