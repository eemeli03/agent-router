import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Codex } from './codex.mjs';
import { claudeAccount } from './claude.mjs';
import { readConfig,WorkerConfig } from './shared-config.mjs';
import { privateCall } from './private-http.mjs';

const exec=promisify(execFile);
export function nativeLogin(config,{spawnProcess=spawn,account=claudeAccount,codexFactory=c=>new Codex(c.binary,c.cwd,{mode:'managed',socketPath:c.codexSocket})}={}) {
  if(config.provider==='codex')return codexLogin(config,codexFactory);
  return claudeLogin(config,spawnProcess,account);
}
async function codexLogin(config,factory) {
  const c=factory(config);await c.start();
  const check=async()=>{
    const {account}=await c.call('account/read',{refreshToken:false});
    if(account?.type!=='chatgpt'||account.email!==config.email)throw new Error('Codex account does not match owner');
  };
  const existing=(await c.call('account/read',{refreshToken:false})).account;
  if(existing) {try{await check();return{ready:Promise.resolve()};}finally{c.stop();}}
  let login;
  try {login=await c.call('account/login/start',{type:'chatgpt',useHostedLoginSuccessPage:true});}
  catch(error){c.stop();throw error;}
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('Login timed out')),8*60_000);
    const finish=error=>{clearTimeout(timer);c.stop();error?reject(error):resolve();};
    c.on('message',m=>{if(m.method==='account/login/completed'&&m.params.loginId===login.loginId){if(!m.params.success)finish(new Error('Login failed'));else void check().then(()=>finish(),finish);}});
  });
  return{url:login.authUrl,ready};
}
async function claudeLogin(config,spawnProcess,account) {
  const check=async()=>{
    const info=await account(config.binary);
    if(!info.loggedIn||info.email!==config.email||info.apiProvider!=='firstParty')throw new Error('Claude account does not match owner');
  };
  const info=await account(config.binary);
  if(info.loggedIn){await check();return{ready:Promise.resolve()};}
  const child=spawnProcess(config.binary,['auth','login','--claudeai','--email',config.email],{
    cwd:config.cwd,env:{...process.env,BROWSER:'/usr/bin/true'},stdio:['ignore','pipe','pipe']});
  let urlResolve,urlReject,readyResolve,readyReject,buffer='',urlFound=false;
  const url=new Promise((resolve,reject)=>{urlResolve=resolve;urlReject=reject;});
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  // Attach before waiting for URL so an early CLI failure never becomes unhandled.
  void ready.catch(()=>{});
  const timer=setTimeout(()=>{child.kill('SIGTERM');const e=new Error('Login timed out');urlReject(e);readyReject(e);},8*60_000);
  const data=chunk=>{
    buffer=(buffer+chunk.toString()).slice(-16000);
    const candidate=buffer.match(/https:\/\/[^\s\u001b]+/)?.[0];
    if(candidate&&!urlFound){urlFound=true;urlResolve(candidate);}
  };
  child.stdout.on('data',data);child.stderr.on('data',data);
  child.on('error',error=>{clearTimeout(timer);urlReject(error);readyReject(error);});
  child.on('close',code=>{
    clearTimeout(timer);
    if(code!==0){const error=new Error('Native Claude login failed');urlReject(error);readyReject(error);return;}
    void check().then(readyResolve,readyReject);
    if(!urlFound)urlResolve(null);
  });
  try {return{url:await url,ready};}catch(error){child.kill('SIGTERM');throw error;}
}

export function pilotConnections(config,router) {
  const workers=Object.fromEntries(['codex','claude'].map(provider=>{
    const worker=readConfig(config.onboarding.workerConfigs[provider],WorkerConfig);
    if(worker.provider!==provider||worker.owner!==config.onboarding.owner||worker.team!==config.team||worker.bot!==config.bot)throw new Error('Pilot worker identity mismatch');
    const registration=config.workers.find(w=>w.registration===worker.registration);
    if(!registration||['owner','email','provider','endpoint','secret'].some(key=>registration[key]!==worker[key]))throw new Error('Pilot registration mismatch');
    return[provider,worker];
  }));
  return{
    connect:provider=>nativeLogin(workers[provider]),
    activate:async provider=>{
      const worker=workers[provider];
      if(provider==='claude') {
        try {await exec('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,config.onboarding.claudeLaunchAgent]);}
        catch { /* Already running: verify the actual worker below. */ }
      }
      let verified=false;
      for(let i=0;i<20;i++) {
        try {
          const result=await privateCall(worker.endpoint,'/identity',worker.secret,{identity:{team:worker.team,bot:worker.bot,owner:worker.owner,email:worker.email,provider:worker.provider,registration:worker.registration},payload:{}});
          if(result.registration===worker.registration&&result.email===worker.email){verified=true;break;}
        } catch {}
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(!verified)throw new Error('Personal worker unavailable');
      router.selectProvider(worker.owner,provider);
    },
  };
}
