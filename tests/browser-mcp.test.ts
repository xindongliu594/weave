import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import express from 'express';
import {migrateIdentity} from '../apps/api/src/identity-schema.ts';
import {migrateRestoreControlFixture} from './helpers/restore-control-schema.ts';

const schema = `test_browser_mcp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const databaseUrl = process.env.DATABASE_URL!;
const admin = new pg.Pool({ connectionString: databaseUrl });
let mod: typeof import('../apps/api/src/work-tools-browser.ts'), pool: pg.Pool, directory: string;
let service: http.Server, appServer: http.Server, baseUrl: string, serviceUrl: string;
let mode = 'json', calls = 0, posts = 0, initialized = 0, escapedOriginRequests = 0;
const secret = 'mcp-test-secret-only';
const exposedTools = [
  { name: 'echo_read', description: 'Return fixture data', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'write_item', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
];
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
  directory = await mkdtemp(join(tmpdir(), 'ad-browser-mcp-')); process.env.DATA_DIR = directory;
  mod = await import('../apps/api/src/work-tools-browser.ts'); pool = (await import('../apps/api/src/db.ts')).pool;
  await mod.migrateBrowserMcp(pool);
  await pool.query('CREATE TABLE departments(id text PRIMARY KEY)');await migrateIdentity(pool);await migrateRestoreControlFixture(pool);
  await pool.query("CREATE TABLE project_runs(id text PRIMARY KEY,snapshot jsonb,status text,cancel_requested boolean DEFAULT false,lease_until timestamptz DEFAULT now()+interval '1 hour')");
  service = http.createServer(async (req, res) => {
    if (req.url === '/redirect-outside') { res.writeHead(302, { location: serviceUrl.replace('127.0.0.1', 'localhost') + '/outside' }).end(); return; }
    if (req.url === '/outside') { escapedOriginRequests++; res.end('outside scope'); return; }
    if (req.url?.startsWith('/page')) { res.setHeader('content-type', 'text/html'); res.end(`<html><head><title>Browser fixture</title></head><body><h1>Browser fixture text</h1><input name="q"><a href="/next" id="next">Next page</a><form action="/write" method="post"><button id="submit">Write</button></form><script>document.body.append('JS_SHOULD_NOT_RUN')</script></body></html>`); return; }
    if (req.url === '/next') { res.setHeader('content-type', 'text/html'); res.end('<html><body><h1>Next fixture</h1></body></html>'); return; }
    if (req.url === '/write') { posts++; res.end('written'); return; }
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (mode === 'autherror') { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: secret })); return; }
    if (mode === 'slow') { req.on('close', () => res.destroy()); return; }
    if (request.method === 'notifications/initialized') { initialized++; res.writeHead(202).end(); return; }
    if (request.method !== 'initialize') assert.equal(req.headers['mcp-session-id'], 'fixture-session');
    const result = request.method === 'initialize' ? { protocolVersion: mode === 'bad-version' ? '2099-01-01' : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : request.method === 'tools/list' ? { tools: exposedTools }
      : { content: [{ type: 'text', text: `${secret}: ${JSON.stringify(request.params.arguments)}` }] };
    if (request.method === 'tools/call') calls++;
    const response = { jsonrpc: '2.0', id: mode === 'wrong-id' ? 'wrong' : request.id, result };
    if (mode === 'large') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...response, result: 'x'.repeat(1024 * 1024 + 1) })); return; }
    res.setHeader('mcp-session-id', 'fixture-session');
    if (mode === 'sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n'); res.end(`event: message\ndata: ${JSON.stringify(response)}\n\n`); }
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); }
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening'); serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  const app = express(); app.use(express.json()); app.use('/api', mod.browserMcpRouter());
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 422).json({ message: error.message }));
  appServer = app.listen(0, '127.0.0.1'); await once(appServer, 'listening'); baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}/api`;
});
after(async () => {
  await mod?.closeBrowserMcp();
  if (appServer) await new Promise<void>(resolve => appServer.close(() => resolve()));
  if (service) { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); }
  await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(baseUrl + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function connection() {
  mode = 'json'; return (await api('/work-tools/mcp', 'POST', { name: 'Fixture', url: serviceUrl + '/mcp', token: secret, allowedEmployees: [{ departmentId: 'department-a', agentId: 'employee-1' }], allowedTools: ['echo_read', 'write_item'] })).body;
}
function snapshot(id: string, version = 1) { return { policy: { allowedTools: ['browser_read', 'mcp_call_readonly'] }, agents: [{ id: 'worker', sourceDepartmentId: 'department-a', sourceAgentId: 'employee-1', tools: ['browser_read', 'mcp_call_readonly'], browserOrigins: [serviceUrl], mcpConnections: [{ connectionId: id, version, tools: ['echo_read', 'write_item'] }] }] }; }

test('browser origin scope rejects credentials, paths, protocols and other origins', () => {
  assert.equal(mod.browserOrigin('https://example.com'), 'https://example.com');
  for (const value of ['file:///secret', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?key=secret']) assert.throws(() => mod.browserOrigin(value));
  assert.throws(() => mod.assertBrowserUrl('https://evil.example/path', ['https://example.com']));
  assert.equal(mod.assertBrowserUrl('https://example.com/path', ['https://example.com']), 'https://example.com/path');
});
test('MCP JSON and SSE initialize, discover and redact credentials in tool results', async () => {
  for (const format of ['json', 'sse']) {
    mode = format; const client = new mod.HttpMcpClient(serviceUrl + '/mcp', secret);
    try { await client.initialize(); const tools = await client.listTools(); assert.equal(tools.length, 2); const result = await client.request('tools/call', { name: 'echo_read', arguments: { text: 'hello' } }); assert.ok(!JSON.stringify(result).includes(secret)); assert.match(result.content[0].text, /hello/); }
    finally { await client.close(); }
  }
  assert.equal(initialized, 2);
});
test('MCP bounds responses, checks matching request and protocol version, hides upstream errors', async () => {
  for (const failure of ['large', 'wrong-id', 'bad-version', 'autherror']) {
    mode = failure; const client = new mod.HttpMcpClient(serviceUrl + '/mcp', secret);
    await assert.rejects(client.initialize(), (error: any) => !error.message.includes(secret)); await client.close();
  }
  mode = 'slow'; const client = new mod.HttpMcpClient(serviceUrl + '/mcp', secret, AbortSignal.timeout(30)); await assert.rejects(client.initialize(), /超时|取消/); mode = 'json';
});
test('MCP configuration seals keys and refuses stale versions and unsafe endpoint addresses', async () => {
  const saved = await connection(); assert.equal(saved.hasCredential, true); assert.equal(saved.token, undefined); assert.equal(saved.credential, undefined);
  const stored = (await pool.query('SELECT credential FROM mcp_connections WHERE id=$1', [saved.id])).rows[0]; assert.ok(stored.credential); assert.ok(!stored.credential.includes(secret));
  const discovered = await api(`/work-tools/mcp/${saved.id}/discover`, 'POST', { version: 1 }); assert.equal(discovered.status, 200); assert.equal(discovered.body.tools.length, 2);
  const changed = await api(`/work-tools/mcp/${saved.id}`, 'PUT', { ...saved, version: 1, enabled: false }); assert.equal(changed.status, 200); assert.equal(changed.body.hasCredential, true);
  assert.equal((await api(`/work-tools/mcp/${saved.id}/discover`, 'POST', { version: 1 })).status, 409);
  assert.equal((await api('/work-tools/mcp', 'POST', { name: 'bad', url: 'http://remote.example/mcp', token: secret })).status, 422);
  assert.ok(!JSON.stringify((await api('/work-tools/mcp')).body).includes(secret));
});
test('employee scopes freeze connection versions and separate original department identities', async () => {
  const saved = await connection(); const stored = (await pool.query('SELECT * FROM mcp_connections WHERE id=$1', [saved.id])).rows[0]; const data = snapshot(saved.id); const args = { connectionId: saved.id, tool: 'echo_read' };
  assert.doesNotThrow(() => mod.authorizeBrowserMcp(data, 'worker', 'mcp_call_readonly', args, stored));
  assert.throws(() => mod.authorizeBrowserMcp(data, 'worker', 'mcp_call_readonly', args, { ...stored, version: 2 }));
  data.agents[0].sourceDepartmentId = 'department-b'; assert.throws(() => mod.authorizeBrowserMcp(data, 'worker', 'mcp_call_readonly', args, stored));
  assert.throws(() => mod.authorizeBrowserMcp(snapshot(saved.id), 'worker', 'browser_read', { url: 'https://unapproved.example' }));
  const deniedEmployee = snapshot(saved.id); deniedEmployee.agents[0].tools = []; assert.throws(() => mod.authorizeBrowserMcp(deniedEmployee, 'worker', 'mcp_call_readonly', args, stored));
  const deniedPolicy = snapshot(saved.id); deniedPolicy.policy.allowedTools = []; assert.throws(() => mod.authorizeBrowserMcp(deniedPolicy, 'worker', 'mcp_call_readonly', args, stored));
  assert.throws(() => mod.authorizeBrowserMcp(snapshot(saved.id), 'another-worker', 'mcp_call_readonly', args, stored));
  assert.throws(() => mod.authorizeBrowserMcp(snapshot(saved.id), 'worker', 'mcp_call_readonly', { ...args, tool: 'other-tool' }, stored));
});
test('employee runtime calls only allowed read tools while a leased run is active', async () => {
  const saved = await connection(); const runId = randomUUID(); await pool.query("INSERT INTO project_runs(id,snapshot,status) VALUES($1,$2,'running')", [runId, snapshot(saved.id)]);
  const beforeCalls = calls; const call = (tool: string) => mod.executeBrowserMcpTool({ runId, agentId: 'worker', name: 'mcp_call_readonly', args: { connectionId: saved.id, tool, arguments: { text: 'employee read' } } });
  const result = await call('echo_read'); assert.equal(result.trust, 'untrusted_mcp_content'); assert.equal(calls, beforeCalls + 1);
  await assert.rejects(call('write_item'), /只读/); assert.equal(calls, beforeCalls + 1);
  await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1', [runId]); await assert.rejects(call('echo_read'), /执行状态/);
  await pool.query('UPDATE project_runs SET cancel_requested=false,lease_until=now()-interval \'1 second\' WHERE id=$1', [runId]); await assert.rejects(call('echo_read'), /执行状态/);
  await pool.query("UPDATE project_runs SET lease_until=now()+interval '1 hour' WHERE id=$1", [runId]);
  await api(`/work-tools/mcp/${saved.id}`, 'PUT', { ...saved, allowedTools: [] });
  await assert.rejects(call('echo_read'), /未授权|版本/); assert.equal(calls, beforeCalls + 1, 'revoked connection must not dispatch another call');
});
test('manual MCP call requires explicit confirmation and does not auto retry', async () => {
  const saved = await connection(); const path = `/work-tools/mcp/${saved.id}/call`; const body = { version: 1, tool: 'write_item', arguments: { text: 'manual' } };
  assert.equal((await api(path, 'POST', body)).status, 422);
  const beforeCalls = calls; const result = await api(path, 'POST', { ...body, confirmation: 'CALL' }); assert.equal(result.status, 200); assert.equal(calls, beforeCalls + 1); assert.ok(!JSON.stringify(result).includes(secret));
});
test('real isolated browser reads, fills, clicks and screenshots while blocking scripts and POST', async t => {
  const status = await api('/work-tools/browser'); if (!status.body.available) { t.skip('Chrome/Edge not installed'); return; }
  const open = await api('/work-tools/browser', 'POST', { url: serviceUrl + '/page', origins: [serviceUrl] }); assert.equal(open.status, 200, JSON.stringify(open.body));
  const id = open.body.id; assert.match(open.body.text, /Browser fixture text/); assert.doesNotMatch(open.body.text, /JS_SHOULD_NOT_RUN/); assert.match(open.body.screenshot, /^data:image\/png;base64,/);
  try {
    const fill = await api(`/work-tools/browser/${id}/action`, 'POST', { action: 'fill', selector: '[name=q]', value: 'fixture input' }); assert.equal(fill.status, 200);
    const clicked = await api(`/work-tools/browser/${id}/action`, 'POST', { action: 'click', selector: '#next' }); assert.equal(clicked.status, 200); assert.match(clicked.body.text, /Next fixture/);
    assert.equal((await api(`/work-tools/browser/${id}/action`, 'POST', { action: 'navigate', url: 'https://unapproved.example' })).status, 403);
    await api(`/work-tools/browser/${id}/action`, 'POST', { action: 'navigate', url: serviceUrl + '/page' });
    await api(`/work-tools/browser/${id}/action`, 'POST', { action: 'click', selector: '#submit' }); assert.equal(posts, 0);
    const redirect = await api(`/work-tools/browser/${id}/action`, 'POST', { action: 'navigate', url: serviceUrl + '/redirect-outside' }); assert.equal(redirect.status, 502); assert.equal(escapedOriginRequests, 0);
  } finally { assert.equal((await api(`/work-tools/browser/${id}`, 'DELETE', {})).status, 200); }
});
