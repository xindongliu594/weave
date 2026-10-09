// Protocol regression fixtures only. These are not a real OpenRig daemon or
// employee/model acceptance; the separate control-plane trial supplies that evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {OpenRigBridge, type OpenRigBridgeConfig, type OpenRigQueueItem} from '../apps/api/src/openrig-bridge.ts';

const testRoot = path.resolve('.data/openrig-bridge-tests');
function fixture() {
  fs.mkdirSync(testRoot, {recursive: true}); const root = fs.mkdtempSync(path.join(testRoot, 'case-'));
  const directory = path.join(root, 'mapping'); fs.mkdirSync(directory); const tokenFile = path.join(root, 'token'); fs.writeFileSync(tokenFile, 'fixture-local-token');
  const config: OpenRigBridgeConfig = {enabled: true, version: '0.6.6', endpoint: 'http://127.0.0.1:58033', expectedSelfHostId: 'fixture-host', tokenFile, stateDirectory: directory};
  const departmentId = randomUUID(), manager = randomUUID(), developer = randomUUID(), projectId = randomUUID(), rigId = '01M4DWNWQ6KA70DSXTWVSK9RBM', rigName = 'weiwu-fixture';
  const seats = [{employeeId: manager, logicalId: 'dev.manager', nodeId: 'node-manager', role: 'manager'}, {employeeId: developer, logicalId: 'dev.engineer', nodeId: 'node-engineer', role: 'developer'}];
  const input = {projectId, departmentId, sourceEmployeeId: manager, destinationEmployeeId: developer, title: 'Repair the small CLI', description: 'User-approved project metadata only. No model task starts in this bridge.'};
  const rows = new Map<string, OpenRigQueueItem>(), calls: Array<{route: string; method: string; body: any; headers: Record<string, string>}> = [];
  const control = {selfHostId: 'fixture-host', semver: '0.6.6', sessions: [] as unknown[], runtime: 'stub', activeNode: false, disconnect: '' as '' | 'before-commit' | 'after-commit', badSource: false, invalidResponse: false};
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status});
  const transport: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, 'error'); assert.ok(init.signal); assert.equal(String(url).startsWith(config.endpoint + '/'), true);
    const route = String(url).slice(config.endpoint.length), method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const headers = init?.headers as Record<string, string>; assert.equal(headers.Authorization, 'Bearer fixture-local-token'); calls.push({route, method, body, headers});
    if (route === '/healthz') return response({status: 'ok', selfHostId: control.selfHostId, semver: control.semver});
    if (route === `/api/rigs/${rigId}`) return response({rig: {id: rigId, name: rigName}, nodes: [], edges: []});
    if (route === `/api/rigs/${rigId}/sessions`) return response(control.sessions);
    if (route === `/api/rigs/${rigId}/nodes`) return response(seats.map(seat => ({...seat, runtime: control.runtime, sessionStatus: control.activeNode ? 'running' : null, canonicalSessionName: null})));
    if (route === '/api/queue/create' && method === 'POST') {
      assert.equal(body.nudge, false); assert.equal(body.sourceSession, undefined);
      if (control.disconnect === 'before-commit') throw Error('fixture connection lost before observed commit');
      assert.equal(rows.has(body.qitemId), false, 'the bridge must never replay a POST');
      const item = {...body, sourceSession: control.badSource ? 'other@foreign' : headers['X-OpenRig-Session'], state: 'pending'} as OpenRigQueueItem; rows.set(item.qitemId, item);
      if (control.disconnect === 'after-commit') throw Error('fixture response dropped after commit');
      return control.invalidResponse ? new Response('{truncated', {status: 201}) : response(item, 201);
    }
    if (route.startsWith('/api/queue/') && method === 'GET') {const item = rows.get(route.slice('/api/queue/'.length)); return item ? response(item) : response({error: 'qitem_not_found'}, 404);}
    throw Error(`Unexpected protocol fixture route ${method} ${route}`);
  };
  const bridge = new OpenRigBridge(config, transport);
  const bind = () => bridge.bindDepartment({departmentId, rigId, rigName, seats});
  const posts = () => calls.filter(call => call.method === 'POST');
  return {config, bridge, transport, root, directory, departmentId, rigId, rigName, seats, input, rows, calls, control, bind, posts, cleanup() {assert.equal(path.dirname(path.resolve(root)), testRoot); fs.rmSync(root, {recursive: true});}};
}

