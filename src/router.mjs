import { createHash } from 'node:crypto';
import { addressed } from './agent.mjs';

/** The Slack edge owns author verification; workers receive only their owner's envelopes. */
export class Router {
  constructor({store,workers,team,bot,dispatch,slack}) {
    Object.assign(this,{store,team,bot,dispatch,slack});
    store.bindIdentity(team,bot);
    this.workers=new Map(workers.map(worker=>[worker.registration,worker]));
    if(this.workers.size!==workers.length||new Set(workers.filter(w=>w.acceptingNew!==false).map(w=>`${w.owner}:${w.provider}`)).size!==workers.filter(w=>w.acceptingNew!==false).length)throw new Error('Duplicate owner registration');
    for(const binding of store.bindings()) {
      const worker=this.workers.get(binding.registration);
      if(!worker&&workers.some(w=>w.owner===binding.owner&&w.provider===binding.provider))throw new Error('Existing sessions require their original registration');
      if(worker && (worker.provider!==binding.provider || worker.registration!==binding.registration))throw new Error('Existing sessions require their original registration');
    }
    for(const worker of workers)store.bindWorker(worker);
  }
  addWorker(worker){
    if(this.workers.has(worker.registration)||[...this.workers.values()].some(w=>w.owner===worker.owner&&w.provider===worker.provider&&w.acceptingNew!==false))throw Error('Worker already registered');
    this.store.bindWorker(worker);this.store.saveTeamWorker(worker);this.workers.set(worker.registration,worker);
  }
  disableWorker(registration){
    const worker=this.workers.get(registration);if(!worker)return;
    worker.enabled=false;this.store.updateTeamWorker(worker);
  }
  workerFor(owner,binding) {
    if(!owner)return;
    if(binding)return this.workers.get(binding.registration);
    const saved=this.store.preference(owner);
    if(saved){const worker=this.workers.get(saved);if(worker?.acceptingNew!==false)return worker;}
    return [...this.workers.values()].find(w=>w.owner===owner&&w.provider==='codex'&&w.acceptingNew!==false)??[...this.workers.values()].find(w=>w.owner===owner&&w.acceptingNew!==false);
  }
  selectProvider(owner,provider) {
    const worker=[...this.workers.values()].find(w=>w.owner===owner&&w.provider===provider&&w.enabled!==false&&w.acceptingNew!==false);
    if(!worker)throw new Error('Provider is not registered');
    this.store.selectProvider(owner,worker.registration);
    return worker;
  }
  admit(payload) {
    if(payload?.team_id!==this.team||!payload?.event)return false;
    const event=payload.event,root=event.thread_ts??event.ts;
    const saved=this.store.binding(event.channel,root);
    const worker=this.workerFor(event.user,saved);
    if(!worker||worker.owner!==event.user||worker.enabled===false)return false;
    if(saved && (saved.owner!==worker.owner || saved.registration!==worker.registration || saved.provider!==worker.provider))return false;
    const input=addressed(payload,{owner:worker.owner,team:this.team,bot:this.bot},{hasSession:()=>Boolean(saved)});
    if(!input)return false;
    return this.store.admit(worker,input,payload);
  }
  admitAction(body) {
    if(body?.team?.id!==this.team)return false;
    const binding=this.store.binding(body.channel?.id,body.message?.thread_ts??body.message?.ts);
    const worker=binding?this.workers.get(binding.registration):null;
    if(!worker||worker.owner!==body?.user?.id||worker.enabled===false)return false;
    if(!binding || binding.owner!==worker.owner || binding.registration!==worker.registration || binding.provider!==worker.provider)return false;
    const action=body.actions?.[0];
    if(!['owner_approve','owner_decline'].includes(action?.action_id) || typeof action.value!=='string')return false;
    const id=createHash('sha256').update(JSON.stringify([this.team,worker.registration,worker.owner,binding.channel,binding.root,action.value,action.action_id,action.action_ts])).digest('hex');
    return this.store.action(worker,id,body);
  }
  async flush() {
    if(this.flushing)return;
    this.flushing=true;
    try {
      await Promise.all([...this.workers.values()].map(worker=>this.flushWorker(worker)));
    } finally {this.flushing=false;}
  }
  async flushWorker(worker) {
    if(worker.enabled===false)return;
    for(const item of this.store.pendingFor(worker.owner,worker.registration)) {
      if(worker.registration!==item.registration || worker.provider!==item.provider)continue;
      try {
        const result=await this.dispatch(worker,item.kind,JSON.parse(item.payload));
        if(result?.accepted!==true)break;
        this.store.delivered(item.id);
      } catch { break; /* Durable input retries preserve this worker's message order. */ }
    }
  }
  async output(worker,body) {
    const binding=this.store.binding(body.channel,body.root);
    if(!binding || binding.owner!==worker.owner || binding.registration!==worker.registration || binding.provider!==worker.provider)throw new Error('Output scope mismatch');
    if(body.kind==='reaction') {
      if(!this.store.hasInput(worker.owner,body.channel,body.root,body.ts))throw new Error('Reaction scope mismatch');
      return this.slack.react(body.channel,body.ts);
    }
    if(body.kind!=='message'||typeof body.text!=='string'||body.text.length>12000||typeof body.id!=='string'||body.id.length>200)throw new Error('Invalid output');
    const key=createHash('sha256').update(JSON.stringify([worker.registration,body.channel,body.root,body.id])).digest('hex');
    const digest=createHash('sha256').update(JSON.stringify([body.text,body.prompt??null])).digest('hex');
    const saved=this.store.output(key);
    if(saved) {
      if(saved.digest!==digest||saved.status!=='sent')throw new Error('Output remains unconfirmed');
      return {ts:saved.ts};
    }
    this.store.reserveOutput(key,digest);
    const messageId=[key.slice(0,8),key.slice(8,12),key.slice(12,16),key.slice(16,20),key.slice(20,32)].join('-');
    const ts=await this.slack.post(body.channel,body.root,body.text,body.prompt,messageId);
    this.store.sentOutput(key,ts);
    return {ts};
  }
}
