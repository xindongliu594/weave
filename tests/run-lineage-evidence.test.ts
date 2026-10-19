import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {collectRunLineageEvidence} from '../apps/api/src/run-lineage-evidence.ts';
import {RunInheritedEvidence} from '../apps/web/src/RunInheritedEvidence.tsx';
import {createGoalContract} from '../packages/contracts/goal-contract.mjs';
import {applyRecoveryResources} from '../apps/api/src/recovery-resource-plan.ts';
import {createHandoffReport,handoffContractDigest} from '../packages/contracts/handoff-report.mjs';

// Isolated regression fixtures. No model, production DB or employee artifact
// is generated here. Real acceptance is documented separately.
const parentId='11111111-1111-4111-8111-111111111111',childId='22222222-2222-4222-8222-222222222222',runId='33333333-3333-4333-8333-333333333333';
const operationId='44444444-4444-4444-8444-444444444444';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const output='# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const fileA={path:'code.mjs',sha256:sha('A'),size:1},fileB={path:'test.mjs',sha256:sha('B'),size:1};
const contracts=[{id:'T1',assignee:'developer',kind:'implementation',dependencies:[],inputs:[],outputs:[{path:'code.mjs'}]},
 {id:'T2',assignee:'qa',kind:'verification',dependencies:['T1'],inputs:[{path:'code.mjs',producerTaskId:'T1'}],outputs:[{path:'test.mjs'}]},
 {id:'T3',assignee:'manager',kind:'review',dependencies:['T1','T2'],inputs:[],outputs:[]}];
const event=(seq:number,type:string,data:any)=>({seq,type,data});
function fixture(){
 const t1={runId:parentId,taskId:'T1',attemptId:'a1',workspaceRevision:sha('workspace-a'),inputs:[],outputs:[fileA],commands:[],acceptedAt:'fixture-time'};
 const command={command:'node --test test.mjs',exitCode:0,workspaceRevision:sha('workspace-ab'),observationSeq:4,
  evidence:{version:1,runId:childId,tool:'terminal_test',callId:'call',sessionId:'session',approval:{status:'available',approvalId:'approval'},
   operation:{status:'available',operationId,queuedSeq:2,finishedSeq:3},output:{status:'available',complete:true,bytes:Buffer.byteLength(output),sha256:sha(output)}}};
 const t2={runId:childId,taskId:'T2',attemptId:'a2',workspaceRevision:sha('workspace-ab'),inputs:[{...fileA,producerTaskId:'T1'}],outputs:[fileB],commands:[command],acceptedAt:'fixture-time'};
 const recovery=(sourceRunId:string,seals:any[])=>({version:1,sourceRunId,completed:seals.map(seal=>({taskId:seal.taskId,attemptId:seal.attemptId})),
  files:seals.flatMap(seal=>seal.outputs.map((file:any)=>({...file,state:'accepted',producerTaskId:seal.taskId}))),
  nodes:Object.fromEntries(seals.map(seal=>[seal.taskId,{historyRunId:sourceRunId,status:'completed',output:'untrusted source summary'}]))});
 const base={projectId:'project',planVersion:12,tasks:contracts,agents:[{id:'manager',role:'manager'}]};
 const parent:any={id:parentId,integrity:'ok',snapshot:{...base},events:[event(1,'run/task-mapping',{tasks:[{task_id:'n1',seed_id:'T1'}]}),
  event(2,'handoff/accepted',t1),event(3,'team/checkpoint',{tasks:[{id:'n1',attemptId:'a1',status:'completed'}]})]};
 const link={operationId,name:'terminal_test',taskId:'T2',attemptId:'a2',agentId:'qa',callId:'call',sessionId:'session',approvalId:'approval'};
 const child:any={id:childId,integrity:'ok',snapshot:{...base,approvedTasks:contracts,handoffCheckpoints:[t1],recovery:recovery(parentId,[t1])},events:[
  event(1,'run/task-mapping',{tasks:[{task_id:'n2',seed_id:'T2'}]}),event(2,'local/operation-queued',link),event(3,'local/operation-finished',link),
  event(4,'handoff/command-observed',{taskId:'T2',attemptId:'a2',...command,observationSeq:undefined}),event(5,'handoff/accepted',t2),
  event(6,'team/checkpoint',{tasks:[{id:'n2',attemptId:'a2',status:'completed'}]})]};
 const current:any={id:runId,integrity:'ok',snapshot:{...base,approvedTasks:contracts,handoffCheckpoints:[t1,t2],recovery:recovery(childId,[t1,t2])},events:[]};
 const operation:any={id:operationId,runId:childId,status:'completed',started:true,payload:{name:'terminal_test',arguments:{command:command.command,expectedWorkspaceRevision:command.workspaceRevision},context:{...link}},result:{ok:true,result:{exitCode:0,output}}};
 const reads:string[]=[];
 const load={run:(id:string)=>{reads.push(id);return id===parentId?parent:id===childId?child:null;},operations:async(id:string,ids:string[])=>id===childId&&ids.includes(operationId)?[operation]:[]};
 return {current,parent,child,operation,load,reads,t1,t2};
}

