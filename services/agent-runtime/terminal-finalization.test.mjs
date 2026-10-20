import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as teams from '@nanmicoder/dsh-agent-teams';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ProductDshRuntime } from './product-runtime.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
const { createTaskWorkspace } = createRequire(import.meta.url)('../../apps/desktop/task-workspace.cjs');

// Actual installed Host/AgentTeams, Handoff and durable archive; fixture model
// responses and task executor. This does not authenticate SQL/device stop proof.
const profile = 'task-attempt-openshell-v1', sha = 'a'.repeat(64);
const emptyRevision = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const tick = () => new Promise(setImmediate);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label, ms = 16000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture wait: ' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function scenario(t, hooks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-runtime-')), id = randomUUID();
  const originalFetch = globalThis.fetch, order = [], requests = [];
  const releaseClose = Promise.withResolvers(), closeEntered = Promise.withResolvers();
  const releaseManager = Promise.withResolvers(), settlementStarted = Promise.withResolvers();
  let runtime, completion, host, verified = false, step = 0, finalizations = 0, closeDisposals = 0, sandboxCloses = 0, workspacePreparations = 0;
  let finalCheckpointFailed = false, finalSignal;
  const snapshot = {
    projectId: 'terminal-runtime-fixture', planVersion: 1, requirement: 'Native task terminal ordering fixture',
    executionProfile: profile, executionTarget: { kind: 'local', backend: { kind: 'openshell' } }, executionBudget: 1,
    approval: { kind: 'project', projectVersion: 1 },
    policy: { maxBudget: 1, maxConcurrentAgents: 2, deadlineSeconds: hooks.deadlineSeconds ?? 12, contextManagement: 'prune', maxModelCalls: 12, maxTaskModelCalls: 6, allowedTools: [] },
    agents: [
      { id: 'manager', employeeId: 'manager', role: 'manager', modelId: 'manager-fixture', rolePrompt: 'Coordinate.', tools: [] },
      { id: 'worker', employeeId: 'worker', role: 'member', modelId: 'worker-fixture', rolePrompt: 'Complete the approved text task.', tools: [] },
    ],
    tasks: [{ id: 'last', kind: 'work', subject: 'Final text task', objective: 'Check native terminal ordering', assignee: 'worker', assigneeId: 'worker', dependencies: [], inputs: [], outputs: [], inScope: [], outOfScope: [], verify: [], acceptanceCriteria: [] }],
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    let message = { content: 'Fixture coordinator.' };
    if (body.model === 'worker-fixture') {
      const combined = body.messages.map(row => typeof row.content === 'string' ? row.content : JSON.stringify(row.content)).join('\n');
      const attempt = /"attemptId":"([a-f0-9-]+)"/.exec(combined)?.[1] ?? /Attempt id: ([a-f0-9-]+)/.exec(combined)?.[1];
      const actions = [
        ['agent_teams_claim_task', { task_id: 't1' }],
        ['agent_teams_update_task', { task_id: 't1', attempt_id: attempt, status: 'in_progress' }],
        ['agent_teams_update_task', { task_id: 't1', attempt_id: attempt, status: 'completed', output: 'Approved terminal text task complete.' }],
      ];
      if (step < actions.length) {
        const [name, args] = actions[step++];
        message = { content: null, tool_calls: [{ id: 'fixture-' + step, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      } else message = { content: 'No further work.' };
    }
    if (hooks.holdManager && body.model === 'manager-fixture' && requests.filter(row => row.model === 'manager-fixture').length === 1) {
      await new Promise((resolve, reject) => {
        const abort = () => reject(init.signal.reason);
        if (init.signal.aborted) { abort(); return; }
        init.signal.addEventListener('abort', abort, { once: true });
        releaseManager.promise.then(() => { init.signal.removeEventListener('abort', abort); resolve(); });
      });
    }
    return Response.json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
  };
  runtime = new ProductDshRuntime({
    traceRoot: root, beforeRequest: async () => {},
    onUsage: async (_id, usage) => { if (hooks.lateUsageFailure && usage.modelId === 'manager-fixture') throw Error('PRIVATE_LATE_USAGE_FAILURE'); },
    createExecutor: archive => {
      const append = archive.append.bind(archive), artifacts = join(archive.dir, 'artifacts');
      archive.append = (type, data, ...links) => {
        if (type === 'runtime/model-settling' && data.reason === 'delivery-completed') {
          hooks.beforeDrain?.();
          settlementStarted.resolve();
        }
        if (type === 'run/started') {
          host = runtime.jobs.get(id).host;
          const verify = host.verifyDeliverable;
          host.verifyDeliverable = async (...args) => { const result = await verify(...args); verified = true; return result; };
          const fiber = [...host.ctx.registry.get(teams.default ?? teams).fibers][0];
          fiber.ctx.effect(() => async () => {
            closeDisposals++; order.push('host-close'); closeEntered.resolve();
            if (hooks.holdClose) await releaseClose.promise;
          });
        }
        if (type === 'team/checkpoint' && verified) {
          order.push('final-checkpoint');
          if (hooks.failFinalCheckpoint && !finalCheckpointFailed) { finalCheckpointFailed = true; throw Error('FINAL_CHECKPOINT_FSYNC_FAILED'); }
        }
        if (type === 'run/finished') {
          order.push('run-finished');
          if (hooks.failFinalArchive && data.status === 'completed') throw Error('FINAL_ARCHIVE_FSYNC_FAILED');
        }
        return append(type, data, ...links);
      };
      return {
        root: artifacts,
        prepare: async () => { mkdirSync(artifacts, { recursive: true }); },
        bindAttempt: async candidate => ({ ...candidate, generation: 1 }),
        prepareTask: async context => {
          const key = { runId: id, taskId: context.taskId, attemptId: context.attemptId, generation: context.generation };
          const workspace = createTaskWorkspace({ binding: { projectId: snapshot.projectId, planVersion: 1, ...key, assigneeId: 'worker', contractHash: sha, permissionHash: sha,
            backend: { kind: 'openshell', version: '0.1.2', image: 'node@sha256:' + sha, policyHash: sha } }, readPaths: [], writePaths: [], canonicalFiles: [], origins: [] });
          return { profile, key, workspace, workRevision: workspace.baseCanonicalRevision, capabilityHash: sha, inputOrigins: [] };
        },
        prepareCheckpoint: async context => ({ profile, key: { runId: id, taskId: context.taskId, attemptId: context.attemptId, generation: context.generation },
          inputManifest: [], inputOrigins: [], workManifest: [], canonical: { revision: emptyRevision, manifest: [], mergeId: null }, lastMerge: null, scopeHash: sha, capabilityHash: sha }),
        execute: async () => { throw Error('NO_SANDBOX_COMMAND_EXPECTED'); },
        finalizeAccepted: async signal => {
          finalizations++; finalSignal = signal; order.push('finalize');
          assert.equal(verified, true);
          assert.ok(readRun(root, id).events.findLast(e => e.type === 'team/checkpoint').data.tasks.every(task => task.status === 'completed'));
          if (hooks.finalize) return hooks.finalize({ signal, runtime, id, host, order, requests });
          return { version: 1, state: 'stopped' };
        },
        close: async () => { sandboxCloses++; order.push('sandbox-close'); if (hooks.failSandboxClose) throw Error('PRIVATE_SANDBOX_CLEANUP_FAILURE'); },
      };
    },
  });
  t.after(async () => {
    releaseClose.resolve();
    releaseManager.resolve();
    await bounded(Promise.allSettled([runtime.cancel(id), completion]), 'cleanup');
    globalThis.fetch = originalFetch;
    assert.ok(root.startsWith(join(tmpdir(), 'terminal-runtime-')));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const start = await runtime.start({ runId: id, approvedSnapshot: snapshot, prepareWorkspace: () => {
    workspacePreparations++;
    assert.equal(readRun(root, id), null, 'workspace preparation precedes the original archive');
    order.push('prepare-workspace');
  }, routes: ['manager-fixture', 'worker-fixture'].map(model => ({
    id: model, name: model, wireModel: model, baseUrl: 'https://fixture.invalid/v1', inputRate: 1, outputRate: 2, maxOutputTokens: 512,
  })) });
  completion = start.completion;
  return { root, id, runtime, snapshot, order, requests, completion, closeEntered, releaseClose, releaseManager, settlementStarted, get host() { return host; },
    get finalizations() { return finalizations; }, get closeDisposals() { return closeDisposals; }, get sandboxCloses() { return sandboxCloses; }, get finalSignal() { return finalSignal; }, get workspacePreparations() { return workspacePreparations; },
    read: () => readRun(root, id) };
}

test('task runtime requires the source-only finalizer before prepare or model effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-preflight-'));
  let prepares = 0;
  try {
    const snapshot = { executionProfile: profile, executionTarget: { kind: 'local', backend: { kind: 'openshell' } }, policy: { maxConcurrentAgents: 1, deadlineSeconds: 2 } };
    const archive = createRunArchive(root, snapshot);
    const runtime = new ProductDshRuntime({ traceRoot: root, createExecutor: () => ({
      root, bindAttempt() {}, prepareTask() {}, prepareCheckpoint() {}, execute() {},
      async prepare() { prepares++; throw Error('PREPARE_RAN_BEFORE_FINALIZER_CHECK'); }, async close() {},
    }) });
    const result = await runtime.execute({ controller: new AbortController(), cancelled: false }, archive, snapshot, []);
    assert.equal(prepares, 0);
    assert.match(result.message, /TASK_FINALIZATION_REQUIRED/);
    assert.equal(readRun(root, archive.id).events.filter(e => e.type === 'model/wire-request').length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('durable native acceptance finalizes once before Host close and run finished', { timeout: 16000 }, async t => {
  const f = await scenario(t);
  const result = await f.completion;
  assert.equal(result.status, 'completed', result.message);
  assert.equal(f.workspacePreparations, 1);
  assert.equal(f.order[0], 'prepare-workspace');
  assert.equal(f.finalizations, 1);
  assert.ok(f.finalSignal instanceof AbortSignal);
  assert.ok(f.order.indexOf('final-checkpoint') < f.order.indexOf('finalize'));
  assert.ok(f.order.indexOf('finalize') < f.order.indexOf('host-close'));
  assert.ok(f.order.indexOf('host-close') < f.order.indexOf('run-finished'));
  assert.equal(f.sandboxCloses, 1);
  assert.deepEqual(result.maintenance, { version: 1, state: 'stopped' });
  assert.equal(f.read().events.filter(e => e.type === 'runtime/maintenance-completed').length, 1);
});

test('failure of the final durable checkpoint stays a business failure with zero finalization', { timeout: 16000 }, async t => {
  const f = await scenario(t, { failFinalCheckpoint: true });
  const result = await f.completion;
  assert.equal(result.status, 'failed');
  assert.match(result.message, /FINAL_CHECKPOINT_FSYNC_FAILED/);
  assert.equal(f.finalizations, 0);
  assert.equal(f.read().events.some(e => e.type === 'run/finished' && e.data.status === 'completed'), false);
});

for (const mode of ['throws', 'invalid', 'cancel']) test('accepted business remains completed with pending maintenance: ' + mode, { timeout: 16000 }, async t => {
  const f = await scenario(t, { finalize: async ({ runtime, id, signal }) => {
    if (mode === 'throws') throw Error('PRIVATE_STOP_FAILURE');
    if (mode === 'invalid') return { version: 1, state: 'stopped', privateProof: 'must not escape' };
    await runtime.cancel(id);
    signal.throwIfAborted();
  } });
  const result = await f.completion;
  assert.equal(f.finalizations, 1);
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.maintenance.state, 'pending');
  assert.equal(f.read().events.findLast(e => e.type === 'run/finished').data.status, 'completed');
  const observed = f.read().events.filter(e => e.type === 'runtime/maintenance-pending');
  assert.equal(observed.length, 1);
  assert.equal(JSON.stringify(observed).includes('PRIVATE_STOP_FAILURE'), false);
  assert.equal(JSON.stringify(result).includes('privateProof'), false);
});

test('business deadline stops at durable acceptance while shared maintenance signal remains active', { timeout: 16000 }, async t => {
  const f = await scenario(t, { deadlineSeconds: 3, finalize: async ({ signal }) => {
    await wait(3100);
    assert.equal(signal.aborted, false, 'business timer must not abort accepted maintenance');
    return { version: 1, state: 'stopped' };
  } });
  const result = await f.completion;
  assert.equal(f.finalizations, 1);
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.maintenance.state, 'stopped');
  assert.equal(f.read().events.some(e => e.type === 'run/deadline-exceeded'), false);
});

test('held native teardown retains the original Host, blocks launches and cannot execute late tools', { timeout: 26000 }, async t => {
  const f = await scenario(t, { holdClose: true });
  await bounded(f.closeEntered.promise, 'native disposer entry');
  let settled = false; f.completion.then(() => { settled = true; }, () => { settled = true; });
  const result = await bounded(f.completion, 'bounded accepted teardown', 11500);
  assert.equal(settled, true);
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.maintenance.state, 'pending');
  assert.equal((await f.runtime.inspect()).ready, false);
  assert.equal(f.runtime.jobs.get(f.id).host, f.host);
  let bodies = 0;
  const late = defineTool({ name: 'terminal_late', description: 'fixture', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] }, execute: async () => { bodies++; return {}; } });
  f.host.ctx.tools.register(late);
  await assert.rejects(f.host.ctx.tools.get(late.name).execute({}, {}), /TASK_TOOL_/);
  let rejectedPreparations = 0;
  await assert.rejects(f.runtime.start({ runId: randomUUID(), approvedSnapshot: f.snapshot, routes: [],
    prepareWorkspace: () => { rejectedPreparations++; } }), /RUNTIME_TEARDOWN_PENDING/);
  assert.equal(rejectedPreparations, 0);
  const before = f.requests.length; await tick(); assert.equal(f.requests.length, before); assert.equal(bodies, 0);
  assert.equal(f.closeDisposals, 1);
  f.releaseClose.resolve();
  await bounded((async () => { while (!(await f.runtime.inspect()).ready) await tick(); })(), 'same close settlement');
  assert.equal(f.closeDisposals, 1);
  assert.equal(f.runtime.jobs.has(f.id), false);
  assert.equal(f.read().events.findLast(e => e.type === 'run/finished').data.status, 'completed');
});

