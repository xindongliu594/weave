import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as teams from '@nanmicoder/dsh-agent-teams';
import { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools';
import { createTeamHost } from './host.mjs';
import { EmployeeHostFactory } from './employee-hosts.mjs';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { Semaphore } from './limits.mjs';

const require = createRequire(import.meta.url), baseRequire = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));
const loadPlugin = name => import(pathToFileURL(baseRequire.resolve(name)).href);
const route = { id: 'fixture', name: 'fixture', wireModel: 'fixture', baseUrl: 'https://fixture.invalid/v1', inputRate: 1, outputRate: 2, maxOutputTokens: 64 };
const tool = (name, execute) => defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute });
const request = { model: 'fixture', sessionId: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] };

// Uses installed DSH Hosts/registries; no model transport or sandbox effect is permitted.
async function fixture(t, taskProfile = true) {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-')), artifacts = join(root, 'artifacts');
  await mkdir(artifacts);
  const employee = { id: 'manager', role: 'manager', modelId: 'fixture', tools: ['knowledge_search'] };
  const snapshot = { ...(taskProfile ? { executionProfile: 'task-attempt-openshell-v1' } : {}), policy: { contextManagement: 'prune' }, agents: [employee], tasks: [], knowledge: { manager: [] } };
  const archive = createRunArchive(join(root, 'runs'), snapshot);
  const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, beforeRequest: () => { throw Error('MODEL_TRANSPORT_FORBIDDEN'); } });
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive,
    ...(taskProfile ? { product: { snapshot, sandbox: { root: artifacts }, gate: new Semaphore(1) } } : {}) });
  let expectedFailure = false;
  t.after(async () => { if(expectedFailure)await assert.rejects(host.close(), error => error.code === 'RUNTIME_WRITER_DRAIN_FAILED');else await host.close(); assert.ok(root.startsWith(join(tmpdir(), 'host-admission-'))); await rm(root, { recursive: true, force: true }); });
  return { root, host, adapter, archive, employee, expectCloseFailure() { expectedFailure = true; } };
}

test('Host stopAdmission synchronously fences the real model adapter and employee creation', { timeout: 10000 }, async t => {
  const { host, adapter, root } = await fixture(t);
  host.stopAdmission();
  host.stopAdmission();
  assert.throws(() => adapter.prepareRequest(request), error => error.code === 'RUNTIME_STOPPING');
  await assert.rejects(host.captain({ cwd: root, model: 'fixture' }), /EMPLOYEE_HOSTS_CLOSED/);
  assert.equal(host.employeeHosts().length, 0);
  assert.equal(adapter.calls, 0);
});

for (const local of [false, true]) test('Host stopAdmission rejects '+(local ? 'employee local capability' : 'coordinator tool')+' held after DSH final guard', { timeout: 10000 }, async t => {
  const { host, root, archive } = await fixture(t);
  const agent = await host.captain({ cwd: root, model: 'fixture' });
  const ctx = local ? agent.ctx : host.ctx, name = local ? 'capability_search' : 'knowledge_search';
  const baseline = await ctx.tools.execute({ callId: randomUUID(), name, arguments: { query: 'fixture' }, agent, signal: AbortSignal.timeout(2000) });
  assert.equal(baseline.isError, false, JSON.stringify(baseline.error));
  const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER];
  const prepared = await scheduler.prepare({ callId: randomUUID(), name, arguments: { query: 'fixture' }, agent, signal: AbortSignal.timeout(2000) });
  assert.equal(prepared.kind, 'dispatch');
  const before = readRun(join(root, 'runs'), archive.id).events.length;
  host.stopAdmission();
  const outcome = await scheduler.dispatch(prepared.exec);
  const result = await scheduler.finalize(prepared.exec, outcome.result);
  assert.equal(result.isError, true, 'an already guarded execution cannot start its body after the Host fence');
  assert.match(result.error.message, /TASK_TOOL_DENIED/);
  const fresh = await ctx.tools.execute({ callId: randomUUID(), name, arguments: { query: 'fixture' }, agent, signal: AbortSignal.timeout(2000) });
  assert.equal(fresh.isError, true);
  assert.match(fresh.error.message, /TASK_TOOL_DENIED/);
  const effects = readRun(join(root, 'runs'), archive.id).events.slice(before).filter(event => ['knowledge/citation', 'capability/searched'].includes(event.type));
  assert.deepEqual(effects, []);
});

for (const local of [false, true]) test('Host close retains the '+(local ? 'employee' : 'coordinator')+' wrapper during pending plugin teardown', { timeout: 10000 }, async t => {
  const { host, adapter, root } = await fixture(t);
  const agent = await host.captain({ cwd: root, model: 'fixture' });
  const slot = host.employeeHosts()[0], ctx = local ? slot.ctx : host.ctx;
  const plugin = local ? await loadPlugin('@deepseek-ai/dsh-agent-loop') : teams;
  const fiber = [...ctx.registry.get(plugin.default ?? plugin).fibers][0];
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  fiber.ctx.effect(() => async () => { entered.resolve(); await release.promise; });
  let bodies = 0, closing;
  try {
    closing = host.close();
    assert.equal(host.close(), closing, 'close retains the original promise');
    await entered.promise;
    ctx.tools.register(tool('late_teardown', async () => { bodies++; return {}; }));
    const wrapped = ctx.tools.get('late_teardown');
    await assert.rejects(wrapped.execute({}, { agent, name: 'late_teardown' }), /TASK_TOOL_BINDING_CHANGED/);
    assert.equal(bodies, 0);
    assert.throws(() => adapter.prepareRequest(request), error => error.code === 'RUNTIME_STOPPING');
  } finally { release.resolve(); await closing; }
});

