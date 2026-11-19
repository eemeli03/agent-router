// A single executable .command in an uncompressed ZIP, with Unix mode preserved.
export function installerZip(script){
 const name=new TextEncoder().encode('Connect Agent Router.command'),body=new TextEncoder().encode(script);
 let crc=0xffffffff;for(const b of body){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
 const local=new Uint8Array(30+name.length),v=new DataView(local.buffer);
 v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(14,crc,true);v.setUint32(18,body.length,true);v.setUint32(22,body.length,true);v.setUint16(26,name.length,true);local.set(name,30);
 const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);
 c.setUint32(0,0x02014b50,true);c.setUint16(4,0x0314,true);c.setUint16(6,20,true);c.setUint32(16,crc,true);c.setUint32(20,body.length,true);c.setUint32(24,body.length,true);c.setUint16(28,name.length,true);c.setUint32(38,0x81c00000,true);central.set(name,46);
 const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,1,true);e.setUint16(10,1,true);e.setUint32(12,central.length,true);e.setUint32(16,local.length+body.length,true);
 const result=new Uint8Array(local.length+body.length+central.length+end.length);let offset=0;for(const part of[local,body,central,end]){result.set(part,offset);offset+=part.length;}return result;
}
