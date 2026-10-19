import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunArchive, readRun } from './trace-store.mjs';
import { HandoffGate } from './handoff.mjs';
import { listArtifacts } from './sandbox.mjs';
import { buildCheckpointContext } from './checkpoint-context.mjs';

// Synthetic authenticated device identity; tests real journals and gate logic,
// not OpenShell attestation or real-model acceptance.
const backend={kind:'openshell',version:'0.1.2',image:'node@sha256:'+'1'.repeat(64),policySha256:'2'.repeat(64),fingerprint:'3'.repeat(64),gateway:'fixture'};
const execution={...backend,node:'v24.19.0',uid:1000,gid:1000,effectivePolicyHash:'4'.repeat(64),memory:'536870912',cpu:[100000,100000]};
const output='# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
function setup(t,second) {
  const root=mkdtempSync(join(tmpdir(),'inherited-step-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const task={id:'qa',assignee:'qa1',kind:'verification',dependencies:[],inputs:[],outputs:[{path:'a.test.mjs'}],verify:['node --test a.test.mjs'],verificationReuse:'same-workspace'};
  const snapshot={projectId:'p',planVersion:1,agents:[{id:'qa1',tools:['filesystem','terminal_test']}],tasks:[task],executionTarget:{kind:'local',deviceId:'dev',grantId:'grant',backend}};
  const archive=createRunArchive(root,snapshot),workspace=join(archive.dir,'artifacts');mkdirSync(workspace);writeFileSync(join(workspace,'a.test.mjs'),'// same test');
  archive.append('local/device-bound',{execution});
  const gate=new HandoffGate({snapshot,archive,sandbox:{root:workspace}});
  const context={sessionId:'employee',callId:'call-1',approvalId:'approval-1'};
  archive.append('local/operation-queued',{operationId:'operation-1',name:'terminal_test',taskId:'qa',attemptId:'old',...context});
  archive.append('local/operation-finished',{operationId:'operation-1',name:'terminal_test',taskId:'qa',attemptId:'old',...context,execution});
  gate.observe('qa','old','terminal_test',{command:task.verify[0]},{exitCode:0,output,execution,verificationProfile:'node-permission-workspace-v1'},listArtifacts(workspace),context);
  if(second){const next={...context,callId:'call-2'};for(const type of ['local/operation-queued','local/operation-finished'])archive.append(type,{operationId:'operation-2',name:'terminal_test',taskId:'qa',attemptId:'old',...next,execution});gate.observe('qa','old','terminal_test',{command:task.verify[0]},{output,execution,...second},listArtifacts(workspace),next);}
  const events=readRun(root,archive.id).events;
  const recovery=buildCheckpointContext(snapshot,events,new Map(),new Map(),workspace,archive.id);
  const childSnapshot={...snapshot,recovery},child=createRunArchive(root,childSnapshot),childRoot=join(child.dir,'artifacts');cpSync(workspace,childRoot,{recursive:true});
  child.append('local/device-bound',{execution});
  return {root,snapshot,archive,events,childSnapshot,child,childRoot};
}
test('an unfinished node resumes with inherited evidence and never relabels the original execution',t=>{
  const f=setup(t),gate=new HandoffGate({snapshot:f.childSnapshot,archive:f.child,sandbox:{root:f.childRoot}});
  assert.ok(f.events.some(e=>e.type==='step/checkpoint'),'completed tool must commit checkpoint');
  const report=gate.prepare('qa','new',{});
  assert.equal(report.commands.length,1);
  assert.equal(report.commands[0].evidence.runId,f.archive.id);
  assert.equal(report.commands[0].inheritedFrom.attemptId,'old');
  assert.equal(report.attemptId,'new');
  assert.equal(readRun(f.root,f.child.id).events.filter(e=>e.type==='handoff/command-observed').length,0);
});
test('changed files and revoked reuse permission require fresh verification',t=>{
  const f=setup(t);writeFileSync(join(f.childRoot,'a.test.mjs'),'changed');
  let gate=new HandoffGate({snapshot:f.childSnapshot,archive:f.child,sandbox:{root:f.childRoot}});
  assert.throws(()=>gate.prepare('qa','new',{}),/UNVERIFIED_COMMAND/);
  writeFileSync(join(f.childRoot,'a.test.mjs'),'// same test');
  const snapshot=structuredClone(f.childSnapshot);delete snapshot.tasks[0].verificationReuse;
  assert.throws(()=>{gate=new HandoffGate({snapshot,archive:f.child,sandbox:{root:f.childRoot}});gate.prepare('qa','new',{});},/UNVERIFIED_COMMAND|INVALID_HANDOFF_CONTRACT/);
});
test('new environment, changed tool grants, or unknown effects after the checkpoint block reuse',t=>{
  const f=setup(t);
  f.child.append('local/device-bound',{execution:{...execution,node:'v99'}});
  let gate=new HandoffGate({snapshot:f.childSnapshot,archive:f.child,sandbox:{root:f.childRoot}});
  assert.throws(()=>gate.prepare('qa','new',{}),/UNVERIFIED_COMMAND/);
  f.child.append('local/device-bound',{execution});
  const snapshot=structuredClone(f.childSnapshot);snapshot.agents[0].tools=['filesystem'];
  assert.throws(()=>{gate=new HandoffGate({snapshot,archive:f.child,sandbox:{root:f.childRoot}});gate.prepare('qa','new',{});},/UNVERIFIED_COMMAND|INVALID_HANDOFF_CONTRACT/);
  f.archive.append('runtime/outcome-unknown',{name:'terminal_test',callId:'later',arguments:{command:'something'}},{callId:'later'});
  gate=new HandoffGate({snapshot:f.childSnapshot,archive:f.child,sandbox:{root:f.childRoot}});
  assert.throws(()=>gate.prepare('qa','new',{}),/UNVERIFIED_COMMAND/);
});
test('ordinary plans and native host commands do not opt into verification inheritance',t=>{
  const f=setup(t),snapshot=structuredClone(f.childSnapshot);snapshot.executionTarget.backend={kind:'native'};
  const gate=new HandoffGate({snapshot,archive:f.child,sandbox:{root:f.childRoot}});
  assert.throws(()=>gate.prepare('qa','new',{}),/UNVERIFIED_COMMAND/);
});
test('a later failed or unconfined result cannot be hidden by an earlier passing receipt',t=>{
 for(const second of [{exitCode:1,verificationProfile:'node-permission-workspace-v1'},{exitCode:0}]){
  const f=setup(t,second),gate=new HandoffGate({snapshot:f.childSnapshot,archive:f.child,sandbox:{root:f.childRoot}});
  assert.throws(()=>gate.prepare('qa','new',{}),/UNVERIFIED_COMMAND/);
 }
});
test('a late unknown operation in the original receipt ancestor blocks another generation of reuse',t=>{
 const f=setup(t),gate=new HandoffGate({snapshot:f.childSnapshot,archive:f.child,sandbox:{root:f.childRoot}});gate.prepare('qa','new',{});
 gate.checkpoint('qa','new','cycle-complete',{sessionId:'second'});
 const recovery=buildCheckpointContext(f.childSnapshot,readRun(f.root,f.child.id).events,new Map(),new Map(),f.childRoot,f.child.id);
 const snapshot={...f.childSnapshot,recovery},child=createRunArchive(f.root,snapshot),target=join(child.dir,'artifacts');cpSync(f.childRoot,target,{recursive:true});child.append('local/device-bound',{execution});
 f.archive.append('runtime/outcome-unknown',{name:'terminal_test',callId:'late'});
 assert.throws(()=>new HandoffGate({snapshot,archive:child,sandbox:{root:target}}).prepare('qa','third',{}),/UNVERIFIED_COMMAND/);
});
test('a parent without a new checkpoint cannot be skipped when it has an unknown operation',t=>{
 const f=setup(t);f.child.append('runtime/outcome-unknown',{name:'terminal',callId:'intermediate'});
 const recovery=buildCheckpointContext(f.childSnapshot,readRun(f.root,f.child.id).events,new Map(),new Map(),f.childRoot,f.child.id);
 assert.equal(recovery.nodes.qa.stepCheckpoint.runId,f.archive.id);
 const snapshot={...f.childSnapshot,recovery},child=createRunArchive(f.root,snapshot),target=join(child.dir,'artifacts');cpSync(f.childRoot,target,{recursive:true});child.append('local/device-bound',{execution});
 assert.throws(()=>new HandoffGate({snapshot,archive:child,sandbox:{root:target}}).prepare('qa','third',{}),/UNVERIFIED_COMMAND/);
});