test('default-disabled bridge performs no filesystem or network setup', async () => {
  let calls = 0; const disabled = new OpenRigBridge(undefined, async () => {calls++; throw Error('must not call');});
  assert.equal(disabled.enabled, false);
  await assert.rejects(disabled.reconcileProject(randomUUID()), {code: 'OPENRIG_DISABLED'}); assert.equal(calls, 0);
  const explicitlyDisabled = new OpenRigBridge({enabled: false, version: '0.6.6', endpoint: 'not a URL', expectedSelfHostId: '', tokenFile: 'missing', stateDirectory: 'missing'});
  assert.equal(explicitlyDisabled.enabled, false);
});

test('only explicit loopback endpoints and the pinned version are admitted', () => {
  const f = fixture(); try {
    for (const endpoint of ['https://127.0.0.1:58033', 'http://localhost:58033', 'http://10.0.0.1:58033', 'http://127.0.0.1:58033/other', 'http://user:pass@127.0.0.1:58033', 'http://127.0.0.1:58033?host=remote', 'http://127.0.0.1:58033#fragment']) assert.throws(() => new OpenRigBridge({...f.config, endpoint}), {code: 'OPENRIG_ENDPOINT_INVALID'});
    assert.throws(() => new OpenRigBridge({...f.config, version: '0.6.7' as '0.6.6'}), {code: 'OPENRIG_VERSION_MISMATCH'}); assert.equal(f.calls.length, 0);
  } finally {f.cleanup();}
});

test('department binds immutable real topology; no materialization or harness startup requests exist', async () => {
  const f = fixture(); try {
    const bound = await f.bind(); assert.equal(bound.seats[0].session, 'dev-manager@weiwu-fixture'); assert.deepEqual(await f.bind(), bound); assert.equal(f.posts().length, 0);
    const reopened = new OpenRigBridge(f.config, f.transport);
    await assert.rejects(reopened.bindDepartment({departmentId: f.departmentId, rigId: f.rigId, rigName: f.rigName, seats: [{...f.seats[0], role: 'another-role'}, f.seats[1]]}), {code: 'OPENRIG_MAPPING_CHANGED'});
    await assert.rejects(f.bridge.bindDepartment({departmentId: randomUUID(), rigId: f.rigId, rigName: f.rigName, seats: [f.seats[0], f.seats[0]]}), {code: 'OPENRIG_MAPPING_CHANGED'});
  } finally {f.cleanup();}
});

test('concurrent callers and reopened instances persist one official qitem with one POST', async () => {
  const f = fixture(); try {
    await f.bind(); const second = new OpenRigBridge(f.config, f.transport);
    const results = await Promise.all([f.bridge.enqueueProject(f.input), second.enqueueProject(f.input), f.bridge.enqueueProject(f.input)]);
    assert.equal(new Set(results.map(result => result.receipt.qitemId)).size, 1); assert.equal(f.posts().length, 1);
    const [post] = f.posts(); assert.match(post.body.qitemId, /^qitem-weiwu-[a-f0-9]{64}$/); assert.equal(post.headers['X-OpenRig-Session'], 'dev-manager@weiwu-fixture'); assert.equal(post.body.destinationSession, 'dev-engineer@weiwu-fixture'); assert.equal(post.body.nudge, false);
    for (const result of results) {assert.equal(result.receipt.outcome, 'confirmed'); assert.equal(result.queueItem?.state, 'pending'); assert.equal(result.acceptanceAuthority, 'weiwu');}
    const stored = JSON.parse(fs.readFileSync(path.join(f.directory, `project-${f.input.projectId}.json`), 'utf8')); assert.equal(stored.body, undefined); assert.equal(stored.state, undefined); assert.equal(stored.token, undefined);
  } finally {f.cleanup();}
});

test('lost successful create response is reconciled by ID after restart without replay', async () => {
  const f = fixture(); try {
    await f.bind(); f.control.disconnect = 'after-commit';
    await assert.rejects(f.bridge.enqueueProject(f.input), {code: 'OPENRIG_OUTCOME_UNKNOWN'}); assert.equal(f.rows.size, 1);
    const reopened = new OpenRigBridge(f.config, f.transport), result = await reopened.reconcileProject(f.input.projectId);
    assert.equal(result.receipt.outcome, 'confirmed'); assert.equal(result.queueItem?.body, f.input.description); assert.equal(f.posts().length, 1);
  } finally {f.cleanup();}
});

