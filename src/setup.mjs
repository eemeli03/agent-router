import { mkdir,writeFile,readFile,copyFile,constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { nativeLogin } from './native-login.mjs';
import { Codex } from './codex.mjs';
import { launchPlist } from './launch-plist.mjs';
const exec=promisify(execFile);
import {exists,writeOnce,validateWorkspace} from './setup-utils.mjs';
const here=dirname(fileURLToPath(import.meta.url));
async function openUrl(url){
  const u=new URL(url);if(u.protocol!=='https:')throw Error('HTTPS login required');
  const command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?'rundll32.exe':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  await exec(command,args);
}
export async function detectBinary(provider){
  const candidates=provider==='codex'?[
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    join(homedir(),'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
  ]:[join(homedir(),'.local/bin/claude'),'/opt/homebrew/bin/claude','/usr/local/bin/claude'];
  for(const p of candidates)if(await exists(p))return p;
  try{const {stdout}=await exec(process.platform==='win32'?'where':'which',[provider==='codex'?'codex':'claude']);const p=stdout.trim().split(/\r?\n/)[0];if(p)return p;}catch{}
  throw Error(`Install ${provider==='codex'?'Codex or the ChatGPT desktop app':'Claude Code'} first, then reopen this setup.`);
}
async function bootstrap(file){
  try{await exec('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,file]);}
  catch(error){
    const contents=await readFile(file,'utf8');const label=contents.match(/<key>Label<\/key><string>([^<]+)<\/string>/)?.[1];
    if(!label)throw error;await exec('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`]);
  }
}
export async function setup({origin,ticket,workspace,runtimeRoot=here,expectedProvider}){
  if(process.platform!=='darwin')throw Error('This first connector installer supports macOS.');
  if(new URL(origin).protocol!=='https:'||!/^[a-f0-9]{64}$/.test(ticket))throw Error('Invalid setup link');
  const cwd=await validateWorkspace(workspace);
  const base=join(homedir(),'.agent-router');await mkdir(base,{recursive:true,mode:0o700});
  let daemon;
  try{
    const response=await fetch(new URL('/api/status',origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:ticket})});
    if(!response.ok)throw Error('Setup link expired. Send setup to your app in Slack.');
    const info=await response.json();
    if(expectedProvider&&info.provider!==expectedProvider)throw Error('This Slack link is for a different agent. Choose the matching provider in Slack.');
    const binary=await detectBinary(info.provider);
    const ticketHash=(await import('node:crypto')).createHash('sha256').update(ticket).digest('hex');
    const receiptPath=join(base,`claim-${ticketHash}.json`);
    let saved;try{saved=JSON.parse(await readFile(receiptPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const secret=saved?.secret??randomBytes(32).toString('hex');
    if(!saved)await writeFile(receiptPath,JSON.stringify({secret})+'\n',{mode:0o600,flag:'wx'});
    // Claim is persisted before provider login. Only this device secret can retry it.
    const claim=await fetch(new URL('/api/claim',origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:ticket,deviceSecret:secret})});
    if(!claim.ok)throw Error('This setup is no longer available. Send setup to your app in Slack for a new link.');
    const identity=await claim.json();
    const root=join(base,identity.registration);await mkdir(root,{recursive:true,mode:0o700});
    const runtime=join(root,'runtime');await mkdir(runtime,{recursive:true,mode:0o700});
    for(const name of ['worker.mjs','setup.mjs'])if(!await exists(join(runtime,name)))await copyFile(join(runtimeRoot,name),join(runtime,name),constants.COPYFILE_EXCL);
    const node=join(root,process.platform==='win32'?'node.exe':'node');if(!await exists(node))await copyFile(process.execPath,node,constants.COPYFILE_EXCL);
    if(process.platform!=='win32'){const{chmod}=await import('node:fs/promises');await chmod(node,0o700);}
    let config={...identity,secret,relay:{origin},endpoint:join(root,'worker.sock'),broker:join(root,'unused.sock'),state:join(root,'state.sqlite'),cwd,binary,codexSocket:join(root,'codex.sock'),releaseIdleThreads:true};
    const configPath=join(root,'worker.json');
    if(await exists(configPath)){
      const existing=JSON.parse(await readFile(configPath,'utf8'));
      if(['team','bot','owner','email','provider','registration'].some(key=>existing[key]!==identity[key])||existing.secret!==secret||existing.cwd!==cwd||existing.binary!==binary||existing.relay?.origin!==origin)throw Error('Existing connector identity differs; it was preserved.');
      config=existing;
    }else await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
    if(identity.provider==='codex'){
      daemon=spawn(binary,['-c','thread_unload_delay_secs=1','app-server','--listen',`unix://${config.codexSocket}`],{cwd,stdio:'ignore'});
      let connected=false;for(let i=0;i<30;i++){if(await exists(config.codexSocket)){connected=true;break;}await new Promise(r=>setTimeout(r,300));}
      if(!connected)throw Error('Could not start your Codex connection');
    }
    const connection=await nativeLogin(config);
    if(connection.url)await openUrl(connection.url);
    await connection.ready;
    if(identity.provider==='codex'){
      const c=new Codex(binary,cwd,{mode:'managed',socketPath:config.codexSocket});
      try{await c.start();const sections=await c.call('threadSection/list',{});let section=(sections.data??sections.sections??[]).find(s=>s.name==='Agent Router');if(!section){const made=await c.call('threadSection/create',{name:'Agent Router'});section=made.section??made;}
        if(section?.id&&!config.sidebarSectionId){
          await copyFile(configPath,join(root,`worker-before-sidebar-${Date.now()}.json`),constants.COPYFILE_EXCL);
          config.sidebarSectionId=section.id;await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
        }
      }catch{console.log('You can group your conversations in an Agent Router sidebar section later.');}finally{c.stop();}
    }
    console.log(`Your ${identity.provider==='codex'?'Codex':'Claude Code'} account is verified.`);
    if(process.platform==='darwin'){
      if(daemon){daemon.kill('SIGTERM');await new Promise(r=>daemon.exitCode!==null?r():daemon.once('exit',r));}
      const agents=join(homedir(),'Library/LaunchAgents');await mkdir(agents,{recursive:true});
      const label=`dev.agent-router.personal.${identity.registration}`;
      if(identity.provider==='codex'){
        const file=join(agents,label+'.codex.plist');
        await writeOnce(file,launchPlist(label+'.codex',[binary,'-c','thread_unload_delay_secs=1','app-server','--listen',`unix://${config.codexSocket}`],cwd,root));
        await bootstrap(file);
      }
      const file=join(agents,label+'.plist');
      await writeOnce(file,launchPlist(label,[node,join(runtime,'worker.mjs'),configPath],cwd,root));
      await bootstrap(file);
    }else{
      // Foreground connector preserves per-user identity on platforms without launchd.
      console.log('Keep this window open while using Agent Router.');
      const worker=spawn(node,[join(runtime,'worker.mjs'),configPath],{cwd,stdio:'inherit'});
      await new Promise(resolve=>worker.once('exit',resolve));daemon?.kill('SIGTERM');
    }
    let ready=false;
    for(let i=0;i<30;i++){
      try{const r=await fetch(new URL('/api/status',origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:ticket})});if(r.ok&&(await r.json()).status==='connected'){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,1000));
    }
    if(!ready)throw Error('The connector is installed, but connection is not confirmed. Return to Slack and ask your workspace owner to check it.');
    console.log('Connected. Return to Slack and send your app a new message.');
  }finally{daemon?.kill('SIGTERM');}
}
