import {sendEmailOtp,verifyEmailOtp,readMagicLinkSession,signOut} from './sync-api.js';
import {makeSyncEngine} from './sync-engine.js';
import {createSyncSession} from './sync-session.js';
import {createSyncAppBridge} from './sync-app-bridge.js';
import {buildSyncAppDocument} from './sync-app-frame.js';
import {createAuthSession} from './sync-auth-session.js';
import {createRemoteTrial} from './sync-remote-trial.js';
import {encodeRecords} from './sync-model.js';
import {inspectFirstImport,MIGRATION_CONFIRMATION} from './first-import.js';
import {canonical} from './sync-merge.js';

const element = id => document.getElementById(id);
const frame = element('app');
const offlineKey = 'takuwae-sync-offline-owner';
const rememberRequestKey = 'takuwae-sync-remember-request-v21';
let connection;
let bridge;
const auth = createAuthSession({storage:localStorage,withLock:(key,action)=>navigator.locks.request(key,action)});
let conflictReview;
let remoteTrial;
let reviewedBackup;
let importBusy=false;
let trialBusy=false;
function renderImport() {
  const snapshot=connection?.engine.snapshot();
  const prepared=!!snapshot?.initialVerification && !snapshot.conflict;
  element('receive').disabled=importBusy||trialBusy||!!snapshot;
  element('trial').disabled=importBusy||trialBusy||!!snapshot;
  element('writes').disabled=importBusy||trialBusy||!bridge;
  element('initial-import').classList.toggle('hidden',!connection || (!!snapshot&&!prepared));
  element('backup-preview-file').disabled=importBusy||prepared;
  element('prepare-import').disabled=importBusy||trialBusy||!!snapshot||!reviewedBackup;
  element('send-import').disabled=importBusy||trialBusy||!prepared;
}
let syncTimer;
let stopped = false;
function showSyncSettings() {
  const dialog=element('sync-settings-dialog');
  if(element('shell').classList.contains('ready') && !dialog.open)dialog.showModal();
}
element('sync-settings-close').addEventListener('click',()=>element('sync-settings-dialog').close());
function setLedgerLayout(ready,{keepSettingsOpen=false}={}) {
  const dialog=element('sync-settings-dialog');
  const settings=element('sync-settings');
  element('shell').classList.toggle('ready',ready);
  const target=ready?dialog:element('sync-settings-setup');
  if(settings.parentElement!==target)target.append(settings);
  settings.open=true;
  if(!ready && dialog.open)dialog.close();
  if(ready && keepSettingsOpen)showSyncSettings();
}
function status(message) { element('status').textContent = message; }
element('enable-offline').addEventListener('click',async()=>{
  const output=element('offline-status');
  try {
    const snapshot=connection?.engine.snapshot();
    if(!snapshot || snapshot.initialVerification || snapshot.conflict)
      throw Error('先に家計画面をオンラインで開いてください。');
    if(!auth.isRemembered())throw Error('先に「この端末でログインを維持する」にチェックを入れてください。');
    output.textContent='起動に必要なファイルを準備しています。';
    await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    let readyTimeout;
    const registration=await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_,reject)=>{
        readyTimeout=setTimeout(()=>reject(Error('起動ファイルの準備に時間がかかっています。通信を確認して再試行してください。')),15000);
      })
    ]).finally(()=>clearTimeout(readyTimeout));
    const channel=new MessageChannel();
    const available=await new Promise(resolve=>{
      const timeout=setTimeout(()=>resolve(false),10000);
      channel.port1.onmessage=event=>{clearTimeout(timeout);resolve(event.data===true);};
      registration.active.postMessage('offline-ready',[channel.port2]);
    });
    channel.port1.close();
    if(!available)throw Error('起動ファイルを確認できませんでした。');
    localStorage.setItem(offlineKey,connection.ownerId);
    output.textContent='この端末でオフライン起動を準備しました。';
  } catch(error) { output.textContent=error.message; }
});
async function openOffline() {
  const ownerId=localStorage.getItem(offlineKey);
  const remembered=JSON.parse(localStorage.getItem(auth.key)||'null');
  if(!ownerId || remembered?.ownerId!==ownerId) return false;
  const unavailable=async()=>{throw Error('通信に接続してから同期してください。');};
  const engine=makeSyncEngine({ownerId,storage:localStorage,
    withLock:(key,action)=>navigator.locks.request(key,action),
    transport:{fetchRows:unavailable,applyBatch:unavailable}});
  const snapshot=engine.snapshot();
  if(!snapshot || snapshot.initialVerification || snapshot.conflict) return false;
  connection={engine,ownerId,isWritable:()=>false};
  element('login').classList.add('hidden');
  element('remember').closest('label').classList.add('hidden');
  await mount('オフラインで開きました。変更はこの端末に保存します。通信が戻ったらアプリを開き直して同期してください。');
  element('sync-settings-title').textContent='同期の設定（オフライン）';
  window.addEventListener('online',()=>{
    showSyncSettings();
    status('通信が戻りました。アプリを開き直して同期できます。');
  });
  return true;
}
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
  if(['conflict','retry_later','save_failed','blocked'].includes(result.status))showSyncSettings();
  status((messages[result.status] || result.status) + (result.reason?'\n'+result.reason:''));
  if (result.status==='saved_locally') scheduleSync();
  if (result.status==='conflict') showConflict().catch(error=>status(error.message));
}
async function showConflict() {
  conflictReview=await connection.engine.previewConflict();
  const local=encodeRecords(conflictReview.localDb);
  const remote=encodeRecords(conflictReview.remoteDb);
  const differences=[];
  for(const key of new Set([...local.keys(),...remote.keys()])) {
    const left=local.get(key),right=remote.get(key);
    if(canonical(left)===canonical(right))continue;
    differences.push({項目:left?.payload?.category||left?.payload?.name||key,
      この端末:left?.payload??'削除済み',クラウド:right?.payload??'削除済み'});
  }
  element('conflict-summary').textContent=JSON.stringify({
    競合:conflictReview.conflict.records,
    この端末:{取引:conflictReview.localDb.tx.length,固定費:conflictReview.localDb.bills.length},
    クラウド:{取引:conflictReview.remoteDb.tx.length,固定費:conflictReview.remoteDb.bills.length},
    異なる内容:differences
  },null,2);
  element('backup-confirmed').checked=false;
  element('conflict-choice').value='';
  element('conflict').classList.remove('hidden');
}
async function mount(successMessage) {
  const snapshot = connection.engine.snapshot();
  renderImport();
  if(snapshot?.initialVerification) {
    status(snapshot.conflict?'初回登録後の内容が一致しません。処理を停止しました。':'初回登録を準備済みです。下の初回移行欄から登録を確定できます。');
    return;
  }
  if (!snapshot) {
    status('ログインできました。この端末の同期保存は未作成です。初回受信でクラウドを確認できます。');
    return;
  }
  const response = await fetch('./ledger.html', {cache:'no-store'});
  if (!response.ok) throw new Error('本体画面を取得できませんでした');
  bridge?.close();
  bridge = createSyncAppBridge({engine:connection.engine, onStatus:handleStatus, view:{
    replace:db=>frame.contentWindow.syncAppView?.replace(db),
    setBusy:value=>frame.contentWindow.syncAppView?.setBusy(value)
  }});
  window.syncAppHost = {save:db=>bridge.save(db),openSettings:showSyncSettings, async pullSync() {
    if (!navigator.onLine) return 'オフラインです。通信が戻ったら同期できます。';
    if (!connection?.isWritable()) return 'クラウド同期はオフです。';
    const result = await bridge.sync();
    if (result.status === 'synced') return '同期しました。';
    return result.reason || '同期は完了していません。同期設定を確認してください。';
  }};
  frame.srcdoc = buildSyncAppDocument(await response.text(), {
    db:snapshot.localDb, baseUrl:new URL('./',location.href).href
  });
  frame.onload = ()=>{
    frame.contentWindow.syncAppView?.setBusy(!!snapshot.conflict);
    status(snapshot.conflict?'競合を保持しています。編集を停止しています。':(successMessage||'端末の保存データを開きました。'));
    if(snapshot.conflict)showConflict().catch(error=>status(error.message));
  };
  renderImport();
  frame.classList.remove('hidden');
  setLedgerLayout(true,{keepSettingsOpen:!!snapshot.conflict || (!!successMessage && navigator.onLine)});
  element('receive').disabled = true;
  element('recover').disabled = false;
  element('sync').disabled = false;
}
element('backup-preview-file').addEventListener('change', async event=>{
  const input=event.currentTarget;
  const output=element('backup-preview-status');
  const file=input.files[0];
  output.textContent='';
  reviewedBackup=undefined;
  element('import-backup-confirmed').checked=false;
  if(!file)return;
  input.disabled=true;
  try {
    if(file.size>5*1024*1024)throw Error('バックアップが5 MBを超えているため確認を停止しました。');
    let backup;
    try { backup=JSON.parse(await file.text()); }
    catch { throw Error('JSONバックアップを読み取れませんでした。'); }
    const plan=inspectFirstImport(backup,[]);
    if(new TextEncoder().encode(JSON.stringify(plan.operations)).length>1048576)
      throw Error('一度に移行できるデータ量を超えています。');
    reviewedBackup=backup;
    output.textContent='形式の確認ができました。取引 '+plan.transactionCount+'件、固定費 '+plan.billCount+'件、設定などを含む登録予定 '+plan.recordCount+'件。';
  } catch(error) {
    output.textContent='確認を停止しました。'+error.message;
  } finally {
    input.value='';
    renderImport();
  }
});
element('prepare-import').addEventListener('click',async()=>{
  if(importBusy || trialBusy || !connection || !reviewedBackup) return;
  importBusy=true;
  renderImport();
  try {
    const plan=await connection.engine.prepareInitialImport({
      localDb:reviewedBackup,confirmation:MIGRATION_CONFIRMATION,
      hasExternalBackup:element('import-backup-confirmed').checked
    });
    reviewedBackup=undefined;
    element('import-status').textContent=plan.recordCount+'件を端末内で準備しました。';
  } catch(error) { element('import-status').textContent=error.message; }
  finally { importBusy=false;renderImport(); }
});
element('send-import').addEventListener('click',async()=>{
  if(importBusy || trialBusy || !connection) return;
  const active=connection;
  const pending=active.engine.snapshot();
  if(!pending?.initialVerification || pending.conflict) return;
  const count=encodeRecords(pending.initialVerification).size;
  if(!window.confirm(count+'件の家計データを、このアカウントのクラウドに初回登録しますか？'))return;
  importBusy=true;
  renderImport();
  try {
    active.enableWrites({ownerId:active.ownerId,confirmation:'このアカウントで同期の書き込みを有効にする'});
    const result=await active.engine.sync();
    if(result.status!=='synced') {
      element('import-status').textContent=result.reason||'登録結果を確認できませんでした。';
      status(element('import-status').textContent);
      return;
    }
    await mount(count+'件をクラウドに登録し、読み戻した内容が一致しました。');
  } catch(error) { element('import-status').textContent=error.message; }
  finally { active.pauseWrites();importBusy=false;renderImport(); }
});
async function finishSignIn() {
  element('remember').checked=auth.isRemembered();
  connection=await createSyncSession({getAccessToken:auth.getAccessToken,storage:localStorage,locks:navigator.locks});
  remoteTrial=createRemoteTrial({getAccessToken:auth.getAccessToken,ownerId:connection.ownerId,storage:localStorage,
    withLock:(key,action)=>navigator.locks.request(key,action)});
  element('login').classList.add('hidden');element('controls').classList.remove('hidden');
  await mount();
}
element('code-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const emailField=element('email');
  if(!emailField.reportValidity())return;
  const button=element('verify-code');
  button.disabled=true;
  try {
    const session=await verifyEmailOtp(emailField.value.trim(),element('email-code').value.trim());
    await auth.accept(session,{remember:element('remember').checked});
    localStorage.removeItem(rememberRequestKey);
    element('email-code').value='';
    await finishSignIn();
  } catch(error) { status(error.message); }
  finally { button.disabled=false; }
});
element('login-form').addEventListener('submit', async event=>{
  event.preventDefault();element('send').disabled = true;
  const email = element('email').value.trim();
  const request = JSON.stringify({email, expiresAt:Date.now()+15*60*1000});
  try {
    if (element('remember').checked) localStorage.setItem(rememberRequestKey,request);
    else localStorage.removeItem(rememberRequestKey);
    await sendEmailOtp(email, {
      redirectTo:new URL('./',location.href).href
    });
    status('認証メールを送りました。数字のコードが届いたら、この画面で入力してください。リンクだけの場合は、ブラウザでログインできます。');
  } catch(error) {
    if(localStorage.getItem(rememberRequestKey)===request) localStorage.removeItem(rememberRequestKey);
    status(error.message);
  }
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
  if(importBusy || trialBusy)return;
  stopped = true;clearTimeout(syncTimer);connection.pauseWrites();bridge?.close();
  try {
    await bridge?.settled();await signOut(await auth.getAccessToken());connection.close();localStorage.removeItem(offlineKey);connection=undefined;bridge=undefined;auth.clear();renderImport();
    frame.srcdoc='';frame.classList.add('hidden');setLedgerLayout(false);element('controls').classList.add('hidden');
    element('login').classList.remove('hidden');status('ログアウトしました。端末の保存データは保持しています。');
  } catch(error) {status(error.message);}
});
element('remember').addEventListener('change',async()=>{
  if(!connection)return;
  try{await auth.remember(element('remember').checked);status(element('remember').checked?'この端末でログインを維持します。':'ログイン情報の端末保存を解除しました。');}
  catch(error){element('remember').checked=auth.isRemembered();status(error.message);}
});
element('trial').addEventListener('click',async()=>{
  if(importBusy || trialBusy || connection.engine.snapshot())return;
  trialBusy=true;
  renderImport();
  try {
    const report=await remoteTrial.run();
    element('trial-status').textContent='通信試験に成功しました。'+report.passed.join('・')+'。試験用レコードは削除済み状態にしました。';
  }catch(error){element('trial-status').textContent=error.message;}
  finally{trialBusy=false;renderImport();}
});
element('backup-conflict').addEventListener('click',()=>{
  if(!conflictReview)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(conflictReview,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='takuwae-conflict-backup-'+Date.now()+'.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
element('resolve-conflict').addEventListener('click',async()=>{
  if(!conflictReview||!element('backup-confirmed').checked||!element('conflict-choice').value){status('双方の退避と残す内容を確認してください。');return;}
  if(!confirm('選んだ内容を同期の正本にします。退避ファイルを保存済みで間違いありませんか？'))return;
  try {
    await connection.engine.resolveConflict({resolvedDb:element('conflict-choice').value==='local'?conflictReview.localDb:conflictReview.remoteDb,
      expectedRemoteRows:conflictReview.remoteRows,hasExternalBackup:true,confirmation:'退避後に競合を解決する'});
    element('conflict').classList.add('hidden');await bridge.recover();status('端末に解決内容を保存しました。「今すぐ同期」で送信できます。');
  }catch(error){status(error.message);}
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
  let rememberEmail;
  if (session) {
    const raw = localStorage.getItem(rememberRequestKey);
    localStorage.removeItem(rememberRequestKey);
    if (raw) {
      const pending = JSON.parse(raw);
      if (pending?.expiresAt > Date.now()) rememberEmail = pending.email;
    }
  }
  const offline=!session && !navigator.onLine && await openOffline();
  const user=offline?null:session?await auth.accept(session,{rememberEmail}):await auth.resume();
  if (user) await finishSignIn();
} catch(error) {status(error.message);}
finally {
  element('startup').hidden=true;
  element('shell').hidden=false;
}
