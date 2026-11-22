import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteTrial} from './sync-remote-trial.js';
import {makeDemoServer} from './sync-demo-server.js';
const owner='550e8400-e29b-41d4-a716-446655440000';
const db={initial:{s1:0},fundInitial:{},fundCategories:[],bills:[],months:{},tx:[]};
test('HTTPS trial adapter confines every write to fixtures and resumes after a lost update response',async()=>{
  const connection=makeDemoServer(db).connection();
  const values=new Map(),batches=[];let lost=false;
  const api={fetchRecords:()=>connection.fetchRows(),applyBatch:async(_token,batch)=>{
    batches.push(structuredClone(batch));
    assert.ok(batch.operations.every(op=>op.entity_type==='transaction'&&op.entity_id.startsWith('qa-v21-')&&op.payload.__takuwaeTrial));
    const result=await connection.applyBatch(batch);
    if(batch.operations.length===1&&!lost){lost=true;throw Error('response lost');}
    return result;
  }};
  const options={ownerId:owner,getAccessToken:async()=>'fake-token',storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},withLock:(_key,action)=>action(),api};
  const trial=createRemoteTrial(options);
  await assert.rejects(trial.run(),/response lost/);
  const result=await createRemoteTrial(options).run();assert.equal(result.passed.length,6);
  const updates=batches.filter(batch=>batch.operations.length===1);assert.equal(updates.length,2);assert.deepEqual(updates[0],updates[1]);
  const rows=await connection.fetchRows();assert.equal(rows.filter(row=>row.entity_type==='transaction').length,2);
  assert.ok(rows.filter(row=>row.entity_type==='transaction').every(row=>row.deleted_at));
  const count=batches.length;await trial.run();assert.equal(batches.length,count);
});
