import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function page(response){
 const html=await readFile(new URL('../relay/public/connect.html',import.meta.url),'utf8');
 const script=html.match(/<script>([\s\S]+)<\/script>/)[1];
 const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,{style:{},textContent:'',href:'',open:false});return nodes.get(id);};
 const requests=[],timers=[],copies=[],history=[];const ticket='b'.repeat(64);
 const context=vm.createContext({document:{getElementById:get,querySelector:()=>get('details')},location:{origin:'https://relay.example.test',hash:'#'+ticket},history:{replaceState:(...a)=>history.push(a)},navigator:{clipboard:{writeText:async text=>copies.push(text)}},fetch:async(url,options)=>{requests.push({url,options});return{ok:response.ok??true,json:async()=>response};},setTimeout:fn=>timers.push(fn),encodeURIComponent});
 vm.runInContext(script,context);await new Promise(resolve=>setImmediate(resolve));
 return{get,requests,timers,copies,history,ticket};
}

test('Codex handoff keeps the Slack ticket in a native setup prompt and never requests an installer',async()=>{
 const p=await page({provider:'codex',status:'authorized'});
 assert.equal(p.get('codex').style.display,'block');assert.equal(p.get('claude').style.display,'none');
 const url=new URL(p.get('open-codex').href);assert.equal(url.protocol,'codex:');assert.equal(url.hostname,'threads');assert.equal(url.pathname,'/new');
 const prompt=url.searchParams.get('prompt');assert.ok(prompt.includes('router-codex@agent-router'));assert.ok(prompt.includes('/connect#'+p.ticket));
 assert.ok(p.history[0].includes('/connect'));assert.deepEqual(p.requests.map(x=>x.url),['/api/status']);
 await p.get('copy').onclick();assert.equal(p.copies[0],prompt);
});
test('Claude handoff uses the operator marketplace and current relay',async()=>{
 const p=await page({provider:'claude',status:'claimed'});assert.equal(p.get('claude').style.display,'block');assert.equal(p.get('codex').style.display,'none');
 await p.get('copy-claude').onclick();assert.ok(p.copies[0].includes('router-claude@agent-router connect skill'));assert.ok(p.copies[0].includes('https://relay.example.test/connect#'+p.ticket));
});
test('connected and unknown-provider states never offer another installation',async()=>{
 const connected=await page({provider:'codex',status:'connected'});assert.equal(connected.get('install').style.display,'none');assert.equal(connected.timers.length,0);
 const invalid=await page({provider:'unknown',status:'authorized'});assert.equal(invalid.get('install').style.display,'none');assert.ok(invalid.get('status').textContent.includes('unavailable'));
});
