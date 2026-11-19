import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Onboarding } from '../src/onboarding.mjs';
import { RouterState } from '../src/router-state.mjs';

function fixture(overrides={}) {
  const store=new RouterState(join(mkdtempSync(join(tmpdir(),'ba-onboarding-')),'state.sqlite'));
  const posts=[],connections=[],activations=[];
  const web={chat:{postMessage:async body=>{posts.push(body);return{ts:'1'};}},conversations:{open:async()=>({channel:{id:'D_OWNER'}})}};
  const o=new Onboarding({owner:'U_OWNER',team:'T_TEAM',bot:'U_BOT',origin:'http://127.0.0.1:49581',store,web,
    connect:async p=>{connections.push(p);return{url:'https://claude.com/cai/oauth/authorize?state=opaque',ready:new Promise(()=>{})};},
    activate:async p=>activations.push(p),...overrides});
  return{store,posts,connections,activations,o};
}
function action(token,user='U_OWNER',provider='claude'){return{team:{id:'T_TEAM'},user:{id:user},actions:[{action_id:`ba_connect_${provider}`,value:token}]};}
test('pilot offers two real provider choices only in the owner DM',async()=>{
  const f=fixture();
  assert.equal(await f.o.handleEvent({team_id:'T_TEAM',event:{type:'app_mention',user:'U_OTHER',channel:'C',text:'<@U_BOT> setup'}}),false);
  assert.equal(await f.o.handleEvent({team_id:'T_TEAM',event:{type:'app_mention',user:'U_OWNER',channel:'C',text:'<@U_BOT> setup'}}),true);
  assert.equal(f.posts[0].channel,'D_OWNER');
  assert.deepEqual(f.posts[0].blocks[1].elements.map(x=>x.text.text),['Codex','Claude Code']);
  assert.equal(new Set(f.posts[0].blocks[1].elements.map(x=>x.action_id)).size,2);
  assert.ok(f.posts[0].blocks[1].elements.every(x=>x.url.startsWith('http://127.0.0.1:49581/connect#')&&x.visible_to_user_ids[0]==='U_OWNER'));
  assert.equal(f.connections.length,0);f.store.close();
});
test('link needs authenticated Slack click; reused clicks cannot start a second login',async()=>{
  const f=fixture();await f.o.offer('D_OWNER');const token=f.posts[0].blocks[1].elements[1].value;
  assert.deepEqual(await f.o.begin(token),{status:'waiting'});
  assert.equal(f.o.authorize(action(token,'U_OTHER')),false);
  assert.equal(f.o.authorize({...action(token),team:{id:'T_OTHER'}}),false);
  assert.equal(f.o.authorize(action(token)),true);
  assert.equal((await f.o.begin(token)).status,'login');
  assert.equal((await f.o.begin(token)).status,'login');
  assert.deepEqual(f.connections,['claude']);f.store.close();
});
test('provider becomes default only after native login and worker verification',async()=>{
  let finish;
  const f=fixture({connect:async()=>({ready:new Promise(r=>finish=r)})});await f.o.offer('D_OWNER');
  const token=f.posts[0].blocks[1].elements[0].value;f.o.authorize(action(token,'U_OWNER','codex'));
  assert.equal((await f.o.begin(token)).status,'starting');assert.equal(f.activations.length,0);
  finish();await new Promise(r=>setImmediate(r));
  assert.deepEqual(f.activations,['codex']);assert.equal((await f.o.begin(token)).status,'complete');
  assert.equal(f.posts.length,2);f.store.close();
});
test('expired and unexpected auth links never activate a provider',async()=>{
  let now=1;
  const f=fixture({now:()=>now,connect:async()=>({url:'https://evil.example/login',ready:Promise.resolve()})});
  await f.o.offer('D_OWNER');const elements=f.posts[0].blocks[1].elements;
  f.o.authorize(action(elements[0].value,'U_OWNER','codex'));assert.equal((await f.o.begin(elements[0].value)).status,'failed');
  now=700000;assert.equal(f.o.authorize(action(elements[1].value)),false);
  await assert.rejects(f.o.begin(elements[1].value),/Expired/);assert.equal(f.activations.length,0);f.store.close();
});

test('local onboarding refuses remote origins and serves only a same-origin token POST',async()=>{
  const f=fixture({origin:'http://127.0.0.1:49582'});
  assert.throws(()=>new Onboarding({origin:'https://public.example'}),/loopback/);
  await f.o.start();
  try {
    const page=await fetch(f.o.origin+'/connect');assert.equal(page.status,200);assert.match(await page.text(),/history.replaceState/);
    const blocked=await fetch(f.o.origin+'/start',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'});
    assert.equal(blocked.status,400);
  } finally {f.o.close();f.store.close();}
});
