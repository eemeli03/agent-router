import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Slack input and remote effects retain receipts. Unknown calls never replay automatically. */
export class State {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, root TEXT NOT NULL,
        ts TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS sessions (
        address TEXT PRIMARY KEY, channel TEXT NOT NULL, root TEXT NOT NULL,
        thread TEXT, turn TEXT, status TEXT NOT NULL DEFAULT 'idle'
      );
      CREATE TABLE IF NOT EXISTS prompts (
        nonce TEXT PRIMARY KEY, address TEXT NOT NULL, request TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, ts TEXT
      );
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY);
    `);
  }
  insert(message) {
    return this.db.prepare("INSERT OR IGNORE INTO messages(id,channel,root,ts,text,state) VALUES(?,?,?,?,?,'received')")
      .run(message.id,message.channel,message.root,message.ts,message.text).changes === 1;
  }
  received() { return this.db.prepare("SELECT * FROM messages WHERE state='received' ORDER BY ts").all(); }
  message(id) { return this.db.prepare("SELECT * FROM messages WHERE id=?").get(id); }
  next() { return this.db.prepare("SELECT messages.* FROM messages LEFT JOIN sessions ON sessions.address=messages.channel || ':' || messages.root WHERE messages.state='pending' AND COALESCE(sessions.status,'idle') NOT IN ('uncertain','paused') ORDER BY messages.ts LIMIT 1").get(); }
  cancelPending(channel,root) { this.db.prepare("UPDATE messages SET state='cancelled' WHERE channel=? AND root=? AND state='pending'").run(channel,root); }
  messageState(id, state) { this.db.prepare('UPDATE messages SET state=? WHERE id=?').run(state,id); }
  session(channel, root) {
    const address = `${channel}:${root}`;
    this.db.prepare('INSERT OR IGNORE INTO sessions(address,channel,root) VALUES(?,?,?)').run(address,channel,root);
    return this.getSession(address);
  }
  getSession(address) { return this.db.prepare('SELECT * FROM sessions WHERE address=?').get(address); }
  hasSession(channel, root) { return Boolean(this.getSession(`${channel}:${root}`)); }
  sessions() { return this.db.prepare('SELECT * FROM sessions').all(); }
  update(address, { thread, turn, status }) {
    this.db.prepare('UPDATE sessions SET thread=?,turn=?,status=? WHERE address=?')
      .run(thread ?? null, turn ?? null, status, address);
  }
  prompt(nonce,address,request) {
    this.db.prepare('INSERT INTO prompts(nonce,address,request) VALUES(?,?,?)').run(nonce,address,JSON.stringify(request));
  }
  pendingPrompts(address) { return this.db.prepare("SELECT * FROM prompts WHERE address=? AND state='pending' ORDER BY rowid").all(address).map(row=>({...row,request:JSON.parse(row.request)})); }
  pendingPrompt(address) {
    const row=this.db.prepare("SELECT * FROM prompts WHERE address=? AND state='pending' ORDER BY rowid LIMIT 1").get(address);
    return row ? {...row,request:JSON.parse(row.request)} : null;
  }
  getPrompt(nonce) {
    const row=this.db.prepare("SELECT * FROM prompts WHERE nonce=? AND state='pending'").get(nonce);
    return row ? {...row,request:JSON.parse(row.request)} : null;
  }
  resolveRequest(id) { for(const row of this.db.prepare("SELECT nonce,request FROM prompts WHERE state IN ('pending','desktop')").all()) if(JSON.parse(row.request).id===id)this.settlePrompt(row.nonce); }
  expirePrompts(address) { this.db.prepare("UPDATE prompts SET state='expired' WHERE address=? AND state IN ('pending','desktop')").run(address); }
  settlePrompt(nonce) { this.db.prepare("UPDATE prompts SET state='answered' WHERE nonce=?").run(nonce); }
  deferPrompt(nonce) { this.db.prepare("UPDATE prompts SET state='desktop' WHERE nonce=?").run(nonce); }
  reserveDelivery(id) {
    return this.db.prepare("INSERT OR IGNORE INTO deliveries(id,state) VALUES(?,'sending')").run(id).changes===1;
  }
  claimAction(id) { return this.db.prepare('INSERT OR IGNORE INTO actions(id) VALUES(?)').run(id).changes===1; }
  delivery(id,ts) { this.db.prepare("UPDATE deliveries SET state='sent',ts=? WHERE id=?").run(ts,id); }
  holdUncertain() {
    this.db.exec("UPDATE messages SET state='uncertain' WHERE state='submitting'; UPDATE sessions SET status='uncertain' WHERE status IN ('starting','active'); UPDATE prompts SET state='expired' WHERE state IN ('pending','desktop')");
  }
  close() { this.db.close(); }
}
