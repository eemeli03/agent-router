import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {RelayClient} from '../src/relay-client.mjs';

class Socket extends EventEmitter{
 static instances=[];
 constructor(url,options){super();this.url=url;this.options=options;this.readyState=1;this.sent=[];Socket.instances.push(this);queueMicrotask(()=>this.emit('open'));}
 send(value){this.sent.push(JSON.parse(value));}
 close(){this.readyState=3;this.emit('close');}
 terminate(){this.terminated=true;this.close();}
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('application heartbeat closes a silent connection and reconnects',async()=>{
 Socket.instances=[];
 const client=new RelayClient({origin:'https://ba.test',role:'worker',registration:'r',secret:'secret',handle:async()=>{},WebSocketImpl:Socket,heartbeatMs:15,reconnectMs:1});
 try{
  client.start();await pause(2);const first=Socket.instances[0];assert.equal(first.sent[0].type,'ping');assert.equal(first.options.handshakeTimeout,10000);
  await pause(24);assert.equal(first.terminated,true);assert.ok(Socket.instances.length>=2);
 }finally{client.stop();}
});
test('only a matching application pong keeps the current connection alive',async()=>{
 Socket.instances=[];const client=new RelayClient({origin:'https://ba.test',role:'router',secret:'secret',handle:async()=>{},WebSocketImpl:Socket,heartbeatMs:25,reconnectMs:1});
 try{
  client.start();await pause(2);const first=Socket.instances[0];
  first.emit('message',JSON.stringify({type:'pong',id:first.sent[0].id}));
  await pause(28);assert.equal(first.terminated,undefined);assert.equal(first.sent.length,2);
  first.emit('message',JSON.stringify({type:'pong',id:'wrong'}));
  await pause(30);assert.equal(first.terminated,true);
 }finally{client.stop();}
});
test('server liveness probe is handled without exposing it to the agent',async()=>{
 Socket.instances=[];let handled=0;const client=new RelayClient({origin:'https://ba.test',role:'router',secret:'secret',handle:async()=>{handled++;},WebSocketImpl:Socket,heartbeatMs:1000});
 try{
  client.start();await pause(1);const socket=Socket.instances[0];
  await client.receive(socket,JSON.stringify({type:'request',id:'probe',method:'relay/ping',params:{}}));
  assert.equal(handled,0);assert.deepEqual(socket.sent.at(-1),{type:'response',id:'probe',result:{alive:true}});
 }finally{client.stop();}
});
