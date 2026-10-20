import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type pg from 'pg';
import { toolEvidence } from './model-fixture.ts';
import { createRunArchive, readRun } from '../services/agent-runtime/trace-store.mjs';

// The runner supplies a fresh in-memory PGlite. Never open the product database.
const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
let pool: pg.Pool, app: any, server: http.Server, gateway: http.Server, directory: string, url: string;
let requests = 0, wire: any, candidate: any;
const modelId = 'planning-preview-model', expensiveId = 'planning-astra-rate-fixture', responsesId = 'planning-responses-fixture', gatewayId = 'planning-preview-gateway', departmentId = 'planning-preview-department';
const employee = { id: 'manager', name: '隔离规划经理', title: '经理', role: 'manager', instructions: '遵守本次批准范围。', modelId, tools: [] };
const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 300,
  allowedModelIds: [modelId, expensiveId, responsesId], allowedTools: [], allowedKnowledgeSpaceIds: [], allowedDepartmentIds: [departmentId] };
const task = { id: 'report', subject: '整理运行说明', objective: '整理说明并明确未完成验收。', assigneeId: employee.id, dependencies: [],
  acceptanceCriteria: ['明确完成项与未验证项'], estimatedInputTokens: 100, estimatedOutputTokens: 100, kind: 'work' };
const original = { rationale: '原保存方案', agents: [employee], tasks: [task] };
const close = (instance?: http.Server) => instance ? new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()); }) : Promise.resolve();

before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /@127\.0\.0\.1:\d+\/postgres$/);
  directory = await mkdtemp(join(tmpdir(), 'project-planning-preview-'));
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  gateway = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    wire = JSON.parse(raw); requests++; assert.ok(['/v1/chat/completions', '/v1/responses'].includes(req.url!)); assert.equal(wire.tools, undefined);
    res.setHeader('content-type', 'application/json');
    const content = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
    res.end(JSON.stringify(req.url === '/v1/responses'
      ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 20, output_tokens: 20 } }
      : { choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 20 } }));
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)', [gatewayId, { name: 'Local model protocol fixture', baseUrl: 'http://127.0.0.1:' + (gateway.address() as any).port + '/v1' }]);
  for (const [id, inputRate, outputRate] of [[modelId, 2, 10], [expensiveId, 10, 50]] as const)
    await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)", [id, { name: id, model: 'fixture-planner', gatewayId, inputRate, outputRate }, toolEvidence]);
  await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)", [responsesId,
    { name: responsesId, model: 'fixture-responses-planner', protocol: 'responses', contextWindowTokens: 256000, gatewayId, inputRate: 10, outputRate: 50 }, toolEvidence]);
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)', [departmentId, { name: '隔离规划部门', description: 'No production data', agents: [employee] }]);
  const { createApp } = await import('../apps/api/src/app.ts'); app = createApp(); await app.locals.shutdownBackground();
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
});
beforeEach(async () => {
  if (!isolated) return;
  await pool.query('TRUNCATE usage,model_reservations,organization_previews,project_runs,plan_versions,projects,request_keys CASCADE');
  await pool.query('UPDATE product_settings SET data=$1 WHERE id=1', [{ autoBudgetLimit: .25, dailyBudgetLimit: 20, maxActiveRuns: 2, retentionDays: 0 }]);
  await pool.query('UPDATE models SET data=data||$2::jsonb WHERE id=$1', [responsesId, { contextWindowTokens: 256000 }]);
  requests = 0; wire = undefined;
  candidate = { ...structuredClone(original), rationale: '待用户确认的新候选', tasks: [{ ...structuredClone(task), subject: '整理新的验收说明' }] };
});
after(async () => {
  if (!isolated) return;
  await app?.locals.shutdown(); await close(server); await close(gateway); await pool?.end();
  if (directory) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('project-planning-preview-'));
    await rm(directory, { recursive: true, force: true });
  }
});

