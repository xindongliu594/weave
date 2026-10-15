import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalContract, assertGoalContract } from '../packages/contracts/goal-contract.mjs';
import { applyRecoveryResources, recoveryResourceProposalSchema, recoveryTaskMinimumBudget, verifiedResourceEdge } from '../apps/api/src/recovery-resource-plan.ts';
import * as resources from '../apps/api/src/recovery-resource-plan.ts';
import { recoveryHistoryBudgetIssues } from '../apps/api/src/recovery-conditions.ts';
const {ExecutionBudget}=await import(new URL('../services/agent-runtime/budget.mjs',import.meta.url).href);

function fixture() {
  const snapshot:any={projectId:'p',planVersion:2,departmentId:'d',requirement:'Keep the original sum goal',
    policy:{maxBudget:.13,maxModelCalls:45,maxTaskModelCalls:16,allowedTools:['terminal_test']},
    agents:[{id:'e',tools:['terminal_test'],knowledgeSpaceIds:['fixed']}],modelRoutes:[{id:'m',configurationHash:'fixed'}],
    tasks:[{id:'develop',maxModelCalls:8,objective:'Original development',acceptanceCriteria:['Original criterion'],outputs:[{path:'sum.mjs'}]},
      {id:'qa',maxModelCalls:7,dependencies:['develop'],acceptanceCriteria:['Independent real QA']},
      {id:'accept',maxModelCalls:6,dependencies:['qa'],objective:'Read only review',acceptanceCriteria:['At least six real tests'],verify:['node --test']}],
    knowledge:{documents:[{version:1,sha256:'fixed'}]}};
  snapshot.goalContract=createGoalContract(snapshot);
  return snapshot;
}
const proposal={maxBudget:.18,taskCallLimits:{accept:10},rationale:'Preserve the completed nodes and fund four further manager calls.'};
const options={newRevision:1,completedTaskIds:['develop','qa'],history:{calls:23,tasks:{accept:{calls:5}}},ceiling:.18};

