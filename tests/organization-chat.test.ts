import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

const base = process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const schema = 'organization_chat_' + Date.now(), admin = new pg.Pool({ connectionString: base });
let pool: pg.Pool, app: any, server: http.Server, gateway: http.Server, url: string, directory: string, modelId: string, otherModelId: string;
let response: unknown, wire: any, requests = 0;
const policy = { maxBudget: 1, maxAgents: 3, maxConcurrentAgents: 2, deadlineSeconds: 300 };
const firstMessage = { role: 'user', content: '我想做一个适合团队使用的工具。' };
const input = (patch: any = {}) => ({ modelId, policy, messages: [firstMessage], ...patch });
async function call(path: string, body: unknown, key?: string) { const result = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) }); return { status: result.status, data: await result.json() as any }; }
const counts = async () => (await pool.query('SELECT (SELECT count(*)::int FROM departments) AS departments,(SELECT count(*)::int FROM projects) AS projects,(SELECT count(*)::int FROM project_runs) AS runs,(SELECT count(*)::int FROM organization_previews) AS previews')).rows[0];
const agent = (id: string, role = 'member', tools: string[] = []) => ({ id, role, name: role === 'manager' ? '需求经理' : '开发员工', title: role === 'manager' ? '项目经理' : '开发工程师', instructions: '明确职责、记录依据并遵守批准范围。', modelId, tools });
function candidate() { return { department: { name: '需求研究部', description: '把目标转化为可批准计划。', agents: [agent('manager', 'manager')] }, rationale: '先明确用户需要的交付与验收，再授权实现。', tasks: [{ id: 'requirements', subject: '整理需求与实现计划', objective: '形成可编辑的接口范围和验收标准，不运行命令。', assigneeId: 'manager', dependencies: [], acceptanceCriteria: ['明确接口范围、使用者和验收方式'], estimatedInputTokens: 300, estimatedOutputTokens: 200, kind: 'requirements' }] }; }
function implementationCandidate() {
  const team = [agent('manager', 'manager'), agent('developer', 'member', ['filesystem', 'artifact_write', 'terminal_test']), agent('reviewer', 'member', ['filesystem', 'terminal_test'])];
  return { department: { name: 'Todo 研发部', description: '独立实现和测试。', agents: team }, rationale: '开发先产出，再由独立员工验收，经理汇总。', tasks: [
    { id: 'implement', subject: '开发 Todo API', objective: '在批准目录实现 Todo 接口与测试。', assigneeId: 'developer', dependencies: [], acceptanceCriteria: ['接口自检通过'], estimatedInputTokens: 500, estimatedOutputTokens: 400, kind: 'implementation', inputs: [], outputs: [{ path: 'todo.mjs' }, { path: 'smoke.test.mjs' }], inScope: ['todo.mjs', 'smoke.test.mjs'], verify: ['node --test smoke.test.mjs'] },
    { id: 'review', subject: '独立检查实现', objective: '读取开发文件并实际运行已授权的验证命令，返回审查结论。', assigneeId: 'reviewer', dependencies: ['implement'], acceptanceCriteria: ['读取当前产物并核对真实命令结果'], estimatedInputTokens: 500, estimatedOutputTokens: 200, kind: 'review', reviewedTaskId: 'implement', inputs: [{ path: 'todo.mjs', producerTaskId: 'implement' }, { path: 'smoke.test.mjs', producerTaskId: 'implement' }], outputs: [], verify: ['node --test smoke.test.mjs'], maxReworkRounds: 0 },
    { id: 'deliver', subject: '经理汇总验收', objective: '汇总审查结论、使用方法和未完成项。', assigneeId: 'manager', dependencies: ['review'], acceptanceCriteria: ['清楚区分通过项与未完成项'], estimatedInputTokens: 200, estimatedOutputTokens: 200, kind: 'work' },
  ] };
}
before(async () => {
  await admin.query('CREATE SCHEMA ' + schema); const connection = new URL(base); connection.searchParams.set('options', '-c search_path=' + schema); process.env.DATABASE_URL = connection.toString();
  directory = await mkdtemp(join(tmpdir(), 'organization-chat-')); process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate(); const { createApp } = await import('../apps/api/src/app.ts'); app = createApp(); await app.locals.shutdown(); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api';
  gateway = http.createServer(async (req, res) => { assert.equal(req.url, '/v1/chat/completions'); let raw = ''; for await (const chunk of req) raw += chunk; wire = JSON.parse(raw); requests++; assert.equal(wire.model, 'fixture-model'); assert.equal(wire.tools, undefined); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: typeof response === 'string' ? response : JSON.stringify(response) } }], usage: { prompt_tokens: 40, completion_tokens: 15 } })); });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const saved = await call('/gateways', { name: '组织对话固定服务', baseUrl: 'http://127.0.0.1:' + (gateway.address() as AddressInfo).port + '/v1' });
  for (const name of ['selected', 'other']) { const added = await call('/models', { name, model: name === 'selected' ? 'fixture-model' : 'fixture-other', gatewayId: saved.data.id, inputRate: .1, outputRate: .2 }); assert.equal(added.status, 201, JSON.stringify(added.data)); if (name === 'selected') modelId = added.data.id; else otherModelId = added.data.id; }
  await pool.query("UPDATE models SET status='available'");
});
after(async () => { await app?.locals.shutdown(); for (const current of [server, gateway]) if (current) { current.closeAllConnections(); await new Promise<void>(r => current.close(() => r())); } await pool?.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); if (directory) { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'organization-chat-')); await rm(directory, { recursive: true, force: true }); } });

