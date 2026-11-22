/**
 * Offline queue for DEVELOPMENT tests. Never reads/modifies takuwae-v1.
 * Storage is injected to make iOS/iPad persistence testing possible.
 *
 * Each batch includes a permanently assigned UUID. A failed HTTP request
 * MUST retry the very same batch ID and immutable operations.
 * The caller is responsible for using a consistent server revision baseline,
 * or for pausing on conflicts and reconciling; never silently overwrite.
 */
const QUEUE_SCHEMA=1;
const isObject=v=>v&&typeof v==='object'&&!Array.isArray(v);
function validateEntry(e) {
  if(!isObject(e) || typeof e.batchId!=='string'
      || !Array.isArray(e.operations) || !e.operations.length
      || !['pending','conflict'].includes(e.status))
    throw new Error('同期待ちデータが不正です');
}
export function makeSyncQueue({storage,ownerId,keyPrefix='takuwae-sync-v2.1-queue'}={}) {
  if(!storage || typeof storage.getItem!=='function' || typeof storage.setItem!=='function')
    throw new Error('保存領域が必要です');
  if(typeof ownerId!=='string' || !/^[0-9a-f-]{36}$/i.test(ownerId))
    throw new Error('ログインユーザーIDが必要です');
  const key=keyPrefix+':'+ownerId;
  const read=()=>{
    const raw=storage.getItem(key);
    if(raw===null) return [];
    let parsed;
    try {parsed=JSON.parse(raw);} catch {throw new Error('同期待ちデータが破損しています。上書き禁止');}
    if(parsed?.schema!==QUEUE_SCHEMA || !Array.isArray(parsed.entries))
      throw new Error('同期待ちデータが認識できません。上書き禁止');
    parsed.entries.forEach(validateEntry);
    const ids=parsed.entries.map(x=>x.batchId);
    if(new Set(ids).size!==ids.length) throw new Error('同期待ちIDが重複しています');
    return parsed.entries;
  };
  const write=(entries)=>{
    // A thrown quota error must be propagated so an unsaved local mutation
    // is never treated as durable.
    storage.setItem(key,JSON.stringify({schema:QUEUE_SCHEMA,entries}));
  };
  return {
    key,
    pending:()=>structuredClone(read()),
    enqueue:(batchId,operations)=>{
      const entries=read();
      const entry={batchId,operations:structuredClone(operations),status:'pending'};
      validateEntry(entry);
      if(entries.some(e=>e.batchId===batchId)) throw new Error('同じバッチIDが既にあります');
      entries.push(entry);write(entries);
      return structuredClone(entry);
    },
    peek:()=>structuredClone(read()[0]??null),
    acknowledge:(batchId)=>{
      const entries=read();
      if(entries[0]?.batchId!==batchId || entries[0]?.status!=='pending')
        throw new Error('同期待ちの順序が違います');
      write(entries.slice(1));
    },
    markConflict:(batchId)=>{
      const entries=read();
      if(entries[0]?.batchId!==batchId) throw new Error('競合したバッチが先頭ではありません');
      entries[0]={...entries[0],status:'conflict'};
      write(entries);
    },
    // No implicit discard method: conflict resolution must preserve data
    // through a separate backup and explicit manual decision.
  };
}