function outputFixture(){
  const old=fixture();old.policy.maxBudget=1;old.policy.contextBytes=4000;
  old.agents[0].modelId='m';
  old.modelRoutes=[{id:'m',configurationHash:'fixed',inputRate:.3,outputRate:1.2,maxOutputTokens:2048,contextWindowTokens:64000}];
  old.tasks.forEach((t:any)=>{t.assignee='e';t.maxOutputTokens=2048;t.maxBudget=1;});
  old.goalContract=createGoalContract(old);return old;
}
function contextFixture(){
  const old=outputFixture();old.policy.contextBytes=48000;old.modelRoutes[0].contextWindowTokens=131072;
  old.tasks[2].maxBudget=.02;old.goalContract=createGoalContract(old);return old;
}
test('context resources change only the approved new snapshot and price each future request at the new byte limit',()=>{
  const old=contextFixture(),before=structuredClone(old),change={...proposal,maxBudget:1,contextBytes:64000,taskBudgetLimits:{accept:.05}};
  const next=applyRecoveryResources(old,change,{...options,ceiling:1,contextBytes:64000} as any);
  assert.equal(next.policy.contextBytes,64000);assert.deepEqual(old,before);
  assert.deepEqual(next.tasks.slice(0,2),old.tasks.slice(0,2));assert.deepEqual(next.modelRoutes,old.modelRoutes);
  assert.deepEqual(next.knowledge,old.knowledge);assert.deepEqual(next.agents,old.agents);
  const task={...next.tasks[2],maxBudget:0};
  assert.equal(recoveryTaskMinimumBudget(next,task,0,0,13,2),.0439374);
  assert.throws(()=>applyRecoveryResources(old,{...change,taskBudgetLimits:{accept:.02}},{...options,ceiling:1,contextBytes:64000} as any),/完整请求/);
  assert.throws(()=>applyRecoveryResources(old,{...change,taskBudgetLimits:undefined},{...options,ceiling:1,contextBytes:64000} as any),/完整请求/);
});
test('context resources reject missing consent, reductions and routes lacking full input output and guard capacity',()=>{
  const old=contextFixture(),change={...proposal,maxBudget:1,contextBytes:64000,taskBudgetLimits:{accept:.05}},opts={...options,ceiling:1,contextBytes:64000};
  assert.throws(()=>applyRecoveryResources(old,change,{...options,ceiling:1}));
  assert.throws(()=>applyRecoveryResources(old,{...change,contextBytes:65000},opts as any));
  assert.throws(()=>applyRecoveryResources(old,{...change,contextBytes:47999},{...opts,contextBytes:47999} as any));
  for(const route of [{contextBytes:63999},{contextWindowTokens:undefined},{contextWindowTokens:67071},{maxOutputTokens:undefined}]){
    const altered=structuredClone(old);Object.assign(altered.modelRoutes[0],route);altered.goalContract=createGoalContract(altered);
    assert.throws(()=>applyRecoveryResources(altered,change,opts as any),JSON.stringify(route));
  }
  assert.throws(()=>applyRecoveryResources(old,{...proposal,maxBudget:1},opts as any),'an approved adjustment must be explicit in the candidate');
});
test('context consent is sealed through confirmation and lineage while later unadjusted recovery inherits the new limit',async()=>{
  const old=contextFixture(),history={calls:23,tasks:{accept:{calls:5}}},previewId='00000000-0000-4000-8000-000000000001',usageId='00000000-0000-4000-8000-000000000002';
  const change={...proposal,maxBudget:1,contextBytes:64000,taskBudgetLimits:{accept:.2}};
  const preview:any={kind:'run-resource-proposal',sourceRunId:'parent',projectId:'p',projectVersion:2,sourceResourceRevision:0,
    sourceGoalContract:old.goalContract,modelId:'m',usageId,proposal:change,ceiling:1,contextBytes:64000,callRequirementVersion:'handoff-correction-v1',taskContinuationLimits:{accept:2}};
  const db={query:async(sql:string)=>({rows:sql.startsWith('SELECT data')?[{data:preview}]:[{id:usageId}]})};
  const next=await resources.approvedRecoveryResources(db,{id:'parent',project_id:'p',project_version:2,snapshot:old},previewId,['develop','qa'],history);
  assert.equal(next.policy.contextBytes,64000);assert.equal(next.resourceApproval.contextBytes,64000);
  assert.deepEqual(next.resourceApproval.taskCallCeilings,{accept:7});assert.equal(verifiedResourceEdge(next,old,'parent',['develop','qa']),true);
  for(const mutate of [(s:any)=>s.policy.contextBytes=65000,(s:any)=>s.resourceApproval.contextBytes=65000,(s:any)=>delete s.resourceApproval.contextBytes]){
    const forged=structuredClone(next);mutate(forged);forged.goalContract=createGoalContract(forged);
    assert.equal(verifiedResourceEdge(forged,old,'parent',['develop','qa']),false);
  }
  Object.assign(preview,{sourceRunId:'child',sourceResourceRevision:1,sourceGoalContract:next.goalContract,
    proposal:{...proposal,maxBudget:1,taskBudgetLimits:{accept:.2}}});
  delete preview.contextBytes;delete preview.taskContinuationLimits;
  const inherited=await resources.approvedRecoveryResources(db,{id:'child',project_id:'p',project_version:2,snapshot:next},previewId,['develop','qa'],history);
  assert.equal(inherited.policy.contextBytes,64000);assert.equal(inherited.resourceApproval.contextBytes,undefined);
  assert.equal(verifiedResourceEdge(inherited,next,'child',['develop','qa']),true);
  assert.equal(verifiedResourceEdge(structuredClone(next),next,'child',['develop','qa']),true);
});
test('output choices quote the whole next tranche with old fees and leave the approved snapshot unchanged',()=>{
  const old=outputFixture();old.tasks[2].maxBudget=.014;old.goalContract=createGoalContract(old);
  const before=structuredClone(old);
  const quotes=resources.recoveryTaskOutputBudgets(old,old.tasks[2],['develop','qa'],8192,{cost:.006,reserved:0},3);
  assert.deepEqual(quotes.map(q=>q.maxOutputTokens),[2048,8192]);
  for(const [i,expected] of [.0179061,.0400245].entries())assert.ok(Math.abs(quotes[i].minimumBudget-expected)<=1.00001e-8);
  assert.deepEqual(old,before);
  delete old.tasks[0].maxOutputTokens;
  assert.deepEqual(resources.recoveryTaskOutputBudgets(old,old.tasks[2],['develop','qa'],8192,{cost:.006},3),[quotes[0]]);
});
test('output allowance reaches the runtime wire and approved lineage without changing completed tasks',async()=>{
  const old=outputFixture(),before=structuredClone(old);
  const change={...proposal,maxBudget:1,taskOutputLimits:{accept:8192}};
  const opts={...options,ceiling:1,maxTaskOutputTokens:16384};
  const next=applyRecoveryResources(old,change,opts);
  assert.deepEqual(old,before);assert.deepEqual(next.tasks.slice(0,2),old.tasks.slice(0,2));
  assert.equal(next.tasks[2].maxOutputTokens,8192);assert.equal(next.modelRoutes[0].maxOutputTokens,8192);
  assert.deepEqual(next.agents,old.agents);assert.deepEqual(next.knowledge,old.knowledge);
  const {OpenAiCompatibleAdapter}=await import(new URL('../services/agent-runtime/openai-compatible.mjs',import.meta.url).href);
  const route={...next.modelRoutes[0],baseUrl:'https://fixture.invalid/v1',wireModel:'fixture'};
  const adapter=new OpenAiCompatibleAdapter({routes:[route],tasks:next.tasks,maxBudget:1});
  adapter.attribution=()=>({taskId:'accept'});
  const request=adapter.prepareRequest({model:'m',messages:[{role:'user',content:[{type:'text',text:'Check the preserved employee report'}]}]});
  assert.equal(request.body.max_tokens,8192);assert.ok(request.reservation>=8192*1.2/1e6);
  next.resourceApproval={format:'run-resource-approval-v1',revision:1,sourceRunId:'parent',sourceGoalContract:old.goalContract,
    ceiling:1,maxTaskOutputTokens:16384,proposal:change,previewId:'00000000-0000-4000-8000-000000000001',usageId:'00000000-0000-4000-8000-000000000002'};
  next.goalContract=createGoalContract(next);
  assert.equal(verifiedResourceEdge(next,old,'parent',['develop','qa']),true);
  next.tasks[2].maxOutputTokens=16384;next.approvedTasks[2].maxOutputTokens=16384;next.goalContract=createGoalContract(next);
  assert.equal(verifiedResourceEdge(next,old,'parent',['develop','qa']),false);
});
test('output changes reject absent consent, completed tasks, unsupported context and incidental shared-route expansion',()=>{
  const old=outputFixture(),change={...proposal,maxBudget:1,taskOutputLimits:{accept:8192}},opts={...options,ceiling:1,maxTaskOutputTokens:16384};
  assert.throws(()=>applyRecoveryResources(old,change,{...options,ceiling:1}));
  for(const taskOutputLimits of [{accept:32768},{accept:0},{accept:1000},{qa:8192},{unknown:8192}])
    assert.throws(()=>applyRecoveryResources(old,{...change,taskOutputLimits},opts));
  old.modelRoutes[0].contextWindowTokens=8192;old.goalContract=createGoalContract(old);
  assert.throws(()=>applyRecoveryResources(old,change,opts));
  old.modelRoutes[0].contextWindowTokens=64000;delete old.tasks[1].maxOutputTokens;old.goalContract=createGoalContract(old);
  assert.throws(()=>applyRecoveryResources(old,change,{...opts,completedTaskIds:['develop']}),/共享/);
  old.tasks[1].maxOutputTokens=2048;delete old.tasks[2].assignee;old.goalContract=createGoalContract(old);
  assert.throws(()=>applyRecoveryResources(old,change,opts),/输出额度/,'missing task identity must not select an employee with an absent alias');
});
test('larger output must fit retained node money even when money is not changed',()=>{
  const old=outputFixture();old.tasks[2].maxBudget=.014;old.goalContract=createGoalContract(old);
  const opts={...options,ceiling:1,maxTaskOutputTokens:16384,history:{calls:23,tasks:{accept:{calls:5,cost:.006}}}};
  assert.throws(()=>applyRecoveryResources(old,{...proposal,maxBudget:1,taskOutputLimits:{accept:8192}},opts),/完整请求/);
  const next=applyRecoveryResources(old,{...proposal,maxBudget:1,taskOutputLimits:{accept:8192},taskBudgetLimits:{accept:.04}},opts);
  assert.equal(next.tasks[2].maxBudget,.04);
});

