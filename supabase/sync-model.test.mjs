import {encodeRecords, decodeRecords, diffRecords, validateTakuwae} from './sync-model.js';
import assert from 'node:assert/strict';
const base={
 initial:{s1:2000,r:1000},fundInitial:{repair:0},
 fundCategories:[{id:'repair',name:'修理予備費',goal:10000}],
 bills:[{id:'rent',name:'家賃',bank:'r'}],
 months:{'2026-11':{rent:{paid:true,amount:500}}},
 tx:[{id:'unique1',date:'2026-11-22',kind:'expense',amount:500,from:'r'}],
 monthly:30000,bonus:150000,payday:25,weeklyBuffer:0
};
const rows=[...encodeRecords(base).values()].map(r=>({...r,revision:1}));
const rehydrated=decodeRecords(rows);
assert.equal(rehydrated.initial.s1,2000);
assert.equal(rehydrated.months['2026-11'].rent.amount,500);
assert.equal(rehydrated.tx[0].id,'unique1');
const reorderedTx=structuredClone(base);
reorderedTx.tx=[
  {id:'later',date:'2026-11-22',kind:'expense',amount:20,from:'r'},
  {id:'earlier',date:'2026-11-22',kind:'expense',amount:10,from:'r'}
];
reorderedTx.bills=[{id:'second',name:'第二',bank:'r'},...base.bills];
reorderedTx.fundCategories=[{id:'car',name:'車',goal:0},...base.fundCategories];
const scrambled=[...encodeRecords(reorderedTx).values()]
  .map(r=>({...r,revision:1}))
  .reverse();
const restoredOrder=decodeRecords(scrambled);
assert.deepEqual(restoredOrder.tx.map(x=>x.id),['later','earlier']);
assert.deepEqual(restoredOrder.bills.map(x=>x.id),['second','rent']);
assert.deepEqual(restoredOrder.fundCategories.map(x=>x.id),['car','repair']);
assert.equal(rows.length,5);
assert.equal(diffRecords(new Map(rows.map(r=>[r.entity_type+':'+r.entity_id,r])),encodeRecords(base)).length,0);
const newLocal=structuredClone(base);newLocal.tx.push({id:'second',date:'2026-11-23',kind:'income',amount:100});
const changes=diffRecords(new Map(rows.map(r=>[r.entity_type+':'+r.entity_id,r])),encodeRecords(newLocal));
assert.equal(changes.length,2); // New transaction AND exact ordering metadata.
assert.equal(changes.find(c=>c.entity_type==='transaction').expected_revision,null);
const deleted=structuredClone(base);deleted.tx=[];
assert.equal(diffRecords(new Map(rows.map(r=>[r.entity_type+':'+r.entity_id,r])),encodeRecords(deleted)).filter(c=>c.deleted).length,1);
assert.throws(()=>validateTakuwae({...base,tx:[{id:''}]}));
assert.throws(()=>encodeRecords({...base,tx:[base.tx[0],base.tx[0]]}));
// Semantically identical JSONB should not appear modified if key order changes.
const reordered=structuredClone(base);
reordered.initial={r:1000,s1:2000};
assert.equal(diffRecords(new Map(rows.map(r=>[r.entity_type+':'+r.entity_id,r])),encodeRecords(reordered)).length,0);
// Never let a rogue settings row overwrite decoded transaction array.
assert.throws(()=>decodeRecords(rows.map(r=>r.entity_type==='setting'
  ? {...r,payload:{...r.payload,tx:[]}}:r)),/予約された項目/);
console.log('record codec tests passed');
