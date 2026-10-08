import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type pg from 'pg';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { planSchema, policySchema, validatePlan, type Model, type Plan, type Policy } from '../packages/contracts/index.ts';
import { GeneratedPlanView, type GeneratedPlan } from '../apps/web/src/ProjectPlanning.tsx';
import { toolEvidence } from './model-fixture.ts';

const generic = '任务执行估算（含 20% 预留）超过该任务的费用上限';
const detail = '任务「独立真实CLI子进程HTTP验收」（qa_verify）：执行估算（含 20% 预留）$0.151200 超过任务费用上限 $0.15。';
const modelId = 'task-budget-feedback-model', gatewayId = 'task-budget-feedback-gateway', departmentId = 'task-budget-feedback-department';
const model: Model = { id: modelId, gatewayId, name: 'Isolated rate fixture', model: 'fixture-no-paid-provider',
  protocol: 'chat-completions', inputRate: .3, outputRate: 1.2, version: 1, status: 'available', capabilities: toolEvidence };
const policy: Policy = policySchema.parse({ maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 300,
  allowedModelIds: [modelId], allowedTools: [], allowedKnowledgeSpaceIds: [], allowedDepartmentIds: [departmentId] });
function taskPlan(): Plan {
  const base = { objective: '核对隔离测试材料并给出明确结论', assigneeId: 'manager', dependencies: [],
    acceptanceCriteria: ['结论包含可核验依据'], kind: 'work' };
  return planSchema.parse({ rationale: '仅复现任务估算和上限差额的内存夹具',
    agents: [{ id: 'manager', name: '隔离经理', role: 'manager', title: '经理', instructions: '只处理隔离测试材料', modelId, tools: [] }],
    tasks: [
      { ...base, id: 'dev', subject: '开发估算夹具', estimatedInputTokens: 200000, estimatedOutputTokens: 26000, maxBudget: .11 },
      { ...base, id: 'qa_verify', subject: '独立真实CLI子进程HTTP验收', estimatedInputTokens: 300000, estimatedOutputTokens: 30000, maxBudget: .15 },
      { ...base, id: 'qa_review', subject: '审查估算夹具', estimatedInputTokens: 150000, estimatedOutputTokens: 10000, maxBudget: .07 },
      { ...base, id: 'manager_accept', subject: '经理估算夹具', estimatedInputTokens: 90000, estimatedOutputTokens: 8000, maxBudget: .05 },
    ] });
}
function candidate(plan = taskPlan()): GeneratedPlan {
  return { previewId: 'memory-preview', projectId: 'memory-project', baseVersion: 1, plan, policy: structuredClone(policy),
    usageId: 'memory-usage', validation: validatePlan(plan, policy, [model]) };
}
function candidateMarkup(value: GeneratedPlan): string {
  return renderToStaticMarkup(createElement(GeneratedPlanView, { candidate: value, currentVersion: value.baseVersion,
    models: [model], onConfirm: () => {}, onDiscard: () => {} }));
}

test('the actual QA estimate/cap gap names its task while retaining the generic error and total', () => {
  const plan = taskPlan(), before = JSON.stringify({ plan, policy, model });
  const result = validatePlan(plan, policy, [model]);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [generic, detail]);
  assert.equal(result.estimate, .37296);
  assert.deepEqual(result.checks.filter(check => !check.pass), [{ label: '任务费用上限', pass: false }]);
  assert.equal(JSON.stringify({ plan, policy, model }), before);
});

test('every over-cap task is identified once in task order', () => {
  const plan = taskPlan();
  plan.tasks = [plan.tasks[1], { ...plan.tasks[1], id: 'qa_second', subject: '第二项独立验收', maxBudget: .14 }];
  const result = validatePlan(plan, policy, [model]);
  assert.deepEqual(result.errors, [generic, detail,
    '任务「第二项独立验收」（qa_second）：执行估算（含 20% 预留）$0.151200 超过任务费用上限 $0.14。']);
  assert.equal(result.checks.filter(check => check.label === '任务费用上限').length, 1);
});

