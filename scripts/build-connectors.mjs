import { build } from 'esbuild';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const output='state/build/connector';await mkdir(output,{recursive:true});
for(const entry of ['setup','worker'])await build({entryPoints:[`src/${entry==='setup'?'setup-cli':entry}.mjs`],outfile:`${output}/${entry}.mjs`,bundle:true,platform:'node',format:'esm',target:'node26',banner:{js:'import { createRequire as __baCreateRequire } from "node:module";const require=__baCreateRequire(import.meta.url);'}});
const archive='relay/public/downloads/agent-router-connector.tar.gz';await mkdir('relay/public/downloads',{recursive:true});
execFileSync('tar',['-czf',archive,'-C',output,'setup.mjs','worker.mjs']);
const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile('relay/public/downloads/manifest.json',JSON.stringify({version:1,archive:'agent-router-connector.tar.gz',sha256},null,2)+'\n');
console.log(JSON.stringify({archive,sha256}));

const bootstrap=await readFile('scripts/bootstrap-template.sh','utf8');
await writeFile('relay/bootstrap.mjs','export default '+JSON.stringify(bootstrap.replaceAll('__ARCHIVE_SHA__',sha256))+';\n');
