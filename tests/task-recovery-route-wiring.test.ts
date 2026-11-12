import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {pool} from '../apps/api/src/db.ts';
import * as routes from '../apps/api/src/run-management.ts';

const profile='task-attempt-openshell-v1',sourceId=randomUUID(),checkpointId=randomUUID(),sha='a'.repeat(64);
function retryHandler(writers:any){
 const router=routes.runManagementRouter(writers.traceRoot,writers) as any;
 return router.stack.find((layer:any)=>layer.route?.path==='/runs/:id/retry'&&layer.route.methods.post).route.stack[0].handle;
}
test('task checkpoint retry waits for source admission before opening its SQL transaction',async t=>{
 const blocked=Error('source fence held'),seen:string[]=[];
 t.mock.method(pool,'query',async(text:any,values:any)=>{assert.match(String(text),/executionProfile/);assert.deepEqual(values,[sourceId]);return {rows:[{execution_profile:profile}]};});
 t.mock.method(pool,'connect',async()=>{seen.push('sql-transaction');throw Error('unexpected transaction');});
 const writers={traceRoot:'unused-task-recovery-route',withWriter:async()=>{seen.push('child-writer');throw Error('wrong guard');},withRecoverySource:async(source:string,target:string)=>{
  assert.equal(source,sourceId);assert.notEqual(target,sourceId);seen.push('source-fence');throw blocked;
 }};
 await assert.rejects(()=>retryHandler(writers)({params:{id:sourceId},body:{resume:true,checkpointId}},{locals:{}},()=>{}),error=>error===blocked);
 assert.deepEqual(seen,['source-fence']);
});

test('legacy retry without checkpoint still waits for its target fence without a preliminary SQL read',async t=>{
 const blocked=Error('target fence held');
 t.mock.method(pool,'query',async()=>{throw Error('unexpected preliminary SQL');});
 t.mock.method(pool,'connect',async()=>{throw Error('unexpected transaction');});
 const writers={traceRoot:'unused-task-recovery-route',withWriter:async()=>{throw blocked;},withRecoverySource:async()=>{throw Error('wrong source guard');}};
 await assert.rejects(()=>retryHandler(writers)({params:{id:sourceId},body:{resume:true}},{locals:{}},()=>{}),error=>error===blocked);
});

// These are pure composition fixtures. They grant no SQL/source authority and
// do not establish that the deliberately closed public profile is executable.
function composition(){
 const entry=(path:string,content:string)=>({path,size:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')});
 const files=[entry('a.txt','old A'),entry('b.txt','accepted B'),entry('private.txt','private')];
 const snapshot={projectId:'project',planVersion:1,executionProfile:profile,tasks:[{id:'a',inputs:[],outputs:[{path:'a.txt'}]},{id:'b',inputs:[],outputs:[{path:'b.txt'}]}],policy:{maxBudget:1}};
 const accepted={runId:sourceId,taskId:'b',attemptId:'parent-b',taskExecution:{profile,key:{runId:sourceId,taskId:'b',attemptId:'parent-b',generation:4}},outputs:[files[1]],commands:[{command:'verify B'}],employeeReport:{summary:'original B'}};
 const events=[
  {seq:1,type:'run/task-mapping',data:{tasks:[{task_id:'native-a',seed_id:'a'},{task_id:'native-b',seed_id:'b'}]}},
  {seq:2,type:'team/checkpoint',data:{tasks:[{id:'native-a',status:'in_progress',attemptId:'parent-a'},{id:'native-b',status:'pending'}]}},
  {seq:3,type:'step/checkpoint',data:{id:checkpointId,sha256:sha,boundary:{taskId:'a',trigger:'before-tool'},files:[files[0]]}},
  {seq:4,type:'model/wire-request',taskId:'a',data:{}},
  {seq:5,type:'team/checkpoint',at:'2026-11-02T01:00:00Z',data:{tasks:[{id:'native-a',status:'in_progress',attemptId:'parent-a'},{id:'native-b',status:'completed',attemptId:'parent-b',output:'B result'}],budgetEvidence:{version:1,runId:sourceId,basis:'host-execution-budget',projectId:'project',projectVersion:1,point:'latest',project:{limit:1,occupied:.6,activeReserved:0,available:.4,callsUsed:7,callLimit:20}}}},
  {seq:6,type:'billing/usage',data:{cost:.1}}
 ];
 const source={id:sourceId,snapshot,events},facts={source:{sourceRunId:sourceId,sourceCheckpoint:{id:checkpointId,sha256:sha}},selected:{event:events[2],checkpoint:events[2].data},scope:{candidate:{manifest:files},retained:[{key:accepted.taskExecution.key,accepted}]}};
 return {source,facts,accepted,files};
}
test('task child context keeps full candidate B and private files while A context stops at selected CP',()=>{
 const build=(routes as any).buildTaskRecoveryChildContext;assert.equal(typeof build,'function');
 const f=composition(),before=structuredClone(f.source),context=build(f.source,f.facts,'unused-root');
 assert.deepEqual(context.completedCheckpoints,['b']);assert.deepEqual(context.handoffCheckpoints,[f.accepted]);
 assert.equal(context.handoffCheckpoints[0].runId,sourceId);assert.equal(context.handoffCheckpoints[0].taskExecution.key.generation,4);
 assert.equal(context.recovery.version,1);assert.deepEqual(context.recovery.files.map((row:any)=>row.path),['a.txt','b.txt','private.txt']);
 assert.equal(context.recovery.files.find((row:any)=>row.path==='b.txt').state,'accepted');
 assert.equal(context.recovery.nodes.a.status,'restart');assert.equal(context.recovery.nodes.a.stepCheckpoint.id,checkpointId);
 assert.deepEqual(context.recovery.completed,[{taskId:'b',attemptId:'parent-b',output:'B result'}]);
 assert.deepEqual(context.recovery.workspaceCheckpoint,{id:checkpointId,runId:sourceId,sha256:sha});
 assert.equal(context.recovery.budgetEvidence.checkpointSeq,5);assert.equal(context.recovery.budgetEvidence.project.callsUsed,7);assert.equal(context.recovery.budgetEvidence.subsequentAccountingEvents,1);
 assert.deepEqual(f.source,before);
});

test('task child composition refuses retained task states with absent or different native attempts',()=>{
 const build=(routes as any).buildTaskRecoveryChildContext;assert.equal(typeof build,'function');
 for(const mutate of [(f:any)=>f.source.events[4].data.tasks[1].attemptId='foreign-b',(f:any)=>f.source.events[4].data.tasks[1].status='pending',(f:any)=>f.facts.scope.retained.push(f.facts.scope.retained[0])]){
  const f=composition();mutate(f);assert.throws(()=>build(f.source,f.facts,'unused-root'),{code:'TASK_RECOVERY_SOURCE_INVALID'});
 }
});
