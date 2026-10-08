import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt';
import { EmployeeHostFactory } from './employee-hosts.mjs';
import { createTeamHost } from './host.mjs';
import { ExecutionBudget } from './budget.mjs';
import { executionBudgetContext } from './budget-context.mjs';

const snapshotName = 'department:approved-context';
const isSnapshot = message => message.source?.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-system-prompt' && message.source.form === 'snapshot';
const lastSnapshot = messages => messages.findLast(message => isSnapshot(message) && message.source.sections.some(section => section.name === snapshotName));
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const snapshotMessage = (plugin, text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, form: 'snapshot', sections: [{ name: snapshotName, text }] } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'admission-context-')), requests = [], decisions = [];
  const employee = { id: 'employee-runtime', employeeId: 'qa', modelId: 'fixture', tools: [] };
  const contract = { id: 'qa', assigneeId: 'qa', assignee: employee.id, objective: 'Independent fixed-version verification', maxBudget: .4,
    inputs: [{ path: 'server.mjs', sha256: 'a'.repeat(64) }], outputs: [], verify: ['fixture-only-test'] };
  const snapshot = { agents: [employee], tasks: [contract], recovery: { completed: [{ taskId: 'dev' }], files: [{ path: 'server.mjs', sha256: 'a'.repeat(64) }] } };
  const budget = new ExecutionBudget({ maxBudget: .4, priorSpend: .1, maxModelCalls: 20, priorModelCalls: 2, tasks: snapshot.tasks,
    taskUsage: { qa: { cost: .04, calls: 2 } } });
  budget.reserve(.03, { taskId: 'qa', employeeId: 'qa' }); // An existing local unknown hold stays occupied.
  const state = { allow: false, admitted: false, callbacks: 0, rejectedCallbacks: undefined, round: 0 };
  const adapter = new class extends LlmAdapter {
    async *stream(options) { requests.push(options); yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'local admission fixture' } }; yield { type: 'finish', reason: { kind: 'stop' } }; }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions') });
  const localRequire = createRequire(import.meta.url), baseRequire = createRequire(localRequire.resolve('@deepseek-ai/dsh-base/package.json'));
  const current = () => ({ task: contract, recovery: snapshot.recovery, round: state.round,
    budget: executionBudgetContext({ budget, snapshot, taskId: 'qa', routes: [{ id: 'fixture', inputRate: 2, outputRate: 10 }] }) });
  const protectedContext = () => { state.callbacks++; return JSON.stringify(state.admitted ? current() : { status: 'waiting-for-native-admission' }); };
  const factory = new EmployeeHostFactory({ coordinator: host.ctx, provider: 'fixture', sessionRoot: join(root, 'sessions'), identify: () => employee,
    protectedContext, loadPlugin: name => import(pathToFileURL(baseRequire.resolve(name)).href) });
  const setup = agentCtx => {
    agentCtx.systemPrompt.context({ name: 'other:unchanged', order: 120, text: 'UNCHANGED_OTHER_CONTEXT' });
    agentCtx.on('agent/pre-step', async (_event, next) => {
      if (!state.allow) { state.rejectedCallbacks = state.callbacks; return { kind: 'reject' }; }
      const decision = await next();
      // The native fixture commits its task identity and a concurrent local
      // receipt after assembly, just before outer admission hooks resume.
      state.admitted = true; state.round++;
      budget.reserve(.01, { taskId: 'qa', employeeId: 'qa' }).settle(.006);
      const prior = snapshotMessage('@deepseek-ai/dsh-system-prompt', 'OLDER_SNAPSHOT_MUST_NOT_CHANGE');
      const foreign = snapshotMessage('fixture-unrelated-plugin', 'FOREIGN_SNAPSHOT_MUST_NOT_CHANGE');
      const messages = [prior, foreign, ...decision.messages];
      const frozen = freeze({ ...decision, messages });
      decisions.push({ decision: frozen, before: structuredClone(messages), callbacksBeforeRefresh: state.callbacks });
      return frozen;
    });
  };
  const sessionId = randomUUID();
  let handle = await factory.createAgent(host.ctx, { sessionId, meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' }, setup });
  await handle.agent.whenIdle();
  return { requests, decisions, state, budget, current, get agent() { return handle.agent; },
    async turn(text) { handle.agent.followup(user(text)); await handle.agent.whenIdle(); },
    async resume() {
      const old = handle.agent.ctx; await handle.dispose(); state.allow = false; state.admitted = false;
      handle = await factory.resume(host.ctx, { resumeSessionId: sessionId, agentOptions: { provider: 'fixture', model: 'fixture' }, setup });
      await handle.agent.whenIdle(); assert.notEqual(handle.agent.ctx, old);
    },
    async close() { await factory.close(); await host.close(); await rm(root, { recursive: true, force: true }); } };
}

function checkAdmitted(f) {
  const request = f.requests.at(-1), captured = f.decisions.at(-1), message = lastSnapshot(request.messages);
  assert.ok(message); assert.deepEqual(JSON.parse(message.source.sections.find(section => section.name === snapshotName).text), f.current());
  assert.equal(message.content[0].text, joinContextSections(message.source.sections));
  assert.equal(message.source.sections.find(section => section.name === 'other:unchanged').text, 'UNCHANGED_OTHER_CONTEXT');
  assert.ok(message.content[0].text.includes('UNCHANGED_OTHER_CONTEXT'));
  assert.equal(f.state.callbacks, captured.callbacksBeforeRefresh + 1, 'only the admitted snapshot receives one late refresh');
  assert.deepEqual(captured.decision.messages, captured.before, 'the complete original decision messages remain immutable');
  assert.ok(captured.before.at(-1).content[0].text.includes('waiting-for-native-admission'), 'the fixture exercises stale pre-admission assembly');
  for (const original of captured.before.slice(0, -1)) assert.ok(request.messages.some(item => JSON.stringify(item) === JSON.stringify(original)), 'older snapshots, foreign contexts and user messages stay intact');
  const persisted = lastSnapshot(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data));
  assert.deepEqual(persisted, message, 'the loop archives exactly the refreshed model-facing message');
  assert.equal(f.budget.run.reserved, .03, 'unknown reservation is not released by prompt refresh');
  assert.ok(JSON.parse(message.source.sections.find(section => section.name === snapshotName).text).budget.project.occupied >= .13);
  return message;
}