test('clarification replies retain global billed usage and do not create departments, previews or runs', async () => {
  response = { reply: '这个工具主要解决什么问题？' }; const before = await counts(), beforeCalls = requests;
  const result = await call('/organizations/chat', input()); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(result.data, response); assert.deepEqual(await counts(), before); assert.equal(requests, beforeCalls + 1);
  const usage = (await pool.query("SELECT * FROM usage WHERE purpose='组织需求对话'")).rows.at(-1); assert.ok(Number(usage.cost) > 0); assert.equal(usage.planning_preview_id, null); assert.equal(usage.project_id, null);
  assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1', [usage.id])).rows[0].status, 'settled');
});

test('second round uses conversation context but only user messages become the saved requirement; preview saves idempotently', async () => {
  response = { reply: '已整理一份待确认的需求团队草案，保存后可继续配置。', candidate: candidate() };
  const messages = [firstMessage, { role: 'assistant', content: 'ASSISTANT_CONTEXT_ONLY：谁来使用？' }, { role: 'user', content: '团队内部用，希望有 Todo 增删改查，先整理接口和验收需求。' }];
  const before = await counts(), key = randomUUID(); const result = await call('/organizations/chat', input({ messages }), key); assert.equal(result.status, 200, JSON.stringify(result.data)); const preview = result.data.preview; assert.equal(preview.validation.valid, true); assert.equal(preview.source, 'model'); assert.ok(preview.requirement.includes(firstMessage.content)); assert.ok(preview.requirement.includes(messages[2].content)); assert.ok(!preview.requirement.includes('ASSISTANT_CONTEXT_ONLY'));
  assert.deepEqual(wire.messages.slice(-3), messages); assert.equal(wire.messages[1].role, 'system'); const constraints = JSON.parse(wire.messages[1].content); assert.equal(constraints.templateReference.name, '软件研发部'); assert.deepEqual(constraints.availableModels.map((m: any) => m.id), [modelId]); assert.deepEqual(preview.policy.allowedTools, []); assert.deepEqual(preview.policy.allowedKnowledgeSpaceIds, []);
  let after = await counts(); assert.equal(after.previews, before.previews + 1); assert.equal(after.departments, before.departments); assert.equal(after.runs, before.runs);
  const billed = (await pool.query('SELECT id FROM usage WHERE planning_preview_id=$1', [preview.previewId])).rows; assert.equal(billed.length, 1);
  const priorRequests = requests, repeated = await call('/organizations/chat', input({ messages }), key); assert.equal(repeated.data.preview.previewId, preview.previewId); assert.equal(requests, priorRequests);
  const created = await call('/organizations', preview); assert.equal(created.status, 201, JSON.stringify(created.data)); const savedAgain = await call('/organizations', preview); assert.equal(savedAgain.status, 200); assert.equal(savedAgain.data.existing, true); assert.equal(savedAgain.data.projectId, created.data.projectId);
  const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [created.data.projectId])).rows[0]; assert.equal(project.status, 'DRAFT'); assert.equal(project.source, 'model'); assert.equal((await pool.query('SELECT project_id FROM usage WHERE id=$1', [billed[0].id])).rows[0].project_id, project.id); assert.equal((await pool.query('SELECT * FROM plan_versions WHERE project_id=$1', [project.id])).rowCount, 2);
  after = await counts(); assert.equal(after.departments, before.departments + 1); assert.equal(after.projects, before.projects + 1); assert.equal(after.runs, before.runs);
});