test('a completed legacy task keeps its old output cap if review later requests rework',()=>{
  const old=outputFixture();delete old.tasks[0].maxOutputTokens;old.goalContract=createGoalContract(old);
  assert.throws(()=>applyRecoveryResources(old,{...proposal,maxBudget:1,taskOutputLimits:{accept:8192}},
    {...options,ceiling:1,maxTaskOutputTokens:16384}),/共享/);
  assert.equal(old.modelRoutes[0].maxOutputTokens,2048);
});

test('resource approval preserves original semantics, grants and source snapshot',()=>{
  const old=fixture(),before=structuredClone(old);
  const next=applyRecoveryResources(old,proposal,options);
  assert.deepEqual(old,before);
  assert.equal(next.policy.maxBudget,.18);assert.equal(next.tasks[2].maxModelCalls,10);
  assert.equal(next.planVersion,2);assert.deepEqual(next.resourceRevision,1);
  assert.deepEqual(next.agents,old.agents);assert.deepEqual(next.knowledge,old.knowledge);
  assert.deepEqual(next.tasks.slice(0,2),old.tasks.slice(0,2));
  const {maxModelCalls:_,...newTask}=next.tasks[2];const {maxModelCalls:__,...oldTask}=old.tasks[2];
  assert.deepEqual(newTask,oldTask);assert.deepEqual(next.approvedTasks,next.tasks);
  assert.equal(assertGoalContract(next),true);assert.notEqual(next.goalContract.sha256,old.goalContract.sha256);
});
test('resource proposal rejects semantic fields and invalid or completed task changes',()=>{
  assert.equal(recoveryResourceProposalSchema.safeParse({...proposal,requirement:'Rewrite goal'}).success,false);
  for(const changed of [{...proposal,maxBudget:.19},{...proposal,maxBudget:.12},
    {...proposal,taskCallLimits:{qa:10}},{...proposal,taskCallLimits:{unknown:10}},
    {...proposal,taskCallLimits:{accept:4}},{...proposal,taskCallLimits:{accept:17}}])
    assert.throws(()=>applyRecoveryResources(fixture(),changed,options));
});
test('new version and inherited lineage must be trustworthy and bound to approved seal',()=>{
  assert.throws(()=>applyRecoveryResources(fixture(),proposal,{...options,newRevision:5}));
  const old=fixture();old.tasks[0].acceptanceCriteria=['Lowered requirement'];
  assert.throws(()=>applyRecoveryResources(old,proposal,options),/GOAL_CONTRACT_CHANGED/);
  const next=applyRecoveryResources(fixture(),proposal,options);next.resourceRevision=0;
  assert.throws(()=>assertGoalContract(next),/GOAL_CONTRACT_CHANGED/);
});
test('subsequent resource approval retains each ancestor once',()=>{
  const first=applyRecoveryResources(fixture(),proposal,options);
  const second=applyRecoveryResources(first,{...proposal,maxBudget:.20,taskCallLimits:{accept:12}},
    {...options,newRevision:2,ceiling:.20});
  assert.deepEqual(second.resourceRevision,2);
});

