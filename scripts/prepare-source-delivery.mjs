import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Source-only delivery. Never imports the app, DB, credential vault or backup
// worker. Root runs --copy only after the final code/build/documents are frozen.
export const SOURCE_TREES=['apps','packages','services/agent-runtime','scripts','tests'];
export const ROOT_FILES=['package.json','package-lock.json','tsconfig.json','vite.config.ts','README.md','start-local.cmd','start-local-production.cmd','start-demo.cmd','start.command'];
export const EMBEDDING_FILES=['services/embedding/local.mjs','services/embedding/local.d.mts','services/embedding/model-lock.json'];
export const LIMITS={files:20000,fileBytes:64*1024**2,totalBytes:512*1024**2,documentBytes:2*1024**2};
const deniedDirectories=new Set(['node_modules','.git','.data','.cache','.env','.private','private','credentials','secrets','coverage','test-evidence']);
const extensions=new Set(['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs','.json','.css','.html','.md','.txt','.ps1','.py','.sh','.cmd','.command','.svg','.png','.jpg','.jpeg','.webp','.gif','.ico','.woff','.woff2']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ordered=(a,b)=>a.path<b.path?-1:a.path>b.path?1:0;
const canonical=value=>JSON.stringify(value);
const identity=stat=>Object.fromEntries(['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].map(key=>[key,String(stat[key])]));
const equivalent=(a,b)=>canonical(a)===canonical(b);

export function checkedRelative(path){
 assert.equal(typeof path,'string','Selection must be a relative path');
 assert.ok(path&&!isAbsolute(path)&&!/[\\:\0<>"|?*]/.test(path),'Selection must be a plain relative path');
 assert.ok(path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),'Unsafe path component');
 return path;
}
function child(root,path){const result=resolve(root,...checkedRelative(path).split('/')),rel=relative(root,result);assert.ok(rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep),'Path escapes source root');return result;}
function excluded(path){
 const parts=path.toLowerCase().split('/'),name=parts.at(-1);
 return parts.some(part=>deniedDirectories.has(part)||part.startsWith('.env'))||/\.(?:pem|key|p12|pfx|jks|sqlite|sqlite3|db|zip|tar|gz|log|jsonl)$/.test(name)||/(?:^|[._-])(?:api[-_.]?key|key|credential[s]?|password|secret|token|master|auth|private)(?=[._-]|$).*\.(?:json|txt|yaml|yml|ini|conf)$/i.test(name)||/^(?:id_rsa|id_ed25519|device\.credential)$/i.test(name);
}
async function checkedRoot(root){const stat=await lstat(root);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Root must be an ordinary directory, not a link/junction');assert.equal((await realpath(root)).toLowerCase(),resolve(root).toLowerCase(),'Root cannot resolve through a link/junction');}
async function checkedPath(root,path){
 await checkedRoot(root);let current=root;const parts=checkedRelative(path).split('/');
 for(let i=0;i<parts.length;i++){current=join(current,parts[i]);const stat=await lstat(current,{bigint:true});assert.ok(!stat.isSymbolicLink(),'Source/destination links and junctions are refused');if(i<parts.length-1)assert.ok(stat.isDirectory(),'Path parent must be a directory');}
 return lstat(current,{bigint:true});
}
function selection(documents,includeWebBuild){
 assert.equal(typeof includeWebBuild,'boolean','Web build selection must be explicit');assert.ok(Array.isArray(documents),'Documents must be an array');
 const unique=[...new Set(documents.map(checkedRelative))].sort();
 for(const path of unique)assert.ok(path.startsWith('docs/')&&!excluded(path)&&/\.(?:md|json)$/.test(path),'Only explicitly selected public docs Markdown/JSON files are allowed');
 return {trees:[...SOURCE_TREES,...(includeWebBuild?['dist/web']:[])],files:[...ROOT_FILES,...EMBEDDING_FILES,...unique].sort(),documents:unique,includeWebBuild};
}
async function bytesAt(root,path,expected){
 const stat=await checkedPath(root,path);assert.ok(stat.isFile()&&stat.nlink===1n,'Only ordinary single-link files are allowed');assert.ok(stat.size<=BigInt(LIMITS.fileBytes),'File exceeds source byte bound');
 if(expected)assert.ok(equivalent(identity(stat),expected),'Source file changed since inventory');
 const handle=await open(child(root,path),constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{assert.ok(equivalent(identity(await handle.stat({bigint:true})),identity(stat)),'File changed before read');const bytes=await handle.readFile();assert.equal(BigInt(bytes.length),stat.size,'File changed during read');assert.ok(equivalent(identity(await handle.stat({bigint:true})),identity(stat)),'File changed during read');assert.ok(equivalent(identity(await checkedPath(root,path)),identity(stat)),'File identity changed during read');return {bytes,stat:identity(stat)};}
 finally{await handle.close();}
}

export async function inventorySource(sourceRoot,{documents=[],includeWebBuild=false}={}){
 const root=resolve(sourceRoot);await checkedRoot(root);const selected=selection(documents,includeWebBuild),files=[],directories=[],excludedPaths=[];let totalBytes=0;
 async function file(path){
  const stat=await checkedPath(root,path);assert.ok(stat.isFile()&&stat.nlink===1n,'Selected file must be ordinary and have no hard links');assert.ok(stat.size<=BigInt(LIMITS.fileBytes),'File exceeds source byte bound');
  if(selected.documents.includes(path))assert.ok(stat.size<=BigInt(LIMITS.documentBytes),'Selected document exceeds byte bound');
  assert.ok(files.length<LIMITS.files,'File count exceeds source bound');totalBytes+=Number(stat.size);assert.ok(totalBytes<=LIMITS.totalBytes,'Source exceeds total byte bound');
  const read=await bytesAt(root,path,identity(stat));files.push({path,bytes:read.bytes.length,sha256:hash(read.bytes),sourceStat:read.stat});
 }
 async function walk(path){
  const stat=await checkedPath(root,path);assert.ok(stat.isDirectory(),'Selected tree must be a directory');assert.ok(directories.length<LIMITS.files,'Directory count exceeds source bound');directories.push({path,sourceStat:identity(stat)});
  for(const entry of (await readdir(child(root,path),{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
   const name=path+'/'+entry.name;checkedRelative(name);if(excluded(name)){excludedPaths.push(name);continue;}
   const current=await checkedPath(root,name);assert.ok(!current.isSymbolicLink(),'Source links are refused');
   if(current.isDirectory())await walk(name);else{assert.ok(current.isFile(),'Unsupported source entry');assert.ok(extensions.has(extname(name).toLowerCase()),'Unsupported source file type; select source code only');await file(name);}
  }
  assert.ok(equivalent(identity(await checkedPath(root,path)),identity(stat)),'Source directory changed during inventory');
 }
 for(const path of selected.trees)await walk(path);for(const path of selected.files)await file(path);
 files.sort(ordered);directories.sort(ordered);excludedPaths.sort();
 for(const row of [...directories,...files])assert.ok(equivalent(identity(await checkedPath(root,row.path)),row.sourceStat),'Source changed during final inventory identity check');
 return {format:'source-delivery-inventory-v1',sourceRoot:root,selection:selected,files,directories,excludedPaths,fileCount:files.length,totalBytes,contentSha256:hash(canonical(files.map(({path,bytes,sha256})=>({path,bytes,sha256}))))};
}
async function inventoryCopy(root){
 const files=[],directories=[];async function walk(path=''){
  const directory=path?child(root,path):root;await checkedRoot(directory);
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const name=path?path+'/'+entry.name:entry.name,stat=await checkedPath(root,name);
   if(stat.isDirectory()){directories.push(name);await walk(name);}else{const read=await bytesAt(root,name);files.push({path:name,bytes:read.bytes.length,sha256:hash(read.bytes)});}
  }
 }await walk();return {files:files.sort(ordered),directories:directories.sort()};
}
async function ensureDirectory(root,path){
 await checkedRoot(root);let current=root;
 for(const part of checkedRelative(path).split('/')){await checkedRoot(current);current=join(current,part);try{await mkdir(current);}catch(error){if(error.code!=='EEXIST')throw error;}await checkedRoot(current);}
}
function copyDirectories(inventory){
 const dirs=new Set(inventory.directories.map(row=>row.path));
 for(const row of [...inventory.directories,...inventory.files]){const parts=row.path.split('/');while(parts.length>1){parts.pop();dirs.add(parts.join('/'));}}
 return [...dirs].sort();
}

export async function copySourceDelivery({sourceRoot,documents=[],includeWebBuild=false,expectedInventory}={}){
 const root=resolve(sourceRoot),options={documents,includeWebBuild},before=await inventorySource(root,options);
 if(expectedInventory)assert.ok(equivalent(before,expectedInventory),'Source changed from the supplied frozen inventory');
 const name='source-delivery-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID(),destination=child(root,name),codeRoot=join(destination,'code');
 await checkedRoot(root);await mkdir(destination);await checkedRoot(destination);await mkdir(codeRoot);
 const base={format:'source-delivery-copy-v1',sourceRoot:root,destination,codeRoot,startedAt:new Date().toISOString(),selection:before.selection};
 try{
  const expectedDirectories=copyDirectories(before);for(const path of expectedDirectories)await ensureDirectory(codeRoot,path);
  for(const row of before.files){
   const read=await bytesAt(root,row.path,row.sourceStat);assert.equal(hash(read.bytes),row.sha256,'Source bytes changed since inventory');
   const parent=dirname(child(codeRoot,row.path));await checkedRoot(parent);await checkedRoot(codeRoot);await writeFile(child(codeRoot,row.path),read.bytes,{flag:'wx'});
  }
  const copied=await inventoryCopy(codeRoot),content=before.files.map(({path,bytes,sha256})=>({path,bytes,sha256}));assert.ok(equivalent(content,copied.files),'Copied byte manifest differs from source');assert.ok(equivalent(expectedDirectories,copied.directories),'Copied directories differ from source');
  const after=await inventorySource(root,options);assert.ok(equivalent(before,after),'Source changed while copying; copy is not verified');
  const manifest={...base,status:'verified-source-copy',verifiedAt:new Date().toISOString(),sourceStable:true,copiedBytesIdentical:true,inventory:before,copiedFiles:copied.files,copiedDirectories:copied.directories};
  await checkedRoot(destination);await writeFile(join(destination,'code-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
 }catch(error){
  await checkedRoot(destination);await writeFile(join(destination,'status.json'),JSON.stringify({...base,status:'failed-source-copy',failedAt:new Date().toISOString(),reason:String(error.message).slice(0,400)},null,2)+'\n',{flag:'wx'});throw error;
 }
}

async function main(args){
 if(args.includes('--help')){assert.equal(args.length,1);console.log('Offline source only. No data/API/services.\nnode scripts/prepare-source-delivery.mjs --inventory|--copy [--include-web-build] [--document=docs/path.md ...]\n--copy creates a new source-delivery-<UTC>-<UUID>/code under this workspace. Documents are exact public Markdown/JSON selections. Final delivery status requires separate data backup and runtime acceptance.');return;}
 assert.ok(args.every(arg=>['--copy','--inventory','--include-web-build'].includes(arg)||arg.startsWith('--document=')),'Unknown argument');
 assert.equal(args.filter(arg=>arg==='--copy'||arg==='--inventory').length,1,'Explicit --copy or --inventory is required');assert.ok(args.filter(arg=>arg==='--include-web-build').length<=1,'Duplicate build flag');
 const sourceRoot=fileURLToPath(new URL('../',import.meta.url)),documents=args.filter(arg=>arg.startsWith('--document=')).map(arg=>arg.slice('--document='.length)),includeWebBuild=args.includes('--include-web-build');
 if(args.includes('--inventory'))console.log(JSON.stringify(await inventorySource(sourceRoot,{documents,includeWebBuild}),null,2));
 else{const result=await copySourceDelivery({sourceRoot,documents,includeWebBuild});console.log(JSON.stringify({status:result.status,destination:result.destination,manifest:join(result.destination,'code-manifest.json'),files:result.inventory.fileCount,bytes:result.inventory.totalBytes,contentSha256:result.inventory.contentSha256}));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