test('an exact task cap and an omitted cap keep the original valid boundary', () => {
  for (const cap of [.1512, undefined]) {
    const plan = taskPlan(); plan.tasks = [{ ...plan.tasks[1], maxBudget: cap }];
    const before = JSON.stringify(plan), result = validatePlan(plan, policy, [model]);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.deepEqual(result.errors, []);
    assert.equal(result.estimate, .1512);
    assert.equal(JSON.stringify(plan), before);
  }
});

test('micro-dollar ceiling remains strict and displays an unrounded cap', () => {
  const plan = taskPlan();
  plan.tasks = [{ ...plan.tasks[1], estimatedInputTokens: 1, estimatedOutputTokens: 1, maxBudget: .0000019 }];
  const result = validatePlan(plan, policy, [model]);
  assert.equal(result.valid, false);
  assert.equal(result.estimate, .000002);
  assert.deepEqual(result.errors, [generic,
    '任务「独立真实CLI子进程HTTP验收」（qa_verify）：执行估算（含 20% 预留）$0.000002 超过任务费用上限 $0.0000019。']);
  plan.tasks[0].maxBudget = .000002;
  assert.equal(validatePlan(plan, policy, [model]).valid, true);
});

test('missing model prices stay unknown without invented numeric task feedback', () => {
  const result = validatePlan(taskPlan(), policy, []);
  assert.equal(result.valid, false); assert.equal(result.estimate, null);
  assert.ok(result.errors.includes('模型配置不完整，暂时无法估算费用'));
  assert.ok(!result.errors.includes(generic));
  assert.ok(!result.errors.some(error => error.includes('任务费用上限 $')));
});

test('the existing candidate page renders the exact task, estimate and cap in error paragraphs', () => {
  const value = candidate(), before = JSON.stringify(value), markup = candidateMarkup(value);
  assert.ok(markup.includes('<p class="validation-error">' + generic + '</p>'));
  assert.ok(markup.includes('<p class="validation-error">' + detail + '</p>'));
  assert.match(markup, /候选校验：未通过/);
  assert.match(markup, /确认保存候选为草稿/);
  assert.match(markup, /批准执行时仍须通过全部校验/);
  assert.equal(JSON.stringify(value), before);
  const plan = taskPlan(); plan.tasks[1].subject = '<img src=x onerror=alert(1)>';
  const escaped = candidateMarkup(candidate(plan));
  assert.ok(escaped.includes('任务「&lt;img src=x onerror=alert(1)&gt;」（qa_verify）'));
  assert.ok(!escaped.includes('<img src=x'));
});

// API cases can only open the fresh in-memory database supplied by the integration runner.
const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
let pool: pg.Pool, app: any, server: http.Server, gateway: http.Server, directory: string, url: string;
let modelRequests = 0;
const originalFetch = globalThis.fetch;
const close = (instance?: http.Server) => instance ? new Promise<void>(done => {
  instance.closeAllConnections(); instance.close(() => done());
}) : Promise.resolve();
before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
  directory = await mkdtemp(join(tmpdir(), 'task-budget-feedback-'));
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  gateway = http.createServer(async (request, response) => {
    modelRequests++; assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const wire = JSON.parse(raw); assert.equal(wire.model, model.model); assert.equal(wire.tools, undefined);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(taskPlan()) } }],
      usage: { prompt_tokens: 20, completion_tokens: 20 } }));
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const gatewayOrigin = 'http://127.0.0.1:' + (gateway.address() as any).port;
  await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)', [gatewayId, { name: 'Credential-free local fixture', baseUrl: gatewayOrigin + '/v1' }]);
  const { id: _id, version: _version, status: _status, capabilities: _capabilities, ...data } = model;
  await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)", [modelId, data, toolEvidence]);
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)', [departmentId,
    { name: '任务费用反馈隔离部门', description: 'Only in-memory validation evidence', agents: taskPlan().agents }]);
  const { createApp } = await import('../apps/api/src/app.ts'); app = createApp(); await app.locals.shutdown();
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const apiOrigin = 'http://127.0.0.1:' + (server.address() as any).port; url = apiOrigin + '/api';
  globalThis.fetch = async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    assert.ok([apiOrigin, gatewayOrigin].includes(new URL(target).origin), 'Only the two credential-free loopback fixtures may receive HTTP');
    return originalFetch(input, init);
  };
});
after(async () => {
  if (!isolated) return;
  await app?.locals.shutdown(); await close(server); await close(gateway); await pool?.end();
  globalThis.fetch = originalFetch;
  if (directory) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('task-budget-feedback-'));
    await rm(directory, { recursive: true, force: true });
  }
});
async function seed(plan: Plan): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
    [id, departmentId, '任务费用反馈隔离部门', '只验证任务费用反馈；不会启动员工', policy, plan, 'manual']);
  await pool.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)', [id, plan, policy]);
  return id;
}
async function call(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
async function noEmployeeWork(): Promise<void> {
  for (const table of ['project_runs', 'local_operations', 'tool_approvals'])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n, 0, table);
}

