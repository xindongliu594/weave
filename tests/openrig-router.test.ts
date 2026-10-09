// Production router + persistent bridge + real in-memory SQL. OpenRig transport
// is a protocol fixture here; separate daemon evidence is not replaced by tests.
import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {openRigRouter} from '../apps/api/src/openrig-router.ts';

const db = new PGlite(), root = path.resolve('.data/openrig-router-tests');
before(async () => {
  fs.mkdirSync(root, {recursive: true});
  await db.exec(`CREATE TABLE departments(id text PRIMARY KEY,data jsonb,deleted_at timestamptz);
    CREATE TABLE projects(id text PRIMARY KEY,department_id text,requirement text,version int,plan jsonb,department_name text);
    CREATE TABLE project_runs(id text PRIMARY KEY,status text); CREATE TABLE usage(id text PRIMARY KEY,cost numeric);
    INSERT INTO project_runs VALUES ('untouched-run','running'); INSERT INTO usage VALUES ('untouched-cost',0.25);`);
});
after(async () => {await db.close();});
async function fixture(mode: 'enabled' | 'disabled' | 'invalid' | 'unbound' = 'enabled') {
  const directory = fs.mkdtempSync(path.join(root, 'case-')), mapping = path.join(directory, 'mapping'); fs.mkdirSync(mapping);
  const tokenFile = path.join(directory, 'token'), configFile = path.join(directory, 'config.json'); fs.writeFileSync(tokenFile, 'private-fixture-token');
  const departmentId = randomUUID(), projectId = randomUUID(), rigId = 'fixture-rig', rigName = 'api-fixture';
  const seats = [{employeeId: 'manager', logicalId: 'dev.manager', nodeId: 'manager-node', role: 'manager'}, {employeeId: 'dev', logicalId: 'dev.worker', nodeId: 'dev-node', role: 'developer'}];
  const config = {schema: 1, enabled: true, bridge: {version: '0.6.6', endpoint: 'http://127.0.0.1:58601', expectedSelfHostId: 'fixture-host', tokenFile, stateDirectory: mapping},
    departments: mode === 'unbound' ? [] : [{departmentId, rigId, rigName, seats, sourceEmployeeId: 'manager', destinationEmployeeId: 'dev'}]};
  fs.writeFileSync(configFile, mode === 'invalid' ? '{broken secret-file-path' : JSON.stringify(config));
  const agents = [{id: 'manager', role: 'manager', instructions: 'private-manager-prompt'}, {id: 'dev', role: 'member', instructions: 'private-developer-prompt'}];
  await db.query('INSERT INTO departments VALUES($1,$2,NULL)', [departmentId, JSON.stringify({agents})]);
  await db.query('INSERT INTO projects VALUES($1,$2,$3,1,$4,$5)', [projectId, departmentId, 'A tiny user task', JSON.stringify({agents, secret: 'private-project-secret', modelId: 'not-shared'}), 'Test department']);
  const calls: Array<{method: string; route: string; body?: any}> = [], items = new Map<string, any>();
  const control = {disconnect: '' as '' | 'before' | 'after', unavailable: false};
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status});
  const transport: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname, method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({route, method, body}); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-fixture-token');
    if (control.unavailable) throw Error('private-fixture-token /secret/path internal stack');
    if (route === '/healthz') return response({status: 'ok', selfHostId: 'fixture-host', semver: '0.6.6'});
    if (route === `/api/rigs/${rigId}`) return response({rig: {id: rigId, name: rigName}, nodes: [], edges: []});
    if (route === `/api/rigs/${rigId}/sessions`) return response([]);
    if (route === `/api/rigs/${rigId}/nodes`) return response(seats.map(seat => ({...seat, runtime: 'stub', sessionStatus: null, canonicalSessionName: null})));
    if (method === 'POST' && route === '/api/queue/create') {
      assert.equal(body.nudge, false); assert.equal(items.has(body.qitemId), false, 'duplicate external creation');
      if (control.disconnect === 'before') throw Error('request lost');
      const item = {...body, sourceSession: new Headers(init?.headers).get('X-OpenRig-Session'), state: 'pending', token: 'must-not-return', session: 'must-not-return'};
      items.set(item.qitemId, item); if (control.disconnect === 'after') throw Error('response lost'); return response(item, 201);
    }
    if (method === 'GET' && route.startsWith('/api/queue/')) return items.has(route.slice(11)) ? response(items.get(route.slice(11))) : response({error: 'qitem_not_found'}, 404);
    throw Error(`Unexpected fixture ${method} ${route}`);
  };
  const queries: string[] = [];
  const readOnlyDb = {async query(sql: string, parameters?: any[]) {assert.match(sql.trim(), /^SELECT /); queries.push(sql); return db.query(sql, parameters);}};
  async function start() {
    const app = express(); app.use(express.json()); app.use('/api', openRigRouter(readOnlyDb, {configFile: mode === 'disabled' ? '' : configFile, request: transport}));
    app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({message: error.message, code: error.code}));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    return {server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`};
  }
  let app = await start();
  async function request(route: string, body?: unknown) {
    const response = await fetch(app.url + route, body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json() as any};
  }
  const sync = (body: unknown = {version: 1}) => request(`/projects/${projectId}/openrig/sync`, body);
  const get = () => request(`/projects/${projectId}/openrig`);
  const batch = (ids: string = projectId, dept: string = departmentId) => request(`/openrig/projects?departmentId=${dept}&projectIds=${ids}`);
  const posts = () => calls.filter(call => call.method === 'POST');
  async function close() {await new Promise<void>(resolve => app.server.close(() => resolve()));}
  return {departmentId, projectId, calls, posts, items, control, queries, mapping, configFile, config, request, sync, get, batch,
    async restart() {await close(); app = await start();}, async cleanup() {await close(); assert.equal(path.dirname(path.resolve(directory)), root); fs.rmSync(directory, {recursive: true});}};
}

test('default-disabled router has no OpenRig I/O; missing real projects still return 404', async () => {
  const f = await fixture('disabled'); try {
    assert.deepEqual((await f.request('/openrig/status')).body, {enabled: false, status: 'disabled', acceptanceAuthority: 'weiwu'});
    assert.equal((await f.get()).body.status, 'disabled'); assert.equal((await f.sync()).body.status, 'disabled');
    assert.equal((await f.batch()).body.items[0].status, 'disabled');
    assert.equal((await f.request(`/projects/${randomUUID()}/openrig`)).status, 404);
    assert.equal((await f.request(`/projects/${randomUUID()}/openrig/sync`, {version: 1})).status, 404);
    assert.equal(f.calls.length, 0); assert.deepEqual(fs.readdirSync(f.mapping), []);
  } finally {await f.cleanup();}
});

test('bad optional configuration cannot crash the router and never exposes private configuration', async () => {
  const f = await fixture('invalid'); try {
    for (const result of [await f.request('/openrig/status'), await f.get(), await f.sync()]) {
      assert.equal(result.status, 200); assert.equal(result.body.enabled, true); assert.equal(result.body.status, 'unavailable');
      assert.equal(result.body.error.code, 'OPENRIG_CONFIG_INVALID'); assert.doesNotMatch(JSON.stringify(result.body), /secret-file-path|tokenFile|stateDirectory/);
    }
    assert.equal(f.calls.length, 0);
  } finally {await f.cleanup();}
});

test('unmapped reads and batch lists do not reserve or contact OpenRig; foreign IDs are excluded', async () => {
  const f = await fixture(), other = await fixture('unbound'); try {
    assert.equal((await f.get()).body.status, 'not_synced');
    const result = await f.batch(`${f.projectId},${other.projectId},${f.projectId}`);
    assert.equal(result.body.items.length, 1); assert.equal(result.body.items[0].projectId, f.projectId);
    assert.equal((await other.sync()).body.status, 'not_bound'); assert.equal((await other.batch()).body.items[0].status, 'not_bound');
    assert.equal((await f.batch(f.projectId, randomUUID())).status, 404);
    assert.equal((await f.batch(Array(101).fill(f.projectId).join(','))).status, 422);
    assert.equal(f.calls.length + other.calls.length, 0); assert.deepEqual(fs.readdirSync(f.mapping), []);
  } finally {await f.cleanup(); await other.cleanup();}
});

test('HTTP cannot override endpoint, token or seats; stale versions reject before network activity', async () => {
  const f = await fixture(); try {
    for (const extra of [{endpoint: 'https://foreign.example'}, {token: 'injected'}, {destinationEmployeeId: 'foreign'}, {seat: 'foreign'}, {nudge: true}]) {
      const result = await f.sync({version: 1, ...extra}); assert.equal(result.status, 422); assert.equal(result.body.code, 'OPENRIG_INPUT_INVALID');
    }
    const stale = await f.sync({version: 2}); assert.equal(stale.status, 409); assert.equal(stale.body.code, 'OPENRIG_PROJECT_VERSION_CHANGED');
    assert.equal(f.calls.length, 0); assert.deepEqual(fs.readdirSync(f.mapping), []);
  } finally {await f.cleanup();}
});

test('actual project employees and department provenance are checked before queue writes', async () => {
  const f = await fixture(); try {
    await db.query('UPDATE projects SET plan=$1 WHERE id=$2', [JSON.stringify({agents: [{id: 'manager', role: 'manager'}, {id: 'dev', role: 'member', sourceDepartmentId: randomUUID(), sourceAgentId: 'dev'}]}), f.projectId]);
    const result = await f.sync(); assert.equal(result.body.status, 'unavailable'); assert.equal(result.body.error.code, 'OPENRIG_EMPLOYEE_UNBOUND');
    assert.equal(result.body.notSubmitted, true);
    assert.equal(f.calls.length, 0); assert.deepEqual(fs.readdirSync(f.mapping), []);
  } finally {await f.cleanup();}
});

test('concurrent HTTP requests create one metadata item; batch remains local; queue done never accepts the project', async () => {
  const f = await fixture(); try {
    const results = await Promise.all([f.sync(), f.sync(), f.sync()]);
    assert.equal(f.posts().length, 1); assert.equal(new Set(results.map(result => result.body.queueItemId)).size, 1);
    for (const result of results) {assert.equal(result.body.status, 'synced'); assert.equal(result.body.acceptanceAuthority, 'weiwu'); assert.equal(result.body.queueState, 'pending');
      assert.deepEqual(Object.keys(result.body).sort(), ['acceptanceAuthority', 'enabled', 'projectId', 'queueItemId', 'queueState', 'status']);}
    const metadata = JSON.parse(f.posts()[0].body.body); assert.equal(metadata.projectVersion, 1); assert.equal(metadata.sourceEmployeeId, 'manager'); assert.equal(metadata.destinationEmployeeId, 'dev');
    assert.doesNotMatch(JSON.stringify(f.posts()[0].body), /private-project-secret|private-manager-prompt|modelId|not-shared/);
    const before = f.calls.length; const batch = await f.batch(); assert.equal(batch.body.items[0].status, 'synced'); assert.equal(batch.body.items[0].queueState, null); assert.equal(f.calls.length, before);
    const [item] = f.items.values(); item.state = 'done'; const queried = await f.get(); assert.equal(queried.body.queueState, 'done'); assert.equal(queried.body.accepted, undefined);
    assert.equal((await db.query<{status: string}>('SELECT status FROM project_runs WHERE id=$1', ['untouched-run'])).rows[0].status, 'running');
    assert.equal(Number((await db.query<{cost: number}>('SELECT cost FROM usage WHERE id=$1', ['untouched-cost'])).rows[0].cost), 0.25);
    await f.restart(); assert.equal((await f.get()).body.queueItemId, item.qitemId); assert.equal(f.posts().length, 1);
  } finally {await f.cleanup();}
});

test('lost create response and process reopen reconcile the same receipt using GET only', async () => {
  const f = await fixture(); try {
    f.control.disconnect = 'after'; const unknown = await f.sync(); assert.equal(unknown.body.status, 'unknown'); assert.equal(f.posts().length, 1);
    assert.equal(unknown.body.notSubmitted, undefined);
    assert.equal((await f.batch()).body.items[0].status, 'unknown');
    await f.restart(); f.control.disconnect = ''; const before = f.calls.length;
    const confirmed = await f.sync(); assert.equal(confirmed.body.status, 'synced'); assert.equal(confirmed.body.queueItemId, unknown.body.queueItemId);
    assert.ok(f.calls.slice(before).every(call => call.method === 'GET')); assert.equal(f.posts().length, 1);
  } finally {await f.cleanup();}
});

test('unknown receipt plus remote 404 remains query-only across repeated POST and restart', async () => {
  const f = await fixture(); try {
    f.control.disconnect = 'before'; const unknown = await f.sync(); assert.equal(unknown.body.status, 'unknown');
    assert.equal(unknown.body.notSubmitted, undefined);
    await f.restart(); f.control.disconnect = ''; const before = f.calls.length;
    assert.equal((await f.get()).body.status, 'unknown'); assert.equal((await f.sync()).body.status, 'unknown');
    assert.equal(f.posts().length, 1); assert.equal(f.items.size, 0); assert.ok(f.calls.slice(before).every(call => call.method === 'GET'));
  } finally {await f.cleanup();}
});

test('remote failures are sanitized and remain confined to optional integration routes', async () => {
  const f = await fixture(); try {
    f.control.unavailable = true; const result = await f.sync(); assert.equal(result.status, 200); assert.equal(result.body.status, 'unavailable');
    assert.equal(result.body.notSubmitted, true, 'completed preflight failed before entering enqueue');
    assert.doesNotMatch(JSON.stringify(result.body), /private-fixture-token|secret\/path|stack|Bearer|sourceSession/);
    assert.equal((await f.request('/openrig/status')).body.status, 'ready'); assert.equal((await f.batch()).body.items[0].status, 'not_synced');
    assert.equal(f.posts().length, 0);
    f.control.unavailable = false; assert.equal((await f.sync()).body.status, 'synced'); assert.equal(f.posts().length, 1);
  } finally {await f.cleanup();}
});
