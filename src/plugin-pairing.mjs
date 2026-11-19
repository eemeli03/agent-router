import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Codex} from './codex.mjs';
import {claudeAccount} from './claude.mjs';

export async function providerEmail(provider,binary,cwd){
 if(provider==='claude'){
  const account=await claudeAccount(binary);
  if(!account.loggedIn||account.apiProvider!=='firstParty'||!account.email)throw Error('Sign in to your own Claude Code account first.');
  return account.email.toLowerCase();
 }
 if(provider!=='codex')throw Error('Choose Codex or Claude Code.');
 const client=new Codex(binary,cwd);
 try{await client.start();const {account}=await client.call('account/read',{refreshToken:false});if(account?.type!=='chatgpt'||!account.email)throw Error('Sign in to your own Codex account first.');return account.email.toLowerCase();}
 finally{client.stop();}
}

export async function completePluginPairing({origin,provider,email,ticket,base=join(homedir(),'.agent-router')}){
 const file=join(base,`plugin-pairing-${createHash('sha256').update(origin+'\n'+provider+'\n'+email).digest('hex')}.json`);
 const saved=JSON.parse(await readFile(file,'utf8'));
 if(saved.token!==ticket)return;
 if(saved.origin!==origin||saved.provider!==provider||saved.email!==email)throw Error('Saved pairing identity differs; it was preserved.');
 const completed={...saved,completed:true,status:'connected'};
 await writeFile(join(base,`plugin-pairing-completion-${randomBytes(16).toString('hex')}.json`),JSON.stringify(completed)+'\n',{mode:0o600,flag:'wx'});
 await writeFile(file,JSON.stringify(completed)+'\n',{mode:0o600});
}

export async function requestPluginPairing({origin,provider,email,fetchImpl=fetch,base=join(homedir(),'.agent-router'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=console.log,now=Date.now}){
 if(new URL(origin).origin!==origin||new URL(origin).protocol!=='https:')throw Error('Invalid connection origin');
 if(!['codex','claude'].includes(provider)||!email)throw Error('A signed-in personal account is required.');
 await mkdir(base,{recursive:true,mode:0o700});
 const file=join(base,`plugin-pairing-${createHash('sha256').update(origin+'\n'+provider+'\n'+email).digest('hex')}.json`);
 let saved;try{saved=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(saved&&(saved.origin!==origin||saved.provider!==provider||saved.email!==email))throw Error('Saved pairing identity differs; it was preserved.');
 let legacyPending=!!(saved&&saved.version!==2&&!saved.completed&&saved.expires>now());
 if(legacyPending){
  const status=await fetchImpl(new URL('/api/status',origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:saved.token})});
  if(status.ok){const info=await status.json();if(info.provider!==provider)throw Error('Pairing provider mismatch');legacyPending=info.status!=='connected';}
 }
 if(!saved||saved.expires<=now()||(!legacyPending&&saved.version!==2)||saved.completed){
  if(saved)await writeFile(join(base,`plugin-pairing-before-${randomBytes(16).toString('hex')}.json`),JSON.stringify(saved)+'\n',{mode:0o600,flag:'wx'});
  // Unique files retain previous setup receipts; the pointer contains no native history.
  saved={version:2,origin,provider,email,token:randomBytes(32).toString('hex'),expires:now()+10*60_000};
  await writeFile(join(base,`plugin-pairing-receipt-${saved.token.slice(0,16)}.json`),JSON.stringify(saved)+'\n',{mode:0o600,flag:'wx'});
  await writeFile(file,JSON.stringify(saved)+'\n',{mode:0o600});
 }
 const response=await fetchImpl(new URL('/api/plugin-pair',origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider,email,token:saved.token})});
 if(!response.ok)throw Error('Could not request Slack confirmation. Try Setup again in a minute.');
 let prompted=false;
 while(now()<saved.expires){
  const status=await fetchImpl(new URL('/api/status',origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:saved.token})});
  if(status.ok){const info=await status.json();if(info.provider!==provider)throw Error('Pairing provider mismatch');if(['authorized','claimed','connected'].includes(info.status)){
   if(info.status==='connected')await completePluginPairing({origin,provider,email,ticket:saved.token,base});
   return{ticket:saved.token,status:info.status};
  }}
  if(!prompted){log(legacyPending?'Return to your pending Agent Router confirmation in Slack and select Connect.':'Open the new message from your app in Slack and select Connect.');prompted=true;}
  await sleep(1500);
 }
 throw Error('Slack confirmation expired. Run Setup again.');
}
