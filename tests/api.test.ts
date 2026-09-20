import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { AddressInfo } from 'node:net';

const schema = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const originalURL = process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin = new pg.Pool({ connectionString: originalURL });
let server: http.Server, gateway: http.Server, pool: pg.Pool, baseUrl: string, gatewayUrl: string, directory: string;
let plannedResponse: unknown;
let requests = 0;
const apps: any[] = [];
before(async () => {
  process.env.ALLOWED_ORIGINS = 'https://deployment.example';
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(originalURL); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
  directory = await mkdtemp(join(tmpdir(), 'ad-test-')); process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  const { createApp } = await import('../apps/api/src/app.ts'); const app = createApp(); apps.push(app); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  gateway = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-key-not-real');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'relay-model-a' }, { id: 'relay-model-b' }] })); return; }
    requests++;
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    assert.equal(body.model, 'relay-model-a');
    await new Promise(r => setTimeout(r, 30));
    const runtimeAssignment = Array.isArray(body.tools) && JSON.stringify(body.messages).includes('AgentTeams automatic task assignment');
    if (runtimeAssignment) {
      const calls = body.messages.flatMap((message: any) => message.tool_calls ?? []);
      const step = calls.length;
      const toolHistory = body.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.content).join('\n');
      const attemptId = /attempt_id ([a-f0-9-]+)/.exec(toolHistory)?.[1];
      const sequence = [
        ['agent_teams_claim_task', { task_id: 't1' }],
        ['agent_teams_update_task', { task_id: 't1', attempt_id: attemptId, status: 'in_progress' }],
        ['agent_teams_update_task', { task_id: 't1', attempt_id: attemptId, status: 'completed', output: '已整理需求范围和验收标准。' }],
        ['agent_teams_send_message', { to: 'captain', content: '任务完成：已整理需求范围和验收标准。' }],
      ] as const;
      if (step < sequence.length) {
        const [name, args] = sequence[step];
        res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: `call-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
      } else res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '本轮任务已完成并汇报。' } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
      return;
    }
    if (Array.isArray(body.tools)) {
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '经理汇总：团队任务已经完成。' } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: body.max_tokens === 16 ? 'OK' : JSON.stringify(plannedResponse) } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
  }).listen(0, '127.0.0.1'); await once(gateway, 'listening'); gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`;
});
after(async () => {
  for (const app of apps) await app.locals.shutdown();
  if (server) await new Promise<void>(r => server.close(() => r()));
  if (gateway) await new Promise<void>(r => gateway.close(() => r()));
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  // Use node:http so proxy/Host tests send the supplied Host on the wire;
  // Node's fetch may replace it with the URL's authority.
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(baseUrl + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }), ...headers } }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode!, data: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}
test('gateway discovery, formal execution, versioned plans and deletion preserve history', async () => {
  const g = await call('/gateways', 'POST', { name: '测试中转站', baseUrl: gatewayUrl, apiKey: 'test-key-not-real' }); assert.equal(g.status, 201);
  const gateways = await call('/gateways'); assert.equal(gateways.data[0].hasCredential, true); assert.equal(JSON.stringify(gateways.data).includes('test-key'), false);
  const encrypted = (await pool.query('SELECT credential FROM gateways')).rows[0].credential; assert.ok(encrypted); assert.notEqual(encrypted, 'test-key-not-real');
  const discovery = await call(`/gateways/${g.data.id}/discover`, 'POST', {}); assert.deepEqual(discovery.data.models, ['relay-model-a', 'relay-model-b']);
  const m = await call('/models', 'POST', { gatewayId: g.data.id, model: 'relay-model-a', name: '模型 A', inputRate: 1, outputRate: 2 }); assert.equal(m.status, 201);
  assert.equal((await call(`/models/${m.data.id}/test`, 'POST', {})).status, 200);
  const agents = [{ id: 'manager', role: 'manager', name: '经理', title: '协调经理', instructions: '协调任务', modelId: m.data.id, tools: ['artifact_write'] }];
  const d = await call('/departments', 'POST', { name: '一次性部门', description: '测试', agents }); assert.equal(d.status, 201);
  const p = await call('/projects', 'POST', { departmentId: d.data.id, requirement: '实现本地 Todo API 并通过自动化测试', policy: { maxBudget: 12, maxAgents: 6, maxConcurrentAgents: 3, deadlineSeconds: 3600 } }); assert.equal(p.status, 201);
  let project = (await call('/projects')).data[0];
  assert.equal(project.validation.valid, true);
  plannedResponse = { ...project.plan, rationale: '来自测试中转站的方案' };
  const callsBefore = requests;
  const parallel = await Promise.all([1, 2].map(() => call(`/projects/${p.data.id}/generate`, 'POST', { modelId: m.data.id, version: 1, maxPlanningCost: 1 })));
  assert.deepEqual(parallel.map(p => p.status).sort(), [200, 409]); assert.equal(requests - callsBefore, 1);
  project = (await call('/projects')).data[0]; assert.equal(project.version, 2); assert.equal(project.source, 'model');
  assert.equal((await call(`/projects/${p.data.id}/plan`, 'PUT', { version: 1, plan: project.plan })).status, 409);
  // Tool execution and permission checks have their own sandbox contract tests.
  const textOnlyPlan = { ...project.plan, agents: project.plan.agents.map((agent: any) => ({ ...agent, tools: [] })) };
  assert.equal((await call(`/projects/${p.data.id}/plan`, 'PUT', { version: 2, plan: textOnlyPlan })).status, 200);
  project = (await call('/projects')).data[0]; assert.equal(project.version, 3);
  const approved = await call(`/projects/${p.data.id}/approve`, 'POST', { version: project.version });
  assert.equal(approved.status, 202);
  assert.equal((await call(`/projects/${p.data.id}/approve`, 'POST', { version: project.version })).status, 200);
  let run = await call(`/runs/${approved.data.id}`);
  for (let i = 0; i < 200 && ['unfinished','queued','running'].includes(run.data.status); i++) { await new Promise(resolve => setTimeout(resolve, 50)); run = await call(`/runs/${approved.data.id}`); }
  assert.equal(run.data.status, 'completed', JSON.stringify(run.data.events.slice(-20).map((event: any) => ({ type: event.type, data: event.data }))));
  assert.equal(run.data.mode, 'product');
  assert.equal(JSON.stringify(run.data.snapshot).includes('test-key-not-real'), false);
  assert.ok(run.data.events.some((event: { type: string }) => event.type === 'team/snapshot'));
  assert.ok(run.data.events.some((event: { type: string }) => event.type === 'billing/usage'));
  assert.equal((await call(`/projects/${p.data.id}/versions`)).data.length, 3);
  assert.equal((await call(`/departments/${d.data.id}`, 'DELETE', { version: 1 })).status, 200);
  assert.equal((await call('/departments')).data.length, 0);
  assert.equal((await call('/projects')).data[0].departmentName, '一次性部门');
  assert.ok((await call('/usage')).data.some((item: { purpose: string }) => item.purpose === '项目执行'));
  assert.equal((await call(`/gateways/${g.data.id}`, 'PUT', { version: 1, name: '新连接配置', baseUrl: gatewayUrl })).status, 200);
  assert.equal((await call('/models')).data[0].status, 'untested');
});
test('dynamic loopback preview can save a gateway through the local proxy', async () => {
  for (const origin of ['http://localhost:54234', 'http://127.0.0.1:54674', 'http://[::1]:55123']) {
    const result = await call('/gateways', 'POST', { name: '预览连接测试', baseUrl: gatewayUrl }, {
      host: 'localhost:4310', origin, 'sec-fetch-site': 'same-origin',
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.ok((await call('/gateways')).data.some((gateway: { id: string }) => gateway.id === result.data.id));
  }
});

test('cross-origin mutations, remote host headers, and malformed data fail closed', async () => {
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://deployment.example', 'sec-fetch-site': 'same-origin' })).status, 422);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://deployment.example', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/departments', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://deployment.example.evil.test', 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://untrusted.example' })).status, 403);
  const deniedOrigins = ['http://localhost:54234', 'http://127.0.0.1:54674'];
  for (const origin of deniedOrigins) {
    for (const site of [undefined, 'same-site', 'cross-site', 'none']) {
      const headers: Record<string, string> = { origin };
      if (site) headers['sec-fetch-site'] = site;
      assert.equal((await call('/gateways', 'POST', {}, headers)).status, 403);
    }
  }
  for (const origin of ['null', 'not-an-origin', 'https://untrusted.example', 'http://localhost.evil.example:54234', 'http://localhost:54234@evil.example', 'http://user@localhost:54234', 'http://localhost:54234/path', 'http://localhost:54234?query=1']) {
    assert.equal((await call('/gateways', 'POST', {}, { origin, 'sec-fetch-site': 'same-origin' })).status, 403);
  }
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'http://localhost:4310', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'https://untrusted.example', 'x-forwarded-host': 'localhost:54234', 'x-forwarded-proto': 'http' })).status, 403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(baseUrl + '/api/health', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await call('/gateways', 'POST', {}, { host: 'untrusted.example', origin: 'http://localhost:54234', 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'http://localhost:4310' })).status, 422);
  assert.equal((await call('/gateways', 'POST', {}, { origin: 'http://127.0.0.1:4311' })).status, 422);
  assert.equal((await call('/departments', 'POST', { name: 'bad', agents: [] })).status, 422);
});

 test('trace verification API persists a run and serves history after recreating the app', async () => {
  const result = await call('/runs/verify', 'POST', {});
  assert.equal(result.status, 201);
  const id = result.data.id;
  const first = await call(`/runs/${id}`);
  assert.equal(first.data.status, 'completed');
  assert.equal(first.data.mode, 'fixture');
  assert.ok(first.data.events.some((e: { type: string }) => e.type === 'model/request'));
  const count = first.data.eventCount;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await apps[0].locals.shutdown();
  const { createApp } = await import('../apps/api/src/app.ts');
  const restoredApp = createApp(); apps.push(restoredApp); server = restoredApp.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await call('/runs')).data[0].id, id);
  const restored = await call(`/runs/${id}`);
  assert.equal(restored.data.eventCount, count);
  assert.deepEqual(restored.data.snapshot, first.data.snapshot);
  const after = await call(`/runs/${id}?after=${count}`);
  assert.equal(after.data.events.length, 0);
  assert.equal((await call('/runs/not-a-run')).status, 422);
  assert.equal((await call('/runs/verify', 'POST', {}, { origin: 'https://untrusted.example' })).status, 403);
});
