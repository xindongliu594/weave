import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools';
import { installTaskToolBoundary } from './task-tool-boundary.mjs';

const definition = (name, execute = async () => ({ ok: true })) => defineTool({ name, description: name, parameters: {},
  output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute });

async function fixture(t, enabled = true, configured = true) {
  const ctx = new Context(), fibers = [];
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools']) {
    const plugin = await import(name), fiber = ctx.plugin(plugin.default ?? plugin);
    fibers.push(fiber); await fiber.await();
  }
  assert.equal(typeof installTaskToolBoundary, 'function', 'shared boundary API must exist');
  const boundary = enabled ? installTaskToolBoundary(ctx) : undefined;
  const agent = { id: randomUUID() }; let scope;
  const scopedFiber = ctx.inject(['tools'], owner => { scope = createScope(owner, agent); });
  fibers.push(scopedFiber); await scopedFiber.await(); await scope.ctx.fiber.await();
  agent.ctx = scope.ctx;
  const admitted = new Set();
  const policy = (exec, actual) => exec.agent !== agent ? 'PRINCIPAL_DENIED' : admitted.has(actual) ? undefined : 'DEFINITION_DENIED';
  if (configured) boundary?.setPolicy(policy);
  const admit = (name, inScope = false, raw = definition(name)) => {
    (inScope ? agent.ctx : ctx).tools.register(raw);
    const wrapped = ctx.tools.get(name, inScope ? agent : undefined); admitted.add(wrapped); return wrapped;
  };
  const call = (name, overrides = {}) => ctx.tools.execute({ callId: randomUUID(), name, arguments: {}, agent,
    signal: AbortSignal.timeout(2000), ...overrides });
  t.after(async () => { boundary?.dispose(); await scope.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); });
  return { ctx, agent, boundary, admitted, admit, call, policy };
}

test('admitted actual DSH tool runs and preserves output, finalizer and metadata', async t => {
  const { ctx, agent, admit, call } = await fixture(t);
  let bodies = 0;
  const raw = definition('normal', async () => { bodies++; return { ok: true }; });
  raw.finalizeContent = () => [{ type: 'text', text: 'finalized' }];
  raw.timeoutMs = 1234;
  raw.presentCall = () => undefined; raw.presentResult = () => undefined; raw.isConcurrencySafe = () => true;
  raw.output.presentationMeta = () => ({ kind: 'preserved' });
  const wrapped = admit('normal', false, raw);
  const result = await call('normal');
  assert.equal(result.isError, false); assert.deepEqual(result.value, { ok: true }); assert.equal(bodies, 1);
  assert.equal(result.content[0].text, 'finalized'); assert.equal(wrapped.timeoutMs, 1234);
  assert.equal(wrapped.output.render({}, { ok: true })[0].text, '{"ok":true}');
  assert.equal(wrapped.presentCall, raw.presentCall); assert.equal(wrapped.presentResult, raw.presentResult);
  assert.equal(wrapped.isConcurrencySafe, raw.isConcurrencySafe); assert.deepEqual(wrapped.output.presentationMeta(), { kind: 'preserved' });
  assert.ok(Object.isFrozen(wrapped)); assert.ok(Object.isFrozen(wrapped.parameters)); assert.ok(Object.isFrozen(wrapped.output.schema));
  assert.equal(ctx.tools.get('normal', agent), wrapped);
});

test('missing or foreign principal rejects before body', async t => {
  const { agent, admit, call } = await fixture(t);
  let bodies = 0; admit('normal', false, definition('normal', async () => { bodies++; return {}; }));
  assert.equal((await call('normal', { agent: undefined })).isError, true);
  assert.equal((await call('normal', { agent: { id: agent.id } })).isError, true);
  assert.equal(bodies, 0);
});

