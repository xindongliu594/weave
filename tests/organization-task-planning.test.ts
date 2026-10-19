import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationCandidateSchema } from '../packages/contracts/organization.ts';
import { policySchema, validatePlan, type Model } from '../packages/contracts/index.ts';
import { taskContractErrors } from '../packages/contracts/task-contracts.mjs';
import { organizationPlanningTaskExample, organizationTaskInstructionsFor, organizationTaskPlanningInstructions } from '../apps/api/src/organization-task-planning.ts';
import { plannedAcceptanceErrors } from '../apps/api/src/execution-prompt.ts';

test('the planning example is a legal three-person develop, independent verification, existing-manager review DAG', () => {
  const agents = ['manager', 'developer', 'qa'].map(id => ({ id, role: id === 'manager' ? 'manager' as const : 'member' as const,
    name: id, title: id, instructions: '只按批准合同执行并记录实际验收证据。', modelId: 'route',
    tools: id === 'manager' ? ['filesystem' as const] : ['filesystem' as const, 'artifact_write' as const, 'terminal_test' as const] }));
  const candidate = organizationCandidateSchema.parse({ department: { name: '结构示例', description: '仅验证规划合同，不执行模型或工具。', agents }, rationale: '开发、QA 和已有经理承担三个节点。', tasks: structuredClone(organizationPlanningTaskExample) });
  assert.deepEqual(taskContractErrors(candidate.tasks, candidate.department.agents), []);
  assert.deepEqual(plannedAcceptanceErrors(candidate.tasks), []);
  const policy = policySchema.parse({ maxBudget: 1, maxAgents: 3, maxConcurrentAgents: 1, deadlineSeconds: 300, allowedModelIds: ['route'], allowedTools: ['filesystem', 'artifact_write', 'terminal_test'] });
  const model = { id: 'route', name: 'Synthetic validation only', gatewayId: 'fixture', model: 'fixture', inputRate: .1, outputRate: .2, status: 'available' } as Model;
  const validation = validatePlan({ agents: candidate.department.agents, tasks: candidate.tasks, rationale: candidate.rationale }, policy, [model], false);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const review = candidate.tasks.find(task => task.kind === 'review')!;
  assert.equal(review.assigneeId, 'manager'); assert.equal(candidate.department.agents.length, 3);
  assert.ok(review.dependencies.includes(review.reviewedTaskId!)); assert.ok(review.dependencies.includes('verify'));
  assert.deepEqual(review.outputs, []);
});

test('new executable plans require mappings while text tasks and saved legacy contracts stay compatible',()=>{
  const tasks=structuredClone(organizationPlanningTaskExample);
  for(const task of tasks)delete task.acceptanceChecks;
  assert.equal(plannedAcceptanceErrors(tasks).length,2);
  assert.deepEqual(taskContractErrors(tasks),[],'this check must not invalidate historical handoffs');
  assert.deepEqual(plannedAcceptanceErrors([tasks[2]]),[],'read-only semantic review does not invent a command');
});

test('office-only planning does not teach the model to label document acceptance as code review',()=>{
  const prompt=organizationTaskInstructionsFor(['artifact_write','filesystem','plugin__office__docx_read']);
  assert.ok(!prompt.includes('node --test'));
  assert.match(prompt,/kind=work/);
  assert.match(prompt,/producerTaskId/);
  assert.match(prompt,/最终经理结论/);
  assert.ok(organizationTaskInstructionsFor(['terminal_test']).includes('node --test'));
});

test('terminal template previews use contextual rework instructions while existing callers keep zero rework',()=>{
  for(const tool of ['terminal','terminal_test']){
    const legacy=organizationTaskInstructionsFor([tool]);
    assert.equal(legacy,organizationTaskPlanningInstructions);
    assert.match(legacy,/maxReworkRounds 固定 0/);
    const preview=organizationTaskInstructionsFor([tool],true);
    assert.equal(preview.includes('maxReworkRounds 固定 0'),false,'template previews must not receive unconditional zero-only rework');
    assert.equal(preview.includes('无 orchestration.template 的旧方案：maxReworkRounds=0'),true);
    assert.equal(preview.includes('orchestration.template.id=review_repair 时，绑定的独立审查任务 maxReworkRounds 必须为 1..2'),true);
  }
  assert.equal(organizationTaskInstructionsFor(['artifact_write'],true),organizationTaskInstructionsFor(['artifact_write']));
});
