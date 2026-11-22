import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthSession} from './sync-auth-session.js';
const owner='550e8400-e29b-41d4-a716-446655440000';
function setup() {
  const data=new Map();let clock=0,refreshes=0,tail=Promise.resolve();
  const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
  const withLock=(_key,action)=>{const next=tail.then(action);tail=next.catch(()=>{});return next;};
  const api={getAuthUser:async()=>({id:owner}),refreshAuthSession:async()=>{refreshes++;return {access_token:'new-token',refresh_token:'new-refresh',expires_in:3600};}};
  const create=()=>createAuthSession({storage,withLock,now:()=>clock,api});
  return {data,storage,api,create,setTime:value=>clock=value,refreshes:()=>refreshes};
}
const login={access_token:'fake-access-token',refresh_token:'fake-refresh-token',expires_in:3600};
test('memory-only login leaves no stored credential until the user opts in',async()=>{
  const e=setup(),auth=e.create();await auth.accept(login);assert.equal(e.data.size,0);
  assert.equal(await e.create().resume(),null);
  await auth.remember(true);assert.equal(e.data.size,1);assert.equal((await e.create().resume()).id,owner);
  await auth.remember(false);assert.equal(e.data.size,0);
});
test('expired login refreshes without email, and two tabs share the rotated token',async()=>{
  const e=setup(),a=e.create();await a.accept(login,{remember:true});
  const b=e.create();await b.resume();e.setTime(3600000);
  assert.deepEqual(await Promise.all([a.getAccessToken(),b.getAccessToken()]),['new-token','new-token']);
  assert.equal(e.refreshes(),1);
});
test('logout in one tab prevents other tabs from resurrecting its saved login',async()=>{
  const e=setup(),a=e.create();await a.accept(login,{remember:true});const b=e.create();await b.resume();
  a.clear();await assert.rejects(b.getAccessToken(),/ログアウト済み/);assert.equal(e.data.size,0);
});
test('changing saved account is rejected by a tab with the previous owner',async()=>{
  const e=setup(),a=e.create();await a.accept(login,{remember:true});
  const stored=JSON.parse(e.storage.getItem(a.key));stored.ownerId='different';e.storage.setItem(a.key,JSON.stringify(stored));
  await assert.rejects(a.getAccessToken(),/別のアカウント/);
});
test('refresh failure preserves the existing credential for a later safe retry',async()=>{
  const e=setup(),a=e.create();await a.accept(login,{remember:true});const original=e.storage.getItem(a.key);
  e.setTime(3600000);e.api.refreshAuthSession=async()=>{throw Error('offline');};
  await assert.rejects(a.getAccessToken(),/offline/);assert.equal(e.storage.getItem(a.key),original);
});
