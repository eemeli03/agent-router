import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {nativeLogin} from '../src/native-login.mjs';

const codexConfig={provider:'codex',email:'owner@example.com'};
test('existing Codex login is checked without replacing credentials or logging out',async()=>{
  const methods=[];let stopped=false;
  const c={start:async()=>{},call:async method=>{methods.push(method);return{account:{type:'chatgpt',email:'owner@example.com'}};},stop:()=>stopped=true};
  const login=await nativeLogin(codexConfig,{codexFactory:()=>c});await login.ready;
  assert.deepEqual(methods,['account/read','account/read']);assert.equal(stopped,true);
});
test('a different Codex account fails without starting a login over it',async()=>{
  let calls=0;
  const c={start:async()=>{},call:async()=>{calls++;return{account:{type:'chatgpt',email:'other@example.com'}};},stop:()=>{}};
  await assert.rejects(nativeLogin(codexConfig,{codexFactory:()=>c}),/does not match/);assert.equal(calls,2);
});
test('Claude uses its own native login and only completes on a matching account',async()=>{
  let loggedIn=false,invocation;
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  const result=nativeLogin({provider:'claude',binary:'/claude',cwd:'/project',email:'owner@example.com'},{
    account:async()=>({loggedIn,email:loggedIn?'owner@example.com':undefined,apiProvider:'firstParty'}),
    spawnProcess:(...args)=>{invocation=args;queueMicrotask(()=>child.stdout.write('https://claude.com/cai/oauth/authorize?state=opaque\n'));return child;},
  });
  const login=await result;assert.match(login.url,/claude.com/);assert.deepEqual(invocation[1],['auth','login','--claudeai','--email','owner@example.com']);
  assert.equal(invocation[2].env.BROWSER,'/usr/bin/true');
  loggedIn=true;child.emit('close',0);await login.ready;
});
