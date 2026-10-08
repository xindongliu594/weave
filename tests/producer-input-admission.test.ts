import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type pg from 'pg';
import { toolEvidence } from './model-fixture.ts';
import { planningProjectFingerprint } from '../apps/api/src/project-planning.ts';

// Only the integration runner's fresh in-memory PGlite is permitted. No model
// endpoint is started or contacted, and the product database is never opened.
const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
let pool: pg.Pool, app: any, server: http.Server, directory: string, url: string;
let executorChecks = 0;
const modelId = 'producer-input-admission-model', departmentId = 'producer-input-admission-department';
const agent = { id: 'manager', name: 'Fixture', role: 'manager', title: 'Fixture', instructions: 'Only isolated contracts', modelId, tools: ['filesystem', 'artifact_write'] };
const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 600 };
const common = { assigneeId: agent.id, acceptanceCriteria: ['Accepted evidence'], estimatedInputTokens: 100, estimatedOutputTokens: 100 };
const plan = { rationale: 'Pinned producer regression', agents: [agent], tasks: [
  { ...common, id: 'produce', subject: 'Produce current data', objective: 'New output', dependencies: [], outputs: [{ path: 'server.mjs' }] },
  { ...common, id: 'consume', subject: 'Verify accepted data', objective: 'Current accepted input', dependencies: ['produce'], inputs: [{ path: 'server.mjs', producerTaskId: 'produce', sha256: 'a'.repeat(64) }] },
] };

before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /@127\.0\.0\.1:\d+\/postgres$/);
  directory = await mkdtemp(join(tmpdir(), 'producer-input-admission-'));
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)', ['producer-input-fixture-gateway', { name: 'Never contacted', baseUrl: 'http://127.0.0.1:1/v1' }]);
  await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)", [modelId, { name: 'No inference', gatewayId: 'producer-input-fixture-gateway', model: 'fixture', inputRate: 1, outputRate: 1 }, toolEvidence]);
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)', [departmentId, { name: 'Isolated input fixture', description: 'No live data', agents: [agent] }]);
  const { createApp } = await import('../apps/api/src/app.ts');
  app = createApp({ assertExecutorReady: async () => { executorChecks++; throw Error('must never reach execution'); } });
  await app.locals.shutdown();
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
});

after(async () => {
  if (!isolated) return;
  await app?.locals.shutdown();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await pool?.end();
  if (directory) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('producer-input-admission-'));
    await rm(directory, { recursive: true, force: true });
  }
});

async function call(path: string, method = 'GET', body?: any) {
  const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}

test('confirmed candidate reports a pinned producer contract invalid; real approve rejects before enqueue, billing or executor admission', { skip: !isolated }, async () => {
  const projectId = randomUUID(), previewId = randomUUID();
  const original = { ...structuredClone(plan), tasks: [{ ...common, id: 'original', subject: 'Existing draft', objective: 'Retained draft', dependencies: [] }] };
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)', [projectId, departmentId, 'Isolated input fixture', 'Use current producer artifacts', policy, original, 'manual']);
  await pool.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)', [projectId, original, policy]);
  const project = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
  await pool.query('INSERT INTO organization_previews(id,data,project_id) VALUES($1,$2,$3)', [previewId, { kind: 'project-plan', projectId, baseVersion: 1, baseFingerprint: planningProjectFingerprint(project), plan, policy }, projectId]);
  const confirmation = await call('/projects/' + projectId + '/generated-plan/confirm', 'POST', { previewId, version: 1 });
  assert.equal(confirmation.status, 200, JSON.stringify(confirmation.data));
  assert.equal(confirmation.data.validation.valid, false);
  assert.ok(confirmation.data.validation.errors.some((message: string) => message.includes('不能同时指定 producerTaskId 和固定 SHA256')));
  const saved = (await call('/projects')).data.find((item: any) => item.id === projectId);
  assert.equal(saved.version, 2); assert.equal(saved.validation.valid, false);
  assert.equal(saved.plan.tasks[1].inputs[0].sha256, 'a'.repeat(64), 'invalid draft is reviewable without silently rewriting its contract');
  const approval = await call('/projects/' + projectId + '/approve', 'POST', { version: 2 });
  assert.equal(approval.status, 422, JSON.stringify(approval.data));
  assert.equal(approval.data.code, 'PLAN_NOT_READY');
  assert.match(approval.data.message, /不能同时指定 producerTaskId 和固定 SHA256/);
  assert.equal(executorChecks, 0);
  for (const table of ['project_runs', 'usage', 'model_reservations'])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n, 0, table);
});
