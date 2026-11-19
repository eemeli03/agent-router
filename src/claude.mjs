import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const run=promisify(execFile);
export async function claudeAccount(binary) {
  try {
    const {stdout}=await run(binary,['auth','status','--json'],{timeout:15000,maxBuffer:64000});
    return JSON.parse(stdout);
  } catch(error) {
    try { return JSON.parse(error.stdout); } catch { throw new Error('Claude account check failed'); }
  }
}

class InputStream {
  queue=[]; waiter=null; closed=false;
  push(value){if(this.closed)throw new Error('Input stream closed');if(this.waiter){this.waiter({value,done:false});this.waiter=null;}else this.queue.push(value);}
  next(){if(this.queue.length)return Promise.resolve({value:this.queue.shift(),done:false});if(this.closed)return Promise.resolve({done:true});return new Promise(resolve=>this.waiter=resolve);}
  close(){this.closed=true;this.waiter?.({done:true});this.waiter=null;}
  [Symbol.asyncIterator](){return this;}
}

/** Thin adapter over the unmodified personal Claude Code runtime. */
export class Claude extends EventEmitter {
  sessions=new Map();requests=new Map();next=0;
  constructor(binary,cwd,email,{query,account=claudeAccount,getSessionInfo,instructions=''}={}) {
    super();Object.assign(this,{binary,cwd,email,query,account,getSessionInfo,instructions});
  }
  async start() {
    if(!this.query){const sdk=await import('@anthropic-ai/claude-agent-sdk');this.query=sdk.query;this.getSessionInfo=sdk.getSessionInfo;}
    await this.verifyAccount();
  }
  async verifyAccount() {
    const account=await this.account(this.binary);
    if(!account.loggedIn||account.email!==this.email||account.apiProvider!=='firstParty')throw new Error('Claude account does not match owner');
  }
  async call(method,p={}) {
    if(method==='account/read'){await this.verifyAccount();return{account:{type:'claude',email:this.email}};}
    if(method==='thread/start'){const id=randomUUID();this.sessions.set(id,{id,turn:null,status:'idle',started:false,instructions:p.developerInstructions});return{thread:{id,status:{type:'idle'}}};}
    const session=this.sessions.get(p.threadId);
    if(method==='thread/resume') {
      if(session)return{thread:{id:p.threadId,status:{type:session.status==='active'?'active':'idle'}}};
      const info=await this.getSessionInfo(p.threadId,{dir:this.cwd});
      if(!info||info.cwd!==this.cwd)throw Object.assign(new Error('Saved Claude session not found in owner project'),{code:'CLAUDE_SESSION_NOT_FOUND'});
      this.sessions.set(p.threadId,{id:p.threadId,turn:null,status:'idle',started:true,instructions:this.instructions});
      return{thread:{id:p.threadId,status:{type:'idle'}}};
    }
    // Unloading an already-unloaded saved session must not create or replay it.
    if(method==='thread/unsubscribe'&&!session)return{status:'unsubscribed'};
    if(!session)throw new Error('Unknown Claude session');
    if(method==='thread/name/set'){session.name=p.name;return{};}
    if(method==='thread/section/move')return{}; // Native Claude history is separate from Codex sidebar.
    if(method==='thread/read')return{thread:{id:session.id,status:{type:session.status}}};
    if(method==='thread/turns/list')return{data:session.turn?[session.turn]:[]};
    if(method==='thread/unsubscribe'){if(session.status==='active')throw new Error('Claude turn still active');session.query?.close();session.input?.close();session.query=null;return{status:'unsubscribed'};}
    if(method==='turn/start') {
      await this.verifyAccount();
      if(session.status==='active')throw new Error('Claude session already active');
      if(!session.query)await this.open(session);
      const turn={id:randomUUID(),status:'inProgress'};session.turn=turn;session.status='active';
      session.input.push(this.userMessage(session,p.input));
      return{turn};
    }
    if(method==='turn/steer') {
      if(session.turn?.id!==p.expectedTurnId||session.status!=='active')throw new Error('Claude turn changed');
      // Queue within the same native session; no parallel copy or new account.
      session.input.push(this.userMessage(session,p.input));return{turnId:session.turn.id};
    }
    if(method==='turn/interrupt') {
      if(session.turn?.id!==p.turnId||session.status!=='active')throw new Error('Claude turn changed');
      session.interrupted=true;await session.query.interrupt();return{};
    }
    throw new Error('Unsupported Claude operation');
  }
  userMessage(session,input){return{type:'user',message:{role:'user',content:input.map(i=>({type:'text',text:i.text}))},parent_tool_use_id:null,session_id:session.id,uuid:randomUUID()};}
  async open(session) {
    const input=new InputStream();session.input=input;
    session.query=this.query({prompt:input,options:{cwd:this.cwd,pathToClaudeCodeExecutable:this.binary,
      ...(session.started?{resume:session.id}:{sessionId:session.id}),
      systemPrompt:{type:'preset',preset:'claude_code',append:session.instructions??''},
      title:session.name,
      permissionMode:'default',settingSources:['user','project','local'],
      // Session history must never be cleaned up by the integration.
      settings:{cleanupPeriodDays:365000},
      canUseTool:(name,args,options)=>this.permission(session,name,args,options),
      onElicitation:(request,options)=>this.request(session,'mcpServer/elicitation/request',request,options,{kind:'elicitation'}),
      stderr:()=>{},
    }});
    const account=await session.query.accountInfo();
    if(account.email!==this.email){session.query.close();session.query=null;throw new Error('Claude runtime account does not match owner');}
    session.started=true;
    void this.consume(session);
  }
  permission(session,name,args,options) {
    const method=name==='AskUserQuestion'?'item/tool/requestUserInput':'item/commandExecution/requestApproval';
    const params=name==='AskUserQuestion'?{questions:args.questions.map((q,index)=>({...q,id:String(index)}))}:{tool:name,input:args};
    return this.request(session,method,params,options,{kind:'tool',name,args});
  }
  request(session,method,params,{signal},data) {
    const id=++this.next;
    return new Promise(resolve=>{
      const settle=result=>{
        if(!this.requests.delete(id))return;
        signal.removeEventListener('abort',abort);
        resolve(result);
        this.emit('message',{method:'serverRequest/resolved',params:{threadId:session.id,requestId:id}});
      };
      const abort=()=>settle(data.kind==='elicitation'?{action:'cancel'}:{behavior:'deny',message:'Request cancelled'});
      this.requests.set(id,{session,...data,settle});
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted||session.status!=='active'){abort();return;}
      this.emit('message',{id,method,params:{...params,threadId:session.id,turnId:session.turn.id}});
    });
  }
  cancelRequests(session) {
    for(const request of this.requests.values())if(request.session===session)request.settle(request.kind==='elicitation'?{action:'cancel'}:{behavior:'deny',message:'Request cancelled'});
  }
  async consume(session) {
    const query=session.query;
    try {
      for await(const message of query) {
        if(session.query!==query)break;
        if(message.session_id&&message.session_id!==session.id)throw new Error('Claude changed session identity');
        if(message.type==='assistant')for(const [index,part] of (message.message.content??[]).entries())if(part.type==='text'&&part.text)this.emit('message',{method:'item/completed',params:{threadId:session.id,item:{type:'agentMessage',id:`${message.uuid}:${index}`,text:part.text}}});
        if(message.type==='result'&&session.status==='active') {
          const status=session.interrupted?'interrupted':message.is_error?'failed':'completed';
          session.interrupted=false;session.status='idle';session.turn={...session.turn,status};
          this.cancelRequests(session);
          this.emit('message',{method:'turn/completed',params:{threadId:session.id,turn:session.turn}});
        }
      }
      if(session.query===query&&session.status==='active')throw new Error('Claude stream ended before result');
    } catch {
      if(session.query===query&&session.status==='active'){session.status='idle';session.turn={...session.turn,status:'failed'};this.emit('message',{method:'turn/completed',params:{threadId:session.id,turn:session.turn}});}
    } finally {
      query.close();
      if(session.query===query){session.query=null;session.input?.close();this.cancelRequests(session);}
    }
  }
  answer(id,result){
    const request=this.requests.get(id);if(!request)return;
    if(request.kind==='elicitation'){request.settle(['accept','decline','cancel'].includes(result.action)?result:{action:'decline'});return;}
    if(request.name==='AskUserQuestion'&&result.answers) {
      const answers=Object.fromEntries(request.args.questions.map((q,index)=>[q.question,result.answers[String(index)]?.answers?.join(', ')??'']));
      request.settle({behavior:'allow',updatedInput:{...request.args,answers}});return;
    }
    request.settle(result.decision==='accept'?{behavior:'allow',updatedInput:request.args}:{behavior:'deny',message:'Owner declined'});
  }
  reject(id){this.answer(id,{decision:'decline'});}
  stop(){for(const s of this.sessions.values()){s.input?.close();s.query?.close();}for(const id of this.requests.keys())this.reject(id);}
}