test('unfinished node money can be reallocated under the original project ceiling without resetting spend',()=>{
  const old=fixture();old.policy.maxBudget=.15;
  old.tasks.forEach((task:any,i:number)=>{task.maxBudget=[.05,.03,.025][i]});
  old.goalContract=createGoalContract(old);
  const change={maxBudget:.15,taskCallLimits:{accept:10},taskBudgetLimits:{accept:.045},rationale:'Project funds remain; manager needs complete request reservations.'};
  const prior={calls:18,tasks:{accept:{calls:4,cost:.0133923,reserved:0}}};
  const next=applyRecoveryResources(old,change,{...options,history:prior,ceiling:.15});
  assert.equal(next.policy.maxBudget,.15);assert.equal(next.tasks[2].maxBudget,.045);
  assert.deepEqual(next.tasks.slice(0,2),old.tasks.slice(0,2));assert.equal(old.tasks[2].maxBudget,.025);
  const engine=new ExecutionBudget({maxBudget:.0749562,priorSpend:.0750438,tasks:next.tasks,taskUsage:prior.tasks});
  assert.equal(engine.tasks.get('accept').spent,.0133923);
  assert.ok(engine.tasks.get('accept').limit-engine.tasks.get('accept').spent>.0118503);
  assert.equal(assertGoalContract(next),true);
  next.resourceApproval={format:'run-resource-approval-v1',revision:1,sourceRunId:'parent',sourceGoalContract:old.goalContract,
    ceiling:.15,proposal:change,previewId:'00000000-0000-4000-8000-000000000001',usageId:'00000000-0000-4000-8000-000000000002'};
  next.goalContract=createGoalContract(next);
  assert.equal(verifiedResourceEdge(next,old,'parent',['develop','qa']),true);
  next.tasks[2].maxBudget=.046;next.approvedTasks[2].maxBudget=.046;next.goalContract=createGoalContract(next);
  assert.equal(verifiedResourceEdge(next,old,'parent',['develop','qa']),false,'a fresh goal hash alone cannot authorize an unapproved node cap');
});

test('node money changes cannot alter completed tasks, lower caps, exceed the project or discard holds',()=>{
  const old=fixture();old.tasks[2].maxBudget=.025;old.goalContract=createGoalContract(old);
  for(const taskBudgetLimits of [{qa:.05},{unknown:.05},{accept:.02},{accept:.19},{accept:NaN},{accept:0}])
    assert.throws(()=>applyRecoveryResources(old,{...proposal,taskBudgetLimits},options));
  assert.throws(()=>applyRecoveryResources(old,{...proposal,taskBudgetLimits:{accept:.03}},
    {...options,history:{calls:23,tasks:{accept:{calls:5,cost:.02,reserved:.011}}}}));
});

test('a money proposal must fund a complete bounded request after retained task spend',()=>{
  const old=fixture();old.policy.maxBudget=.15;old.policy.contextBytes=48000;
  old.agents[0].modelId='m';old.modelRoutes[0]={id:'m',inputRate:.3,outputRate:1.2,maxOutputTokens:2048};
  old.tasks[2].assignee='e';old.tasks[2].maxBudget=.05;old.tasks[2].maxOutputTokens=2048;
  old.goalContract=createGoalContract(old);
  const history={calls:21,tasks:{accept:{calls:11,cost:.0384369,reserved:.001}}};
  const change={maxBudget:.20,taskCallLimits:{accept:16},taskBudgetLimits:{accept:.05},rationale:'Keep the old ledger and fund unfinished review'};
  assert.throws(()=>applyRecoveryResources(old,change,{...options,history,ceiling:.20}),/完整请求/);
  const next=applyRecoveryResources(old,{...change,taskBudgetLimits:{accept:.06}},{...options,history,ceiling:.20});
  assert.equal(next.tasks[2].maxBudget,.06);assert.equal(next.policy.maxBudget,.20);
  assert.equal(old.tasks[2].maxBudget,.05);assert.equal(history.tasks.accept.cost,.0384369);
});

test('the request floor includes archived wire schemas and envelope fields, beyond the message cap',()=>{
  const old=fixture();old.policy.contextBytes=48000;
  old.agents[0].modelId='m';old.modelRoutes[0]={id:'m',inputRate:.3,outputRate:1.2,maxOutputTokens:2048};
  old.tasks[2].assignee='e';old.tasks[2].maxBudget=.05;old.tasks[2].maxOutputTokens=2048;
  old.goalContract=createGoalContract(old);
  const history={calls:21,tasks:{accept:{calls:11,cost:.0384369,requestOverheadBytes:12000}}};
  const change={maxBudget:.20,taskCallLimits:{accept:16},taskBudgetLimits:{accept:.057},rationale:'Retain tool schemas and used budget'};
  assert.throws(()=>applyRecoveryResources(old,change,{...options,history,ceiling:.20}),/完整请求/);
  assert.equal(applyRecoveryResources(old,{...change,taskBudgetLimits:{accept:.06}},{...options,history,ceiling:.20}).tasks[2].maxBudget,.06);
});

test('runtime employee identity takes precedence over source aliases and absent IDs never match',()=>{
  const snapshot:any={policy:{contextBytes:48000,maxBudget:.001},
    agents:[{id:'alias',employeeId:'source',modelId:'cheap'},{id:'runtime',employeeId:'source',modelId:'expensive'}],
    modelRoutes:[{id:'cheap',inputRate:.01,outputRate:.01,maxOutputTokens:2048},
      {id:'expensive',inputRate:1,outputRate:2,maxOutputTokens:2048}]};
  assert.equal(recoveryTaskMinimumBudget(snapshot,{assignee:'runtime',assigneeId:'source',maxBudget:.001}),.053133);
  assert.equal(recoveryTaskMinimumBudget(snapshot,{assigneeId:'runtime',maxBudget:.001}),.053133);
  assert.equal(recoveryTaskMinimumBudget(snapshot,{maxBudget:.001}),.001);
});

