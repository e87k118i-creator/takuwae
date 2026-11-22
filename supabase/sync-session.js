/* Explicit development wiring only. Nothing executes on import. */
import {makeSyncEngine} from './sync-engine.js';
import {fetchRecords,applyBatch,getAuthUser} from './sync-api.js';
/**
 * Read-only by default, including after sign-in. Enabling writes requires a
 * separate, explicit call with the currently authenticated owner and phrase.
 * No app, lab or production page imports this adapter yet.
 */
export async function createSyncSession({accessToken,storage,locks,api={fetchRecords,applyBatch,getAuthUser}}={}) {
  if(!locks?.request)throw Error('安全な複数タブ排他制御が使えません');
  const user=await api.getAuthUser(accessToken);
  let writable=false,closed=false;
  const requireSession=()=>{if(closed)throw Error('ログアウト済みです');};
  const engine=makeSyncEngine({storage,ownerId:user.id,withLock:(key,fn)=>locks.request(key,{mode:'exclusive'},fn),transport:{
    fetchRows:async()=>{requireSession();return api.fetchRecords(accessToken);},
    applyBatch:async batch=>{
      requireSession();if(!writable)throw Error('家計データの送信はまだ許可されていません');
      const current=await api.getAuthUser(accessToken);
      requireSession();if(!writable)throw Error('書き込みは一時停止されています');
      if(current.id!==user.id)throw Error('認証ユーザーが変わりました。送信を停止します');
      return api.applyBatch(accessToken,batch);
    }
  }});
  return {
    engine,ownerId:user.id,
    isWritable:()=>writable&&!closed,
    enableWrites:({ownerId,confirmation}={})=>{
      requireSession();
      if(ownerId!==user.id||confirmation!=='このアカウントで同期の書き込みを有効にする')throw Error('書き込みを有効にする明示確認が必要です');
      writable=true;
    },
    pauseWrites:()=>{writable=false;},
    close:()=>{writable=false;closed=true;accessToken=null;}
  };
}
