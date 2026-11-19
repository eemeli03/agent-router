import test from 'node:test';
import assert from 'node:assert/strict';
import { Claude } from '../src/claude.mjs';

const identity=async()=>({loggedIn:true,email:'owner@example.com',apiProvider:'firstParty'});
function fixture() {
  const queries=[];
  function query(args) {
    const messages=[],waiting=[];let ended=false;
    const stream={
      async next(){if(messages.length)return{value:messages.shift(),done:false};if(ended)return{done:true};return new Promise(r=>waiting.push(r));},
      [Symbol.asyncIterator](){return this;},
      accountInfo:async()=>({email:'owner@example.com'}),
      close(){ended=true;for(const r of waiting)r({done:true});},
      interrupt:async()=>{},
      emit(message){if(waiting.length)waiting.shift()({value:message,done:false});else messages.push(message);},
    };
    queries.push({args,stream});return stream;
  }
  return{queries,c:new Claude('/claude','/project','owner@example.com',{query,account:identity,getSessionInfo:async id=>({sessionId:id,cwd:'/project'})})};
}
const tick=()=>new Promise(r=>setImmediate(r));

test('Claude verifies the actual personal account before work',async()=>{
  const c=new Claude('/claude','/project','owner@example.com',{query:()=>{},account:async()=>({loggedIn:true,email:'other@example.com',apiProvider:'firstParty'})});
  await assert.rejects(c.start(),/account does not match/);
});
test('Claude preserves one native session and resumes it without a fork',async()=>{
  const f=fixture();await f.c.start();const events=[];f.c.on('message',m=>events.push(m));
  const {thread}=await f.c.call('thread/start',{developerInstructions:'Owner rules'});
  const t=await f.c.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'hello'}]});
  assert.equal(f.queries[0].args.options.sessionId,thread.id);
  assert.deepEqual(f.queries[0].args.options.settingSources,['user','project','local']);
  const input=await f.queries[0].args.prompt.next();assert.equal(input.value.message.content[0].text,'hello');
  f.queries[0].stream.emit({type:'assistant',uuid:'answer',session_id:thread.id,message:{content:[{type:'text',text:'Hi'}]}});
  f.queries[0].stream.emit({type:'result',session_id:thread.id,is_error:false});await tick();
  assert.equal(events.at(-1).params.turn.status,'completed');
  await f.c.call('thread/unsubscribe',{threadId:thread.id});
  await f.c.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'again'}]});
  assert.equal(f.queries[1].args.options.resume,thread.id);assert.equal(f.queries[1].args.options.forkSession,undefined);
  f.c.stop();
});
test('Claude tool approvals wait for the owner and never persist allow rules',async()=>{
  const f=fixture();await f.c.start();const events=[];f.c.on('message',m=>events.push(m));
  const {thread}=await f.c.call('thread/start',{});await f.c.call('turn/start',{threadId:thread.id,input:[]});
  const ac=new AbortController();const pending=f.queries[0].args.options.canUseTool('Bash',{command:'echo hi'},{signal:ac.signal});
  const request=events.at(-1);assert.equal(request.params.threadId,thread.id);
  f.c.answer(request.id,{decision:'accept'});
  assert.deepEqual(await pending,{behavior:'allow',updatedInput:{command:'echo hi'}});f.c.stop();
});
test('Claude asks questions with structured answers and fails a changed session ID',async()=>{
  const f=fixture();await f.c.start();const events=[];f.c.on('message',m=>events.push(m));
  const {thread}=await f.c.call('thread/start',{});await f.c.call('turn/start',{threadId:thread.id,input:[]});
  const ac=new AbortController();const pending=f.queries[0].args.options.canUseTool('AskUserQuestion',{questions:[{question:'Which?',header:'Choice',options:[]}]},{signal:ac.signal});
  const request=events.at(-1);assert.equal(request.method,'item/tool/requestUserInput');
  f.c.answer(request.id,{answers:{'0':{answers:['First']}}});
  assert.equal((await pending).updatedInput.answers['Which?'],'First');
  f.queries[0].stream.emit({type:'result',session_id:'other-session',is_error:false});await tick();
  assert.equal(events.at(-1).params.turn.status,'failed');f.c.stop();
});

test('Claude settles aborted questions and bridges MCP form and URL requests',async()=>{
  const f=fixture();const events=[];f.c.on('message',m=>events.push(m));await f.c.start();
  const {thread}=await f.c.call('thread/start',{});await f.c.call('turn/start',{threadId:thread.id,input:[]});
  const options=f.queries[0].args.options;
  const first=new AbortController();const pending=options.canUseTool('AskUserQuestion',{questions:[{question:'First?',options:[]}]},{signal:first.signal});
  const id=events.at(-1).id;first.abort();assert.equal((await pending).behavior,'deny');
  assert.equal(events.at(-1).method,'serverRequest/resolved');assert.equal(events.at(-1).params.requestId,id);
  const form=options.onElicitation({serverName:'example',mode:'form',message:'Choose',requestedSchema:{type:'object'}},{signal:new AbortController().signal});
  const request=events.at(-1);assert.equal(request.method,'mcpServer/elicitation/request');assert.equal(request.params.turnId,(await f.c.call('thread/turns/list',{threadId:thread.id})).data[0].id);
  f.c.answer(request.id,{action:'accept',content:{choice:'yes'}});assert.deepEqual(await form,{action:'accept',content:{choice:'yes'}});
  const cancel=new AbortController();const url=options.onElicitation({serverName:'example',mode:'url',url:'https://example.com',message:'Connect'},{signal:cancel.signal});cancel.abort();assert.deepEqual(await url,{action:'cancel'});f.c.stop();
});

test('Claude reopens the same native session after an idle stream ends',async()=>{
  const f=fixture();await f.c.start();const {thread}=await f.c.call('thread/start',{});
  await f.c.call('turn/start',{threadId:thread.id,input:[]});
  f.queries[0].stream.emit({type:'result',session_id:thread.id,is_error:false});await tick();
  f.queries[0].stream.close();await tick();assert.equal(f.c.sessions.get(thread.id).query,null);
  await f.c.call('turn/start',{threadId:thread.id,input:[]});assert.equal(f.queries.length,2);assert.equal(f.queries[1].args.options.resume,thread.id);f.c.stop();
});

test('Claude reports missing native history without creating a replacement',async()=>{
  const f=fixture();f.c.getSessionInfo=async()=>undefined;await f.c.start();
  await assert.rejects(f.c.call('thread/resume',{threadId:'saved-id'}),{code:'CLAUDE_SESSION_NOT_FOUND'});
  assert.equal(f.queries.length,0);assert.equal(f.c.sessions.size,0);f.c.stop();
});

test('Claude permits unloading a saved but unloaded session before resuming it',async()=>{
 const f=fixture();await f.c.start();
 assert.deepEqual(await f.c.call('thread/unsubscribe',{threadId:'saved-paused-session'}),{status:'unsubscribed'});
 assert.equal(f.queries.length,0);assert.equal(f.c.sessions.size,0);
 await f.c.call('thread/resume',{threadId:'saved-paused-session'});
 await f.c.call('turn/start',{threadId:'saved-paused-session',input:[]});
 assert.equal(f.queries[0].args.options.resume,'saved-paused-session');f.c.stop();
});
