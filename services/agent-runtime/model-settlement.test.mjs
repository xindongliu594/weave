import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { ProductDshRuntime, approvedTeamExecutionDescription } from './product-runtime.mjs';
import { readRun } from './trace-store.mjs';

const route = { id: 'fixture', name: 'fixture', wireModel: 'fixture', baseUrl: 'https://fixture.invalid/v1', inputRate: 1, outputRate: 2, maxOutputTokens: 512 };
const options = { model: route.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Approved execution' }] }] };
const consume = async (adapter, chunks = []) => { for await (const chunk of adapter.stream(options)) chunks.push(chunk); };
const response = () => Response.json({ choices: [{ message: { tool_calls: [{ id: 'late-call', type: 'function', function: { name: 'artifact_write', arguments: '{"path":"late.txt","content":"late"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 37, completion_tokens: 5 } }, { headers: { 'X-Oneapi-Request-Id': 'original-response' } });

test('local pre-dispatch failure is not reported as a relay connection failure or charged', async () => {
  const original=globalThis.fetch;let fetches=0;const usages=[],errors=[];
  globalThis.fetch=async()=>{fetches++;return response();};
  try {
    const adapter=new OpenAiCompatibleAdapter({routes:[route],maxBudget:1,
      beforeRequest:async()=>{throw Error('private diagnostic must not be exposed');},
      onUsage:value=>usages.push(value),onCallError:value=>errors.push(value)});
    await assert.rejects(consume(adapter),error=>error.code==='MODEL_ADMISSION_FAILED'&&/尚未发送/.test(error.message)&&!error.message.includes('private diagnostic'));
    assert.equal(fetches,0);assert.deepEqual(usages,[]);assert.deepEqual(errors,[]);
    assert.equal(adapter.spent,0);assert.equal(adapter.reserved,0);assert.equal(adapter.pendingRequests,0);
  }finally{globalThis.fetch=original;}
});

test('an internal stop settles only its original late response and emits no tool calls or new requests', async () => {
  const original = globalThis.fetch, usages = [], errors = [], metadata = [], chunks = [], ids = [];
  let resolveResponse, dispatched, fetches = 0;
  const sent = new Promise(resolve => { dispatched = resolve; });
  globalThis.fetch = async () => { fetches++; dispatched(); return await new Promise(resolve => { resolveResponse = resolve; }); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, beforeRequest: async data => ids.push(data.id), onUsage: usage => usages.push(usage), onCallError: error => errors.push(error), onResponse: event => metadata.push(event) });
    const stop = Object.assign(Error('NO_PROGRESS: internal stop'), { code: 'NO_PROGRESS' });
    const running = assert.rejects(consume(adapter, chunks), error => error === stop); await sent;
    adapter.stopAdmission(stop); const settled = adapter.drain(1000);
    await assert.rejects(consume(adapter), error => error === stop); assert.equal(fetches, 1); assert.equal(ids.length, 1);
    resolveResponse(response()); await running;
    assert.deepEqual(await settled, { pendingRequests: 0, finishedRequests: 1, timedOut: false, aborted: false });
    assert.equal(usages.length, 1); assert.equal(usages[0].id, ids[0]); assert.equal(usages[0].inputTokens, 37); assert.equal(usages[0].outputTokens, 5); assert.equal(usages[0].cost, 47 / 1e6);
    assert.equal(metadata[0].id, ids[0]); assert.equal(metadata[0].providerRequestId, 'original-response');
    assert.deepEqual(chunks, []); assert.deepEqual(errors, []); assert.equal(adapter.pendingRequests, 0); assert.equal(adapter.reserved, 0);
  } finally { globalThis.fetch = original; }
});

test('settlement has a hard 30-second ceiling and an unanswered call remains uncertain without fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch, controller = new AbortController(), usages = [], errors = [], fallbackEvents = [];
  let dispatched, fetches = 0; const sent = new Promise(resolve => { dispatched = resolve; });
  globalThis.fetch = async (_url, init) => { fetches++; dispatched(); return await new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); }); };
  try {
    const backup = { ...route, id: 'backup' };
    const adapter = new OpenAiCompatibleAdapter({ routes: [route, backup], maxBudget: 1, signal: controller.signal, beforeRequest: async () => {}, onUsage: usage => usages.push(usage), onCallError: error => errors.push(error), onFallback: event => fallbackEvents.push(event) });
    adapter.sessionPolicies.set('employee', { fallbackModelId: backup.id });
    const running = assert.rejects(consume(adapter), /settlement timeout/); await sent;
    adapter.stopAdmission(Error('internal failure')); let finished = false;
    const settled = adapter.drain(120000).then(result => { finished = true; return result; });
    t.mock.timers.tick(29999); await Promise.resolve(); assert.equal(finished, false);
    t.mock.timers.tick(1); assert.deepEqual(await settled, { pendingRequests: 1, finishedRequests: 0, timedOut: true, aborted: false });
    controller.abort(Error('settlement timeout')); await running;
    assert.equal(fetches, 1); assert.deepEqual(usages, []); assert.deepEqual(fallbackEvents, []); assert.equal(errors.length, 1); assert.equal(errors[0].dispatched, true); assert.equal(adapter.spent, 0);
  } finally { globalThis.fetch = original; t.mock.timers.reset(); }
});

test('user cancellation or the approved deadline immediately ends settlement without a new request', async () => {
  const original = globalThis.fetch;
  try {
    for (const reason of ['Run cancelled', 'Run deadline exceeded']) {
      const controller = new AbortController(), usages = [], errors = []; let dispatched, fetches = 0;
      const sent = new Promise(resolve => { dispatched = resolve; });
      globalThis.fetch = async (_url, init) => { fetches++; dispatched(); return await new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); }); };
      const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, signal: controller.signal, beforeRequest: async () => {}, onUsage: usage => usages.push(usage), onCallError: error => errors.push(error) });
      const running = assert.rejects(consume(adapter), error => error.message === reason); await sent;
      adapter.stopAdmission(Error('internal failure')); const settled = adapter.drain();
      controller.abort(Error(reason)); const result = await settled; await running;
      assert.equal(result.aborted, true); assert.equal(result.timedOut, false); assert.equal(fetches, 1); assert.equal(usages.length, 0); assert.equal(errors.length, 1); assert.equal(errors[0].dispatched, true);
    }
  } finally { globalThis.fetch = original; }
});