for (const local of [false, true]) test('Host close retains the '+(local ? 'employee' : 'coordinator')+' fence after Cordis swallows a real disposer failure', { timeout: 10000 }, async t => {
  const f = await fixture(t), { host, root } = f;
  f.expectCloseFailure();
  const agent = await host.captain({ cwd: root, model: 'fixture' });
  const ctx = local ? host.employeeHosts()[0].ctx : host.ctx, tools = ctx.tools;
  const name = local ? 'capability_search' : 'knowledge_search', scheduler = tools[TOOL_RUNTIME_SCHEDULER];
  const prepared = await scheduler.prepare({ callId: randomUUID(), name, arguments: { query: 'fixture' }, agent, signal: AbortSignal.timeout(5000) });
  assert.equal(prepared.kind, 'dispatch');
  const held = tools.get(name, agent);
  const plugin = local ? await loadPlugin('@deepseek-ai/dsh-agent-loop') : teams;
  const fiber = [...ctx.registry.get(plugin.default ?? plugin).fibers][0];
  let disposerCalls = 0, lateBodies = 0;
  fiber.ctx.effect(() => () => { disposerCalls++; throw Error('TEARDOWN_PROBE'); });
  await assert.rejects(host.close(), error => error.code === 'RUNTIME_WRITER_DRAIN_FAILED');
  assert.equal(disposerCalls, 1, 'the original installed Cordis disposer ran once');
  await assert.rejects(held.execute(prepared.exec.arguments, prepared.exec));
  tools.register(tool('late_failed_teardown', async () => { lateBodies++; return {}; }));
  let lateError;
  try { await tools.get('late_failed_teardown').execute({}, { agent, name: 'late_failed_teardown' }); } catch (error) { lateError = error; }
  const fresh = await tools.execute({ callId: randomUUID(), name: 'late_failed_teardown', arguments: {}, agent, signal: AbortSignal.timeout(2000) });
  assert.equal(lateBodies, 0, 'a swallowed disposer failure cannot expose raw registration after close');
  assert.match(lateError?.message ?? '', /TASK_TOOL_BINDING_CHANGED/);
  assert.equal(fresh.isError, true);
  assert.match(tools.guardReason(prepared.exec), /TASK_TOOL_DENIED/, 'the last native task guard remains after close');
});

test('employee materialization stopped before tool mounting cannot commit a late Host', { timeout: 10000 }, async t => {
  const { host, root, employee } = await fixture(t, false);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const factory = new EmployeeHostFactory({ coordinator: host.ctx, provider: 'fixture', sessionRoot: join(root, 'other-sessions'), taskToolBoundary: true,
    identify: () => employee, loadPlugin: async name => { const plugin = await loadPlugin(name); if (name === '@deepseek-ai/dsh-tools') { entered.resolve(); await release.promise; } return plugin; } });
  let handle;
  const creating = factory.createAgent(host.ctx, { sessionId: randomUUID(), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } });
  try {
    await entered.promise;
    factory.stopAdmission();
    release.resolve();
    await assert.rejects(creating.then(value => { handle = value; }), /EMPLOYEE_HOSTS_CLOSED/);
    assert.equal(factory.list().length, 0);
  } finally { release.resolve(); await handle?.dispose(); await factory.close(); }
});

test('employee materialization stopped during setup cannot commit an already mounted Host', { timeout: 10000 }, async t => {
  const { host, root, employee } = await fixture(t, false);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const factory = new EmployeeHostFactory({ coordinator: host.ctx, provider: 'fixture', sessionRoot: join(root, 'other-sessions'), taskToolBoundary: true,
    identify: () => employee, loadPlugin });
  let handle;
  const creating = factory.createAgent(host.ctx, { sessionId: randomUUID(), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' },
    setup: async () => { entered.resolve(); await release.promise; } });
  try {
    await entered.promise;
    factory.stopAdmission();
    release.resolve();
    await assert.rejects(creating.then(value => { handle = value; }), /EMPLOYEE_HOSTS_CLOSED/);
    assert.equal(factory.list().length, 1);
    await assert.rejects(factory.close(), error => error.code === 'RUNTIME_WRITER_DRAIN_UNPROVEN');
  } finally { release.resolve(); await handle?.dispose(); await factory.close().catch(() => {}); }
});

test('legacy Host can fence model and employee admission without a task boundary', { timeout: 10000 }, async t => {
  const { host, adapter, root } = await fixture(t, false);
  const agent = await host.captain({ cwd: root, model: 'fixture' });
  let bodies = 0;
  agent.ctx.tools.register(tool('legacy_probe', async () => { bodies++; return {}; }));
  const result = await agent.ctx.tools.execute({ callId: randomUUID(), name: 'legacy_probe', arguments: {}, agent, signal: AbortSignal.timeout(2000) });
  assert.equal(result.isError, false); assert.equal(bodies, 1);
  host.stopAdmission();
  assert.throws(() => adapter.prepareRequest(request), error => error.code === 'RUNTIME_STOPPING');
  await assert.rejects(host.captain({ cwd: root, model: 'fixture' }), /EMPLOYEE_HOSTS_CLOSED/);
});
