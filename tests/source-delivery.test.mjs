import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {watch,writeFileSync} from 'node:fs';
import {link,mkdtemp,mkdir,readFile,readdir,stat,symlink,truncate,unlink,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {checkedRelative,copySourceDelivery,inventorySource,ROOT_FILES,SOURCE_TREES,EMBEDDING_FILES,LIMITS} from '../scripts/prepare-source-delivery.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Synthetic roots only; no original data, API, services or final code bundle.
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'source-delivery-fixture-'));
 const put=async(path,bytes)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);};
 for(const tree of SOURCE_TREES)await mkdir(join(root,tree),{recursive:true});
 for(const file of [...ROOT_FILES,...EMBEDDING_FILES])await put(file,Buffer.from('fixture '+file+'\r\n为伍\0\xff','utf8'));
 await put('apps/web/src/main.tsx','export const title="为伍";\r\n');await put('packages/contracts/index.ts','export const fixture=true;\n');await put('services/agent-runtime/host.mjs','export const fixture=true;\n');await put('services/agent-runtime/package.json','{"fixture":true}\n');await put('services/agent-runtime/package-lock.json','{"fixtureLock":true}\n');await put('scripts/local.mjs','// No launcher invocation in fixtures\n');await put('tests/fixture.test.ts','// Fixture only\n');await mkdir(join(root,'apps/empty'),{recursive:true});
 await put('docs/local-run.md','# Synthetic guide\n');await put('docs/validation/final.json','{"fixture":true}\n');await put('dist/web/index.html','<!doctype html><h1>为伍</h1>\r\n');await put('dist/web/assets/app.js','console.log("fixture");\n');return {root,put};
}

test('source whitelist produces identical byte hashes, keeps empty directories and original files, and every copy has a fresh directory',async()=>{
 const {root}=await fixture(),before=await inventorySource(root),first=await copySourceDelivery({sourceRoot:root,expectedInventory:before}),second=await copySourceDelivery({sourceRoot:root});
 assert.equal(first.status,'verified-source-copy');assert.equal(first.sourceStable,true);assert.notEqual(first.destination,second.destination);assert.equal(dirname(first.destination),root);assert.equal(first.inventory.contentSha256,second.inventory.contentSha256);assert.deepEqual(await inventorySource(root),before);
 for(const row of first.inventory.files){const original=await readFile(join(root,row.path)),copied=await readFile(join(first.codeRoot,row.path));assert.deepEqual(copied,original);assert.equal(sha(original),row.sha256);assert.equal(copied.length,row.bytes);assert.ok(row.sourceStat.ctimeNs&&row.sourceStat.mtimeNs&&row.sourceStat.ino&&row.sourceStat.dev);}
 assert.ok(first.copiedDirectories.includes('apps/empty'));assert.ok((await stat(join(first.codeRoot,'apps/empty'))).isDirectory());const persisted=JSON.parse(await readFile(join(first.destination,'code-manifest.json'),'utf8'));assert.equal(persisted.status,'verified-source-copy');assert.equal(persisted.inventory.fileCount,before.fileCount);
});

test('node_modules, private data, environment files, credential files and large evidence are excluded without becoming payload',async()=>{
 const {root,put}=await fixture();
 for(const path of ['.env','node_modules/private.json','.git/config','.data/local/credentials/master','docs/test-evidence/huge.json','apps/api/.env.production','apps/api/credentials/master.json','scripts/private/internal.json','tests/api-key.json','tests/password.txt','tests/private.pem','tests/journal.jsonl'])await put(path,'SYNTHETIC EXCLUDED CONTENT');
 const inv=await inventorySource(root),copy=await copySourceDelivery({sourceRoot:root});assert.ok(inv.excludedPaths.includes('tests/api-key.json'));assert.ok(inv.excludedPaths.includes('apps/api/.env.production'));
 assert.ok(copy.copiedFiles.every(row=>!/node_modules|\.data|test-evidence|\.env|api-key|password|private\.pem|journal\.jsonl/.test(row.path)));assert.deepEqual((await readdir(copy.codeRoot)).sort(),['README.md','apps','package-lock.json','package.json','packages','scripts','services','start-demo.cmd','start-local-production.cmd','start-local.cmd','start.command','tests','tsconfig.json','vite.config.ts'].sort());
});

test('build and documents require explicit selections and are byte-verified, while evidence/private paths and traversal are rejected',async()=>{
 const {root,put}=await fixture(),docs=['docs/local-run.md','docs/validation/final.json'];await put('docs/private/internal.json','SYNTHETIC');await put('docs/test-evidence/raw.json','SYNTHETIC');
 const basic=await inventorySource(root);assert.ok(!basic.files.some(row=>row.path.startsWith('docs/')||row.path.startsWith('dist/')));
 const copy=await copySourceDelivery({sourceRoot:root,documents:docs,includeWebBuild:true});for(const path of [...docs,'dist/web/index.html','dist/web/assets/app.js'])assert.deepEqual(await readFile(join(root,path)),await readFile(join(copy.codeRoot,path)));
 for(const path of ['docs/test-evidence/raw.json','docs/private/internal.json','docs/../README.md','/docs/local-run.md','docs\\local-run.md','docs/other.txt','docs/C:foo.json','docs/report.json:stream'])await assert.rejects(inventorySource(root,{documents:[path]}));
 for(const path of ['../outside','a/../../outside','C:/outside','a//b','a/CON.txt','a/file.','a/file ','a\0b'])assert.throws(()=>checkedRelative(path));
});

