import { createHash, randomUUID } from 'node:crypto';

export function addressed(payload, { owner, team, bot }, state) {
  const event = payload?.event;
  if (payload?.team_id !== team || event?.user !== owner || event.bot_id) return null;
  if (!['message', 'app_mention'].includes(event.type)) return null;
  if (event.subtype) return null;
  if (typeof event.text !== 'string' || typeof event.channel !== 'string' || typeof event.ts !== 'string') return null;
  const root=event.thread_ts ?? event.ts;
  const mention=new RegExp(`<@${bot}(?:\\|[^>]+)?>`, 'g');
  if (event.channel_type !== 'im' && !mention.test(event.text) && !state.hasSession(event.channel,root)) return null;
  const text=event.text.replace(mention,'').trim();
  if (!text) return null;
  return {id:`${team}:${event.channel}:${event.ts}`,channel:event.channel,root,ts:event.ts,text};
}

export class Agent {
  constructor({ state, codex, slack, config }) {
    Object.assign(this,{state,codex,slack,config});
    this.busy=null;
    this.pausing=new Set();
    this.pumping=false;
    this.serial=Promise.resolve();
    codex.on('message', message => {
      this.serial=this.serial.then(()=>this.onCodex(message)).catch(error=>this.failed(error));
    });
  }
  async ready() {
    this.state.holdUncertain();
    const {account}=await this.codex.call('account/read',{refreshToken:false});
    if(account?.type!==(this.config.provider==='claude'?'claude':'chatgpt')||account.email!==this.config.email) throw new Error('Agent account does not match owner');
    this.serial=this.serial.then(async()=>{
      for(const session of this.state.sessions()) if(session.thread) await this.groupThread(session.thread);
      if(this.config.codexMode==='managed') {
        for(const session of this.state.sessions()) if(session.thread) {
          if(this.config.provider==='claude'&&session.status==='uncertain')continue;
          if(this.config.releaseIdleThreads&&['idle','paused'].includes(session.status))continue;
          try {
            const resumed=await this.resumeManaged(session);
            await this.releaseIdle(resumed);
          }
          catch(error) { if(!this.config.releaseIdleThreads||!this.isOtherWriter(error))throw error; }
        }
      }
      for(const input of this.state.received()) await this.handle(input);
      await this.pump();
    });
    await this.serial;
  }
  async receive(payload) {
    const input=addressed(payload,this.config,this.state);
    if(!input||!this.state.insert(input)) return;
    this.serial=this.serial.then(()=>this.handle(input)).catch(error=>this.failed(error));
  }
  async handle(input) {
    if(this.state.message(input.id)?.state!=='received') return;
    let session=this.state.session(input.channel,input.root);
    await this.slack.react(input.channel,input.ts);
    if(this.config.codexMode==='managed'&&session.thread&&!(this.config.releaseIdleThreads&&['paused','uncertain'].includes(session.status))) {
      try { session=await this.resumeManaged(session); }
      catch(error) {
        if(!this.config.releaseIdleThreads||!this.isOtherWriter(error))throw error;
        // Desktop owns the same saved session. Do not start a second writer or
        // pretend that a stop/approval reached the desktop's active turn.
        await this.desktopOwnsInput(session,input);
        return;
      }
    }
    if(/^(?:\/?stop|\/?pause|keskeytä|tauko)$/i.test(input.text.trim())) {
      this.state.messageState(input.id,'done');
      this.state.cancelPending(session.channel,session.root);
      if(session.status==='active'&&session.turn) {
        if(/^(?:\/?pause|tauko)$/i.test(input.text.trim()))this.pausing.add(session.address);
        await this.codex.call('turn/interrupt',{threadId:session.thread,turnId:session.turn});
      } else if(session.thread&&session.status!=='uncertain') {
        await this.codex.call('thread/unsubscribe',{threadId:session.thread});
        this.state.update(session.address,{...session,status:'paused',turn:null});
      }
      return;
    }
    if(/^(?:\/?resume|jatka)$/i.test(input.text.trim())) {
      this.state.messageState(input.id,'done');
      if(session.status==='paused') this.state.update(session.address,{...session,status:'idle'});
      await this.releaseIdle(session);
      await this.pump();
      return;
    }
    const prompts=this.state.pendingPrompts(session.address);
    if(prompts.length) {
      this.state.messageState(input.id,'done');
      if(prompts.length===1&&['item/tool/requestUserInput','mcpServer/elicitation/request'].includes(prompts[0].request.method)&&prompts[0].request.params.mode!=='url') {
        await this.respond(prompts[0],input.text);
      } else {
        await this.post(session,`ambiguous:${input.id}`,'Use the buttons on the exact approval request. If several questions are open, answer them in Codex.');
      }
      return;
    }
    if(session.status==='active'&&session.turn) {
      if(this.config.provider==='claude') {
        this.state.messageState(input.id,'pending');
        return;
      }
      this.state.messageState(input.id,'submitting');
      await this.codex.call('turn/steer',{threadId:session.thread,expectedTurnId:session.turn,input:[{type:'text',text:input.text}]});
      this.state.messageState(input.id,'done');
      return;
    }
    if(session.status==='uncertain'||session.status==='paused') {
      this.state.messageState(input.id,'done');
      await this.post(session,`hold:${input.id}`,session.status==='paused'?'This session is paused. Write resume to continue here.':`The previous turn stopped without a confirmed result. Inspect this session in ${this.config.provider==='claude'?'Claude Code':'Codex'} before starting a new thread.`);
      return;
    }
    this.state.messageState(input.id,'pending');
    await this.pump();
  }
  async pump() {
    if(!this.busy)this.busy=this.state.sessions().find(session=>session.status==='active'&&session.turn)??null;
    if(this.pumping||this.busy) return;
    this.pumping=true;
    try {
      const input=this.state.next();
      if(!input) return;
      let session=this.state.session(input.channel,input.root);
      if(session.status==='uncertain') return;
      this.state.messageState(input.id,'submitting');
      if(!session.thread) {
        this.state.update(session.address,{...session,status:'starting'});
        const result=await this.codex.call('thread/start',{
          cwd:this.config.cwd,
          serviceName:'agent_router',
          developerInstructions:this.config.instructions,
        });
        session={...session,thread:result.thread.id};
        this.state.update(session.address,{...session,status:'starting'});
        await this.codex.call('thread/name/set',{threadId:session.thread,name:`Slack: ${input.text.slice(0,65)}`});
        await this.groupThread(session.thread);
      } else {
        if(this.config.codexMode==='managed') {
          try { session=await this.resumeManaged(session); }
          catch(error) {
            if(!this.config.releaseIdleThreads||!this.isOtherWriter(error))throw error;
            await this.desktopOwnsInput(session,input);
            this.pumping=false;
            await this.pump();
            return;
          }
          if(session.status==='active'&&session.turn) {
            await this.codex.call('turn/steer',{threadId:session.thread,expectedTurnId:session.turn,input:[{type:'text',text:input.text}]});
            this.state.messageState(input.id,'done');
            return;
          }
          if(session.status==='uncertain') {
            this.state.messageState(input.id,'uncertain');await this.releaseIdle(session);
            this.pumping=false;await this.pump();return;
          }
        } else await this.codex.call('thread/resume',{threadId:session.thread,excludeTurns:true});
      }
      this.state.update(session.address,{...session,status:'starting'});
      const result=await this.codex.call('turn/start',{threadId:session.thread,input:[{type:'text',text:input.text}]});
      this.busy={address:session.address,thread:session.thread,turn:result.turn.id};
      this.state.update(session.address,{...session,turn:result.turn.id,status:'active'});
      this.state.messageState(input.id,'done');
    } finally {this.pumping=false;}
  }
  adoptTurn(session,turn) {
    const active={...session,turn:turn.id,status:'active'};
    this.state.update(session.address,active);
    if(!this.busy||this.busy.address===session.address)this.busy={address:session.address,thread:session.thread,turn:turn.id};
    return active;
  }
  async resumeManaged(session) {
    if(this.config.provider==='claude'&&session.status==='uncertain')return session;
    let result;
    try {result=await this.codex.call('thread/resume',{threadId:session.thread,excludeTurns:true});}
    catch(error){
      if(this.config.provider!=='claude'||error.code!=='CLAUDE_SESSION_NOT_FOUND')throw error;
      const held={...session,status:'uncertain'};this.state.update(session.address,held);return held;
    }
    const page=await this.codex.call('thread/turns/list',{threadId:session.thread,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
    const turn=page.data?.[0];
    if(turn?.status==='inProgress')return this.adoptTurn(session,turn);
    if(result.thread.status.type==='active') {
      const current=await this.codex.call('thread/read',{threadId:session.thread});
      if(current.thread.status.type==='active')throw new Error('Active Codex turn could not be identified');
    }
    if(session.status==='active') {
      const status=turn?.status==='failed'?'uncertain':this.pausing.has(session.address)?'paused':'idle';
      this.pausing.delete(session.address);
      session={...session,turn:null,status};
      this.state.update(session.address,session);
      this.state.expirePrompts(session.address);
      if(this.busy?.address===session.address)this.busy=null;
    }
    return session;
  }
  isOtherWriter(error) { return /already has an active writer/.test(error?.message??''); }
  async groupThread(threadId) {
    if(!this.config.sidebarSectionId||this.config.provider==='claude')return;
    try {
      await this.codex.call('thread/section/move',{threadId,sectionId:this.config.sidebarSectionId});
    } catch {
      // Sidebar organization must not prevent or replay the user's task.
      // Startup retries only our own persisted session mappings.
      console.warn('Codex sidebar grouping was not confirmed');
    }
  }
  async releaseIdle(session) {
    if(this.config.releaseIdleThreads&&session.thread&&session.status!=='active'&&!(this.config.provider==='claude'&&session.status==='uncertain'))await this.codex.call('thread/unsubscribe',{threadId:session.thread});
  }
  async desktopOwnsInput(session,input) {
    this.state.messageState(input.id,'done');
    await this.post(session,`desktop-owner:${input.id}`,'This session is currently open in Codex. Continue or stop it there, then close its tab before continuing from Slack.');
  }
  desktopApprovalText(reason) {
    return `${reason} ${this.config.releaseIdleThreads
      ? 'Write pause here, then open the same session in Codex and ask it to continue. The pending action is not approved.'
      : 'Open this session in Codex to review and respond.'}`;
  }
  async onCodex(message) {
    const p=message.params??{};
    const session=this.state.sessions().find(s=>s.thread===p.threadId);
    // On a shared daemon another client can own the request. Never decline its approvals.
    if(!session) {if(message.id!==undefined&&this.config.codexMode!=='managed')this.codex.reject(message.id);return;}
    if(message.method==='turn/started'&&p.turn?.status==='inProgress') {this.adoptTurn(session,p.turn);return;}
    if(message.id!==undefined && (session.status!=='active' || !session.turn || (p.turnId && session.turn!==p.turnId))) {
      if(this.config.codexMode!=='managed')this.codex.reject(message.id);
      return;
    }
    if(message.method==='serverRequest/resolved') {this.state.resolveRequest(p.requestId);return;}
    if(message.id!==undefined) {
      const supported=['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request'];
      if(!supported.includes(message.method)) {
        if(this.config.codexMode==='managed'&&this.config.provider!=='claude')await this.post(session,`desktop:${message.id}`,this.desktopApprovalText('This request needs the Codex app.'));
        else this.codex.reject(message.id);
        return;
      }
      const nonce=randomUUID();
      const request={id:message.id,method:message.method,params:{...p,turnId:p.turnId??session.turn}};
      this.state.prompt(nonce,session.address,request);
      if(message.method==='item/fileChange/requestApproval') {
        if(this.config.provider==='claude'){this.codex.reject(message.id);this.state.settlePrompt(nonce);await this.post(session,`prompt:${nonce}`,'This Claude change was declined because the full diff is unavailable here. Ask for a smaller, fully inspectable change.');return;}
        if(this.config.codexMode==='managed') {this.state.deferPrompt(nonce);await this.post(session,`prompt:${nonce}`,this.desktopApprovalText('File-change approval needs the full diff.'));return;}
        this.codex.answer(message.id,{decision:'decline'});
        this.state.settlePrompt(nonce);
        await this.post(session,`prompt:${nonce}`,'File-change approval needs the full diff. It was declined here. Open this session in Codex to inspect and approve the exact change.');
        return;
      }
      const details=message.method==='item/tool/requestUserInput'
        ? (p.questions??[]).map(q=>`${q.header??''}\n${q.question}\n${(q.options??[]).map((o,i)=>`${i+1}. ${o.label}: ${o.description??''}`).join('\n')}`).join('\n\n')
        : JSON.stringify(p,null,2);
      if(details.length>2000) {
        if(this.config.provider==='claude'){this.codex.reject(message.id);this.state.settlePrompt(nonce);await this.post(session,`prompt:${nonce}`,'This Claude request was declined because its full details do not fit here. Ask for a smaller, fully inspectable request.');return;}
        if(this.config.codexMode==='managed') {this.state.deferPrompt(nonce);await this.post(session,`prompt:${nonce}`,this.desktopApprovalText('This approval needs more context than fits here.'));return;}
        this.codex.reject(message.id);this.state.settlePrompt(nonce);
        await this.post(session,`prompt:${nonce}`,'This approval needs more context than fits here. It was declined. Inspect this session in Codex.');
        return;
      }
      const form=message.method==='mcpServer/elicitation/request'&&p.mode!=='url';
      await this.post(session,`prompt:${nonce}`,`${details}\n\n${form?'Reply with the JSON object requested by the schema.':message.method==='item/tool/requestUserInput'?'Reply in this thread; use one line per question.':'Use the buttons on this approval request.'}`,!form&&message.method!=='item/tool/requestUserInput'?nonce:null);
      return;
    }
    if(message.method==='item/completed'&&p.item?.type==='agentMessage'&&p.item.text) {
      await this.post(session,`item:${session.thread}:${p.item.id}`,p.item.text);
    }
    if(message.method==='turn/completed'&&session.turn===p.turn?.id) {
      if(p.turn.status==='failed') await this.post(session,`failure:${p.turn.id}`,`${this.config.provider==='claude'?'Claude Code':'Codex'} stopped with an error. Inspect the session before retrying.`);
      const paused=this.pausing.has(session.address);
      this.pausing.delete(session.address);
      this.state.update(session.address,{...session,turn:null,status:p.turn.status==='failed'?'uncertain':paused?'paused':'idle'});
      this.state.expirePrompts(session.address);
      if(this.busy?.turn===p.turn.id)this.busy=null;
      if(paused||this.config.releaseIdleThreads) await this.codex.call('thread/unsubscribe',{threadId:session.thread});
      await this.pump();
    }
  }
  async respond(prompt,text) {
    const session=this.state.getSession(prompt.address);
    const request=prompt.request;
    if(session?.status!=='active'||request.params.turnId!==session.turn) return;
    const p=request.params;
    const decision=text.trim().toLowerCase();
    let answer;
    if(request.method==='item/tool/requestUserInput') {
      const lines=text.split('\n');
      if(p.questions?.length!==1&&lines.length!==p.questions?.length) return;
      answer={answers:Object.fromEntries(p.questions.map((q,i)=>[q.id,{answers:[p.questions.length===1?text:lines[i]]}]))};
    } else {
      if(request.method==='mcpServer/elicitation/request'&&p.mode!=='url'&&!['decline','cancel'].includes(decision)) {
        let content;try{content=JSON.parse(text);}catch{return;}
        if(!content||typeof content!=='object'||Array.isArray(content))return;
        this.codex.answer(request.id,{action:'accept',content});this.state.settlePrompt(prompt.nonce);return;
      }
      if(!['approve','decline'].includes(decision)) return;
      const accepted=decision==='approve';
      if(request.method==='item/permissions/requestApproval') answer={permissions:accepted?p.permissions:{},scope:'turn'};
      else if(request.method==='mcpServer/elicitation/request') {
        // Free-form schema forms require the desktop UI; never guess missing structured fields.
        answer={action:accepted&&p.mode==='url'?'accept':'decline',content:null};
      } else answer={decision:accepted?'accept':'decline'};
    }
    this.codex.answer(request.id,answer);
    this.state.settlePrompt(prompt.nonce);
  }
  async action(body) {
    if(body?.team?.id!==this.config.team||body?.user?.id!==this.config.owner) return;
    const action=body.actions?.[0];
    if(!['owner_approve','owner_decline'].includes(action?.action_id))return;
    const prompt=this.state.getPrompt(action?.value);
    if(!prompt) return;
    const session=this.state.getSession(prompt.address);
    if(session?.channel!==body.channel?.id||session.root!==(body.message?.thread_ts??body.message?.ts)) return;
    await this.respond(prompt,action.action_id==='owner_approve'?'approve':'decline');
  }
  async post(session,id,text,prompt=null) {
    const chunks=prompt?[text]:Array.from({length:Math.max(1,Math.ceil(text.length/12000))},(_,i)=>text.slice(i*12000,(i+1)*12000));
    for(let index=0;index<chunks.length;index++) {
      const key=`${id}:${index}`;
      if(!this.state.reserveDelivery(key)) continue;
      const digest=createHash('sha256').update(key).digest('hex');
      const uuid=[digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join('-');
      const ts=await this.slack.post(session.channel,session.root,chunks[index],prompt,uuid);
      this.state.delivery(key,ts);
    }
  }
  async failed() {
    // A lost response is not evidence that the action did not happen.
    this.state.holdUncertain();
    process.exitCode=1;
    this.codex.stop();
  }
}
