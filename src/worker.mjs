import { resolve } from 'node:path';
import { WorkerConfig, readConfig, instructions,verifyWorkerEnvelope } from './shared-config.mjs';
import { listenPrivate, privateCall, sameSecret } from './private-http.mjs';
import { State } from './state.mjs';
import { Codex } from './codex.mjs';
import { Claude } from './claude.mjs';
import { Agent } from './agent.mjs';
import { RelayClient } from './relay-client.mjs';
import { initializeWorker } from './worker-readiness.mjs';
import { acquireLock } from './lock.mjs';

const config=readConfig(resolve(process.argv[2]),WorkerConfig);
const release=await acquireLock(config.state);
const state=new State(config.state);
const codex=config.provider==='claude'?new Claude(config.binary,config.cwd,config.email,{instructions:instructions(config.email)+'\n'+(config.contextInstructions??'')}):new Codex(config.binary,config.cwd,{mode:'managed',socketPath:config.codexSocket});
let relay;
const output=body=>config.relay?relay.request('worker/output',body):privateCall(config.broker,'/output',config.secret,{...body,owner:config.owner,registration:config.registration});
const slack={
  async react(channel,ts) {try{await output({kind:'reaction',channel,root:currentRoot(channel,ts),ts});}catch{console.warn('Reaction delivery unconfirmed');}},
  post:async(channel,root,text,prompt,id)=>(await output({kind:'message',channel,root,text,prompt,id})).ts,
};
function currentRoot(channel,ts) {
  const row=state.db.prepare('SELECT root FROM messages WHERE channel=? AND ts=?').get(channel,ts);
  if(!row)throw new Error('Input not found');return row.root;
}
const agent=new Agent({state,codex,slack,config:{...config,codexMode:'managed',instructions:instructions(config.email)+'\n'+(config.contextInstructions??'')}});
let server,stopping=false;
async function stop(code=0) {
  if(stopping)return;stopping=true;
  state.holdUncertain();relay?.stop();server?.close();codex.stop();state.close();await release();process.exit(code);
}
codex.on('disconnected',()=>void stop(1));
let initialized=false,transportReady=Promise.resolve(),announce=async()=>{};
const handle=async(path,body)=>{
  if(!initialized&&path!=='/identity')throw Error('Worker still starting');
  body=verifyWorkerEnvelope(config,body);
  if(path==='/identity')return{registration:config.registration,email:config.email,provider:config.provider};
  if(path==='/event') {await agent.receive(body);return{accepted:true};}
  if(path==='/action') {
    if(body?.team?.id!==config.team||body?.user?.id!==config.owner)throw new Error('Owner mismatch');
    if(typeof body.deliveryId!=='string')throw new Error('Missing delivery ID');
    if(!state.claimAction(body.deliveryId))return{accepted:true};
    agent.serial=agent.serial.then(()=>agent.action(body)).catch(()=>agent.failed());
    return{accepted:true};
  }
  throw new Error('Unknown endpoint');
};
if(config.relay){
  relay=new RelayClient({...config.relay,secret:config.secret,registration:config.registration,role:'worker',handle:(method,body)=>{
    if(!['worker/event','worker/action'].includes(method))throw Error('Unknown worker operation');
    return handle('/'+method.split('/')[1],body);
  }});
  let connectedResolve;transportReady=new Promise(r=>connectedResolve=r);
  announce=()=>relay.request('worker/ready',{email:config.email,provider:config.provider});
  relay.on('connected',()=>{connectedResolve();if(initialized)void announce().catch(()=>relay.socket?.close());});
  relay.start();
}else server=await listenPrivate(config.endpoint,async(path,body,auth)=>{
  if(!sameSecret(auth,`Bearer ${config.secret}`))throw new Error('Unauthorized');
  return handle(path,body);
});
await initializeWorker({codex,agent,waitForTransport:()=>transportReady,setInitialized:()=>{initialized=true;},announce});
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
console.log('Personal agent worker ready; account identity verified.');
