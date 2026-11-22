/**
 * Takuwae v2.1 development-only, side-effect-free record codec.
 * No localStorage writes, network requests, login, or production activation.
 * The caller must validate auth/RLS, revision and pending offline operations.
 */
export const TYPES = Object.freeze(['transaction','bill','bill_month','fund','setting','closing','rollover']);
const key = (type, id) => type + ':' + id;
const clone = x => JSON.parse(JSON.stringify(x));
const canonical=x=>JSON.stringify(x,(_key,v)=>
  v && typeof v==='object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]]))
    : v);
const RESERVED=new Set(['tx','bills','months','fundCategories']);
const safe = x => x && typeof x === 'object' && !Array.isArray(x);
const mustId = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error(label + ': IDが不正です');
  }
  return value;
};
const put = (out, type, id, value) => {
  id = mustId(id, type);
  const k = key(type, id);
  if (out.has(k)) throw new Error('重複ID: ' + k);
  out.set(k, {entity_type:type, entity_id:id, payload:clone(value)});
};
export function validateTakuwae(db) {
  const inspect=(v)=>{
    if(typeof v==='number' && !Number.isFinite(v)) throw new Error('有限でない数値があります');
    if(v && typeof v==='object') for(const [k,value] of Object.entries(v)) {
      if(['__proto__','constructor','prototype'].includes(k)) throw new Error('予約されたキーが含まれています');
      inspect(value);
    }
  };
  inspect(db);
  if (!safe(db) || !safe(db.initial) || !safe(db.fundInitial) ||
      !safe(db.months) || !Array.isArray(db.tx) ||
      !Array.isArray(db.bills) || !Array.isArray(db.fundCategories)) {
    throw new Error('たくわえのデータ形式が違います');
  }
  db.tx.forEach(t => { if (!safe(t)) throw new Error('取引データが不正です');mustId(t.id,'取引'); });
  db.bills.forEach(b => { if (!safe(b)) throw new Error('固定費データが不正です');mustId(b.id,'固定費'); });
  db.fundCategories.forEach(f => { if (!safe(f)) throw new Error('積立項目が不正です');mustId(f.id,'積立'); });
  Object.entries(db.months).forEach(([m, value]) => {
    if (!/^\d{4}-\d{2}$/.test(m) || !safe(value)) throw new Error('固定費の年月が不正です');
  });
  return true;
}
/** Split one local backup into independently syncable records. */
export function encodeRecords(db) {
  validateTakuwae(db);
  const out = new Map();
  for (const t of db.tx) put(out,'transaction',t.id,t);
  for (const b of db.bills) put(out,'bill',b.id,b);
  for (const f of db.fundCategories) put(out,'fund',f.id,f);
  for (const [month, bills] of Object.entries(db.months))
    for (const [billId, state] of Object.entries(bills))
      put(out,'bill_month',month + '/' + mustId(billId,'固定費のID'),state);
  const settings = Object.fromEntries(Object.entries(db).filter(([k]) =>
    !['tx','bills','months','fundCategories'].includes(k)));
  // Keep exact user-visible ordering without changing ledger object payloads.
  // This metadata is ONLY in the sync record, not in the original backup.
  settings.__sync_order={
    tx:db.tx.map(t=>t.id),
    bills:db.bills.map(b=>b.id),
    fundCategories:db.fundCategories.map(f=>f.id)
  };
  put(out,'setting','global',settings);
  return out;
}
/** Rebuild a backup shape after successful server fetch. Never overwrite local automatically. */
export function decodeRecords(rows) {
  if (!Array.isArray(rows)) throw new Error('サーバーのデータ形式が違います');
  const db = {tx:[],bills:[],months:{},fundCategories:[]};
  const seen = new Set();
  let syncOrder=null;
  for (const row of rows) {
    if (!TYPES.includes(row.entity_type)) throw new Error('未知のレコード種類');
    const k = key(row.entity_type,mustId(row.entity_id,'レコード'));
    if (seen.has(k)) throw new Error('サーバーに重複したレコードがあります');
    seen.add(k);
    if (row.deleted_at) continue;
    const data = clone(row.payload);
    if(!safe(data)) throw new Error('レコード内容が不正です');
    if(['closing','rollover'].includes(row.entity_type)) throw new Error('未対応のレコード種類。受信を停止します');
    if(['transaction','bill','fund'].includes(row.entity_type) && data.id!==row.entity_id)
      throw new Error('レコードIDと内容のIDが一致しません');
    if (row.entity_type === 'transaction') db.tx.push(data);
    if (row.entity_type === 'bill') db.bills.push(data);
    if (row.entity_type === 'fund') db.fundCategories.push(data);
    if (row.entity_type === 'bill_month') {
      const slash = row.entity_id.indexOf('/');
      if (slash < 1) throw new Error('年月キーが不正です');
      const month = row.entity_id.slice(0,slash), billId=row.entity_id.slice(slash+1);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('年月キーが不正です');
      (db.months[month] ??= {})[billId] = data;
    }
    if (row.entity_type === 'setting') {
      if (row.entity_id !== 'global' || !safe(data)) throw new Error('設定データが不正です');
      if(Object.keys(data).some(k=>RESERVED.has(k))) throw new Error('設定に予約された項目が含まれています');
      syncOrder=data.__sync_order;
      delete data.__sync_order;
      Object.assign(db,data);
    }
  }
  const applyOrder=(items,names)=>{
    if(!Array.isArray(names)) return false;
    const expected=new Set(items.map(x=>x.id));
    if(names.length!==items.length || names.some(x=>!expected.has(x))
       || new Set(names).size!==names.length)
      throw new Error('同期データの並び順情報が不正です');
    const order=new Map(names.map((id,i)=>[id,i]));
    items.sort((a,b)=>order.get(a.id)-order.get(b.id));
    return true;
  };
  if(!applyOrder(db.tx,syncOrder?.tx))
    db.tx.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  applyOrder(db.bills,syncOrder?.bills);
  applyOrder(db.fundCategories,syncOrder?.fundCategories);
  validateTakuwae(db);
  return db;
}
/**
 * Compare a verified server baseline to local state. Never silently merge
 * changed records: a caller must use server revision compare-and-swap RPC.
 * Deleted local records become tombstones, not immediate SQL deletes.
 */
export function diffRecords(baseline, local) {
  const changes = [];
  for (const [k,record] of local) {
    const prior=baseline.get(k);
    if (!prior || prior.deleted_at || canonical(prior.payload)!==canonical(record.payload)) {
      changes.push({...record, expected_revision: prior?.revision ?? null, deleted:false});
    }
  }
  for (const [k,prior] of baseline) if (!prior.deleted_at && !local.has(k)) {
    changes.push({entity_type:prior.entity_type, entity_id:prior.entity_id,
      payload:prior.payload, expected_revision:prior.revision, deleted:true});
  }
  return changes;
}
