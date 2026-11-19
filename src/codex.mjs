import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import WebSocket from 'ws';

/** One connection owns these Slack sessions. Other desktop sessions are never resumed here. */
export class Codex extends EventEmitter {
  pending = new Map();
  next = 0;
  constructor(binary, cwd, { mode = 'isolated', socketPath, spawnProcess = spawn } = {}) {
    super();
    if (!['isolated', 'managed'].includes(mode)) throw new Error('Unsupported Codex connection mode');
    this.binary = binary;
    this.cwd = cwd;
    this.mode = mode;
    this.spawnProcess = spawnProcess;
    this.socketPath = socketPath ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
    if (mode === 'managed' && (!isAbsolute(this.socketPath) || /[:\r\n]/.test(this.socketPath))) throw new Error('Codex socket must be an absolute local path');
  }
  async start() {
    if (this.mode === 'managed') await this.connectManaged();
    else this.startIsolated();
    await this.call('initialize', {
      clientInfo: { name: 'agent_router', title: 'Agent Router', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }
  startIsolated() {
    this.child = this.spawnProcess(this.binary, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child.stderr.on('data', () => {}); // stderr can contain private prompt and credential context.
    this.child.on('error', error => this.disconnected(error));
    this.child.on('exit', () => this.disconnected(new Error('Codex disconnected')));
    createInterface({ input: this.child.stdout }).on('line', line => this.receive(line));
  }
  async connectManaged() {
    // Private Unix socket: the daemon survives this connection and is shared with desktop SSH.
    this.socket = new WebSocket(`ws+unix:${this.socketPath}:/`);
    this.socket.on('message', bytes => this.receive(bytes.toString()));
    this.socket.on('error', error => this.disconnected(error));
    this.socket.on('close', () => this.disconnected(new Error('Codex disconnected')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.terminate(); reject(new Error('Codex connection timed out')); }, 15_000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
  }
  receive(line) {
      try {
        const message = JSON.parse(line);
        if (message.method) this.emit('message', message);
        else {
          const request = this.pending.get(message.id);
          if (!request) return;
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result);
        }
      } catch { this.emit('protocolError'); }
  }
  send(message) {
    if (this.socket) {
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex is not connected');
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (!this.child || this.child.exitCode !== null) throw new Error('Codex is not connected');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  call(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} response unknown`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  answer(id, result) { this.send({ id, result }); }
  reject(id) { this.send({ id, error: { code: -32601, message: 'Unsupported interaction; no approval granted' } }); }
  disconnected(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit('disconnected');
  }
  stop() { this.socket?.close(); this.child?.kill('SIGTERM'); }
}