test('sandbox cleanup rejection cannot replace completed business acceptance', { timeout: 16000 }, async t => {
  const f = await scenario(t, { failSandboxClose: true });
  const result = await f.completion;
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.maintenance.state, 'pending');
  assert.equal(f.sandboxCloses, 1);
  assert.equal(f.read().events.findLast(e => e.type === 'run/finished').data.status, 'completed');
});

test('archiving failure after durable acceptance is not recorded as fully persisted completion or business failure', { timeout: 16000 }, async t => {
  const f = await scenario(t, { failFinalArchive: true });
  const result = await f.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.recording, 'incomplete');
  assert.equal(result.maintenance.state, 'pending');
  assert.match(result.message, /记录.*核对/);
  assert.equal(JSON.stringify(result).includes('FINAL_ARCHIVE_FSYNC_FAILED'), false);
  assert.equal(f.finalizations, 1);
  assert.equal(f.read().events.some(e => e.type === 'run/finished'), false);
});

test('actual model drain timeout blocks terminal finalization without a second settlement window', { timeout: 18000 }, async t => {
  const f = await scenario(t, { holdManager: true, deadlineSeconds: 90,
    beforeDrain: () => { t.mock.timers.enable({ apis: ['setTimeout'] }); } });
  try {
    await f.settlementStarted.promise;
    await tick();
    t.mock.timers.tick(30000);
    // Existing native drain resolves at its real fixed ceiling; no injected
    // finalization result, pending counter or simplified adapter is used.
    await tick(); await tick();
    t.mock.timers.reset();
    const result = await bounded(f.completion, 'failed original settlement', 5000);
    assert.equal(result.status, 'failed');
    assert.match(result.message, /MODEL_SETTLEMENT_UNRESOLVED/);
    assert.equal(f.finalizations, 0);
    assert.equal(f.read().events.filter(e => e.type === 'runtime/model-settling').length, 1);
    assert.equal(f.read().events.some(e => e.type === 'run/finished' && e.data.status === 'completed'), false);
    assert.ok(f.read().events.some(e => e.type === 'billing/unconfirmed' && e.data.dispatched));
  } finally { t.mock.timers.reset(); }
});

for (const fail of [false, true]) test('late original model usage ' + (fail ? 'failure blocks acceptance' : 'settles despite the internal delivery stop'), { timeout: 18000 }, async t => {
  const f = await scenario(t, { holdManager: true, lateUsageFailure: fail });
  await bounded(f.settlementStarted.promise, 'original manager settlement');
  f.releaseManager.resolve();
  const result = await f.completion;
  assert.equal(result.status, fail ? 'failed' : 'completed', result.message);
  assert.equal(f.finalizations, fail ? 0 : 1);
  assert.ok(f.read().events.some(e => e.type === 'runtime/model-settled' && e.data.pendingRequests === 0 && !e.data.timedOut));
  if (fail) assert.equal(f.read().events.some(e => e.type === 'run/finished' && e.data.status === 'completed'), false);
});
