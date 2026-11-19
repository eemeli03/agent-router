import { createServer } from 'node:http';
import { createHash,randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const hash=token=>createHash('sha256').update(token).digest('hex');
const providers=['codex','claude'];
const labels={codex:'Codex',claude:'Claude Code'};
const tokenPattern=/^[a-f0-9]{64}$/;
const fonts=new Map();

/** Owner-only pilot. Provider credentials stay in the provider's native runtime. */
export class Onboarding {
  attempts=new Map();
  constructor({owner,team,bot,origin,store,web,connect,activate,now=Date.now}) {
    Object.assign(this,{owner,team,bot,origin,store,web,connect,activate,now});
    const parsed=new URL(origin);
    if(parsed.hostname!=='127.0.0.1'||parsed.protocol!=='http:'||!parsed.port)throw new Error('Pilot requires explicit loopback origin');
  }
  async offer(channel) {
    const elements=providers.map(provider=>{
      const token=randomBytes(32).toString('hex');
      this.store.issueTicket(hash(token),this.owner,provider,this.now()+10*60_000);
      return{type:'button',text:{type:'plain_text',text:labels[provider]},action_id:`ba_connect_${provider}`,value:token,
        url:`${this.origin}/connect#${token}`,visible_to_user_ids:[this.owner]};
    });
    return this.web.chat.postMessage({channel,text:'Connect your agent — Codex or Claude Code',
      blocks:[{type:'section',text:{type:'mrkdwn',text:'*Connect your agent*\nChoose the agent for your new Slack threads.'}},{type:'actions',elements}],unfurl_links:false,unfurl_media:false});
  }
  async handleEvent(body) {
    const e=body?.event;
    if(body?.team_id!==this.team||e?.user!==this.owner||e.bot_id||e.subtype||!['message','app_mention'].includes(e.type))return false;
    const text=e.text?.replace(new RegExp(`<@${this.bot}(?:\\|[^>]+)?>`,'g'),'').trim();
    if(!/^\/?(?:setup|connect|yhdistä)$/i.test(text??''))return false;
    const dm=await this.web.conversations.open({users:this.owner});await this.offer(dm.channel.id);return true;
  }
  authorize(body) {
    if(body?.team?.id!==this.team||body?.user?.id!==this.owner)return false;
    const action=body.actions?.[0];if(!tokenPattern.test(action?.value??''))return false;
    const ticket=this.store.ticket(hash(action.value));
    if(!ticket||action.action_id!==`ba_connect_${ticket.provider}`||ticket.owner!==this.owner||ticket.expires<=this.now())return false;
    if(ticket.status==='authorized')return true;
    return this.store.ticketStatus(ticket.hash,'offered','authorized');
  }
  ticket(token) {
    if(!tokenPattern.test(token??''))throw new Error('Invalid link');
    const ticket=this.store.ticket(hash(token));
    if(!ticket||ticket.owner!==this.owner||ticket.expires<=this.now())throw new Error('Expired link');
    return ticket;
  }
  async begin(token) {
    const ticket=this.ticket(token);
    if(ticket.status==='offered')return{status:'waiting'};
    if(ticket.status==='complete')return{status:'complete',provider:labels[ticket.provider]};
    if(ticket.status==='failed')return{status:'failed'};
    const current=this.attempts.get(ticket.hash);if(current)return current.view;
    if(!this.store.ticketStatus(ticket.hash,'authorized','connecting'))return{status:'failed'};
    const attempt={view:{status:'starting'}};this.attempts.set(ticket.hash,attempt);
    try {
      const connection=await this.connect(ticket.provider);
      void connection.ready.catch(()=>{});
      if(connection.url) {
        const url=new URL(connection.url);
        const allowed=ticket.provider==='claude'?['claude.com','claude.ai','platform.claude.com']:['auth.openai.com','auth0.openai.com','chatgpt.com'];
        if(url.protocol!=='https:'||!allowed.includes(url.hostname))throw new Error('Unexpected login destination');
        attempt.view={status:'login',url:connection.url};
      }
      void connection.ready.then(async()=>{
        if(ticket.expires<=this.now())throw new Error('Link expired before login');
        await this.activate(ticket.provider);
        if(!this.store.ticketStatus(ticket.hash,'connecting','complete'))return;
        attempt.view={status:'complete',provider:labels[ticket.provider]};
        const dm=await this.web.conversations.open({users:this.owner});
        await this.web.chat.postMessage({channel:dm.channel.id,text:`${labels[ticket.provider]} connected. Your new Slack threads will use it. Existing conversations will continue with their current agent.`});
      }).catch(()=>{this.store.ticketStatus(ticket.hash,'connecting','failed');attempt.view={status:'failed'};});
      return attempt.view;
    } catch {this.store.ticketStatus(ticket.hash,'connecting','failed');attempt.view={status:'failed'};return attempt.view;}
  }
  async start() {
    const host=new URL(this.origin).host;
    this.server=createServer(async(req,res)=>{
      const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"};
      try {
        if(req.headers.host!==host)throw new Error('Wrong host');
        if(req.method==='GET'&&fonts.has(req.url)) {
          const font=await readFile(fonts.get(req.url));
          res.writeHead(200,{...headers,'content-type':'font/woff2'});res.end(font);return;
        }
        if(req.method==='GET'&&req.url==='/connect') {res.writeHead(200,{...headers,'content-type':'text/html; charset=utf-8'});res.end(page);return;}
        if(req.method!=='POST'||req.url!=='/start'||req.headers.origin!==this.origin||req.headers['content-type']!=='application/json')throw new Error('Invalid request');
        let body='';for await(const chunk of req){body+=chunk;if(body.length>256)throw new Error('Too large');}
        const result=await this.begin(JSON.parse(body).token);
        res.writeHead(200,{...headers,'content-type':'application/json'});res.end(JSON.stringify(result));
      } catch {res.writeHead(400,headers);res.end('This link has expired. Send setup to your app in Slack for a new one.');}
    });
    this.server.requestTimeout=10_000;
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(Number(new URL(this.origin).port),'127.0.0.1',resolve);});
  }
  close(){this.server?.close();}
}

const page=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Router · Connect your agent</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#131312;color:#f6f5f3;font:18px system-ui,sans-serif}
main{max-width:440px;padding:40px}h1{margin:0;font:500 42px system-ui,sans-serif}p{line-height:1.5}
</style><main><h1>Agent Router</h1><p id="status">Connecting your agent…</p></main><script>
const token=location.hash.slice(1);history.replaceState(null,'','/connect');let tries=0;
async function start(){try{const r=await fetch('/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});if(!r.ok)throw Error();const x=await r.json();if(x.status==='login'){location.replace(x.url);return;}if(x.status==='complete'){document.getElementById('status').textContent=x.provider+' connected. You can return to Slack.';return;}if(x.status==='failed')throw Error();if(++tries>60)throw Error();setTimeout(start,500);}catch{document.getElementById('status').textContent='Connection could not be completed. Send setup to your app in Slack for a new link.';}}start();
</script></html>`;
