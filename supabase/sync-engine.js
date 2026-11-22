/**
 * Development controller. Transport, storage and exclusive lock MUST be
 * injected. Importing this module performs no I/O; production is not wired.
 * One durable journal stores baseline + local edits + immutable request as a
 * single atomic storage value. Never reads or writes the legacy ledger key.
 */
import {encodeRecords,decodeRecords,diffRecords,validateTakuwae,TYPES} from './sync-model.js';
import {mergeLedger,canonical} from './sync-merge.js';
import {inspectFirstImport,MIGRATION_CONFIRMATION} from './first-import.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const keyOf=r=>r.entity_type+':'+r.entity_id;
const clone=v=>structuredClone(v);
function checkedRows(rows) {
  if(!Array.isArray(rows)) throw Error('受信した記録が不正です');
  const seen=new Set();
  for(const r of rows) {
    if(!r||!TYPES.includes(r.entity_type)||typeof r.entity_id!=='string'||!r.entity_id.trim()
      ||!r.payload||typeof r.payload!=='object'||Array.isArray(r.payload)
      ||!Number.isSafeInteger(r.revision)||r.revision<1||seen.has(keyOf(r)))
      throw Error('受信した記録のID・版番号が不正です');
    seen.add(keyOf(r));
  }
  if(rows.length) decodeRecords(rows);
  return clone(rows);
}
function batchSize(operations) {
  if(operations.length>250||new TextEncoder().encode(JSON.stringify(operations)).length>1048576)
    throw Error('1回の同期上限を超えました。分割せず停止します');
}
export function makeSyncEngine({storage,ownerId,transport,withLock,randomUUID=()=>crypto.randomUUID()}={}) {
  if(!uuid(ownerId)||!storage?.getItem||!storage?.setItem||!transport?.fetchRows||!transport?.applyBatch
    ||typeof withLock!=='function') throw Error('同期の所有者・保存先・通信・排他制御が必要です');
  const key='takuwae-sync-v2.1-journal:'+ownerId;
  const read=()=>{
    const raw=storage.getItem(key);if(raw===null)return null;
    let s;try{s=JSON.parse(raw)}catch{throw Error('同期保存データが破損しています。上書きせず停止します')}
    if(s?.schema!==1||s.ownerId!==ownerId||!Array.isArray(s.baseline))throw Error('同期保存データの所有者・形式が違います');
    validateTakuwae(s.localDb);checkedRows(s.baseline);
    if(s.pending) {
      if(!uuid(s.pending.batchId)||!Array.isArray(s.pending.operations)||!s.pending.operations.length)
        throw Error('未送信データが不正です');
      batchSize(s.pending.operations);
      validateTakuwae(s.pending.targetDb);
      const expected=diffRecords(new Map(s.baseline.map(r=>[keyOf(r),r])),encodeRecords(s.pending.targetDb));
      if(canonical(expected)!==canonical(s.pending.operations))throw Error('未送信データと保存内容が一致しません');
    }
    return s;
  };
  const write=s=>{storage.setItem(key,JSON.stringify(s));};
  const requireState=()=>{const s=read();if(!s)throw Error('受信または明示的な初回移行が先に必要です');return s;};
  const guardRows=rows=>{
    checkedRows(rows);
    if(rows.some(r=>r.owner_id!==undefined&&r.owner_id!==ownerId))throw Error('別のユーザーの受信を拒否しました');
    return rows;
  };
  let active=false;
  const exclusive=fn=>withLock(key,async()=>{
    if(active)throw Error('同期処理は実行中です');active=true;
    try{return await fn()}finally{active=false}
  });
  async function commitPending(s) {
    const pending=clone(s.pending);
    let response;
    try{response=await transport.applyBatch({batchId:pending.batchId,operations:clone(pending.operations)});}
    catch(error){return {status:'retry_later',reason:error.message};}
    if(response?.status==='conflict') {
      s.conflict={kind:'revision',records:clone(response.conflicts||[])};write(s);
      return {status:'conflict'};
    }
    if(response?.status!=='applied'||!Array.isArray(response.records))return {status:'retry_later',reason:'応答形式が不正です'};
    const results=new Map(response.records.map(r=>[keyOf(r),r]));
    if(results.size!==pending.operations.length||response.records.length!==results.size)return {status:'retry_later',reason:'応答の件数が一致しません'};
    const baseline=new Map(s.baseline.map(r=>[keyOf(r),r]));
    for(const op of pending.operations) {
      const result=results.get(keyOf(op));
      if(!result||result.revision!==(op.expected_revision??0)+1||result.deleted!==op.deleted)
        return {status:'retry_later',reason:'応答の版番号が一致しません'};
      baseline.set(keyOf(op),{entity_type:op.entity_type,entity_id:op.entity_id,payload:clone(op.payload),revision:result.revision,deleted_at:op.deleted?'deleted':null});
    }
    // Persist acknowledgement and revised baseline together. On quota failure,
    // disk retains the original request and retries the SAME server receipt.
    s.baseline=[...baseline.values()];s.pending=null;s.conflict=null;write(s);
    return {status:'applied'};
  }
  return {
    key,
    snapshot:()=>{const s=read();return s?clone(s):null;},
    receiveInitial:({confirmReceive=false}={})=>exclusive(async()=>{
      if(read())throw Error('保存済みのローカルデータがあります。初回受信で上書きしません');
      if(confirmReceive!==true)throw Error('この端末への初回受信の確認が必要です');
      const rows=guardRows(await transport.fetchRows());
      if(!rows.length)throw Error('クラウドは空です。空データを送信せず停止します');
      const localDb=decodeRecords(rows);
      write({schema:1,ownerId,baseline:clone(rows),localDb,pending:null,conflict:null});
      return {status:'received',db:clone(localDb)};
    }),
    prepareInitialImport:({localDb,confirmation,hasExternalBackup}={})=>exclusive(async()=>{
      if(read())throw Error('同期データが既にあります');
      if(confirmation!==MIGRATION_CONFIRMATION||hasExternalBackup!==true)throw Error('初回移行の確認と外部バックアップが必要です');
      const rows=guardRows(await transport.fetchRows());
      const plan=inspectFirstImport(localDb,rows);batchSize(plan.operations);
      const batchId=randomUUID();if(!uuid(batchId))throw Error('バッチIDが不正です');
      write({schema:1,ownerId,baseline:[],localDb:clone(localDb),pending:{batchId,operations:plan.operations,targetDb:clone(localDb)},initialVerification:clone(localDb),conflict:null});
      // Preparation is storage-only. No apply call until a separate sync action.
      return {status:'prepared',recordCount:plan.recordCount};
    }),
    edit:mutate=>exclusive(async()=>{
      const s=requireState();if(s.conflict)throw Error('競合を解決するまで編集を停止します');
      if(typeof mutate!=='function')throw Error('編集処理が必要です');
      const next=clone(s.localDb);const result=mutate(next);
      if(result?.then)throw Error('編集処理は同期的である必要があります');
      validateTakuwae(next);encodeRecords(next);s.localDb=clone(next);write(s);
      return {status:'saved_locally'};
    }),
    saveLocal:(nextDb,{expectedLocalDb}={})=>exclusive(async()=>{
      const s=requireState();validateTakuwae(nextDb);encodeRecords(nextDb);
      if(s.conflict)throw Error('競合を解決するまで編集を停止します');
      if(!expectedLocalDb||canonical(s.localDb)!==canonical(expectedLocalDb))
        throw Error('表示中にローカルデータが変更されました。再読み込みが必要です');
      s.localDb=clone(nextDb);write(s);return {status:'saved_locally'};
    }),
    sync:()=>exclusive(async()=>{
      const s=requireState();if(s.conflict)return {status:'conflict'};
      if(s.pending) {const sent=await commitPending(s);if(sent.status!=='applied')return sent;}
      let rows;try{rows=guardRows(await transport.fetchRows());}catch(error){return {status:'retry_later',reason:error.message};}
      if(!rows.length)throw Error('クラウドが空になっています。ローカルを上書きせず停止します');
      if(s.initialVerification) {
        const expected=encodeRecords(s.initialVerification),actual=encodeRecords(decodeRecords(rows));
        if(rows.length!==expected.size||canonical(Object.fromEntries(expected))!==canonical(Object.fromEntries(actual))) {
          s.conflict={kind:'initial_verification',records:['初回登録後の内容が一致しません']};write(s);
          return {status:'conflict'};
        }
        s.initialVerification=null;write(s);
      }
      const base=decodeRecords(s.baseline),remote=decodeRecords(rows);
      const merged=mergeLedger(base,s.localDb,remote);
      if(merged.status==='conflict') {s.conflict={kind:'content',records:merged.conflicts};write(s);return {status:'conflict'};}
      const ops=diffRecords(new Map(rows.map(r=>[keyOf(r),r])),encodeRecords(merged.db));batchSize(ops);
      s.baseline=clone(rows);s.localDb=merged.db;
      if(ops.length) {
        const batchId=randomUUID();if(!uuid(batchId))throw Error('バッチIDが不正です');
        s.pending={batchId,operations:ops,targetDb:clone(merged.db)};
      }
      write(s);
      if(s.pending) {const sent=await commitPending(s);if(sent.status!=='applied')return sent;}
      return {status:'synced',db:clone(s.localDb)};
    }),
    // Manual resolution requires an external backup, fresh server fetch and an
    // explicit caller-selected ledger. No implicit local/server winner.
    previewConflict:()=>exclusive(async()=>{
      const s=requireState();if(!s.conflict)throw Error('競合がありません');
      const remoteRows=guardRows(await transport.fetchRows());
      return {localDb:clone(s.localDb),remoteDb:decodeRecords(remoteRows),remoteRows:clone(remoteRows),conflict:clone(s.conflict)};
    }),
    resolveConflict:({resolvedDb,expectedRemoteRows,hasExternalBackup,confirmation}={})=>exclusive(async()=>{
      const s=requireState();if(!s.conflict)throw Error('解決する競合がありません');
      if(hasExternalBackup!==true||confirmation!=='退避後に競合を解決する')throw Error('双方の外部退避と確認が必要です');
      validateTakuwae(resolvedDb);const rows=guardRows(await transport.fetchRows());
      if(!rows.length)throw Error('サーバーが空のため解決を停止します');
      if(!Array.isArray(expectedRemoteRows)||canonical(rows)!==canonical(expectedRemoteRows))
        throw Error('確認後にクラウドが変更されています。再度双方を確認してください');
      if(s.conflict.kind==='initial_verification')throw Error('初回照合不一致は移行監査が必要です');
      s.baseline=clone(rows);s.localDb=clone(resolvedDb);s.pending=null;s.conflict=null;write(s);
      return {status:'resolved_locally'};
    })
  };
}
