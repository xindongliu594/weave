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
const schema = 'organization_update_' + Date.now(), admin = new pg.Pool({ connectionString: base });
let pool: pg.Pool, app: any, server: http.Server, url: string, directory: string, modelId: string;
async function call(path: string, body?: unknown) {
  const response = await fetch(url + path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body) } : undefined);
  return { status: response.status, data: await response.json() as any };
}
async function preview(name = '为伍需求组') {
  const agents = [{ id: 'manager', name: '需求经理', role: 'manager', title: '需求经理', instructions: '核对需求并汇总可验证的交付。', modelId, tools: [] }];
  const department = { name, description: '持续对话形成的团队', agents };
  const plan = { agents, rationale: '先确认需求，保存后由用户批准执行。', tasks: [{ id: 'clarify', subject: '整理需求', objective: '整理需求、约束与验收标准。', assigneeId: 'manager', dependencies: [], acceptanceCriteria: ['列出明确的交付和待确认事项'], estimatedInputTokens: 100, estimatedOutputTokens: 100, kind: 'requirements' }] };
  const draft = { department, plan, requirement: '整理一份团队需求说明，确认目标、边界和验收依据。', policy: { maxBudget: 10, maxAgents: 2, maxConcurrentAgents: 1, deadlineSeconds: 300, allowedModelIds: [modelId], allowedTools: [] }, source: 'model' };
  const previewId = randomUUID(); await pool.query('INSERT INTO organization_previews(id,data) VALUES($1,$2)', [previewId, draft]);
  return { ...draft, previewId };
}
const counts = async () => (await pool.query('SELECT (SELECT count(*)::int FROM departments) AS departments,(SELECT count(*)::int FROM projects) AS projects,(SELECT count(*)::int FROM project_runs) AS runs')).rows[0];
const targetOf = (saved: any) => ({ departmentId: saved.departmentId, projectId: saved.projectId, departmentVersion: saved.departmentVersion, projectVersion: saved.projectVersion });

before(async () => {
  await admin.query('CREATE SCHEMA ' + schema); const connection = new URL(base); connection.searchParams.set('options', '-c search_path=' + schema); process.env.DATABASE_URL = connection.toString();
  directory = await mkdtemp(join(tmpdir(), 'organization-update-')); process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate(); const { createApp } = await import('../apps/api/src/app.ts'); app = createApp(); await app.locals.shutdownBackground();
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api';
  const gateway = await call('/gateways', { name: '固定配置，不发模型请求', baseUrl: 'http://127.0.0.1:45999/v1' });
  const model = await call('/models', { name: '固定模型', model: 'fixture', gatewayId: gateway.data.id, inputRate: .1, outputRate: .2 }); modelId = model.data.id;
  await pool.query("UPDATE models SET status='available' WHERE id=$1", [modelId]);
});
after(async () => {
  await app?.locals.shutdown(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await pool?.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end();
  if (directory) { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'organization-update-')); await rm(directory, { recursive: true, force: true }); }
});

test('confirming a revised proposal updates the same team and draft project, records versions, and never executes', async () => {
  const before = await counts(), first = await preview(), created = await call('/organizations', first);
  assert.equal(created.status, 201); assert.equal(created.data.departmentVersion, 1); assert.equal(created.data.projectVersion, 1);
  const second = await preview('为伍分析团队'), target = targetOf(created.data);
  const updated = await call('/organizations', { ...second, target }); assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.departmentId, target.departmentId); assert.equal(updated.data.projectId, target.projectId); assert.equal(updated.data.departmentVersion, 2); assert.equal(updated.data.projectVersion, 2);
  assert.deepEqual(await counts(), { departments: before.departments + 1, projects: before.projects + 1, runs: before.runs });
  const department = (await call('/departments')).data.find((row: any) => row.id === target.departmentId); assert.equal(department.name, '为伍分析团队'); assert.equal(department.agents[0].id, 'manager');
  const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [target.projectId])).rows[0]; assert.equal(project.status, 'DRAFT'); assert.equal(project.department_version, 2);
  assert.equal((await pool.query('SELECT * FROM department_versions WHERE department_id=$1', [target.departmentId])).rowCount, 2);
  assert.equal((await pool.query('SELECT * FROM plan_versions WHERE project_id=$1', [target.projectId])).rowCount, 3);
  const replay = await call('/organizations', { ...second, target }); assert.equal(replay.status, 200); assert.equal(replay.data.existing, true); assert.equal(replay.data.departmentVersion, 2);
  const third = await preview('不能覆盖的新名字'), stale = await call('/organizations', { ...third, target }); assert.equal(stale.status, 409); assert.equal(stale.data.code, 'VERSION_CONFLICT');
  assert.equal((await pool.query('SELECT department_id FROM organization_previews WHERE id=$1', [third.previewId])).rows[0].department_id, null);
});

