import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {TeamOnboarding} from '../src/team-onboarding.mjs';
import {RouterState} from '../src/router-state.mjs';
import {Router} from '../src/router.mjs';
import {setupPrompt} from '../src/setup-prompt.mjs';

const marketplace='test-owner/test-repo',origin='https://relay.example.test';
const setupMessageText='Hi! Give this to your Codex or Claude Code agent👇\n\n```\n'+setupPrompt({marketplace,origin})+'\n```';
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const store=new RouterState(join(mkdtempSync(join(tmpdir(),'ba-team-')),'state.sqlite')),posts=[];
 const users={U_ALICE:{profile:{email:'alice@example.test'}},U_BOB:{profile:{email:'bob@example.test'}},U_EXT:{profile:{email:'outside@example.com'}},U_GUEST:{is_restricted:true,profile:{email:'guest@example.test'}}};
 const updates=[];
 const web={users:{lookupByEmail:async({email})=>{const found=Object.entries(users).find(([,u])=>u.profile.email===email);if(!found)throw Error('Not found');return{user:{id:found[0]}};},info:async({user})=>({user:users[user]})},conversations:{open:async({users})=>({channel:{id:'D_'+users}})},chat:{postMessage:async p=>{const ts=String(posts.length+1);posts.push({...structuredClone(p),ts});return{ts};},update:async p=>{updates.push(structuredClone(p));Object.assign(posts.find(m=>m.channel===p.channel&&m.ts===p.ts),structuredClone(p));return{ts:p.ts};}}};
 web.conversations.history=async({channel,oldest})=>({messages:posts.filter(p=>p.channel===channel&&p.ts===oldest).map(p=>({...structuredClone(p),user:'U_BOT'}))});
 const router=new Router({store,workers:[],team:'T_TEST',bot:'U_BOT',slack:{},dispatch:async()=>({accepted:true})});
 const onboarding=new TeamOnboarding({store,router,web,team:'T_TEST',bot:'U_BOT',origin,marketplace,domains:['example.test'],codexPluginUrls:{U_ALICE:'codex://plugins/router-codex?marketplacePath=%2FUsers%2Falice%2Fmarketplace.json'}});
 const event=(user='U_ALICE',ts='100')=>({team_id:'T_TEST',event:{type:'app_mention',user,channel:'C_MAIN',ts,text:'<@U_BOT> hello'}});
 return{store,posts,updates,users,web,router,onboarding,event};
}
async function legacyOffer(f,user='U_ALICE'){return f.onboarding.ensureCard({owner:user,email:f.users[user].profile.email});}
async function ticket(f,user='U_ALICE'){
 await legacyOffer(f,user);const element=f.posts.at(-1).blocks[1].elements[0];
 const body={team:{id:'T_TEST'},user:{id:user},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[{action_id:element.action_id,value:element.value}]};
 await f.onboarding.authorize(body);return{value:element.value,body};
}
test('new team member gets a copy instruction and the shared prompt in a native Slack code block',async()=>{
 const f=fixture();await f.onboarding.handleEvent(f.event());await f.onboarding.handleEvent(f.event());assert.equal(f.posts.length,1);assert.equal(f.posts[0].channel,'D_U_ALICE');
 assert.equal(f.posts[0].text,setupMessageText);assert.equal(f.posts[0].mrkdwn,true);assert.equal(f.posts[0].blocks,undefined);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_tickets').get().n,0);
 await f.onboarding.handleEvent(f.event('U_EXT'));await f.onboarding.handleEvent(f.event('U_GUEST'));assert.equal(f.posts.length,1);f.store.close();
});
test('legacy: Slack Codex button opens the native plugin page without a prompt or website',async()=>{
 const f=fixture();await legacyOffer(f);const [codex,claude]=f.posts[0].blocks[1].elements;
 const url=new URL(codex.url);assert.equal(url.protocol,'codex:');assert.equal(url.hostname,'plugins');assert.equal(url.pathname,'/router-codex');assert.equal(url.searchParams.get('marketplacePath'),'/Users/alice/marketplace.json');assert.equal(url.searchParams.has('prompt'),false);assert.equal(url.hash,'');
 assert.equal(claude.url,`${origin}/connect#${claude.value}`);
 assert.throws(()=>f.onboarding.status({token:codex.value}));
 await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[{action_id:codex.action_id,value:codex.value}]});
 assert.equal(f.onboarding.status({token:codex.value}).status,'authorized');f.store.close();
});
test('link cannot be claimed until its exact Slack owner clicks it',async()=>{
 const f=fixture();await legacyOffer(f);const e=f.posts[0].blocks[1].elements[0];
 assert.throws(()=>f.onboarding.status({token:e.value}));
 assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_BOB'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[{action_id:e.action_id,value:e.value}]}),false);
 assert.throws(()=>f.onboarding.status({token:e.value}));f.store.close();
});
test('claim is pinned to one device and native identity before registration; reconnect uses original registration',async()=>{
 const f=fixture(),{value}=await ticket(f);const deviceSecret='a'.repeat(64);
 const c=await f.onboarding.claim({token:value,deviceSecret});assert.equal(c.owner,'U_ALICE');assert.equal(f.router.workers.size,0);
 assert.equal((await f.onboarding.claim({token:value,deviceSecret})).registration,c.registration);
 await assert.rejects(f.onboarding.claim({token:value,deviceSecret:'b'.repeat(64)}));
 await assert.rejects(f.onboarding.ready(c.registration,{email:'bob@example.test',provider:'codex'}));
 assert.equal(f.router.workers.size,0);
 await f.onboarding.ready(c.registration,{email:c.email,provider:c.provider});
 assert.equal(f.router.workerFor('U_ALICE').registration,c.registration);
 await f.onboarding.ready(c.registration,{email:c.email,provider:c.provider});assert.equal(f.router.workers.size,1);assert.equal(f.posts.length,1);
 assert.equal((await f.onboarding.claim({token:value,deviceSecret})).registration,c.registration);
 const restored=new Router({store:f.store,workers:f.store.teamWorkers(),team:'T_TEST',bot:'U_BOT',slack:{},dispatch:()=>{}});
 assert.equal(restored.workerFor('U_ALICE').registration,c.registration);f.store.close();
});
test('new members never acquire another member thread or replace a connected provider',async()=>{
 const f=fixture(),{value}=await ticket(f);const c=await f.onboarding.claim({token:value,deviceSecret:'a'.repeat(64)});
 await f.onboarding.ready(c.registration,{email:c.email,provider:c.provider});
 f.router.admit(f.event('U_ALICE','200'));assert.equal(await f.onboarding.handleEvent({...f.event('U_BOB','201'),event:{...f.event('U_BOB','201').event,thread_ts:'200'}}),true);
 assert.equal(f.posts.length,1); // one offer, no status messages or Bob takeover
 await f.onboarding.handleEvent({...f.event('U_ALICE','300'),event:{...f.event('U_ALICE','300').event,text:'<@U_BOT> setup'}});
 await f.onboarding.requestPluginPair({email:'alice@example.test',provider:'codex',token:'4'.repeat(64)});
 const e=f.posts.at(-1).blocks.find(b=>b.type==='actions').elements.find(e=>e.action_id==='ba_team_codex');await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:f.posts.at(-1).ts},actions:[{action_id:e.action_id,value:e.value}]});
 assert.equal(f.onboarding.status({token:e.value}).status,'connected');
 await assert.rejects(f.onboarding.claim({token:e.value,deviceSecret:'b'.repeat(64)}),/Already claimed/);f.store.close();
});
test('expired ticket and revoked team membership cannot activate',async()=>{
 const f=fixture(),{value}=await ticket(f);const c=await f.onboarding.claim({token:value,deviceSecret:'a'.repeat(64)});f.users.U_ALICE.deleted=true;
 await assert.rejects(f.onboarding.ready(c.registration,{email:c.email,provider:c.provider}));
 f.store.db.prepare('UPDATE team_tickets SET expires=0 WHERE hash=?').run(hash(value));assert.throws(()=>f.onboarding.status({token:value}));f.store.close();
});