test('a request still persisting admission when stopped never dispatches or pretends it was charged', async () => {
  const original = globalThis.fetch, errors = []; let admitted, releaseAdmission, fetches = 0;
  const admissionStarted = new Promise(resolve => { admitted = resolve; });
  globalThis.fetch = async () => { fetches++; return response(); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, beforeRequest: async () => { admitted(); await new Promise(resolve => { releaseAdmission = resolve; }); }, onCallError: error => errors.push(error) });
    const stop = Object.assign(Error('NO_PROGRESS: internal stop'), { code: 'NO_PROGRESS' });
    const running = assert.rejects(consume(adapter), error => error === stop); await admissionStarted;
    adapter.stopAdmission(stop); assert.equal((await adapter.drain()).pendingRequests, 0); releaseAdmission(); await running;
    assert.equal(fetches, 0); assert.equal(errors.length, 1); assert.equal(errors[0].dispatched, false); assert.equal(adapter.spent, 0); assert.equal(adapter.reserved, 0);
  } finally { globalThis.fetch = original; }
});

test('legacy execution descriptions use the approved task stage and retain the untouched historical requirement', () => {
  const snapshot = { requirement: 'Old planning instruction: no files.', tasks: [{ id: 'generic-task', subject: 'Implement Todo API', objective: 'Write and test real delivery files' }] };
  const before = JSON.stringify(snapshot), description = approvedTeamExecutionDescription(snapshot);
  assert.match(description, /已批准的项目执行阶段/); assert.match(description, /Implement Todo API/); assert.match(description, /Write and test real delivery files/); assert.ok(!description.includes(snapshot.requirement)); assert.equal(JSON.stringify(snapshot), before);
  assert.equal(approvedTeamExecutionDescription({ ...snapshot, executionDescription: 'Approved execution summary' }), 'Approved execution summary');
});

