import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.mjs';
import { Agent, addressed } from '../src/agent.mjs';
const config={owner:'U_OWNER',team:'T_TEST',bot:'U_BOT',email:'owner@example.com',cwd:'/project',instructions:'Owner only'};
const message=(text='do work',extra={})=>({team_id:'T_TEST',event:{type:'message',channel_type:'im',user:'U_OWNER',channel:'D_1',ts:'100.001',text,...extra}});
function fixture(){
 const state=new State(join(mkdtempSync(join(tmpdir(),'personal-agent-test-')),'state.sqlite'));
 const calls=[];const posts=[];const reactions=[];const codex=new EventEmitter();let n=0;
 codex.call=async(method,params)=>{calls.push({method,params});if(method==='account/read')return{account:{type:'chatgpt',email:config.email}};if(method==='thread/start')return{thread:{id:`thread-${++n}`}};if(method==='thread/resume')return{thread:{id:params.threadId,status:{type:'idle'}}};if(method==='thread/turns/list')return{data:[]};if(method==='turn/start')return{turn:{id:`turn-${n}`}};return{};};
 codex.answer=(id,result)=>calls.push({method:'answer',id,result});codex.reject=id=>calls.push({method:'reject',id});codex.stop=()=>{};
 const slack={react:async(...a)=>reactions.push(a),post:async(...a)=>{posts.push(a);return `reply-${posts.length}`;}};
 const agent=new Agent({state,codex,slack,config});
 return{state,codex,calls,posts,reactions,agent};
}
test('only the owner can start, steer or answer a session, including shared threads',async()=>{
 const f=fixture();await f.agent.ready();
 assert.equal(addressed(message('work',{user:'U_OTHER'}),config,f.state),null);
 assert.equal(addressed({...message(),team_id:'T_OTHER'},config,f.state),null);
 assert.equal(addressed(message('work',{bot_id:'B_BOT'}),config,f.state),null);
 await f.agent.receive(message());await f.agent.serial;
 assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);
 await f.agent.receive(message('extra',{ts:'100.002',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.find(c=>c.method==='turn/steer').params.expectedTurnId,'turn-1');
 await f.agent.receive(message('extra',{ts:'100.002',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.filter(c=>c.method==='turn/steer').length,1);
 await f.agent.receive(message('intrude',{user:'U_OTHER',ts:'100.003',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.reactions.length,2);f.state.close();
});
test('new threads queue separately and continue the same Codex conversation',async()=>{
 const f=fixture();await f.agent.ready();
 await f.agent.receive(message());await f.agent.serial;
 await f.agent.receive(message('second',{ts:'101.001'}));await f.agent.serial;
 assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);
 await f.agent.onCodex({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
 assert.equal(f.calls.filter(c=>c.method==='thread/start').length,2);
 await f.agent.onCodex({method:'turn/completed',params:{threadId:'thread-2',turn:{id:'turn-2',status:'completed'}}});
 await f.agent.receive(message('follow up',{ts:'100.004',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.at(-2).method,'thread/resume');assert.equal(f.calls.at(-2).params.threadId,'thread-1');f.state.close();
});
test('approvals are bound to owner, channel, root and active turn',async()=>{
 const f=fixture();await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 await f.agent.onCodex({id:90,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:['echo','ok']}});
 const p=f.state.pendingPrompt('D_1:100.001');
 const body={team:{id:'T_TEST'},user:{id:'U_OTHER'},channel:{id:'D_1'},message:{thread_ts:'100.001'},actions:[{action_id:'owner_approve',value:p.nonce}]};
 await f.agent.action(body);assert.equal(f.calls.some(c=>c.method==='answer'),false);
 await f.agent.action({...body,user:{id:'U_OWNER'},channel:{id:'D_OTHER'}});assert.equal(f.calls.some(c=>c.method==='answer'),false);
 await f.agent.action({...body,user:{id:'U_OWNER'}});assert.deepEqual(f.calls.at(-1).result,{decision:'accept'});
 await f.agent.action({...body,user:{id:'U_OWNER'}});assert.equal(f.calls.filter(c=>c.method==='answer').length,1);f.state.close();
});
test('pause releases the session; uncertain submission never replays after restart',async()=>{
 const f=fixture();await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 await f.agent.receive(message('pause',{ts:'100.005',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.at(-1).method,'turn/interrupt');
 await f.agent.onCodex({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}}});
 assert.equal(f.state.getSession('D_1:100.001').status,'paused');assert.equal(f.calls.at(-1).method,'thread/unsubscribe');
 f.state.update('D_1:100.001',{thread:'thread-1',turn:'unknown',status:'active'});f.state.holdUncertain();
 assert.equal(f.state.getSession('D_1:100.001').status,'uncertain');
 await f.agent.receive(message('continue',{ts:'100.006',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);f.state.close();
});
test('outgoing receipts prevent duplicate messages',async()=>{
 const f=fixture();const s=f.state.session('D_1','100.001');
 await f.agent.post(s,'output-1','hello');await f.agent.post(s,'output-1','hello');
 assert.equal(f.posts.length,1);assert.match(f.posts[0][4],/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);f.state.close();
});
test('MCP prompt without a turn ID binds to the active turn and resolves once',async()=>{
 const f=fixture();await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 await f.agent.onCodex({id:91,method:'mcpServer/elicitation/request',params:{threadId:'thread-1',turnId:null,mode:'url',serverName:'example',message:'Connect account',url:'https://app.example.test/connect'}});
 const p=f.state.pendingPrompt('D_1:100.001');assert.equal(p.request.params.turnId,'turn-1');
 assert.match(f.posts.at(-1)[2],/https:\/\/app.example.test\/connect/);
 await f.agent.respond(p,'approve');assert.deepEqual(f.calls.at(-1).result,{action:'accept',content:null});
 await f.agent.onCodex({id:92,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:'echo ok'}});
 await f.agent.onCodex({method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:92}});
 assert.equal(f.state.pendingPrompt('D_1:100.001'),null);f.state.close();
});
test('file changes never receive a blind approval and stale buttons cannot approve',async()=>{
 const f=fixture();await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 await f.agent.onCodex({id:93,method:'item/fileChange/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'diff'}});
 assert.deepEqual(f.calls.at(-1).result,{decision:'decline'});assert.equal(f.state.pendingPrompt('D_1:100.001'),null);
 await f.agent.onCodex({id:94,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:'echo ok'}});
 const p=f.state.pendingPrompt('D_1:100.001');
 await f.agent.onCodex({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
 assert.equal(f.state.getPrompt(p.nonce),null);f.state.close();
});
test('unclassified input cannot be pumped as duplicate work or a pause command',async()=>{
 const f=fixture();await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 const input={id:'T_TEST:D_1:102.001',channel:'D_1',root:'100.001',ts:'102.001',text:'/pause'};
 f.state.insert(input);
 await f.agent.onCodex({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
 await f.agent.handle(input);
 assert.equal(f.state.getSession('D_1:100.001').status,'paused');
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);f.state.close();
});
test('one state file permits only one active runtime',async()=>{
 const {acquireLock}=await import('../src/lock.mjs');
 const path=join(mkdtempSync(join(tmpdir(),'ea-lock-test-')),'state.sqlite');
 const release=await acquireLock(path);
 await assert.rejects(acquireLock(path),/already running/);
 await release();
 const next=await acquireLock(path);await next();
});
test('long answers are delivered completely with individual receipts',async()=>{
 const f=fixture();const s=f.state.session('D_1','100.001');const text='a'.repeat(12500)+'final outcome';
 await f.agent.post(s,'long',text);await f.agent.post(s,'long',text);
 assert.equal(f.posts.length,2);assert.equal(f.posts.map(p=>p[2]).join(''),text);f.state.close();
});
test('plain approval text cannot select one of several pending requests',async()=>{
 const f=fixture();await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 for(const id of [100,101])await f.agent.onCodex({id,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:`echo ${id}`}});
 await f.agent.receive(message('approve',{ts:'100.008',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.filter(c=>c.method==='answer').length,0);
 assert.equal(f.state.pendingPrompts('D_1:100.001').length,2);f.state.close();
});

test('managed bridge leaves other desktop sessions and desktop-owned turns untouched',async()=>{
 const f=fixture();f.agent.config={...config,codexMode:'managed'};await f.agent.ready();
 await f.agent.onCodex({id:201,method:'item/commandExecution/requestApproval',params:{threadId:'desktop-only',turnId:'desktop-turn',command:'echo ok'}});
 assert.equal(f.calls.some(c=>c.method==='reject'||c.method==='answer'),false);
 await f.agent.receive(message());await f.agent.serial;
 await f.agent.onCodex({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
 await f.agent.onCodex({id:202,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'desktop-turn',command:'echo ok'}});
 assert.equal(f.calls.some(c=>c.method==='reject'||c.method==='answer'),false);
 assert.equal(f.state.pendingPrompts('D_1:100.001').length,0);f.state.close();
});

test('managed bridge steers and stops a desktop-started turn on the same mapped session',async()=>{
 const f=fixture();f.agent.config={...config,codexMode:'managed'};await f.agent.ready();
 f.state.session('D_1','100.001');f.state.update('D_1:100.001',{thread:'thread-1',status:'idle'});
 const call=f.codex.call;let active=true;
 f.codex.call=async(method,params)=>{
  if(method==='thread/resume'){f.calls.push({method,params});return{thread:{id:'thread-1',status:{type:active?'active':'idle'}}};}
  if(method==='thread/turns/list'){f.calls.push({method,params});return{data:[{id:'desktop-turn',status:active?'inProgress':'interrupted'}]};}
  return call(method,params);
 };
 await f.agent.onCodex({method:'turn/started',params:{threadId:'thread-1',turn:{id:'desktop-turn',status:'inProgress'}}});
 await f.agent.receive(message('change direction',{ts:'100.002',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.find(c=>c.method==='turn/steer').params.expectedTurnId,'desktop-turn');
 await f.agent.receive(message('stop',{ts:'100.003',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.find(c=>c.method==='turn/interrupt').params.turnId,'desktop-turn');
 assert.equal(f.calls.some(c=>c.method==='turn/start'),false);
 active=false;await f.agent.onCodex({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'desktop-turn',status:'interrupted'}}});
 assert.equal(f.state.getSession('D_1:100.001').status,'idle');f.state.close();
});

test('managed restart rejoins an already active turn instead of replaying uncertain input',async()=>{
 const f=fixture();f.agent.config={...config,codexMode:'managed'};
 f.state.session('D_1','100.001');f.state.update('D_1:100.001',{thread:'thread-1',turn:'desktop-turn',status:'active'});
 const call=f.codex.call;
 f.codex.call=async(method,params)=>{
  if(method==='thread/resume'){f.calls.push({method,params});return{thread:{id:'thread-1',status:{type:'active'}}};}
  if(method==='thread/turns/list'){f.calls.push({method,params});return{data:[{id:'desktop-turn',status:'inProgress'}]};}
  return call(method,params);
 };
 await f.agent.ready();
 assert.equal(f.agent.busy.turn,'desktop-turn');
 await f.agent.receive(message('pause',{ts:'100.003',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.find(c=>c.method==='turn/interrupt').params.turnId,'desktop-turn');
 assert.equal(f.calls.some(c=>c.method==='turn/start'),false);f.state.close();
});

test('managed full-diff and oversized approvals remain pending for the desktop client',async()=>{
 const f=fixture();f.agent.config={...config,codexMode:'managed'};await f.agent.ready();
 await f.agent.receive(message());await f.agent.serial;
 for(const request of[
  {id:301,method:'item/fileChange/requestApproval',params:{itemId:'diff'}},
  {id:302,method:'item/commandExecution/requestApproval',params:{command:'x'.repeat(2100)}},
  {id:303,method:'future/approval',params:{}},
 ])await f.agent.onCodex({...request,params:{...request.params,threadId:'thread-1',turnId:'turn-1'}});
 assert.equal(f.calls.some(c=>c.method==='reject'||c.method==='answer'),false);
 assert.equal(f.state.pendingPrompts('D_1:100.001').length,0);
 assert.equal(f.posts.filter(p=>p[2].includes('Codex')).length>=3,true);f.state.close();
});

test('managed reconciliation accepts a turn that completes between status and history reads',async()=>{
 const f=fixture();f.agent.config={...config,codexMode:'managed'};
 f.state.session('D_1','100.001');f.state.update('D_1:100.001',{thread:'thread-1',turn:'finished-turn',status:'active'});
 const call=f.codex.call;
 f.codex.call=async(method,params)=>{
  f.calls.push({method,params});
  if(method==='thread/resume')return{thread:{id:'thread-1',status:{type:'active'}}};
  if(method==='thread/turns/list')return{data:[{id:'finished-turn',status:'completed'}]};
  if(method==='thread/read')return{thread:{id:'thread-1',status:{type:'idle'}}};
  return call(method,params);
 };
 await f.agent.resumeManaged(f.state.getSession('D_1:100.001'));
 assert.equal(f.state.getSession('D_1:100.001').status,'idle');
 assert.equal(f.calls.some(c=>c.method==='turn/start'),false);
 f.codex.call=async(method)=>method==='thread/resume'||method==='thread/read'?{thread:{status:{type:'active'}}}:{data:[]};
 await assert.rejects(f.agent.resumeManaged(f.state.getSession('D_1:100.001')),/could not be identified/);
 f.state.close();
});

test('local worker releases finished sessions and does not take desktop-owned work',async()=>{
 const f=fixture();f.agent.config={...config,codexMode:'managed',releaseIdleThreads:true};await f.agent.ready();
 await f.agent.receive(message());await f.agent.serial;
 await f.agent.onCodex({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
 assert.equal(f.calls.at(-1).method,'thread/unsubscribe');
 const call=f.codex.call;
 f.codex.call=async(method,params)=>{
   if(method==='thread/resume')throw new Error('thread thread-1 already has an active writer');
   return call(method,params);
 };
 await f.agent.receive(message('stop',{ts:'100.005',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.some(c=>c.method==='turn/interrupt'),false);
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
 assert.match(f.posts.at(-1)[2],/currently open in Codex/);
 assert.equal(f.state.message('T_TEST:D_1:100.005').state,'done');
 f.state.close();
});

test('local restart leaves idle desktop sessions unloaded and continues serving other threads',async()=>{
 const f=fixture();f.agent.config={...config,codexMode:'managed',releaseIdleThreads:true};
 f.state.session('D_1','100.001');f.state.update('D_1:100.001',{thread:'desktop-thread',status:'idle'});
 await f.agent.ready();
 assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
 await f.agent.receive(message('new work',{ts:'101.001'}));await f.agent.serial;
 assert.equal(f.calls.filter(c=>c.method==='thread/start').length,1);f.state.close();
});

test('local paused input and no-work resume do not retain the writer',async()=>{
 const f=fixture();f.agent.config={...config,codexMode:'managed',releaseIdleThreads:true};
 f.state.session('D_1','100.001');f.state.update('D_1:100.001',{thread:'thread-1',status:'paused'});
 await f.agent.ready();
 await f.agent.receive(message('ordinary followup',{ts:'100.007',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
 assert.equal(f.calls.some(c=>c.method==='turn/start'),false);
 assert.match(f.posts.at(-1)[2],/paused/);
 await f.agent.receive(message('resume',{ts:'100.008',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
 assert.equal(f.calls.at(-1).method,'thread/unsubscribe');
 assert.equal(f.state.getSession('D_1:100.001').status,'idle');f.state.close();
});

test('local recovered queue refuses desktop-owned input and proceeds to other work',async()=>{
 const f=fixture();f.agent.config={...config,codexMode:'managed',releaseIdleThreads:true};
 f.state.session('D_1','100.001');f.state.update('D_1:100.001',{thread:'desktop-thread',status:'idle'});
 const input={id:'first',channel:'D_1',root:'100.001',ts:'100.005',text:'followup'};
 f.state.insert(input);f.state.messageState(input.id,'pending');
 f.state.insert({...input,id:'second',root:'101.001',ts:'101.001',text:'new work'});f.state.messageState('second','pending');
 const call=f.codex.call;
 f.codex.call=async(method,params)=>{
   if(method==='thread/resume'&&params.threadId==='desktop-thread')throw new Error('thread desktop-thread already has an active writer');
   return call(method,params);
 };
 await f.agent.ready();
 assert.equal(f.state.message('first').state,'done');
 assert.match(f.posts[0][2],/currently open in Codex/);
 assert.equal(f.state.message('second').state,'done');
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);f.state.close();
});

test('Slack sessions join the configured sidebar section without changing their work directory',async()=>{
 const f=fixture();f.agent.config={...config,sidebarSectionId:'ba-section'};
 f.state.session('D_1','99.001');f.state.update('D_1:99.001',{thread:'saved-thread',status:'idle'});
 await f.agent.ready();
 assert.deepEqual(f.calls.find(c=>c.method==='thread/section/move').params,{threadId:'saved-thread',sectionId:'ba-section'});
 await f.agent.receive(message());await f.agent.serial;
 const moved=f.calls.findIndex(c=>c.method==='thread/section/move'&&c.params.threadId==='thread-1');
 const started=f.calls.findIndex(c=>c.method==='turn/start');
 assert.ok(moved>0&&moved<started);
 assert.equal(f.calls.find(c=>c.method==='thread/start').params.cwd,'/project');
 assert.equal(f.calls.filter(c=>c.method==='thread/section/move').length,2);
 f.state.close();
});

test('a missing sidebar section cannot block or duplicate Slack work',async()=>{
 const f=fixture();f.agent.config={...config,sidebarSectionId:'missing-section'};
 const call=f.codex.call;
 f.codex.call=async(method,params)=>{
   if(method==='thread/section/move'){f.calls.push({method,params});throw new Error('Section not found');}
   return call(method,params);
 };
 await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
 assert.equal(f.state.message('T_TEST:D_1:100.001').state,'done');f.state.close();
});

test('Claude restart holds unfinished history without blocking another Slack thread',async()=>{
 const f=fixture();f.agent.config={...config,provider:'claude',codexMode:'managed',releaseIdleThreads:true};
 const call=f.codex.call;
 f.codex.call=async(method,p)=>method==='account/read'?{account:{type:'claude',email:config.email}}:call(method,p);
 f.state.session('D_1','99.001');f.state.update('D_1:99.001',{thread:'not-yet-created-natively',status:'starting'});
 await f.agent.ready();assert.equal(f.state.getSession('D_1:99.001').status,'uncertain');
 assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
 await f.agent.receive(message());await f.agent.serial;assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
 await f.agent.receive(message('try again',{ts:'99.002',thread_ts:'99.001'}));await f.agent.serial;
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);assert.equal(f.state.getSession('D_1:99.001').status,'uncertain');f.state.close();
});

test('Claude missing idle native history holds only that session',async()=>{
 const f=fixture();f.agent.config={...config,provider:'claude',codexMode:'managed',releaseIdleThreads:false};
 const call=f.codex.call;f.codex.call=async(method,p)=>{
  if(method==='account/read')return{account:{type:'claude',email:config.email}};
  if(method==='thread/resume')throw Object.assign(new Error('Missing history'),{code:'CLAUDE_SESSION_NOT_FOUND'});
  return call(method,p);
 };
 f.state.session('D_1','99.001');f.state.update('D_1:99.001',{thread:'missing',status:'idle'});
 await f.agent.ready();assert.equal(f.state.getSession('D_1:99.001').status,'uncertain');
 await f.agent.receive(message());await f.agent.serial;assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);f.state.close();
});

test('Claude oversized approvals are denied rather than stranded in Codex',async()=>{
 const f=fixture();f.agent.config={...config,provider:'claude',codexMode:'managed'};
 const call=f.codex.call;f.codex.call=async(method,p)=>method==='account/read'?{account:{type:'claude',email:config.email}}:call(method,p);
 await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 await f.agent.onCodex({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',tool:'Write',input:{content:'x'.repeat(2100)}}});
 assert.equal(f.calls.at(-1).method,'reject');assert.equal(f.calls.at(-1).id,900);assert.equal(f.state.pendingPrompts('D_1:100.001').length,0);
 assert.doesNotMatch(f.posts.at(-1)[2],/Codex/);f.state.close();
});

test('canceled question does not block the next question and answer',async()=>{
 const f=fixture();await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 const request=id=>({id,method:'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:'turn-1',questions:[{id:'0',question:'Which?',options:[]}]}});
 await f.agent.onCodex(request(901));await f.agent.onCodex({method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:901}});
 await f.agent.onCodex(request(902));await f.agent.receive(message('The next choice',{ts:'100.007',thread_ts:'100.001'}));await f.agent.serial;
 assert.deepEqual(f.calls.at(-1),{method:'answer',id:902,result:{answers:{'0':{answers:['The next choice']}}}});assert.equal(f.state.pendingPrompts('D_1:100.001').length,0);f.state.close();
});

test('Claude paused session can resume after worker restart and accept the next input',async()=>{
 const f=fixture();const {Claude}=await import('../src/claude.mjs');
 let queryArgs;
 const c=new Claude('/claude','/project',config.email,{
  account:async()=>({loggedIn:true,email:config.email,apiProvider:'firstParty'}),
  getSessionInfo:async id=>({sessionId:id,cwd:'/project'}),
  query:args=>{queryArgs=args;let finish;return{accountInfo:async()=>({email:config.email}),async *[Symbol.asyncIterator](){await new Promise(r=>finish=r);},close(){finish?.();}};},
 });
 await c.start();const a=new Agent({state:f.state,codex:c,slack:f.agent.slack,config:{...config,provider:'claude',codexMode:'managed',releaseIdleThreads:true}});
 f.state.session('D_1','100.001');f.state.update('D_1:100.001',{thread:'saved-paused-session',status:'paused'});
 await a.ready();await a.receive(message('pause',{ts:'100.002',thread_ts:'100.001'}));await a.serial;
 await a.receive(message('resume',{ts:'100.003',thread_ts:'100.001'}));await a.serial;
 assert.equal(f.state.getSession('D_1:100.001').status,'idle');assert.equal(queryArgs,undefined);
 await a.receive(message('new input',{ts:'100.004',thread_ts:'100.001'}));await a.serial;
 assert.equal(queryArgs.options.resume,'saved-paused-session');assert.equal(f.state.getSession('D_1:100.001').status,'active');
 c.stop();await new Promise(r=>setImmediate(r));await a.serial;f.state.close();
});

test('missing queued Claude history does not block the next valid queued thread at startup',async()=>{
 const f=fixture();f.agent.config={...config,provider:'claude',codexMode:'managed',releaseIdleThreads:true};
 const call=f.codex.call;f.codex.call=async(method,p)=>{
  if(method==='account/read')return{account:{type:'claude',email:config.email}};
  if(method==='thread/resume'&&p.threadId==='missing')throw Object.assign(new Error('Missing history'),{code:'CLAUDE_SESSION_NOT_FOUND'});
  return call(method,p);
 };
 f.state.session('D_1','99.001');f.state.update('D_1:99.001',{thread:'missing',status:'idle'});
 for(const [id,root,ts]of[['old','99.001','100.002'],['new','100.001','101.001']]){
  f.state.insert({id,channel:'D_1',root,ts,text:'pending request'});f.state.messageState(id,'pending');
 }
 await f.agent.ready();assert.equal(f.state.message('old').state,'uncertain');assert.equal(f.state.getSession('D_1:99.001').status,'uncertain');
 assert.equal(f.state.message('new').state,'done');assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);f.state.close();
});

test('new and continued sessions send only agent content without session ID notifications',async()=>{
 const f=fixture();await f.agent.ready();await f.agent.receive(message());await f.agent.serial;
 assert.equal(f.posts.length,0);
 await f.agent.onCodex({method:'item/completed',params:{threadId:'thread-1',item:{type:'agentMessage',id:'answer-1',text:'- **One:** answer'}}});
 assert.equal(f.posts.length,1);assert.equal(f.posts[0][2],'- **One:** answer');
 await f.agent.onCodex({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
 await f.agent.receive(message('continue',{ts:'100.002',thread_ts:'100.001'}));await f.agent.serial;
 assert.equal(f.posts.length,1);assert.equal(f.posts.some(p=>/session: thread-1/.test(p[2])),false);f.state.close();
});