test('simultaneous retry of the same device claim returns the same registration',async()=>{
 const f=fixture(),{value}=await ticket(f);const args={token:value,deviceSecret:'c'.repeat(64)};
 const results=await Promise.all([f.onboarding.claim(args),f.onboarding.claim(args)]);
 assert.equal(results[0].registration,results[1].registration);f.store.close();
});

test('revoked member cannot dispatch or publish after enrollment, and revocation persists',async()=>{
 const f=fixture(),{value}=await ticket(f);const c=await f.onboarding.claim({token:value,deviceSecret:'d'.repeat(64)});await f.onboarding.ready(c.registration,{email:c.email,provider:c.provider});
 const worker=f.router.workers.get(c.registration);assert.equal(await f.onboarding.checkWorker(worker),true);
 f.users.U_ALICE.deleted=true;await assert.rejects(f.onboarding.checkWorker(worker));assert.equal(worker.enabled,false);
 const saved=f.store.teamWorkers().find(w=>w.registration===c.registration);assert.equal(saved.enabled,false);assert.equal(f.router.admit(f.event('U_ALICE','400')),false);
 await assert.rejects(f.onboarding.ready(c.registration,{email:c.email,provider:c.provider}));f.store.close();
});

test('cleared connection permits fresh installer and preserves old bindings',async()=>{
 const f=fixture();
 f.router.addWorker({owner:'U_ALICE',email:'alice@example.test',provider:'codex',registration:'old',endpoint:'/local.sock',secret:'secret',enabled:true,acceptingNew:false});
 const {value}=await ticket(f);assert.equal(f.onboarding.status({token:value}).status,'authorized');
 const c=await f.onboarding.claim({token:value,deviceSecret:'e'.repeat(64)});
 await f.onboarding.ready(c.registration,{email:c.email,provider:c.provider});
 assert.notEqual(c.registration,'old');assert.equal(f.router.workerFor('U_ALICE').registration,c.registration);f.store.close();
});

