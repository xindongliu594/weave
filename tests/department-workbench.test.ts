import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { departmentWorkbenchRouter } from '../apps/api/src/department-workbench.ts';
import { groupWorkbenchItems, workbenchItemLabel, type DepartmentWorkbenchData } from '../apps/web/src/department-workbench-view.ts';

// An in-memory PostgreSQL-compatible database and a test-owned HTTP listener.
// No application database, trace archive, model, scheduler or device is opened.
const db = new PGlite();
let server: Server, baseUrl: string;
before(async () => {
  await db.exec(`
    CREATE TABLE departments(id text PRIMARY KEY,deleted_at timestamptz);
    CREATE TABLE projects(id text PRIMARY KEY,department_id text,requirement text,version int,status text,created_at timestamptz);
    CREATE TABLE project_runs(id text PRIMARY KEY,project_id text,project_version int,status text,error text,
      created_at timestamptz,finished_at timestamptz,cancel_requested boolean DEFAULT false,snapshot jsonb);
    CREATE TABLE tool_approvals(id text PRIMARY KEY,run_id text,status text);
    CREATE TABLE usage(id text PRIMARY KEY,department_id text,cost numeric);
    INSERT INTO departments VALUES ('research',NULL),('foreign',NULL),('archived',now()),('empty',NULL);
    INSERT INTO projects VALUES
      ('draft','research','Same title',2,'DRAFT','2026-10-09T08:01Z'),
      ('active','research','Same title',1,'RUNNING','2026-10-09T08:02Z'),
      ('approval','research','Waiting for a command',1,'RUNNING','2026-10-09T08:03Z'),
      ('failed','research','Historical result retained',1,'FAILED','2026-10-09T08:04Z'),
      ('interrupted','research','Stopped work',1,'INTERRUPTED','2026-10-09T08:05Z'),
      ('completed-label','research','A status without a completed run',1,'COMPLETED','2026-10-09T08:06Z'),
      ('finished','research','Actual completed run',1,'COMPLETED','2026-10-09T08:07Z'),
      ('foreign-project','foreign','Same title',1,'RUNNING','2026-10-09T08:08Z');
    INSERT INTO project_runs(id,project_id,project_version,status,error,created_at,finished_at,snapshot) VALUES
      ('old-draft-run','draft',1,'failed','Old version error','2026-10-08T08:01Z',NULL,'{"private":"never return snapshot"}'),
      ('active-run','active',1,'running',NULL,'2026-10-09T09:02Z',NULL,'{}'),
      ('approval-run','approval',1,'running',NULL,'2026-10-09T09:03Z',NULL,'{}'),
      ('failed-old-completion','failed',1,'completed',NULL,'2026-10-08T09:04Z','2026-10-08T10:04Z','{}'),
      ('failed-latest','failed',1,'failed','Transport outcome unknown; retained','2026-10-09T09:04Z','2026-10-09T10:04Z','{}'),
      ('interrupted-run','interrupted',1,'interrupted','Service restarted','2026-10-09T09:05Z',NULL,'{}'),
      ('finished-run','finished',1,'completed',NULL,'2026-10-09T09:07Z','2026-10-09T10:07Z','{}'),
      ('foreign-run','foreign-project',1,'running',NULL,'2026-10-09T09:08Z',NULL,'{}');
    INSERT INTO tool_approvals VALUES
      ('one','approval-run','pending'),('two','approval-run','pending'),('past','approval-run','approved'),
      ('stale','failed-latest','pending'),('old-version','old-draft-run','pending'),('foreign','foreign-run','pending');
    INSERT INTO usage VALUES ('u1','research',0.21),('u2','research',0.04),('u3','foreign',19.0);
  `);
  const app = express(); app.use('/api', departmentWorkbenchRouter(db));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 400).json({ message: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/department-workbench`;
});
after(async () => { if (server) await new Promise<void>(done => server.close(() => done())); await db.close(); });
async function read(query = 'departmentId=research') {
  const response = await fetch(baseUrl + '?' + query); assert.equal(response.status, 200);
  return await response.json() as DepartmentWorkbenchData;
}

test('real IDs and current plan versions isolate departments, pending approvals and costs', async () => {
  const data = await read();
  assert.deepEqual(data.summary, { total: 7, backlog: 1, running: 1, attention: 4, completed: 2, pendingApprovals: 2, recordedCost: 0.25 });
  assert.equal(data.items.length, 7); assert.equal(data.hasMore, false);
  assert.equal(data.items.find(item => item.id === 'draft')!.latestRun, null, 'an old run cannot become the new plan current run');
  assert.equal(data.items.find(item => item.id === 'active')!.latestRun!.id, 'active-run', 'same titles do not join');
  assert.equal(data.items.find(item => item.id === 'approval')!.latestRun!.pendingApprovalCount, 2);
  assert.equal(data.items.find(item => item.id === 'failed')!.latestRun!.pendingApprovalCount, 0, 'terminal approvals are not actionable');
  assert.doesNotMatch(JSON.stringify(data), /never return snapshot|foreign-run|old-draft-run/);
});

test('completed history never masks the latest failure or invents a delivery from a project label', async () => {
  const data = await read(), groups = groupWorkbenchItems(data.items);
  assert.deepEqual(groups.completed.map(item => item.id), ['finished', 'failed']);
  assert.equal(groups.attention.find(item => item.id === 'failed')!.latestRun!.id, 'failed-latest');
  assert.equal(groups.completed.find(item => item.id === 'failed')!.completedRun!.id, 'failed-old-completion');
  assert.equal(groups.completed.some(item => item.id === 'completed-label'), false);
  assert.equal(groups.attention.some(item => item.id === 'completed-label'), true);
  assert.equal(workbenchItemLabel(data.items.find(item => item.id === 'completed-label')!), '完成状态需要核对');
  assert.equal(workbenchItemLabel(data.items.find(item => item.id === 'approval')!), '2 项工具操作待审批');
  assert.match(workbenchItemLabel(data.items.find(item => item.id === 'interrupted')!), /检查恢复条件/);
});

test('bounded pages retain department-wide counts and deterministic ordering', async () => {
  const first = await read('departmentId=research&limit=2&offset=0');
  const second = await read('departmentId=research&limit=2&offset=2');
  assert.equal(first.items.length, 2); assert.equal(first.hasMore, true);
  assert.deepEqual(first.items.map(item => item.id), ['finished', 'completed-label']);
  assert.equal(second.items.length, 2); assert.deepEqual(first.summary, second.summary);
  assert.equal(first.items.some(item => second.items.some(other => other.id === item.id)), false);
  const beyond = await read('departmentId=research&offset=20');
  assert.deepEqual(beyond.items, []); assert.equal(beyond.hasMore, false); assert.equal(beyond.summary.total, 7);
});

test('empty departments load, archived or absent departments and invalid bounds are rejected', async () => {
  const empty = await read('departmentId=empty'); assert.equal(empty.summary.total, 0); assert.deepEqual(empty.items, []);
  for (const departmentId of ['archived', 'missing']) assert.equal((await fetch(baseUrl + '?departmentId=' + departmentId)).status, 404);
  for (const query of ['departmentId=research&limit=201', 'departmentId=research&offset=-1', 'departmentId=research&limit=2.5', 'departmentId=research&extra=true', 'departmentId=research&departmentId=foreign', ''])
    assert.equal((await fetch(baseUrl + '?' + query)).status, 400, query);
});

test('reads preserve pending approvals, run outcomes and the billing ledger', async () => {
  const before = await db.query('SELECT (SELECT jsonb_agg(a ORDER BY id) FROM tool_approvals a) AS approvals,(SELECT jsonb_agg(r ORDER BY id) FROM project_runs r) AS runs,(SELECT jsonb_agg(u ORDER BY id) FROM usage u) AS usage');
  await read(); await read('departmentId=foreign');
  const after = await db.query('SELECT (SELECT jsonb_agg(a ORDER BY id) FROM tool_approvals a) AS approvals,(SELECT jsonb_agg(r ORDER BY id) FROM project_runs r) AS runs,(SELECT jsonb_agg(u ORDER BY id) FROM usage u) AS usage');
  assert.deepEqual(after.rows, before.rows);
});
