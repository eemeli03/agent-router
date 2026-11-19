import test from 'node:test';
import assert from 'node:assert/strict';
import { localServices, launchPlist } from '../src/local-launch.mjs';

test('local launch keeps the shared app, worker and Codex listener separate',()=>{
  const worker={team:'T_A',bot:'U_B',owner:'U_C',email:'c@example.com',provider:'codex',registration:'one',secret:'secret',endpoint:'/private/worker.sock',broker:'/private/router.sock',state:'/private/worker.sqlite',cwd:'/project',binary:'/codex',codexSocket:'/private/codex.sock',releaseIdleThreads:true};
  const router={team:worker.team,bot:worker.bot,socket:worker.broker,state:'/private/router.sqlite',workers:[{...worker}]};
  const jobs=localServices(router,worker,'/private/router.json','/private/worker.json','/code','/node');
  assert.equal(jobs.length,3);
  assert.deepEqual(jobs[0].args,['/codex','-c','thread_unload_delay_secs=1','app-server','--listen','unix:///private/codex.sock']);
  assert.equal(jobs[0].cwd,'/project');
  assert.ok(jobs.every(job=>!job.args.some(arg=>arg.includes('secret'))));
  assert.throws(()=>localServices(router,{...worker,releaseIdleThreads:false},'/r','/w','/c'),/handoff/);
  assert.throws(()=>localServices({...router,workers:[...router.workers,{...worker}]},worker,'/r','/w','/c'),/one owner/);
  assert.throws(()=>localServices(router,{...worker,email:'wrong@example.com'},'/r','/w','/c'),/identity mismatch/);
  assert.throws(()=>localServices(router,{...worker,codexSocket:worker.endpoint},'/r','/w','/c'),/distinct/);
});

test('launchd values are escaped and services restart without logging secrets',()=>{
  const xml=launchPlist('dev.agent-router.worker',['/node','/a & b/<script>.mjs'],'/work"space','/private/logs');
  assert.match(xml,/<string>\/a &amp; b\/&lt;script&gt;\.mjs<\/string>/);
  assert.match(xml,/\/work&quot;space/);
  assert.match(xml,/<key>KeepAlive<\/key><true\/>/);
  assert.match(xml,/<key>Umask<\/key><integer>63<\/integer>/);
});
