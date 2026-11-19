import { createServer, request } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';

async function removeStaleSocket(path) {
  let stat;
  try { stat=lstatSync(path); } catch(error) { if(error.code==='ENOENT')return;throw error; }
  if(!stat.isSocket() || stat.uid!==process.getuid())throw new Error('Socket path is not owned by this service');
  const active=await new Promise((resolve,reject)=>{
    const socket=createConnection(path);
    socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('Socket ownership check timed out'));});
    socket.once('connect',()=>{socket.destroy();resolve(true);});
    socket.once('error',error=>error.code==='ECONNREFUSED'?resolve(false):reject(error));
  });
  if(active)throw new Error('Service is already listening');
  const current=lstatSync(path);
  if(current.ino!==stat.ino||current.dev!==stat.dev)throw new Error('Socket path changed during startup');
  unlinkSync(path);
}

export function sameSecret(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a=Buffer.from(received),b=Buffer.from(expected);
  return a.length===b.length && timingSafeEqual(a,b);
}

export async function listenPrivate(socketPath, handler) {
  await removeStaleSocket(socketPath);
  const server=createServer(async(req,res)=>{
    try {
      let size=0;const chunks=[];
      for await(const chunk of req) {
        size+=chunk.length;
        if(size>512_000)throw new Error('Request too large');
        chunks.push(chunk);
      }
      if(req.method!=='POST')throw new Error('POST required');
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const result=await handler(req.url,body,req.headers.authorization);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result??{}));
    } catch {
      res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"Request rejected"}');
    }
  });
  server.requestTimeout=10_000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  chmodSync(socketPath,0o660);
  return server;
}

export function privateCall(socketPath, path, secret, body) {
  return new Promise((resolve,reject)=>{
    const req=request({socketPath,path,method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${secret}`}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>512_000)req.destroy(new Error('Response too large'));else chunks.push(chunk);});
      res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('Private endpoint rejected request');resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(error){reject(error);}});
    });
    req.setTimeout(5000,()=>req.destroy(new Error('Private endpoint response unknown')));
    req.on('error',reject);req.end(JSON.stringify(body));
  });
}