function resourceFixture(){
 const f=fixture();
 for(const run of [f.parent,f.child,f.current]){
  run.snapshot=structuredClone(run.snapshot);run.snapshot.requirement='Original immutable goal';
  run.snapshot.policy={maxBudget:.13,maxModelCalls:45,maxTaskModelCalls:10};
  run.snapshot.tasks[2].maxModelCalls=3;run.snapshot.approvedTasks=structuredClone(run.snapshot.tasks);
  run.snapshot.goalContract=createGoalContract(run.snapshot);
 }
 const proposal={maxBudget:.18,taskCallLimits:{T3:6},rationale:'Only resource approval for the remaining manager'};
 f.current.snapshot=applyRecoveryResources(f.current.snapshot,proposal,{newRevision:1,completedTaskIds:['T1','T2'],
  history:{calls:2,tasks:{T3:{calls:1}}},ceiling:.18});
 f.current.snapshot.resourceApproval={format:'run-resource-approval-v1',revision:1,sourceRunId:childId,
  sourceGoalContract:f.child.snapshot.goalContract,proposal,ceiling:.18,previewId:operationId,usageId:operationId,modelId:'m',approvedAt:'fixture'};
 f.current.snapshot.goalContract=createGoalContract(f.current.snapshot);
 return f;
}
test('a test reused inside an unfinished attempt retains its original execution through later node recovery',async()=>{
 const f=fixture(),originalCommand=f.t2.commands[0],originSeal=structuredClone(f.t2);
 f.child.events=f.child.events.filter((e:any)=>e.type!=='handoff/accepted');f.child.events.at(-1).data.tasks[0].status='failed';
 const command={...originalCommand,inheritedFrom:{runId:childId,attemptId:'a2',checkpointId:'cp',checkpointRunId:childId,observationSeq:4}};
 const seal={...originSeal,runId,attemptId:'a3',commands:[command]};
 f.current.snapshot.handoffCheckpoints=[f.t1];f.current.snapshot.recovery.completed=[{taskId:'T1',attemptId:'a1'}];
 f.current.events=[event(1,'run/task-mapping',{tasks:[{task_id:'n3',seed_id:'T2'}]}),event(2,'step/evidence-inherited',{taskId:'T2',attemptId:'a3',commands:[command]}),event(3,'handoff/accepted',seal),event(4,'team/checkpoint',{tasks:[{id:'n3',attemptId:'a3',status:'completed'}]})];
 const later=structuredClone(f.current);later.id='55555555-5555-4555-8555-555555555555';later.events=[];
 later.snapshot.handoffCheckpoints=[f.t1,seal];later.snapshot.recovery.sourceRunId=runId;later.snapshot.recovery.completed.push({taskId:'T2',attemptId:'a3'});later.snapshot.recovery.nodes.T2={status:'completed',historyRunId:runId};
 const load={...f.load,run:(id:string)=>id===runId?f.current:f.load.run(id)};
 let result=await collectRunLineageEvidence(later,load);assert.equal(result.status,'verified',JSON.stringify(result.issues));assert.equal(result.tests[0].sourceRunId,childId);assert.equal(result.tests[0].attemptId,'a2');
 f.current.events=f.current.events.filter((e:any)=>e.type!=='step/evidence-inherited');
 result=await collectRunLineageEvidence(later,load);assert.equal(result.tests.length,0);assert.equal(result.status,'partial');
});
test('explicit resource approval preserves exact inherited QA evidence across ordinary later recovery',async()=>{
 const f=resourceFixture();
 const result=await collectRunLineageEvidence(f.current,f.load);assert.equal(result.status,'verified');assert.equal(result.tests.length,1);
 const later={...f.current,id:'66666666-6666-4666-8666-666666666666',snapshot:structuredClone(f.current.snapshot)};
 later.snapshot.recovery.sourceRunId=runId;
 const next=await collectRunLineageEvidence(later,{...f.load,run:id=>id===runId?f.current:f.load.run(id)});
 assert.equal(next.status,'verified');assert.equal(next.tests[0].sourceRunId,childId);
});
test('a resource boundary cannot authorize changed goal, completed contract or counterfeit parent',async()=>{
 for(const mutate of [(f:any)=>{f.current.snapshot.tasks[0].objective='Changed completed work';f.current.snapshot.approvedTasks=structuredClone(f.current.snapshot.tasks);},
   (f:any)=>{f.current.snapshot.agents[0].tools=['terminal'];},
   (f:any)=>{f.current.snapshot.resourceApproval.sourceRunId=parentId;},
   (f:any)=>{f.current.snapshot.resourceApproval.sourceGoalContract={format:'approved-goal-v1',sha256:'a'.repeat(64)};},
   (f:any)=>{f.current.snapshot.resourceRevision=2;}]){
  const f=resourceFixture();mutate(f);f.current.snapshot.goalContract=createGoalContract(f.current.snapshot);
  const result=await collectRunLineageEvidence(f.current,f.load);assert.equal(result.status,'unavailable');assert.equal(result.tests.length,0);
 }
});

