import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRunArchive,openRunArchive,readRun,listRuns} from './trace-store.mjs';

// Real temporary archive bytes and native fs metadata only. Instrument the
// builtin binding in this isolated test process to prove journal reuse, rather
// than relying on a timing assertion or changing the product's exported API.
async function fixture(work){
 const root=await mkdtemp(join(tmpdir(),'trace-list-cache-'));
 try{return await work(root);}finally{const within=relative(resolve(tmpdir()),resolve(root));assert.ok(within.startsWith('trace-list-cache-')&&!within.startsWith('..')&&!isAbsolute(within));await rm(root,{recursive:true,force:true});}
}
const summary=run=>({id:run.id,createdAt:run.createdAt,title:run.title,mode:run.mode,status:run.status,integrity:run.integrity,eventCount:run.eventCount});
function countReads(work){
 const original=fs.readFileSync,counts={snapshots:0,journals:0};
 fs.readFileSync=function(file,...args){const path=String(file);if(path.endsWith('snapshot.json'))counts.snapshots++;if(path.endsWith('events.jsonl'))counts.journals++;return original.call(this,file,...args);};syncBuiltinESMExports();
 try{return work(counts);}finally{fs.readFileSync=original;syncBuiltinESMExports();}
}
function metadata(file){return fs.statSync(file,{bigint:true});}
const fixedTime=new Date('2020-01-01T00:00:00.000Z');
function mutateAndRestoreMtime(file,bytes){fs.writeFileSync(file,bytes);fs.utimesSync(file,fixedTime,fixedTime);}

test('an unchanged real 10 MiB journal is parsed once for lists while full reads always bypass the cache',()=>fixture(root=>{
 const archive=createRunArchive(root,{title:'Large archived run',mode:'fixture'}),file=join(archive.dir,'events.jsonl');
 const base=fs.readFileSync(file,'utf8'),events=Array.from({length:80},(_,index)=>JSON.stringify({seq:index+2,at:'2020-01-01T00:00:00.000Z',type:'fixture/data',data:{text:'x'.repeat(128*1024)}})+'\n').join('');fs.appendFileSync(file,events);
 const expected=summary(readRun(root,archive.id));assert.ok(metadata(file).size>10n*1024n*1024n);
 countReads(counts=>{
  assert.deepEqual(listRuns(root),[expected]);assert.equal(counts.journals,1);assert.equal(counts.snapshots,1);
  for(let i=0;i<5;i++)assert.deepEqual(listRuns(root),[expected]);assert.equal(counts.journals,1,'same full BigInt identities must reuse the verified summary');
  assert.equal(readRun(root,archive.id).eventCount,81);assert.equal(counts.journals,2,'export/recovery readRun remains a full strict parse');
 });
}));

test('cross-handle appends invalidate summaries and retain all fields, terminal state and descending order',()=>fixture(root=>{
 const first=createRunArchive(root,{title:'First',mode:'fixture'}),a=openRunArchive(root,first.id),b=openRunArchive(root,first.id);
 const second=createRunArchive(root,{title:'Second',mode:'fixture'});const expected=[summary(readRun(root,first.id)),summary(readRun(root,second.id))].sort((left,right)=>right.createdAt.localeCompare(left.createdAt));
 assert.deepEqual(listRuns(root),expected);a.append('fixture/a');b.append('run/finished',{status:'cancelled'});
 const changed=[summary(readRun(root,first.id)),summary(readRun(root,second.id))].sort((left,right)=>right.createdAt.localeCompare(left.createdAt));
 assert.deepEqual(listRuns(root),changed);assert.equal(changed.find(row=>row.id===first.id).status,'cancelled');assert.equal(changed.find(row=>row.id===first.id).eventCount,3);
 countReads(counts=>{listRuns(root);assert.equal(counts.journals,0);});
}));

test('journal truncation, same-size corruption with restored mtime, and repair all invalidate the cached integrity',()=>fixture(root=>{
 const archive=createRunArchive(root,{title:'Integrity fixture',mode:'fixture'});archive.append('fixture/data',{value:'abc'});const file=join(archive.dir,'events.jsonl'),original=fs.readFileSync(file);
 fs.utimesSync(file,fixedTime,fixedTime);const before=metadata(file);assert.equal(listRuns(root)[0].integrity,'ok');
 const broken=Buffer.from(original);broken[broken.indexOf(Buffer.from('"seq":2'))+5]=59; // Same byte length, invalid JSON ':' -> ';'.
 mutateAndRestoreMtime(file,broken);const altered=metadata(file);assert.equal(altered.size,before.size);assert.equal(altered.mtimeNs,before.mtimeNs);assert.notEqual(altered.ctimeNs,before.ctimeNs);
 assert.equal(listRuns(root)[0].integrity,'incomplete');assert.equal(listRuns(root)[0].eventCount,1);
 mutateAndRestoreMtime(file,original);assert.equal(listRuns(root)[0].integrity,'ok');assert.equal(listRuns(root)[0].eventCount,2);
 fs.writeFileSync(file,original.subarray(0,original.length-1));assert.equal(listRuns(root)[0].status,'incomplete');
 mutateAndRestoreMtime(file,original);assert.equal(listRuns(root)[0].status,'unfinished');
}));

