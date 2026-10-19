import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRunArchive,readRun} from './trace-store.mjs';
import {commitStepCheckpoint,readStepCheckpoint} from './step-checkpoints.mjs';
const storage=await import('./storage-governance.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
function fixture(t){const root=mkdtempSync(join(tmpdir(),'storage-governance-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const traceRoot=join(root,'runs'),workspaceRoot=join(root,'workspaces');mkdirSync(workspaceRoot);
 const archive=createRunArchive(traceRoot,{executionTarget:{kind:'local',deviceId:'native'},projectId:'fixture'});
 const work=join(workspaceRoot,archive.id),artifacts=join(archive.dir,'artifacts');mkdirSync(work);mkdirSync(artifacts);writeFileSync(join(work,'code.txt'),'delivered');writeFileSync(join(artifacts,'code.txt'),'delivered');
 const checkpoint=commitStepCheckpoint({archive,workspace:artifacts,boundary:{taskId:'writer',attemptId:'first',sessionId:'employee',trigger:'cycle-complete',eventCursor:1,contractHash:'a'.repeat(64)}});
 archive.append('run/finished',{status:'completed'});
 return {root,traceRoot,workspaceRoot,archive,work,artifacts,checkpoint,runs:[{id:archive.id,status:'completed',native:true,blocked:false}]};}
test('inventory counts actual regular bytes without following directory links and marks bounded scans incomplete',t=>{
 assert.equal(typeof storage.scanStorage,'function');const f=fixture(t),dir=join(f.root,'inventory');mkdirSync(dir);writeFileSync(join(dir,'a'),'abc');mkdirSync(join(dir,'nested'));writeFileSync(join(dir,'nested','b'),'12345');symlinkSync(f.artifacts,join(dir,'linked'),'junction');
 const result=storage.scanStorage(dir);assert.equal(result.bytes,8);assert.equal(result.files,2);assert.equal(result.links,1);assert.equal(result.complete,true);assert.equal(storage.scanStorage(dir,1).complete,false);
});
test('only completed native workspace copies with verified identical canonical delivery become candidates',t=>{
 assert.equal(typeof storage.workspaceCopyCandidates,'function');const f=fixture(t);const result=storage.workspaceCopyCandidates(f);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].path,'code.txt');assert.equal(result.candidates[0].bytes,9);
 for(const overrides of [{status:'running'},{status:'failed'},{native:false},{blocked:true}])assert.equal(storage.workspaceCopyCandidates({...f,runs:[{...f.runs[0],...overrides}]}).candidates.length,0);
 writeFileSync(join(f.work,'new.txt'),'not in delivery');assert.equal(storage.workspaceCopyCandidates(f).candidates.length,1);
});
test('incomplete journal and mismatched completion are retained even when database says completed',t=>{
 assert.equal(typeof storage.workspaceCopyCandidates,'function');const f=fixture(t);writeFileSync(join(f.archive.dir,'events.jsonl'),'incomplete');assert.equal(storage.workspaceCopyCandidates(f).candidates.length,0);
});
test('cleaning copies preserves immutable deliverables, checkpoints and a valid complete journal',t=>{
 assert.equal(typeof storage.removeWorkspaceCopies,'function');const f=fixture(t);const before=readFileSync(join(f.archive.dir,'events.jsonl'));
 const {candidates}=storage.workspaceCopyCandidates(f);const result=storage.removeWorkspaceCopies(f,candidates);assert.equal(result.deleted.length,1);assert.equal(result.bytes,9);assert.equal(existsSync(join(f.work,'code.txt')),false);
 assert.equal(readFileSync(join(f.artifacts,'code.txt'),'utf8'),'delivered');assert.deepEqual(readFileSync(join(f.archive.dir,'events.jsonl')),before);assert.equal(readRun(f.traceRoot,f.archive.id).integrity,'ok');
 assert.deepEqual(readStepCheckpoint({root:f.traceRoot,runId:f.archive.id,checkpointId:f.checkpoint.id}),f.checkpoint);
 // Prepare/restore can recreate the redundant file from the canonical copy.
 writeFileSync(join(f.work,'code.txt'),readFileSync(join(f.artifacts,'code.txt')));assert.equal(readFileSync(join(f.work,'code.txt'),'utf8'),'delivered');
});
test('changed second candidate rejects the entire preview before the first file is deleted',t=>{
 assert.equal(typeof storage.validateWorkspaceCopies,'function');const f=fixture(t);for(const dir of [f.work,f.artifacts])writeFileSync(join(dir,'second.txt'),'second');const {candidates}=storage.workspaceCopyCandidates(f);
 writeFileSync(join(f.work,'second.txt'),'changed');assert.throws(()=>storage.removeWorkspaceCopies(f,candidates),{code:'STORAGE_CANDIDATE_CHANGED'});assert.ok(existsSync(join(f.work,'code.txt')));
});
test('canonical delivery changes invalidate a preview without deleting its workspace copy',t=>{
 assert.equal(typeof storage.validateWorkspaceCopies,'function');const f=fixture(t);const {candidates}=storage.workspaceCopyCandidates(f);writeFileSync(join(f.artifacts,'code.txt'),'changed');assert.throws(()=>storage.validateWorkspaceCopies(f,candidates),{code:'STORAGE_CANDIDATE_CHANGED'});assert.ok(existsSync(join(f.work,'code.txt')));
});
test('workspace ancestor links and hard-linked files cannot become cleanup candidates',t=>{
 assert.equal(typeof storage.workspaceCopyCandidates,'function');const f=fixture(t);linkSync(join(f.work,'code.txt'),join(f.work,'alias.txt'));assert.equal(storage.workspaceCopyCandidates(f).candidates.length,0);
 rmSync(f.work,{recursive:true});symlinkSync(f.artifacts,f.work,'junction');assert.equal(storage.workspaceCopyCandidates(f).candidates.length,0);
});
test('preview paths cannot traverse, name internal files or forge a different run',t=>{
 assert.equal(typeof storage.validateWorkspaceCopies,'function');const f=fixture(t);const {candidates}=storage.workspaceCopyCandidates(f);
 for(const change of [{path:'../code.txt'},{path:'.agent-write-secret'},{runId:'not-a-run'}])assert.throws(()=>storage.validateWorkspaceCopies(f,[{...candidates[0],...change}]),{code:'STORAGE_CANDIDATE_CHANGED'});
});
test('disk admission uses actual filesystem free space and stops before altering any file',t=>{
 assert.equal(typeof storage.assertStorageHeadroom,'function');const f=fixture(t);
 assert.ok(storage.assertStorageHeadroom(f.root,0).freeBytes>0);
 assert.throws(()=>storage.assertStorageHeadroom(f.root,Number.MAX_SAFE_INTEGER),{code:'STORAGE_FREE_LIMIT'});
 assert.equal(readFileSync(join(f.artifacts,'code.txt'),'utf8'),'delivered');
});
test('inventory refuses a linked ancestor instead of counting files outside the declared directory',t=>{
 const f=fixture(t);const alias=join(f.root,'alias');symlinkSync(f.artifacts,alias,'junction');mkdirSync(join(f.artifacts,'nested'));writeFileSync(join(f.artifacts,'nested','outside.txt'),'outside');
 const r=storage.scanStorage(join(alias,'nested'));assert.equal(r.complete,false);assert.equal(r.bytes,0);
});
test('a completed journal with an unresolved external mutation still protects its workspace',t=>{
 const f=fixture(t);f.archive.append('runtime/outcome-unknown',{callId:'unknown-write',name:'artifact_write'});assert.equal(storage.workspaceCopyCandidates(f).candidates.length,0);
});
test('linked or oversized snapshot metadata cannot authorize cleanup',t=>{
 const f=fixture(t),snapshot=join(f.archive.dir,'snapshot.json'),copy=join(f.root,'snapshot-copy.json');writeFileSync(copy,readFileSync(snapshot));rmSync(snapshot);if(process.platform==='win32')linkSync(copy,snapshot);else symlinkSync(copy,snapshot,'file');assert.equal(storage.workspaceCopyCandidates(f).candidates.length,0);
 rmSync(snapshot);writeFileSync(snapshot,' '.repeat(9*1024*1024));assert.equal(storage.workspaceCopyCandidates(f).candidates.length,0);
});
test('workspace directory enumeration returns only the bounded UUID scope',t=>{
 assert.equal(typeof storage.workspaceRunIds,'function');const f=fixture(t);for(let n=0;n<6;n++)mkdirSync(join(f.workspaceRoot,`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`));
 const ids=storage.workspaceRunIds(f.workspaceRoot,3);assert.equal(ids.length,3);assert.ok(ids.every(id=>/^[a-f0-9-]{36}$/.test(id)));
});
test('verified compressed completed logs still authorize identical workspace copy cleanup',async t=>{const f=fixture(t),journal=await import('./journal-archive.mjs');f.archive.append('evidence/test-output',{output:'test evidence\n'.repeat(2000)});journal.archiveJournal(f.traceRoot,journal.journalArchiveCandidate(f.traceRoot,f.archive.id));assert.equal(storage.workspaceCopyCandidates(f).candidates.length,1);assert.deepEqual(readStepCheckpoint({root:f.traceRoot,runId:f.archive.id,checkpointId:f.checkpoint.id}),f.checkpoint);});
