import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterState } from '../src/router-state.mjs';
import { Router } from '../src/router.mjs';

const workers=[
  {owner:'U_ALICE',email:'alice@example.com',provider:'codex',registration:'reg-alice',enabled:true},
  {owner:'U_BOB',email:'bob@example.com',provider:'codex',registration:'reg-bob',enabled:true},
];
function payload(user='U_ALICE',ts='100.001',extra={}) {
  return {team_id:'T_TEST',event:{type:'app_mention',user,channel:'C_SHARED',ts,text:'<@U_BOT> help',...extra}};
}
function fixture() {
  const store=new RouterState(join(mkdtempSync(join(tmpdir(),'shared-router-')),'router.sqlite'));
  const calls=[],posts=[];
  const router=new Router({store,workers,team:'T_TEST',bot:'U_BOT',dispatch:async(worker,kind,body)=>{calls.push({worker,kind,body});return{accepted:true};},slack:{react:async(...args)=>posts.push(args),post:async(...args)=>{posts.push(args);return'200.001';}}});
  return {store,calls,posts,router};
}

test('shared app routes actual authors to isolated registrations and persists the owner',async()=>{
  const f=fixture();
  try {
    assert.equal(f.router.admit(payload('U_ALICE')),true);
    assert.equal(f.router.admit(payload('U_BOB','101.001')),true);
    await f.router.flush();
    assert.deepEqual(f.calls.map(call=>call.worker.owner),['U_ALICE','U_BOB']);
    assert.equal(f.store.binding('C_SHARED','100.001').registration,'reg-alice');
    assert.equal(f.router.admit(payload('U_ALICE','100.002',{type:'message',thread_ts:'100.001',text:'follow up'})),true);
    assert.equal(f.router.admit(payload('U_BOB','100.003',{thread_ts:'100.001',text:'<@U_BOT> stop'})),false);
    assert.equal(f.router.admit(payload('U_OTHER','100.004',{text:'I am <@U_ALICE>'})),false);
    assert.equal(f.router.admit({...payload(),team_id:'T_OTHER'}),false);
    assert.equal(f.router.admit(payload('U_ALICE','100.005',{bot_id:'B_OTHER'})),false);
    assert.equal(f.router.admit(payload('U_ALICE','100.006',{subtype:'message_changed'})),false);
    await f.router.flush();
    assert.deepEqual(f.calls.map(call=>call.worker.owner),['U_ALICE','U_BOB','U_ALICE']);
  }finally{f.store.close();}
});

test('duplicate Slack deliveries dispatch once and unavailable workers retain input',async()=>{
  const f=fixture();
  try {
    f.router.admit(payload());f.router.admit(payload());await f.router.flush();await f.router.flush();
    assert.equal(f.calls.length,1);
    f.router.admit(payload('U_BOB','101.002'));
    f.router.dispatch=async()=>{throw new Error('Unavailable');};await f.router.flush();
    assert.equal(f.store.pending().length,1);
    f.router.dispatch=async(worker,kind,body)=>{f.calls.push({worker,kind,body});return{accepted:true};};
    await f.router.flush();assert.equal(f.store.pending().length,0);assert.equal(f.calls.length,2);
  }finally{f.store.close();}
});

test('thread provider and registration cannot be changed by configuration fallback',()=>{
  const f=fixture();
  try {
    f.router.admit(payload());
    assert.throws(()=>new Router({store:f.store,workers:[{...workers[0],registration:'another-account'}],team:'T_TEST',bot:'U_BOT'}),/original registration/);
    assert.throws(()=>new Router({store:f.store,workers:[{...workers[0],provider:'claude'}],team:'T_TEST',bot:'U_BOT'}),/original registration/);
    assert.throws(()=>new Router({store:f.store,workers:[{...workers[0],email:'bob@example.com'}],team:'T_TEST',bot:'U_BOT'}),/account cannot change/);
    assert.throws(()=>new Router({store:f.store,workers:[workers[0],workers[0]],team:'T_TEST',bot:'U_BOT'}),/Duplicate owner/);
    assert.throws(()=>new Router({store:f.store,workers,team:'T_OTHER',bot:'U_BOT'}),/another Slack app/);
  }finally{f.store.close();}
});

test('provider choice applies only to new threads and keeps original account bindings',async()=>{
  const store=new RouterState(join(mkdtempSync(join(tmpdir(),'ba-choice-')),'state.sqlite'));
  const dual=[workers[0],{...workers[0],provider:'claude',registration:'reg-alice-claude'}];
  const calls=[];const router=new Router({store,workers:dual,team:'T_TEST',bot:'U_BOT',dispatch:async(w)=>{calls.push(w.registration);return{accepted:true};},slack:{}});
  try {
    router.admit(payload());router.selectProvider('U_ALICE','claude');
    router.admit(payload('U_ALICE','102.001'));router.admit(payload('U_ALICE','100.002',{thread_ts:'100.001'}));
    await router.flush();
    assert.equal(store.binding('C_SHARED','100.001').registration,'reg-alice');
    assert.equal(store.binding('C_SHARED','102.001').registration,'reg-alice-claude');
    assert.equal(calls.filter(x=>x==='reg-alice').length,2);
    assert.throws(()=>router.selectProvider('U_BOB','claude'),/not registered/);
  }finally{store.close();}
});