test('ordinary retired-owner thread replies bypass onboarding while explicit setup still opens it',async()=>{
 const f=fixture();const old={owner:'U_ALICE',email:'alice@example.test',provider:'codex',registration:'old',endpoint:'/local.sock',secret:'secret',enabled:true};
 f.router.addWorker(old);f.router.admit(f.event('U_ALICE','100'));
 old.acceptingNew=false;
 const follow={...f.event('U_ALICE','101'),event:{...f.event('U_ALICE','101').event,thread_ts:'100',text:'continue'}};
 assert.equal(await f.onboarding.handleEvent(follow),false);assert.equal(f.router.admit(follow),true);assert.equal(f.posts.length,0);
 assert.equal(await f.onboarding.handleEvent({...follow,event:{...follow.event,ts:'102',text:'setup'}}),true);assert.equal(f.posts.length,1);
 f.store.close();
});


test('plugin Setup pairs native email only after authenticated Slack owner approval',async()=>{
 const f=fixture();const token='f'.repeat(64);
 assert.deepEqual(await f.onboarding.requestPluginPair({email:'alice@example.test',provider:'codex',token}),{accepted:true});
 assert.equal(f.posts.length,1);assert.equal(f.posts[0].channel,'D_U_ALICE');
 assert.throws(()=>f.onboarding.status({token}));
 const button=f.posts[0].blocks[1].elements[0];assert.equal(button.url,undefined);assert.equal(button.confirm.confirm.text,'Connect');assert.equal(button.confirm.text.text,'Connect your Codex account to Agent Router?');assert.equal(button.value,token);
 assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_BOB'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[button]}),false);
 assert.throws(()=>f.onboarding.status({token}));
 await f.onboarding.requestPluginPair({email:'alice@example.test',provider:'codex',token});assert.equal(f.posts.length,1);
 await assert.rejects(f.onboarding.requestPluginPair({email:'bob@example.test',provider:'codex',token}),/identity mismatch/);
 await assert.rejects(f.onboarding.requestPluginPair({email:'alice@example.test',provider:'codex',token:'a'.repeat(64)}),/too recently/);
 assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[button]}),true);
 assert.equal(f.onboarding.status({token}).status,'authorized');
 const claim=await f.onboarding.claim({token,deviceSecret:'1'.repeat(64)});assert.equal(claim.owner,'U_ALICE');f.store.close();
});

test('plugin pairing refuses external members, guests and invalid requests without sending',async()=>{
 const f=fixture();for(const request of [{email:'outside@example.com',provider:'codex',token:'a'.repeat(64)},{email:'guest@example.test',provider:'codex',token:'a'.repeat(64)},{email:'alice@example.test',provider:'unknown',token:'a'.repeat(64)},{email:'alice@example.test',provider:'codex',token:'bad'}])await assert.rejects(f.onboarding.requestPluginPair(request));
 assert.equal(f.posts.length,0);f.store.close();
});


