import bootstrap from './bootstrap.mjs';
import {installerZip} from './installer.mjs';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const token=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export default {async fetch(request,env){
  const url=new URL(request.url);
  if(url.protocol!=='https:')return json({error:'HTTPS required'},400);
  if(url.pathname==='/health')return json({ok:true});
  if(url.pathname.startsWith('/ws/')||url.pathname.startsWith('/api/')||url.pathname.startsWith('/downloads/'))return env.RELAY.get(env.RELAY.idFromName('agent-router')).fetch(request);
  return env.ASSETS.fetch(request);
}};

export class Relay {
  pending=new Map();
  connecting=new Set();
  constructor(state,env){this.state=state;this.env=env;}
  async fetch(request){
    const url=new URL(request.url);
    try{
      if(url.pathname==='/ws/router'){
        const auth=request.headers.get('authorization');
        if(!this.env.ROUTER_SECRET||await digest(auth??'')!==await digest(`Bearer ${this.env.ROUTER_SECRET}`))return json({error:'Unauthorized'},401);
        return this.connect(request,{role:'router'});
      }
      if(url.pathname==='/ws/worker'){
        const registration=url.searchParams.get('registration'),saved=await this.state.storage.get(`worker:${registration}`);
        if(!saved||await digest(request.headers.get('authorization')??'')!==saved.secretHash)return json({error:'Unauthorized'},401);
        return this.connect(request,{role:'worker',registration});
      }
      if(request.method==='GET'&&url.pathname==='/downloads/agent-router-connector.tar.gz'){
        const ticket=request.headers.get('x-ba-setup-ticket');if(!token(ticket))throw Error();
        await this.call('router','team/status',{token:ticket});
        const asset=await this.env.ASSETS.fetch(request);
        return new Response(asset.body,{status:asset.status,headers:{'content-type':'application/gzip','cache-control':'no-store','x-content-type-options':'nosniff'}});
      }
      if(request.method!=='POST'||request.headers.get('content-type')!=='application/json')return json({error:'Not found'},404);
      const text=await request.text();if(text.length>4096)return json({error:'Too large'},413);
      const body=JSON.parse(text);
      if(url.pathname==='/api/plugin-pair'){
        if(!token(body.token))throw Error();
        return json(await this.call('router','plugin/pair',body));
      }
      if(url.pathname==='/api/status'){
        if(!token(body.token))throw Error();
        return json(await this.call('router','team/status',{token:body.token}));
      }
      if(url.pathname==='/api/installer'){
        if(request.headers.get('origin')!==url.origin||!token(body.token))throw Error();
        await this.call('router','team/status',{token:body.token});
        const script=bootstrap.replaceAll('__ORIGIN__',url.origin).replaceAll('__TICKET__',body.token);
        return new Response(installerZip(script),{headers:{'content-type':'application/zip','content-disposition':'attachment; filename=Connect-Agent-Router.zip','cache-control':'no-store'}});
      }
      if(url.pathname==='/api/claim'){
        if(!token(body.token)||!token(body.deviceSecret))throw Error();
        const result=await this.call('router','team/claim',{token:body.token,deviceSecret:body.deviceSecret});
        if(!result?.registration||!result?.owner)throw Error();
        await this.state.storage.put(`worker:${result.registration}`,{secretHash:await digest(`Bearer ${body.deviceSecret}`)});
        return json(result);
      }
      return json({error:'Not found'},404);
    }catch{return json({error:'Connection unavailable. Return to Slack and request a new setup link.'},400);}
  }
  async connect(request,identity){
    if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket required'},400);
    const tag=identity.role==='router'?'router':`worker:${identity.registration}`;
    if(this.connecting.has(tag))return json({error:'Connection check in progress'},409);
    this.connecting.add(tag);
    try{
      // A TCP drop can leave a hibernated socket behind. Probe it before allowing
      // a replacement; even a legacy client's error response proves it is alive.
      const old=this.state.getWebSockets(tag).filter(s=>!s.deserializeAttachment()?.retired);
      const alive=await Promise.all(old.map(s=>this.probeSocket(s)));
      if(alive.some(Boolean))return json({error:'Already connected'},409);
      for(const s of old){s.serializeAttachment({...s.deserializeAttachment(),retired:true});this.webSocketClose(s);try{s.close(1001,'Connection no longer responding');}catch{}}
      const pair=new WebSocketPair();this.state.acceptWebSocket(pair[1],[tag]);pair[1].serializeAttachment(identity);
      return new Response(null,{status:101,webSocket:pair[0]});
    }finally{this.connecting.delete(tag);}
  }
  probeSocket(socket){
    if(socket.readyState!==WebSocket.OPEN)return Promise.resolve(false);
    const id=crypto.randomUUID();return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.pending.delete(id);resolve(false);},3000);
      this.pending.set(id,{socket,probe:true,timer,resolve:()=>resolve(true),reject:()=>resolve(false)});
      try{socket.send(JSON.stringify({type:'request',id,method:'relay/ping',params:{}}));}
      catch{clearTimeout(timer);this.pending.delete(id);resolve(false);}
    });
  }
  call(tag,method,params){
    const socket=this.state.getWebSockets(tag).find(s=>s.readyState===WebSocket.OPEN&&!s.deserializeAttachment()?.retired);if(!socket)return Promise.reject(Error('Offline'));
    const id=crypto.randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Unknown response'));},8000);
      this.pending.set(id,{socket,resolve,reject,timer});socket.send(JSON.stringify({type:'request',id,method,params}));
    });
  }
  async webSocketMessage(socket,data){
    try{
      if(typeof data!=='string'||data.length>900000)throw Error();
      const message=JSON.parse(data),identity=socket.deserializeAttachment();
      if(identity?.retired)return;
      if(message.type==='ping'&&typeof message.id==='string'&&message.id.length<=80){socket.send(JSON.stringify({type:'pong',id:message.id}));return;}
      if(message.type==='response'){
        const pending=this.pending.get(message.id);if(!pending||pending.socket!==socket)return;
        this.pending.delete(message.id);clearTimeout(pending.timer);
        message.error&&!pending.probe?pending.reject(Error('Rejected')):pending.resolve(message.result);return;
      }
      if(message.type!=='request'||typeof message.id!=='string'||message.id.length>80)return;
      let result;
      if(identity.role==='router'&&message.method==='worker/event'){
        const {registration,kind,payload}=message.params;
        if(!['event','action'].includes(kind))throw Error();
        result=await this.call(`worker:${registration}`,`worker/${kind}`,payload);
      }else if(identity.role==='worker'&&['worker/output','worker/ready'].includes(message.method)){
        result=await this.call('router',message.method,{registration:identity.registration,body:message.params});
      }else throw Error();
      socket.send(JSON.stringify({type:'response',id:message.id,result}));
    }catch{try{const m=JSON.parse(data);if(m.type==='request')socket.send(JSON.stringify({type:'response',id:m.id,error:true}));}catch{}}
  }
  webSocketClose(socket){
    for(const [id,p]of this.pending)if(p.socket===socket){clearTimeout(p.timer);p.reject(Error('Disconnected'));this.pending.delete(id);}
  }
  webSocketError(socket){this.webSocketClose(socket);}
}
