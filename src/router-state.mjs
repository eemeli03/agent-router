import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class RouterState {
  constructor(file) {
    mkdirSync(dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);chmodSync(file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),team TEXT NOT NULL,bot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registrations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,provider TEXT NOT NULL,email TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(channel TEXT,root TEXT,owner TEXT NOT NULL,provider TEXT NOT NULL,registration TEXT NOT NULL,PRIMARY KEY(channel,root));
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,owner TEXT NOT NULL,provider TEXT NOT NULL,registration TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS input_scope(owner TEXT,channel TEXT,root TEXT,ts TEXT,PRIMARY KEY(owner,channel,root,ts));
      CREATE TABLE IF NOT EXISTS outputs(id TEXT PRIMARY KEY,digest TEXT NOT NULL,status TEXT NOT NULL,ts TEXT);
      CREATE TABLE IF NOT EXISTS team_tickets(hash TEXT PRIMARY KEY,owner TEXT NOT NULL,email TEXT NOT NULL,provider TEXT NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL,registration TEXT,secretHash TEXT);
      CREATE TABLE IF NOT EXISTS team_workers(registration TEXT PRIMARY KEY,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_offers(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS team_setup_prompts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,channel TEXT,ts TEXT);
      CREATE TABLE IF NOT EXISTS plugin_pair_requests(hash TEXT PRIMARY KEY,email TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_pair_deliveries(hash TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_pair_messages(hash TEXT PRIMARY KEY,channel TEXT NOT NULL,ts TEXT NOT NULL,connected INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS team_setup_cards(owner TEXT PRIMARY KEY,channel TEXT NOT NULL,ts TEXT,state TEXT NOT NULL,codexHash TEXT,claudeHash TEXT);
      CREATE TABLE IF NOT EXISTS team_card_updates(owner TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_card_status(owner TEXT,provider TEXT,registration TEXT NOT NULL,PRIMARY KEY(owner,provider));
      CREATE TABLE IF NOT EXISTS provider_preferences(owner TEXT PRIMARY KEY,registration TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS onboarding_tickets(hash TEXT PRIMARY KEY,owner TEXT NOT NULL,provider TEXT NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL);`);
  }
  teamCard(owner){return this.db.prepare('SELECT * FROM team_setup_cards WHERE owner=?').get(owner);}
  setupPrompt(id){return this.db.prepare('SELECT * FROM team_setup_prompts WHERE id=?').get(id);}
  latestSetupPrompt(owner){return this.db.prepare('SELECT * FROM team_setup_prompts WHERE owner=? ORDER BY rowid DESC LIMIT 1').get(owner);}
  reserveSetupPrompt(id,owner,digest){
    this.db.prepare("INSERT OR IGNORE INTO team_setup_prompts(id,owner,digest,state) VALUES(?,?,?,'pending')").run(id,owner,digest);
    const saved=this.setupPrompt(id);
    if(saved.owner!==owner||saved.digest!==digest)throw Error('Setup prompt identity changed');
  }
  beginSetupPrompt(id){return this.db.prepare("UPDATE team_setup_prompts SET state='sending' WHERE id=? AND state IN ('pending','failed')").run(id).changes===1;}
  finishSetupPrompt(id,state,channel=null,ts=null){this.db.prepare("UPDATE team_setup_prompts SET state=?,channel=?,ts=? WHERE id=? AND state='sending'").run(state,channel,ts,id);}
  queueCardStatus(owner,provider,registration){this.db.prepare('INSERT INTO team_card_status VALUES(?,?,?) ON CONFLICT(owner,provider) DO UPDATE SET registration=excluded.registration').run(owner,provider,registration);}
  pendingCardStatuses(){return this.db.prepare('SELECT * FROM team_card_status').all();}
  finishCardStatus(owner,provider,registration){this.db.prepare('DELETE FROM team_card_status WHERE owner=? AND provider=? AND registration=?').run(owner,provider,registration);}
  teamCardUpdate(owner){const row=this.db.prepare('SELECT payload FROM team_card_updates WHERE owner=?').get(owner);return row?JSON.parse(row.payload):null;}
  beginTeamCardUpdate(owner,payload){this.db.prepare('INSERT INTO team_card_updates VALUES(?,?)').run(owner,JSON.stringify(payload));}
  finishTeamCardUpdate(owner,applied){
    const pending=this.teamCardUpdate(owner);if(!pending)return;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(applied)for(const provider of ['codex','claude'])this.teamCardButton(owner,provider,pending.after[provider]);
      if(pending.pairHash)this.db.prepare('UPDATE plugin_pair_deliveries SET state=? WHERE hash=?').run(applied?'sent':'failed',pending.pairHash);
      this.db.prepare('DELETE FROM team_card_updates WHERE owner=?').run(owner);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  beginTeamCard(owner,channel){return this.db.prepare("INSERT OR IGNORE INTO team_setup_cards(owner,channel,state) VALUES(?,?,'creating')").run(owner,channel).changes===1;}
  finishTeamCard(owner,{ts,codexHash,claudeHash}){this.db.prepare("UPDATE team_setup_cards SET ts=?,codexHash=?,claudeHash=?,state='live' WHERE owner=? AND state='creating'").run(ts,codexHash,claudeHash,owner);}
  failTeamCard(owner,state){this.db.prepare("UPDATE team_setup_cards SET state=? WHERE owner=? AND state='creating'").run(state,owner);}
  retryTeamCard(owner){return this.db.prepare("UPDATE team_setup_cards SET state='creating' WHERE owner=? AND state='failed'").run(owner).changes===1;}
  teamCardButton(owner,provider,hash){
    if(!['codex','claude'].includes(provider))throw Error('Invalid provider');
    this.db.prepare(`UPDATE team_setup_cards SET ${provider}Hash=? WHERE owner=? AND state='live'`).run(hash,owner);
  }
  pluginPairDelivery(hash){return this.db.prepare('SELECT state FROM plugin_pair_deliveries WHERE hash=?').get(hash)?.state;}
  pluginPairMessage(hash){return this.db.prepare('SELECT * FROM plugin_pair_messages WHERE hash=?').get(hash);}
  savePluginPairMessage(hash,channel,ts){this.db.prepare('INSERT INTO plugin_pair_messages(hash,channel,ts) VALUES(?,?,?)').run(hash,channel,ts);}
  latestPluginPairing(owner,provider){return this.db.prepare('SELECT t.hash FROM plugin_pair_requests p JOIN team_tickets t ON t.hash=p.hash WHERE t.owner=? AND t.provider=? ORDER BY p.created DESC,p.rowid DESC LIMIT 1').get(owner,provider)?.hash;}
  connectedPairMessages(owner,provider,registration){return this.db.prepare("SELECT m.* FROM plugin_pair_messages m JOIN team_tickets t ON t.hash=m.hash WHERE t.owner=? AND t.provider=? AND t.registration=? AND t.status='connected' AND m.connected=0").all(owner,provider,registration);}
  finishPairMessage(hash){this.db.prepare('UPDATE plugin_pair_messages SET connected=1 WHERE hash=?').run(hash);}
  beginPluginPairDelivery(hash){
    this.db.prepare("INSERT OR IGNORE INTO plugin_pair_deliveries VALUES(?,'pending')").run(hash);
    return this.db.prepare("UPDATE plugin_pair_deliveries SET state='sending' WHERE hash=? AND state IN ('pending','failed')").run(hash).changes===1;
  }
  finishPluginPairDelivery(hash,state){this.db.prepare("UPDATE plugin_pair_deliveries SET state=? WHERE hash=? AND state='sending'").run(state,hash);}
  reservePluginPairing(t,now=Date.now()){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const prior=this.teamTicket(t.hash);
      if(prior){if(prior.owner!==t.owner||prior.email!==t.email||prior.provider!==t.provider)throw Error('Pairing identity mismatch');this.db.exec('COMMIT');return false;}
      const recent=this.db.prepare('SELECT t.status FROM plugin_pair_requests p JOIN team_tickets t ON t.hash=p.hash WHERE p.email=? AND p.created>? ORDER BY p.created DESC,p.rowid DESC LIMIT 1').get(t.email,now-60_000);
      if(recent?.status==='offered')throw Error('Pairing requested too recently');
      this.teamIssue(t);this.db.prepare('INSERT INTO plugin_pair_requests VALUES(?,?,?)').run(t.hash,t.email,now);this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  teamOfferEvent(id){return this.db.prepare('INSERT OR IGNORE INTO team_offers VALUES(?)').run(id).changes===1;}
  teamIssue(t){this.db.prepare("INSERT INTO team_tickets(hash,owner,email,provider,expires,status) VALUES(?,?,?,?,?,'offered')").run(t.hash,t.owner,t.email,t.provider,t.expires);}
  teamTicket(hash){return this.db.prepare('SELECT * FROM team_tickets WHERE hash=?').get(hash);}
  teamEnrollment(owner,provider){return this.db.prepare("SELECT * FROM team_tickets WHERE owner=? AND provider=? AND status IN ('claimed','connected') AND (expires>? OR status='connected') LIMIT 1").get(owner,provider,Date.now());}
  teamRegistration(id){return this.db.prepare('SELECT * FROM team_tickets WHERE registration=?').get(id);}
  teamSelect(hash,registration){this.db.prepare("UPDATE team_tickets SET status='connected',registration=? WHERE hash=? AND status='authorized'").run(registration,hash);}
  teamStatus(hash,from,to){return this.db.prepare('UPDATE team_tickets SET status=? WHERE hash=? AND status=?').run(to,hash,from).changes===1;}
  teamClaim(hash,id,secretHash){if(this.db.prepare("UPDATE team_tickets SET registration=?,secretHash=?,status='claimed' WHERE hash=? AND status='authorized'").run(id,secretHash,hash).changes!==1)throw Error('Ticket already claimed');}
  teamWorkers(){return this.db.prepare('SELECT config FROM team_workers').all().map(r=>JSON.parse(r.config));}
  updateTeamWorker(w){this.db.prepare('UPDATE team_workers SET config=? WHERE registration=?').run(JSON.stringify(w),w.registration);}
  saveTeamWorker(w){this.db.prepare('INSERT INTO team_workers VALUES(?,?)').run(w.registration,JSON.stringify(w));}
  bindIdentity(team,bot) {
    this.db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?,?)').run(team,bot);
    const saved=this.db.prepare('SELECT * FROM identity WHERE id=1').get();
    if(saved.team!==team||saved.bot!==bot)throw new Error('Router state belongs to another Slack app');
  }
  bindWorker(worker) {
    this.db.prepare('INSERT OR IGNORE INTO registrations VALUES(?,?,?,?)').run(worker.registration,worker.owner,worker.provider,worker.email);
    const saved=this.db.prepare('SELECT * FROM registrations WHERE id=?').get(worker.registration);
    if(saved.owner!==worker.owner || saved.provider!==worker.provider || saved.email!==worker.email)throw new Error('Registration account cannot change');
  }
  bindings(){return this.db.prepare('SELECT * FROM bindings').all();}
  preference(owner){return this.db.prepare('SELECT registration FROM provider_preferences WHERE owner=?').get(owner)?.registration;}
  selectProvider(owner,registration){this.db.prepare('INSERT INTO provider_preferences VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET registration=excluded.registration').run(owner,registration);}
  issueTicket(hash,owner,provider,expires){this.db.prepare("INSERT INTO onboarding_tickets VALUES(?,?,?,?,'offered')").run(hash,owner,provider,expires);}
  ticket(hash){return this.db.prepare('SELECT * FROM onboarding_tickets WHERE hash=?').get(hash);}
  ticketStatus(hash,from,to){return this.db.prepare('UPDATE onboarding_tickets SET status=? WHERE hash=? AND status=?').run(to,hash,from).changes===1;}
  binding(channel,root){return this.db.prepare('SELECT * FROM bindings WHERE channel=? AND root=?').get(channel??'',root??'');}
  admit(worker,input,payload) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO bindings VALUES(?,?,?,?,?)').run(input.channel,input.root,worker.owner,worker.provider,worker.registration);
      const binding=this.binding(input.channel,input.root);
      if(binding.owner!==worker.owner||binding.registration!==worker.registration||binding.provider!==worker.provider)throw new Error('Binding changed');
      this.db.prepare('INSERT OR IGNORE INTO input_scope VALUES(?,?,?,?)').run(worker.owner,input.channel,input.root,input.ts);
      this.db.prepare("INSERT OR IGNORE INTO inbox VALUES(?,?,?,?,?,?,'pending')").run(input.id,worker.owner,worker.provider,worker.registration,'event',JSON.stringify(payload));
      this.db.exec('COMMIT');return true;
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  action(worker,id,body){this.db.prepare("INSERT OR IGNORE INTO inbox VALUES(?,?,?,?,?,?,'pending')").run(id,worker.owner,worker.provider,worker.registration,'action',JSON.stringify({...body,deliveryId:id}));return true;}
  pending(){return this.db.prepare("SELECT * FROM inbox WHERE status='pending' ORDER BY rowid LIMIT 100").all();}
  pendingFor(owner,registration){return registration?this.db.prepare("SELECT * FROM inbox WHERE status='pending' AND owner=? AND registration=? ORDER BY rowid LIMIT 25").all(owner,registration):this.db.prepare("SELECT * FROM inbox WHERE status='pending' AND owner=? ORDER BY rowid LIMIT 25").all(owner);}
  delivered(id){this.db.prepare("UPDATE inbox SET status='delivered' WHERE id=?").run(id);}
  hasInput(owner,channel,root,ts){return Boolean(this.db.prepare('SELECT 1 FROM input_scope WHERE owner=? AND channel=? AND root=? AND ts=?').get(owner,channel,root,ts));}
  output(id){return this.db.prepare('SELECT * FROM outputs WHERE id=?').get(id);}
  reserveOutput(id,digest){this.db.prepare("INSERT INTO outputs VALUES(?,?,'sending',NULL)").run(id,digest);}
  sentOutput(id,ts){this.db.prepare("UPDATE outputs SET status='sent',ts=? WHERE id=?").run(ts,id);}
  close(){this.db.close();}
}
