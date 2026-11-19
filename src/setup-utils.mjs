import {access,readFile,writeFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
export async function exists(path){try{await access(path);return true;}catch{return false;}}
export async function writeOnce(path,content){
 try{await writeFile(path,content,{mode:0o600,flag:'wx'});}
 catch(e){if(e.code!=='EEXIST')throw e;if(await readFile(path,'utf8')!==content)throw Error('Existing connector configuration differs; it was preserved.');}
}
export async function validateWorkspace(path) {
 if(typeof path!=='string'||!isAbsolute(path))throw Error('Provide an absolute path with --workspace.');
 const resolved=await realpath(path).catch(()=>{throw Error('Workspace directory does not exist.');});
 if(!(await stat(resolved)).isDirectory())throw Error('Workspace must be a directory.');
 return resolved;
}
