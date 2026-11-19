import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,statSync,writeFileSync } from 'node:fs';
import { listenPrivate,privateCall,sameSecret } from '../src/private-http.mjs';

test('private endpoint authenticates its worker and has no TCP listener',async()=>{
  const path=mkdtempSync('/tmp/slack-rpc-')+'/rpc.sock';
  const secret='a'.repeat(32);
  const server=await listenPrivate(path,async(route,body,auth)=>{
    if(!sameSecret(auth,`Bearer ${secret}`))throw new Error('Unauthorized');
    return {route,owner:body.owner};
  });
  try {
    assert.equal(server.address(),path);
    assert.equal(statSync(path).mode&0o777,0o660);
    await assert.rejects(privateCall(path,'/event','b'.repeat(32),{}),/rejected/);
    assert.deepEqual(await privateCall(path,'/event',secret,{owner:'U_ALICE'}),{route:'/event',owner:'U_ALICE'});
    await assert.rejects(listenPrivate(path,()=>({})),/already listening/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('private endpoint preserves a non-socket file at the configured address',async()=>{
  const path=mkdtempSync('/tmp/slack-rpc-')+'/preserved';writeFileSync(path,'keep');
  await assert.rejects(listenPrivate(path,()=>({})),/not owned/);
  assert.equal(statSync(path).size,4);
});
