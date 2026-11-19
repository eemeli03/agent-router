import test from 'node:test';import assert from 'node:assert/strict';
import {initializeWorker} from '../src/worker-readiness.mjs';
test('native account and reconciliation succeed before remote ready is announced',async()=>{
 const steps=[];await initializeWorker({codex:{start:async()=>steps.push('native')},waitForTransport:async()=>steps.push('transport'),agent:{ready:async()=>steps.push('account+reconcile')},setInitialized:()=>steps.push('admission'),announce:async()=>steps.push('remote-ready')});
 assert.deepEqual(steps,['native','transport','account+reconcile','admission','remote-ready']);
});
test('wrong native account or failed reconciliation never announces connected',async()=>{
 for(const reason of ['wrong account','reconciliation failed']){
  let announced=false,admitted=false;
  await assert.rejects(initializeWorker({codex:{start:async()=>{}},agent:{ready:async()=>{throw Error(reason);}},setInitialized:()=>{admitted=true;},announce:async()=>{announced=true;}}),new RegExp(reason));
  assert.equal(announced,false);assert.equal(admitted,false);
 }
});
