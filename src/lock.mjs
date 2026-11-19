import net from 'node:net';
import { createHash } from 'node:crypto';

/** A bound loopback port gives the kernel one lifetime owner, including across crashes. */
export async function acquireLock(file) {
  const key=createHash('sha256').update(file).digest().readUInt32BE(0);
  const port=30000+(key%20000);
  const server=net.createServer(socket=>socket.end());
  await new Promise((resolve,reject)=>{
    server.once('error',error=>reject(new Error(error.code==='EADDRINUSE'?'This personal agent is already running':error.message)));
    server.listen({host:'127.0.0.1',port,exclusive:true},resolve);
  });
  return ()=>new Promise(resolve=>server.close(resolve));
}
