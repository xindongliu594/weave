import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchema, validatePlan, type Plan, type Model, type Policy } from '../packages/contracts/index.ts';
const model: Model = { id: 'model', name: 'Test', gatewayId: 'gateway', model: 'model', inputRate: 1, outputRate: 2, version: 1, status: 'available' };
const policy: Policy = { maxBudget: 1, maxAgents: 2, maxConcurrentAgents: 2, deadlineSeconds: 600 };
const base: Plan = { rationale: '测试方案', agents: [{ id: 'manager', name: '经理', role: 'manager', title: '经理', instructions: '协调', modelId: 'model', tools: ['artifact_write'] }], tasks: [{ id: 'a', subject: '实现', objective: '完成需求', assigneeId: 'manager', dependencies: [], acceptanceCriteria: ['通过测试'], estimatedInputTokens: 1000, estimatedOutputTokens: 1000 }] };
test('single manager is a valid one-agent department', () => { assert.equal(validatePlan(base, policy, [model]).valid, true); });
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
