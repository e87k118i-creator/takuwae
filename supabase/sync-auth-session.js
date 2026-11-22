/** Token retention is opt-in through the candidate's remember-login control. */
import {getAuthUser,refreshAuthSession} from './sync-api.js';
export function createAuthSession({storage,withLock,now=()=>Date.now(),api={getAuthUser,refreshAuthSession}}) {
  const key='takuwae-sync-auth-v21';
  let session=null;
  let remembered=false;
  function save(next) {
    if(remembered)storage.setItem(key,JSON.stringify(next));
    session=next;
  }
  function checked(value) {
    if(!value||typeof value.access_token!=='string'||typeof value.refresh_token!=='string'
      ||!Number.isFinite(value.expiresAt)||typeof value.ownerId!=='string')
      throw new Error('保存された認証を読み込めません。再ログインしてください');
    return value;
  }
  async function token() {
    return withLock(key,async()=>{
      if(remembered) {
        const saved=storage.getItem(key);
        if(!saved)throw new Error('ログアウト済みです。再ログインしてください');
        const stored=checked(JSON.parse(saved));
        if(session&&stored.ownerId!==session.ownerId)throw new Error('別のアカウントに切り替わりました。再ログインしてください');
        session=stored;
      }
      if(!session)throw new Error('ログインが必要です');
      if(session.expiresAt<=now()+60000) {
        const refreshed=await api.refreshAuthSession(session.refresh_token);
        const user=await api.getAuthUser(refreshed.access_token);
        if(user.id!==session.ownerId)throw new Error('認証アカウントが変わりました。再ログインしてください');
        save({...refreshed,ownerId:user.id,expiresAt:now()+refreshed.expires_in*1000});
      }
      return session.access_token;
    });
  }
  return {
    key,
    async accept(login,{remember=false}={}) {
      const user=await api.getAuthUser(login.access_token);
      const next=checked({...login,ownerId:user.id,expiresAt:now()+Number(login.expires_in)*1000});
      remembered=remember;
      if(!remember)storage.removeItem(key);
      save(next);
      return user;
    },
    async resume() {
      const saved=storage.getItem(key);if(!saved)return null;
      session=checked(JSON.parse(saved));remembered=true;
      const user=await api.getAuthUser(await token());
      if(user.id!==session.ownerId)throw new Error('保存された認証の所有者が一致しません');
      return user;
    },
    getAccessToken:token,
    async remember(value) {
      await token();
      if(value)storage.setItem(key,JSON.stringify(session));else storage.removeItem(key);
      remembered=!!value;
    },
    isRemembered:()=>remembered,
    clear(){storage.removeItem(key);session=null;remembered=false;}
  };
}