test('links/junctions in source trees, selected documents and the declared root are refused before reading their target',async()=>{
 const {root,put}=await fixture(),outside=await mkdtemp(join(tmpdir(),'source-delivery-outside-'));await writeFile(join(outside,'material.json'),'SYNTHETIC ONLY');
 await symlink(outside,join(root,'apps/escape'),process.platform==='win32'?'junction':'dir');await assert.rejects(inventorySource(root),/links|junctions/);assert.equal(await readFile(join(outside,'material.json'),'utf8'),'SYNTHETIC ONLY');
 const next=await fixture();await symlink(outside,join(next.root,'docs/linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(inventorySource(next.root,{documents:['docs/linked/material.json']}),/links|junctions/);
 const parent=await mkdtemp(join(tmpdir(),'source-delivery-root-link-'));await symlink(next.root,join(parent,'root'),process.platform==='win32'?'junction':'dir');await assert.rejects(inventorySource(join(parent,'root')),/link|junction/);await put('scripts/keep.mjs','unchanged');
});

test('single-file hard links and oversized/unsupported files are refused instead of copying ambiguous or unbounded payloads',async()=>{
 const {root}=await fixture();await link(join(root,'apps/web/src/main.tsx'),join(root,'apps/web/src/alias.tsx'));await assert.rejects(inventorySource(root),/hard links|single-link/);
 const large=await fixture();await writeFile(join(large.root,'apps/large.ts'),'');await truncate(join(large.root,'apps/large.ts'),LIMITS.fileBytes+1);await assert.rejects(inventorySource(large.root),/byte bound/);
 const unknown=await fixture();await writeFile(join(unknown.root,'apps/unselected.bin'),'fixture');await assert.rejects(inventorySource(unknown.root),/Unsupported source file type/);
 const doc=await fixture();await writeFile(join(doc.root,'docs/huge.md'),'');await truncate(join(doc.root,'docs/huge.md'),LIMITS.documentBytes+1);await assert.rejects(inventorySource(doc.root,{documents:['docs/huge.md']}),/document exceeds/);
});

test('same-size source replacement with restored mtime invalidates a supplied frozen inventory, and deletions/additions cannot pass',async()=>{
 const {root,put}=await fixture(),before=await inventorySource(root),path=join(root,'packages/contracts/index.ts'),original=await stat(path);await writeFile(path,'export const fixture=xxxx;\n');await utimes(path,original.atime,original.mtime);
 assert.equal((await stat(path)).size,original.size);await assert.rejects(copySourceDelivery({sourceRoot:root,expectedInventory:before}),/Source changed/);assert.ok(!(await readdir(root)).some(name=>name.startsWith('source-delivery-')));
 const next=await fixture(),frozen=await inventorySource(next.root);await next.put('apps/new.ts','new source');await assert.rejects(copySourceDelivery({sourceRoot:next.root,expectedInventory:frozen}),/Source changed/);
 const removed=await fixture(),beforeRemoval=await inventorySource(removed.root);await unlink(join(removed.root,'apps/web/src/main.tsx'));await assert.rejects(copySourceDelivery({sourceRoot:removed.root,expectedInventory:beforeRemoval}),/Source changed/);
 await put('apps/new.ts','new source');assert.notEqual((await inventorySource(root)).contentSha256,before.contentSha256);
});

test('a real source mutation after copy starts leaves only failed evidence and never a verified manifest',async()=>{
 const {root,put}=await fixture();await put('apps/large.ts',Buffer.alloc(8*1024**2,65));let changed=false;
 const watcher=watch(root,(_event,name)=>{if(!changed&&String(name).startsWith('source-delivery-')){changed=true;writeFileSync(join(root,'apps/late.ts'),'// changed while copy was starting\n');}});
 try{await assert.rejects(copySourceDelivery({sourceRoot:root}),/Source changed|Source directory changed/);assert.equal(changed,true);}finally{watcher.close();}
 const groups=(await readdir(root)).filter(name=>name.startsWith('source-delivery-'));assert.equal(groups.length,1);const paths=await readdir(join(root,groups[0]));assert.ok(!paths.includes('code-manifest.json'));const failed=JSON.parse(await readFile(join(root,groups[0],'status.json'),'utf8'));assert.equal(failed.status,'failed-source-copy');assert.ok((await readFile(join(root,'apps/large.ts'))).every(byte=>byte===65));
});

test('CLI requires an explicit operation, rejects unknown flags and makes no bundle while displaying help',()=>{
 const script=resolve(import.meta.dirname,'../scripts/prepare-source-delivery.mjs');
 for(const args of [[],['--destination=elsewhere'],['--copy','--copy'],['--inventory','--copy']]){const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8',windowsHide:true});assert.equal(result.status,1);assert.match(result.stderr,/Explicit|Unknown/);}
 const help=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8',windowsHide:true});assert.equal(help.status,0);assert.match(help.stdout,/No data\/API\/services/);assert.match(help.stdout,/Final delivery status requires separate data backup/);
});