test('planning funds the next bounded tranche rather than only the first resumed request',()=>{
  const snapshot:any={policy:{contextBytes:48000,maxBudget:.20},agents:[{id:'e',modelId:'m'}],
    modelRoutes:[{id:'m',inputRate:.3,outputRate:1.2,maxOutputTokens:2048}]};
  const task={assignee:'e',maxBudget:.0576924,maxOutputTokens:2048};
  const floor=recoveryTaskMinimumBudget(snapshot,task,.0467031,0,6969,3);
  assert.ok(floor>=.1044696&&floor<=.10446961);
  const single=recoveryTaskMinimumBudget(snapshot,task,.0467031,0,6969);
  assert.ok(single>=.0659586&&single<=.06595861);
});

test('explicit call ceilings extend only unfinished resources and keep every historical attempt',()=>{
  const old=fixture();old.policy.maxModelCalls=32;old.tasks[2].maxModelCalls=16;old.goalContract=createGoalContract(old);
  const change={...proposal,maxModelCalls:48,taskCallLimits:{accept:22}};
  const history={calls:28,tasks:{accept:{calls:16,cost:.01}}};
  assert.throws(()=>applyRecoveryResources(old,change,{...options,history}));
  const ceilings={maxModelCalls:48,maxTaskModelCalls:24};
  const next=applyRecoveryResources(old,change,{...options,history,callCeilings:ceilings});
  assert.equal(next.policy.maxModelCalls,48);assert.equal(next.policy.maxTaskModelCalls,22);assert.equal(next.tasks[2].maxModelCalls,22);
  assert.equal(history.calls,28);assert.equal(history.tasks.accept.calls,16);assert.deepEqual(next.tasks.slice(0,2),old.tasks.slice(0,2));
  for(const invalid of [{...change,maxModelCalls:49},{...change,maxModelCalls:31},{...change,taskCallLimits:{accept:25}},
    {...change,taskCallLimits:{qa:22}}])assert.throws(()=>applyRecoveryResources(old,invalid,{...options,history,callCeilings:ceilings}));
  next.resourceApproval={format:'run-resource-approval-v1',revision:1,sourceRunId:'parent',sourceGoalContract:old.goalContract,
    ceiling:.18,callCeilings:ceilings,proposal:change,previewId:'00000000-0000-4000-8000-000000000001',usageId:'00000000-0000-4000-8000-000000000002'};
  next.goalContract=createGoalContract(next);
  assert.equal(verifiedResourceEdge(next,old,'parent',['develop','qa']),true);
  next.resourceApproval.callCeilings.maxTaskModelCalls=16;next.goalContract=createGoalContract(next);
  assert.equal(verifiedResourceEdge(next,old,'parent',['develop','qa']),false);
});