test('plugin confirmation retries a definite rejection and holds an unknown new-message send',async()=>{
 const f=fixture(),request={email:'alice@example.test',provider:'codex',token:'7'.repeat(64)};let calls=0;
 await f.onboarding.handleEvent(f.event());
 const post=f.web.chat.postMessage;
 f.web.chat.postMessage=async p=>{calls++;if(calls===1)throw Object.assign(Error('Rate limited'),{data:{ok:false,error:'ratelimited'}});return post(p);};
 await assert.rejects(f.onboarding.requestPluginPair(request));assert.equal(f.store.pluginPairDelivery(hash(request.token)),'failed');
 await f.onboarding.requestPluginPair(request);assert.equal(calls,2);assert.equal(f.posts.length,2);
 await f.onboarding.requestPluginPair(request);assert.equal(calls,2);f.store.close();
 const other=fixture();let attempts=0;other.web.chat.postMessage=async()=>{attempts++;throw Error('Connection lost');};
 await assert.rejects(other.onboarding.requestPluginPair(request));assert.equal(other.store.pluginPairDelivery(hash(request.token)),'unknown');
 await assert.rejects(other.onboarding.requestPluginPair(request),/unresolved/);assert.equal(attempts,1);other.store.close();
});

test('each new Setup sends a separate approval DM; pending retries and restart reuse it',async()=>{
 const f=fixture();await f.onboarding.handleEvent(f.event());
 const original=structuredClone(f.posts[0]);
 const request={email:'alice@example.test',provider:'codex',token:'9'.repeat(64)};
 await Promise.all([f.onboarding.requestPluginPair(request),f.onboarding.requestPluginPair(request)]);
 assert.equal(f.posts.length,2);assert.equal(f.updates.length,0);assert.deepEqual(f.posts[0],original);
 assert.ok(f.posts[1].text.includes('Connect your Codex'));assert.equal(f.posts[1].blocks[1].elements[0].text.text,'Connect');
 const restarted=new TeamOnboarding({store:f.store,router:f.router,web:f.web,team:'T_TEST',bot:'U_BOT',origin,marketplace,domains:['example.test']});
 await restarted.requestPluginPair(request);assert.equal(f.posts.length,2);
 f.store.db.prepare('UPDATE plugin_pair_requests SET created=0').run();
 await restarted.requestPluginPair({...request,token:'3'.repeat(64)});assert.equal(f.posts.length,3);assert.notEqual(f.posts[1].ts,f.posts[2].ts);f.store.close();
});

test('approval is bound to the latest request, exact DM and message, and authenticated owner',async()=>{
 const f=fixture();await legacyOffer(f);
 const old=structuredClone(f.posts[0].blocks[1].elements[0]);
 const request={email:'alice@example.test',provider:'codex',token:'8'.repeat(64)};
 await f.onboarding.requestPluginPair(request);
 const current=f.posts.at(-1).blocks[1].elements[0];
 const click=e=>({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:f.posts[1].ts},actions:[e]});
 assert.equal(await f.onboarding.authorize({...click(old),message:{ts:'1'}}),false);
 assert.equal(await f.onboarding.authorize({...click(current),message:{ts:'1'}}),false);
 assert.equal(await f.onboarding.authorize({...click(current),channel:{id:'D_U_BOB'}}),false);
 assert.equal(await f.onboarding.authorize({...click(current),user:{id:'U_BOB'}}),false);
 assert.throws(()=>f.onboarding.status({token:request.token}));
 assert.equal(await f.onboarding.authorize(click(current)),true);
 assert.equal(f.onboarding.status({token:request.token}).status,'authorized');
 f.store.db.prepare('UPDATE plugin_pair_requests SET created=0').run();
 await f.onboarding.requestPluginPair({...request,token:'6'.repeat(64)});
 assert.equal(await f.onboarding.authorize(click(current)),false);
 await assert.rejects(f.onboarding.requestPluginPair(request),/superseded/);f.store.close();
});

test('unknown initial prompt delivery is never retried as another Slack message',async()=>{
 const f=fixture();let sends=0;f.web.chat.postMessage=async()=>{sends++;throw Error('Connection lost');};
 await assert.rejects(f.onboarding.handleEvent(f.event()));
 await assert.rejects(f.onboarding.handleEvent(f.event('U_ALICE','101')),/unresolved/);
 assert.equal(sends,1);f.store.close();
});

