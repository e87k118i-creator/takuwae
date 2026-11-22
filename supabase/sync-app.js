import {sendEmailOtp,readMagicLinkSession,signOut} from './sync-api.js';
import {createSyncSession} from './sync-session.js';
import {createSyncAppBridge} from './sync-app-bridge.js';
import {buildSyncAppDocument} from './sync-app-frame.js';

const element = id => document.getElementById(id);
const frame = element('app');
let connection;
let bridge;
let accessToken;
let syncTimer;
let stopped = false;
function status(message) { element('status').textContent = message; }
function scheduleSync() {
  clearTimeout(syncTimer);
  if (stopped || !bridge || !connection?.isWritable()) return;
  syncTimer = setTimeout(async()=>{
    const active = frame.contentDocument?.activeElement;
    if (active && ['INPUT','SELECT','TEXTAREA'].includes(active.tagName)) {
      scheduleSync();
      return;
    }
    try { await bridge.sync(); }
    catch(error) { status(error.message); }
  }, 1200);
}
function handleStatus(result) {
  const messages = {
    saved_locally:'端末に保存しました。',
    synced:'同期できました。',
    conflict:'同じ記録の変更が重なりました。編集を停止し、双方のデータを保持しています。',
    retry_later:'変更を端末に保持しています。通信復帰後に再試行できます。',
    save_failed:'端末への保存に失敗しました。保存済みの状態を再表示してください。',
    blocked:'処理を停止しています。保存済みの状態を確認してください。'
  };
  status((messages[result.status] || result.status) + (result.reason?'\n'+result.reason:''));
  if (result.status==='saved_locally') scheduleSync();
}
async function mount() {
  const snapshot = connection.engine.snapshot();
  if (!snapshot) {
    status('ログインできました。この端末の同期保存は未作成です。初回受信でクラウドを確認できます。');
    return;
  }
  const response = await fetch('./index.html', {cache:'no-store'});
  if (!response.ok) throw new Error('本体画面を取得できませんでした');
  bridge?.close();
  bridge = createSyncAppBridge({engine:connection.engine, onStatus:handleStatus, view:{
    replace:db=>frame.contentWindow.syncAppView?.replace(db),
    setBusy:value=>frame.contentWindow.syncAppView?.setBusy(value)
  }});
  window.syncAppHost = {save:db=>bridge.save(db)};
  frame.srcdoc = buildSyncAppDocument(await response.text(), {
    db:snapshot.localDb, baseUrl:new URL('./',location.href).href
  });
  frame.onload = ()=>{
    frame.contentWindow.syncAppView?.setBusy(!!snapshot.conflict);
    status(snapshot.conflict?'競合を保持しています。編集を停止しています。':'端末の保存データを開きました。');
  };
  frame.classList.remove('hidden');
  element('receive').disabled = true;
  element('recover').disabled = false;
  element('sync').disabled = false;
}
element('login-form').addEventListener('submit', async event=>{
  event.preventDefault();element('send').disabled = true;
  try {
    await sendEmailOtp(element('email').value.trim(), {
      redirectTo:new URL('./sync-app.html',location.href).href
    });
    status('認証メールを送りました。新しく届いたメールのリンクを開いてください。');
  } catch(error) { status(error.message); }
  finally { element('send').disabled = false; }
});
element('receive').addEventListener('click',async()=>{
  element('receive').disabled = true;
  try {
    await connection.engine.receiveInitial({confirmReceive:true});
    await mount();
  } catch(error) { status(error.message);element('receive').disabled = false; }
});
element('writes').addEventListener('change',()=>{
  if (element('writes').checked) {
    connection.enableWrites({ownerId:connection.ownerId,confirmation:'このアカウントで同期の書き込みを有効にする'});
    status('クラウドへの同期を有効にしました。');scheduleSync();
  } else { connection.pauseWrites();clearTimeout(syncTimer);status('クラウドへの送信を一時停止しました。'); }
});
element('sync').addEventListener('click',()=>bridge?.sync().catch(error=>status(error.message)));
element('recover').addEventListener('click',()=>bridge?.recover().catch(error=>status(error.message)));
element('logout').addEventListener('click',async()=>{
  stopped = true;clearTimeout(syncTimer);connection.pauseWrites();bridge?.close();
  try {
    await bridge?.settled();await signOut(accessToken);connection.close();accessToken=null;
    frame.srcdoc='';frame.classList.add('hidden');element('controls').classList.add('hidden');
    element('login').classList.remove('hidden');status('ログアウトしました。端末の保存データは保持しています。');
  } catch(error) {status(error.message);}
});
window.addEventListener('online',scheduleSync);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleSync();});
window.addEventListener('beforeunload',event=>{
  if(bridge?.isBusy()){event.preventDefault();event.returnValue='';}
});

const fragment = location.hash || '#'+location.search.slice(1);
if (location.hash || location.search) history.replaceState(null,'',location.pathname);
try {
  const session = readMagicLinkSession(fragment);
  if (session) {
    accessToken=session.access_token;
    connection=await createSyncSession({accessToken,storage:localStorage,locks:navigator.locks});
    element('login').classList.add('hidden');element('controls').classList.remove('hidden');
    await mount();
  }
} catch(error) {status(error.message);}