async function seed(budget = 1) {
  const id = randomUUID();
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
    [id, departmentId, '隔离规划部门', '通过网页检查并确认方案，生成不会自动保存或执行。', { ...policy, maxBudget: budget }, original, 'manual']);
  await pool.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)', [id, original, { ...policy, maxBudget: budget }]);
  return id;
}
async function call(path: string, method = 'GET', body?: any, key?: string) {
  const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
const input = (patch: any = {}) => ({ modelId, version: 1, maxPlanningCost: .5, ...patch });
async function quote(projectId: string, patch: any = {}) {
  return call('/projects/' + projectId + '/planning-quote?' + new URLSearchParams(Object.entries(input(patch)).map(([key, value]) => [key, String(value)])));
}
async function state() {
  const tables = ['projects', 'departments', 'department_versions', 'plan_versions', 'usage', 'model_reservations', 'project_runs', 'organization_previews', 'tool_approvals', 'local_operations', 'request_keys', 'activity'];
  return Promise.all(tables.map(async table => ({ table, rows: (await pool.query('SELECT row_to_json(t) AS data FROM ' + table + ' t ORDER BY row_to_json(t)::text')).rows })));
}
async function hold(projectId: string, status: string, options: { amount?: number; runId?: string; context?: Record<string, unknown> } = {}) {
  const id = randomUUID();
  await pool.query(`INSERT INTO model_reservations(id,model_id,project_id,run_id,purpose,amount,input_rate,output_rate,status,context,history,expires_at)
    VALUES($1,$2,$3,$4,'isolated historic fee',$5,2,10,$6,$7,$8,now()-interval '1 hour')`,
    [id, modelId, projectId, options.runId ?? null, options.amount ?? .02, status, options.context ?? {}, JSON.stringify([{ source: 'fixture', note: 'Never sent externally' }])]);
  return id;
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const receipt = async (id: string) => (await pool.query('SELECT * FROM model_reservations WHERE id=$1', [id])).rows[0];

test('project dialogue retains source versions without old grants, and new dialogue invalidates an unconfirmed candidate', {skip:!isolated},async()=>{
  const id=await seed();await pool.query('UPDATE projects SET version=2 WHERE id=$1',[id]);
  for(const [messageId,version,content] of [['older',1,'OLD_VERSION_NOT_CURRENT'],['current',2,'补充 --help 只打印用法；不要增加服务器或权限。']] as const)
    await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,reply,status,max_cost,model_id) VALUES($1,$2,$3,$4,'经理建议仅供参考','replied',.02,$5)",[messageId,id,version,content,modelId]);
  const inspected=await quote(id,{version:2});assert.equal(inspected.data.conversation.count,2);assert.deepEqual(inspected.data.conversation.messageIds,['older','current']);
  const generated=await call('/projects/'+id+'/generate','POST',input({version:2}));assert.equal(generated.status,200,JSON.stringify(generated.data));
  const materials=JSON.parse(wire.messages.find((message:any)=>message.role==='user').content);assert.equal(materials.conversation.messages[1].user,'补充 --help 只打印用法；不要增加服务器或权限。');assert.deepEqual(materials.conversation.messages.map((m:any)=>m.sourceVersion),[1,2]);
  assert.deepEqual(generated.data.policy.allowedTools,[]);assert.equal(generated.data.conversation.sha256,inspected.data.conversation.sha256);
  await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,reply,status,max_cost,model_id) VALUES('newer',$1,2,'帮助中再加运行示例','待规划','replied',.02,$2)",[id,modelId]);
  const denied=await call('/projects/'+id+'/generated-plan/confirm','POST',{previewId:generated.data.previewId,version:2});assert.equal(denied.status,409);assert.equal(denied.data.code,'PLANNING_CONVERSATION_CHANGED');
  assert.equal(requests,1);assert.equal((await pool.query('SELECT version FROM projects WHERE id=$1',[id])).rows[0].version,2);
});

test('unfinished conversation blocks planning before any extra model request', {skip:!isolated},async()=>{
  const id=await seed();await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,status,max_cost,model_id) VALUES('pending',$1,1,'补充需求等待经理','waiting',.02,$2)",[id,modelId]);
  const inspected=await quote(id);assert.equal(inspected.data.allowed,false);assert.ok(inspected.data.reasons.some((r:any)=>r.code==='CONVERSATION_ACTIVE'));
  const generated=await call('/projects/'+id+'/generate','POST',input());assert.equal(generated.data.code,'CONVERSATION_ACTIVE');assert.equal(requests,0);
});