test('legacy: aged setup refreshes expired buttons on the same card and Claude URL matches its approval',async()=>{
 const f=fixture();await legacyOffer(f);
 const old=f.posts[0].blocks[1].elements.map(e=>e.value);
 f.store.db.prepare('UPDATE team_tickets SET expires=0').run();
 await legacyOffer(f);
 assert.equal(f.posts.length,1);assert.equal(f.updates.length,1);
 const [codex,claude]=f.posts[0].blocks[1].elements;
 assert.notEqual(codex.value,old[0]);assert.notEqual(claude.value,old[1]);
 assert.equal(claude.url,`${origin}/connect#${claude.value}`);
 assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[claude]}),true);
 assert.equal(f.onboarding.status({token:claude.value}).status,'authorized');
 const request={email:'alice@example.test',provider:'claude',token:'2'.repeat(64)};
 await f.onboarding.requestPluginPair(request);
 const updated=f.posts.at(-1).blocks[1].elements[0];assert.equal(updated.value,request.token);assert.equal(updated.url,undefined);assert.equal(f.posts.length,2);
 f.store.close();
});

test('legacy: uncertain refresh reconciles before retrying and keeps the original card usable',async()=>{
 for(const applied of [false,true]){
  const f=fixture();await legacyOffer(f);
  f.store.db.prepare('UPDATE team_tickets SET expires=0').run();
  const update=f.web.chat.update;let calls=0;
  f.web.chat.update=async p=>{calls++;if(calls===1){if(applied)await update(p);throw Error('Connection lost');}return update(p);};
  await assert.rejects(legacyOffer(f),/Connection lost/);
  assert.ok(f.store.teamCardUpdate('U_ALICE'));
  await legacyOffer(f);
  assert.equal(f.posts.length,1);assert.equal(f.store.teamCardUpdate('U_ALICE'),null);
  assert.equal(calls,applied?1:2);
  const button=f.posts[0].blocks[1].elements[1];
  assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[button]}),true);
  assert.equal(f.onboarding.status({token:button.value}).status,'authorized');f.store.close();
 }
});

test('verified connection replaces only its own button with status in the same message',async()=>{
 const f=fixture(),{value}=await ticket(f);
 assert.equal(f.posts[0].blocks.find(b=>b.type==='context'),undefined);
 const claim=await f.onboarding.claim({token:value,deviceSecret:'c'.repeat(64)});
 await assert.rejects(f.onboarding.ready(claim.registration,{email:'bob@example.test',provider:'codex'}));
 assert.equal(f.posts[0].blocks.find(b=>b.type==='context'),undefined);
 await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider});
 await f.onboarding.flushConnectedCards();
 const card=f.posts[0];assert.equal(f.posts.length,1);
 assert.deepEqual(card.blocks.find(b=>b.type==='actions').elements.map(e=>e.text.text),['Claude Code']);
 assert.equal(card.blocks.find(b=>b.type==='context').elements[0].text,':white_check_mark: Codex connected');
 const updates=f.updates.length;
 await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider});await f.onboarding.flushConnectedCards();assert.equal(f.updates.length,updates);
 // The second provider still enrolls through the same message.
 const claude=card.blocks.find(b=>b.type==='actions').elements[0];
 await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[claude]});
 const cc=await f.onboarding.claim({token:claude.value,deviceSecret:'d'.repeat(64)});
 await f.onboarding.ready(cc.registration,{email:cc.email,provider:cc.provider});
 await f.onboarding.flushConnectedCards();
 assert.equal(f.posts.length,1);assert.equal(f.posts[0].blocks.some(b=>b.type==='actions'),false);
 assert.deepEqual(f.posts[0].blocks.filter(b=>b.type==='context').map(b=>b.elements[0].text),[':white_check_mark: Codex connected',':white_check_mark: Claude Code connected']);
 f.store.close();
});

test('uncertain connected rendering reconciles without another message or replacing the worker',async()=>{
 for(const applied of [false,true]){
  const f=fixture(),{value}=await ticket(f),claim=await f.onboarding.claim({token:value,deviceSecret:'e'.repeat(64)});
  const update=f.web.chat.update;let attempts=0;
  f.web.chat.update=async p=>{attempts++;if(attempts===1){if(applied)await update(p);throw Error('Connection lost');}return update(p);};
  assert.deepEqual(await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider}),{ready:true});
  await f.onboarding.flushConnectedCards();
  assert.equal(f.onboarding.status({token:value}).status,'connected');
  await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider});
  f.onboarding.nextCardAttempt=0;await f.onboarding.flushConnectedCards();
  assert.equal(attempts,applied?1:2);assert.equal(f.router.workers.size,1);assert.equal(f.posts.length,1);
  assert.equal(f.posts[0].blocks.find(b=>b.type==='context').elements[0].text,':white_check_mark: Codex connected');
  f.store.close();
 }
});

