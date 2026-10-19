import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationCandidateSchema } from '../packages/contracts/organization.ts';
import { policySchema, validatePlan, type Model } from '../packages/contracts/index.ts';
import { taskContractErrors } from '../packages/contracts/task-contracts.mjs';
import { organizationPlanningTaskExample, organizationTaskInstructionsFor, organizationTaskPlanningInstructions } from '../apps/api/src/organization-task-planning.ts';
import { plannedAcceptanceErrors } from '../apps/api/src/execution-prompt.ts';
import { orchestrationPatterns } from '../packages/contracts/orchestration-patterns.ts';

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

test('terminal planning covers writers for every task kind and keeps resource fields out of handoff',()=>{
 const prompt=organizationTaskInstructionsFor(['filesystem','artifact_write','terminal'],true);
 assert.match(prompt,/filesystem 仅提供读取能力/);
 assert.match(prompt,/所有 outputs/);
 assert.match(prompt,/handoff 只含 sections/);
 assert.match(prompt,/maxBudget.*任务.*同级/);
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

test('routing rework example lets QA consume only the independently reviewed implementation and ends with manager acceptance',()=>{
  const tasks=JSON.parse(organizationTaskInstructionsFor(['filesystem','artifact_write','terminal_test'],true).split('\n').at(-1)!);
  const review=tasks.find((t:any)=>t.kind==='review'),qa=tasks.find((t:any)=>t.kind==='verification'),manager=tasks.at(-1);
  assert.equal(review.maxReworkRounds,1);
  assert.ok(qa.dependencies.includes(review.id));assert.ok(!review.dependencies.includes(qa.id));
  assert.equal(manager.assigneeId,'manager');assert.notEqual(review.assigneeId,'manager');
  const agents=['manager','developer','qa'].map(id=>({id,name:id,title:id,role:id==='manager'?'manager' as const:'member' as const,instructions:'依照合同验证真实结果。',modelId:'m',tools:['filesystem','artifact_write','terminal_test']}));
  const definition=orchestrationPatterns.find(p=>p.id==='review_repair')!;
  const plan={agents,tasks,rationale:'仅检查示例合同',orchestration:{pattern:'pipeline' as const,rationale:'审查通过后QA再消费当前产物',template:{schemaVersion:1 as const,id:'review_repair' as const,version:1 as const,definitionHash:definition.definitionHash,reviewTaskId:review.id}},deliveryCriteria:[{id:'cli',description:'实现达到要求',producerTaskIds:['develop'],checkTaskId:review.id,checkCriteriaIndexes:[0],independent:true}]};
  const policy=policySchema.parse({maxBudget:1,maxAgents:3,maxConcurrentAgents:1,deadlineSeconds:600,allowedModelIds:['m'],allowedTools:['filesystem','artifact_write','terminal_test']});
  assert.deepEqual(taskContractErrors(tasks,agents),[]);assert.deepEqual(plannedAcceptanceErrors(tasks),[]);
  const validation=validatePlan(plan,policy,[{id:'m',name:'fixture',gatewayId:'g',model:'m',inputRate:.1,outputRate:.2,status:'available'} as Model],false);
  assert.equal(validation.valid,true,JSON.stringify(validation.errors));
  const stale=structuredClone(tasks);stale.find((t:any)=>t.id===qa.id).dependencies=['develop'];
  assert.ok(taskContractErrors(stale,agents).some((e:string)=>e.includes('必须等待独立审查')),'the consumer gate stays enforced');
});