test('missing generated command mappings preserve the saved plan and paid receipt', {skip:!isolated},async()=>{
  const id=await seed();candidate.tasks[0].verify=['node --test check.test.mjs'];
  const result=await call('/projects/'+id+'/generate','POST',input());
  assert.equal(result.status,422);assert.equal(result.data.code,'PLAN_ACCEPTANCE_REQUIRED');
  assert.equal(requests,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM organization_previews')).rows[0].n,0);
  const saved=(await pool.query('SELECT plan,version FROM projects WHERE id=$1',[id])).rows[0];assert.equal(saved.version,1);assert.deepEqual(saved.plan,original);
});

test('HTTP quote is read-only, uses the exact generation body and shares its reservation formula', { skip: !isolated }, async () => {
  const id = await seed(), before = await state();
  const inspected = await quote(id); assert.equal(inspected.status, 200, JSON.stringify(inspected.data));
  assert.equal(inspected.data.allowed, true); assert.equal(inspected.data.maxOutputTokens, 5000);
  assert.equal(inspected.data.nativeExecutionChecked, false); assert.deepEqual(await state(), before); assert.equal(requests, 0);
  assert.equal(inspected.data.savedPlanIncluded, true);
  assert.equal(inspected.data.executionHistory.budget.available, true);
  assert.equal(inspected.data.executionHistory.budget.calls, 0);
  const generated = await call('/projects/' + id + '/generate', 'POST', input()); assert.equal(generated.status, 200, JSON.stringify(generated.data));
  assert.equal(requests, 1); assert.equal(wire.max_tokens, 5000);
  assert.match(wire.messages[0].content, /所有员工必须省略 reasoningEffort/);
  const planningData = JSON.parse(wire.messages.find((message: any) => message.role === 'user').content);
  assert.deepEqual(planningData.savedPlan, original);
  assert.deepEqual(planningData.executionHistory, inspected.data.executionHistory);
  const expected = ((Buffer.byteLength(JSON.stringify({ messages: wire.messages })) + 1024) * 2 + wire.max_tokens * 10) / 1e6;
  assert.equal(inspected.data.reservation, expected);
  const receipt = (await pool.query('SELECT * FROM model_reservations WHERE id=$1', [generated.data.usageId])).rows[0];
  assert.equal(Number(receipt.amount), expected); assert.equal(receipt.status, 'settled');
  assert.equal((await pool.query('SELECT planning_preview_id FROM usage WHERE id=$1',[generated.data.usageId])).rows[0].planning_preview_id,generated.data.previewId);
  assert.equal((await pool.query('SELECT version,plan,policy FROM projects WHERE id=$1', [id])).rows[0].version, 1);
});

test('Astra-rate quote exposes both planning and net-budget limits without lowering output or making a call', { skip: !isolated }, async () => {
  const id = await seed(.48); await pool.query('INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,1,1,.3664174,$4)', [randomUUID(), modelId, id, 'prior fees fixture']);
  await hold(id, 'uncertain'); const before = await state();
  const inspected = await quote(id, { modelId: expensiveId, maxPlanningCost: .048 });
  assert.equal(inspected.status, 200); assert.equal(inspected.data.allowed, false); assert.equal(inspected.data.maxOutputTokens, 5000);
  assert.ok(inspected.data.reservation > .25); assert.deepEqual(inspected.data.rates, { inputRate: 10, outputRate: 50 });
  for (const code of ['COST_PENDING', 'CALL_BUDGET_EXCEEDED', 'BUDGET_EXCEEDED']) assert.ok(inspected.data.reasons.some((reason: any) => reason.code === code));
  assert.equal(requests, 0); assert.deepEqual(await state(), before);
  const generated = await call('/projects/' + id + '/generate', 'POST', input({ modelId: expensiveId, maxPlanningCost: .048 }));
  assert.equal(generated.data.code, 'COST_PENDING'); assert.equal(requests, 0); assert.deepEqual(await state(), before);
});

test('a quote is not a ticket: a new pending hold blocks generation and stays unchanged', { skip: !isolated }, async () => {
  const id = await seed(); assert.equal((await quote(id)).data.allowed, true);
  const receiptId = await hold(id, 'pending'), before = await state();
  const generated = await call('/projects/' + id + '/generate', 'POST', input()); assert.equal(generated.status, 409); assert.equal(generated.data.code, 'COST_PENDING');
  assert.equal(requests, 0); assert.deepEqual(await state(), before);
  assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1', [receiptId])).rows[0].status, 'pending');
});

test('generation leaves the saved team and plan untouched; confirmation versions once and never starts a run', { skip: !isolated }, async () => {
  const id = await seed();
  const historyId = randomUUID(); await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,$2,1,'failed',$3)", [historyId, id, { projectId: id, policy, tasks: [task], completedCheckpoints: ['report'] }]);
  const history = (await pool.query('SELECT * FROM project_runs WHERE id=$1', [historyId])).rows[0];
  const department = (await pool.query('SELECT * FROM departments WHERE id=$1', [departmentId])).rows[0];
  const generated = await call('/projects/' + id + '/generate', 'POST', input(), 'planning-generate-once'); assert.equal(generated.status, 200, JSON.stringify(generated.data));
  assert.equal(generated.data.baseVersion, 1); assert.equal(generated.data.projectId, id); assert.equal(generated.data.policy.maxBudget, 1);
  assert.deepEqual((await pool.query('SELECT plan FROM projects WHERE id=$1', [id])).rows[0].plan, original);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM plan_versions WHERE project_id=$1', [id])).rows[0].n, 1);
  assert.deepEqual((await pool.query('SELECT * FROM departments WHERE id=$1', [departmentId])).rows[0], department);
  const repeated = await call('/projects/' + id + '/generate', 'POST', input(), 'planning-generate-once'); assert.deepEqual(repeated.data, generated.data); assert.equal(requests, 1);
  const confirmations = await Promise.all(Array.from({ length: 4 }, () => call('/projects/' + id + '/generated-plan/confirm', 'POST', { previewId: generated.data.previewId, version: 1 })));
  assert.ok(confirmations.every(result => result.status === 200), JSON.stringify(confirmations));
  assert.equal(confirmations.filter(result => !result.data.existing).length, 1); assert.ok(confirmations.every(result => result.data.version === 2));
  const saved = (await pool.query('SELECT * FROM projects WHERE id=$1', [id])).rows[0]; assert.equal(saved.version, 2); assert.equal(saved.source, 'model'); assert.equal(saved.status, 'DRAFT'); assert.equal(saved.policy.maxBudget, 1);
  assert.equal(saved.plan.rationale, candidate.rationale); assert.equal((await pool.query('SELECT count(*)::int AS n FROM plan_versions WHERE project_id=$1', [id])).rows[0].n, 2);
  assert.equal(requests, 1); assert.deepEqual((await pool.query('SELECT * FROM project_runs WHERE id=$1', [historyId])).rows[0], history);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs WHERE project_id=$1', [id])).rows[0].n, 1);
  assert.deepEqual((await pool.query('SELECT * FROM departments WHERE id=$1', [departmentId])).rows[0], department);
});