test('unavailable or deleted setup message never takes a verified worker offline',async()=>{
 const f=fixture(),{value}=await ticket(f),claim=await f.onboarding.claim({token:value,deviceSecret:'a'.repeat(64)});
 assert.deepEqual(await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider}),{ready:true});
 const history=f.web.conversations.history;
 for(const unavailable of [async()=>{throw Error('Slack unavailable');},async()=>({messages:[]})]){
  f.web.conversations.history=unavailable;f.onboarding.nextCardAttempt=0;
  await f.onboarding.flushConnectedCards();
  assert.equal(f.store.pendingCardStatuses().length,1);
  assert.deepEqual(await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider}),{ready:true});
  assert.equal(f.router.workers.get(claim.registration).enabled,true);
 }
 const restarted=new TeamOnboarding({store:f.store,router:f.router,web:f.web,team:'T_TEST',bot:'U_BOT',origin,marketplace,domains:['example.test']});
 f.web.conversations.history=history;await restarted.flushConnectedCards();
 assert.equal(f.store.pendingCardStatuses().length,0);assert.equal(f.posts.length,1);
 assert.equal(f.posts[0].blocks.find(b=>b.type==='context').elements[0].text,':white_check_mark: Codex connected');f.store.close();
});

test('reinstalled plugin recognizes its verified connection after the setup card changes',async()=>{
 const f=fixture(),request={email:'alice@example.test',provider:'codex',token:'5'.repeat(64)};
 await f.onboarding.requestPluginPair(request);
 const button=f.posts[0].blocks.find(b=>b.type==='actions').elements[0];
 await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[button]});
 const claim=await f.onboarding.claim({token:request.token,deviceSecret:'f'.repeat(64)});
 await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider});
 const replacement='3'.repeat(64);f.store.teamIssue({hash:hash(replacement),owner:'U_ALICE',email:request.email,provider:'codex',expires:Date.now()+600000});
 f.store.teamCardButton('U_ALICE','codex',hash(replacement));
 const updates=f.updates.length;
 assert.deepEqual(await f.onboarding.requestPluginPair(request),{accepted:true});
 assert.equal(f.onboarding.status({token:request.token}).status,'connected');assert.equal(f.updates.length,updates);
 f.router.disableWorker(claim.registration);await assert.rejects(f.onboarding.requestPluginPair(request),/no longer active/);f.store.close();
});

test('opening the plugin page never marks an existing connection as newly connected',async()=>{
 const f=fixture();
 f.router.addWorker({owner:'U_ALICE',email:'alice@example.test',provider:'codex',registration:'existing',endpoint:'relay:existing',secret:'secret',enabled:true});
 await legacyOffer(f);
 const button=f.posts[0].blocks.find(b=>b.type==='actions').elements[0];
 assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[button]}),true);
 assert.equal(f.onboarding.status({token:button.value}).status,'authorized');
 assert.equal(f.store.pendingCardStatuses().length,0);
 await f.onboarding.flushConnectedCards();
 assert.equal(f.posts[0].blocks.some(b=>b.type==='context'),false);
 assert.deepEqual(f.posts[0].blocks.find(b=>b.type==='actions').elements.map(e=>e.text.text),['Codex','Claude Code']);f.store.close();
});


test('an already connected provider gets a fresh approval DM without replacing its device or bindings',async()=>{
 for(const provider of ['codex','claude']){
  const f=fixture(),worker={owner:'U_ALICE',email:'alice@example.test',provider,registration:'existing',endpoint:'relay:existing',secret:'secret',enabled:true};
  f.router.addWorker(worker);f.router.admit(f.event('U_ALICE','previous-thread'));
  const binding={...f.store.binding('C_MAIN','previous-thread')};
  const request={email:worker.email,provider,token:'d'.repeat(64)};
  await f.onboarding.requestPluginPair(request);
  assert.equal(f.posts.length,1);assert.throws(()=>f.onboarding.status({token:request.token}));
  const button=f.posts[0].blocks[1].elements[0];
  const click={team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[button]};
  assert.equal(await f.onboarding.authorize(click),true);
  assert.equal(f.onboarding.status({token:request.token}).status,'connected');
  await f.onboarding.flushConnectedCards();
  assert.equal(f.posts[0].blocks.length,1);assert.equal(f.posts[0].text.split('\n')[0],provider==='codex'?':white_check_mark: Codex connected':':white_check_mark: Claude Code connected');
  const next={...request,token:'e'.repeat(64)};
  await f.onboarding.requestPluginPair(next);assert.equal(f.posts.length,2);
  assert.throws(()=>f.onboarding.status({token:next.token}));
  assert.equal(f.router.workers.size,1);assert.equal(f.router.workerFor('U_ALICE').registration,'existing');
  assert.deepEqual({...f.store.binding('C_MAIN','previous-thread')},binding);f.store.close();
 }
});

