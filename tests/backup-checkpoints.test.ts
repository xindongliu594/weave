import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,rmdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {commitStepCheckpoint} from '../services/agent-runtime/step-checkpoints.mjs';
import {validateBackupCheckpoints} from '../apps/api/src/backup-checkpoints.ts';

function fixture(t:any,empty=false){
 const root=mkdtempSync(join(tmpdir(),'backup-checkpoint-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=createRunArchive(root,{projectId:'project',planVersion:1}),workspace=join(source.dir,'artifacts');mkdirSync(workspace);
 if(!empty)writeFileSync(join(workspace,'data.txt'),'source');
 const receipt={command:'node --test unit.test.mjs',exitCode:0,workspaceRevision:'revision',evidence:{runId:source.id},acceptanceChecks:[]};
 const observation:any=source.append('handoff/command-observed',{taskId:'qa',attemptId:'first',...receipt});
 const checkpoint=commitStepCheckpoint({archive:source,workspace,boundary:{taskId:'qa',attemptId:'first',sessionId:'session',trigger:'tool-result',eventCursor:observation.seq,contractHash:'a'.repeat(64)},receipts:[{...receipt,observationSeq:observation.seq}]});
 const reference={runId:source.id,id:checkpoint.id,sha256:checkpoint.sha256};
 const child=createRunArchive(root,{projectId:'project',planVersion:1,recovery:{sourceRunId:source.id,nodes:{qa:{stepCheckpoint:reference}}}});
 const paths=()=>readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(root.length+1).replaceAll('\\','/'));
 return {root,source,child,checkpoint,paths,rows:[{id:child.id,snapshot:readRun(root,child.id)!.snapshot}]};
}
test('restore rejects missing or corrupt child journals even without own checkpoint objects',t=>{
 const f=fixture(t);const file=join(f.child.dir,'events.jsonl'),original=readFileSync(file);
 validateBackupCheckpoints(f.root,f.paths(),f.rows);
 for(const contents of [null,'',original.toString().replace('run/created','run/changed')]){
  if(contents===null)rmSync(file);else writeFileSync(file,contents);
  assert.throws(()=>validateBackupCheckpoints(f.root,f.paths(),f.rows),/CHECKPOINT|ENOENT/);
 }
});
test('database checkpoint references cannot disappear with missing archived files',t=>{
 const f=fixture(t);rmSync(f.child.dir,{recursive:true});
 assert.throws(()=>validateBackupCheckpoints(f.root,f.paths(),f.rows),/CHECKPOINT/);
 assert.throws(()=>validateBackupCheckpoints(f.root,[],f.rows),/CHECKPOINT/);
});
test('empty checkpoints survive the file-only backup format',t=>{
 const f=fixture(t,true);rmdirSync(join(f.source.dir,'checkpoint-objects'));
 assert.doesNotThrow(()=>validateBackupCheckpoints(f.root,f.paths(),f.rows));
});
test('checkpoint receipts must still match the original journal observation',t=>{
 const f=fixture(t),file=join(f.source.dir,'events.jsonl'),events=readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 events.find(e=>e.type==='handoff/command-observed').data.command='node --test unit.changed.mjs';
 writeFileSync(file,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 assert.throws(()=>validateBackupCheckpoints(f.root,f.paths(),f.rows),/CHECKPOINT_RECEIPT/);
});
test('structurally sound unknown operations remain backup data, not permission to resume',t=>{
 const f=fixture(t);f.source.append('runtime/outcome-unknown',{name:'terminal_test',callId:'unknown'});
 assert.doesNotThrow(()=>validateBackupCheckpoints(f.root,f.paths(),f.rows));
});
test('unrelated old forensic logs stay portable without being certified for resume',t=>{
 const f=fixture(t),old=createRunArchive(f.root,{projectId:'old',planVersion:1});
 writeFileSync(join(old.dir,'events.jsonl'),'truncated legacy journal');
 assert.doesNotThrow(()=>validateBackupCheckpoints(f.root,f.paths(),f.rows));
});
