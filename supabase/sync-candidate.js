/* Full app save/receive integration rehearsal. Simulation ONLY, no real transport. */
import {makeSyncEngine} from './sync-engine.js';
import {makeDemoServer} from './sync-demo-server.js';
const seed={initial:{s1:10000,r:5000,s2:0,cash:0,em:0},fundInitial:{repair:0,car:0},fundCategories:[{id:'repair',name:'修理予備費',goal:300000},{id:'car',name:'車両購入資金',goal:0}],bills:[],months:{},tx:[],monthly:30000,bonus:150000,payday:25,weeklyBuffer:0,savingMonths:{},intervalDays:7};
const server=makeDemoServer(seed),devices=new Map();
// One immutable next value per original save. Render receives data only AFTER
// durability succeeds; failed edits roll back to the last durable snapshot.
window.candidateCommit=(deviceId,next)=>{
 const d=devices.get(deviceId);if(!d)throw Error('検証端末がありません');
 d.queued=(d.queued||0)+1;d.busy=true;d.frame.contentWindow.candidateView?.setBusy(true);d.sync.disabled=true;
 d.saveTail=(d.saveTail||Promise.resolve()).then(async()=>{
  try{
   await d.engine.saveLocal(next,{expectedLocalDb:d.rendered});
   d.status.textContent='端末内の検証用保存に成功。同期ボタンで送信できます。';
  }catch(error){d.status.textContent='保存せず停止：'+error.message;}
  finally{
   d.rendered=d.engine.snapshot().localDb;
   if(--d.queued===0){
    d.frame.contentWindow.candidateView?.replace(d.rendered);d.busy=false;
    d.frame.contentWindow.candidateView?.setBusy(false);d.sync.disabled=false;
   }
  }
 });
 return d.saveTail;
};
function frameSource(source,deviceId,db){
 const literal=v=>JSON.stringify(v).replaceAll('<','\\u003c');
 source=source.replace("const KEY='takuwae-v1';","const KEY='unused-sync-candidate';");
 const load="let db;try{db=JSON.parse(localStorage.getItem(KEY))||fresh()}catch(e){db=fresh()}";
 const save='let save=()=>localStorage.setItem(KEY,JSON.stringify(db));';
 if(!source.includes(load)||!source.includes(save))throw Error('本体の保存処理が変わりました。変換せず停止します');
 source=source.replace(load,'let db='+literal(db)+';');
 source=source.replace(save,'let save=()=>{parent.candidateCommit('+literal(deviceId)+',structuredClone(db));};');
 // No PWA registration, installation metadata or app update actions in a frame.
 source=source.replace(/<link[^>]*rel="manifest"[^>]*>/g,'');
 source=source.replace(/<script>if\("serviceWorker"[\s\S]*?<\/script>/g,'');
 const adapter=`
window.candidateView={replace(value){db=structuredClone(value);render()},setBusy(value){document.body.inert=value},snapshot(){return structuredClone(db)}};
importData=async()=>alert('この検証画面では実データを取り込めません');
checkTakuwaeUpdate=async()=>alert('検証画面では本番の更新操作を行いません');
`;
 const end=source.lastIndexOf('</script>');if(end<0)throw Error('本体スクリプトを確認できません');
 source=source.slice(0,end)+adapter+source.slice(end);
 return source.replace('<head>','<head><base href="'+new URL('./',location.href).href+'">');
}
try{
 const response=await fetch('./index.html',{cache:'no-store'});if(!response.ok)throw Error('本体ソースを取得できません');
 const source=await response.text();
 for(const id of ['A','B']){
  const values=new Map();let tail=Promise.resolve();
  const d={busy:false,connection:server.connection()};
  d.engine=makeSyncEngine({ownerId:'550e8400-e29b-41d4-a716-446655440000',storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},transport:d.connection,withLock:(_key,fn)=>{const p=tail.then(fn);tail=p.catch(()=>{});return p}});
  await d.engine.receiveInitial({confirmReceive:true});d.rendered=d.engine.snapshot().localDb;
  const block=document.createElement('section');block.className='device';
  const heading=document.createElement('h2');heading.textContent='端末 '+id;block.append(heading);
  d.sync=document.createElement('button');d.sync.textContent='端末'+id+'を同期';block.append(d.sync);
  d.status=document.createElement('p');d.status.className='status';d.status.setAttribute('role','status');d.status.textContent='架空の初回受信済み';block.append(d.status);
  d.frame=document.createElement('iframe');d.frame.title='たくわえ検証端末'+id;block.append(d.frame);
  devices.set(id,d);document.getElementById('frames').append(block);
  d.frame.srcdoc=frameSource(source,id,d.rendered);
  d.sync.addEventListener('click',async()=>{
   if(d.busy)return;d.busy=true;d.sync.disabled=true;d.frame.contentWindow.candidateView?.setBusy(true);
   try{
    const result=await d.engine.sync();
    d.status.textContent=result.status==='synced'?'同期完了':result.status==='conflict'?'競合で停止。双方の変更を保持しています':'未送信を保持。再試行できます';
   }catch(error){d.status.textContent=error.message;}
   finally{d.rendered=d.engine.snapshot().localDb;d.frame.contentWindow.candidateView?.replace(d.rendered);d.busy=false;d.sync.disabled=false;d.frame.contentWindow.candidateView?.setBusy(false);}
  });
 }
 document.getElementById('ready').textContent='本体の操作画面で、架空データの同期を試せます。';
}catch(error){document.getElementById('ready').textContent='起動を停止しました：'+error.message;}
