import test from 'node:test';
import assert from 'node:assert/strict';
import {createSlackEventHandler} from '../src/slack-events.mjs';
function fixture(){
 const calls=[],logs=[];
 const router={workers:new Map(),workerFor:()=>{calls.push('lookup');},admit:()=>calls.push('admit'),admitAction:()=>calls.push('action'),flush:async()=>calls.push('flush')};
 const deps={team:'T_TEST',router,store:{binding:()=>undefined},log:(...args)=>logs.push(args)};
 return{deps,calls,logs,ack:async()=>calls.push('ack')};
}
test('Connect is acknowledged before a pending membership check; transport receipt does not authorize work',async()=>{
 const f=fixture();let release;
 f.deps.teamOnboarding={authorize:async()=>{f.calls.push('verify');await new Promise(r=>release=r);return false;}};
 const pending=createSlackEventHandler(f.deps)({type:'interactive',body:{channel:{},message:{},actions:[{action_id:'ba_team_codex'}]},ack:f.ack});
 await new Promise(r=>setImmediate(r));assert.deepEqual(f.calls,['ack','verify']);
 release();await pending;assert.deepEqual(f.calls,['ack','verify','action','flush']);
});
test('membership failure still acknowledges Connect and logs no payload or error message',async()=>{
 const f=fixture();f.deps.teamOnboarding={authorize:async()=>{throw Object.assign(Error('private response body'),{code:'membership_check_failed'});}};
 await createSlackEventHandler(f.deps)({type:'interactive',body:{actions:[{action_id:'ba_team_codex'}]},ack:f.ack});
 assert.deepEqual(f.calls,['ack']);assert.deepEqual(f.logs,[['Slack envelope not admitted','interactive','Error','membership_check_failed']]);
});
test('bot, changed and senderless events are acknowledged without account lookup or model work',async()=>{
 for(const event of [{type:'message',bot_id:'B_BOT'},{type:'message',subtype:'message_changed',user:'U_ALICE'},{type:'message'}]){
  const f=fixture();await createSlackEventHandler(f.deps)({type:'events_api',body:{team_id:'T_TEST',event},ack:f.ack});
  assert.deepEqual(f.calls,['ack']);assert.deepEqual(f.logs,[]);
 }
});
test('human messages retain durable admission before acknowledgment',async()=>{
 const f=fixture();await createSlackEventHandler(f.deps)({type:'events_api',body:{team_id:'T_TEST',event:{type:'message',user:'U_ALICE',channel:'D_ALICE',ts:'1',text:'hello'}},ack:f.ack});
 assert.deepEqual(f.calls,['lookup','admit','ack','flush']);
});

test('ordinary owner decisions retain durable admission before acknowledgment',async()=>{
 const f=fixture();let release;
 f.deps.teamOnboarding={authorize:async()=>{f.calls.push('verify');await new Promise(r=>release=r);return false;}};
 const pending=createSlackEventHandler(f.deps)({type:'interactive',body:{channel:{},message:{},actions:[{action_id:'owner_approve'}]},ack:f.ack});
 await new Promise(r=>setImmediate(r));assert.deepEqual(f.calls,['verify']);
 release();await pending;assert.deepEqual(f.calls,['verify','action','ack','flush']);
});

test('team setup takes precedence over the legacy pilot for its owner',async()=>{
 const f=fixture();f.deps.pilotOwner='U_OWNER';
 f.deps.onboarding={handleEvent:async()=>{throw Error('Legacy offer must not run');}};
 f.deps.teamOnboarding={handleEvent:async()=>{f.calls.push('prompt');return true;}};
 await createSlackEventHandler(f.deps)({type:'events_api',body:{team_id:'T_TEST',event:{type:'message',user:'U_OWNER',channel:'D_OWNER',ts:'1',text:'setup'}},ack:f.ack});
 assert.deepEqual(f.calls,['prompt','ack']);assert.deepEqual(f.logs,[]);
});

test('already-issued pilot Connect approvals remain supported with team setup configured',async()=>{
 const f=fixture();f.deps.onboarding={authorize:()=>{f.calls.push('pilot approval');return true;}};
 f.deps.teamOnboarding={authorize:async()=>{throw Error('Pilot approval must retain its owner');}};
 await createSlackEventHandler(f.deps)({type:'interactive',body:{actions:[{action_id:'ba_connect_codex'}]},ack:f.ack});
 assert.deepEqual(f.calls,['pilot approval','ack','flush']);assert.deepEqual(f.logs,[]);
});