test('only explicitly granted filesystem tools produce a valid implementation and independent review draft', async () => {
  response = { reply: '可以按这个实现与独立验收流程组建团队，等待你保存并批准。', candidate: implementationCandidate() };
  const before = await counts(); const result = await call('/organizations/chat', input({ policy: { ...policy, allowedTools: ['filesystem', 'artifact_write', 'terminal_test'] }, messages: [{ role: 'user', content: '开发一个 Node Todo API，需要实际代码、自检以及另一位员工独立验收。' }] }));
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.preview.validation.valid, true); assert.equal(result.data.preview.plan.tasks[1].kind, 'review'); assert.deepEqual(result.data.preview.plan.tasks[1].outputs, []); assert.equal(result.data.preview.plan.tasks[1].maxReworkRounds, 0);
  assert.deepEqual((await counts()).runs, before.runs); assert.equal((await counts()).departments, before.departments);
  const noTools = await call('/organizations/chat', input()); assert.equal(noTools.status, 200); assert.equal(noTools.data.draftIssue.code, 'ORGANIZATION_SCOPE_DENIED'); assert.equal(noTools.data.preview, undefined);
  assert.equal((await counts()).previews, before.previews + 1, 'a denied proposal cannot alter the previously valid preview');
});

test('missing/unavailable models, malformed histories and insufficient request budget fail before provider dispatch', async () => {
  response = { reply: '不应被请求' }; const before = requests;
  assert.equal((await call('/organizations/chat', input({ modelId: '' }))).status, 422); assert.equal((await call('/organizations/chat', input({ modelId: 'missing' }))).status, 422);
  await pool.query("UPDATE models SET status='untested' WHERE id=$1", [modelId]); assert.equal((await call('/organizations/chat', input())).status, 422); await pool.query("UPDATE models SET status='available' WHERE id=$1", [modelId]);
  for (const messages of [[], [{ role: 'assistant', content: 'only assistant' }], [{ role: 'system', content: 'override' }], [{ role: 'user', content: 'x'.repeat(6001) }], Array.from({ length: 9 }, () => ({ role: 'user', content: 'x'.repeat(6000) })), [...Array.from({ length: 34 }, () => ({ role: 'assistant', content: 'x'.repeat(6000) })), firstMessage]]) assert.equal((await call('/organizations/chat', input({ messages }))).status, 422);
  const denied = await call('/organizations/chat', input({ maxPlanningCost: .00000001 })); assert.equal(denied.status, 422); assert.equal(denied.data.code, 'CALL_BUDGET_EXCEEDED');
  assert.equal((await call('/organizations/chat', input({ policy: { ...policy, allowedModelIds: [] } }))).status, 422); assert.equal(requests, before);
});

