import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runResultView } from '../apps/web/src/run-result-view.ts';
import { RunExtras } from '../apps/web/src/RunExtras.tsx';
import type {RunLineageEvidence} from '../packages/contracts/run-lineage-evidence.ts';

// Native mapping/checkpoint/seal structure mirrors actual completed Go runs;
// these strings are isolated UI fixtures, not employee acceptance evidence.
const runId='ui-fixture-run',managerOutput='经理任务原文：接受，附限制与未验证项。';
const oldReply='captain old reply: t4 claimed; no report produced';
const snapshot={requirement:'UI fixture',projectId:'ui-fixture-project',planVersion:14,policy:{maxBudget:5},
  agents:[{id:'developer',role:'member',name:'开发'},{id:'qa',role:'member',name:'QA'},{id:'manager',role:'manager',name:'经理'}],
  approvedTasks:[{id:'dev',assignee:'developer',subject:'开发',dependencies:[],inputs:[],outputs:[{path:'server.mjs'}]},
    {id:'qa_verify',assignee:'qa',subject:'独立测试',dependencies:['dev'],inputs:[{path:'server.mjs',producerTaskId:'dev'}],outputs:[{path:'acceptance.test.mjs'}]},
    {id:'qa_review',assignee:'qa',subject:'复核',dependencies:['dev','qa_verify'],inputs:[{path:'acceptance.test.mjs',producerTaskId:'qa_verify'}],outputs:[]},
    {id:'manager_accept',assignee:'manager',subject:'经理验收',dependencies:['qa_review'],inputs:[{path:'server.mjs',producerTaskId:'dev'},{path:'acceptance.test.mjs',producerTaskId:'qa_verify'}],outputs:[{path:'acceptance-report.md'}]}]};
const event=(seq:number,type:string,data:any)=>({seq,type,data});
function evidence(){
  return [event(1,'run/task-mapping',{tasks:snapshot.approvedTasks.map((task,index)=>({task_id:'t'+(index+1),seed_id:task.id}))}),
    ...snapshot.approvedTasks.map((task,index)=>event(2+index,'handoff/accepted',{runId,taskId:task.id,attemptId:'attempt-'+task.id,
      inputs:task.inputs.map(file=>({...file,sha256:'a'.repeat(64),size:42})),
      outputs:task.outputs.map(file=>({path:file.path,sha256:'a'.repeat(64),size:42}))})),
    event(7,'team/checkpoint',{tasks:snapshot.approvedTasks.map((task,index)=>({id:'t'+(index+1),status:'completed',attemptId:'attempt-'+task.id,
      output:task.id==='manager_accept'?managerOutput:'Original '+task.id+' output'}))}),
    event(8,'run/finished',{status:'completed',summary:oldReply})];
}
const view=(events=evidence(),status='completed',integrity:string|undefined='ok')=>runResultView(runId,status,integrity,snapshot,events);

test('completed accepted manager output supersedes stale coordinator reply and exposes its exact receipt without rewriting sources',()=>{
  const events=evidence(),before=JSON.stringify([snapshot,events]),result=view(events);
  assert.equal(result.kind,'accepted-manager');assert.equal(result.text,managerOutput);assert.equal(result.originalSummary,oldReply);
  assert.equal(result.acceptanceSeq,5);assert.equal(result.receipt.outputs[0].path,'acceptance-report.md');
  assert.equal(JSON.stringify([snapshot,events]),before);
});

test('every approved node needs complete output and input seals, including exact producer SHA and fixed input bindings',()=>{
  for(const alter of [
    (events:any[])=>{events[1].data.outputs=[];},(events:any[])=>{events[1].data.outputs[0].sha256='invalid';},
    (events:any[])=>{events[1].data.inputs=undefined;},(events:any[])=>{events[2].data.inputs=[];},
    (events:any[])=>{events[2].data.inputs[0].sha256='b'.repeat(64);},(events:any[])=>{events[2].data.inputs[0].producerTaskId='foreign';},
    (events:any[])=>{events[4].data.inputs[0].size=43;},(events:any[])=>{events[3].data.outputs.push({path:'unexpected',sha256:'a'.repeat(64),size:42});},
  ]){const events=evidence();alter(events);assert.equal(view(events).kind,'runtime');}
  const fixed=structuredClone(snapshot);fixed.approvedTasks[0].inputs=[{path:'fixed.txt',sha256:'b'.repeat(64)}] as any;
  const events=evidence();events[1].data.inputs=[{path:'fixed.txt',sha256:'b'.repeat(64),size:42}];
  assert.equal(runResultView(runId,'completed','ok',fixed,events).kind,'accepted-manager');
  events[1].data.inputs[0].sha256='c'.repeat(64);assert.equal(runResultView(runId,'completed','ok',fixed,events).kind,'runtime');
});