test('repeated recovery resolves exact ancestor seals and real QA operation without reading model context into the response',async()=>{
 const f=fixture(),before=JSON.stringify([f.current,f.parent,f.child,f.operation]);
 f.parent.events.push(event(4,'model/request',{secretContext:'PRIVATE MODEL PROMPT'}));
 const evidence=await collectRunLineageEvidence(f.current,f.load);
 assert.equal(evidence.status,'verified');assert.equal(evidence.receipts.length,2);assert.equal(evidence.tests.length,1);
 assert.deepEqual(evidence.receipts.map(row=>row.sourceRunId),[parentId,childId]);assert.equal(evidence.receipts[0].acceptanceSeq,2);
 assert.equal(evidence.tests[0].output,output);assert.equal(evidence.tests[0].operationId,operationId);assert.equal(evidence.tests[0].nodeTests.pass,2);
 assert.doesNotMatch(JSON.stringify(evidence),/PRIVATE MODEL PROMPT|untrusted source summary/);
 f.parent.events.pop();assert.equal(JSON.stringify([f.current,f.parent,f.child,f.operation]),before);
});

test('cross-project/version/contract, corrupt, missing and cyclic ancestry fail closed before operation queries',async()=>{
 for(const mutate of [(f:any)=>{f.parent.snapshot={...f.parent.snapshot,projectId:'foreign'};},(f:any)=>{f.child.snapshot={...f.child.snapshot,planVersion:13};},
  (f:any)=>{f.parent.integrity='incomplete';},(f:any)=>{f.child.snapshot.recovery.sourceRunId=runId;},(f:any)=>{f.child.snapshot.recovery.sourceRunId='not-an-id';},
  (f:any)=>{f.parent.snapshot.tasks=[];},(f:any)=>{f.load.run=()=>null;},(f:any)=>{f.current.integrity='incomplete';}]){
  const f=fixture();mutate(f);let operations=0;f.load.operations=async()=>{operations++;return [];};
  const result=await collectRunLineageEvidence(f.current,f.load);assert.equal(result.status,'unavailable');assert.deepEqual(result.receipts,[]);assert.deepEqual(result.tests,[]);assert.equal(operations,0);
 }
});

