import test from 'node:test';
import assert from 'node:assert/strict';
import { RouterConfig,workerEnvelope,verifyWorkerEnvelope } from '../src/shared-config.mjs';

test('router author identity must match the worker account before any input is admitted',()=>{
  const config={team:'T_ONE',bot:'U_BOT',owner:'U_ALICE',email:'alice@example.com',provider:'codex',registration:'reg-alice'};
  const payload={event:{user:'U_ALICE'}};
  const envelope=workerEnvelope(config,config.team,config.bot,payload);
  assert.equal(verifyWorkerEnvelope(config,envelope),payload);
  for(const key of ['team','bot','owner','email','provider','registration']) {
    assert.throws(()=>verifyWorkerEnvelope({...config,[key]:'different'},envelope),/identity mismatch/);
  }
  assert.throws(()=>verifyWorkerEnvelope(config,payload),/identity mismatch/);
});

test('a fresh self-hosted router requires its own service settings before any worker enrolls', () => {
  const base = {
    team: 'T_TEST', bot: 'U_BOT', botToken: 'xoxb-placeholder', appToken: 'xapp-placeholder',
    socket: '/tmp/router.sock', state: '/tmp/router.sqlite', workers: [],
  };
  const relay = { origin: 'https://relay.example.test', marketplace: 'example/marketplace', secret: 't'.repeat(64), domains: ['example.test'] };
  assert.equal(RouterConfig.safeParse(base).success, false);
  assert.equal(RouterConfig.safeParse({ ...base, relay }).success, true);
  for (const key of ['origin', 'marketplace', 'secret', 'domains']) {
    assert.equal(RouterConfig.safeParse({ ...base, relay: { ...relay, [key]: undefined } }).success, false);
  }
  assert.equal(RouterConfig.safeParse({ ...base, relay: { ...relay, origin: 'https://relay.example.test/path' } }).success, false);
});
