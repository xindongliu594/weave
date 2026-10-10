import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalContract, assertGoalContract } from '../packages/contracts/goal-contract.mjs';
import { applyRecoveryResources, recoveryResourceProposalSchema } from '../apps/api/src/recovery-resource-plan.ts';

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
