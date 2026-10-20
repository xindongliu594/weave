import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { ProductDshRuntime } from './product-runtime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tick = () => new Promise(setImmediate);
const route = { id: 'fixture', name: 'fixture', wireModel: 'fixture', baseUrl: 'https://fixture.invalid/v1', inputRate: 1, outputRate: 2, maxOutputTokens: 128 };
const options = { model: route.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] };
const consume = async adapter => { for await (const _ of adapter.stream(options)) {} };
const response = () => Response.json({ choices: [{ message: { content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } });

for (const callback of ['beforeRequest', 'onResponse', 'onUsage', 'onCallError']) test('actual writer drain retains original ' + callback + ' beyond business drain', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; if (callback === 'onCallError') throw Error('fixture transport'); return response(); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, beforeRequest: async () => {}, [callback]: async () => { entered.resolve(); await release.promise; } });
    const drained = adapter.writerDrained;
    assert.ok(drained instanceof Promise);
    assert.equal(adapter.writerDrained, drained);
    let done = false; drained.then(() => { done = true; });
    await tick(); assert.equal(done, false, 'admission is still open');
    const running = consume(adapter).catch(error => error);
    await entered.promise;
    adapter.stopAdmission();
    const settlement = await adapter.drain(1);
    assert.equal(settlement.pendingRequests, callback === 'beforeRequest' ? 0 : 1);
    await tick(); assert.equal(done, false);
    release.resolve(); await running; await drained;
    assert.equal(done, true); assert.equal(requests, callback === 'beforeRequest' ? 0 : 1);
  } finally { release.resolve(); globalThis.fetch = original; }
});

for (const fail of [false, true]) test('pre-Host preparation failure joins only constructed executor cleanup: ' + fail, async () => {
  const root = await mkdtemp(join(tmpdir(), 'writer-bootstrap-')), release = Promise.withResolvers(), entered = Promise.withResolvers();
  let closes = 0;
  try {
    const runtime = new ProductDshRuntime({ traceRoot: root, createExecutor: () => ({ root, prepare: async () => { throw Error('PREPARE_FAILED'); },
      close: async () => { closes++; entered.resolve(); await release.promise; if (fail) throw Error('PRIVATE_CLOSE'); } }) });
    const started = await runtime.start({ runId: randomUUID(), approvedSnapshot: { policy: { maxConcurrentAgents: 1, deadlineSeconds: 5 } }, routes: [] });
    assert.ok(started.writerDrained instanceof Promise);
    const drained = started.writerDrained.catch(error => error);
    await entered.promise;
    assert.equal((await started.completion).status, 'failed');
    assert.equal((await runtime.inspect()).ready, false);
    release.resolve();
    const outcome = await drained;
    assert.equal(closes, 1);
    if (fail) { assert.equal(outcome.code, 'RUNTIME_WRITER_DRAIN_FAILED'); assert.equal(outcome.message.includes('PRIVATE'), false); assert.equal((await runtime.inspect()).ready, false); }
    else { assert.equal(outcome, undefined); assert.equal((await runtime.inspect()).ready, true); }
  } finally { release.resolve(); assert.ok(root.startsWith(join(tmpdir(), 'writer-bootstrap-'))); await rm(root, { recursive: true, force: true }); }
});
