import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pool, migrate } from '../../apps/api/src/db.ts';
import { backupRouter } from '../../apps/api/src/backup.ts';
import { knowledgeRouter } from '../../apps/api/src/knowledge.ts';
import { knowledgeSnapshot, queryKnowledge, attachRunInputs } from '../../apps/api/src/knowledge-store.ts';
import { runManagementRouter } from '../../apps/api/src/run-management.ts';
import { budgetHistory } from '../../apps/api/src/budget-history.ts';
import { createRunArchive, readRun } from '../../services/agent-runtime/trace-store.mjs';
import { buildCheckpointContext, recoveryContext, readRecoveryContext } from '../../services/agent-runtime/checkpoint-context.mjs';

const [phase, experimentDirectory] = process.argv.slice(2);
assert.ok(['source', 'restore', 'reopen'].includes(phase));
const dataDirectory = resolve(process.env.DATA_DIR!), traceRoot = resolve(process.env.TRACE_ROOT!);
assert.equal(relative(resolve(experimentDirectory), dataDirectory), phase === 'source' ? 'source' : 'target');
assert.equal(process.env.SIMULATED_INTEGRATION, 'pglite');
const passphrase = 'isolated-data-fixture-only';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
await migrate();
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/api', knowledgeRouter()); app.use('/api', backupRouter(traceRoot)); app.use('/api', runManagementRouter(traceRoot));
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ code: error.code, message: error.message }));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${(server.address() as any).port}/api`;
const checks: string[] = [];
async function call(path: string, method = 'GET', body?: any) {
  const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
async function files(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function walk(current: string) { for (const item of await readdir(current, { withFileTypes: true })) { const path = join(current, item.name); if (item.isDirectory()) await walk(path); else if (item.isFile()) hashes[relative(directory, path).replaceAll('\\', '/')] = hash(await readFile(path)); } }
  await walk(directory); return hashes;
}
let fixture: any;
try {
  if (phase === 'source') {
    const manager = { id: 'manager', name: '资料检查员', role: 'manager', modelId: 'fixture-model', instructions: '隔离资料实验', tools: ['knowledge_search', 'knowledge_read'], knowledgeSpaceIds: [] as string[] };
    const other = { ...manager, id: 'other', name: '私有资料检查员', role: 'member', knowledgeSpaceIds: [] as string[] };
    await pool.query("INSERT INTO gateways(id,data) VALUES('fixture-gateway',$1)", [{ name: 'Unused data fixture', baseUrl: 'http://127.0.0.1:1/v1' }]);
    await pool.query("INSERT INTO models(id,data,status) VALUES('fixture-model',$1,'available')", [{ name: 'Unused data fixture', gatewayId: 'fixture-gateway', model: 'not-called', inputRate: 1, outputRate: 1 }]);
    await pool.query("INSERT INTO departments(id,data) VALUES('fixture-department',$1)", [{ name: '隔离数据测试', agents: [manager, other] }]);
    const company = await call('/knowledge/spaces', 'POST', { name: '共享测试资料', scope: 'company' }); assert.equal(company.status, 201);
    const privateSpace = await call('/knowledge/spaces', 'POST', { name: '私有测试资料', scope: 'employee', departmentId: 'fixture-department', agentIds: ['other'] }); assert.equal(privateSpace.status, 201);
    const shared = await call('/knowledge/documents', 'POST', { spaceId: company.data.id, title: '固定版本测试', content: 'oldneedle：恢复必须引用已批准的版本一。\n测试资料，不是项目交付。' }); assert.equal(shared.status, 201);
    const secret = await call('/knowledge/documents', 'POST', { spaceId: privateSpace.data.id, title: '授权隔离测试', content: 'privateneedle：仅 other 员工可见。' }); assert.equal(secret.status, 201);
    manager.knowledgeSpaceIds = [company.data.id]; other.knowledgeSpaceIds = [privateSpace.data.id];
    await pool.query("UPDATE departments SET data=$1 WHERE id='fixture-department'", [{ name: '隔离数据测试', agents: [manager, other] }]);
    const denied = { ...manager, knowledgeSpaceIds: [privateSpace.data.id] };
    await assert.rejects(knowledgeSnapshot([denied], 'fixture-department'), (error: any) => error.code === 'KNOWLEDGE_GRANT_INVALID');
    const runId = randomUUID();
    const knowledge = attachRunInputs(await knowledgeSnapshot([manager, other], 'fixture-department'), [{ id: 'brief', title: '单员工临时输入', content: 'inputneedle：运行专用资料。', agentIds: ['manager'] }], [manager, other], runId);
    const found = (await queryKnowledge(knowledge, 'manager', 'search', 'oldneedle'))[0]; assert.equal(found.version, 1);
    const privateHit = (await queryKnowledge(knowledge, 'other', 'search', 'privateneedle'))[0]; assert.equal(privateHit.documentId, secret.data.id);
    assert.deepEqual(await queryKnowledge(knowledge, 'manager', 'search', 'privateneedle'), []);
    assert.equal(await queryKnowledge(knowledge, 'manager', 'read', privateHit.id), undefined);
    const input = (await queryKnowledge(knowledge, 'manager', 'search', 'inputneedle'))[0];
    assert.equal(await queryKnowledge(knowledge, 'other', 'read', input.id), undefined);
    assert.equal((await pool.query('SELECT id FROM knowledge_chunks WHERE id=$1', [input.id])).rowCount, 0);
    checks.push('Company, employee-private and run-input grants filter both search and direct reads; invalid grant rejected.');
    const policy = { maxBudget: 1, maxAgents: 2, maxConcurrentAgents: 1, deadlineSeconds: 300, allowedModelIds: ['fixture-model'], allowedTools: ['knowledge_search', 'knowledge_read'], allowedKnowledgeSpaceIds: [company.data.id, privateSpace.data.id], allowedDepartmentIds: ['fixture-department'] };
    const tasks = [{ id: 'research', assignee: 'manager', dependencies: [] }, { id: 'review', assignee: 'other', dependencies: ['research'] }];
    const snapshot = { projectId: 'fixture-project', projectVersion: 1, departmentId: 'fixture-department', departmentIds: ['fixture-department'], agents: [manager, other], tasks, knowledge, policy, title: 'Isolated data fixture (no model execution)' };
    await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('fixture-project','fixture-department',1,'隔离数据测试','验证资料与备份，不运行模型',$1,$2,'manual')", [policy, { agents: [manager, other], tasks }]);
    await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,started_at) VALUES($1,'fixture-project',1,'interrupted',$2,now())", [runId, snapshot]);
    await pool.query("INSERT INTO usage(id,model_id,project_id,run_id,agent_id,task_id,input_tokens,output_tokens,cost,purpose) VALUES('fixture-usage','fixture-model','fixture-project',$1,'manager','research',10,5,0.002,'synthetic-data-fixture')", [runId]);
    const archive = createRunArchive(traceRoot, snapshot, { id: runId });
    archive.append('model/request', { fixture: true }, { taskId: 'research', sessionId: 'fixture-session' });
    archive.append('model/wire-request', { taskId: 'research', fixture: true }, { sessionId: 'fixture-session' });
    const citation = { documentId: found.documentId, version: found.version, chunkId: found.id, title: found.title, sha256: found.sha256 };
    archive.append('knowledge/citation', { agentId: 'manager', sources: [citation] }, { taskId: 'research', sessionId: 'fixture-session' });
    archive.append('knowledge/citation', { agentId: 'manager', sources: [{ documentId: input.documentId, version: input.version, chunkId: input.id, sha256: input.sha256 }] }, { taskId: 'research' });
    archive.append('run/finished', { status: 'interrupted', fixture: true });
    const nestedFile = join(archive.dir, 'artifacts', 'nested', 'data-fixture.txt'); await mkdir(join(archive.dir, 'artifacts', 'nested'), { recursive: true });
    await writeFile(nestedFile, '备份文件完整性测试资料；不是员工产出的 Todo 交付物。\n');
    const run = readRun(traceRoot, runId)!;
    const recovery = buildCheckpointContext(snapshot, run.events, new Map([['research', { status: 'in_progress' }]]), new Map(), join(archive.dir, 'artifacts'), runId);
    const resumed = createRunArchive(traceRoot, { ...snapshot, recovery });
    await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,parent_run_id,attempt) VALUES($1,'fixture-project',1,'cancelled',$2,$3,2)", [resumed.id, { ...snapshot, recovery }, runId]);
    assert.equal(recoveryContext({ ...snapshot, recovery }, 'research')!.current.citations[0].sha256, found.sha256);
    const downstream = readRecoveryContext({ ...snapshot, recovery }, resumed.dir, 'review', { taskId: 'research' });
    assert.equal(downstream.text.includes(found.id), false);
    checks.push('Task recovery context retains citation metadata; downstream context does not expose upstream private history.');
    const updated = await call(`/knowledge/documents/${shared.data.id}`, 'PUT', { spaceId: company.data.id, title: '当前版本二', content: 'newneedle：这是新版本，不能取代旧引用。', version: 1 }); assert.equal(updated.status, 200);
    const interactive = await call('/knowledge/search', 'POST', { departmentId: 'fixture-department', agentId: 'manager', query: 'newneedle' }); assert.equal(interactive.data[0].version, 2);
    assert.equal((await queryKnowledge(knowledge, 'manager', 'read', found.id)).content, found.content);
    assert.equal((await call(`/runs/${runId}/citations/${found.id}`)).data.version, 1);
    checks.push('Interactive retrieval sees version 2; approved run and citation API still return version 1.');
    const exported = await call('/backup/export', 'POST', { password: passphrase }); assert.equal(exported.status, 200);
    await writeFile(join(experimentDirectory, 'fixture-backup.json'), JSON.stringify(exported.data));
    const knowledgePaths = (await pool.query('SELECT vault_path FROM knowledge_documents ORDER BY id')).rows.map(row => row.vault_path);
    fixture = { runId, resumedRunId: resumed.id, documentId: found.documentId, chunkId: found.id, version: 1, sha256: found.sha256, content: found.content, inputChunkId: input.id, knowledgePaths, traceFiles: await files(traceRoot), vaultFiles: await files(join(dataDirectory, 'vault')), budget: await budgetHistory(pool, traceRoot, 'fixture-project', 1), databaseCounts: {} as Record<string, number> };
    for (const table of ['departments', 'projects', 'project_runs', 'usage', 'knowledge_spaces', 'knowledge_documents', 'knowledge_revisions', 'knowledge_chunks']) fixture.databaseCounts[table] = (await pool.query('SELECT * FROM ' + table)).rowCount!;
    await writeFile(join(experimentDirectory, 'fixture.json'), JSON.stringify(fixture, null, 2));
  } else {
    fixture = JSON.parse(await readFile(join(experimentDirectory, 'fixture.json'), 'utf8'));
    if (phase === 'restore') {
      assert.equal((await pool.query('SELECT * FROM projects')).rowCount, 0);
      const backup = JSON.parse(await readFile(join(experimentDirectory, 'fixture-backup.json'), 'utf8'));
      const wrong = await call('/backup/restore', 'POST', { password: 'incorrect-fixture-password', backup, confirmation: 'RESTORE' }); assert.equal(wrong.status, 422);
      assert.equal((await pool.query('SELECT * FROM projects')).rowCount, 0);
      checks.push('Destination starts empty; wrong backup password rejected before replacement.');
      const restored = await call('/backup/restore', 'POST', { password: passphrase, backup, confirmation: 'RESTORE' }); assert.equal(restored.status, 200, JSON.stringify(restored.data));
      checks.push('Product restore API loads source encrypted backup into a different database and directory.');
    }
    for (const [table, count] of Object.entries(fixture.databaseCounts)) assert.equal((await pool.query('SELECT * FROM ' + table)).rowCount, count);
    assert.deepEqual(await files(traceRoot), fixture.traceFiles);
    const vault = await files(join(dataDirectory, 'vault'));
    for (const path of fixture.knowledgePaths) assert.equal(vault[path], fixture.vaultFiles[path]);
    const run = readRun(traceRoot, fixture.runId)!; assert.equal(run.integrity, 'ok'); assert.equal(run.status, 'interrupted'); assert.equal(run.snapshot.tasks.length, 2);
    const citation = await call(`/runs/${fixture.runId}/citations/${fixture.chunkId}`); assert.equal(citation.status, 200); assert.equal(citation.data.version, 1); assert.equal(citation.data.content, fixture.content); assert.equal(citation.data.sha256, fixture.sha256);
    const restoredInput = await call(`/runs/${fixture.runId}/citations/${fixture.inputChunkId}`); assert.equal(restoredInput.status, 200); assert.match(restoredInput.data.content, /inputneedle/);
    const resumed = readRun(traceRoot, fixture.resumedRunId)!;
    const brief = recoveryContext(resumed.snapshot, 'research')!; assert.equal(brief.current.citations[0].sha256, fixture.sha256);
    const page = readRecoveryContext(resumed.snapshot, join(traceRoot, fixture.resumedRunId), 'research'); assert.ok(page.text);
    assert.deepEqual(await budgetHistory(pool, traceRoot, 'fixture-project', 1), fixture.budget);
    assert.equal((await pool.query('SELECT sum(cost)::float8 AS cost FROM usage')).rows[0].cost, 0.002);
    checks.push('Key row counts, complete DAG, synthetic budget/call bookkeeping, journal integrity, nested file and Vault SHA-256 hashes match source.');
    checks.push('Recovered citation endpoint and task recovery context reference version 1; per-run input citation remains available.');
    if (phase === 'reopen') checks.push('A fresh process reopens the persisted target database and repeats all restored-data checks.');
  }
  await writeFile(join(experimentDirectory, `${phase}.json`), JSON.stringify({ phase, status: 'passed', dataDirectory, runId: fixture.runId, resumedRunId: fixture.resumedRunId, databaseCounts: fixture.databaseCounts, traceFiles: fixture.traceFiles, knowledgePaths: fixture.knowledgePaths, fixedCitation: { documentId: fixture.documentId, chunkId: fixture.chunkId, version: fixture.version, sha256: fixture.sha256 }, syntheticBudgetHistory: fixture.budget, checks }, null, 2));
  console.log(`PASS ${phase}: ${checks.length} check groups; run ${fixture.runId}; directory ${dataDirectory}`);
} finally { await new Promise<void>(accept => server.close(() => accept())); await pool.end(); }
