import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, LlmError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';

const textReply = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const prompt = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

test('employee Hosts isolate registries, cancellation, failures and resumed history', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'employee-hosts-'));
  const startedA = Promise.withResolvers(), startedB = Promise.withResolvers(), releaseB = Promise.withResolvers();
  let mode = 'wait', abortedB = false, cancelledA = false;
  const requests = [];
  const adapter = new class extends LlmAdapter {
    async *stream(options) {
      requests.push(options);
      if (mode === 'wait' && options.model === 'a') {
        startedA.resolve();
        await new Promise(resolve => options.signal.addEventListener('abort', () => { cancelledA = true; resolve(); }, { once: true }));
        options.signal.throwIfAborted();
      }
      if (mode === 'wait' && options.model === 'b') {
        options.signal.addEventListener('abort', () => { abortedB = true; }, { once: true });
        startedB.resolve(); await releaseB.promise; options.signal.throwIfAborted();
      }
      if (mode === 'failure' && options.model === 'a') throw new LlmError('isolated failure', 'FIXTURE_FAILURE');
      yield* textReply('completed ' + options.model);
    }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions') });
  let handleA, handleB;
  const setup = role => ctx => { ctx.systemPrompt.section({ name: 'employee-role', order: 100, text: role }); };
  try {
    handleA = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'a' }, setup: setup('ROLE_A') });
    handleB = await host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'b' }, setup: setup('ROLE_B') });
    const a = handleA.agent, b = handleB.agent;
    const worldA = host.employeeHosts().find(item => item.sessionId === a.id), worldB = host.employeeHosts().find(item => item.sessionId === b.id);
    assert.notEqual(worldA.ctx, worldB.ctx); assert.notEqual(worldA.hostId, worldB.hostId);
    assert.deepEqual(a.ctx.agents.list().map(agent => agent.id), [a.id]);
    assert.deepEqual(b.ctx.agents.list().map(agent => agent.id), [b.id]);
    assert.equal(a.ctx.sessions.get(b.id), undefined); assert.equal(b.ctx.sessions.get(a.id), undefined);
    assert.equal(host.ctx.agents.list().length, 2, 'coordination sees both independently owned employees');
    a.followup(prompt('SECRET_A')); b.followup(prompt('SECRET_B'));
    await Promise.all([startedA.promise, startedB.promise]);
    await handleA.dispose();
    assert.equal(cancelledA, true); assert.equal(abortedB, false);
    assert.equal(host.ctx.agents.get(a.id), undefined); assert.equal(host.ctx.agents.get(b.id), b);
    assert.equal(b.status, 'running');
    releaseB.resolve(); await b.whenIdle();
    const requestB = requests.find(item => item.model === 'b');
    assert.ok(JSON.stringify(requestB).includes('ROLE_B')); assert.ok(!JSON.stringify(requestB).includes('SECRET_A'));
    assert.ok(!JSON.stringify(requestB).includes('ROLE_A'));

    mode = 'failure';
    handleA = await host.ctx.agents.resume({ resumeSessionId: a.id, agentOptions: { provider: 'fixture', model: 'a' }, setup: setup('ROLE_A') });
    assert.notEqual(host.employeeHosts().find(item => item.sessionId === a.id).ctx, worldA.ctx);
    handleA.agent.followup(prompt('FAIL_A')); await handleA.agent.whenIdle();
    assert.ok(handleA.agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'));
    assert.equal(host.ctx.agents.get(b.id), b, 'an employee model failure does not release a sibling Host');
    mode = 'complete';
    handleA.agent.followup(prompt('CONTINUE_A')); b.followup(prompt('CONTINUE_B'));
    await Promise.all([handleA.agent.whenIdle(), b.whenIdle()]);
    const resumedA = requests.filter(item => item.model === 'a').at(-1);
    assert.ok(JSON.stringify(resumedA.messages).includes('SECRET_A'));
    assert.ok(!JSON.stringify(resumedA.messages).includes('SECRET_B'));
    assert.ok(JSON.stringify(requests.filter(item => item.model === 'b').at(-1).messages).includes('SECRET_B'));
    assert.equal(host.employeeHosts().length, 2);
  } finally {
    releaseB.resolve(); await host.close();
    assert.equal(host.employeeHosts().length, 0);
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(host.ctx.agents, undefined, 'closing coordination removes its creation service');
});

test('failed employee setup leaves no published Agent or resident Host', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'employee-setup-'));
  const adapter = new class extends LlmAdapter { async *stream() { yield* textReply('unused'); } }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions') });
  try {
    const id = randomUUID();
    await assert.rejects(host.ctx.agents.create({ sessionId: id, meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' }, setup() { throw Error('setup rejected'); } }), /setup rejected/);
    assert.equal(host.ctx.agents.get(id), undefined); assert.equal(host.employeeHosts().length, 0);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('closing coordination cancels an unpublished employee setup and drains its Host', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'employee-startup-'));
  const setupStarted = Promise.withResolvers(), releaseSetup = Promise.withResolvers();
  let modelCalls = 0;
  const adapter = new class extends LlmAdapter { async *stream() { modelCalls++; yield* textReply('unused'); } }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions') });
  try {
    const creating = host.ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' }, async setup() {
      setupStarted.resolve(); await releaseSetup.promise;
    } });
    const rejected = assert.rejects(creating, /disposed|aborted/i);
    await setupStarted.promise;
    await host.close(); await rejected;
    assert.equal(host.employeeHosts().length, 0); assert.equal(modelCalls, 0);
  } finally { releaseSetup.resolve(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
