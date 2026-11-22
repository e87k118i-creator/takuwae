/** Authenticated HTTPS trial. All writes use uniquely named synthetic records. */
import {fetchRecords,applyBatch} from './sync-api.js';
export function createRemoteTrial({getAccessToken,ownerId,storage,withLock,randomUUID=()=>crypto.randomUUID(),api={fetchRecords,applyBatch}}) {
  const key='takuwae-sync-trial-v21:'+ownerId;
  const save=plan=>storage.setItem(key,JSON.stringify(plan));
  function load() {
    const raw=storage.getItem(key);
    if(raw) {
      const saved=JSON.parse(raw);
      if(saved.ownerId!==ownerId||saved.version!==1||typeof saved.prefix!=='string'
        ||!/^qa-v21-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.prefix))
        throw new Error('通信試験の保存情報が不正です。上書きせず停止します');
      return saved;
    }
    const plan={version:1,ownerId,prefix:'qa-v21-'+randomUUID(),stage:'new',
      batches:{insert:randomUUID(),update:randomUUID(),conflict:randomUUID(),cleanup:randomUUID()}};
    save(plan);return plan;
  }
  return {
    key,
    run:()=>withLock(key,async()=>{
      const plan=load();
      const id=name=>plan.prefix+'-'+name;
      const operation=(name,amount,revision,deleted=false)=>({entity_type:'transaction',entity_id:id(name),
        payload:{id:id(name),date:'2026-11-22',kind:'income',to:'s1',amount,category:'同期通信試験（架空）',__takuwaeTrial:plan.prefix},expected_revision:revision,deleted});
      const send=async(batch,operations)=>{
        if(operations.some(op=>op.entity_type!=='transaction'||!op.entity_id.startsWith(plan.prefix+'-')||op.payload.__takuwaeTrial!==plan.prefix))
          throw new Error('試験用以外の書き込みを拒否しました');
        return api.applyBatch(await getAccessToken(),{batchId:plan.batches[batch],operations});
      };
      const rows=async()=>{
        const all=await api.fetchRecords(await getAccessToken());
        return all.filter(row=>row.entity_type==='transaction'&&row.entity_id.startsWith(plan.prefix+'-'));
      };
      const assert=(condition,message)=>{if(!condition)throw new Error(message);};
      const next=stage=>{plan.stage=stage;save(plan);};
      const initial=[operation('a',123,null),operation('b',456,null)];
      if(plan.stage==='new') {
        const result=await send('insert',initial);assert(result.status==='applied','試験用の初回送信を確認できません');next('inserted');
      }
      if(plan.stage==='inserted') {
        const replay=await send('insert',initial);
        assert(replay.status==='applied'&&replay.records?.length===2,'同一送信の再実行を確認できません');
        const received=await rows();
        assert(received.length===2&&received.every(row=>row.revision===1&&!row.deleted_at)
          &&received.find(row=>row.entity_id===id('a'))?.payload.amount===123
          &&received.find(row=>row.entity_id===id('b'))?.payload.amount===456,'試験データの件数・内容が一致しません');
        next('checked');
      }
      if(plan.stage==='checked') {
        const result=await send('update',[operation('a',124,1)]);
        assert(result.status==='applied','試験用の更新を確認できません');
        const received=await rows();
        assert(received.find(row=>row.entity_id===id('a'))?.revision===2,'更新後の版番号が一致しません');next('updated');
      }
      if(plan.stage==='updated') {
        const result=await send('conflict',[operation('c',789,null),operation('a',999,1)]);
        assert(result.status==='conflict','古い版の変更が拒否されませんでした');
        const received=await rows();
        assert(!received.some(row=>row.entity_id===id('c'))&&received.find(row=>row.entity_id===id('a'))?.payload.amount===124,
          '競合時に一部の変更が反映されています');next('conflict_checked');
      }
      if(plan.stage==='conflict_checked') {
        const result=await send('cleanup',[operation('a',124,2,true),operation('b',456,1,true)]);
        assert(result.status==='applied','試験データの削除済み状態への変更を確認できません');
        const received=await rows();assert(received.length===2&&received.every(row=>!!row.deleted_at),'試験データの削除済み状態を確認できません');next('done');
      }
      assert(plan.stage==='done','認識できない試験状態です');
      return {passed:['登録と受信','二重送信の防止','更新','競合の拒否','一括変更の原子性','削除'],prefix:plan.prefix,batches:plan.batches};
    })
  };
}