test('confirmation rendering retries the same message and never disconnects a verified worker',async()=>{
 const f=fixture(),request={email:'alice@example.test',provider:'codex',token:'d'.repeat(64)};
 f.router.addWorker({owner:'U_ALICE',email:request.email,provider:'codex',registration:'existing',endpoint:'relay:existing',secret:'secret',enabled:true});
 await f.onboarding.requestPluginPair(request);
 await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[f.posts[0].blocks[1].elements[0]]});
 const update=f.web.chat.update;let calls=0;
 f.web.chat.update=async p=>{calls++;await update(p);if(calls===1)throw Error('Connection lost');return{ts:p.ts};};
 await f.onboarding.flushConnectedCards();assert.equal(f.store.pendingCardStatuses().length,1);
 assert.equal(f.router.workers.get('existing').enabled,true);
 f.onboarding.nextCardAttempt=0;await f.onboarding.flushConnectedCards();
 assert.equal(calls,2);assert.equal(f.posts.length,1);assert.equal(f.store.pendingCardStatuses().length,0);f.store.close();
});

test('an uncertain legacy card update reconciles without posting a second approval',async()=>{
 const f=fixture(),request={email:'alice@example.test',provider:'codex',token:'f'.repeat(64)},key=hash(request.token);
 await legacyOffer(f);
 f.store.reservePluginPairing({hash:key,owner:'U_ALICE',email:request.email,provider:'codex',expires:Date.now()+600000});
 f.store.beginPluginPairDelivery(key);
 const card=f.store.teamCard('U_ALICE'),elements=await f.onboarding.cardElements(card);elements[0].value=request.token;
 const update=f.web.chat.update;f.web.chat.update=async p=>{await update(p);throw Error('Connection lost');};
 await assert.rejects(f.onboarding.updateCard(card,elements,key));f.store.finishPluginPairDelivery(key,'unknown');
 assert.ok(f.store.teamCardUpdate('U_ALICE'));
 await f.onboarding.requestPluginPair(request);
 assert.equal(f.store.teamCardUpdate('U_ALICE'),null);assert.equal(f.store.pluginPairDelivery(key),'sent');assert.equal(f.posts.length,1);
 assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[elements[0]]}),true);f.store.close();
});

test('legacy: disconnect restores the original setup button before expiry and preserves old sessions',async()=>{
 const f=fixture(),{value}=await ticket(f),claim=await f.onboarding.claim({token:value,deviceSecret:'c'.repeat(64)});
 await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider});
 f.router.admit(f.event('U_ALICE','existing-thread'));
 const originalBinding={...f.store.binding('C_MAIN','existing-thread')};
 await f.onboarding.flushConnectedCards();assert.equal(f.posts[0].blocks.some(b=>b.type==='context'),true);
 const pairToken='e'.repeat(64);
 await f.onboarding.requestPluginPair({email:claim.email,provider:claim.provider,token:pairToken});
 const previousApproval={team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:f.posts.at(-1).ts},actions:[f.posts.at(-1).blocks[1].elements[0]]};
 await f.onboarding.authorize(previousApproval);
 const worker=f.router.workers.get(claim.registration);worker.acceptingNew=false;f.router.disableWorker(claim.registration);
 f.store.teamStatus(hash(value),'connected','revoked');
 f.store.teamStatus(hash(pairToken),'connected','revoked');
 assert.equal(await f.onboarding.authorize(previousApproval),false);
 await legacyOffer(f);
 const restored=f.posts[0].blocks.find(b=>b.type==='actions').elements.find(e=>e.action_id==='ba_team_codex');
 assert.ok(restored);assert.notEqual(restored.value,value);assert.ok(restored.url.startsWith('codex://plugins/router-codex'));
 assert.equal(f.posts[0].blocks.some(b=>b.type==='context'),false);assert.deepEqual({...f.store.binding('C_MAIN','existing-thread')},originalBinding);
 assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'1'},actions:[restored]}),true);
 const next=await f.onboarding.claim({token:restored.value,deviceSecret:'d'.repeat(64)});
 await f.onboarding.ready(next.registration,{email:next.email,provider:next.provider});
 assert.notEqual(next.registration,claim.registration);assert.equal(f.router.workerFor('U_ALICE').registration,next.registration);
 assert.deepEqual({...f.store.binding('C_MAIN','existing-thread')},originalBinding);f.store.close();
});

