import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools';
import { createTeamHost } from './host.mjs';

// These are isolated transport fixtures for durability ordering, not real-model
// acceptance evidence. Every Host and JSONL backend is the installed DSH code.
const require = createRequire(import.meta.url);
const baseRequire = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));
const policy = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-session-checkpoint-policy')).href);
const reply = function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'isolated ordering fixture' } };
  yield { type: 'finish', reason: { kind: 'stop' } };
};
const prompt = () => createUserMessage({ content: [{ type: 'text', text: 'CHECKPOINT_PREFIX' }], source: { kind: 'user' } });
const persistenceFor = new WeakMap();
async function stored(agent) {
  const reader = await persistenceFor.get(agent).open(agent.id, 'read');
  try { return (await reader.read()).events; } finally { await reader.close(); }
}
async function fixture(stream) {
  const root = await mkdtemp(join(tmpdir(), 'official-checkpoint-'));
  const host = await createTeamHost({ adapter: new class extends LlmAdapter {
    async *stream(options) { options.signal.throwIfAborted(); yield* stream(options); }
  }(), provider: 'fixture', sessionRoot: join(root, 'sessions') });
  const agent = await host.captain({ cwd: root, model: 'fixture' });
  persistenceFor.set(agent, host.employeeHosts().find(slot => slot.sessionId === agent.id).ctx.sessionPersistence);
  return { root, host, agent, async close() { await host.close(); await rm(root, { recursive: true, force: true }); } };
}
function registerProbe(agent, execute) {
  return agent.ctx.tools.register(defineTool({ name: 'checkpoint_probe', description: 'isolated durability probe', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute }));
}

test('official policy belongs to the session Host; bare coordinator mounting rejects foreign sessions', { timeout: 10000 }, async () => {
  const f = await fixture(() => reply());
  let body = 0, foreign;
  try {
    assert.equal(f.agent.ctx.sessions.get(f.agent.id), f.agent.session);
    assert.equal(f.host.ctx.sessions.get(f.agent.id), undefined);
    assert.equal(JSON.parse(require('node:fs').readFileSync(baseRequire.resolve('@deepseek-ai/dsh-session-checkpoint-policy/package.json'))).version, '0.1.5-rc.1');
    f.host.ctx.tools.register(defineTool({ name: 'coordinator_probe', description: 'foreign store probe', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute() { body++; return 'ran'; } }));
    foreign = f.host.ctx.plugin(policy); await foreign.await();
    const rejected = await f.host.ctx.tools.execute({ name: 'coordinator_probe', arguments: {}, callId: randomUUID(), agent: f.agent, signal: AbortSignal.timeout(5000) });
    assert.equal(rejected.isError, true);
    assert.match(rejected.error.message, /not live in this store/);
    assert.equal(body, 0);
    await foreign.dispose(); foreign = undefined;
    const accepted = await f.host.ctx.tools.execute({ name: 'coordinator_probe', arguments: {}, callId: randomUUID(), agent: f.agent, signal: AbortSignal.timeout(5000) });
    assert.equal(accepted.isError, false); assert.equal(body, 1);
  } finally { await foreign?.dispose(); await f.close(); }
});

test('model adapter waits for request-prefix flush and observes persisted JSONL before dispatch', { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0, detach;
  const f = await fixture(async function* (options) {
    calls++;
    const events = await stored(f.agent);
    assert.ok(events.some(event => event.type === 'request/header'));
    assert.ok(JSON.stringify(events).includes('CHECKPOINT_PREFIX'));
    assert.equal(options.sessionId, f.agent.id);
    yield* reply();
  });
  try {
    detach = f.agent.ctx.on('session/flush', session => {
      if (session.snapshotEvents().some(event => event.type === 'request/header')) {
        entered.resolve(); return release.promise;
      }
    });
    f.agent.followup(prompt()); await entered.promise;
    assert.equal(calls, 0, 'adapter must not be constructed while the durability barrier is pending');
    release.resolve(); await f.agent.whenIdle(); assert.equal(calls, 1);
  } finally { release.resolve(); detach?.(); await f.close(); }
});

