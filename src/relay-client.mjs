import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/** Outbound-only connection; no local control socket is exposed to the Internet. */
export class RelayClient extends EventEmitter {
  pending=new Map(); stopped=false;
  constructor({origin,role,secret,registration,handle,WebSocketImpl=WebSocket,heartbeatMs=20_000,reconnectMs=3_000}) {
    super();Object.assign(this,{origin,role,secret,registration,handle,WebSocketImpl,heartbeatMs,reconnectMs});
    if(new URL(origin).protocol!=='https:')throw new Error('HTTPS relay required');
  }
  start(){this.stopped=false;this.connect();}
  connect(){
    if(this.stopped)return;
    const url=new URL(`/ws/${this.role}`,this.origin);url.protocol='wss:';
    if(this.registration)url.searchParams.set('registration',this.registration);
    const socket=this.socket=new this.WebSocketImpl(url,{headers:{authorization:`Bearer ${this.secret}`},maxPayload:1_000_000,handshakeTimeout:10_000});
    let heartbeat,pendingPing;
    socket.on('open',()=>{
      const ping=()=>{
        if(pendingPing){socket.terminate();return;}
        pendingPing=randomUUID();
        try{socket.send(JSON.stringify({type:'ping',id:pendingPing}));}catch{socket.terminate();}
      };
      socket.on('message',bytes=>{try{const m=JSON.parse(bytes.toString());if(m.type==='pong'&&m.id===pendingPing)pendingPing=null;}catch{}});
      ping();heartbeat=setInterval(ping,this.heartbeatMs);
      this.emit('connected');
    });
    socket.on('message',bytes=>void this.receive(socket,bytes));
    socket.on('error',()=>{});
    socket.on('close',()=>{
      clearInterval(heartbeat);
      if(socket!==this.socket)return;
      for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('Relay response unknown'));}this.pending.clear();
      if(!this.stopped)this.timer=setTimeout(()=>this.connect(),this.reconnectMs);
    });
  }
  async receive(socket,bytes){
    if(socket!==this.socket)return;
    let message;try{message=JSON.parse(bytes.toString());}catch{return;}
    if(message.type==='response'){
      const pending=this.pending.get(message.id);if(!pending)return;
      this.pending.delete(message.id);clearTimeout(pending.timer);
      message.error?pending.reject(new Error('Relay request rejected')):pending.resolve(message.result);return;
    }
    if(message.type!=='request'||typeof message.id!=='string')return;
    try{
      const result=message.method==='relay/ping'?{alive:true}:await this.handle(message.method,message.params);
      if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'response',id:message.id,result}));
    }catch{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'response',id:message.id,error:true}));}
  }
  request(method,params){
    if(this.socket?.readyState!==WebSocket.OPEN)return Promise.reject(new Error('Relay offline'));
    const id=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Relay response unknown'));},10000);
      this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({type:'request',id,method,params}));
    });
  }
  stop(){this.stopped=true;clearTimeout(this.timer);this.socket?.close();}
}
