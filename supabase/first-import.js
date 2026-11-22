/* Explicit, backup-gated first import. No localStorage writes or auto-run. */
import {encodeRecords,decodeRecords,validateTakuwae} from './sync-model.js';
export const MIGRATION_CONFIRMATION='iPhoneから初回登録する';
// Postgres jsonb can reorder object keys: compare parsed content, not key order.
const canonical=value=>JSON.stringify(value,(_key,part)=>{
  if(part && typeof part==='object' && !Array.isArray(part))
    return Object.fromEntries(Object.keys(part).sort().map(k=>[k,part[k]]));
  return part;
});
export function inspectFirstImport(localDb, serverRows) {
  validateTakuwae(localDb);
  if (!Array.isArray(serverRows)) throw new Error('サーバーデータを確認できません');
  if (serverRows.length !== 0) throw new Error('サーバーに既存データがあります。自動上書き・統合はしません');
  const records=[...encodeRecords(localDb).values()];
  if (records.length>250) throw new Error('記録が250件を超えるため、安全な分割移行の実装が必要です');
  return {
    transactionCount:localDb.tx.length, billCount:localDb.bills.length,
    recordCount:records.length,
    operations:records.map(r=>({...r,expected_revision:null,deleted:false}))
  };
}
/* No implicit activation of two-way sync after import. */
export async function firstImport({localDb,confirmation,hasExternalBackup,fetchRows,apply,batchId}={}) {
  if(confirmation!==MIGRATION_CONFIRMATION) throw new Error('初回移行の確認操作が必要です');
  if(hasExternalBackup!==true) throw new Error('外部JSONバックアップを先に保存してください');
  if(typeof fetchRows!=='function' || typeof apply!=='function') throw new Error('同期接続が用意できていません');
  if(typeof batchId!=='string' || !/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('固定のUUIDバッチIDが必要です');
  const initial=await fetchRows();
  const plan=inspectFirstImport(localDb,initial);
  const result=await apply({batchId,operations:plan.operations});
  if(result?.status==='conflict') throw new Error('初回移行中に競合を検出しました。データは上書きしません');
  if(result?.status!=='applied') throw new Error('初回移行の結果を確認できません');
  const verified=await fetchRows();
  if(verified.length!==plan.recordCount) throw new Error('クラウド上の記録件数が一致しません。同期は有効にしません');
  const expected=new Map(plan.operations.map(r=>[r.entity_type+':'+r.entity_id,canonical(r.payload)]));
  for(const row of verified) {
    const k=row.entity_type+':'+row.entity_id;
    if(row.deleted_at || expected.get(k)!==canonical(row.payload))
      throw new Error('クラウド上の記録内容が一致しません。同期は有効にしません');
    expected.delete(k);
  }
  if(expected.size) throw new Error('クラウドに未登録の記録があります');
  const restored=decodeRecords(verified);
  if(restored.tx.length!==localDb.tx.length || restored.bills.length!==localDb.bills.length)
    throw new Error('復元した記録数が一致しません');
  return {status:'verified',transactionCount:plan.transactionCount,recordCount:plan.recordCount};
}
