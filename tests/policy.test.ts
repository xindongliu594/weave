import {toolEvidence} from './model-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchema, validatePlan, type Plan, type Model, type Policy } from '../packages/contracts/index.ts';
const model: Model = { id: 'model', name: 'Test', gatewayId: 'gateway', model: 'model', inputRate: 1, outputRate: 2, version: 1, status: 'available',capabilities:toolEvidence };
const policy: Policy = { maxBudget: 1, maxAgents: 2, maxConcurrentAgents: 2, deadlineSeconds: 600 };
const base: Plan = { rationale: '测试方案', agents: [{ id: 'manager', name: '经理', role: 'manager', title: '经理', instructions: '协调', modelId: 'model', tools: ['artifact_write'] }], tasks: [{ id: 'a', subject: '实现', objective: '完成需求', assigneeId: 'manager', dependencies: [], acceptanceCriteria: ['通过测试'], estimatedInputTokens: 1000, estimatedOutputTokens: 1000 }] };
test('single manager is a valid one-agent department', () => { assert.equal(validatePlan(base, policy, [model]).valid, true); });
test('team protocol capability is required even without workspace tools and for fallback models',()=>{
 const plan=structuredClone(base);plan.agents[0].tools=[];
 assert.equal(validatePlan(plan,policy,[{...model,capabilities:{}}]).valid,false);
 assert.equal(validatePlan(plan,policy,[{...model,capabilities:{}}],false).valid,true,'a draft can be planned before execution readiness');
 plan.agents[0].fallbackModelId='fallback';
 assert.equal(validatePlan(plan,policy,[model,{...model,id:'fallback',capabilities:{}}]).valid,false);
 assert.equal(validatePlan(plan,policy,[model,{...model,id:'fallback'}]).valid,true);
});
test('cyclic dependencies and missing owners are rejected', () => {
  const plan = structuredClone(base); plan.tasks[0].dependencies = ['b']; plan.tasks.push({ ...plan.tasks[0], id: 'b', dependencies: ['a'] });
  assert.equal(validatePlan(plan, policy, [model]).checks.find(c => c.label === '任务依赖无环')?.pass, false);
  plan.tasks[0].assigneeId = 'invented'; assert.equal(validatePlan(plan, policy, [model]).valid, false);
});
test('unknown model, excessive concurrency and cost cannot pass validation', () => {
  assert.equal(validatePlan(base, policy, []).valid, false);
  assert.equal(validatePlan(base, { ...policy, maxConcurrentAgents: 3 }, [model]).valid, false);
  assert.equal(validatePlan(base, { ...policy, maxBudget: .001 }, [model]).valid, false);
});
test('manager count, duplicate agent IDs and empty acceptance are rejected', () => {
  const plan = structuredClone(base); plan.agents.push({ ...plan.agents[0] });
  assert.equal(validatePlan(plan, policy, [model]).valid, false);
  plan.tasks[0].acceptanceCriteria = []; assert.equal(planSchema.safeParse(plan).success, false);
});
test('task estimates and task turn limits must fit the approved policy',()=>{
  const plan=structuredClone(base);plan.tasks[0].maxBudget=.001;plan.tasks[0].maxModelCalls=41;
  const invalid=validatePlan(plan,policy,[model]);
  assert.equal(invalid.checks.find(c=>c.label==='任务费用上限')?.pass,false);
  assert.equal(invalid.checks.find(c=>c.label==='员工每任务调用上限')?.pass,false);
  plan.tasks[0].maxBudget=.01;plan.tasks[0].maxModelCalls=20;
  assert.equal(validatePlan(plan,policy,[model]).valid,true);
  assert.equal(planSchema.safeParse({...plan,tasks:[{...plan.tasks[0],maxModelCalls:0}]}).success,false);
});
test('run inputs require valid recipients, bounded text, unique IDs and a retrieval grant',()=>{
 const input={id:'brief',title:'资料',content:'本次任务输入',agentIds:['manager']};
 const plan={...structuredClone(base),runInputs:[input],knowledgeDocumentIds:[]};
 assert.equal(planSchema.safeParse(plan).success,true);
 assert.equal(validatePlan(plan,policy,[model]).valid,false);
 plan.agents[0].tools=['knowledge_search'];assert.equal(validatePlan(plan,policy,[model]).valid,true);
 for(const inputs of [[{...input,agentIds:['foreign']}],[input,input],[{...input,content:'binary\0text'}],[{...input,agentIds:[]}],[{...input,content:'x'.repeat(50001)}],Array.from({length:6},(_,i)=>({...input,id:'file'+i,content:'x'.repeat(50000)}))])assert.equal(planSchema.safeParse({...plan,runInputs:inputs}).success,false);
});