test('wrong project, stale version and same-version source changes cannot confirm a candidate', { skip: !isolated }, async () => {
  const id = await seed(), other = await seed();
  const preview = (await call('/projects/' + id + '/generate', 'POST', input())).data;
  const wrong = await call('/projects/' + other + '/generated-plan/confirm', 'POST', { previewId: preview.previewId, version: 1 }); assert.equal(wrong.data.code, 'PLANNING_PREVIEW_MISMATCH');
  assert.equal((await call('/projects/' + id + '/generated-plan/confirm', 'POST', { previewId: preview.previewId, version: 2 })).data.code, 'VERSION_CONFLICT');
  await pool.query('UPDATE projects SET requirement=$1 WHERE id=$2', ['另一页改过原需求，仍不得覆盖。', id]);
  const before = await state();
  assert.equal((await call('/projects/' + id + '/generated-plan/confirm', 'POST', { previewId: preview.previewId, version: 1 })).data.code, 'VERSION_CONFLICT');
  assert.deepEqual(await state(), before); assert.equal(requests, 1);
});

test('active runs block quotes, generation and candidate confirmation before any added call or plan write', { skip: !isolated }, async () => {
  const id = await seed(); const preview = (await call('/projects/' + id + '/generate', 'POST', input())).data;
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,$2,1,'running',$3)", [randomUUID(), id, { projectId: id }]);
  const before = await state(), inspected = await quote(id); assert.equal(inspected.data.allowed, false); assert.ok(inspected.data.reasons.some((reason: any) => reason.code === 'PROJECT_ACTIVE'));
  assert.equal((await call('/projects/' + id + '/generate', 'POST', input())).data.code, 'PROJECT_ACTIVE');
  assert.equal((await call('/projects/' + id + '/generated-plan/confirm', 'POST', { previewId: preview.previewId, version: 1 })).data.code, 'PROJECT_ACTIVE');
  assert.equal(requests, 1); assert.deepEqual(await state(), before);
});

test('invalid replies retain their fee receipt and cannot replace the original plan', { skip: !isolated }, async () => {
  const id = await seed(); candidate = '{"rationale":"incomplete"';
  const generated = await call('/projects/' + id + '/generate', 'POST', input()); assert.equal(generated.status, 422); assert.equal(requests, 1);
  assert.deepEqual((await pool.query('SELECT plan FROM projects WHERE id=$1', [id])).rows[0].plan, original);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM organization_previews')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE project_id=$1', [id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM model_reservations WHERE project_id=$1 AND status='settled'", [id])).rows[0].n, 1);
});

test('unsupported effort is explicitly invalid in project candidates and cannot launch a confirmed plan', { skip: !isolated }, async () => {
  const id = await seed(); candidate.agents[0].reasoningEffort = 'medium';
  const generated = await call('/projects/' + id + '/generate', 'POST', input());
  assert.equal(generated.status, 200); assert.equal(generated.data.validation.valid, false);
  assert.match(generated.data.validation.errors.join('；'), /使用模型默认/);
  assert.equal(generated.data.plan.agents[0].reasoningEffort, 'medium', 'invalid candidate is retained without silently rewriting it');
  assert.deepEqual((await pool.query('SELECT plan FROM projects WHERE id=$1', [id])).rows[0].plan, original);
  const confirmed = await call('/projects/' + id + '/generated-plan/confirm', 'POST', { previewId: generated.data.previewId, version: 1 });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.data.validation.valid, false);
  const beforeCalls = requests, beforeRuns = (await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n;
  const approved = await call('/projects/' + id + '/approve', 'POST', { version: confirmed.data.version });
  assert.equal(approved.status, 422); assert.equal(approved.data.code, 'PLAN_NOT_READY');
  assert.match(approved.data.message, /使用模型默认/);
  assert.equal(requests, beforeCalls);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n, beforeRuns);
});