test('missing qitem after unknown write stays unknown and never automatically sends another create', async () => {
  const f = fixture(); try {
    await f.bind(); f.control.disconnect = 'before-commit'; await assert.rejects(f.bridge.enqueueProject(f.input), {code: 'OPENRIG_OUTCOME_UNKNOWN'});
    f.control.disconnect = ''; const reopened = new OpenRigBridge(f.config, f.transport);
    for (let i = 0; i < 2; i++) {const result = await reopened.enqueueProject(f.input); assert.equal(result.receipt.outcome, 'unknown'); assert.equal(result.queueItem, null);}
    assert.equal(f.posts().length, 1); assert.equal(f.rows.size, 0);
  } finally {f.cleanup();}
});

test('same project with changed payload is refused before new network I/O', async () => {
  const f = fixture(); try {
    await f.bind(); await f.bridge.enqueueProject(f.input); const before = f.calls.length;
    await assert.rejects(f.bridge.enqueueProject({...f.input, description: 'different requirement'}), {code: 'OPENRIG_PAYLOAD_MISMATCH'});
    assert.equal(f.calls.length, before); assert.equal(f.posts().length, 1);
  } finally {f.cleanup();}
});

test('source/destination/body mismatches are not accepted as a successful write or later reconciliation', async () => {
  const f = fixture(); try {
    await f.bind(); f.control.badSource = true; await assert.rejects(f.bridge.enqueueProject(f.input), {code: 'OPENRIG_OUTCOME_UNKNOWN'});
    await assert.rejects(new OpenRigBridge(f.config, f.transport).reconcileProject(f.input.projectId), {code: 'OPENRIG_PAYLOAD_MISMATCH'}); assert.equal(f.posts().length, 1);
  } finally {f.cleanup();}
});

test('truncated response keeps durable identity and a later query can confirm its actual row', async () => {
  const f = fixture(); try {
    await f.bind(); f.control.invalidResponse = true; await assert.rejects(f.bridge.enqueueProject(f.input), {code: 'OPENRIG_OUTCOME_UNKNOWN'});
    const result = await f.bridge.reconcileProject(f.input.projectId); assert.equal(result.receipt.outcome, 'confirmed'); assert.equal(f.posts().length, 1);
  } finally {f.cleanup();}
});

test('instance replacement, upgraded daemon, active harness or changed node blocks queue mutations', async () => {
  for (const change of [{selfHostId: 'another-host'}, {semver: '0.6.7'}, {sessions: [{id: 'live-session'}]}, {runtime: 'codex'}, {activeNode: true}]) {
    const f = fixture(); try {await f.bind(); Object.assign(f.control, change); await assert.rejects(f.bridge.enqueueProject(f.input)); assert.equal(f.posts().length, 0);} finally {f.cleanup();}
  }
});

test('current queue state is read from OpenRig and terminal closure does not imply Weiwu acceptance', async () => {
  const f = fixture(); try {
    await f.bind(); const first = await f.bridge.enqueueProject(f.input); const item = f.rows.get(first.receipt.qitemId)!; item.state = 'done'; item.closureReason = 'no-follow-on';
    const current = await f.bridge.reconcileProject(f.input.projectId); assert.equal(current.queueItem?.state, 'done'); assert.equal(current.acceptanceAuthority, 'weiwu'); assert.equal((current as any).accepted, undefined); assert.equal(f.posts().length, 1);
  } finally {f.cleanup();}
});

test('corrupt receipt and cross-instance persistent bindings fail closed', async () => {
  const f = fixture(); try {
    await f.bind(); await f.bridge.enqueueProject(f.input); const before = f.calls.length;
    const other = new OpenRigBridge({...f.config, expectedSelfHostId: 'another-instance'}, f.transport);
    await assert.rejects(other.enqueueProject(f.input), {code: 'OPENRIG_MAPPING_CHANGED'});
    fs.writeFileSync(path.join(f.directory, `project-${f.input.projectId}.json`), '{partial');
    await assert.rejects(f.bridge.reconcileProject(f.input.projectId), {code: 'OPENRIG_STATE_INVALID'}); assert.equal(f.calls.length, before);
  } finally {f.cleanup();}
});