test('request-prefix flush rejection prevents all model adapter dispatch', { timeout: 10000 }, async () => {
  let calls = 0, detach;
  const f = await fixture(function* () { calls++; yield* reply(); });
  try {
    detach = f.agent.ctx.on('session/flush', session => {
      if (session.snapshotEvents().some(event => event.type === 'request/header')) throw Error('ISOLATED_CHECKPOINT_WRITE_FAILURE');
    });
    f.agent.followup(prompt()); await f.agent.whenIdle();
    assert.equal(calls, 0);
    assert.ok(JSON.stringify(f.agent.session.snapshotEvents()).includes('ISOLATED_CHECKPOINT_WRITE_FAILURE'));
  } finally { detach?.(); await f.close(); }
});

test('model-generated top-level tool call waits for flush and sees its persisted call before body', { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0, body = 0, detach;
  const f = await fixture(function* () {
    if (calls++ === 0) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name: 'checkpoint_probe', arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else yield* reply();
  });
  try {
    registerProbe(f.agent, async () => {
      body++;
      assert.ok((await stored(f.agent)).some(event => event.type === 'tool/call' && JSON.stringify(event.data).includes('checkpoint_probe')));
      return 'body-dispatched-after-durable-call';
    });
    detach = f.agent.ctx.on('session/flush', session => {
      if (!body && session.snapshotEvents().some(event => event.type === 'tool/call')) {
        entered.resolve(); return release.promise;
      }
    });
    f.agent.followup(prompt()); await entered.promise;
    assert.equal(body, 0); release.resolve(); await f.agent.whenIdle();
    assert.equal(body, 1, JSON.stringify(f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result' || event.type === 'turn/end'))); assert.equal(calls, 2);
    assert.ok((await stored(f.agent)).some(event => event.type === 'tool/result'));
  } finally { release.resolve(); detach?.(); await f.close(); }
});

test('top-level tool checkpoint rejection prevents tool side effects', { timeout: 10000 }, async () => {
  let body = 0, detach;
  const f = await fixture(() => reply());
  try {
    registerProbe(f.agent, () => { body++; return 'must not run'; });
    detach = f.agent.ctx.on('session/flush', () => { throw Error('ISOLATED_TOOL_CHECKPOINT_FAILURE'); });
    const result = await f.agent.ctx.tools.execute({ name: 'checkpoint_probe', arguments: {}, callId: randomUUID(), agent: f.agent, signal: AbortSignal.timeout(5000) });
    assert.equal(result.isError, true); assert.match(result.error.message, /ISOLATED_TOOL_CHECKPOINT_FAILURE/);
    assert.equal(body, 0);
  } finally { detach?.(); await f.close(); }
});

test('cancellation while a tool checkpoint is pending releases without dispatch or unknown side effects', { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController();
  let body = 0, detach;
  const f = await fixture(() => reply());
  try {
    registerProbe(f.agent, () => { body++; return 'must not run'; });
    detach = f.agent.ctx.on('session/flush', () => { entered.resolve(); return release.promise; });
    const pending = f.agent.ctx.tools.execute({ name: 'checkpoint_probe', arguments: {}, callId: randomUUID(), agent: f.agent, signal: controller.signal });
    await entered.promise; controller.abort(Error('controlled fixture cancellation')); release.resolve();
    const result = await pending;
    assert.equal(body, 0); assert.equal(result.isError, true);
    assert.equal(result.error.info.code, TOOL_ABORTED_BEFORE_DISPATCH);
  } finally { release.resolve(); detach?.(); await f.close(); }
});

test('Host close drains a pending model checkpoint and never dispatches its cancelled request', { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0, detach, closing, detachRequest, signal;
  const f = await fixture(function* () { calls++; yield* reply(); });
  try {
    detachRequest = f.agent.ctx.on('llm/stream', (options, next) => { signal = options.signal; return next(); }, { prepend: true });
    detach = f.agent.ctx.on('session/flush', session => {
      if (session.snapshotEvents().some(event => event.type === 'request/header')) { entered.resolve(); return release.promise; }
    });
    f.agent.followup(prompt()); await entered.promise;
    assert.ok(signal);
    const cancelled = Promise.withResolvers();
    signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    closing = f.host.close(); await cancelled.promise; release.resolve(); await closing;
    assert.equal(calls, 0);
    assert.equal(f.host.employeeHosts().length, 0);
  } finally { release.resolve(); detach?.(); detachRequest?.(); await closing; await f.close(); }
});