test('unconfigured boundary defaults to denial', async t => {
  const { admit, call } = await fixture(t, true, false);
  let bodies = 0; admit('unconfigured', false, definition('unconfigured', async () => { bodies++; return {}; }));
  assert.equal((await call('unconfigured')).isError, true); assert.equal(bodies, 0);
});

test('normal pre-execute transformation is governed by final guard snapshot', async t => {
  const { ctx, admit, call } = await fixture(t);
  let bodies = 0; admit('actual', false, definition('actual', async () => { bodies++; return {}; }));
  ctx.on('tools/pre-execute', async (exec, next) => { exec.name = 'actual'; return next(); });
  assert.equal((await call('requested')).isError, false); assert.equal(bodies, 1);
});

for (const kind of ['shadow', 'replacement', 'wrapped-execute']) for (const prepend of [true, false]) test('async execute '+kind+' cannot bypass '+(prepend ? 'outer' : 'inner')+' middleware', async t => {
  const { ctx, agent, admitted, call } = await fixture(t);
  let good = 0, substituted = 0;
  const source = definition('normal', async () => { good++; return {}; });
  const remove = ctx.tools.register(source), wrapped = ctx.tools.get('normal');
  admitted.add(wrapped);
  ctx.on('tools/execute', async (_exec, next) => { await Promise.resolve(); return next(); });
  ctx.on('tools/execute', async (exec, next) => {
    await Promise.resolve();
    if (kind === 'shadow') agent.ctx.tools.register(definition('normal', async () => { substituted++; return {}; }));
    if (kind === 'replacement') { remove(); ctx.tools.register(definition('normal', async () => { substituted++; return {}; })); }
    if (kind === 'wrapped-execute') wrapped.execute = async () => { substituted++; return {}; };
    return next();
  }, { prepend });
  const state = await call('normal');
  assert.equal(state.isError, true); assert.equal(substituted, 0); assert.equal(good, 0);
});

test('source execute replacement cannot change the captured raw callback', async t => {
  const { ctx, admit, call } = await fixture(t);
  let original = 0, replaced = 0;
  const raw = definition('normal', async () => { original++; return {}; });
  admit('normal', false, raw);
  ctx.on('tools/execute', async (_exec, next) => {
    await Promise.resolve(); raw.execute = async () => { replaced++; return {}; }; return next();
  });
  assert.equal((await call('normal')).isError, false); assert.equal(original, 1); assert.equal(replaced, 0);
});

for (const key of ['name', 'agent', 'arguments', 'callId', 'rootCallId', 'token', 'parent', 'deferContext', 'concludeTurn']) test('after-guard '+key+' mutation rejects before raw body', async t => {
  const { ctx, agent, admit, call } = await fixture(t);
  let bodies = 0;
  admit('normal', false, definition('normal', async () => { bodies++; return {}; }));
  admit('other', false, definition('other', async () => { bodies++; return {}; }));
  ctx.on('tools/execute', async (exec, next) => {
    await Promise.resolve();
    exec[key] = key === 'name' ? 'other' : key === 'agent' ? { id: agent.id } : key === 'arguments' ? {} : key === 'token' || key === 'parent' ? Symbol() : 'changed';
    return next();
  });
  assert.equal((await call('normal')).isError, true); assert.equal(bodies, 0);
});

test('current policy is rechecked after async middleware and cannot become asynchronous', async t => {
  const { ctx, boundary, admit, call } = await fixture(t);
  let bodies = 0; admit('normal', false, definition('normal', async () => { bodies++; return {}; }));
  const remove = ctx.on('tools/execute', async (_exec, next) => { await Promise.resolve(); boundary.setPolicy(() => 'REVOKED'); return next(); });
  assert.equal((await call('normal')).isError, true); remove();
  boundary.setPolicy(async () => undefined);
  const result = await call('normal'); assert.equal(result.isError, true); assert.match(result.error.message, /TASK_TOOL_POLICY_INVALID/);
  assert.equal(bodies, 0);
});