test('admitted employee step refreshes current task and occupied budget before durable append without changing other messages', async () => {
  const f = await fixture();
  try { assert.equal(f.requests.length, 0); f.state.allow = true; await f.turn('ORIGINAL_USER_MESSAGE'); assert.equal(f.requests.length, 1); checkAdmitted(f); }
  finally { await f.close(); }
});

test('rejected native admission cannot refresh a snapshot, dispatch a model or change the occupied budget', async () => {
  const f = await fixture(), before = { spent: f.budget.run.spent, reserved: f.budget.run.reserved, calls: f.budget.run.calls };
  try {
    await f.turn('REJECTED_USER_MESSAGE'); assert.equal(f.requests.length, 0); assert.equal(f.decisions.length, 0);
    assert.equal(f.state.callbacks, f.state.rejectedCallbacks, 'rejection returns before protectedContext is recomputed');
    assert.deepEqual({ spent: f.budget.run.spent, reserved: f.budget.run.reserved, calls: f.budget.run.calls }, before);
    assert.ok(!f.agent.session.snapshotEvents().some(event => event.type === 'user/message' && isSnapshot(event.data)), 'unadmitted context is not appended');
  } finally { await f.close(); }
});

test('cold-resumed employee refreshes the newly admitted contract and remaining calls while retaining the previous archived snapshot', async () => {
  const f = await fixture();
  try {
    f.state.allow = true; await f.turn('FIRST_LOCAL_TASK'); const first = structuredClone(checkAdmitted(f));
    const previousCalls = f.budget.run.calls;
    await f.resume(); assert.equal(f.requests.length, 1, 'cold resume admission rejection does not replay a model');
    f.state.allow = true; await f.turn('RESUME_LOCAL_TASK'); assert.equal(f.requests.length, 2);
    const latest = checkAdmitted(f);
    const contract = JSON.parse(latest.source.sections.find(section => section.name === snapshotName).text);
    assert.equal(contract.round, 2); assert.equal(f.budget.run.calls, previousCalls + 1);
    assert.equal(contract.budget.project.callsRemaining, f.budget.run.maxCalls - f.budget.run.calls);
    assert.ok(f.agent.session.snapshotEvents().some(event => event.type === 'user/message' && JSON.stringify(event.data) === JSON.stringify(first)), 'the complete previous contract remains in the original archive');
    assert.equal(contract.task.inputs[0].sha256, 'a'.repeat(64)); assert.equal(contract.recovery.files[0].sha256, 'a'.repeat(64));
  } finally { await f.close(); }
});
