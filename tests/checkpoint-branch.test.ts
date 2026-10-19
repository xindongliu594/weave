import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {resumeHandoff} from '../apps/api/src/handoff-checkpoints.ts';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {commitStepCheckpoint,checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';

async function api(){try{return await import('../apps/api/src/step-checkpoint-recovery.ts');}catch(error:any){if(error.code==='ERR_MODULE_NOT_FOUND')return {} as any;throw error;}}
function fixture(t:any){
 const root=mkdtempSync(join(tmpdir(),'checkpoint-branch-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const snapshot:any={projectId:'project',planVersion:1,tasks:[{id:'qa',dependencies:[],inputs:[{path:'a.txt',sha256:createHash('sha256').update('before').digest('hex')}]}],policy:{maxBudget:1},executionTarget:{backend:{kind:'openshell'}}};
 const archive=createRunArchive(root,snapshot),workspace=join(archive.dir,'artifacts');mkdirSync(workspace);writeFileSync(join(workspace,'a.txt'),'before');
 const cp=commitStepCheckpoint({archive,workspace,boundary:{taskId:'qa',attemptId:'a',sessionId:'s',trigger:'cycle-complete',eventCursor:1,contractHash:checkpointContract(snapshot,snapshot.tasks[0])}});
 writeFileSync(join(workspace,'a.txt'),'after');archive.append('billing/usage',{cost:.2});
 return {root,snapshot,archive,workspace,cp,run:()=>readRun(root,archive.id)};
}
test('selecting an earlier point preserves accounting and restores files only into a new workspace',async t=>{
 const {selectStepCheckpoint,restoreStepWorkspace}=await api();assert.equal(typeof selectStepCheckpoint,'function');
 const f=fixture(t),selected=selectStepCheckpoint(f.root,f.run(),f.cp.id),target=join(f.root,'new','artifacts');
 assert.throws(()=>resumeHandoff(f.snapshot,f.run()!.events,new Map(),f.workspace),/已变化/);
 assert.doesNotThrow(()=>resumeHandoff(f.snapshot,f.run()!.events,new Map(),f.workspace,selected.checkpoint.files));
 restoreStepWorkspace(f.root,selected.reference,target);
 assert.equal(readFileSync(join(target,'a.txt'),'utf8'),'before');assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'after');
 assert.equal(f.run()!.events.filter((e:any)=>e.type==='billing/usage').length,1);
 assert.throws(()=>restoreStepWorkspace(f.root,selected.reference,f.workspace),/CHECKPOINT_TARGET_EXISTS/);
});
test('unknown and external effects after a selected point cannot be forgotten by rollback',async t=>{
 const {selectStepCheckpoint}=await api();assert.equal(typeof selectStepCheckpoint,'function');
 const f=fixture(t);f.archive.append('runtime/outcome-unknown',{name:'terminal',callId:'unknown'},{callId:'unknown'});
 assert.throws(()=>selectStepCheckpoint(f.root,f.run(),f.cp.id),/CHECKPOINT_OPERATION_UNKNOWN/);
});
test('another employee modifying shared files after the point blocks rollback',async t=>{
 const {selectStepCheckpoint}=await api();assert.equal(typeof selectStepCheckpoint,'function');
 const f=fixture(t);f.archive.append('artifact/updated',{files:[]},{taskId:'other',attemptId:'b'});
 assert.throws(()=>selectStepCheckpoint(f.root,f.run(),f.cp.id),/CHECKPOINT_OTHER_TASK_CHANGED/);
});
