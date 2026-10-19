import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createRunArchive,readRun} from './trace-store.mjs';
import {HandoffGate} from './handoff.mjs';
import {listArtifacts} from './sandbox.mjs';
import {buildCheckpointContext} from './checkpoint-context.mjs';
import {archiveStorageUsage} from './archive-storage.mjs';
import {checkpointTestInvocation} from '../../apps/desktop/checkpoint-test-profile.cjs';

// The command really runs and the worker is really killed. OpenShell identity
// is a fixture, so this is crash/recovery regression, not production acceptance.
const backend={kind:'openshell',version:'fixture',image:'node@sha256:'+'a'.repeat(64)};
const execution={...backend,node:process.version,uid:1000,gid:1000,effectivePolicyHash:'b'.repeat(64),cpu:[100000,100000],memory:536870912};
if(process.argv[2]==='--worker') {
 const root=process.argv[3],task={id:'qa',assignee:'qa',kind:'verification',dependencies:[],inputs:[],outputs:[{path:'unit.test.mjs'}],verify:['node --test unit.test.mjs'],verificationReuse:'same-workspace'};
 const snapshot={projectId:'crash-fixture',planVersion:1,agents:[{id:'qa',tools:['filesystem','terminal_test']}],tasks:[task],executionTarget:{kind:'local',backend}};
 const archive=createRunArchive(root,snapshot),workspace=join(archive.dir,'artifacts');mkdirSync(workspace);
 writeFileSync(join(workspace,'unit.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('addition',()=>assert.equal(2+3,5));\n");
 archive.append('local/device-bound',{execution});
 const gate=new HandoffGate({snapshot,archive,sandbox:{root:workspace}}),context={sessionId:'employee',callId:'test-1',approvalId:'approval-1'};
 archive.append('local/operation-queued',{operationId:'op-1',name:'terminal_test',taskId:'qa',attemptId:'old',...context});
 appendFileSync(join(root,'executions.txt'),'1\n');
 const invocation=checkpointTestInvocation(task.verify[0],workspace);
 const before=listArtifacts(workspace),result=spawnSync(process.execPath,invocation.args,{cwd:workspace,encoding:'utf8',env:invocation.env});
 assert.equal(result.status,0,result.stderr);
 archive.append('local/operation-finished',{operationId:'op-1',name:'terminal_test',taskId:'qa',attemptId:'old',...context,execution});
 const start=performance.now();
 gate.observe('qa','old','terminal_test',{command:task.verify[0]},{exitCode:result.status,output:result.stdout,execution,verificationProfile:invocation.profile},before,context);
 const durationMs=performance.now()-start;
 writeFileSync(join(root,'worker.json'),JSON.stringify({id:archive.id,durationMs,storage:archiveStorageUsage(archive.dir).bytes}));
 process.send({ready:true});setInterval(()=>{},1000);
}else test('hard process termination after a real test resumes evidence with one total command execution',{timeout:20000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'step-crash-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const worker=fork(fileURLToPath(import.meta.url),['--worker',root],{stdio:['ignore','ignore','pipe','ipc']});
 let errors='';worker.stderr.on('data',chunk=>errors+=chunk);t.after(()=>{if(worker.exitCode===null)worker.kill();});
 await Promise.race([once(worker,'message'),once(worker,'exit').then(()=>{throw Error('worker exited: '+errors);})]);
 const exited=once(worker,'exit');worker.kill('SIGKILL');await exited;
 const recorded=JSON.parse(readFileSync(join(root,'worker.json'),'utf8')),source=readRun(root,recorded.id),workspace=join(root,source.id,'artifacts');
 const recovery=buildCheckpointContext(source.snapshot,source.events,new Map(),new Map(),workspace,source.id);
 const snapshot={...source.snapshot,recovery},child=createRunArchive(root,snapshot),target=join(child.dir,'artifacts');cpSync(workspace,target,{recursive:true});child.append('local/device-bound',{execution});
 const start=performance.now(),gate=new HandoffGate({snapshot,archive:child,sandbox:{root:target}}),seal=gate.prepare('qa','new',{}),resumeMs=performance.now()-start;
 assert.equal(seal.commands[0].evidence.nodeTests.pass,1);assert.equal(seal.commands[0].inheritedFrom.runId,source.id);
 assert.equal(readFileSync(join(root,'executions.txt'),'utf8'),'1\n');
 writeFileSync(join(target,'unit.test.mjs'),'changed');assert.throws(()=>gate.prepare('qa','new',{}),/UNVERIFIED_COMMAND/);
 t.diagnostic(JSON.stringify({sourceRunId:source.id,resumedRunId:child.id,checkpointId:recovery.nodes.qa.stepCheckpoint.id,checkpointMs:recorded.durationMs,resumeMs,archiveBytes:recorded.storage,commandExecutions:1,modelCalls:0}));
});
