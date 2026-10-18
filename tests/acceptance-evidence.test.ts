import test from 'node:test';
import assert from 'node:assert/strict';
import {observeAcceptanceChecks,collectAcceptanceChecks} from '../services/agent-runtime/acceptance-checks.mjs';
import {runAcceptanceEvidence} from '../apps/api/src/run-acceptance-evidence.ts';
import {sameHandoffSeal} from '../packages/contracts/run-lineage-evidence.ts';
import {taskSchema} from '../packages/contracts/index.ts';
import {resumeHandoff} from '../apps/api/src/handoff-checkpoints.ts';

const task={id:'qa',dependencies:[],acceptanceCriteria:['用户可启动'],verify:['node cli.mjs 25'],acceptanceChecks:[{criterionIndex:0,command:'node cli.mjs 25',expectedOutput:'77\n'}]};
function run(){
 const command={command:task.verify[0],exitCode:0,workspaceRevision:'revision',acceptanceChecks:observeAcceptanceChecks(task,task.verify[0],{exitCode:0,output:'77\n'})};
 const record={taskId:'qa',attemptId:'a',runId:'run',workspaceRevision:'revision',commands:[command],acceptanceChecks:collectAcceptanceChecks(task,[command],'revision')};
 return {id:'run',integrity:'ok',snapshot:{projectId:'project',planVersion:1,tasks:[structuredClone(task)]},events:[
  {type:'run/task-mapping',data:{tasks:[{task_id:'native',seed_id:'qa'}]}},
  {type:'team/checkpoint',data:{tasks:[{id:'native',status:'completed',attemptId:'a'}]}},
  {type:'handoff/accepted',data:record}]};
}
const lineage={version:1,runId:'run',projectId:'project',planVersion:1,sourceRunId:null,status:'none',receipts:[],tests:[],issues:[]} as const;
test('only matching completed attempt and host seal expose passing evidence',()=>{
 const source=run();assert.equal(runAcceptanceEvidence(source,lineage as any).rows[0].status,'passed');
 for(const mutate of [(r:any)=>r.integrity='broken',(r:any)=>r.events[1].data.tasks[0].attemptId='new',(r:any)=>r.events[1].data.tasks[0].status='in_progress',(r:any)=>delete r.events[2].data.acceptanceChecks]){
  const changed=run();mutate(changed);assert.equal(runAcceptanceEvidence(changed,lineage as any).rows[0].status,'unverified');
 }
});
test('new requirement or truncated/changed receipt cannot inherit old success; seals include acceptance',()=>{
 const source=run();source.snapshot.tasks[0].acceptanceCriteria=['新增要求'];assert.equal(runAcceptanceEvidence(source,lineage as any).rows[0].status,'unverified');
 const record=run().events[2].data;assert.equal(sameHandoffSeal(record,{...record,acceptanceChecks:[]}),false);
});
test('legacy reports remain unverified instead of inventing new mappings',()=>{
 const source=run();delete (source.snapshot.tasks[0] as any).acceptanceChecks;
 const row=runAcceptanceEvidence(source,lineage as any).rows[0];assert.equal(row.status,'unverified');assert.match(row.reason,/未定义/);
});
test('delivery projection requires committed producers and the exact check attempt',()=>{
 const source:any=run();source.snapshot.tasks[0].assigneeId='qa';source.snapshot.tasks.push({id:'write',assigneeId:'writer',acceptanceCriteria:[],outputs:[]});
 source.snapshot.deliveryCriteria=[{id:'r1',description:'程序可启动',producerTaskIds:['write'],checkTaskId:'qa',checkCriteriaIndexes:[0],independent:true}];
 source.events[0].data.tasks.push({task_id:'native-write',seed_id:'write'});source.events[1].data.tasks.push({id:'native-write',status:'completed',attemptId:'w'});
 source.events.push({type:'handoff/accepted',data:{taskId:'write',attemptId:'w',runId:'run',outputs:[]}});
 assert.equal(runAcceptanceEvidence(source,lineage as any).deliveryCriteria?.[0].status,'passed');
 source.snapshot.tasks[1].outputs=[{path:'result.txt'}];source.events.at(-1).data.outputs=[{path:'result.txt',sha256:'old'}];source.events[2].data.inputs=[{path:'result.txt',producerTaskId:'write',sha256:'old'}];
 source.events.push({type:'delivery/checked',data:{files:[{path:'result.txt',sha256:'changed'}]}});
 assert.equal(runAcceptanceEvidence(source,lineage as any).deliveryCriteria?.[0].status,'unverified','final artifact manifest defeats matching old receipt pairs');
 source.events[1].data.tasks[1].status='in_progress';assert.equal(runAcceptanceEvidence(source,lineage as any).deliveryCriteria?.[0].status,'unverified');
});
test('check schema rejects invalid exit codes and zero tests',()=>{
 const plan={...task,subject:'QA',objective:'检查交付',assigneeId:'qa',estimatedInputTokens:1,estimatedOutputTokens:1};
 assert.equal(taskSchema.safeParse(plan).success,true);
 for(const patch of [{expectedExitCode:-1},{expectedExitCode:256},{minimumTests:0}])assert.equal(taskSchema.safeParse({...plan,acceptanceChecks:[{...task.acceptanceChecks[0],...patch}]}).success,false);
});
test('cold recovery retains checks without rerunning commands and rejects altered proof',()=>{
 const source=JSON.parse(JSON.stringify(run())),record=source.events[2].data;
 const completed=new Map([['qa',{attemptId:'a'}]]);
 assert.equal(resumeHandoff(source.snapshot,source.events,completed,process.cwd()).length,1);
 const inherited=JSON.parse(JSON.stringify({...source.snapshot,handoffCheckpoints:[record]}));
 assert.equal(resumeHandoff(inherited,[],completed,process.cwd()).length,1);
 inherited.handoffCheckpoints[0].acceptanceChecks[0].status='unverified';
 assert.throws(()=>resumeHandoff(inherited,[],completed,process.cwd()),/逐项验收/);
 assert.equal(record.commands.length,1);
});
