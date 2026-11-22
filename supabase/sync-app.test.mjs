import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {buildSyncAppDocument} from './sync-app-frame.js';
import {createSyncAppBridge} from './sync-app-bridge.js';
import {makeSyncEngine} from './sync-engine.js';
import {makeDemoServer} from './sync-demo-server.js';
import {decodeRecords} from './sync-model.js';

const source = await fs.readFile(new URL('../index.html',import.meta.url),'utf8');
const seed = () => ({initial:{s1:100000,r:100000,s2:20000,cash:1000,em:0},fundInitial:{repair:20000,car:0},fundCategories:[{id:'repair',name:'修理予備費',goal:300000},{id:'car',name:'車両購入資金',goal:0}],bills:[{id:'rent',name:'家賃',bank:'r'}],months:{},tx:[],monthly:30000,bonus:0,payday:25,weeklyBuffer:0,savingMonths:{},intervalDays:7,rollovers:{},closingSnapshots:{}});
async function harness(day=22) {
  const data = new Map();
  const server = makeDemoServer(seed());
  let lock = Promise.resolve();
  const engine = makeSyncEngine({ownerId:'550e8400-e29b-41d4-a716-446655440000',storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)},transport:server.connection(),withLock:(_name,action)=>{const next=lock.then(action);lock=next.catch(()=>{});return next;}});
  await engine.receiveInitial({confirmReceive:true});
  const elements = new Map();
  const node = () => ({innerHTML:'',hidden:false,style:{setProperty(){}},getBoundingClientRect:()=>({height:50}),addEventListener(){},getContext:()=>new Proxy({}, {get:()=>()=>{}})});
  const document = {body:{inert:false},documentElement:node(),getElementById:id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);},querySelector:()=>null,addEventListener(){}};
  class Clock extends Date {constructor(...args){super(...(args.length?args:[`2026-11-${day}T12:00:00+09:00`]))}static now(){return new Clock().getTime()}}
  const statuses = [];
  let context;
  const view = {
    replace:db=>context.window.syncAppView.replace(db),
    setBusy:value=>{document.body.inert=value;}
  };
  const bridge = createSyncAppBridge({engine,view,onStatus:result=>statuses.push(result)});
  const window = {addEventListener(){}};
  context = vm.createContext({window,document,parent:{syncAppHost:{save:db=>bridge.save(db)}},Date:Clock,structuredClone,Intl,console,requestAnimationFrame(){},setTimeout,clearTimeout,alert:message=>{throw Error(message)},confirm:()=>true,FormData:class {constructor(form){return Object.entries(form.fields)}},localStorage:{getItem(){throw Error('legacy storage accessed')},setItem(){throw Error('legacy storage modified')}}});
  const html = buildSyncAppDocument(source,{db:seed(),baseUrl:'https://test.invalid/'});
  for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1],context);
  const run = code=>vm.runInContext(code,context);
  return {engine,server,bridge,run,document,statuses,context};
}

test('full app boots without legacy storage or startup saves, including closing day',async()=>{
  const h = await harness(24);
  assert.equal(h.statuses.length,0);
  assert.deepEqual(h.engine.snapshot().localDb,seed());
  h.run("setTab('bills')");
  assert.equal(JSON.stringify(h.run('db.months')),'{}');
  assert.equal(h.statuses.length,0);
});

test('real app handlers save income, salary, transfer, saving and withdrawal through the journal',async()=>{
  const h = await harness();
  const action = async code=>{h.run(code);await h.bridge.settled();};
  await action("quickSetAmount('123');quickRecord()");
  await action("ui.type='income';submitTx({preventDefault(){},target:{fields:{amount:'500',from:'s1',date:'2026-11-22',category:'テスト入金'}}})");
  await action("salary({preventDefault(){},target:{fields:{s1:'1000',r:'2000'}}})");
  await action("ui.type='transfer';submitTx({preventDefault(){},target:{fields:{amount:'300',from:'s1',to:'r',date:'2026-11-22'}}})");
  await action("ui.type='saving';submitTx({preventDefault(){},target:{fields:{amount:'400',from:'s1',to:'s2',purpose:'car',date:'2026-11-22'}}})");
  await action("ui.wd={fund:'repair',amount:'200',reason:'架空の修理',to:'s1'};commitWd()");
  assert.equal(h.engine.snapshot().localDb.tx.length,7);
  await h.bridge.sync();
  assert.deepEqual(decodeRecords(h.server.snapshot()),h.engine.snapshot().localDb);
});

test('bill amount typing retains DOM and atomic confirmation/cancellation includes ledger entry',async()=>{
  const h = await harness();
  h.run("setTab('bills')");
  h.document.getElementById('view').innerHTML='typing sentinel';
  h.run("changeBillAmount('rent','1');changeBillAmount('rent','12');changeBillAmount('rent','123')");
  await h.bridge.settled();
  assert.equal(h.document.getElementById('view').innerHTML,'typing sentinel');
  assert.equal(h.engine.snapshot().localDb.months['2026-11'].rent.amount,'123');
  h.run("confirmBill('rent',true)");await h.bridge.settled();
  let db=h.engine.snapshot().localDb;
  assert.equal(db.tx.length,1);assert.equal(db.months['2026-11'].rent.paid,true);
  h.run("confirmBill('rent',false)");await h.bridge.settled();
  db=h.engine.snapshot().localDb;
  assert.equal(db.tx.length,0);assert.equal(db.months['2026-11'].rent.paid,false);
});

