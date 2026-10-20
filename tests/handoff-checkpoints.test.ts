import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {randomUUID} from 'node:crypto';
import { inspectArtifact } from '../services/agent-runtime/handoff.mjs';
import { resumeHandoff, completedTasks } from '../apps/api/src/handoff-checkpoints.ts';
import {observeAcceptanceChecks,assertAcceptanceChecks} from '../services/agent-runtime/acceptance-checks.mjs';

test('task acceptance consumes its own sandbox revision and rejects another task binding',()=>{
 const id=randomUUID(),key={runId:id,taskId:'check',attemptId:'attempt',generation:1},operationId=randomUUID(),partial='1'.repeat(64),complete='2'.repeat(64);
 const task={id:'check',assignee:'tester',kind:'work',dependencies:[],inputs:[],outputs:[],verify:['check'],acceptanceCriteria:['Check is successful'],acceptanceChecks:[{criterionIndex:0,command:'check',expectedExitCode:0}]};
 const command={command:'check',exitCode:0,workspaceRevision:partial,mergeId:operationId,taskExecution:{profile:'task-attempt-openshell-v1',key,scopeHash:'3'.repeat(64),operationId,beforeWorkRevision:partial,afterWorkRevision:partial},acceptanceChecks:observeAcceptanceChecks(task,'check',{exitCode:0,output:''})};
 const accepted={runId:id,taskId:'check',attemptId:'attempt',workspaceRevision:complete,sandboxWorkRevision:partial,taskExecution:{profile:'task-attempt-openshell-v1',key,capabilityHash:'4'.repeat(64)},inputs:[],outputs:[],commands:[command],acceptanceChecks:assertAcceptanceChecks(task,[command],partial)};
 const snapshot={id,executionProfile:'task-attempt-openshell-v1',agents:[],tasks:[task]},completed=new Map([['check',{attemptId:'attempt'}]]);
 const events=[{type:'handoff/accepted',data:accepted}];
 assert.equal(resumeHandoff(snapshot,events,completed,'unused')[0].sandboxWorkRevision,partial);
 for(const change of [{...accepted,taskExecution:{...accepted.taskExecution,key:{...key,runId:randomUUID()}}},{...accepted,sandboxWorkRevision:complete},{...accepted,commands:[{...command,taskExecution:{...command.taskExecution,key:{...key,generation:2}}}]}]){
  assert.throws(()=>resumeHandoff(snapshot,[{type:'handoff/accepted',data:change}],completed,'unused'),/TASK_ACCEPTANCE|ACCEPTANCE_CHECK/);
 }
});
test('resume uses exact accepted attempt and rejects missing evidence or a changed restored file',async()=>{
  const root=await mkdtemp(join(tmpdir(),'resume-handoff-'));
  try {
    await writeFile(join(root,'data.json'),'{"count":2}');
    const snapshot={agents:[],tasks:[{id:'produce',dependencies:[],outputs:[{path:'data.json'}]},{id:'consume',dependencies:['produce'],inputs:[{path:'data.json',producerTaskId:'produce'}]}]};
    const completed=new Map([['produce',{attempt_id:'a'}]]),record={taskId:'produce',attemptId:'a',outputs:[inspectArtifact(root,{path:'data.json'})]},events=[{type:'handoff/accepted',data:record}];
    assert.equal(resumeHandoff(snapshot,events,completed,root)[0].outputs[0].sha256,record.outputs[0].sha256);
    assert.throws(()=>resumeHandoff(snapshot,[...events,{type:'quality/rework-created',data:{}}],completed,root),/完整重试/);
    assert.throws(()=>resumeHandoff(snapshot,[],completed,root),/缺少宿主/);
    assert.throws(()=>resumeHandoff(snapshot,events,new Map([['produce',{attempt_id:'b'}]]),root),/缺少宿主/);
    await writeFile(join(root,'data.json'),'{"count":3}');assert.throws(()=>resumeHandoff(snapshot,events,completed,root),/已变化/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('completed implementation stays in the DAG when its review is pending; inherited seals survive another interruption',async()=>{
 const root=await mkdtemp(join(tmpdir(),'resume-review-'));
 try{
  await writeFile(join(root,'code.txt'),'done');
  const tasks=[{id:'build',assignee:'developer',kind:'implementation',dependencies:[],outputs:[{path:'code.txt'}],inScope:['code.txt'],verify:['check']},{id:'review',assignee:'tester',kind:'review',reviewedTaskId:'build',dependencies:['build'],inputs:[{path:'code.txt',producerTaskId:'build'}],outputs:[]}];
  const record={taskId:'build',attemptId:'a',outputs:[inspectArtifact(root,{path:'code.txt'})]};
  const snapshot={tasks,agents:[],handoffCheckpoints:[record],recovery:{completed:[{taskId:'build',attemptId:'a',output:'finished'}]}};
  const done=completedTasks([],snapshot);assert.equal(done.size,1);
  assert.equal(resumeHandoff(snapshot,[],done,root).length,1);assert.equal(tasks.length,2);assert.equal(tasks[1].reviewedTaskId,'build');
  const events=[{type:'run/task-mapping',data:{tasks:[{task_id:'t1',seed_id:'build'}]}},{type:'team/checkpoint',data:{tasks:[{id:'t1',status:'completed'}]}},{type:'team/snapshot',data:{tasks:[{id:'t1',status:'in_progress'}]}}];
  assert.equal(completedTasks(events,snapshot).size,0,'a newer unfinished state supersedes an older checkpoint');
  await writeFile(join(root,'code.txt'),'tampered');assert.throws(()=>resumeHandoff(snapshot,[],done,root),/已变化/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('authorized later writers retain earlier checkpoints while recovery validates the latest file version',async()=>{
 const root=await mkdtemp(join(tmpdir(),'resume-versions-'));
 try{
  const tasks=[{id:'initial',assignee:'developer',kind:'implementation',dependencies:[],outputs:[{path:'data.json',format:'json',expectedValues:{version:1}}],inScope:['data.json'],verify:['check']},{id:'update',assignee:'developer',kind:'implementation',dependencies:['initial'],inputs:[{path:'data.json',producerTaskId:'initial'}],outputs:[{path:'data.json',format:'json',expectedValues:{version:2}}],inScope:['data.json'],verify:['check']},{id:'review',assignee:'tester',kind:'review',reviewedTaskId:'update',dependencies:['update'],inputs:[{path:'data.json',producerTaskId:'update'}],outputs:[]}];
  await writeFile(join(root,'data.json'),'{"version":1}');const first={taskId:'initial',attemptId:'a',outputs:[inspectArtifact(root,{path:'data.json'})]};
  await writeFile(join(root,'data.json'),'{"version":2}');const second={taskId:'update',attemptId:'b',outputs:[inspectArtifact(root,{path:'data.json'})]};
  const snapshot={tasks,agents:[],handoffCheckpoints:[first,second]},done=new Map([['initial',{attemptId:'a'}],['update',{attemptId:'b'}]]);
  assert.equal(resumeHandoff(snapshot,[],done,root).length,2);
  await writeFile(join(root,'data.json'),'{"version":3}');assert.throws(()=>resumeHandoff(snapshot,[],done,root),/ACCEPTANCE_FAILED|已变化/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('rework recovery uses the newest mapping and requires independent acceptance of the complete pair',async()=>{
 const root=await mkdtemp(join(tmpdir(),'resume-rework-'));
 try{
  await writeFile(join(root,'data.json'),'{"count":2}');
  const snapshot={agents:[],tasks:[{id:'build',assignee:'developer',kind:'implementation',dependencies:[],inputs:[],outputs:[{path:'data.json',format:'json',expectedValues:{count:2}}],inScope:['data.json'],verify:['check']},{id:'review',assignee:'tester',kind:'review',reviewedTaskId:'build',dependencies:['build'],inputs:[{path:'data.json',producerTaskId:'build'}],outputs:[],maxReworkRounds:1},{id:'deliver',dependencies:['review'],inputs:[{path:'data.json',producerTaskId:'build'}]}]};
  const output=inspectArtifact(root,{path:'data.json'});
  const events:any[]=[{type:'run/task-mapping',data:{tasks:[{task_id:'t1',seed_id:'build'},{task_id:'t2',seed_id:'review'}]}},{type:'quality/rework-created',data:{reviewTaskId:'review',round:1}},{type:'run/task-mapping',data:{tasks:[{task_id:'t3',seed_id:'build'},{task_id:'t4',seed_id:'review'}]}},{type:'handoff/accepted',data:{taskId:'build',attemptId:'repair',outputs:[output]}},{type:'handoff/accepted',data:{taskId:'review',attemptId:'recheck',outputs:[]}},{type:'quality/reviewed',data:{taskId:'review',attemptId:'recheck',verdict:'pass'}},{type:'team/checkpoint',data:{tasks:[{id:'t1',status:'completed',attemptId:'initial'},{id:'t2',status:'failed'},{id:'t3',status:'completed',attemptId:'repair'},{id:'t4',status:'completed',attemptId:'recheck',verdict:'pass'}]}}];
  const done=completedTasks(events);assert.equal(done.get('build').attemptId,'repair');assert.equal(resumeHandoff(snapshot,events,done,root).length,2);
  events.at(-1).data.tasks.at(-1).status='in_progress';assert.throws(()=>resumeHandoff(snapshot,events,completedTasks(events),root),/尚未形成独立验收/);
  events.at(-1).data.tasks.at(-1).status='completed';events.at(-1).data.tasks[2].status='in_progress';assert.equal(completedTasks(events).has('build'),false);
  assert.throws(()=>resumeHandoff(snapshot,events,completedTasks(events),root),/尚未形成独立验收/);
  events.at(-1).data.tasks[2].status='completed';await writeFile(join(root,'data.json'),'{"count":3}');assert.throws(()=>resumeHandoff(snapshot,events,completedTasks(events),root),/ACCEPTANCE_FAILED|已变化/);
 }finally{await rm(root,{recursive:true,force:true});}
});
