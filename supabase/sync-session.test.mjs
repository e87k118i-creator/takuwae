import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncSession} from './sync-session.js';
import {fetchRecords,sendEmailOtp} from './sync-api.js';
import {MIGRATION_CONFIRMATION} from './first-import.js';
const owner='550e8400-e29b-41d4-a716-446655440000';
test('auth adapter is read-only until separate explicit write consent; close revokes local capability',async()=>{
 const data=new Map();let writes=0;
 const session=await createSyncSession({accessToken:'fake-token',storage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)},locks:{request:(_key,_opts,fn)=>fn()},api:{
  getAuthUser:async()=>({id:owner}),fetchRecords:async()=>[],applyBatch:async()=>{writes++;throw Error('test stopping before network')}
 }});
 const localDb={initial:{s1:1},fundInitial:{},fundCategories:[],bills:[],months:{},tx:[]};
 await session.engine.prepareInitialImport({localDb,confirmation:MIGRATION_CONFIRMATION,hasExternalBackup:true});
 assert.equal((await session.engine.sync()).status,'retry_later');assert.equal(writes,0);
 assert.throws(()=>session.enableWrites({ownerId:'other',confirmation:'このアカウントで同期の書き込みを有効にする'}));
 session.enableWrites({ownerId:owner,confirmation:'このアカウントで同期の書き込みを有効にする'});
 await session.engine.sync();assert.equal(writes,1);
 session.close();await session.engine.sync();assert.equal(writes,1);assert.equal(session.isWritable(),false);
});
test('single snapshot refuses truncated, missing-count, and unauthorized server responses',async()=>{
 let calls=0;
 await assert.rejects(fetchRecords('mock-access-token',{fetchImpl:async()=>{calls++;return {ok:true,headers:new Headers({'content-range':'0-999/1001'}),json:async()=>[]}}}),/一部だけ/);
 assert.equal(calls,1);
 await assert.rejects(fetchRecords('mock-access-token',{fetchImpl:async()=>({ok:true,headers:new Headers(),json:async()=>[]})}),/一部だけ/);
 await assert.rejects(fetchRecords('mock-access-token',{fetchImpl:async()=>({ok:false,status:401})}),/再ログイン/);
});
test('429 is actionable without sending any real email',async()=>{
 await assert.rejects(sendEmailOtp('nobody@example.invalid',{fetchImpl:async()=>({ok:false,status:429})}),/回数制限中/);
});