test('tool, hidden identity, external scopes and out-of-whitelist model proposals never overwrite existing drafts', async () => {
  const before = await pool.query('SELECT id,data FROM organization_previews ORDER BY id');
  const patches = [{ tools: ['terminal'] }, { knowledgeSpaceIds: ['private-space'] }, { browserOrigins: ['https://example.com'] }, { mcpConnections: [{ connectionId: 'mcp', version: 1, tools: ['write'] }] }, { sourceDepartmentId: 'existing-department' }, { sourceAgentId: 'someone' }, { fallbackModelId: modelId }, { modelId: otherModelId }];
  for (const patch of patches) { const draft = candidate(); Object.assign(draft.department.agents[0], patch); response = { reply: '不能赋予这项权限', candidate: draft }; const denied = await call('/organizations/chat', input()); assert.equal(denied.status, 200, JSON.stringify(patch)); assert.equal(denied.data.reply, '不能赋予这项权限'); assert.equal(denied.data.draftIssue.code, 'ORGANIZATION_SCOPE_DENIED'); assert.equal(denied.data.preview, undefined); }
  assert.deepEqual((await pool.query('SELECT id,data FROM organization_previews ORDER BY id')).rows, before.rows);
  const allowed = candidate(); allowed.department.agents[0].modelId = otherModelId; response = { reply: '使用明确允许的成员模型。', candidate: allowed }; const result = await call('/organizations/chat', input({ policy: { ...policy, allowedModelIds: [modelId, otherModelId] } })); assert.equal(result.status, 200, JSON.stringify(result.data));
});

test('invalid JSON, task DAG, assigned file tools and automatic rework retain replies and billed usage without publishing drafts', async () => {
  const before = await counts(), beforeUsage = Number((await pool.query('SELECT count(*) AS count FROM usage')).rows[0].count);
  response = '{"reply":'; assert.equal((await call('/organizations/chat', input())).data.draftIssue.code, 'ORGANIZATION_CHAT_INVALID');
  const cyclic: any = candidate(); cyclic.tasks[0].dependencies = ['requirements']; response = { reply: '错误循环', candidate: cyclic }; assert.equal((await call('/organizations/chat', input())).data.draftIssue.code, 'ORGANIZATION_CHAT_PLAN_INVALID');
  const filePlan: any = implementationCandidate(); filePlan.department.agents.find((a: any) => a.id === 'reviewer').tools = []; response = { reply: '员工未获读取工具', candidate: filePlan }; const permission = await call('/organizations/chat', input({ policy: { ...policy, allowedTools: ['filesystem', 'artifact_write', 'terminal_test'] } })); assert.equal(permission.status, 200); assert.equal(permission.data.draftIssue.code, 'ORGANIZATION_CHAT_PLAN_INVALID');
  const rework: any = implementationCandidate(); rework.tasks[1].maxReworkRounds = 1; response = { reply: '自行增加返工', candidate: rework }; assert.equal((await call('/organizations/chat', input({ policy: { ...policy, allowedTools: ['filesystem', 'artifact_write', 'terminal_test'] } }))).data.draftIssue.code, 'ORGANIZATION_SCOPE_DENIED');
  assert.deepEqual(await counts(), before); assert.equal(Number((await pool.query('SELECT count(*) AS count FROM usage')).rows[0].count), beforeUsage + 4);
});

