import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createArchiveWriterManager,registerArchiveWriterRoot} from './archive-writer-scope.mjs';
import {createRunArchive,openRunArchive,readRun} from './trace-store.mjs';
import {commitStepCheckpoint} from './step-checkpoints.mjs';

test('registered checkpoint refuses an unowned write before creating objects and then saves with its writer',async t=>{
 const parent=fs.realpathSync(os.tmpdir()),base=fs.mkdtempSync(path.join(parent,'checkpoint-entry-'));
 t.after(()=>{assert.equal(fs.realpathSync(base),base);assert.equal(path.dirname(base),parent);fs.rmSync(base,{recursive:true});});
 const traceRoot=path.join(base,'runs'),workspace=path.join(base,'workspace'),runId='20000000-0000-4000-8000-000000000001';
 fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'result.txt'),'checkpoint version');
 const writers=createArchiveWriterManager({traceRoot});registerArchiveWriterRoot(writers);
 let stale;await writers.withWriter([runId],async()=>{stale=createRunArchive(traceRoot,{}, {id:runId});});
 const boundary={taskId:'task',attemptId:'attempt',sessionId:'session',contractHash:'a'.repeat(64),eventCursor:1};
 const journal=path.join(stale.dir,'events.jsonl'),objects=path.join(stale.dir,'checkpoint-objects'),before=fs.readFileSync(journal);
 assert.throws(()=>commitStepCheckpoint({archive:stale,workspace,boundary}),{code:'E_ARCHIVE_WRITER_SCOPE'});
 assert.equal(fs.existsSync(objects),false,'unowned checkpoint cannot create an object directory');
 assert.deepEqual(fs.readFileSync(journal),before);
 await writers.withWriter([runId],async()=>{
  const saved=commitStepCheckpoint({archive:openRunArchive(traceRoot,runId),workspace,boundary});
  assert.equal(saved.files.length,1);assert.equal(fs.readFileSync(path.join(objects,saved.files[0].sha256),'utf8'),'checkpoint version');
 });
 assert.deepEqual(readRun(traceRoot,runId).events.map(e=>e.type),['run/created','step/checkpoint']);
});
