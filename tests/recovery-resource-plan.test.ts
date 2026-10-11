import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalContract, assertGoalContract } from '../packages/contracts/goal-contract.mjs';
import { applyRecoveryResources, recoveryResourceProposalSchema, recoveryTaskMinimumBudget, verifiedResourceEdge } from '../apps/api/src/recovery-resource-plan.ts';
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
