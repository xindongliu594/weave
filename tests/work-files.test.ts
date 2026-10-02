import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createOfficeFile,readOfficeFile } from '../services/agent-runtime/office-files.mjs';
import { migrateWorkFiles,prepareWorkFileSnapshot,selectedWorkFileInputs,selectedWorkFileCopies,validateWorkFilePath,workFilesRouter,prepareImportedWorkspace } from '../apps/api/src/work-files.ts';

const file=(path:string,text:string)=>({path,base64:Buffer.from(text).toString('base64')});
test('work files retain relative paths and immutable source hashes without touching original folders',()=>{
  const value=prepareWorkFileSnapshot({name:'已有代码',files:[file('project/src/index.ts','export const value = 42;'),file('project/README.md','项目资料') ]});
  assert.equal(value.files[0].path,'project/src/index.ts');assert.equal(value.files[1].text,'项目资料');assert.equal(value.files[0].sha256,createHash('sha256').update('export const value = 42;').digest('hex'));assert.equal(value.bytes,Buffer.byteLength('export const value = 42;项目资料'));
});
test('work file paths reject traversal, aliases, credentials and links',()=>{
  for(const path of ['../x','a/../x','a//x','/etc/x','C:/x','a\\x','x:stream','a/%2e%2e/x','a/./x','con.txt','trailing.','a/.git/config','a/.env.local','a/.ssh/id_ed25519','credentials.json','secret.pem','shortcut.lnk','node_modules/pkg/a.js','folder/id_rsa.pub','.agentteams/state','a/'.repeat(120)+'b'])assert.throws(()=>validateWorkFilePath(path),Error,path);
  assert.equal(validateWorkFilePath('todo/src/server.ts'),'todo/src/server.ts');
  assert.throws(()=>prepareWorkFileSnapshot({name:'x',files:[{...file('a.txt','x'),kind:'symlink'}]}));
  assert.throws(()=>prepareWorkFileSnapshot({name:'x',files:[file('a.txt','x'),file('A.txt','y')]}),/重复/);
  assert.throws(()=>prepareWorkFileSnapshot({name:'x',files:[file('notes.txt','-----BEGIN OPENSSH PRIVATE KEY-----')]}),/私钥/);
});
test('work file limits and malformed binary fail explicitly without partial imports',()=>{
  assert.throws(()=>prepareWorkFileSnapshot({name:'x',files:[{path:'x.txt',base64:'oops!'}]}),/编码/);
  assert.throws(()=>prepareWorkFileSnapshot({name:'x',files:[{path:'x.txt',base64:Buffer.from([0xff,0xfe,0x30]).toString('base64')}]}),/UTF-8/);
  assert.throws(()=>prepareWorkFileSnapshot({name:'x',files:[file('x.txt','\0binary')]}),/二进制/);
  assert.throws(()=>prepareWorkFileSnapshot({name:'x',files:Array.from({length:101},(_,i)=>file(i+'.txt','x'))}));
  assert.throws(()=>prepareWorkFileSnapshot({name:'x',files:[file('x.txt','a'.repeat(250001))]}),/250,000/);
  assert.throws(()=>readOfficeFile('old.doc',Buffer.from('old format')),/暂不支持/);
});
test('DOCX text round trips Unicode and XML characters without executing markup',()=>{
  const output=createOfficeFile({format:'docx',title:'工作 & 文档',text:'<script>不执行</script>\n第二段 📋'});
  assert.match(output.mimeType,/wordprocessingml/);
  assert.equal(readOfficeFile('work.docx',output.buffer).text,'工作 & 文档\n<script>不执行</script>\n第二段 📋');
});
test('XLSX and CSV exports preserve data and neutralize spreadsheet formulas',()=>{
  const rows=[['姓名','值'],['甲','a,"b"'],['乙','=WEBSERVICE("https://example.com")'],['丙',3]];
  const xlsx=createOfficeFile({format:'xlsx',rows});const zip=new AdmZip(xlsx.buffer);
  assert.ok(!zip.readAsText('xl/worksheets/sheet1.xml').includes('<f>'));
  const text=readOfficeFile('work.xlsx',xlsx.buffer).text;assert.match(text,/姓名,值/);assert.match(text,/'?=WEBSERVICE/);assert.match(text,/丙,3/);
  const csv=createOfficeFile({format:'csv',rows}).buffer.toString('utf8');assert.ok(csv.includes("'=WEBSERVICE"));assert.ok(csv.includes('"a,""b"""'));
});
test('XLSX reader handles shared strings, sparse cells and cached formula values',()=>{
  const zip=new AdmZip();zip.addFile('xl/sharedStrings.xml',Buffer.from('<sst><si><t>名称 &amp; 值</t></si></sst>'));
  zip.addFile('xl/worksheets/sheet1.xml',Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><f>2+3</f><v>5</v></c></row></sheetData></worksheet>'));
  const result=readOfficeFile('sheet.xlsx',zip.toBuffer());assert.equal(result.text,'[xl/worksheets/sheet1.xml]\n名称 & 值,,5');assert.match(result.warnings[0],/缓存值/);
});
test('Office readers reject unsafe XML, archives, macros and expansion bombs',()=>{
  for(const [name,xml] of [['word/document.xml','<!DOCTYPE x [<!ENTITY attack SYSTEM "file:///x">]><w:p><w:t>&attack;</w:t></w:p>'],['word/vbaProject.bin','macro'],['word/embeddings/secret.xml','object']]){const zip=new AdmZip();zip.addFile(name,Buffer.from(xml));assert.throws(()=>readOfficeFile('bad.docx',zip.toBuffer()),/不支持/);}
  const bomb=new AdmZip();bomb.addFile('word/document.xml',Buffer.from('a'.repeat(8*1024*1024+1)));assert.throws(()=>readOfficeFile('bad.docx',bomb.toBuffer()),/展开后/);
  const link=new AdmZip();const entry=link.addFile('word/document.xml',Buffer.from('target'));entry.header.attr=(0o120777<<16)>>>0;assert.throws(()=>readOfficeFile('bad.docx',link.toBuffer()),/符号链接/);
});
test('Office generation validates total cells, numeric and illegal XML data',()=>{
  assert.throws(()=>createOfficeFile({format:'xlsx',rows:[[Infinity]]}),/有限/);
  assert.throws(()=>createOfficeFile({format:'docx',text:'oops\u0001'}),/控制字符/);
  assert.throws(()=>createOfficeFile({format:'xlsx',rows:Array.from({length:201},()=>Array(100).fill('x'))}),/20,000/);
});
test('selected snapshot grants survive DB persistence, remain exact and do not expose unselected files',async()=>{
  const db=new PGlite();await db.waitReady;const queryDb=db as any;
  try{
    await migrateWorkFiles(queryDb);await migrateWorkFiles(queryDb);const id=randomUUID();
    const snapshot=prepareWorkFileSnapshot({name:'source',files:[file('src/a.ts','export default 1;'),file('src/private.txt','not granted'),{path:'notes.docx',base64:createOfficeFile({format:'docx',text:'文档正文'}).buffer.toString('base64')}]});
    await db.query('INSERT INTO work_file_snapshots(id,name,files,bytes) VALUES($1,$2,$3,$4)',[id,snapshot.name,JSON.stringify(snapshot.files),snapshot.bytes]);
    const selections=[{snapshotId:id,paths:['src/a.ts','notes.docx'],agentIds:['developer'],mode:'workspace' as const}];
    const inputs=await selectedWorkFileInputs(selections,queryDb);assert.equal(inputs.length,2);assert.ok(inputs.every(input=>input.agentIds.join()==='developer'));assert.ok(!JSON.stringify(inputs).includes('not granted'));
    const copies=await selectedWorkFileCopies(selections,queryDb);assert.equal(copies.length,1);assert.equal(copies[0].path,'src/a.ts');assert.equal(copies[0].sha256,snapshot.files[0].sha256);
    assert.deepEqual(await selectedWorkFileCopies([{snapshotId:id,paths:['src/a.ts'],agentIds:['developer']}],queryDb),[]);
    await assert.rejects(()=>selectedWorkFileInputs([{snapshotId:id,paths:['../outside'],agentIds:['developer']}],queryDb),/不在/);
    await assert.rejects(()=>selectedWorkFileInputs([...selections,...selections],queryDb),/重复/);
    await assert.rejects(()=>selectedWorkFileInputs([{snapshotId:id,paths:['src/a.ts'],agentIds:[]}],queryDb));
    await db.query('UPDATE work_file_snapshots SET files=$1 WHERE id=$2',[JSON.stringify([{...snapshot.files[0],base64:Buffer.from('tamper').toString('base64')}]),id]);
    await assert.rejects(()=>selectedWorkFileCopies([{snapshotId:id,paths:['src/a.ts'],agentIds:['developer'],mode:'workspace'}],queryDb),/完整性/);
  }finally{await db.close();}
});
test('work file HTTP import, preview, generation and attachment download persist without exposing raw payloads',async()=>{
  const db=new PGlite();await db.waitReady;await migrateWorkFiles(db as any);
  const adapter={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
  const app=express();app.use(express.json({limit:'12mb'}));app.use('/api',workFilesRouter(adapter as any));app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??422).json({message:error.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api';
  const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    const uploaded=await post('/work-files',{name:'代码快照',files:[file('project/src/app.ts','console.log("你好");')]});assert.equal(uploaded.status,201);const summary=await uploaded.json() as any;assert.equal(summary.fileCount,1);
    const preview=await (await fetch(base+'/work-files/'+summary.id)).json() as any;assert.equal(preview.files[0].text,'console.log("你好");');assert.equal(preview.files[0].base64,undefined);
    const list=await (await fetch(base+'/work-files')).json() as any[];assert.equal(list.length,1);assert.equal(list[0].files,undefined);
    const downloaded=await fetch(base+'/work-files/'+summary.id+'/files/0/download');assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');assert.match(downloaded.headers.get('content-disposition')!,/^attachment;/);assert.equal(await downloaded.text(),'console.log("你好");');
    assert.equal((await fetch(base+'/work-files/'+summary.id+'/files/-1/download')).status,404);
    const rejected=await post('/work-files',{name:'bad',files:[file('ok.txt','safe'),file('../outside','unsafe')]});assert.equal(rejected.status,422);assert.equal(((await (await fetch(base+'/work-files')).json()) as any[]).length,1);
    const generated=await post('/work-files/generate',{format:'docx',name:'报告',text:'办公测试'});assert.equal(generated.status,201);const output=await generated.json() as any;const bytes=Buffer.from(await (await fetch(base+'/work-files/'+output.id+'/files/0/download')).arrayBuffer());assert.equal(readOfficeFile('report.docx',bytes).text,'报告\n办公测试');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();}
});
const imported=(path:string,content:string)=>({path,content,sha256:createHash('sha256').update(content).digest('hex')});
function tempWorkspace(){const root=mkdtempSync(join(tmpdir(),'ad-workfiles-'));return {root,cleanup(){assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'ad-workfiles-'));rmSync(root,{recursive:true,force:true});}};}
test('workspace seeding validates the complete path/hash batch before writing and never overwrites',()=>{
  const fixture=tempWorkspace(),runId=randomUUID(),target=join(fixture.root,runId,'artifacts');
  try{
    const good=imported('project/src/a.ts','export default "原始";');
    assert.throws(()=>prepareImportedWorkspace(fixture.root,runId,[good,{...imported('project/b.ts','bad'),sha256:'0'.repeat(64)}]),/SHA256/);assert.equal(existsSync(target),false);
    assert.throws(()=>prepareImportedWorkspace(fixture.root,runId,[good,imported('../outside','bad')]),/路径/);assert.equal(existsSync(target),false);
    assert.throws(()=>prepareImportedWorkspace(fixture.root,runId,[good,imported('project/src/A.ts','duplicate')]),/重复/);assert.equal(existsSync(target),false);
    prepareImportedWorkspace(fixture.root,runId,[good]);assert.equal(readFileSync(join(target,'project/src/a.ts'),'utf8'),good.content);
    assert.throws(()=>prepareImportedWorkspace(fixture.root,runId,[imported('project/src/a.ts','overwrite')]),/不能覆盖/);assert.equal(readFileSync(join(target,'project/src/a.ts'),'utf8'),good.content);
  }finally{fixture.cleanup();}
});
test('workspace seeding rejects root and nested parent junctions without writing through them',()=>{
  const fixture=tempWorkspace(),outside=join(fixture.root,'outside');mkdirSync(outside);const linkType=process.platform==='win32'?'junction':'dir';
  try{
    const rootLink=join(fixture.root,'trace-link');symlinkSync(outside,rootLink,linkType);assert.throws(()=>prepareImportedWorkspace(rootLink,randomUUID(),[imported('secret.txt','must not escape')]),/链接/);assert.deepEqual(readdirSync(outside),[]);
    const runId=randomUUID(),artifacts=join(fixture.root,'trace',runId,'artifacts');mkdirSync(artifacts,{recursive:true});symlinkSync(outside,join(artifacts,'linked'),linkType);
    assert.throws(()=>prepareImportedWorkspace(join(fixture.root,'trace'),runId,[imported('safe.txt','first'),imported('linked/secret.txt','must not escape')]),/链接/);assert.equal(existsSync(join(artifacts,'safe.txt')),false);assert.equal(existsSync(join(outside,'secret.txt')),false);
  }finally{fixture.cleanup();}
});
test('workspace recovery preserves the parent current bytes and refuses missing or linked source archives',()=>{
  const fixture=tempWorkspace(),parent=randomUUID(),resumed=randomUUID(),initial=imported('src/index.ts','original');
  try{
    prepareImportedWorkspace(fixture.root,parent,[initial]);writeFileSync(join(fixture.root,parent,'artifacts/src/index.ts'),'changed by previous run');
    prepareImportedWorkspace(fixture.root,resumed,[initial],parent,'resume');assert.equal(readFileSync(join(fixture.root,resumed,'artifacts/src/index.ts'),'utf8'),'changed by previous run');
    const legacy=randomUUID();prepareImportedWorkspace(fixture.root,legacy,[initial],parent);assert.equal(readFileSync(join(fixture.root,legacy,'artifacts/src/index.ts'),'utf8'),'changed by previous run');
    const absent=randomUUID(),next=randomUUID();assert.throws(()=>prepareImportedWorkspace(fixture.root,next,[initial],absent),/父运行.*缺失/);assert.equal(existsSync(join(fixture.root,next)),false);
    const linked=randomUUID(),source=join(fixture.root,linked);mkdirSync(source);symlinkSync(join(fixture.root,parent,'artifacts'),join(source,'artifacts'),process.platform==='win32'?'junction':'dir');assert.throws(()=>prepareImportedWorkspace(fixture.root,randomUUID(),[initial],linked),/链接/);
  }finally{fixture.cleanup();}
});
test('full retry restores only approved imports into an empty workspace without inheriting parent outputs',()=>{
  const fixture=tempWorkspace(),parent=randomUUID(),retry=randomUUID(),initial=imported('src/index.ts','original approved bytes');
  try{
    prepareImportedWorkspace(fixture.root,parent,[initial]);const source=join(fixture.root,parent,'artifacts');writeFileSync(join(source,'src/index.ts'),'previous failed edit');writeFileSync(join(source,'todo.json'),'previous output');
    prepareImportedWorkspace(fixture.root,retry,[initial],parent,'retry');const target=join(fixture.root,retry,'artifacts');assert.equal(readFileSync(join(target,'src/index.ts'),'utf8'),initial.content);assert.equal(existsSync(join(target,'todo.json')),false);assert.equal(readFileSync(join(source,'src/index.ts'),'utf8'),'previous failed edit');
    const emptyRetry=randomUUID();prepareImportedWorkspace(fixture.root,emptyRetry,[],parent,'retry');assert.equal(existsSync(join(fixture.root,emptyRetry,'artifacts/todo.json')),false);assert.equal(existsSync(join(fixture.root,emptyRetry,'artifacts/src/index.ts')),false);
    const missingParentRetry=randomUUID();prepareImportedWorkspace(fixture.root,missingParentRetry,[initial],randomUUID(),'retry');assert.equal(readFileSync(join(fixture.root,missingParentRetry,'artifacts/src/index.ts'),'utf8'),initial.content);
    const occupied=randomUUID(),occupiedRoot=join(fixture.root,occupied,'artifacts');mkdirSync(occupiedRoot,{recursive:true});writeFileSync(join(occupiedRoot,'unrelated.txt'),'must remain');assert.throws(()=>prepareImportedWorkspace(fixture.root,occupied,[],parent,'retry'),/独立空工作区/);assert.equal(readFileSync(join(occupiedRoot,'unrelated.txt'),'utf8'),'must remain');
  }finally{fixture.cleanup();}
});
