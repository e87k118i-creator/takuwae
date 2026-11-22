import {makeSyncEngine} from './sync-engine.js';
import {makeDemoServer} from './sync-demo-server.js';
import {decodeRecords} from './sync-model.js';
const initial={initial:{s1:10000,r:5000},fundInitial:{repair:0},fundCategories:[{id:'repair',name:'架空の修理積立',goal:10000}],bills:[],months:{},tx:[],monthly:30000,bonus:0,payday:25,weeklyBuffer:0};
const server=makeDemoServer(initial),ownerId='550e8400-e29b-41d4-a716-446655440000';
const devices=[];
const labels={synced:'同期完了',retry_later:'未送信を保持して停止。再試行できます',conflict:'競合で停止。双方の記録を保持',saved_locally:'この端末に記録しました'};
function update(){
 for(const d of devices){
  const s=d.engine.snapshot();
  d.output.textContent=JSON.stringify({取引:s.localDb.tx,予備枠:s.localDb.weeklyBuffer,送信途中のバッチあり:!!s.pending,競合:s.conflict},null,2);
 }
 const db=decodeRecords(server.snapshot());
 document.getElementById('server').textContent=JSON.stringify({取引:db.tx,予備枠:db.weeklyBuffer},null,2);
}
async function run(d,action){
 const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{const result=await action();d.status.textContent=labels[result?.status]||result?.status||'完了';}
 catch(error){d.status.textContent=error.message;}
 finally{buttons.forEach(b=>b.disabled=false);update();}
}
try{
 for(const name of ['A（iPhone役）','B（iPad役）']){
  const storageData=new Map();const connection=server.connection();let tail=Promise.resolve();
  const d={name,connection,storage:{getItem:k=>storageData.get(k)??null,setItem:(k,v)=>storageData.set(k,v)}};
  const options={storage:d.storage,ownerId,transport:connection,withLock:(_key,fn)=>{const p=tail.then(fn);tail=p.catch(()=>{});return p}};
  d.engine=makeSyncEngine(options);await d.engine.receiveInitial({confirmReceive:true});
  const article=document.createElement('article');
  article.innerHTML='<h2></h2><label>入金額 <input class="amount" type="number" min="1" value="100"></label><button class="add">架空の入金を記録</button><label>予備枠 <input class="buffer" type="number" min="0" value="0"></label><button class="settings">予備枠を変更</button><hr><label><input class="offline" type="checkbox"> 通信断を再現</label><button class="drop">次の送信成功後に応答を紛失</button><button class="sync">この端末を同期</button><button class="reload">保存済み状態から再起動</button><p class="status" role="status">初回受信済み（架空データ）</p><pre></pre>';
  article.querySelector('h2').textContent=name;d.status=article.querySelector('.status');d.output=article.querySelector('pre');
  article.querySelector('.add').addEventListener('click',()=>run(d,async()=>{
   const amount=Number(article.querySelector('.amount').value);
   if(!Number.isSafeInteger(amount)||amount<1)throw Error('正の整数を入力してください');
   return d.engine.edit(db=>{db.tx.unshift({id:crypto.randomUUID(),date:'2026-11-22',kind:'income',to:'s1',amount,category:'架空入金 '+name});});
  }));
  article.querySelector('.settings').addEventListener('click',()=>run(d,async()=>{
   const value=Number(article.querySelector('.buffer').value);
   if(!Number.isSafeInteger(value)||value<0)throw Error('0以上の整数を入力してください');
   return d.engine.edit(db=>{db.weeklyBuffer=value;});
  }));
  article.querySelector('.offline').addEventListener('change',e=>connection.setOffline(e.target.checked));
  article.querySelector('.drop').addEventListener('click',()=>{connection.dropNextResponse();d.status.textContent='次の送信成功後、応答だけを紛失します';});
  article.querySelector('.sync').addEventListener('click',()=>run(d,()=>d.engine.sync()));
  article.querySelector('.reload').addEventListener('click',()=>{d.engine=makeSyncEngine(options);d.status.textContent='保存済み状態から再起動しました';update();});
  document.getElementById('devices').append(article);devices.push(d);
 }
 update();document.getElementById('global-status').textContent='準備完了。ネットワーク通信なしで検証できます。';
}catch(error){document.getElementById('global-status').textContent='検証環境を開けませんでした：'+error.message;}