test('the initial prompt stays unchanged when native Setup sends and completes its separate Connect message',async()=>{
 const f=fixture();await f.onboarding.handleEvent(f.event());const initial=structuredClone(f.posts[0]);
 assert.equal(f.store.teamCard('U_ALICE'),undefined);assert.equal(f.router.workers.size,0);
 const request={email:'alice@example.test',provider:'codex',token:'5'.repeat(64)};
 await f.onboarding.requestPluginPair(request);assert.equal(f.posts.length,2);
 assert.doesNotMatch(f.posts[1].text,/Summarize a document/);
 const button=f.posts[1].blocks[1].elements[0];
 assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_BOB'},channel:{id:'D_U_ALICE'},message:{ts:'2'},actions:[button]}),false);
 assert.equal(await f.onboarding.authorize({team:{id:'T_TEST'},user:{id:'U_ALICE'},channel:{id:'D_U_ALICE'},message:{ts:'2'},actions:[button]}),true);
 const claim=await f.onboarding.claim({token:request.token,deviceSecret:'a'.repeat(64)});
 await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider});await f.onboarding.flushConnectedCards();
 assert.deepEqual(f.posts[0],initial);assert.equal(f.posts.length,2);
 const welcome=f.posts[1].blocks[0].text.text;
 assert.match(welcome,/Codex connected/);
 assert.match(welcome,/Summarize a document/);
 assert.match(welcome,/Investigate a problem/);
 assert.match(welcome,/Help with a code change/);
 assert.match(welcome,/<@U_BOT>/);
 assert.equal(f.posts[1].blocks.length,1);f.store.close();
});

test('automatic retries reuse the prompt, while a new explicit setup request sends a fresh code block',async()=>{
 const f=fixture();await f.onboarding.handleEvent(f.event());await f.onboarding.handleEvent(f.event('U_ALICE','101'));assert.equal(f.posts.length,1);
 const explicit={...f.event('U_ALICE','102'),event:{...f.event('U_ALICE','102').event,text:'setup'}};
 await Promise.all([f.onboarding.handleEvent(explicit),f.onboarding.handleEvent(explicit)]);
 assert.equal(f.posts.length,2);assert.equal(f.posts[1].text,setupMessageText);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_tickets').get().n,0);f.store.close();
});

test('a definite prompt rejection can retry the same request without issuing any account capability',async()=>{
 const f=fixture();let count=0;const post=f.web.chat.postMessage;
 f.web.chat.postMessage=async body=>{if(++count===1)throw Object.assign(Error('Rejected'),{data:{ok:false,error:'ratelimited'}});return post(body);};
 await assert.rejects(f.onboarding.handleEvent(f.event()));await f.onboarding.handleEvent(f.event());
 assert.equal(count,2);assert.equal(f.posts.length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_tickets').get().n,0);f.store.close();
});

test('setup with an existing legacy card sends only a fresh prompt and preserves the old card and connection',async()=>{
 const f=fixture(),{value}=await ticket(f),claim=await f.onboarding.claim({token:value,deviceSecret:'c'.repeat(64)});
 await f.onboarding.ready(claim.registration,{email:claim.email,provider:claim.provider});await f.onboarding.flushConnectedCards();
 const original=structuredClone(f.posts[0]),card={...f.store.teamCard('U_ALICE')},tickets=f.store.db.prepare('SELECT COUNT(*) AS n FROM team_tickets').get().n;
 await f.onboarding.handleEvent({...f.event('U_ALICE','new-setup'),event:{...f.event('U_ALICE','new-setup').event,text:'setup'}});
 assert.equal(f.posts.length,2);assert.equal(f.posts[1].text,setupMessageText);assert.equal(f.posts[1].blocks,undefined);
 assert.deepEqual(f.posts[0],original);assert.deepEqual({...f.store.teamCard('U_ALICE')},card);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM team_tickets').get().n,tickets);assert.equal(f.router.workerFor('U_ALICE').registration,claim.registration);f.store.close();
});
