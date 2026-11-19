import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readConfig, RouterConfig, WorkerConfig } from './shared-config.mjs';

import { launchPlist } from './launch-plist.mjs';
export { launchPlist } from './launch-plist.mjs';

export function localServices(router,worker,routerFile,workerFile,codeRoot,nodeBinary=process.execPath) {
  if(worker.releaseIdleThreads!==true)throw new Error('Local desktop handoff requires releaseIdleThreads');
  const entry=router.workers.find(w=>w.owner===worker.owner);
  if(router.workers.length!==1||!entry)throw new Error('Local first rollout accepts one owner');
  for(const key of ['owner','email','provider','registration','endpoint','secret'])if(entry[key]!==worker[key])throw new Error('Local identity mismatch');
  if(router.team!==worker.team||router.bot!==worker.bot||router.socket!==worker.broker)throw new Error('Local routing mismatch');
  if(router.state===worker.state||router.socket===worker.endpoint||[router.socket,worker.endpoint].includes(worker.codexSocket))throw new Error('Local paths must be distinct');
  // Never adjust the desktop's shared config or stop its existing server.
  // This dedicated listener drops only idle, unsubscribed threads after 1 sec.
  return [
    {label:'dev.agent-router.codex',args:[worker.binary,'-c','thread_unload_delay_secs=1','app-server','--listen',`unix://${worker.codexSocket}`],cwd:worker.cwd},
    {label:'dev.agent-router.worker',args:[nodeBinary,join(codeRoot,'src/worker.mjs'),workerFile],cwd:codeRoot},
    {label:'dev.agent-router.router',args:[nodeBinary,join(codeRoot,'src/shared-main.mjs'),routerFile],cwd:codeRoot},
  ];
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [routerArg,workerArg]=process.argv.slice(2);
  if(!routerArg||!workerArg)throw new Error('Usage: node src/local-launch.mjs ROUTER_CONFIG WORKER_CONFIG');
  if(process.platform!=='darwin')throw new Error('This installer prepares macOS LaunchAgents only');
  const routerFile=resolve(routerArg),workerFile=resolve(workerArg);
  const router=readConfig(routerFile,RouterConfig),worker=readConfig(workerFile,WorkerConfig);
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const jobs=localServices(router,worker,routerFile,workerFile,root);
  const output=join(dirname(routerFile),'launchagents'),logs=join(dirname(routerFile),'logs');
  const files=jobs.map(job=>join(output,`${job.label}.plist`));
  if(files.some(existsSync))throw new Error('Prepared service files already exist; preserve and review them before replacing');
  for(const dir of [output,logs,...[router.state,worker.state,router.socket,worker.endpoint,worker.codexSocket].map(dirname)]) {
    mkdirSync(dir,{recursive:true,mode:0o700});
  }
  for(let i=0;i<jobs.length;i++)writeFileSync(files[i],launchPlist(jobs[i].label,jobs[i].args,jobs[i].cwd,logs),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({prepared:files,launchAgentsDirectory:join(homedir(),'Library/LaunchAgents'),enabled:false}));
}