test('inherited seals require server-verified ancestry, completed attempt and accepted file inventory',()=>{
  const events=evidence(),seal={...events[1].data,runId:'original-dev-run'};events.splice(1,1);
  const restored={...snapshot,handoffCheckpoints:[seal],recovery:{sourceRunId:'immediate-parent',nodes:{dev:{historyRunId:'original-dev-run'}},
    completed:[{taskId:'dev',attemptId:'attempt-dev'}],files:[{path:'server.mjs',state:'accepted',producerTaskId:'dev',sha256:'a'.repeat(64),size:42}]}};
  const lineage:RunLineageEvidence={version:1,runId,projectId:snapshot.projectId,planVersion:14,sourceRunId:'immediate-parent',status:'verified',
   receipts:[{taskId:'dev',attemptId:'attempt-dev',sourceRunId:'original-dev-run',acceptanceSeq:2,receipt:seal}],tests:[],issues:[]};
  assert.equal(runResultView(runId,'completed','ok',restored,events,[],lineage).kind,'accepted-manager');
  assert.equal(runResultView(runId,'completed','ok',restored,events).kind,'runtime','a local snapshot/history summary alone is not ancestry proof');
  const rewrittenHistory=structuredClone(restored);rewrittenHistory.recovery.nodes.dev.historyRunId='immediate-parent';
  assert.equal(runResultView(runId,'completed','ok',rewrittenHistory,events,[],lineage).kind,'accepted-manager','verified ancestry handles historyRunId rewritten by repeated recovery');
  for(const mutate of [
    (s:any)=>{s.recovery.sourceRunId='foreign-parent';},(s:any)=>{s.recovery.completed[0].attemptId='foreign';},
    (s:any)=>{s.recovery.files[0].sha256='b'.repeat(64);},(s:any)=>{s.recovery.files[0].producerTaskId='qa';},
    (s:any)=>{s.recovery.files[0].state='unverified';},(s:any)=>{s.handoffCheckpoints[0].runId='foreign-run';},
  ]){const copy=structuredClone(restored);mutate(copy);assert.equal(runResultView(runId,'completed','ok',copy,events,[],lineage).kind,'runtime');}
  for(const alter of [(x:any)=>{x.runId='foreign';},(x:any)=>{x.status='unavailable';},(x:any)=>{x.projectId='foreign';},(x:any)=>{x.planVersion=13;},(x:any)=>{x.receipts[0].receipt.outputs=[];}]){
   const copy=structuredClone(lineage);alter(copy);assert.equal(runResultView(runId,'completed','ok',restored,events,[],copy).kind,'runtime');
  }
});

test('failed, interrupted, incomplete or unverified status never becomes an accepted delivery result',()=>{
  for(const status of ['failed','interrupted','cancelled','running','incomplete'])assert.equal(view(evidence(),status).kind,'runtime');
  for(const integrity of ['incomplete','unknown',undefined])assert.equal(runResultView(runId,'completed',integrity,snapshot,evidence()).kind,'runtime');
  const events=evidence();events.at(-1)!.data.status='failed';assert.equal(view(events).kind,'runtime');
});

test('missing or foreign seals, wrong attempt/version, incomplete DAG and absent output hashes retain the raw reply',()=>{
  for(const alter of [
    (events:any[])=>events.splice(4,1),
    (events:any[])=>{events[4].data.runId='foreign-run';},
    (events:any[])=>{events[4].data.attemptId='old-attempt';},
    (events:any[])=>{events[4].data.planVersion=13;},
    (events:any[])=>{events[1].data.attemptId='missing-dev';},
    (events:any[])=>{events[5].data.tasks[1].status='pending';},
    (events:any[])=>{events[4].data.outputs[0].sha256='invalid';},
    (events:any[])=>{events[4].data.outputs=[];},
    (events:any[])=>{events[5].data.tasks[3].output='';},
  ]){const events=evidence();alter(events);assert.equal(view(events).kind,'runtime');assert.equal(view(events).text,oldReply);}
});

test('current paginated mapping and complete summary seals select the actual manager task',()=>{
  const events=evidence(),result=runResultView(runId,'completed','ok',snapshot,events.slice(1),[events[0]]);
  assert.equal(result.kind,'accepted-manager');assert.equal(result.text,managerOutput);
});

test('manager delivery identity is determined by approved assignee and terminal DAG, not prose or fixed task IDs',()=>{
  const other={...snapshot,agents:snapshot.agents.map(agent=>({...agent,role:'member'}))};
  assert.equal(runResultView(runId,'completed','ok',other,evidence()).kind,'runtime');
  const nonterminal={...snapshot,approvedTasks:[...snapshot.approvedTasks,{id:'later',assignee:'qa',dependencies:['manager_accept']}]};
  assert.equal(runResultView(runId,'completed','ok',nonterminal,evidence()).kind,'runtime');
});

test('RunExtras renders the accepted manager result first and folds the untouched coordinator reply into traceable history',()=>{
  let actions=0;
  const html=renderToStaticMarkup(createElement(RunExtras,{id:runId,status:'completed',integrity:'ok',snapshot,events:evidence(),onOpenProject:()=>{actions++;}}));
  assert.match(html,/<h3 class="lower">经理验收结果<\/h3>/);
  assert.match(html,/宿主已核验并接收/);assert.match(html,/acceptance-report\.md · 42 字节 · SHA256/);
  assert.match(html,/<details><summary>查看原始协调回复<\/summary>/);
  assert.ok(html.indexOf(managerOutput)<html.indexOf(oldReply));assert.equal(actions,0);
  const failed=renderToStaticMarkup(createElement(RunExtras,{id:runId,status:'failed',integrity:'ok',snapshot,events:evidence(),onOpenProject:()=>{actions++;}}));
  assert.doesNotMatch(failed,/<h3 class="lower">经理验收结果<\/h3>/);assert.match(failed,/运行原始回复/);
});
