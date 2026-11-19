import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeOnce,validateWorkspace} from '../src/setup-utils.mjs';
import {installerZip} from '../relay/installer.mjs';
import {execFileSync} from 'node:child_process';

test('installer preserves existing files and accepts an explicit existing workspace',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ba-install-'));const file=join(dir,'config');await writeOnce(file,'original');await writeOnce(file,'original');await assert.rejects(writeOnce(file,'changed'));assert.equal(await readFile(file,'utf8'),'original');
 await assert.rejects(validateWorkspace('relative/path'));
 await assert.rejects(validateWorkspace(file));
 assert.equal(await validateWorkspace(dir),await realpath(dir));
});
test('download is a valid executable command ZIP without absolute paths',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ba-zip-')),zip=join(dir,'install.zip');await writeFile(zip,installerZip('#!/bin/bash\necho test\n'));
 const list=execFileSync('unzip',['-Z','-l',zip],{encoding:'utf8'});assert.match(list,/-rwx------/);assert.match(list,/Connect Agent Router.command/);
 const content=execFileSync('unzip',['-p',zip,'Connect Agent Router.command'],{encoding:'utf8'});assert.equal(content,'#!/bin/bash\necho test\n');
});


test('setup CLI requires a relay origin and explicit workspace before pairing',()=>{
 const cli=new URL('../src/setup-cli.mjs',import.meta.url).pathname;
 const args=[cli,'--provider','codex','--pair'];
 const fails=(arguments_,pattern)=>assert.throws(()=>execFileSync(process.execPath,arguments_,{stdio:['ignore','pipe','pipe']}),error=>error.status===1&&pattern.test(error.stderr.toString()));
 fails(args,/HTTPS relay origin/);
 fails([...args,'--origin','https://relay.example.test'],/absolute path with --workspace/);
 fails([...args,'--origin','http://relay.example.test','--workspace',tmpdir()],/HTTPS origin without a path/);
});
