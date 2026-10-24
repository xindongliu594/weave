import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

const schema = `manager_chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const originalURL = process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin = new pg.Pool({ connectionString: originalURL });
let pool: pg.Pool, module: typeof import('../apps/api/src/manager-chat.ts'), service: InstanceType<typeof import('../apps/api/src/manager-chat.ts').ManagerChatService>, server: http.Server, provider: http.Server, url: string;
let requests: any[] = [], mode = 'ok';
const plan = { agents: [{ id: 'manager', role: 'manager', modelId: 'model', name: '经理', tools: [] }], tasks: [] };
async function call(path: string, method = 'GET', body?: unknown) { const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
const send = (content: string, maxCost = .02, version = 1) => call('/projects/project/messages', 'POST', { content, version, maxCost });
const history = async () => (await call('/projects/project/messages')).data;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); const target = new URL(originalURL); target.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = target.toString();
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate(); module = await import('../apps/api/src/manager-chat.ts'); await module.migrateManagerChat(pool);
  provider = http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(body.model, 'fixture-manager'); assert.equal(body.tools, undefined);
    res.setHeader('content-type', 'application/json');
    if (mode === 'http-error') { res.statusCode = 503; res.end(JSON.stringify({ message: 'sensitive provider diagnostics must not surface' })); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: mode === 'empty' ? '' : '建议先确认验收标准。' } }], ...(mode === 'missing-usage' ? {} : { usage: { prompt_tokens: 50, completion_tokens: 12 } }) }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  await pool.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)", [{ name: 'Fixture', baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1` }]);
  await pool.query("INSERT INTO models(id,data,status) VALUES('model',$1,'available')", [{ gatewayId: 'gateway', name: 'Fixture manager', model: 'fixture-manager', inputRate: 1, outputRate: 2 }]);
  await pool.query("INSERT INTO departments(id,data) VALUES('department',$1)", [{ name: '研发部', agents: plan.agents }]);
  await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('project','department',1,'研发部','实现一个具备验收标准的任务',$1,$2,'manual')", [{ maxBudget: 5, allowedModelIds: ['model'] }, plan]);
  service = new module.ManagerChatService(pool);
  const app = express(); app.use(express.json()); app.use((_req,res,next)=>{res.locals.principal={kind:'local-owner'};next();}); app.use(module.managerChatRouter()); app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ message: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await service.close(); service = new module.ManagerChatService(pool); requests = []; mode = 'ok';
  await pool.query('DELETE FROM manager_messages'); await pool.query('DELETE FROM usage'); await pool.query('DELETE FROM model_reservations'); await pool.query('DELETE FROM project_runs');
  await pool.query("UPDATE projects SET version=1,policy=$1,plan=$2,status='DRAFT' WHERE id='project'", [{ maxBudget: 5, allowedModelIds: ['model'] }, plan]);
  await pool.query("UPDATE models SET status='available' WHERE id='model'");
});
after(async () => { await service?.close(); for (const instance of [server, provider]) if (instance) await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve())); await pool?.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('manager dialogue persists across workers, includes prior conversation and records billed usage', async () => {
  const first = await send('先确认验收需要哪些材料？'); assert.equal(first.status, 202);
  await service.tick(); let messages = await history(); assert.equal(messages.length, 1); assert.equal(messages[0].status, 'replied'); assert.equal(messages[0].reply, '建议先确认验收标准。'); assert.ok(messages[0].usageId);
  assert.equal(requests.length, 1); assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1', [messages[0].usageId])).rows[0].status, 'settled');
  assert.equal((await pool.query('SELECT purpose FROM usage WHERE id=$1', [messages[0].usageId])).rows[0].purpose, '经理对话');
  await service.close(); service = new module.ManagerChatService(pool);
  assert.equal((await send('按刚才的建议，接口测试放在哪里？')).status, 202); await service.tick(); messages = await history(); assert.equal(messages.length, 2); assert.ok(messages.every((m: any) => m.status === 'replied'));
  const wireHistory = requests[1].messages; assert.ok(wireHistory.some((m: any) => m.role === 'user' && m.content === '先确认验收需要哪些材料？')); assert.ok(wireHistory.some((m: any) => m.role === 'assistant' && m.content === '建议先确认验收标准。'));
  assert.deepEqual((await pool.query("SELECT plan FROM projects WHERE id='project'")).rows[0].plan, plan, 'consultation cannot rewrite the project');
});

