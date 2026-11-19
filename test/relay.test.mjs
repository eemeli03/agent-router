import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';

let script;
test.before(async()=>{script=(await build({entryPoints:['relay/worker.mjs'],bundle:true,write:false,format:'esm',platform:'neutral'})).outputFiles[0].text;});
const tick=()=>new Promise(r=>setImmediate(r));
test('actual Durable Object pins socket identity and routes only allowed methods',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-11-15',durableObjects:{RELAY:{className:'Relay',useSQLite:true}},bindings:{ROUTER_SECRET:'router-secret'},durableObjectsPersist:mkdtempSync(join(tmpdir(),'ba-relay-'))}));
 try{
  const denied=await mf.dispatchFetch('https://ba.test/ws/router',{headers:{upgrade:'websocket',authorization:'Bearer wrong'}});assert.equal(denied.status,401);
  const result=await mf.dispatchFetch('https://ba.test/ws/router',{headers:{upgrade:'websocket',authorization:'Bearer router-secret'}});assert.equal(result.status,101);const router=result.webSocket;router.accept();
  router.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.type==='request'){
   let response;if(m.method==='team/claim')response={registration:'00000000-0000-4000-8000-000000000001',owner:'U_ALICE',email:'a@example.test',provider:'codex'};
   else if(m.method==='plugin/pair')response={accepted:true};
   else if(m.method==='team/status')response={status:'authorized',provider:'codex'};
   else response={seen:m.method,...m.params};
   router.send(JSON.stringify({type:'response',id:m.id,result:response}));
  }});
  const duplicate=await mf.dispatchFetch('https://ba.test/ws/router',{headers:{upgrade:'websocket',authorization:'Bearer router-secret'}});assert.equal(duplicate.status,409);
  const body={token:'a'.repeat(64),deviceSecret:'b'.repeat(64)};
  const pair=await mf.dispatchFetch('https://ba.test/api/plugin-pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:body.token,provider:'codex',email:'a@example.test'})});assert.equal(pair.status,200);assert.deepEqual(await pair.json(),{accepted:true});
  const claim=await mf.dispatchFetch('https://ba.test/api/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(claim.status,200);
  const {registration}=await claim.json();
  const workerResponse=await mf.dispatchFetch(`https://ba.test/ws/worker?registration=${registration}`,{headers:{upgrade:'websocket',authorization:`Bearer ${body.deviceSecret}`}});assert.equal(workerResponse.status,101);
  const worker=workerResponse.webSocket;worker.accept();
  const send=(method,params)=>new Promise(resolve=>{const id=crypto.randomUUID();const listener=e=>{const m=JSON.parse(e.data);if(m.id===id){worker.removeEventListener('message',listener);resolve(m);}};worker.addEventListener('message',listener);worker.send(JSON.stringify({type:'request',id,method,params}));});
  const ready=await send('worker/ready',{email:'a@example.test',provider:'codex'});assert.equal(ready.result.registration,registration);
  const wrong=await send('team/claim',{});assert.equal(wrong.error,true);
  const installer=await mf.dispatchFetch('https://ba.test/api/installer',{method:'POST',headers:{'content-type':'application/json',origin:'https://ba.test'},body:JSON.stringify({token:body.token})});assert.equal(installer.status,200);assert.equal(installer.headers.get('content-type'),'application/zip');
  const badOrigin=await mf.dispatchFetch('https://ba.test/api/installer',{method:'POST',headers:{'content-type':'application/json',origin:'https://elsewhere.test'},body:JSON.stringify({token:body.token})});assert.equal(badOrigin.status,400);
  worker.close();router.close();await tick();
 }finally{await mf.dispose();}
});

test('stale hibernated connection is replaced while live duplicate stays protected',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-11-15',durableObjects:{RELAY:{className:'Relay',useSQLite:true}},bindings:{ROUTER_SECRET:'router-secret'},durableObjectsPersist:mkdtempSync(join(tmpdir(),'ba-stale-relay-'))}));
 try{
  const connect=()=>mf.dispatchFetch('https://ba.test/ws/router',{headers:{upgrade:'websocket',authorization:'Bearer router-secret'}});
  const first=await connect();assert.equal(first.status,101);const stale=first.webSocket;stale.accept();
  // Simulate a network half-open: the old peer never answers application probes.
  const replacementPromise=connect();await new Promise(r=>setTimeout(r,30));
  const concurrent=await connect();assert.equal(concurrent.status,409);
  const replaced=await replacementPromise;assert.equal(replaced.status,101);const live=replaced.webSocket;live.accept();
  let heartbeats=0;
  live.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.type==='request')live.send(JSON.stringify({type:'response',id:m.id,result:{alive:true}}));if(m.type==='pong')heartbeats++;});
  live.send(JSON.stringify({type:'ping',id:'heartbeat'}));await new Promise(r=>setTimeout(r,30));assert.equal(heartbeats,1);
  const duplicate=await connect();assert.equal(duplicate.status,409);
  const denied=await mf.dispatchFetch('https://ba.test/ws/router',{headers:{upgrade:'websocket',authorization:'Bearer wrong'}});assert.equal(denied.status,401);
  live.close();stale.close();
 }finally{await mf.dispose();}
});