const correctionVersion='handoff-correction-v1';
async function confirmedTranche(extra:Record<string,unknown>={taskContinuationLimits:{qa:4,accept:7}}){
 const old=outputFixture();old.policy.maxModelCalls=72;old.policy.maxTaskModelCalls=45;
 old.tasks[1].maxModelCalls=45;old.tasks[2].maxModelCalls=45;old.goalContract=createGoalContract(old);
 const history={calls:60,tasks:{qa:{calls:44,cost:0},accept:{calls:0,cost:0}}};
 const change={maxBudget:1,maxModelCalls:72,taskCallLimits:{qa:48,accept:45},taskBudgetLimits:{qa:1,accept:1},rationale:'An explicitly bounded next recovery tranche'};
 const previewId='00000000-0000-4000-8000-000000000001',usageId='00000000-0000-4000-8000-000000000002';
 const preview={kind:'run-resource-proposal',sourceRunId:'parent',projectId:'p',projectVersion:2,
  sourceResourceRevision:0,sourceGoalContract:old.goalContract,modelId:'m',usageId,proposal:change,ceiling:1,
  callCeilings:{maxModelCalls:72,maxTaskModelCalls:48},callRequirementVersion:correctionVersion,...extra};
 const db={query:async(sql:string)=>{if(sql.startsWith('SELECT data FROM organization_previews'))return {rows:[{data:preview}]};
  assert.match(sql,/SELECT id FROM usage/);return {rows:[{id:usageId}]};}};
 const before=structuredClone(old),next=await resources.approvedRecoveryResources(db,{id:'parent',project_id:'p',project_version:2,snapshot:old},previewId,['develop'],history);
 assert.deepEqual(old,before);return {old,next,history};
}
test('resource confirmation seals the next absolute call ceilings without lowering original task contracts',async()=>{
 const {old,next}=await confirmedTranche();
 assert.deepEqual(next.resourceApproval.taskCallCeilings,{qa:48,accept:7});
 assert.equal(next.tasks[2].maxModelCalls,45);assert.equal(next.tasks[1].maxModelCalls,48);
 assert.equal(verifiedResourceEdge(next,old,'parent',['develop']),true);
 const before=structuredClone(next),history={calls:70,callsBasis:'durable-admissions-and-archived-wire-requests' as const,
  tasks:{qa:{calls:48,cost:0},accept:{calls:6,cost:0}}};
 assert.deepEqual(recoveryHistoryBudgetIssues(next,history,new Set(['develop','qa'])),[]);
 history.tasks.accept.calls=7;history.calls=71;
 assert.equal(recoveryHistoryBudgetIssues(next,history,new Set(['develop','qa']))[0].taskId,'accept');
 assert.deepEqual(next,before,'ordinary recovery checks cannot reset the sealed tranche');
 const legacy=structuredClone(next);delete legacy.resourceApproval.taskCallCeilings;legacy.goalContract=createGoalContract(legacy);
 assert.deepEqual(recoveryHistoryBudgetIssues(legacy,history,new Set(['develop','qa'])),[]);
 assert.equal(verifiedResourceEdge(legacy,old,'parent',['develop']),true);
 const unbounded=await confirmedTranche({});assert.equal(unbounded.next.resourceApproval.taskCallCeilings,undefined,
  'a minimum planning estimate is not an implicit maximum for every recovery');
});
test('explicit continuation allowance rejects missing tasks, insufficient tranches and excessive cumulative grants',async()=>{
 for(const taskContinuationLimits of [null,[],{}, {qa:4},{qa:4,accept:0},{qa:4,accept:1},{qa:5,accept:7},{qa:4,accept:9},
  {qa:4,accept:7,develop:1},{qa:4,accept:7,unknown:1}])
  await assert.rejects(confirmedTranche({taskContinuationLimits}));
});
test('explicit shorter continuation bounds both the sealed allowance and its work-plus-correction fee floor',async()=>{
 const {old,history,next}=await confirmedTranche({taskContinuationLimits:{qa:4,accept:4}});
 assert.deepEqual(next.resourceApproval.taskCallCeilings,{qa:48,accept:4});
 old.tasks[1].maxBudget=.014;old.tasks[2].maxBudget=.014;old.goalContract=createGoalContract(old);
 const ceilings={maxModelCalls:72,maxTaskModelCalls:48},limits={qa:4,accept:4};
 const requirement=resources.recoveryCallRequirements(old,history,['develop'],ceilings,limits);
 assert.equal(requirement.tasks.accept.nextRequestCount,4);assert.equal(requirement.tasks.accept.handoffCorrectionRequests,1);
 assert.equal(requirement.tasks.accept.workRequests,3);
 const change={maxBudget:1,maxModelCalls:72,taskCallLimits:{qa:48,accept:45},taskBudgetLimits:{qa:.02,accept:.02},rationale:'Only four explicitly authorized requests per remaining node'};
 assert.doesNotThrow(()=>applyRecoveryResources(old,change,{newRevision:1,completedTaskIds:['develop'],history,ceiling:1,callCeilings:ceilings,
  callRequirementVersion:correctionVersion,taskContinuationLimits:limits}));
 const floor=resources.recoveryMinimumProjectBudget(old,history,['develop'],ceilings,{recordedCost:0,reserved:0},limits);
 assert.ok(Math.abs(floor-.0317496)<=1.00001e-8);
});
test('a new resource confirmation without an explicit continuation grant preserves the prior sealed ceiling',async()=>{
 const {next,history}=await confirmedTranche(),previewId='00000000-0000-4000-8000-000000000003';
 const approval=next.resourceApproval;
 const preview={kind:'run-resource-proposal',sourceRunId:'child',projectId:'p',projectVersion:2,sourceResourceRevision:1,
  sourceGoalContract:next.goalContract,modelId:'m',usageId:approval.usageId,proposal:approval.proposal,ceiling:1,
  callCeilings:approval.callCeilings,callRequirementVersion:correctionVersion};
 const db={query:async(sql:string)=>({rows:sql.startsWith('SELECT data')?[{data:preview}]:[{id:approval.usageId}]})};
 const child=await resources.approvedRecoveryResources(db,{id:'child',project_id:'p',project_version:2,snapshot:next},previewId,['develop'],history);
 assert.deepEqual(child.resourceApproval.taskCallCeilings,{qa:48,accept:7});
 assert.equal(verifiedResourceEdge(child,next,'child',['develop']),true);
 delete child.resourceApproval.taskCallCeilings;child.goalContract=createGoalContract(child);
 assert.equal(verifiedResourceEdge(child,next,'child',['develop']),false,'a new resource edge cannot silently discard an earlier bounded grant');
});
test('a new unfinished-task grant retains completed-task ceilings across later rework',async()=>{
 const {next}=await confirmedTranche(),previewId='00000000-0000-4000-8000-000000000003',approval=next.resourceApproval;
 const history={calls:65,tasks:{qa:{calls:48},accept:{calls:1}}},done=['develop','qa'];
 const preview={kind:'run-resource-proposal',sourceRunId:'child',projectId:'p',projectVersion:2,sourceResourceRevision:1,
  sourceGoalContract:next.goalContract,modelId:'m',usageId:approval.usageId,ceiling:1,callCeilings:approval.callCeilings,
  callRequirementVersion:correctionVersion,taskContinuationLimits:{accept:7},
  proposal:{...approval.proposal,taskCallLimits:{accept:45},taskBudgetLimits:{accept:1}}};
 const db={query:async(sql:string)=>({rows:sql.startsWith('SELECT data')?[{data:preview}]:[{id:approval.usageId}]})};
 const before=structuredClone(next),child=await resources.approvedRecoveryResources(db,
  {id:'child',project_id:'p',project_version:2,snapshot:next},previewId,done,history);
 assert.deepEqual(child.resourceApproval.taskCallCeilings,{qa:48,accept:8});assert.deepEqual(next,before);
 assert.equal(verifiedResourceEdge(child,next,'child',done),true);
 for(const taskCallCeilings of [{accept:8},{qa:47,accept:8},{qa:48,accept:8,develop:8}]){
  const forged=structuredClone(child);forged.resourceApproval.taskCallCeilings=taskCallCeilings;forged.goalContract=createGoalContract(forged);
  assert.equal(verifiedResourceEdge(forged,next,'child',done),false,JSON.stringify(taskCallCeilings));
 }
 const budget=new ExecutionBudget({maxBudget:1,maxModelCalls:72,tasks:child.tasks,
  taskCallCeilings:child.resourceApproval.taskCallCeilings,taskUsage:history.tasks});
 assert.throws(()=>budget.reserve(.001,{taskId:'qa'}),(error:any)=>error.code==='TASK_TURN_LIMIT');
});
test('planning without a new grant respects the sealed remainder and rejects zero or one available request',async()=>{
 const {next}=await confirmedTranche(),before=structuredClone(next),done=['develop','qa'],ceilings={maxModelCalls:80,maxTaskModelCalls:48};
 const history={calls:69,tasks:{qa:{calls:48},accept:{calls:5}}};
 const requirement=resources.recoveryCallRequirements(next,history,done,ceilings);
 assert.equal(requirement.tasks.accept.nextRequestCount,2);assert.equal(requirement.tasks.accept.workRequests,1);
 for(const calls of [6,7])assert.throws(()=>resources.recoveryCallRequirements(next,
  {...history,tasks:{...history.tasks,accept:{calls}}},done,ceilings),(error:any)=>error.code==='RESOURCE_CALLS_INSUFFICIENT');
 const renewal=resources.recoveryCallRequirements(next,{calls:70,tasks:{qa:{calls:48},accept:{calls:6}}},done,ceilings,{accept:4});
 assert.equal(renewal.tasks.accept.nextRequestCount,4,'only an explicit new grant can renew the exhausted tranche');
 assert.deepEqual(next,before);
});
test('cumulative call floors fund the full explicit grant while fee estimates retain the bounded work tranche',()=>{
 const old=fixture(),history={calls:40,tasks:{accept:{calls:3}}},done=['develop','qa'],ceilings={maxModelCalls:80,maxTaskModelCalls:16};
 const requirement=resources.recoveryCallRequirements(old,history,done,ceilings,{accept:10});
 assert.equal(requirement.tasks.accept.nextRequestCount,7);assert.equal(requirement.tasks.accept.minimumCallLimit,13);
 assert.equal(requirement.minimumTotalCalls,50);
 const change={...proposal,maxModelCalls:50,taskCallLimits:{accept:13}};
 const opts={...options,history,callCeilings:ceilings,callRequirementVersion:correctionVersion,taskContinuationLimits:{accept:10}} as const;
 assert.doesNotThrow(()=>applyRecoveryResources(old,change,opts));
 assert.throws(()=>applyRecoveryResources(old,{...change,maxModelCalls:49},opts));
 assert.throws(()=>applyRecoveryResources(old,{...change,taskCallLimits:{accept:12}},opts));
});
test('resource lineage rejects invalid ceiling maps and unsealed edits while accepting a preserved ordinary-resume edge',async()=>{
 const {old,next}=await confirmedTranche();
 for(const taskCallCeilings of [null,[],{}, {qa:48},{qa:48,accept:0},{qa:48,accept:7.5},{qa:49,accept:7},{qa:48,accept:46},
  {qa:48,accept:7,develop:9},{qa:48,accept:7,unknown:1}]){
  const forged=structuredClone(next);forged.resourceApproval.taskCallCeilings=taskCallCeilings;forged.goalContract=createGoalContract(forged);
  assert.equal(verifiedResourceEdge(forged,old,'parent',['develop']),false,JSON.stringify(taskCallCeilings));
 }
 const forged=structuredClone(next);forged.resourceApproval.taskCallCeilings.accept=8;
 assert.equal(verifiedResourceEdge(forged,old,'parent',['develop']),false);
 const resumed=structuredClone(next);resumed.budgetHistory={calls:70,tasks:{accept:{calls:6}}};
 assert.equal(verifiedResourceEdge(resumed,next,'previous-child',['develop','qa']),true);
});
function correctionFixture(){
  const old=fixture();old.policy.maxModelCalls=48;old.policy.maxTaskModelCalls=32;
  old.tasks[1].maxModelCalls=32;old.tasks[2].maxModelCalls=32;old.goalContract=createGoalContract(old);
  return old;
}
function requirements(old:any,history:any,done=['develop'],ceilings={maxModelCalls:64,maxTaskModelCalls:40}){
  assert.equal(typeof (resources as any).recoveryCallRequirements,'function','missing shared handoff-correction requirements');
  return (resources as any).recoveryCallRequirements(old,history,done,ceilings);
}
test('recovery counts six work requests plus one correction for each unfinished task',()=>{
  const old=correctionFixture(),before=structuredClone(old),history={calls:48,tasks:{qa:{calls:32}}};
  const result=requirements(old,history);
  assert.equal(result.tasks.qa.workRequests,6);assert.equal(result.tasks.qa.handoffCorrectionRequests,1);
  assert.equal(result.tasks.qa.nextRequestCount,7);assert.equal(result.tasks.qa.minimumCallLimit,39);
  assert.equal(result.tasks.accept.minimumCallLimit,32);assert.equal(result.minimumTotalCalls,62);
  assert.equal(result.tasks.develop,undefined);assert.deepEqual(old,before);assert.equal(history.tasks.qa.calls,32);
});
test('recovery preserves a correction when only two node calls remain and rejects zero or one',()=>{
  const old=correctionFixture();
  const result=requirements(old,{calls:54,tasks:{qa:{calls:38}}});
  assert.equal(result.tasks.qa.workRequests,1);assert.equal(result.tasks.qa.handoffCorrectionRequests,1);
  assert.equal(result.tasks.qa.minimumCallLimit,40);assert.equal(result.minimumTotalCalls,63);
  for(const calls of [39,40])assert.throws(()=>requirements(old,{calls:54,tasks:{qa:{calls}}}),
    (error:any)=>error.code==='RESOURCE_CALLS_INSUFFICIENT');
});
test('shared project calls must cover all next tranches and malformed history never creates headroom',()=>{
  const old=correctionFixture();
  assert.throws(()=>requirements(old,{calls:51,tasks:{qa:{calls:32}}}),
    (error:any)=>error.code==='RESOURCE_CALLS_INSUFFICIENT');
  for(const history of [{calls:-1,tasks:{}},{calls:1.5,tasks:{}},{calls:48,tasks:{qa:{calls:NaN}}}])
    assert.throws(()=>requirements(old,history));
});
test('versioned confirmation rechecks actual history and rejects an underfunded or omitted next tranche',()=>{
  const old=correctionFixture(),history={calls:48,tasks:{qa:{calls:32}}};
  const change={maxBudget:.18,maxModelCalls:64,taskCallLimits:{qa:39,accept:32},taskBudgetLimits:{qa:.18,accept:.18},rationale:'Keep each correction within existing authorization'};
  const opts={...options,completedTaskIds:['develop'],history,callCeilings:{maxModelCalls:64,maxTaskModelCalls:40},callRequirementVersion:correctionVersion} as any;
  const good=applyRecoveryResources(old,change,opts);assert.equal(good.tasks[1].maxModelCalls,39);
  for(const altered of [{...change,taskCallLimits:{qa:38,accept:32}},{...change,maxModelCalls:61},
    {...change,taskCallLimits:{qa:39}}])assert.throws(()=>applyRecoveryResources(old,altered,opts));
  assert.throws(()=>applyRecoveryResources(old,change,{...opts,history:{calls:49,tasks:{qa:{calls:33}}}}));
});
test('versioned node money must cover work and correction with old spend and holds preserved',()=>{
  const old=correctionFixture();old.policy.maxBudget=1;old.policy.contextBytes=48000;
  old.agents[0].modelId='m';old.modelRoutes[0]={id:'m',inputRate:.3,outputRate:1.2,maxOutputTokens:2048};
  old.tasks[2].assignee='e';old.tasks[2].maxBudget=.05;old.goalContract=createGoalContract(old);
  const history={calls:48,tasks:{accept:{calls:32,cost:.03,reserved:.01,requestOverheadBytes:6969}}};
  const change={maxBudget:1, maxModelCalls:64,taskCallLimits:{accept:39},taskBudgetLimits:{accept:.18},rationale:'Fund the complete correction tranche'};
  const opts={...options,completedTaskIds:['develop','qa'],history,ceiling:1,callCeilings:{maxModelCalls:64,maxTaskModelCalls:40},callRequirementVersion:correctionVersion} as any;
  assert.throws(()=>applyRecoveryResources(old,{...change,taskBudgetLimits:{accept:.06}},opts));
  const next=applyRecoveryResources(old,change,opts);assert.equal(next.tasks[2].maxBudget,.18);
  assert.deepEqual(history.tasks.accept,{calls:32,cost:.03,reserved:.01,requestOverheadBytes:6969});
});
test('unknown requirement versions are rejected while historical approved edges remain verifiable',()=>{
  assert.throws(()=>applyRecoveryResources(fixture(),proposal,{...options,callRequirementVersion:'future-rule'} as any));
  const old=fixture(),next=applyRecoveryResources(old,proposal,options);
  next.resourceApproval={format:'run-resource-approval-v1',revision:1,sourceRunId:'parent',sourceGoalContract:old.goalContract,
    ceiling:.18,proposal,previewId:'00000000-0000-4000-8000-000000000001',usageId:'00000000-0000-4000-8000-000000000002'};
  next.goalContract=createGoalContract(next);
  assert.equal(verifiedResourceEdge(next,old,'parent',['develop','qa']),true);
});
test('shared money floor counts only unfinished next requests and includes project spend and holds',()=>{
  const old=correctionFixture();old.policy.contextBytes=48000;
  old.agents[0].modelId='m';old.modelRoutes[0]={id:'m',inputRate:.3,outputRate:1.2,maxOutputTokens:2048};
  old.tasks[1].assignee='e';old.tasks[2].assignee='e';
  assert.equal(typeof (resources as any).recoveryMinimumProjectBudget,'function');
  const floor=(resources as any).recoveryMinimumProjectBudget(old,{calls:48,tasks:{qa:{calls:32}}},['develop'],
    {maxModelCalls:64,maxTaskModelCalls:40},{recordedCost:.2,reserved:.01});
  const reservation=((48000+13+1024)*.3+2048*1.2)/1e6;
  assert.ok(Math.abs(floor-(.21+14*reservation))<1e-8);
});