test('execution state, archived teams and mismatched project ownership refuse an update without partial writes', async () => {
  const created = await call('/organizations', await preview()), target = targetOf(created.data), next = await preview('未批准更新');
  const unchanged = (await pool.query('SELECT data,version FROM departments WHERE id=$1', [target.departmentId])).rows[0];
  await pool.query("UPDATE projects SET status='COMPLETED' WHERE id=$1", [target.projectId]);
  const active = await call('/organizations', { ...next, target }); assert.equal(active.status, 409); assert.equal(active.data.code, 'PROJECT_ACTIVE');
  await pool.query("UPDATE projects SET status='DRAFT' WHERE id=$1", [target.projectId]);
  await pool.query('UPDATE departments SET deleted_at=now() WHERE id=$1', [target.departmentId]); assert.equal((await call('/organizations', { ...next, target })).status, 404);
  await pool.query('UPDATE departments SET deleted_at=NULL WHERE id=$1', [target.departmentId]);
  const other = await call('/organizations', await preview()); assert.equal((await call('/organizations', { ...next, target: { ...target, projectId: other.data.projectId } })).status, 404);
  assert.deepEqual((await pool.query('SELECT data,version FROM departments WHERE id=$1', [target.departmentId])).rows[0], unchanged);
});

test('all adopted planning charges count toward the updated budget and transfer only after successful confirmation', async () => {
  const first = await preview(), oldUsage = randomUUID();
  await pool.query("INSERT INTO usage(id,model_id,input_tokens,output_tokens,cost,purpose,planning_preview_id) VALUES($1,$2,10,10,2.6,'组织需求对话',$3)", [oldUsage, modelId, first.previewId]);
  const created = await call('/organizations', first), target = targetOf(created.data), second = await preview(), newUsage = randomUUID();
  await pool.query("INSERT INTO usage(id,model_id,input_tokens,output_tokens,cost,purpose,planning_preview_id) VALUES($1,$2,10,10,1.2,'组织需求对话',$3)", [newUsage, modelId, second.previewId]);
  second.policy.maxBudget = 3; const rejected = await call('/organizations', { ...second, target }); assert.equal(rejected.status, 422);
  assert.equal((await pool.query('SELECT project_id FROM usage WHERE id=$1', [newUsage])).rows[0].project_id, null);
  assert.equal((await pool.query('SELECT version FROM departments WHERE id=$1', [target.departmentId])).rows[0].version, 1);
  second.policy.maxBudget = 5; const updated = await call('/organizations', { ...second, target }); assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal((await pool.query('SELECT project_id FROM usage WHERE id=$1', [newUsage])).rows[0].project_id, target.projectId);
  assert.equal(Number((await pool.query('SELECT sum(cost) AS total FROM usage WHERE project_id=$1', [target.projectId])).rows[0].total), 3.8);
});

test('revisions still require preview identity and explicit tool permissions', async () => {
  const created = await call('/organizations', await preview()), target = targetOf(created.data), next = await preview();
  const { previewId, ...noPreview } = next; assert.equal((await call('/organizations', { ...noPreview, target })).status, 422);
  (next.department.agents[0].tools as string[]).push('filesystem'); const denied = await call('/organizations', { ...next, target }); assert.equal(denied.status, 422); assert.equal(denied.data.code, 'POLICY_PERMISSION_DENIED');
  assert.equal((await pool.query('SELECT version FROM departments WHERE id=$1', [target.departmentId])).rows[0].version, 1);
  assert.equal((await pool.query('SELECT department_id FROM organization_previews WHERE id=$1', [previewId])).rows[0].department_id, null);
});

