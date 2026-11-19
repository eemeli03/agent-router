import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {requestPluginPairing,completePluginPairing} from '../src/plugin-pairing.mjs';

test('native Setup needs no pasted ticket and waits for authenticated Slack approval',async()=>{
 const base=await mkdtemp(join(tmpdir(),'ba-plugin-pair-'));let token,checks=0;const logs=[];
 const options={origin:'https://ba.test',provider:'codex',email:'alice@example.test',base,log:m=>logs.push(m),sleep:async()=>{},fetchImpl:async(url,request)=>{
  const body=JSON.parse(request.body);
  if(url.pathname==='/api/plugin-pair'){token=body.token;assert.equal(body.email,'alice@example.test');return{ok:true};}
  assert.equal(body.token,token);return ++checks===1?{ok:false}:{ok:true,json:async()=>({provider:'codex',status:'authorized'})};
 }};
 const first=await requestPluginPairing(options);assert.equal(first.ticket,token);assert.equal(checks,2);assert.equal(logs[0],'Open the new message from your app in Slack and select Connect.');assert.equal(logs[0].includes(token),false);
 const original=token;await requestPluginPairing(options);assert.equal(token,original);
 await completePluginPairing({...options,ticket:original});
 await requestPluginPairing(options);assert.notEqual(token,original);assert.equal((await readdir(base)).filter(p=>p.startsWith('plugin-pairing-receipt-')).length,2);assert.equal((await readdir(base)).filter(p=>p.startsWith('plugin-pairing-before-')).length,1);
});
test('native Setup rejects a changed provider response and failed requests',async()=>{
 const base=await mkdtemp(join(tmpdir(),'ba-plugin-fail-'));
 await assert.rejects(requestPluginPairing({origin:'https://ba.test',provider:'codex',email:'alice@example.test',base,log:()=>{},fetchImpl:async url=>url.pathname==='/api/plugin-pair'?{ok:true}:{ok:true,json:async()=>({provider:'claude',status:'authorized'})}}),/provider mismatch/);
 await assert.rejects(requestPluginPairing({origin:'http://ba.test',provider:'codex',email:'alice@example.test',base}),/origin/);
});

test('an existing verified connection needs no second Slack approval instruction',async()=>{
 const logs=[];
 const result=await requestPluginPairing({origin:'https://ba.test',provider:'codex',email:'alice@example.test',base:await mkdtemp(join(tmpdir(),'ba-plugin-existing-')),log:x=>logs.push(x),fetchImpl:async url=>url.pathname==='/api/plugin-pair'?{ok:true}:{ok:true,json:async()=>({provider:'codex',status:'connected'})}});
 assert.equal(result.status,'connected');assert.deepEqual(logs,[]);
});

test('retrying a pending native attempt reuses its token and preserves its receipt',async()=>{
 const base=await mkdtemp(join(tmpdir(),'ba-plugin-pending-')),tokens=[];
 const options={origin:'https://ba.test',provider:'codex',email:'alice@example.test',base,log:()=>{}};
 await assert.rejects(requestPluginPairing({...options,fetchImpl:async(_url,request)=>{tokens.push(JSON.parse(request.body).token);return{ok:false};}}),/Could not request/);
 const result=await requestPluginPairing({...options,fetchImpl:async(url,request)=>{
  if(url.pathname==='/api/plugin-pair'){tokens.push(JSON.parse(request.body).token);return{ok:true};}
  return{ok:true,json:async()=>({provider:'codex',status:'authorized'})};
 }});
 assert.equal(tokens[0],tokens[1]);assert.equal(result.ticket,tokens[0]);
 assert.equal((await readdir(base)).filter(x=>x.startsWith('plugin-pairing-receipt-')).length,1);
});

test('upgrading the plugin resumes a legacy claimed setup, and only rotates a connected attempt',async()=>{
 for(const status of ['authorized','claimed','connected']){
  const base=await mkdtemp(join(tmpdir(),'ba-plugin-upgrade-')),oldToken='a'.repeat(64);
  const {createHash}=await import('node:crypto');const {writeFile}=await import('node:fs/promises');
  const saved={origin:'https://ba.test',provider:'codex',email:'alice@example.test',token:oldToken,expires:Date.now()+600000};
  const pointer=join(base,`plugin-pairing-${createHash('sha256').update(saved.origin+'\n'+saved.provider+'\n'+saved.email).digest('hex')}.json`);
  await writeFile(pointer,JSON.stringify(saved));let requested;
  const result=await requestPluginPairing({...saved,base,log:()=>{},fetchImpl:async(url,request)=>{
   if(url.pathname==='/api/plugin-pair'){requested=JSON.parse(request.body).token;return{ok:true};}
   return{ok:true,json:async()=>({provider:'codex',status})};
  }});
  assert.equal(result.ticket,requested);
  if(status==='connected')assert.notEqual(requested,oldToken);else{
   assert.equal(requested,oldToken);assert.equal(JSON.parse(await readFile(pointer,'utf8')).completed,undefined);
  }
 }
});