test('isolated project API returns the detail and rejects approval before calls, receipts or work', { skip: !isolated }, async () => {
  const id = await seed(taskPlan()), saved = (await pool.query('SELECT * FROM projects WHERE id=$1', [id])).rows[0];
  const listed = await call('/projects'); assert.equal(listed.status, 200);
  const project = listed.data.find((item: any) => item.id === id);
  assert.deepEqual(project.validation.errors, [generic, detail]); assert.equal(project.validation.estimate, .37296);
  const blocked = await call('/projects/' + id + '/approve', 'POST', { version: 1 });
  assert.equal(blocked.status, 422); assert.equal(blocked.data.code, 'PLAN_NOT_READY');
  assert.ok(blocked.data.message.includes(generic)); assert.ok(blocked.data.message.includes(detail));
  assert.deepEqual((await pool.query('SELECT * FROM projects WHERE id=$1', [id])).rows[0], saved);
  for (const table of ['usage', 'model_reservations'])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n, 0, table);
  assert.equal(modelRequests, 0); await noEmployeeWork();
});

test('isolated HTTP 200 generated candidate carries the task detail to the unchanged page without saving', { skip: !isolated }, async () => {
  const original = taskPlan(); original.tasks[1].maxBudget = .16;
  const id = await seed(original), saved = (await pool.query('SELECT * FROM projects WHERE id=$1', [id])).rows[0];
  const generated = await call('/projects/' + id + '/generate', 'POST', { modelId, version: 1, maxPlanningCost: .1, maxOutputTokens: 5000 });
  assert.equal(generated.status, 200, JSON.stringify(generated.data));
  assert.equal(generated.data.validation.valid, false); assert.deepEqual(generated.data.validation.errors, [generic, detail]);
  assert.equal(generated.data.validation.estimate, .37296);
  assert.equal(generated.data.plan.tasks[1].maxBudget, .15); assert.deepEqual(generated.data.policy, policy);
  assert.ok(candidateMarkup(generated.data).includes('<p class="validation-error">' + detail + '</p>'));
  const current = (await pool.query('SELECT * FROM projects WHERE id=$1', [id])).rows[0];
  for (const field of ['plan', 'policy', 'version', 'status']) assert.deepEqual(current[field], saved[field], field);
  assert.equal(modelRequests, 1, 'Exactly one synthetic loopback response; no paid provider');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM plan_versions WHERE project_id=$1', [id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1', [generated.data.usageId])).rows[0].status, 'settled');
  assert.equal((await pool.query('SELECT planning_preview_id FROM usage WHERE id=$1', [generated.data.usageId])).rows[0].planning_preview_id, generated.data.previewId);
  await noEmployeeWork();
});