test('ancestry has an explicit maximum depth',async()=>{
 const f=fixture();let count=0;
 const result=await collectRunLineageEvidence(f.current,{...f.load,run:id=>{count++;return {id,integrity:'ok',snapshot:{...f.parent.snapshot,recovery:{version:1,sourceRunId:`${String(count+10).padStart(8,'0')}-1111-4111-8111-111111111111`}},events:[]};}});
 assert.equal(result.status,'unavailable');assert.equal(count,16);assert.equal(result.receipts.length,0);
});

test('every inherited hop must preserve exact completed attempt, accepted file inventory and original committed seal',async()=>{
 for(const mutate of [(f:any)=>{f.child.snapshot.recovery.completed[0].attemptId='wrong';},(f:any)=>{f.current.snapshot.recovery.files[0].sha256=sha('changed');},
  (f:any)=>{f.current.snapshot.recovery.files[0].state='unverified';},(f:any)=>{f.parent.events[1].data=structuredClone(f.t1);f.parent.events[1].data.outputs=[];},
  (f:any)=>{f.parent.events[2].data.tasks[0].status='in_progress';},(f:any)=>{f.parent.events.push(event(4,'handoff/accepted',f.t1));},
  (f:any)=>{f.current.snapshot.handoffCheckpoints[0]={...f.t1,runId:'55555555-5555-4555-8555-555555555555'};},
  (f:any)=>{f.current.snapshot.recovery.completed.push(f.current.snapshot.recovery.completed[0]);}]){
  const f=fixture();mutate(f);const result=await collectRunLineageEvidence(f.current,f.load);
  assert.notEqual(result.status,'verified');assert.equal(result.receipts.some(row=>row.taskId==='T1'),false);
 }
});

test('QA output requires matching actual operation, approval/call/session/attempt, complete bytes and host observation',async()=>{
 for(const mutate of [(f:any)=>{f.operation.runId=parentId;},(f:any)=>{f.operation.status='cancelled';},(f:any)=>{f.operation.started=false;},
  (f:any)=>{f.operation.payload.context.approvalId='other';},(f:any)=>{f.operation.payload.context.callId='other';},(f:any)=>{f.operation.payload.context.sessionId='other';},
  (f:any)=>{f.operation.payload.context.attemptId='other';},(f:any)=>{f.operation.payload.context.agentId='other';},(f:any)=>{f.operation.result.ok=false;},
  (f:any)=>{f.operation.result.result.output+='unverified appended bytes';},(f:any)=>{f.operation.result.result.outputTruncated=true;},
  (f:any)=>{f.child.events[2].data={...f.child.events[2].data,approvalId:'other'};},(f:any)=>{f.child.events[3].data={...f.child.events[3].data,exitCode:1};},
  (f:any)=>{f.load.operations=async()=>[];}]){
  const f=fixture();mutate(f);const result=await collectRunLineageEvidence(f.current,f.load);
  assert.equal(result.status,'partial');assert.equal(result.receipts.length,2,'valid file seals remain separate from an unavailable test output');assert.deepEqual(result.tests,[]);
  assert.equal(result.issues.at(-1)?.code,'COMMAND_UNAVAILABLE');
 }
});

test('source-only summaries and unlinked commands cannot manufacture a test card',async()=>{
 const f=fixture();f.current.snapshot.recovery.nodes.T2.commands=[{command:'node --test test.mjs',exitCode:0,output:'2/2 pass'}];
 f.current.snapshot.handoffCheckpoints=f.current.snapshot.handoffCheckpoints.filter((entry:any)=>entry.taskId!=='T2');
 const result=await collectRunLineageEvidence(f.current,f.load);assert.equal(result.status,'partial');assert.deepEqual(result.tests,[]);
});