test('revision context includes stored employee IDs and task DAG without inheriting old permissions', async () => {
  const allowedPolicy = { ...policy, allowedTools: ['filesystem', 'artifact_write', 'terminal_test'] };
  response = { reply: '请看右侧方案。', candidate: implementationCandidate() };
  const original = await call('/organizations/chat', input({ policy: allowedPolicy })); assert.equal(original.status, 200, JSON.stringify(original.data));
  const previousPreviewId = original.data.preview.previewId;
  const stored = (await pool.query('SELECT data FROM organization_previews WHERE id=$1', [previousPreviewId])).rows[0].data;
  const changed = implementationCandidate(); changed.department.agents[1].title = '后端工程师'; response = { reply: '只调整开发岗位名称，其余沿用。', candidate: changed };
  const messages = [firstMessage, { role: 'assistant', content: '请看右侧方案。' }, { role: 'user', content: '只将开发岗位名称改为后端工程师，保留其余员工、任务和依赖。' }];
  const revised = await call('/organizations/chat', input({ messages, policy: allowedPolicy, previousPreviewId })); assert.equal(revised.status, 200, JSON.stringify(revised.data));
  const material = JSON.parse(wire.messages[2].content); assert.equal(wire.messages[2].role, 'user'); assert.equal(material.kind, 'previous_organization_draft'); assert.deepEqual(material.department.agents, stored.department.agents); assert.deepEqual(material.plan.tasks, stored.plan.tasks); assert.equal(material.policy, undefined); assert.deepEqual(wire.messages.slice(-3), messages);
  assert.notEqual(revised.data.preview.previewId, previousPreviewId); assert.equal(revised.data.preview.department.agents[1].title, '后端工程师'); assert.deepEqual((await pool.query('SELECT data FROM organization_previews WHERE id=$1', [previousPreviewId])).rows[0].data, stored);
  const denied = await call('/organizations/chat', input({ messages, previousPreviewId })); assert.equal(denied.status, 200); assert.equal(denied.data.draftIssue.code, 'ORGANIZATION_SCOPE_DENIED'); assert.deepEqual(JSON.parse(wire.messages[1].content).policy.allowedTools, []);
  const beforeCalls = requests, before = await counts(); const missing = await call('/organizations/chat', input({ previousPreviewId: randomUUID() })); assert.equal(missing.status, 404); assert.equal(missing.data.code, 'ORGANIZATION_PREVIEW_NOT_FOUND'); assert.equal(requests, beforeCalls); assert.deepEqual(await counts(), before);
});

test('natural consultation, fenced replies and explicit null candidates continue without a draft or extra calls', async () => {
  const before = await counts(), beforeCalls = requests;
  const reply = '我是为伍，可以先帮你分担具体事务。你希望另一个自己首先处理哪类工作？持续执行还需要明确预算、监督和暂停条件。';
  const messages = [firstMessage, { role: 'assistant', content: '你希望团队主要帮你做什么？' }, { role: 'user', content: '我想让你变成另一个我，然后7*24小时工作' }];
  for (const body of [reply, JSON.stringify(reply), { reply, candidate: null }, '```json\n' + JSON.stringify({ reply }) + '\n```']) {
    response = body; const result = await call('/organizations/chat', input({ messages })); assert.equal(result.status, 200); assert.deepEqual(result.data, { reply });
  }
  assert.deepEqual(await counts(), before); assert.equal(requests, beforeCalls + 4); assert.match(wire.messages[0].content, /你叫为伍/); assert.match(wire.messages[0].content, /不能保证/);
  response = '给你一份方案：\n```json\n' + JSON.stringify({ reply: '团队已整理，等你确认。', candidate: candidate() }) + '\n```';
  const ready = await call('/organizations/chat', input({ messages })); assert.equal(ready.status, 200); assert.ok(ready.data.preview); assert.equal(ready.data.reply, '团队已整理，等你确认。');
});

