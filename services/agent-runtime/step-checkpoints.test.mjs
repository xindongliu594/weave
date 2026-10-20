import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunArchive } from './trace-store.mjs';

async function api() { try { return await import('./step-checkpoints.mjs'); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; } }
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'step-proof-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const archive=createRunArchive(root,{projectId:'p',tasks:[]}),workspace=join(archive.dir,'artifacts');mkdirSync(workspace);
  writeFileSync(join(workspace,'a.txt'),'first');
  const boundary={taskId:'qa',attemptId:'attempt1',sessionId:'employee1',trigger:'tool-result',eventCursor:1,contractHash:'a'.repeat(64)};
  return {root,archive,workspace,boundary};
}
test('committed checkpoints retain exact file versions and deduplicate unchanged content',async t=>{
  const {commitStepCheckpoint,readStepCheckpoint}=await api();assert.equal(typeof commitStepCheckpoint,'function');
  const f=fixture(t),first=commitStepCheckpoint({...f,receipts:[]});
  const second=commitStepCheckpoint({...f,receipts:[]});
  assert.equal(readdirSync(join(f.archive.dir,'checkpoint-objects')).length,1);
  writeFileSync(join(f.workspace,'a.txt'),'second');
  const saved=readStepCheckpoint({root:f.root,runId:f.archive.id,checkpointId:first.id});
  assert.equal(saved.files[0].sha256,second.files[0].sha256);
  assert.equal(readFileSync(join(f.archive.dir,'checkpoint-objects',saved.files[0].sha256),'utf8'),'first');
  assert.equal(saved.boundary.attemptId,'attempt1');
});
test('partial writes are not checkpoints and corrupt objects fail closed',async t=>{
  const {commitStepCheckpoint,readStepCheckpoint}=await api();assert.equal(typeof readStepCheckpoint,'function');
  const f=fixture(t), saved=commitStepCheckpoint({...f,receipts:[]});
  assert.throws(()=>readStepCheckpoint({root:f.root,runId:f.archive.id,checkpointId:'../outside'}),/CHECKPOINT/);
  writeFileSync(join(f.archive.dir,'checkpoint-objects',saved.files[0].sha256),'tampered');
  assert.throws(()=>readStepCheckpoint({root:f.root,runId:f.archive.id,checkpointId:saved.id}),/CHECKPOINT_CONTENT/);
});
test('oversized and excessive workspaces are rejected rather than silently truncated',async t=>{
  const {commitStepCheckpoint}=await api();assert.equal(typeof commitStepCheckpoint,'function');
  const f=fixture(t);writeFileSync(join(f.workspace,'large.bin'),Buffer.alloc(5*1024*1024+1));
  assert.throws(()=>commitStepCheckpoint({...f,receipts:[]}),/CHECKPOINT_FILE_LIMIT/);
  rmSync(join(f.workspace,'large.bin'));
  for(let n=0;n<128;n++)writeFileSync(join(f.workspace,`f${n}`),'x');
  assert.throws(()=>commitStepCheckpoint({...f,receipts:[]}),/CHECKPOINT_FILE_LIMIT/);
});
test('failed archive commit never publishes a restorable checkpoint',async t=>{
  const {commitStepCheckpoint,readStepCheckpoint}=await api();assert.equal(typeof commitStepCheckpoint,'function');
  const f=fixture(t);let captured;
  const broken={...f.archive,append(type,data){captured=data;throw Error('simulated disk full');}};
  assert.throws(()=>commitStepCheckpoint({...f,archive:broken,receipts:[]}),/simulated disk full/);
  assert.throws(()=>readStepCheckpoint({root:f.root,runId:f.archive.id,checkpointId:captured.id}),/CHECKPOINT_NOT_FOUND/);
});

test('hardlinked workspace files cannot enter a checkpoint',async t=>{
  const {commitStepCheckpoint}=await api();
  const f=fixture(t),outside=join(f.root,'outside.txt');
  writeFileSync(outside,'private content outside the employee workspace');
  linkSync(outside,join(f.workspace,'linked.txt'));
  assert.throws(()=>commitStepCheckpoint({...f,receipts:[]}),/CHECKPOINT_PATH_UNSAFE/);
  assert.equal(readFileSync(outside,'utf8'),'private content outside the employee workspace');
});

test('hardlinked stored objects are refused on restore and reuse',async t=>{
  const {commitStepCheckpoint,readStepCheckpoint}=await api();
  const f=fixture(t),saved=commitStepCheckpoint({...f,receipts:[]});
  linkSync(join(f.archive.dir,'checkpoint-objects',saved.files[0].sha256),join(f.root,'object-alias.txt'));
  assert.throws(()=>readStepCheckpoint({root:f.root,runId:f.archive.id,checkpointId:saved.id}),/CHECKPOINT_CONTENT_INVALID/);
  assert.throws(()=>commitStepCheckpoint({...f,receipts:[]}),/CHECKPOINT_PATH_UNSAFE/);
  assert.equal(readFileSync(join(f.root,'object-alias.txt'),'utf8'),'first');
});
