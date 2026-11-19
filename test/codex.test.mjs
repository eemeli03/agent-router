import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { Codex } from '../src/codex.mjs';

function fakeProcess(calls) {
  return (binary, args, options) => {
    calls.push({ binary, args, options });
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(data, _encoding, done) {
      const request = JSON.parse(data.toString());
      if (request.id !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'));
      done();
    }});
    child.kill = signal => { child.signal = signal; };
    return child;
  };
}

test('managed connections share a private socket and closing one leaves the daemon alive', async () => {
  const socketPath = mkdtempSync('/tmp/ea-wire-') + '/control.sock';
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  const requests = [];
  server.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString());
    requests.push(request);
    if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result: { thread: { id: 'same-thread' } } }));
  }));
  await new Promise(resolve => http.listen(socketPath, resolve));
  const spawnProcess = () => { throw new Error('Managed mode must not spawn a second server'); };
  const first = new Codex('/codex', '/project', { mode: 'managed', socketPath, spawnProcess });
  const second = new Codex('/codex', '/project', { mode: 'managed', socketPath, spawnProcess });
  try {
    await first.start(); await second.start();
    assert.equal((await first.call('thread/read', { threadId: 'same-thread' })).thread.id, 'same-thread');
    first.stop();
    assert.equal((await second.call('thread/read', { threadId: 'same-thread' })).thread.id, 'same-thread');
    assert.equal(requests.filter(request => request.method === 'initialize').length, 2);
  } finally {
    first.stop(); second.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => http.close(resolve));
  }
});

test('existing installs retain isolated mode and unknown modes fail closed', async () => {
  const calls = [];
  const codex = new Codex('/codex', '/project', { spawnProcess: fakeProcess(calls) });
  await codex.start();
  assert.deepEqual(calls[0].args, ['app-server', '--listen', 'stdio://']);
  codex.stop();
  assert.throws(() => new Codex('/codex', '/project', { mode: 'public' }), /Unsupported/);
});
