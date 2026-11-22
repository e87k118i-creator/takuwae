import assert from 'node:assert/strict';
import {encodeRecords} from './sync-model.js';
import {inspectFirstImport,firstImport,MIGRATION_CONFIRMATION} from './first-import.js';
const localDb={
 initial:{s1:1250,r:30},fundInitial:{repair:0},
 fundCategories:[{id:'repair',name:'修理',goal:25000}],
 bills:[{id:'rent',name:'家賃',bank:'r'}],
 months:{'2026-11':{rent:{amount:100,paid:false}}},
 tx:[{id:'tx-1',date:'2026-11-22',kind:'expense',amount:100,from:'s1'}],
 monthly:30000,bonus:150000,payday:25,weeklyBuffer:0
};
const rows=[...encodeRecords(localDb).values()].map(x=>({...x,revision:1,deleted_at:null}));
assert.equal(inspectFirstImport(localDb,[]).recordCount,5);
assert.throws(()=>inspectFirstImport(localDb,[rows[0]]),/既存データ/);
assert.throws(()=>inspectFirstImport(localDb,{error:1}));
let current=[];
const fetchRows=async()=>current;
const apply=async ({operations})=>{
 current=operations.map(x=>({
   entity_type:x.entity_type, entity_id:x.entity_id,
   payload:x.payload,revision:1,deleted_at:null
 }));
 return {status:'applied',records:current.length};
};
const params={localDb,confirmation:MIGRATION_CONFIRMATION,hasExternalBackup:true,
 fetchRows,apply,batchId:'550e8400-e29b-41d4-a716-446655440000'};
await assert.rejects(()=>firstImport({...params,hasExternalBackup:false}),/バックアップ/);
await assert.rejects(()=>firstImport({...params,confirmation:'はい'}),/確認操作/);
const result=await firstImport(params);
assert.equal(result.status,'verified');
assert.equal(result.transactionCount,1);
await assert.rejects(()=>firstImport(params),/既存データ/);
await assert.rejects(()=>firstImport({...params,fetchRows:async()=>[],
  apply:async()=>({status:'applied'}),batchId:'550e8400-e29b-41d4-a716-446655440001'
  }),/件数/);
console.log('first-import safety tests passed');