test('snapshot replacement and malformed snapshots with equal size/restored mtime never retain the old valid summary',()=>fixture(root=>{
 const archive=createRunArchive(root,{title:'Original title',mode:'fixture'}),file=join(archive.dir,'snapshot.json'),bytes=fs.readFileSync(file);
 fs.utimesSync(file,fixedTime,fixedTime);const before=metadata(file);assert.equal(listRuns(root)[0].title,'Original title');
 const replacement=Buffer.from(bytes.toString().replace('Original title','Replaced title'));assert.equal(replacement.length,bytes.length);
 fs.unlinkSync(file);mutateAndRestoreMtime(file,replacement);assert.equal(metadata(file).mtimeNs,before.mtimeNs);
 const replaced=listRuns(root)[0];assert.equal(replaced.title,'Replaced title');assert.equal(replaced.integrity,'incomplete','run/created snapshot SHA continues to be verified');
 const broken=Buffer.from(bytes);broken[0]=33;mutateAndRestoreMtime(file,broken);const invalid=listRuns(root)[0];assert.equal(invalid.title,'无法读取的运行记录');assert.equal(invalid.integrity,'incomplete');assert.equal(invalid.eventCount,0);
 mutateAndRestoreMtime(file,bytes);assert.equal(listRuns(root)[0].title,'Original title');assert.equal(listRuns(root)[0].integrity,'ok');
 fs.unlinkSync(file);assert.deepEqual(listRuns(root),[],'missing snapshot remains absent, matching strict readRun');
}));

test('two roots with the same run ID stay independent, deleted entries disappear, and caller mutation cannot poison cache',()=>fixture(root=>{
 const left=join(root,'left'),right=join(root,'right'),id=randomUUID(),a=createRunArchive(left,{title:'Left',mode:'fixture'},{id}),b=createRunArchive(right,{title:'Right',mode:'fixture'},{id});b.append('fixture/second');
 const first=listRuns(left);assert.equal(first[0].title,'Left');first[0].title='Caller edited';assert.equal(listRuns(right)[0].title,'Right');assert.equal(listRuns(right)[0].eventCount,2);assert.equal(listRuns(left)[0].title,'Left');
 countReads(counts=>{listRuns(left);listRuns(right);assert.equal(counts.journals,0);});
 fs.rmSync(a.dir,{recursive:true});assert.deepEqual(listRuns(left),[]);assert.equal(listRuns(right)[0].title,'Right');
 fs.rmSync(right,{recursive:true});assert.deepEqual(listRuns(right),[]);
}));

test('cache count and per-summary size are bounded without changing returned data',()=>fixture(root=>{
 const many=join(root,'many'),extra=join(root,'extra');for(let index=0;index<256;index++)createRunArchive(many,{title:'Bounded '+index,mode:'fixture'});
 listRuns(many);createRunArchive(extra,{title:'Evicts an LRU entry',mode:'fixture'});listRuns(extra);
 countReads(counts=>{assert.equal(listRuns(many).length,256);assert.ok(counts.journals>0,'an entry beyond 256 must have evicted a prior summary');});
 const huge=join(root,'huge'),title='x'.repeat(64*1024+100);createRunArchive(huge,{title,mode:'fixture'});
 countReads(counts=>{assert.equal(listRuns(huge)[0].title,title);assert.equal(listRuns(huge)[0].title,title);assert.equal(counts.journals,2,'oversized summaries are returned whole but never retained');});
}));

test('a transient read exception remains incomplete but is retried with unchanged file identities',()=>fixture(root=>{
 const archive=createRunArchive(root,{title:'Readable after lock release',mode:'fixture'}),original=fs.readFileSync;let blocked=true;
 fs.readFileSync=function(file,...args){if(blocked&&String(file)===join(archive.dir,'events.jsonl'))throw Object.assign(Error('fixture transient lock'),{code:'EACCES'});return original.call(this,file,...args);};syncBuiltinESMExports();
 try{assert.equal(listRuns(root)[0].integrity,'incomplete');blocked=false;assert.equal(listRuns(root)[0].title,'Readable after lock release');assert.equal(listRuns(root)[0].integrity,'ok');}
 finally{fs.readFileSync=original;syncBuiltinESMExports();}
}));
