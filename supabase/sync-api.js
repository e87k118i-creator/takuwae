// Development-only transport. Does NOT initialize app data or write localStorage.
// A signed-in session is required. Callers must retain batch_id+operations across retries.
import {SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY} from './config.js';

const base = SUPABASE_URL.replace(/\\/$/, '');
const allowed = new Set(['transaction','bill','bill_month','fund','setting','closing','rollover']);
function checkedToken(token) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('ログインが必要です');
  return token;
}
async function api(path, {method='GET', token, body, fetchImpl=fetch, extraHeaders={}}={}) {
  const headers = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: 'Bearer ' + checkedToken(token),
    ...extraHeaders
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(base+path, {
    method, headers, cache:'no-store',
    ...(body===undefined ? {} : {body: JSON.stringify(body)})
  });
  if (!res.ok) {
    const responseText = await res.text();
    throw new Error('同期サーバーエラー ('+res.status+'): '+responseText.slice(0,500));
  }
  return res.json();
}
/** RLS additionally restricts rows to token's authenticated owner. */
export async function fetchRecords(token,{fetchImpl=fetch, pageSize=500}={}) {
  if (!Number.isInteger(pageSize) || pageSize<1 || pageSize>1000) throw new Error('無効なページサイズ');
  let offset=0, all=[];
  while(true) {
    // Stable ordering is required for offset-based paging.
    const range = offset+'-'+(offset+pageSize-1);
    const page=await api('/rest/v1/takuwae_records?select=entity_type,entity_id,payload,revision,deleted_at,updated_at&order=entity_type.asc,entity_id.asc',{
      token, fetchImpl,extraHeaders:{Range:range}
    });
    if (!Array.isArray(page)) throw new Error('サーバーのデータ形式が違います');
    all.push(...page);
    if (page.length<pageSize) return all;
    offset+=pageSize;
    if (offset>100000) throw new Error('同期データが多すぎます');
  }
}
/**
 * Whole-batch write is atomic on the server. A conflict is a legitimate
 * response; it MUST be shown to the user or explicitly reconciled, not retried
 * with a new revision silently.
 */
export async function applyBatch(token,{batchId,operations,fetchImpl=fetch}={}) {
  if (typeof batchId !== 'string' || !/^[a-f0-9-]{36}$/i.test(batchId))
    throw new Error('UUID形式のbatchIdが必要です');
  if (!Array.isArray(operations) || operations.length<1 || operations.length>250)
    throw new Error('同期件数が不正です');
  for (const op of operations) {
    if (!op || !allowed.has(op.entity_type) || typeof op.entity_id!=='string'
        || !op.entity_id.trim() || typeof op.deleted!=='boolean'
        || !op.payload || typeof op.payload!=='object' || Array.isArray(op.payload)
        || !('expected_revision' in op)
        || (op.expected_revision!==null && (!Number.isSafeInteger(op.expected_revision)||op.expected_revision<1)))
      throw new Error('同期レコードの形式が違います');
  }
  const result = await api('/rest/v1/rpc/takuwae_apply_batch',{
    method:'POST', token, fetchImpl, body:{
      p_batch_id:batchId,
      p_operations:operations
    }
  });
  if (result?.status!=='applied' && result?.status!=='conflict')
    throw new Error('不明な同期結果です');
  return result;
}
/** OTP mail sender: calls auth endpoint only after an explicit login action. */
export async function sendEmailOtp(email,{fetchImpl=fetch}={}) {
  if (typeof email!=='string' || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email))
    throw new Error('メールアドレスを確認してな');
  const res = await fetchImpl(base+'/auth/v1/otp',{
    method:'POST', cache:'no-store',
    headers:{apikey:SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email,create_user:true})
  });
  if(!res.ok) throw new Error('認証メールを送信できませんでした ('+res.status+')');
  return true;
}
/** Verify a numeric email OTP: NEVER log or commit the token. */
export async function verifyEmailOtp(email,code,{fetchImpl=fetch}={}) {
  if(typeof code!=='string' || !/^\\d{6,8}$/.test(code))
    throw new Error('メールの認証コードを確認してな');
  const res=await fetchImpl(base+'/auth/v1/verify',{
    method:'POST',cache:'no-store',
    headers:{apikey:SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email,token:code,type:'email'})
  });
  if(!res.ok) throw new Error('認証コードを確認できませんでした ('+res.status+')');
  const session=await res.json();
  if(!session?.access_token || !session?.refresh_token)
    throw new Error('ログイン情報を受信できませんでした');
  return session;
}
