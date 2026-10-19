import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RunSandbox} from './sandbox.mjs';
import {createRunArchive} from './trace-store.mjs';
import {HandoffGate} from './handoff.mjs';
import {readStepCheckpoint} from './step-checkpoints.mjs';

test('a lazy sandbox has a durable empty workspace before the first employee tool',t=>{
 const root=mkdtempSync(join(tmpdir(),'sandbox-checkpoint-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const snapshot={projectId:'fixture',planVersion:1,agents:[{id:'dev',tools:['artifact_write']}],tasks:[{id:'dev',assignee:'dev',kind:'work',dependencies:[],inputs:[],outputs:[{path:'result.txt'}]}]};
 const archive=createRunArchive(root,snapshot),sandbox=new RunSandbox(archive.id,join(archive.dir,'artifacts'));
 const gate=new HandoffGate({snapshot,archive,sandbox});
 const saved=gate.checkpoint('dev','first','before-tool',{sessionId:'employee'});
 assert.equal(sandbox.started,false,'saving an empty checkpoint must not start Docker or any command');
 assert.deepEqual(readStepCheckpoint({root,runId:archive.id,checkpointId:saved.id}).files,[]);
 // Losing an existing workspace later is an error, not a new empty checkpoint.
 rmSync(sandbox.root,{recursive:true});
 assert.throws(()=>gate.checkpoint('dev','first','cycle-complete',{sessionId:'employee'}),/ENOENT/);
});
