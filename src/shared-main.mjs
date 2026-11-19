import { resolve } from 'node:path';
import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { RouterConfig,readConfig,workerEnvelope } from './shared-config.mjs';
import { RouterState } from './router-state.mjs';
import { Router } from './router.mjs';
import { listenPrivate,privateCall,sameSecret } from './private-http.mjs';
import { acquireLock } from './lock.mjs';
import { Onboarding } from './onboarding.mjs';
import { RelayClient } from './relay-client.mjs';
import { TeamOnboarding } from './team-onboarding.mjs';
import { pilotConnections } from './native-login.mjs';
import { slackMessage } from './slack-message.mjs';
import { createSlackEventHandler } from './slack-events.mjs';

const config=readConfig(resolve(process.argv[2]),RouterConfig);
const release=await acquireLock(config.state);
const store=new RouterState(config.state);
const web=new WebClient(config.botToken,{retryConfig:{retries:0}});
const identity=await web.auth.test();
if(identity.team_id!==config.team||identity.user_id!==config.bot)throw new Error('Slack app identity mismatch');
for(const worker of config.workers) {
  const {user}=await web.users.info({user:worker.owner});
  if(user?.is_bot||user?.deleted||user?.profile?.email!==worker.email)throw new Error('Registered Slack owner mismatch');
}
const slack={
  async react(channel,timestamp) {try{await web.reactions.add({channel,timestamp,name:'eyes'});}catch(error){if(error.data?.error!=='already_reacted')throw error;}return{};},
  async post(channel,thread_ts,text,prompt,id) {
    const result=await web.chat.postMessage({channel,thread_ts,...slackMessage(text,prompt),client_msg_id:id});
    if(!result.ts)throw new Error('Slack send unconfirmed');return result.ts;
  },
};
let relay,teamOnboarding;
const router=new Router({...config,workers:[...config.workers,...store.teamWorkers()],store,slack,dispatch:async(worker,kind,body)=>{
  if(worker.endpoint.startsWith('relay:')){
    await teamOnboarding.checkWorker(worker);
    return relay.request('worker/event',{registration:worker.registration,kind,payload:workerEnvelope(worker,config.team,config.bot,body)});
  }
  return privateCall(worker.endpoint,`/${kind}`,worker.secret,workerEnvelope(worker,config.team,config.bot,body));
}});
if(config.relay){
  teamOnboarding=new TeamOnboarding({...config.relay,team:config.team,bot:config.bot,store,web,router});
  relay=new RelayClient({...config.relay,role:'router',handle:async(method,params)=>{
    if(method==='plugin/pair')return teamOnboarding.requestPluginPair(params);
    if(method==='team/status')return teamOnboarding.status(params);
    if(method==='team/claim')return teamOnboarding.claim(params);
    if(method==='worker/ready')return teamOnboarding.ready(params.registration,params.body);
    if(method==='worker/output'){
      const worker=router.workers.get(params.registration);if(!worker?.enabled||!worker.endpoint.startsWith('relay:'))throw Error('Unknown worker');
      await teamOnboarding.checkWorker(worker);
      return router.output(worker,params.body);
    }
    throw Error('Unknown relay operation');
  }});relay.start();
}
let onboarding;
if(config.onboarding) {
  const connection=pilotConnections(config,router);
  onboarding=new Onboarding({...config.onboarding,team:config.team,bot:config.bot,store,web,...connection});
  await onboarding.start();
}
const server=await listenPrivate(config.socket,async(path,body,auth)=>{
  const worker=config.workers.find(worker=>worker.owner===body.owner && worker.registration===body.registration && sameSecret(auth,`Bearer ${worker.secret}`));
  if(path!=='/output'||!worker||worker.enabled===false)throw new Error('Unauthorized output');
  return router.output(worker,body);
});
const socket=new SocketModeClient({appToken:config.appToken,logLevel:'error'});
socket.on('slack_event',createSlackEventHandler({team:config.team,router,store,onboarding,teamOnboarding,pilotOwner:config.onboarding?.owner}));
socket.on('error',()=>console.error('Slack connection failed'));
const timer=setInterval(()=>{void router.flush();void teamOnboarding?.flushConnectedCards();},2000);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);relay?.stop();onboarding?.close();await socket.disconnect();server.close();store.close();await release();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
await socket.start();console.log('Shared Slack router ready.');