test('partial candidates preserve useful replies, never render JSON fragments, and remain idempotent', async () => {
  const before = await counts(), beforeCalls = requests, beforeUsage = Number((await pool.query('SELECT count(*) AS count FROM usage')).rows[0].count);
  const reply = '可以先从日程整理和材料归档两个方向讨论。';
  response = { reply, candidate: { department: { name: '个人助理部' } } }; const key = randomUUID();
  const partial = await call('/organizations/chat', input(), key); assert.equal(partial.status, 200); assert.equal(partial.data.reply, reply); assert.equal(partial.data.draftIssue.code, 'ORGANIZATION_CHAT_PLAN_INVALID'); assert.equal(partial.data.preview, undefined);
  const retried = await call('/organizations/chat', input(), key); assert.deepEqual(retried.data, partial.data); assert.equal(requests, beforeCalls + 1);
  for (const candidate of [false, 0, '']) { response = { reply, candidate }; const malformed = await call('/organizations/chat', input()); assert.equal(malformed.status, 200); assert.equal(malformed.data.reply, reply); assert.equal(malformed.data.draftIssue.code, 'ORGANIZATION_CHAT_PLAN_INVALID'); assert.equal(malformed.data.preview, undefined); }
  response = '{"reply":' + JSON.stringify(reply) + ',"candidate":{"department":'; const truncated = await call('/organizations/chat', input()); assert.equal(truncated.status, 200); assert.equal(truncated.data.reply, reply); assert.equal(truncated.data.draftIssue.code, 'ORGANIZATION_CHAT_INVALID');
  for (const broken of ['{"reply":', '```json\n{"candidate":', null, '', { reply: '{"candidate":broken}', candidate: null }, ['unexpected']]) {
    response = broken; const result = await call('/organizations/chat', input()); assert.equal(result.status, 200); assert.equal(result.data.preview, undefined); assert.equal(result.data.draftIssue.code, 'ORGANIZATION_CHAT_INVALID'); assert.ok(!/[{}]|```/.test(result.data.reply), result.data.reply);
  }
  assert.deepEqual(await counts(), before); assert.equal(Number((await pool.query('SELECT count(*) AS count FROM usage')).rows[0].count), beforeUsage + 11);
});

test('long conversations retain all user requirements but send bounded recent context and earlier user excerpts', async () => {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (let i = 0; i < 35; i++) messages.push({ role: 'user', content: `USER_${i}_` + '需求'.repeat(200) }, { role: 'assistant', content: `ASSISTANT_${i}_` + '说明'.repeat(500) });
  messages.push({ role: 'user', content: '最后请整理目前已经说明的分工方案。' }); response = { reply: '已按讨论整理待确认方案。', candidate: candidate() };
  const result = await call('/organizations/chat', input({ messages })); assert.equal(result.status, 200, JSON.stringify(result.data));
  const requirement = result.data.preview.requirement; for (let i = 0; i < 35; i++) assert.ok(requirement.includes(`USER_${i}_`)); assert.ok(!requirement.includes('ASSISTANT_')); assert.equal(requirement, messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n'));
  const historical = JSON.parse(wire.messages[2].content); assert.equal(historical.kind, 'earlier_user_requirements'); assert.equal(historical.truncated, true); assert.ok(historical.content.includes('USER_0_')); assert.ok(!historical.content.includes('ASSISTANT_')); assert.ok(historical.content.length <= 8000);
  const recent = wire.messages.slice(3); assert.ok(recent.length <= 20); assert.ok(recent.reduce((n: number, m: any) => n + m.content.length, 0) <= 24000); assert.equal(recent.at(-1).content, messages.at(-1)!.content);
  const saved = await call('/organizations', result.data.preview); assert.equal(saved.status, 201, JSON.stringify(saved.data)); assert.equal((await pool.query('SELECT requirement FROM projects WHERE id=$1', [saved.data.projectId])).rows[0].requirement, requirement);
});

test('oversized prior previews use a marked bounded reference without sending truncated JSON to the model', async () => {
  const previewId = randomUUID(), previous = { department: candidate().department, plan: { agents: candidate().department.agents, rationale: 'reference', tasks: candidate().tasks }, requirement: '历史需求'.repeat(12000), policy };
  await pool.query('INSERT INTO organization_previews(id,data) VALUES($1,$2)', [previewId, previous]); response = { reply: '原方案内容较多，我们先明确这次要调整的岗位。' };
  const result = await call('/organizations/chat', input({ previousPreviewId: previewId })); assert.equal(result.status, 200); assert.equal(result.data.preview, undefined);
  const reference = JSON.parse(wire.messages[2].content); assert.equal(reference.detailsOmitted, true); assert.deepEqual(reference.taskIds, ['requirements']); assert.equal(reference.agents[0].id, 'manager'); assert.ok(wire.messages[2].content.length < 32000); assert.deepEqual((await pool.query('SELECT data FROM organization_previews WHERE id=$1', [previewId])).rows[0].data, previous);
});