test('explicit output bounds are quoted and sent unchanged; foreign preview kinds and invalid inputs are rejected', { skip: !isolated }, async () => {
  const id = await seed(); const inspected = await quote(id, { maxOutputTokens: 700 }); assert.equal(inspected.data.maxOutputTokens, 700);
  const generated = await call('/projects/' + id + '/generate', 'POST', input({ maxOutputTokens: 700 })); assert.equal(generated.status, 200, JSON.stringify(generated.data)); assert.equal(wire.max_tokens, 700);
  const before = requests;
  for (const maxOutputTokens of [0, 32769, 1.5]) assert.equal((await quote(id, { maxOutputTokens })).status, 422);
  assert.equal((await quote(id, { version: 2 })).data.code, 'VERSION_CONFLICT');
  assert.equal((await call('/organizations/chat', 'POST', { modelId, policy, messages: [{ role: 'user', content: '不要误把项目候选当成新部门。' }], previousPreviewId: generated.data.previewId })).data.code, 'PLANNING_PREVIEW_MISMATCH');
  const organization = randomUUID(); await pool.query('INSERT INTO organization_previews(id,data) VALUES($1,$2)', [organization, { department: { name: '旧组织草案' } }]);
  assert.equal((await call('/projects/' + id + '/generated-plan/confirm', 'POST', { previewId: organization, version: 1 })).data.code, 'PLANNING_PREVIEW_MISMATCH');
  assert.equal(requests, before); assert.equal((await pool.query('SELECT version FROM projects WHERE id=$1', [id])).rows[0].version, 1);
});

test('quote retention parses only literal true/false and omitted or false choices keep unknown fees blocked', { skip: !isolated }, async () => {
  const id = await seed(), held = await hold(id, 'uncertain'), before = await state();
  for (const patch of [{}, { retainUncertainCosts: false }]) {
    const inspected = await quote(id, patch);
    assert.equal(inspected.status, 200); assert.equal(inspected.data.retainUncertainCosts, false);
    assert.equal(inspected.data.allowed, false); assert.equal(inspected.data.retainedCostEvidence.retained, false);
    assert.deepEqual(inspected.data.retainedCostEvidence.receipts, [{ id: held, amount: .02, status: 'uncertain' }]);
    assert.ok(inspected.data.reasons.some((reason: any) => reason.code === 'COST_PENDING'));
    const generated = await call('/projects/' + id + '/generate', 'POST', input(patch));
    assert.equal(generated.status, 409); assert.equal(generated.data.code, 'COST_PENDING');
  }
  const retained = await quote(id, { retainUncertainCosts: true });
  assert.equal(retained.status, 200); assert.equal(retained.data.allowed, true); assert.equal(retained.data.retainUncertainCosts, true);
  for (const value of ['', 'TRUE', 'False', '1', '0', 'null']) assert.equal((await quote(id, { retainUncertainCosts: value })).status, 422, value);
  assert.equal((await quote(id, { unsupportedPlanningChoice: 'true' })).status, 422);
  assert.equal((await call('/projects/' + id + '/planning-quote?' + new URLSearchParams(input()) + '&retainUncertainCosts=true&retainUncertainCosts=false')).status, 422);
  for (const value of ['true', 'false', 1, null]) assert.equal((await call('/projects/' + id + '/generate', 'POST', input({ retainUncertainCosts: value }))).status, 422);
  assert.equal(requests, 0); assert.deepEqual(await state(), before);
});

