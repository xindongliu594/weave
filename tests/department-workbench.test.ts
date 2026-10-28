import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { departmentWorkbenchRouter } from '../apps/api/src/department-workbench.ts';
import { groupWorkbenchItems, workbenchItemLabel, type DepartmentWorkbenchData } from '../apps/web/src/department-workbench-view.ts';

// Use the runner's fresh database and the real schema; the router requires the
// identity and ownership tables too. No scheduler, trace archive or model runs.
assert.equal(process.env.SIMULATED_INTEGRATION, 'pglite', 'Use scripts/test-integration.mjs for an isolated database');
assert.equal(new URL(process.env.DATABASE_URL!).hostname, '127.0.0.1');
const {pool: db, migrate} = await import('../apps/api/src/db.ts');
let server: Server, baseUrl: string;
const ownerHeaders = { 'x-fixture-owner': 'local-owner' };
before(async () => {
  await migrate();
  await db.query(`
    INSERT INTO departments(id,data,deleted_at) VALUES ('research','{}',NULL),('foreign','{}',NULL),('archived','{}',now()),('empty','{}',NULL);
    INSERT INTO models(id,data) VALUES ('workbench-no-model','{}');
    INSERT INTO projects(id,department_id,requirement,version,status,created_at,department_version,department_name,policy,plan,source)
    SELECT id,department_id,requirement,version,status,created_at::timestamptz,1,'Fixture',
      jsonb_build_object('allowedDepartmentIds',jsonb_build_array(department_id)),
      jsonb_build_object('agents',jsonb_build_array(jsonb_build_object('id','reader','sourceDepartmentId',department_id,'sourceAgentId','reader'))),'test'
    FROM (VALUES
      ('draft','research','Same title',2,'DRAFT','2026-10-09T08:01Z'),
      ('active','research','Same title',1,'RUNNING','2026-10-09T08:02Z'),
      ('approval','research','Waiting for a command',1,'RUNNING','2026-10-09T08:03Z'),
      ('failed','research','Historical result retained',1,'FAILED','2026-10-09T08:04Z'),
      ('interrupted','research','Stopped work',1,'INTERRUPTED','2026-10-09T08:05Z'),
      ('completed-label','research','A status without a completed run',1,'COMPLETED','2026-10-09T08:06Z'),
      ('finished','research','Actual completed run',1,'COMPLETED','2026-10-09T08:07Z'),
      ('foreign-project','foreign','Same title',1,'RUNNING','2026-10-09T08:08Z')) fixture(id,department_id,requirement,version,status,created_at);
    INSERT INTO project_runs(id,project_id,project_version,status,error,created_at,finished_at,snapshot,attempt)
    SELECT id,project_id,project_version,status,error,created_at::timestamptz,finished_at::timestamptz,snapshot::jsonb,
      row_number() OVER(PARTITION BY project_id ORDER BY created_at,id)::int
    FROM (VALUES
      ('old-draft-run','draft',1,'failed','Old version error','2026-10-08T08:01Z',NULL,'{"private":"never return snapshot"}'),
      ('active-run','active',1,'running',NULL,'2026-10-09T09:02Z',NULL,'{}'),
      ('approval-run','approval',1,'running',NULL,'2026-10-09T09:03Z',NULL,'{}'),
      ('failed-old-completion','failed',1,'completed',NULL,'2026-10-08T09:04Z','2026-10-08T10:04Z','{}'),
      ('failed-latest','failed',1,'failed','Transport outcome unknown; retained','2026-10-09T09:04Z','2026-10-09T10:04Z','{}'),
      ('interrupted-run','interrupted',1,'interrupted','Service restarted','2026-10-09T09:05Z',NULL,'{}'),
      ('finished-run','finished',1,'completed',NULL,'2026-10-09T09:07Z','2026-10-09T10:07Z','{}'),
      ('foreign-run','foreign-project',1,'running',NULL,'2026-10-09T09:08Z',NULL,'{}')) fixture(id,project_id,project_version,status,error,created_at,finished_at,snapshot);
    INSERT INTO tool_approvals(id,run_id,status,agent_id,tool,arguments)
    SELECT id,run_id,status,'reader','synthetic-workbench-tool','{}'::jsonb FROM (VALUES
      ('one','approval-run','pending'),('two','approval-run','pending'),('past','approval-run','approved'),
      ('stale','failed-latest','pending'),('old-version','old-draft-run','pending'),('foreign','foreign-run','pending')) fixture(id,run_id,status);
    INSERT INTO usage(id,department_id,cost,model_id,input_tokens,output_tokens,purpose)
    SELECT id,department_id,cost,'workbench-no-model',0,0,'Synthetic workbench fixture' FROM (VALUES
      ('u1','research',0.21),('u2','research',0.04),('u3','foreign',19.0)) fixture(id,department_id,cost);
  `);
  const app = express();
  // Test-only identity dependency. The actual router still calls httpPrincipal.
  app.use((_req,res,next) => { if (_req.get('x-fixture-owner') === 'local-owner') res.locals.principal = { kind: 'local-owner' }; next(); });
  app.use('/api', departmentWorkbenchRouter(db));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 400).json({ message: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/department-workbench`;
});
after(async () => { if (server) await new Promise<void>(done => server.close(() => done())); await db.end(); });
async function read(query = 'departmentId=research') {
  const response = await fetch(baseUrl + '?' + query, {headers: ownerHeaders}); assert.equal(response.status, 200);
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
  assert.equal((await fetch(baseUrl + '?departmentId=research')).status, 401, 'the actual router still rejects a missing principal');
  for (const departmentId of ['archived', 'missing']) assert.equal((await fetch(baseUrl + '?departmentId=' + departmentId, {headers: ownerHeaders})).status, 404);
  for (const query of ['departmentId=research&limit=201', 'departmentId=research&offset=-1', 'departmentId=research&limit=2.5', 'departmentId=research&extra=true', 'departmentId=research&departmentId=foreign', ''])
    assert.equal((await fetch(baseUrl + '?' + query, {headers: ownerHeaders})).status, 400, query);
});

test('reads preserve pending approvals, run outcomes and the billing ledger', async () => {
  const before = await db.query('SELECT (SELECT jsonb_agg(a ORDER BY id) FROM tool_approvals a) AS approvals,(SELECT jsonb_agg(r ORDER BY id) FROM project_runs r) AS runs,(SELECT jsonb_agg(u ORDER BY id) FROM usage u) AS usage');
  await read(); await read('departmentId=foreign');
  const after = await db.query('SELECT (SELECT jsonb_agg(a ORDER BY id) FROM tool_approvals a) AS approvals,(SELECT jsonb_agg(r ORDER BY id) FROM project_runs r) AS runs,(SELECT jsonb_agg(u ORDER BY id) FROM usage u) AS usage');
  assert.deepEqual(after.rows, before.rows);
});
