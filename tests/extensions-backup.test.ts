import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

const schema = `extensions_backup_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const originalURL = process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin = new pg.Pool({ connectionString: originalURL });
const password = 'test-fixture-password';
const archivedRunId = randomUUID();
let pool: pg.Pool, server: http.Server, url: string, directory: string, backupModule: typeof import('../apps/api/src/backup.ts'), backup: any, documentId: string;
let extensionTables: string[];
async function call(path: string, body: any) { const result = await fetch(url + '/backup/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: result.status, data: await result.json() }; }
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); const dbUrl = new URL(originalURL); dbUrl.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = dbUrl.toString();
  directory = await mkdtemp(join(tmpdir(), 'ad-extensions-backup-')); process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  await mkdir(join(directory, 'runs', archivedRunId, 'artifacts'), { recursive: true }); await writeFile(join(directory, 'runs', archivedRunId, 'artifacts', 'result.txt'), 'Windows 嵌套档案也必须完整保留。');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate(); backupModule = await import('../apps/api/src/backup.ts');
  const automation = await import('../apps/api/src/automation-learning.ts'), chat = await import('../apps/api/src/manager-chat.ts'), browser = await import('../apps/api/src/work-tools-browser.ts'), files = await import('../apps/api/src/work-files.ts');
  extensionTables = [...chat.managerChatTables, ...browser.browserMcpTables, ...files.workFileTables, ...automation.automationTables];
  await pool.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)", [{ name: 'Fixture gateway', baseUrl: 'http://127.0.0.1:1/v1' }]);
  await pool.query("INSERT INTO models(id,data,status) VALUES('model',$1,'available')", [{ name: 'Fixture', gatewayId: 'gateway', model: 'fixture', inputRate: 1, outputRate: 2 }]);
  const agent = { id: 'manager', name: '经理', role: 'manager', title: '经理', modelId: 'model', instructions: '协调项目', tools: [] };
  await pool.query("INSERT INTO departments(id,data) VALUES('department',$1)", [{ name: 'Fixture', agents: [agent] }]);
  const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 300, allowedModelIds: ['model'], allowedTools: [], allowedKnowledgeSpaceIds: [], allowedDepartmentIds: ['department'] }, plan = { agents: [agent], tasks: [] };
  await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('project','department',1,'Fixture','备份扩展功能测试需求',$1,$2,'manual')", [policy, plan]);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES('run','project',1,'completed',$1)", [{ approval: { kind: 'project' }, title: 'Fixture completed', agents: [agent], policy }]);
  await pool.query("INSERT INTO knowledge_spaces(id,name,scope,agent_ids) VALUES('space','经验','company','[]')");
  const knowledge = await import('../apps/api/src/knowledge.ts'); documentId = (await knowledge.saveKnowledgeDocument({ spaceId: 'space', title: '经验来源', content: '测试前应确认版本。' })).id;
  const revision = (await pool.query('SELECT sha256 FROM knowledge_revisions WHERE document_id=$1 AND version=1', [documentId])).rows[0];
  await pool.query("INSERT INTO automation_schedules(id,name,source_project_id,snapshot,kind,interval_seconds,next_due) VALUES('schedule','每日检查','project',$1,'interval',86400,now()+interval '1 day')", [{ department_id: 'department', department_version: 1, department_name: 'Fixture', requirement: '备份扩展功能测试需求', policy, plan }]);
  await pool.query("INSERT INTO automation_occurrences(id,schedule_id,due_at,project_id) VALUES('occurrence','schedule',now(),'project')");
  await pool.query("INSERT INTO automation_notifications(id,event_key,kind,title,details,read_at) VALUES('notification','run:run','success','已完成','{}',now())");
  await pool.query("INSERT INTO automation_observations(id,run_id,bucket,status,details,observed_at) VALUES('observation','run','terminal','completed','{}',now())");
  await pool.query("INSERT INTO automation_knowledge_candidates(id,run_id,document_id,source_version,source_hash,space_id,title,content) VALUES('candidate','run',$1,1,$2,'space','待审查经验','来源摘录')", [documentId, revision.sha256]);
  await pool.query("INSERT INTO automation_improvements(id,title,source_run_id,baseline,proposal,cases,status) VALUES('improvement','改进建议','run','原方案','新方案','[]','adopted')");
  await pool.query("INSERT INTO automation_evaluations(id,improvement_id,results) VALUES('evaluation','improvement','{\"beforeScore\":0,\"afterScore\":1}')");
  await pool.query("INSERT INTO automation_reviews(id,improvement_id,evaluation_id,action,note) VALUES('review','improvement','evaluation','adopt','人工核对通过')");
  await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,status,max_cost,model_id,model_version,gateway_version) VALUES('waiting-message','project',1,'等待经理回复','waiting',0.02,'model',1,1)");
  await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,reply,status,max_cost,model_id,model_version,gateway_version) VALUES('replied-message','project',1,'历史问题','历史答复','replied',0.02,'model',1,1)");
  const vault = await import('../apps/api/src/vault.ts');
  await pool.query("INSERT INTO mcp_connections(id,data,credential,tools) VALUES('mcp',$1,$2,$3)", [{ name: 'Fixture MCP', url: 'http://127.0.0.1:1/mcp', enabled: true, allowedEmployees: [{ departmentId: 'department', agentId: 'manager' }], allowedTools: ['read'] }, vault.seal('fixture-token'), JSON.stringify([{ name: 'read', inputSchema: { type: 'object' } }])]);
  const snapshot = files.prepareWorkFileSnapshot({ name: '导入目录', files: [{ path: 'todo/README.md', base64: Buffer.from('Todo API').toString('base64') }] });
  await pool.query("INSERT INTO work_file_snapshots(id,name,files,bytes) VALUES('files',$1,$2,$3)", [snapshot.name, JSON.stringify(snapshot.files), snapshot.bytes]);
  const app = express(); app.use(express.json({ limit: '45mb' })); app.use(backupModule.backupRouter(join(directory, 'runs'))); app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ message: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await pool?.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); if (directory) await rm(directory, { recursive: true, force: true }); });

test('extension tables survive encrypted backup while scheduled dispatch and pending chat require fresh user action', async () => {
  const exported = await call('export', { password }); assert.equal(exported.status, 200, JSON.stringify(exported.data)); backup = exported.data;
  const plain = await backupModule.decryptBackup(backup, password);
  assert.equal(Buffer.from(plain.files[archivedRunId + '/artifacts/result.txt'], 'base64').toString(), 'Windows 嵌套档案也必须完整保留。');
  assert.ok(Object.keys(plain.vaultFiles).length > 0); assert.ok(Object.keys(plain.vaultFiles).every(key => !key.includes('\\')), 'vault paths are portable relative paths');
  for (const table of extensionTables) assert.ok(plain.tables[table].length > 0, `${table} is included`);
  assert.equal(plain.tables.automation_schedules[0].status, 'active');
  await pool.query("UPDATE automation_schedules SET name='Changed',status='cancelled'"); await pool.query("UPDATE work_file_snapshots SET name='Changed'");
  const restored = await call('restore', { password, backup, confirmation: 'RESTORE' }); assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal((await pool.query("SELECT name,status FROM automation_schedules WHERE id='schedule'")).rows[0].status, 'paused');
  assert.equal((await pool.query("SELECT name FROM automation_schedules WHERE id='schedule'")).rows[0].name, '每日检查');
  const messages = (await pool.query('SELECT id,status,reply,error FROM manager_messages')).rows;
  assert.equal(messages.find(m => m.id === 'waiting-message').status, 'cancelled'); assert.match(messages.find(m => m.id === 'waiting-message').error, /重新发送/);
  assert.equal(messages.find(m => m.id === 'replied-message').reply, '历史答复'); assert.equal(messages.find(m => m.id === 'replied-message').status, 'replied');
  assert.equal((await pool.query("SELECT name,files FROM work_file_snapshots WHERE id='files'")).rows[0].files[0].path, 'todo/README.md');
  assert.equal((await pool.query('SELECT * FROM automation_reviews')).rows[0].note, '人工核对通过');
  assert.ok((await pool.query('SELECT read_at FROM automation_notifications')).rows[0].read_at);
  const vault = await import('../apps/api/src/vault.ts'); assert.equal(vault.unseal((await pool.query("SELECT credential FROM mcp_connections WHERE id='mcp'")).rows[0].credential), 'fixture-token');
  assert.equal((await pool.query('SELECT document_id FROM automation_knowledge_candidates')).rows[0].document_id, documentId);
  assert.equal(await readFile(join(directory, 'runs', archivedRunId, 'artifacts', 'result.txt'), 'utf8'), 'Windows 嵌套档案也必须完整保留。');
});

test('active paid manager replies block export and restore before any database replacement', async () => {
  await pool.query("UPDATE manager_messages SET status='replying',started_at=now() WHERE id='waiting-message'");
  const exported = await call('export', { password }); assert.equal(exported.status, 409); assert.match(exported.data.message, /经理回复/);
  const restored = await call('restore', { password, backup, confirmation: 'RESTORE' }); assert.equal(restored.status, 409); assert.match(restored.data.message, /经理回复/);
  assert.equal((await pool.query("SELECT status FROM manager_messages WHERE id='waiting-message'")).rows[0].status, 'replying');
  await pool.query("UPDATE manager_messages SET status='cancelled' WHERE id='waiting-message'");
});

test('legacy backups without extension tables restore with empty defaults rather than stale extension records', async () => {
  const legacy = await backupModule.decryptBackup(backup, password); for (const table of extensionTables) delete legacy.tables[table];
  const result = await call('restore', { password, backup: await backupModule.encryptBackup(legacy, password), confirmation: 'RESTORE' }); assert.equal(result.status, 200, JSON.stringify(result.data));
  for (const table of extensionTables) assert.equal((await pool.query('SELECT * FROM ' + table)).rowCount, 0, `${table} is reset to the old backup's empty state`);
  assert.equal((await pool.query("SELECT id FROM projects WHERE id='project'")).rowCount, 1);
});