test('explicit retention generates and confirms within the net budget while old receipts, runs and unknown operations remain intact', { skip: !isolated }, async () => {
  const id = await seed(), runId = randomUUID(), traceRoot = join(directory, 'runs');
  const snapshot = { projectId: id, planVersion: 1, requirement: '通过网页检查并确认方案，生成不会自动保存或执行。',
    policy, agents: [employee], tasks: [task], knowledge: { format: 'document-versions-v2', documents: [], agentDocuments: { manager: [] } } };
  const archive = createRunArchive(traceRoot, snapshot, { id: runId });
  archive.append('model/wire-request', { taskId: task.id });
  archive.append('runtime/operation-start', { name: 'artifact_write', arguments: { content: 'Synthetic unresolved action, never executed' } }, { callId: 'fixture-unknown-action' });
  archive.append('run/finished', { status: 'failed' });
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,started_at) VALUES($1,$2,1,'failed',$3,now())", [runId, id, snapshot]);
  await pool.query('INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,1,1,.1,$4)', [randomUUID(), modelId, id, 'historic local fixture']);
  const holds = [await hold(id, 'uncertain', { runId, context: { taskId: task.id, providerRequestId: 'synthetic-old-receipt' } }),
    await hold(id, 'uncertain', { amount: .03 })];
  const oldReceipts = await Promise.all(holds.map(receipt));
  const oldRun = (await pool.query('SELECT * FROM project_runs WHERE id=$1', [runId])).rows[0], oldArchive = readRun(traceRoot, runId), before = await state();
  const inspected = await quote(id, { retainUncertainCosts: true });
  assert.equal(inspected.status, 200); assert.equal(inspected.data.allowed, true, JSON.stringify(inspected.data.reasons));
  assert.equal(inspected.data.retainedCostEvidence.retained, true); near(inspected.data.retainedCostEvidence.recordedCost, .1);
  near(inspected.data.retainedCostEvidence.reserved, .05); near(inspected.data.retainedCostEvidence.availableBudget, .85);
  assert.deepEqual(inspected.data.retainedCostEvidence.receipts.map((row: any) => row.id).sort(), holds.sort());
  assert.deepEqual(inspected.data.executionHistory.unknownOperationIds, ['fixture-unknown-action']);
  assert.deepEqual(await state(), before); assert.equal(requests, 0);
  const generated = await call('/projects/' + id + '/generate', 'POST', input({ retainUncertainCosts: true }), 'retained-planning-generation');
  assert.equal(generated.status, 200, JSON.stringify(generated.data)); assert.equal(generated.data.retainUncertainCosts, true); assert.equal(requests, 1);
  assert.equal(wire.max_tokens, 5000); assert.deepEqual((await pool.query('SELECT plan FROM projects WHERE id=$1', [id])).rows[0].plan, original);
  const billedPlanning = await receipt(generated.data.usageId);
  assert.equal(billedPlanning.status, 'settled'); assert.equal(billedPlanning.context.costCarryover.retained, true);
  near(billedPlanning.context.costCarryover.reserved, .05); near(billedPlanning.context.costCarryover.availableBudget, .85);
  assert.deepEqual(billedPlanning.context.costCarryover.receipts.map((row: any) => row.id).sort(), holds);
  const beforeMismatch = await state();
  for (const choice of [{}, { retainUncertainCosts: false }]) {
    const rejected = await call('/projects/' + id + '/generated-plan/confirm', 'POST', { previewId: generated.data.previewId, version: 1, ...choice });
    assert.equal(rejected.status, 409); assert.equal(rejected.data.code, 'PLANNING_COST_CHOICE_MISMATCH');
  }
  assert.deepEqual(await state(), beforeMismatch);
  const saved = await call('/projects/' + id + '/generated-plan/confirm', 'POST', { previewId: generated.data.previewId, version: 1, retainUncertainCosts: true }, 'retained-planning-confirmation');
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.version, 2); near(saved.data.costReadiness.reserved, .05);
  assert.ok(saved.data.costReadiness.recordedCost > .1); near(saved.data.costReadiness.availableBudget, 1 - saved.data.costReadiness.recordedCost - .05);
  assert.deepEqual(await Promise.all(oldReceipts.map(row => receipt(row.id))), oldReceipts);
  assert.deepEqual((await pool.query('SELECT * FROM project_runs WHERE id=$1', [runId])).rows[0], oldRun);
  assert.deepEqual(readRun(traceRoot, runId), oldArchive); assert.equal(requests, 1);
  const current = (await pool.query('SELECT policy,status FROM projects WHERE id=$1', [id])).rows[0];
  assert.equal(current.policy.maxBudget, 1); assert.equal(current.status, 'DRAFT');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs WHERE project_id=$1', [id])).rows[0].n, 1);
});

test('retention never admits a pending receipt or changes its expired lease through read-only preflight', { skip: !isolated }, async () => {
  const id = await seed(), pending = await hold(id, 'pending'), before = await state();
  for (const retainUncertainCosts of [false, true]) {
    const inspected = await quote(id, { retainUncertainCosts });
    assert.equal(inspected.status, 200); assert.equal(inspected.data.allowed, false);
    assert.equal(inspected.data.costReadiness.pendingCount, 1); assert.equal(inspected.data.costReadiness.uncertainCount, 0);
    assert.ok(inspected.data.reasons.some((reason: any) => reason.code === 'COST_PENDING'));
    const generated = await call('/projects/' + id + '/generate', 'POST', input({ retainUncertainCosts }));
    assert.equal(generated.status, 409); assert.equal(generated.data.code, 'COST_PENDING');
  }
  assert.equal((await receipt(pending)).status, 'pending'); assert.equal(requests, 0); assert.deepEqual(await state(), before);
});

test('locked planning admission refuses expired pending fees before converting them into opt-in unknown fees', { skip: !isolated }, async () => {
  const id = await seed(); await hold(id, 'pending'); const before = await state();
  const { reserveCall } = await import('../apps/api/src/cost-control.ts');
  await assert.rejects(reserveCall({ model: { id: modelId, inputRate: 2, outputRate: 10 }, amount: .01,
    purpose: 'local stale-preflight fixture', projectId: id, projectVersion: 1, maxCost: .5, retainUncertainCosts: true }), { code: 'COST_PENDING' });
  assert.equal(requests, 0); assert.deepEqual(await state(), before);
});