test('history correction, settlement and cancellation share the durable save path',async()=>{
  const h = await harness();
  h.run("ui.type='expense';submitTx({preventDefault(){},target:{fields:{amount:'200',from:'r',date:'2026-11-22',category:'架空支出',method:'credit'}}})");
  await h.bridge.settled();
  h.run("settleTx(db.tx[0].id)");await h.bridge.settled();
  assert.equal(h.engine.snapshot().localDb.tx[0].settled,true);
  h.run("editTransaction({preventDefault(){},target:{fields:{amount:'250',from:'r',date:'2026-11-21',category:'訂正',note:'確認'}}},db.tx[0].id)");
  await h.bridge.settled();assert.equal(h.engine.snapshot().localDb.tx[0].amount,250);
  h.run("deleteTransaction(db.tx[0].id)");await h.bridge.settled();assert.equal(h.engine.snapshot().localDb.tx.length,0);
});

test('fund management, bill scheduling, settings and zero-saving confirmation are connected',async()=>{
  const h=await harness();
  const action=async code=>{h.run(code);await h.bridge.settled();};
  await action("addFund({preventDefault(){},currentTarget:{elements:{fundName:{value:'架空旅行'},fundGoal:{value:'1000'}}}})");
  assert.equal(h.engine.snapshot().localDb.fundCategories.length,3);
  await action("removeFund(db.fundCategories[2].id)");
  await action("addBill({preventDefault(){},target:{fields:{name:'架空固定費',bank:'s1'}}})");
  await action("ui.selected=[db.bills[1].id];scheduleDelete()");
  assert.equal(h.engine.snapshot().localDb.bills[1].end,'2026-12');
  await action("db.weeklyBuffer=500;db.initial.s1=90000;db.fundInitial.car=100;save()");
  await action("changeInterval(3)");
  await action("confirmZero('2026-10')");
  assert.equal(h.engine.snapshot().localDb.savingMonths['2026-10'],'zero');
  await action("undoZero('2026-10')");
  assert.equal(h.engine.snapshot().localDb.savingMonths['2026-10'],undefined);
  await h.bridge.sync();assert.deepEqual(decodeRecords(h.server.snapshot()),h.engine.snapshot().localDb);
});

test('compound rollover and cancellation preserve linked transactions together',async()=>{
  const h=await harness(25);
  h.run("commitRollover({preventDefault(){},currentTarget:{fields:{total:'1000',saving:'400',cash:'200',purpose:'car'}}})");
  await h.bridge.settled();let db=h.engine.snapshot().localDb;
  assert.equal(db.tx.length,2);assert.equal(db.rollovers['2026-11'].carry,400);
  await h.bridge.sync();
  h.run("cancelRollover('2026-11')");await h.bridge.settled();await h.bridge.sync();
  db=decodeRecords(h.server.snapshot());assert.equal(db.tx.length,0);assert.deepEqual(db.rollovers,{});
});

test('reset and backup replacement are blocked in the synchronized app',async()=>{
  const h=await harness();
  assert.throws(()=>h.run('resetAll()'),/初期化/);
  await assert.rejects(h.run('importData()'),/退避/);
  assert.equal(h.statuses.length,0);
});
test('a failed save cancels dependent queued edits and restores the durable ledger',async()=>{
  let current=seed();let writes=0;let rendered;let busy;
  const bridge=createSyncAppBridge({engine:{snapshot:()=>({localDb:structuredClone(current),conflict:null}),saveLocal:async()=>{writes++;throw Error('quota')}},view:{replace:db=>rendered=db,setBusy:value=>busy=value}});
  const first=seed();first.weeklyBuffer=1;
  const second=seed();second.weeklyBuffer=2;
  bridge.save(first);bridge.save(second);await bridge.settled();
  assert.equal(writes,1);assert.deepEqual(rendered,seed());assert.equal(busy,true);
  await bridge.recover();assert.equal(busy,false);
});
test('stale app display is rejected if another tab already saved changes',async()=>{
  const h=await harness();
  await h.engine.edit(db=>{db.weeklyBuffer=999;});
  h.run("quickSetAmount('50');quickRecord()");await h.bridge.settled();
  assert.equal(h.engine.snapshot().localDb.weeklyBuffer,999);
  assert.equal(h.engine.snapshot().localDb.tx.length,0);
  assert.equal(h.statuses.at(-1).status,'save_failed');
});
test('explicit closing and its two consecutive saves use the same durable path',async()=>{
  const h=await harness(24);
  h.run('snapshotOn24()');await h.bridge.settled();
  assert.equal(h.engine.snapshot().localDb.closingSnapshots['2026-11'].provisional,true);
  h.run('confirmClosingAmount(1000)');await h.bridge.settled();
  assert.equal(h.engine.snapshot().localDb.closingSnapshots['2026-11'].confirmed,true);
  h.run('reviseClosingAmount()');await h.bridge.settled();
  assert.equal(h.engine.snapshot().localDb.closingSnapshots['2026-11'].confirmed,false);
});