test('calling registered body directly cannot skip native guard admission', async t => {
  const { agent, admit } = await fixture(t);
  let bodies = 0; const wrapped = admit('normal', false, definition('normal', async () => { bodies++; return {}; }));
  await assert.rejects(wrapped.execute({}, { agent, name: 'normal' }), /TASK_TOOL_BINDING_CHANGED/); assert.equal(bodies, 0);
});

test('admitted execution cannot be reused with different body arguments', async t => {
  const { ctx, agent, admit, call } = await fixture(t);
  let bodies = 0; admit('normal', false, definition('normal', async () => { bodies++; return {}; }));
  ctx.on('tools/execute', async (exec, _next) => {
    await Promise.resolve(); return ctx.tools.get('normal', agent).execute({ forged: true }, exec);
  });
  assert.equal((await call('normal')).isError, true); assert.equal(bodies, 0);
});

test('captured callback invocation ignores later call-property replacement', async t => {
  const { ctx, admit, call } = await fixture(t);
  let original = 0, replaced = 0;
  const raw = definition('normal', async () => { original++; return {}; });
  admit('normal', false, raw);
  ctx.on('tools/execute', async (_exec, next) => {
    raw.execute.call = async () => { replaced++; return {}; }; return next();
  });
  assert.equal((await call('normal')).isError, false); assert.equal(original, 1); assert.equal(replaced, 0);
});

test('scope registration preserves native dynamic this and late shadow is denied', async t => {
  const { ctx, agent, admit, call } = await fixture(t);
  admit('scoped', true);
  assert.equal(ctx.tools.get('scoped'), undefined); assert.ok(ctx.tools.get('scoped', agent));
  assert.equal((await call('scoped')).isError, false);
  let bodies = 0;
  agent.ctx.tools.register(definition('late', async () => { bodies++; return {}; }));
  assert.equal(ctx.tools.get('late'), undefined);
  assert.equal((await call('late')).isError, true); assert.equal(bodies, 0);
});

test('nested execution requires its own admission and scheduler uses the same body boundary', async t => {
  const { ctx, agent, admit, call } = await fixture(t);
  let children = 0;
  ctx.tools.register(definition('child', async () => { children++; return {}; }));
  admit('parent', false, definition('parent', async (_args, exec) => {
    const result = await call('child', { rootCallId: exec.rootCallId, parent: exec.token });
    assert.equal(result.isError, true); return {};
  }));
  assert.equal((await call('parent')).isError, false); assert.equal(children, 0);
  const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER];
  const prepared = await scheduler.prepare({ callId: randomUUID(), name: 'parent', arguments: {}, agent, signal: AbortSignal.timeout(2000) });
  assert.equal(prepared.kind, 'dispatch');
  const outcome = await scheduler.dispatch(prepared.exec);
  const result = await scheduler.finalize(prepared.exec, outcome.result);
  assert.equal(result.isError, false); assert.equal(children, 0);
});

test('signal replacement stays supported and disposed boundary fails closed', async t => {
  const { ctx, boundary, admit, call } = await fixture(t);
  let bodies = 0; admit('normal', false, definition('normal', async () => { bodies++; return {}; }));
  ctx.on('tools/execute', async (exec, next) => { const signal = exec.signal; exec.signal = new AbortController().signal;
    try { return await next(); } finally { exec.signal = signal; } });
  assert.equal((await call('normal')).isError, false);
  boundary.dispose(); assert.equal((await call('normal')).isError, true); assert.equal(bodies, 1);
});

test('uninstalled legacy registry remains native', async t => {
  const { ctx, call } = await fixture(t, false);
  let bodies = 0; const raw = definition('legacy', async () => { bodies++; return {}; });
  ctx.tools.register(raw); assert.equal(ctx.tools.get('legacy'), raw);
  assert.equal((await call('legacy', { agent: undefined })).isError, false); assert.equal(bodies, 1);
});
