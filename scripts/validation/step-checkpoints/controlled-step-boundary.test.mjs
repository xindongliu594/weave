import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRunArchive} from '../../../services/agent-runtime/trace-store.mjs';
import {HandoffGate} from '../../../services/agent-runtime/handoff.mjs';
import {listArtifacts} from '../../../services/agent-runtime/sandbox.mjs';

const {atStepBoundary}=await import('./controlled-step-boundary.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'acceptance-step-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const backend={kind:'openshell',version:'fixture',image:'node@sha256:'+'1'.repeat(64)};
 const execution={...backend,node:'v24.19.0',uid:1000,gid:1000,effectivePolicyHash:'2'.repeat(64),cpu:[100000,100000],memory:536870912};
 const task={id:'qa',assignee:'qa',kind:'verification',dependencies:[],inputs:[],outputs:[{path:'unit.test.mjs'}],verify:['node --test unit.test.mjs'],verificationReuse:'same-workspace'};
 const snapshot={projectId:'selected',planVersion:1,agents:[{id:'qa',tools:['terminal_test']}],tasks:[task],executionTarget:{kind:'local',backend}};
 const archive=createRunArchive(root,snapshot),workspace=join(archive.dir,'artifacts');mkdirSync(workspace);writeFileSync(join(workspace,'unit.test.mjs'),'// protocol fixture, no actual test run');
 archive.append('local/device-bound',{execution});
 const gate=new HandoffGate({snapshot,archive,sandbox:{root:workspace}});let sequence=0;
 function observe(exitCode=0){
  const callId='call-'+(++sequence),context={sessionId:'qa-session',callId,approvalId:'approved'};
  for(const type of ['local/operation-queued','local/operation-finished'])archive.append(type,{operationId:callId,name:'terminal_test',taskId:'qa',attemptId:'old',...context,execution});
  gate.observe('qa','old','terminal_test',{command:task.verify[0]},{exitCode,output:'# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',execution,verificationProfile:'node-permission-workspace-v1'},listArtifacts(workspace),context);
 }
 return {root,archive,observe,workspace};
}
test('only a committed successful QA checkpoint holds the next request before dispatch',async t=>{
 assert.equal(typeof atStepBoundary,'function');const f=fixture(t),controller=new AbortController();let dispatched=0,marker;
 const original=async()=>{dispatched++;return 'real';},options={root:f.root,projectId:'selected',taskId:'qa',command:'node --test unit.test.mjs',onBoundary:value=>{marker=value;}};
 const invoke=atStepBoundary(original,options);
 assert.equal(await invoke(f.archive.id,{id:'before'},controller.signal),'real');
 f.archive.append('handoff/accepted',{taskId:'dev'});
 assert.equal(await invoke(f.archive.id,{id:'after-dev'},controller.signal),'real');
 f.archive.append('handoff/command-observed',{taskId:'qa',command:options.command,exitCode:0});
 assert.equal(await invoke(f.archive.id,{id:'not-committed'},controller.signal),'real');
 f.observe();
 assert.equal(await atStepBoundary(original,{...options,projectId:'other'})(f.archive.id,{id:'other'},controller.signal),'real');
 const wait=invoke(f.archive.id,{id:'held',taskId:'qa'},controller.signal);
 assert.equal(dispatched,4);assert.equal(marker.heldRequestId,'held');assert.equal(marker.reference.runId,f.archive.id);assert.equal(marker.taskId,'qa');
 controller.abort(Error('controlled service stop'));await assert.rejects(wait,/controlled service stop/);assert.equal(dispatched,4);
});
test('failed test, accepted QA, changed files and unknown effects cannot masquerade as the intended boundary',async t=>{
 assert.equal(typeof atStepBoundary,'function');const f=fixture(t);let dispatched=0;
 const invoke=atStepBoundary(async()=>{dispatched++;},{root:f.root,projectId:'selected',taskId:'qa',command:'node --test unit.test.mjs',onBoundary(){throw Error('must not hold');}});
 f.observe(1);await invoke(f.archive.id,{},new AbortController().signal);assert.equal(dispatched,1);
 f.observe();writeFileSync(join(f.workspace,'unit.test.mjs'),'changed');
 await assert.rejects(invoke(f.archive.id,{},new AbortController().signal),/FILES_CHANGED/);
 f.archive.append('runtime/outcome-unknown',{name:'terminal_test',callId:'unknown'});
 await assert.rejects(invoke(f.archive.id,{},new AbortController().signal),/UNKNOWN/);
 f.archive.append('handoff/accepted',{taskId:'qa'});
 await assert.rejects(invoke(f.archive.id,{},new AbortController().signal),/BOUNDARY_MISSED/);
 assert.equal(dispatched,1);
});