test('opt-in planning subtracts every unknown hold and rechecks a reduced net budget before another reservation', { skip: !isolated }, async () => {
  const id = await seed(), held = await hold(id, 'uncertain');
  assert.equal((await quote(id, { retainUncertainCosts: true })).data.allowed, true);
  await hold(id, 'uncertain', { amount: .95 }); const before = await state();
  const inspected = await quote(id, { retainUncertainCosts: true });
  assert.equal(inspected.data.allowed, false); near(inspected.data.retainedCostEvidence.reserved, .97);
  near(inspected.data.costReadiness.availableBudget, .03); assert.equal(inspected.data.maxOutputTokens, 5000);
  assert.ok(inspected.data.reasons.some((reason: any) => reason.code === 'BUDGET_EXCEEDED'));
  assert.equal(inspected.data.reasons.some((reason: any) => reason.code === 'COST_PENDING'), false);
  const generated = await call('/projects/' + id + '/generate', 'POST', input({ retainUncertainCosts: true }));
  assert.equal(generated.status, 422); assert.equal(generated.data.code, 'BUDGET_EXCEEDED');
  const { reserveCall } = await import('../apps/api/src/cost-control.ts');
  await assert.rejects(reserveCall({ model: { id: modelId, inputRate: 2, outputRate: 10 }, amount: .04,
    purpose: 'local budget-race fixture', projectId: id, projectVersion: 1, retainUncertainCosts: true }), { code: 'BUDGET_EXCEEDED' });
  assert.equal((await receipt(held)).status, 'uncertain'); assert.equal(requests, 0); assert.deepEqual(await state(), before);
});

test('generation and confirmation keys retain legacy omitted bodies and reject a changed retention choice', { skip: !isolated }, async () => {
  const id = await seed(), generationBody = input(), generationKey = 'legacy-planning-generation';
  const generated = await call('/projects/' + id + '/generate', 'POST', generationBody, generationKey);
  assert.equal(generated.status, 200, JSON.stringify(generated.data)); assert.equal(Object.hasOwn(generated.data, 'retainUncertainCosts'), false);
  const afterGeneration = await state();
  for (const retainUncertainCosts of [false, true]) assert.equal((await call('/projects/' + id + '/generate', 'POST', { ...generationBody, retainUncertainCosts }, generationKey)).status, 409);
  assert.deepEqual((await call('/projects/' + id + '/generate', 'POST', generationBody, generationKey)).data, generated.data);
  assert.deepEqual(await state(), afterGeneration); assert.equal(requests, 1);
  const confirmationBody = { previewId: generated.data.previewId, version: 1 }, confirmationKey = 'legacy-planning-confirmation';
  assert.equal((await call('/projects/' + id + '/generated-plan/confirm', 'POST', { ...confirmationBody, retainUncertainCosts: true })).data.code, 'PLANNING_COST_CHOICE_MISMATCH');
  const confirmed = await call('/projects/' + id + '/generated-plan/confirm', 'POST', confirmationBody, confirmationKey);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data)); const afterConfirmation = await state();
  for (const retainUncertainCosts of [false, true]) assert.equal((await call('/projects/' + id + '/generated-plan/confirm', 'POST', { ...confirmationBody, retainUncertainCosts }, confirmationKey)).status, 409);
  assert.deepEqual((await call('/projects/' + id + '/generated-plan/confirm', 'POST', confirmationBody, confirmationKey)).data, confirmed.data);
  assert.deepEqual(await state(), afterConfirmation); assert.equal(requests, 1);
});

test('Responses quotes expose context and net-budget failures read-only while keeping the explicit output bound', { skip: !isolated }, async () => {
  const id = await seed(.48); await hold(id, 'uncertain', { amount: .0278694 });
  await pool.query('INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,1,1,.3664174,$4)', [randomUUID(), modelId, id, 'historic local fee fixture']);
  await pool.query('UPDATE models SET data=data||$2::jsonb WHERE id=$1', [responsesId, { contextWindowTokens: 1000 }]);
  const before = await state(), inspected = await quote(id, { modelId: responsesId, maxPlanningCost: .048, maxOutputTokens: 5000, retainUncertainCosts: true });
  assert.equal(inspected.status, 200); assert.equal(inspected.data.allowed, false); assert.equal(inspected.data.maxOutputTokens, 5000);
  near(inspected.data.costReadiness.availableBudget, .0857132); near(inspected.data.retainedCostEvidence.reserved, .0278694);
  for (const code of ['CONTEXT_LIMIT', 'CALL_BUDGET_EXCEEDED', 'BUDGET_EXCEEDED']) assert.ok(inspected.data.reasons.some((reason: any) => reason.code === code), code);
  assert.equal(inspected.data.reasons.some((reason: any) => reason.code === 'COST_PENDING'), false);
  const generated = await call('/projects/' + id + '/generate', 'POST', input({ modelId: responsesId, maxPlanningCost: .048, maxOutputTokens: 5000, retainUncertainCosts: true }));
  assert.equal(generated.status, 422); assert.equal(generated.data.code, 'CONTEXT_LIMIT');
  assert.equal(requests, 0); assert.deepEqual(await state(), before);
});

