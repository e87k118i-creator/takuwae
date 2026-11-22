/* In-memory simulator only: NO network, credentials, browser storage or real ledger. */
import {encodeRecords} from './sync-model.js';
import {canonical} from './sync-merge.js';
export function makeDemoServer(db) {
 let rows=[...encodeRecords(db).values()].map(r=>({...r,revision:1,deleted_at:null}));
 const receipts=new Map();
 const key=r=>r.entity_type+':'+r.entity_id;
 return {
  snapshot:()=>structuredClone(rows),
  connection(){
   let offline=false,drop=false;
   return {
    setOffline:v=>offline=!!v,dropNextResponse:()=>drop=true,
    async fetchRows(){if(offline)throw Error('検証用の通信断');return structuredClone(rows)},
    async applyBatch(batch){
     if(offline)throw Error('検証用の通信断');
     const prior=receipts.get(batch.batchId);
     if(prior) {
      if(prior.request!==canonical(batch.operations))throw Error('同じIDで異なる内容を再送しました');
      return structuredClone(prior.response);
     }
     const before=new Map(rows.map(r=>[key(r),r]));
     const conflicts=batch.operations.filter(op=>(before.get(key(op))?.revision??null)!==op.expected_revision);
     if(conflicts.length)return {status:'conflict',conflicts:structuredClone(conflicts)};
     const next=new Map(before),records=[];
     for(const op of batch.operations){
      const revision=(before.get(key(op))?.revision??0)+1;
      next.set(key(op),{entity_type:op.entity_type,entity_id:op.entity_id,payload:structuredClone(op.payload),revision,deleted_at:op.deleted?'deleted':null});
      records.push({entity_type:op.entity_type,entity_id:op.entity_id,revision,deleted:op.deleted});
     }
     rows=[...next.values()];
     const response={status:'applied',records};receipts.set(batch.batchId,{request:canonical(batch.operations),response:structuredClone(response)});
     if(drop){drop=false;throw Error('サーバー更新成功後、応答だけ紛失（検証）')}
     return response;
    }
   };
  }
 };
}
