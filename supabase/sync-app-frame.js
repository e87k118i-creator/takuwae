/** Build the existing app UI against an injected sync host, without legacy storage. */
export function buildSyncAppDocument(source, {db, baseUrl}) {
  const load = "let db;try{db=JSON.parse(localStorage.getItem(KEY))||fresh()}catch(e){db=fresh()}";
  const save = 'let save=()=>localStorage.setItem(KEY,JSON.stringify(db));';
  const entry = '\nrender();\nfunction syncBottomNavHeight';
  for (const marker of [load, save, entry]) {
    if (!source.includes(marker)) throw new Error('本体の保存処理が変わっています。接続を停止しました');
  }
  const literal = value => JSON.stringify(value).replaceAll('<', '\\u003c');
  let html = source.replace(load, 'let db=' + literal(db) + ';');
  html = html.replace(save, 'let save=()=>parent.syncAppHost.save(structuredClone(db));');
  html = html.replace("const KEY='takuwae-v1';", "const KEY='unused-sync-app';");
  html = html.replace(/<link[^>]*rel="manifest"[^>]*>/g, '');
  html = html.replace(/<script>if\("serviceWorker"[\s\S]*?<\/script>/g, '');
  // The original startup snapshot can write on the day before payday.
  // Keep the explicit closing actions, but do not save while mounting a view.
  html = html.replace('\nsnapshotOn24();\n', '\n');
  const adapter = `
const renderSyncApp = render;
render = function(){
  const before = structuredClone(db);
  try { return renderSyncApp(); } finally { db = before; }
};
window.syncAppView = {
  replace(value){ db=structuredClone(value); render(); },
  setBusy(value){ document.body.inert=value; },
  snapshot(){ return structuredClone(db); }
};
// Export via the top-level host, not a download from this srcdoc iframe.
exportData=()=>parent.syncAppHost.exportBackup(structuredClone(db));
importData=async()=>alert('同期中のバックアップ復元は、退避と照合が必要です。同期画面から操作してください');
resetAll=()=>alert('同期中は全データ初期化を実行できません');
checkTakuwaeUpdate=async()=>{
  try {
    const response=await fetch(new URL('index.html',document.baseURI),{cache:'no-store'});
    if(!response.ok) throw Error();
    const html=await response.text();
    const version=new DOMParser().parseFromString(html,'text/html').querySelector('meta[name="takuwae-version"]')?.content;
    if(!version) throw Error();
    alert(version===TAKUWAE_APP_VERSION?'最新版です（v'+version+'）。':'使用中はv'+TAKUWAE_APP_VERSION+'、配信中はv'+version+'です。アプリを閉じて開き直してください。');
  } catch { alert('公開版を確認できませんでした。通信を確認して再度お試しください。'); }
};
`;
  // Keep the synchronization controls in the host, with an entry in the ledger settings.
  html = html.replace('<h2>設定・口座管理</h2>',
    '<h2>設定・口座管理</h2><div class="card stack"><button type="button" onclick="parent.syncAppHost.openSettings()">同期の設定</button></div>');
  html = html.replace(entry, '\n' + adapter + entry);
  html = html.replace('</body>', '<script src="./supabase/ledger-gestures.js"></script></body>');
  return html.replace('<head>', '<head><base href=' + literal(baseUrl) + '>');
}