test('approval action stays in its owner thread and is deduplicated',async()=>{
  const f=fixture();
  try {
    f.router.admit(payload());await f.router.flush();
    const action={team:{id:'T_TEST'},user:{id:'U_BOB'},channel:{id:'C_SHARED'},message:{thread_ts:'100.001'},actions:[{action_id:'owner_approve',value:'nonce',action_ts:'201.001'}]};
    assert.equal(f.router.admitAction(action),false);
    action.user.id='U_ALICE';assert.equal(f.router.admitAction(action),true);
    f.router.admitAction(action);await f.router.flush();
    assert.equal(f.calls.filter(call=>call.kind==='action').length,1);
  }finally{f.store.close();}
});

test('worker output cannot escape its thread and ambiguous send never repeats',async()=>{
  const f=fixture();
  try {
    f.router.admit(payload());
    const body={kind:'message',channel:'C_SHARED',root:'100.001',id:'uuid-one',text:'hello'};
    await assert.rejects(f.router.output(workers[1],body),/scope/);
    await f.router.output(workers[0],body);await f.router.output(workers[0],body);
    assert.equal(f.posts.length,1);
    await assert.rejects(f.router.output(workers[0],{...body,text:'changed'}),/unconfirmed/);
    await assert.rejects(f.router.output(workers[0],{kind:'reaction',channel:body.channel,root:body.root,ts:'another-message'}),/scope/);
    let sends=0;f.router.slack.post=async()=>{sends++;throw new Error('Timeout');};
    const uncertain={...body,id:'uuid-two'};
    await assert.rejects(f.router.output(workers[0],uncertain),/Timeout/);
    await assert.rejects(f.router.output(workers[0],uncertain),/unconfirmed/);
    assert.equal(sends,1);
  }finally{f.store.close();}
});

test('an unavailable owner cannot block another owner or reorder their own messages',async()=>{
  const f=fixture();
  try {
    for(let i=0;i<120;i++)f.router.admit(payload('U_ALICE',`100.${i}`));
    f.router.admit(payload('U_BOB','201.001'));
    f.router.dispatch=async(worker,kind,body)=>{
      f.calls.push({worker,kind,body});
      if(worker.owner==='U_ALICE')throw new Error('Offline');
      return{accepted:true};
    };
    await f.router.flush();
    assert.equal(f.calls.filter(call=>call.worker.owner==='U_ALICE').length,1);
    assert.equal(f.calls.filter(call=>call.worker.owner==='U_BOB').length,1);
    assert.equal(f.store.pendingFor('U_BOB').length,0);
  }finally{f.store.close();}
});

test('retired connection keeps existing sessions but new registration owns new threads',async()=>{
 const store=new RouterState(join(mkdtempSync(join(tmpdir(),'ba-retire-')),'state.sqlite'));
 const old={...workers[0],registration:'old',acceptingNew:true};
 let router=new Router({store,workers:[old],team:'T_TEST',bot:'U_BOT',slack:{},dispatch:async()=>({accepted:true})});
 router.admit(payload('U_ALICE','100.001'));store.selectProvider('U_ALICE','old');
 router=new Router({store,workers:[{...old,acceptingNew:false}],team:'T_TEST',bot:'U_BOT',slack:{},dispatch:async()=>({accepted:true})});
 assert.equal(router.workerFor('U_ALICE'),undefined);
 assert.equal(router.admit(payload('U_ALICE','101.001')),false);
 assert.equal(router.admit(payload('U_ALICE','100.002',{thread_ts:'100.001'})),true);
 router.addWorker({...old,registration:'new',acceptingNew:true});router.selectProvider('U_ALICE','codex');
 assert.equal(router.workerFor('U_ALICE').registration,'new');router.admit(payload('U_ALICE','102.001'));
 assert.equal(store.binding('C_SHARED','102.001').registration,'new');assert.equal(store.binding('C_SHARED','100.001').registration,'old');
 store.close();
});

test('senderless Slack metadata cannot reach the account-preference query',()=>{
 const f=fixture();try{
  assert.equal(f.router.workerFor(undefined),undefined);
  assert.equal(f.router.admit(payload(undefined,'100.001',{user:undefined})),false);
 }finally{f.store.close();}
});