test('active runs keep messages waiting; duplicate pending messages are rejected and cancellation persists', async () => {
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES('active','project',1,'running','{}')");
  const pending = await send('运行完成后请解释结果'); assert.equal(pending.status, 202);
  assert.equal((await send('不允许重复排队')).status, 409); await service.tick(); assert.equal(requests.length, 0); assert.equal((await history())[0].status, 'waiting');
  await service.close(); service = new module.ManagerChatService(pool); await service.tick(); assert.equal(requests.length, 0);
  await pool.query("UPDATE project_runs SET status='completed' WHERE id='active'"); await service.tick(); assert.equal(requests.length, 1); assert.equal((await history())[0].status, 'replied');
  const cancelled = await send('取消这条未开始的消息'); assert.equal(cancelled.status, 202); assert.equal((await call('/projects/project/messages/' + cancelled.data.id, 'DELETE', {})).status, 200);
  await service.tick(); assert.equal(requests.length, 1); assert.equal((await history()).find((m: any) => m.id === cancelled.data.id).status, 'cancelled');
});

test('stale project versions, denied model scope and insufficient request budget never call the model', async () => {
  await send('对当前方案给建议'); await pool.query("UPDATE projects SET version=2 WHERE id='project'"); await service.tick(); assert.equal(requests.length, 0); assert.equal((await history())[0].status, 'failed');
  assert.match((await history())[0].error, /方案.*变化/); assert.equal((await send('过时提交', .02, 1)).status, 409);
  await pool.query("UPDATE projects SET version=1,policy=$1 WHERE id='project'", [{ maxBudget: 5, allowedModelIds: [] }]); assert.equal((await send('未授权模型')).status, 422); assert.equal(requests.length, 0);
  await pool.query("UPDATE projects SET policy=$1 WHERE id='project'", [{ maxBudget: 5, allowedModelIds: ['model'] }]); const budget = await send('预算不足不发请求', .000001); assert.equal(budget.status, 202); await service.tick(); assert.equal(requests.length, 0); assert.match((await history()).find((m: any) => m.id === budget.data.id).error, /费用上限/);
});

test('provider failure is not replayed, missing usage stays uncertain and empty reply retains paid usage', async () => {
  mode = 'http-error'; const failed = await send('失败时不自动重播'); await service.tick(); await service.tick(); assert.equal(requests.length, 1);
  let message = (await history()).find((m: any) => m.id === failed.data.id); assert.equal(message.status, 'failed'); assert.ok(!message.error.includes('sensitive provider diagnostics'));
  let reservation = (await pool.query("SELECT * FROM model_reservations WHERE context->>'managerMessageId'=$1", [failed.data.id])).rows[0]; assert.equal(reservation.status, 'uncertain');
  await service.close(); service = new module.ManagerChatService(pool); await service.tick(); assert.equal(requests.length, 1);
  await pool.query("UPDATE model_reservations SET status='released' WHERE id=$1", [reservation.id]);
  mode = 'missing-usage'; const missing = await send('检查缺失用量'); await service.tick(); assert.equal(requests.length, 2); reservation = (await pool.query("SELECT * FROM model_reservations WHERE context->>'managerMessageId'=$1", [missing.data.id])).rows[0]; assert.equal(reservation.status, 'uncertain');
  await pool.query("UPDATE model_reservations SET status='released' WHERE id=$1", [reservation.id]);
  mode = 'empty'; const empty = await send('空回复也要记账'); await service.tick(); assert.equal(requests.length, 3); message = (await history()).find((m: any) => m.id === empty.data.id); assert.equal(message.status, 'failed'); assert.match(message.error, /用量已记录/);
  reservation = (await pool.query("SELECT * FROM model_reservations WHERE context->>'managerMessageId'=$1", [empty.data.id])).rows[0]; assert.equal(reservation.status, 'settled'); assert.equal((await pool.query('SELECT * FROM usage WHERE id=$1', [reservation.id])).rowCount, 1);
  await service.tick(); assert.equal(requests.length, 3);
});

test('queued messages reject changed model and gateway configuration versions before billing', async () => {
  for (const table of ['models', 'gateways']) {
    const pending = await send('请基于发送时的模型配置回答'); assert.equal(pending.status, 202);
    const captured = (await pool.query('SELECT model_version,gateway_version FROM manager_messages WHERE id=$1', [pending.data.id])).rows[0]; assert.ok(captured.model_version); assert.ok(captured.gateway_version);
    await pool.query('UPDATE ' + table + ' SET version=version+1');
    await service.tick();
    const message = (await history()).find((m: any) => m.id === pending.data.id); assert.equal(message.status, 'failed'); assert.match(message.error, /模型或中转站配置已变化/);
    assert.equal(requests.length, 0); assert.equal((await pool.query('SELECT * FROM model_reservations')).rowCount, 0);
  }
});

test('an interrupted in-flight reply becomes failed after recovery without a new paid request', async () => {
  const pending = await send('曾在请求期间退出');
  await pool.query("UPDATE manager_messages SET status='replying',started_at=now()-interval '11 minutes' WHERE id=$1", [pending.data.id]);
  await service.close(); service = new module.ManagerChatService(pool); await service.tick(); assert.equal(requests.length, 0); const message = (await history())[0]; assert.equal(message.status, 'failed'); assert.match(message.error, /核对费用/);
  await service.tick(); assert.equal(requests.length, 0);
});