test('QA must have executed the exact workspace revision sealed by the original host',async()=>{
 for(const revision of [undefined,sha('different workspace')]){
  const f=fixture();f.operation.payload.arguments.expectedWorkspaceRevision=revision;
  const result=await collectRunLineageEvidence(f.current,f.load);
  assert.equal(result.status,'partial');assert.equal(result.receipts.length,2);assert.deepEqual(result.tests,[]);
  assert.equal(result.issues.at(-1)?.code,'COMMAND_UNAVAILABLE');
  const html=renderToStaticMarkup(createElement(RunInheritedEvidence,{runId,snapshot:f.current.snapshot,evidence:result,taskName:(id:string)=>id}));
  assert.doesNotMatch(html,/恢复沿用的真实测试结果|测试通过/);
 }
});

test('web evidence visibly names original run/attempt/observation and does not pretend inherited QA ran again',async()=>{
 const f=fixture(),evidence=await collectRunLineageEvidence(f.current,f.load);
 const props={runId,snapshot:f.current.snapshot,evidence,taskName:(id:string)=>id};
 const html=renderToStaticMarkup(createElement(RunInheritedEvidence,props));
 assert.match(html,/恢复沿用的真实测试结果/);assert.match(html,/2\/2 测试通过/);assert.match(html,/恢复后未重跑/);
 assert.ok(html.includes('#run/'+parentId)&&html.includes('#run/'+childId));assert.match(html,/命令观察 #4/);assert.ok(html.includes(operationId));
 assert.doesNotMatch(html,/untrusted source summary/);
 const wrong=renderToStaticMarkup(createElement(RunInheritedEvidence,{...props,evidence:{...evidence,runId:parentId}}));
 assert.doesNotMatch(wrong,/恢复沿用的真实测试结果|输出 SHA256/);
 const absent=renderToStaticMarkup(createElement(RunInheritedEvidence,{...props,evidence:undefined,error:'原档案缺失'}));
 assert.match(absent,/原档案缺失/);assert.doesNotMatch(absent,/测试通过/);
});

test('recovery-derived repair report binding preserves the original accepted report',async()=>{
 const make=()=>{
  const f=fixture();
  const approved={...contracts[0],acceptanceCriteria:['原要求'],handoff:{sections:[{key:'evidence',requirement:'核对依据'}]}};
  const effective={...approved,acceptanceCriteria:['修复后核对要求'],reworkRound:1};
  const report=createHandoffReport(effective,{output:JSON.stringify({summary:'独立核对通过',sections:{evidence:'修复后的实际文件'},risks:[]}),acceptanceResults:[{criterion:'修复后核对要求',status:'passed',evidence:'真实文件'}]});
  const original={...f.t1,employeeReport:report};
  const restored={...original,reportContract:{task:effective,approvedSha256:handoffContractDigest(approved)}};
  for(const r of [f.parent,f.child,f.current]){
   r.snapshot=structuredClone(r.snapshot);r.snapshot.tasks[0]=approved;
   if(r.snapshot.approvedTasks)r.snapshot.approvedTasks[0]=approved;
   if(r.snapshot.handoffCheckpoints)r.snapshot.handoffCheckpoints[0]=structuredClone(restored);
  }
  f.parent.events[1].data=original;
  return f;
 };
 const f=make(),result=await collectRunLineageEvidence(f.current,f.load);
 assert.equal(result.status,'verified');
 assert.deepEqual(result.receipts[0].receipt.reportContract,f.current.snapshot.handoffCheckpoints[0].reportContract);
 for(const mutate of [(r:any)=>r.reportContract.approvedSha256='bad',(r:any)=>r.reportContract.task.acceptanceCriteria=['篡改要求'],(r:any)=>r.employeeReport.summary='篡改报告']){
  const changed=make();mutate(changed.current.snapshot.handoffCheckpoints[0]);
  const evidence=await collectRunLineageEvidence(changed.current,changed.load);
  assert.equal(evidence.receipts.some(r=>r.taskId==='T1'),false);
 }
});