test('Responses quote and reservation count the full stateless wire envelope and reject one-byte context overflow before dispatch', { skip: !isolated }, async () => {
  const id = await seed(), parameters = { modelId: responsesId, maxOutputTokens: 700 };
  const inspected = await quote(id, parameters); assert.equal(inspected.data.allowed, true, JSON.stringify(inspected.data.reasons));
  const exactContext = inspected.data.inputBytes + 700;
  await pool.query('UPDATE models SET data=data||$2::jsonb WHERE id=$1', [responsesId, { contextWindowTokens: exactContext - 1 }]);
  const before = await state(), overflow = await quote(id, parameters);
  assert.equal(overflow.data.inputBytes, inspected.data.inputBytes); assert.equal(overflow.data.maxOutputTokens, 700); assert.equal(overflow.data.allowed, false);
  assert.ok(overflow.data.reasons.some((reason: any) => reason.code === 'CONTEXT_LIMIT'));
  assert.equal((await call('/projects/' + id + '/generate', 'POST', input(parameters))).data.code, 'CONTEXT_LIMIT');
  assert.deepEqual(await state(), before); assert.equal(requests, 0);
  await pool.query('UPDATE models SET data=data||$2::jsonb WHERE id=$1', [responsesId, { contextWindowTokens: exactContext }]);
  assert.equal((await quote(id, parameters)).data.allowed, true);
  const generated = await call('/projects/' + id + '/generate', 'POST', input(parameters));
  assert.equal(generated.status, 200, JSON.stringify(generated.data)); assert.equal(requests, 1);
  assert.equal(wire.max_output_tokens, 700); assert.equal(wire.max_tokens, undefined); assert.equal(wire.store, false);
  assert.deepEqual(wire.reasoning, { effort: 'none' }); assert.equal(wire.previous_response_id, undefined); assert.equal(wire.tools, undefined);
  const inputBytes = Buffer.byteLength(JSON.stringify(wire)) + 1024, expected = (inputBytes * 10 + 700 * 50) / 1e6;
  assert.equal(inspected.data.inputBytes, inputBytes); assert.equal(inspected.data.reservation, expected);
  assert.equal(Number((await receipt(generated.data.usageId)).amount), expected);
});

test('a new user adjustment is quoted and pinned without editing the saved requirement, grants or prior plan', { skip: !isolated }, async () => {
  const id = await seed(), before = await state();
  const revisionRequest = '改用已经配置的新中转站模型。\n  保留原授权和预算，由 AI 重新分配任务。';
  const parameters = input({ revisionRequest });
  const inspected = await quote(id, { revisionRequest });
  assert.equal(inspected.status, 200); assert.equal(inspected.data.allowed, true);
  assert.equal(inspected.data.revisionRequest, revisionRequest);
  assert.deepEqual(await state(), before); assert.equal(requests, 0);
  const key = 'adjustment-original-body';
  const generated = await call('/projects/' + id + '/generate', 'POST', parameters, key);
  assert.equal(generated.status, 200, JSON.stringify(generated.data));
  assert.equal(generated.data.revisionRequest, revisionRequest);
  const source = JSON.parse(wire.messages.find((message: any) => message.role === 'user').content);
  assert.equal(source.revisionRequest, revisionRequest);
  assert.deepEqual(source.savedPlan, original);
  assert.match(wire.messages[0].content, /与保存需求中的旧偏好冲突时，以本次调整为准/);
  const preview = (await pool.query('SELECT data FROM organization_previews WHERE id=$1', [generated.data.previewId])).rows[0].data;
  assert.equal(preview.revisionRequest, revisionRequest);
  const project = (await pool.query('SELECT version,requirement,plan,policy FROM projects WHERE id=$1', [id])).rows[0];
  assert.equal(project.version, 1); assert.deepEqual(project.plan, original);
  assert.equal(project.requirement, '通过网页检查并确认方案，生成不会自动保存或执行。');
  assert.equal(project.policy.maxBudget, 1);
  const expected = ((Buffer.byteLength(JSON.stringify({ messages: wire.messages })) + 1024) * 2 + wire.max_tokens * 10) / 1e6;
  assert.equal(inspected.data.reservation, expected);
  const afterGeneration = await state();
  const changed = await call('/projects/' + id + '/generate', 'POST', { ...parameters, revisionRequest: '第二个不同要求' }, key);
  assert.equal(changed.status, 409);
  assert.deepEqual((await call('/projects/' + id + '/generate', 'POST', parameters, key)).data, generated.data);
  assert.deepEqual(await state(), afterGeneration); assert.equal(requests, 1);
  for (const invalid of [null, 7, 'x'.repeat(4001)]) {
    assert.equal((await call('/projects/' + id + '/generate', 'POST', input({ revisionRequest: invalid }))).status, 422);
  }
  assert.equal((await quote(id, { revisionRequest: 'x'.repeat(4001) })).status, 422);
  assert.deepEqual(await state(), afterGeneration); assert.equal(requests, 1);
});