test('pending and uncertain project charges block a revision before any budget or team change', async () => {
  const created = await call('/organizations', await preview()), target = targetOf(created.data), next = await preview(), reservation = randomUUID();
  next.policy.maxBudget = 1;
  await pool.query("INSERT INTO model_reservations(id,model_id,project_id,department_id,purpose,amount,input_rate,output_rate) VALUES($1,$2,$3,$4,'旧方案规划',2,0.1,0.2)", [reservation, modelId, target.projectId, target.departmentId]);
  for (const status of ['pending', 'uncertain']) {
    await pool.query('UPDATE model_reservations SET status=$1 WHERE id=$2', [status, reservation]);
    const result = await call('/organizations', { ...next, target }); assert.equal(result.status, 409); assert.equal(result.data.code, 'COST_PENDING');
    assert.equal((await pool.query('SELECT version FROM departments WHERE id=$1', [target.departmentId])).rows[0].version, 1);
    assert.equal((await pool.query('SELECT version FROM projects WHERE id=$1', [target.projectId])).rows[0].version, 1);
    assert.equal((await pool.query('SELECT department_id FROM organization_previews WHERE id=$1', [next.previewId])).rows[0].department_id, null);
  }
  await pool.query("UPDATE model_reservations SET status='released' WHERE id=$1", [reservation]);
  assert.equal((await call('/organizations', { ...next, target })).status, 200);
});

test('a team participating in another active project cannot be changed through a saved conversation', async () => {
  const created = await call('/organizations', await preview()), target = targetOf(created.data), other = await call('/organizations', await preview()), next = await preview(), runId = randomUUID();
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids) VALUES($1,$2,1,'running',$3,$4)", [runId, other.data.projectId, { departmentId: other.data.departmentId, departmentIds: [other.data.departmentId, target.departmentId], executionBudget: 0 }, [other.data.departmentId, target.departmentId]]);
  const rejected = await call('/organizations', { ...next, target }); assert.equal(rejected.status, 409); assert.equal(rejected.data.code, 'DEPARTMENT_ACTIVE');
  assert.equal((await pool.query('SELECT version FROM departments WHERE id=$1', [target.departmentId])).rows[0].version, 1);
  assert.equal((await pool.query('SELECT version FROM projects WHERE id=$1', [other.data.projectId])).rows[0].version, 1);
  await pool.query("UPDATE project_runs SET status='completed' WHERE id=$1", [runId]);
  assert.equal((await call('/organizations', { ...next, target })).status, 200);
});

test('employee prompt revisions advance role versions while replay and unchanged roles preserve them', async () => {
  const initial = await preview(); Object.assign(initial.department.agents[0], { roleVersion: 1 });
  const created = await call('/organizations', initial), target = targetOf(created.data), next = await preview();
  Object.assign(next.department.agents[0], { roleVersion: 1, instructions: '新增资料溯源职责，逐项标记依据与待确认事项。' });
  const changed = await call('/organizations', { ...next, target }); assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const project = (await pool.query('SELECT plan FROM projects WHERE id=$1', [target.projectId])).rows[0]; assert.equal(project.plan.agents[0].roleVersion, 2);
  assert.equal((await pool.query('SELECT data FROM departments WHERE id=$1', [target.departmentId])).rows[0].data.agents[0].roleVersion, 2);
  const replay = await call('/organizations', { ...next, target }); assert.equal(replay.status, 200, JSON.stringify(replay.data)); assert.equal(replay.data.existing, true);
  const unchanged = await preview('改名不改变员工职责'); Object.assign(unchanged.department.agents[0], next.department.agents[0]);
  const renamed = await call('/organizations', { ...unchanged, target: targetOf(changed.data) }); assert.equal(renamed.status, 200);
  assert.equal((await pool.query('SELECT data FROM departments WHERE id=$1', [target.departmentId])).rows[0].data.agents[0].roleVersion, 2);
});
