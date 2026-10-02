import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

const schema = `automation_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const originalURL = process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin = new pg.Pool({ connectionString: originalURL });
let pool: pg.Pool, module: typeof import('../apps/api/src/automation-learning.ts'), baseUrl: string, server: http.Server;
let now = new Date('2026-01-01T00:00:00Z'), service: InstanceType<typeof import('../apps/api/src/automation-learning.ts').AutomationLearningService>;
let publishCalls = 0, failAfterPublication = false;
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
async function api(path: string, body?: any, method = body === undefined ? 'GET' : 'POST') { const response = await fetch(baseUrl + '/automation' + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(originalURL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  module = await import('../apps/api/src/automation-learning.ts'); await module.migrateAutomationLearning(pool);
  await pool.query("INSERT INTO departments(id,data) VALUES('department',$1)", [{ name: '研发', agents: [{ id: 'employee', name: '工程师' }] }]);
  await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('source','department',1,'研发','测试项目需求与工具范围',$1,$2,'manual')", [{ maxBudget: 1, allowedTools: ['knowledge_read'], allowedKnowledgeSpaceIds: ['space'] }, { agents: [], tasks: [], workFileSelections: [{ id: 'selected-file', version: 2 }], browserScope: ['https://example.org'] }]);
  service = new module.AutomationLearningService(pool, { clock: () => now });
  const app = express(); app.use(express.json()); app.use(module.automationLearningRouter({ db: pool, service, publishKnowledge: async (input, id) => {
    publishCalls++;
    await pool.query('INSERT INTO knowledge_documents(id,space_id,title) VALUES($1,$2,$3)', [id, input.spaceId, input.title]);
    await pool.query('INSERT INTO knowledge_revisions(document_id,version,content,sha256,source) VALUES($1,1,$2,$3,$4)', [id, input.content, digest(input.content), input.source]);
    if (failAfterPublication) { failAfterPublication = false; throw Error('simulated lost response'); }
    return { id, version: 1 };
  } }));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? (error.name === 'ZodError' ? 422 : 500)).json({ message: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await service?.close(); if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await pool?.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('once and missed interval dispatch persist atomic approval drafts without running or broadening scope', async () => {
  const once = await api('/schedules', { name: '单次交付', projectId: 'source', firstDue: now.toISOString(), kind: 'once' }); assert.equal(once.status, 201);
  const interval = await api('/schedules', { name: '每小时检查', projectId: 'source', firstDue: now.toISOString(), kind: 'interval', intervalSeconds: 3600 }); assert.equal(interval.status, 201);
  // Later edits do not silently change an existing schedule's frozen grant/file selections.
  await pool.query('UPDATE projects SET policy=$1,plan=$2,version=2 WHERE id=$3', [{ maxBudget: 999 }, { agents: [], tasks: [] }, 'source']);
  await service.tick(); assert.equal(service.lastError, null);
  await service.tick();
  const created = (await pool.query("SELECT * FROM projects WHERE id<>'source'")).rows;
  assert.equal(created.length, 2); assert.ok(created.every(p => p.status === 'DRAFT' && p.policy.maxBudget === 1));
  assert.deepEqual(created[0].plan.workFileSelections, [{ id: 'selected-file', version: 2 }]);
  assert.deepEqual(created[0].plan.browserScope, ['https://example.org']);
  assert.equal((await pool.query('SELECT * FROM project_runs')).rowCount, 0);
  await service.close(); now = new Date('2026-01-10T00:30:00Z');
  service = new module.AutomationLearningService(pool, { clock: () => now });
  await service.tick(); await service.tick();
  assert.equal((await pool.query('SELECT * FROM automation_occurrences')).rowCount, 3, 'nine missed days coalesce to one draft');
  const row = (await pool.query('SELECT * FROM automation_schedules WHERE id=$1', [interval.body.id])).rows[0];
  assert.equal(new Date(row.next_due).toISOString(), '2026-01-10T01:00:00.000Z');
  assert.equal((await pool.query('SELECT * FROM automation_schedules WHERE id=$1', [once.body.id])).rows[0].status, 'completed');
});

test('pause, resume, cancel and stale version protection persist across service instances', async () => {
  const schedule = (await api('/schedules')).body.find((s: any) => s.kind === 'interval');
  assert.equal((await api('/schedules/' + schedule.id + '/state', { action: 'pause', version: schedule.version })).status, 200);
  assert.equal((await api('/schedules/' + schedule.id + '/state', { action: 'cancel', version: schedule.version })).status, 409);
  now = new Date('2026-01-12T00:00:00Z'); await service.tick(); assert.equal((await pool.query('SELECT * FROM automation_occurrences')).rowCount, 3);
  assert.equal((await api('/schedules/' + schedule.id + '/state', { action: 'resume', version: schedule.version + 1 })).status, 200);
  const otherWorker = new module.AutomationLearningService(pool, { clock: () => now });
  await Promise.all([service.tick(), otherWorker.tick()]); await otherWorker.close();
  assert.equal((await pool.query('SELECT * FROM automation_occurrences')).rowCount, 4);
  const current = (await api('/schedules')).body.find((s: any) => s.id === schedule.id);
  assert.equal((await api('/schedules/' + schedule.id + '/state', { action: 'cancel', version: current.version })).status, 200);
  assert.equal((await api('/schedules/' + schedule.id + '/state', { action: 'resume', version: current.version + 1 })).status, 409);
  now = new Date('2026-01-20T00:00:00Z'); await service.tick(); assert.equal((await pool.query('SELECT * FROM automation_occurrences')).rowCount, 4);
});

async function seedRun(id: string, snapshot: any = {}) {
  await pool.query('INSERT INTO project_runs(id,project_id,project_version,status,snapshot,created_at,started_at,lease_until,attempt) VALUES($1,$2,1,$3,$4,$5,$5,$6,$7)', [id, 'source', 'running', { title: '有界长期任务', approval: { kind: 'project' }, ...snapshot }, '2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z', (await pool.query('SELECT count(*)::int AS count FROM project_runs')).rows[0].count + 1]);
}
test('virtual multi-day supervision survives restart, flags stale leases and emits one terminal unread notification', async () => {
  await seedRun('long-run'); await service.tick(); await service.tick();
  let observations = (await api('/observations')).body.filter((r: any) => r.runId === 'long-run');
  assert.equal(observations.length, 1); assert.equal(observations[0].details.staleLease, true); assert.ok(observations[0].details.ageSeconds > 9 * 86400);
  await service.close(); service = new module.AutomationLearningService(pool, { clock: () => now }); await service.tick();
  assert.equal((await pool.query("SELECT * FROM automation_observations WHERE run_id='long-run'")).rowCount, 1);
  assert.equal((await pool.query("SELECT status FROM project_runs WHERE id='long-run'")).rows[0].status, 'running', 'observer never resumes or mutates execution');
  now = new Date('2026-01-20T01:00:00Z'); await service.tick();
  assert.equal((await pool.query("SELECT * FROM automation_observations WHERE run_id='long-run'")).rowCount, 2);
  await pool.query("UPDATE project_runs SET status='failed',finished_at=$1 WHERE id='long-run'", [now]);
  await service.tick(); await service.close(); service = new module.AutomationLearningService(pool, { clock: () => now }); await service.tick();
  const notices = (await api('/notifications')).body.filter((n: any) => n.details.runId === 'long-run');
  assert.equal(notices.length, 1); assert.equal(notices[0].readAt, null); assert.equal(notices[0].kind, 'attention');
  await api('/notifications/' + notices[0].id + '/read', {}); assert.ok((await api('/notifications')).body.find((n: any) => n.id === notices[0].id).readAt);
});

test('knowledge candidates use approved source versions, deduplicate and never publish to a wider space', async () => {
  const content = '# 验收经验\n必须记录实际运行结果。';
  await pool.query("INSERT INTO knowledge_spaces(id,name,scope,department_id,agent_ids) VALUES('space','部门经验','department','department','[]'),('private-space','其他员工资料','employee','department','[\"other\"]')");
  await pool.query("INSERT INTO knowledge_documents(id,space_id,title) VALUES('document','space','验收过程'),('private-document','private-space','不可访问资料')");
  for (const id of ['document', 'private-document']) await pool.query('INSERT INTO knowledge_revisions(document_id,version,content,sha256) VALUES($1,1,$2,$3)', [id, content, digest(content)]);
  const snapshot = { departmentId: 'department', agents: [{ id: 'employee-1', employeeId: 'employee', sourceAgentId: 'employee', name: '工程师', knowledgeSpaceIds: ['space'] }], knowledge: { documents: [{ documentId: 'document', version: 1, title: '验收过程', spaceId: 'space', sha256: digest(content) }], agentDocuments: { 'employee-1': ['document'] } } };
  await seedRun('knowledge-run', snapshot);
  assert.equal((await api('/knowledge-candidates', { runId: 'knowledge-run', documentId: 'private-document' })).status, 403);
  const first = await api('/knowledge-candidates', { runId: 'knowledge-run', documentId: 'document' }); assert.equal(first.status, 201);
  assert.equal((await api('/knowledge-candidates', { runId: 'knowledge-run', documentId: 'document' })).body.id, first.body.id);
  const candidate = (await api('/knowledge-candidates')).body.find((c: any) => c.id === first.body.id); assert.equal(candidate.spaceId, 'space'); assert.ok(candidate.content.includes(content));
  assert.equal((await api('/knowledge-candidates/' + candidate.id + '/publish', { version: 1, reviewed: false })).status, 422);
  await pool.query("UPDATE knowledge_spaces SET deleted_at=now() WHERE id='space'");
  assert.equal((await api('/knowledge-candidates/' + candidate.id + '/publish', { version: 1, reviewed: true })).status, 422);
  await pool.query("UPDATE knowledge_spaces SET deleted_at=NULL WHERE id='space'");
  await api('/knowledge-candidates/' + candidate.id, { title: '已审查经验', content: '测试结果需要附命令及实际输出。', version: 1, spaceId: 'private-space' }, 'PUT');
  failAfterPublication = true;
  assert.equal((await api('/knowledge-candidates/' + candidate.id + '/publish', { version: 2, reviewed: true })).status, 500);
  assert.equal((await api('/knowledge-candidates/' + candidate.id + '/publish', { version: 2, reviewed: true })).status, 200);
  assert.equal(publishCalls, 1, 'retry recovers the same stable document identity');
  assert.equal((await pool.query('SELECT space_id FROM knowledge_documents WHERE id=$1', [candidate.id])).rows[0].space_id, 'space');
  assert.equal((await api('/knowledge-candidates/' + candidate.id + '/publish', { version: 2, reviewed: true })).status, 200);
  assert.equal(publishCalls, 1);
});

test('fixed evaluation cases retain actual before/after outputs and manual adoption rollback without runtime mutation', async () => {
  const cases = [{ id: 'case1', description: '返回验证结果 JSON', requiredTerms: ['通过'], forbiddenTerms: ['猜测'], jsonKeys: ['result'], maxCharacters: 200 }];
  const create = await api('/improvements', { title: '补充可核验结果', baseline: '直接回答', proposal: '输出含 result 的验收 JSON', sourceRunId: 'long-run', cases }); assert.equal(create.status, 201);
  const id = create.body.id;
  assert.equal((await api('/improvements/' + id + '/review', { action: 'adopt', note: '尚未评测', version: 1 })).status, 422);
  assert.equal((await api('/improvements/' + id + '/evaluate', { responses: [{ caseId: 'wrong', before: '', after: '' }] })).status, 422);
  const evaluation = await api('/improvements/' + id + '/evaluate', { responses: [{ caseId: 'case1', before: '我猜测可以', after: '{"result":"验证通过"}' }] });
  assert.equal(evaluation.status, 201); assert.equal(evaluation.body.modelExecuted, false); assert.equal(evaluation.body.afterScore, 1); assert.ok(evaluation.body.beforeScore < evaluation.body.afterScore);
  const deptBefore = (await pool.query("SELECT data FROM departments WHERE id='department'")).rows[0].data;
  assert.equal((await api('/improvements/' + id + '/review', { action: 'adopt', note: '规则通过；已人工核对输出事实。仅作为待手动应用建议。', version: 1, evaluationId: evaluation.body.id })).status, 200);
  assert.equal((await api('/improvements/' + id + '/review', { action: 'rollback', note: '场景不适合，撤回采纳。', version: 2 })).status, 200);
  assert.deepEqual((await pool.query("SELECT data FROM departments WHERE id='department'")).rows[0].data, deptBefore);
  const history = (await api('/improvements/' + id + '/history')).body;
  assert.equal(history.evaluations.length, 1); assert.equal(history.reviews.length, 2); assert.equal(history.evaluations[0].results.results[0].after.text, '{"result":"验证通过"}');
  assert.equal((await api('/improvements')).body.find((c: any) => c.id === id).status, 'rolled_back');
  const bad = await api('/improvements/' + id + '/evaluate', { responses: [{ caseId: 'case1', before: '{"result":"通过"}', after: '猜测' }] });
  assert.equal((await api('/improvements/' + id + '/review', { action: 'adopt', note: '不应允许分数降低', version: 3, evaluationId: bad.body.id })).status, 422);
});