test('the actual runtime fences failed work while preserving a late original manager receipt', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-settlement-')), requests = [], usages = [], unknown = [], handlers = new Set();
  const managerReceived = Promise.withResolvers(), anomalyRaised = Promise.withResolvers(), settlementStarted = Promise.withResolvers(), fixtureFailed = Promise.withResolvers();
  const controller = new AbortController(), signal = AbortSignal.any([t.signal, controller.signal]);
  async function bounded(promise, label, waitSignal = signal, timeout = 8000) {
    let timer, onAbort;
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Timed out waiting for ${label}`)), timeout);
      if (waitSignal) { onAbort = () => reject(waitSignal.reason); if (waitSignal.aborted) onAbort(); else waitSignal.addEventListener('abort', onAbort, { once: true }); }
    });
    try { return await Promise.race([promise, interrupted]); }
    finally { clearTimeout(timer); if (onAbort) waitSignal.removeEventListener('abort', onAbort); }
  }
  let workerStep = 0, origin, runtime, completion;
  const server = http.createServer((req, res) => {
    const handler = (async () => {
      try {
        if (req.method === 'GET' && req.url === '/slow-read') {
          await bounded(anomalyRaised.promise, 'the real supervisor anomaly');
          res.end('Fixed localhost read fixture; no delivery files or verification progress.');
          return;
        }
        let text = ''; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text); requests.push(body);
        const manager = body.model === 'manager-fixture', step = manager ? -1 : workerStep++;
        let name, args;
        if (manager) {
          managerReceived.resolve();
          await bounded(settlementStarted.promise, 'runtime settlement of the original manager request');
          name = 'agent_teams_send_message'; args = { to: 'writer', content: 'Please resume work' };
        } else if (step === 0) {
          // Native team messaging wakes the real captain loop before work stalls.
          name = 'agent_teams_send_message'; args = { to: 'captain', content: 'Coordinate this isolated no-progress fixture while I read its local page.' };
        } else {
          // An actual HTTP arrival, not a scheduling assumption, fences the stall.
          await bounded(managerReceived.promise, 'the original manager HTTP request');
          name = 'browser_read'; args = { url: `${origin}/slow-read` };
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('X-Oneapi-Request-Id', manager ? 'late-original-manager' : `original-worker-${step}`);
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: manager ? 'late-message' : `worker-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: manager ? 37 : 3, completion_tokens: manager ? 5 : 1 } }));
      } catch (error) { fixtureFailed.resolve(error); res.destroy(); }
    })();
    handlers.add(handler); void handler.finally(() => handlers.delete(handler));
  });
  const id = randomUUID();
  try {
    server.listen(0, '127.0.0.1'); await bounded(once(server, 'listening'), 'fixture HTTP listener');
    origin = `http://127.0.0.1:${server.address().port}`;
    const snapshot = {
    projectId: 'settlement-fixture', planVersion: 1, requirement: 'Old planning phase: do not generate files.', executionBudget: 1,
    approval: { kind: 'project', projectVersion: 1 },
    policy: { maxBudget: 1, maxConcurrentAgents: 2, deadlineSeconds: 10, progressTimeoutSeconds: 1, contextManagement: 'prune', maxModelCalls: 10, maxTaskModelCalls: 5, allowedTools: [] },
    agents: [
      { id: 'manager', employeeId: 'manager', role: 'manager', modelId: 'manager-fixture', rolePrompt: 'Coordinate the approved execution.', tools: [] },
      { id: 'writer', employeeId: 'writer', role: 'member', modelId: 'worker-fixture', rolePrompt: 'Complete the assigned task.', tools: ['browser_read'], browserOrigins: [origin] },
    ],
    tasks: [{ id: 'arbitrary-approved-task', kind: 'work', subject: 'Approved implementation', objective: 'Write the approved deliverable', assignee: 'writer', assigneeId: 'writer', dependencies: [] }],
    };
    runtime = new ProductDshRuntime({ traceRoot: root, onUsage: async (_runId, usage) => usages.push(usage), beforeRequest: async () => {}, onCallError: event => unknown.push(event),
      // The domain tool returns a fixed localhost page. Fixed model replies still
      // use real HTTP transport, native messaging, supervision and billing.
      externalTool: async ({ name, args, signal: toolSignal }) => {
        assert.equal(name, 'browser_read'); assert.equal(args.url, `${origin}/slow-read`);
        const response = await fetch(args.url, { signal: AbortSignal.any([signal, toolSignal]) });
        return { text: await response.text() };
      },
      createExecutor: archive => {
        const append = archive.append.bind(archive);
        archive.append = (type, data, links) => {
          const event = append(type, data, links);
          if (type === 'runtime/anomaly') anomalyRaised.resolve();
          if (type === 'runtime/model-settling') settlementStarted.resolve();
          return event;
        };
        const artifacts = join(archive.dir, 'artifacts'); mkdirSync(artifacts, { recursive: true });
        return { root: artifacts, prepare: async () => {}, close: async () => {} };
      } });
    const started = await runtime.start({ runId: id, approvedSnapshot: snapshot, routes: ['manager-fixture', 'worker-fixture'].map(model => ({ ...route, id: model, wireModel: model, baseUrl: `${origin}/v1` })) });
    completion = started.completion;
    const result = await bounded(Promise.race([completion, fixtureFailed.promise.then(error => { throw error; })]), 'runtime completion'), archived = readRun(root, id), events = archived.events;
    assert.equal(result.status, 'failed'); assert.match(result.message, /NO_PROGRESS/); assert.equal(archived.integrity, 'ok');
    const anomaly = events.find(event => event.type === 'runtime/anomaly'); assert.ok(anomaly);
    assert.equal(anomaly.data.code, 'NO_PROGRESS');
    const managerWire = events.find(event => event.type === 'model/wire-request' && event.data.modelId === 'manager-fixture');
    const stalledRead = events.find(event => event.type === 'external/tool-start' && event.data.name === 'browser_read');
    assert.ok(managerWire && stalledRead && managerWire.seq < stalledRead.seq && stalledRead.seq < anomaly.seq);
    assert.ok(events.some(event => event.type === 'runtime/model-settling' && event.data.maxWaitMs === 30000));
    assert.ok(events.some(event => event.type === 'runtime/model-settled' && event.data.finishedRequests === 1 && event.data.pendingRequests === 0 && !event.data.timedOut));
    const managerUsage = usages.find(usage => usage.modelId === 'manager-fixture'); assert.ok(managerUsage); assert.equal(managerUsage.inputTokens, 37); assert.equal(managerUsage.outputTokens, 5); assert.equal(managerUsage.cost, 47 / 1e6);
    assert.ok(events.some(event => event.type === 'billing/provider-response' && event.data.providerRequestId === 'late-original-manager' && event.seq > anomaly.seq));
    assert.ok(events.some(event => event.type === 'billing/usage' && event.data.id === managerUsage.id && event.seq > anomaly.seq));
    assert.ok(!events.some(event => event.type === 'tool/start' && event.data.name === 'agent_teams_send_message' && event.seq > anomaly.seq));
    assert.ok(!events.some(event => event.type === 'model/wire-request' && event.seq > anomaly.seq));
    assert.equal(requests.filter(request => request.model === 'manager-fixture').length, 1); assert.equal(unknown.length, 0);
    const description = events.find(event => event.type === 'tool/start' && event.data.name === 'agent_teams_create')?.data.arguments.description;
    assert.match(description, /已批准的项目执行阶段/); assert.ok(!description.includes(snapshot.requirement)); assert.equal(archived.snapshot.requirement, snapshot.requirement);
  } finally {
    controller.abort(Error('Fixture shutdown'));
    const cancellation = runtime?.cancel(id), closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections();
    const cleanup = await bounded(Promise.allSettled([cancellation, completion, closed, ...handlers]), 'fixture shutdown', null, 3000);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  }
});
