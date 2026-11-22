/* Full app integration rehearsal using only a memory-backed server. */
import {makeSyncEngine} from './sync-engine.js';
import {makeDemoServer} from './sync-demo-server.js';
import {createSyncAppBridge} from './sync-app-bridge.js';
import {buildSyncAppDocument} from './sync-app-frame.js';

const seed = {
  initial:{s1:10000,r:5000,s2:0,cash:0,em:0},
  fundInitial:{repair:0,car:0},
  fundCategories:[{id:'repair',name:'修理予備費',goal:300000},{id:'car',name:'車両購入資金',goal:0}],
  bills:[],months:{},tx:[],monthly:30000,bonus:150000,payday:25,weeklyBuffer:0,
  savingMonths:{},intervalDays:7,rollovers:{},closingSnapshots:{}
};
const server = makeDemoServer(seed);
try {
  const response = await fetch('./index.html', {cache:'no-store'});
  if (!response.ok) throw new Error('本体ソースを取得できません');
  const source = await response.text();
  for (const id of ['A','B']) {
    const values = new Map();
    let tail = Promise.resolve();
    const engine = makeSyncEngine({
      ownerId:'550e8400-e29b-41d4-a716-446655440000',
      storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},
      transport:server.connection(),
      withLock:(_key,action)=>{
        const next = tail.then(action);
        tail = next.catch(()=>{});
        return next;
      }
    });
    await engine.receiveInitial({confirmReceive:true});
    const section = document.createElement('section');
    section.className = 'device';
    const heading = document.createElement('h2');heading.textContent='端末 '+id;
    const sync = document.createElement('button');sync.textContent='端末'+id+'を同期';
    const status = document.createElement('p');status.className='status';status.setAttribute('role','status');
    const frame = document.createElement('iframe');frame.title='たくわえ検証端末'+id;
    section.append(heading,sync,status,frame);document.getElementById('frames').append(section);
    const bridge = createSyncAppBridge({engine,view:{
      replace:db=>frame.contentWindow.syncAppView?.replace(db),
      setBusy:value=>{frame.contentWindow.syncAppView?.setBusy(value);sync.disabled=value;}
    },onStatus:result=>{status.textContent=({saved_locally:'端末に保存しました',synced:'同期完了',conflict:'競合で停止。双方の変更を保持しています',save_failed:'保存に失敗したため停止しました'})[result.status]||result.reason||result.status;}});
    // Bind each frame directly, including programmatic closing actions.
    frame.onload=()=>{frame.contentWindow.syncAppSave=db=>bridge.save(db);};
    frame.srcdoc=buildSyncAppDocument(source,{db:engine.snapshot().localDb,baseUrl:new URL('./',location.href).href})
      .replace('parent.syncAppHost.save(structuredClone(db))','window.syncAppSave(structuredClone(db))');
    sync.addEventListener('click',()=>bridge.sync().catch(error=>{status.textContent=error.message;}));
    status.textContent='架空データの初回受信済み';
  }
  document.getElementById('ready').textContent='本体の操作画面で、架空データの同期を試せます。';
} catch(error) {
  document.getElementById('ready').textContent='起動を停止しました：'+error.message;
}
