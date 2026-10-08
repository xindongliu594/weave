import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { LlmAdapter, LlmError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { EmployeeHostFactory } from './employee-hosts.mjs';
import { installProductTools, employeeFor, PRODUCT_TOOL_NAMES } from './product-tools.mjs';
import { Semaphore } from './limits.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';

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

test('approved domain schemas are scoped to each employee before a model request and are reapplied on cold resume', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'employee-granted-tools-'));
  const captainId = randomUUID(), readerId = randomUUID(), writerId = randomUUID(), requests = [], sandboxCalls = [], approvals = [];
  const revisions = new Map([['captain', 1], ['reader', 1], ['writer', 1]]);
  const snapshot = { agents: [
    { id: 'captain', role: 'manager', tools: ['filesystem'] },
    { id: 'reader', role: 'member', tools: ['filesystem', 'knowledge_search'] },
    { id: 'writer', role: 'member', tools: ['artifact_write', 'terminal_test'] },
  ], knowledge: { reader: [{ id: 'fixed-chunk', documentId: 'fixed-doc', version: 3, sha256: 'a'.repeat(64), content: '固定授权版本资料', lineStart: 1, lineEnd: 1 }] } };
  const archive = createRunArchive(join(root, 'runs'), snapshot);
  const adapter = new class extends LlmAdapter {
    async *stream(options) { requests.push(options); yield* textReply('local schema fixture'); }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions') });
  const localRequire = createRequire(import.meta.url), baseRequire = createRequire(localRequire.resolve('@deepseek-ai/dsh-base/package.json'));
  let removeTools, factory;
  const names = agent => agent.ctx.tools.schemas(agent).map(tool => tool.name);
  const domain = agent => names(agent).filter(name => PRODUCT_TOOL_NAMES.includes(name)).sort();
  try {
    removeTools = installProductTools(host.ctx, { snapshot, archive, captainId: () => captainId, gate: new Semaphore(1),
      sandbox: { revision: () => 'fixed-workspace', async execute(name, args) { sandboxCalls.push({ name, args }); return { path: 'fixed.mjs', sha256: 'b'.repeat(64), content: '完整固定文件', artifacts: [] }; } },
      requestApproval: async (...args) => { approvals.push(args); return 'approved-command'; } });
    factory = new EmployeeHostFactory({ coordinator: host.ctx, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive,
      identify: agent => agent.session.header.parentSession ? employeeFor(agent, snapshot, captainId) : snapshot.agents[0],
      protectedContext: agent => {
        const employee = agent.session.header.parentSession ? employeeFor(agent, snapshot, captainId) : snapshot.agents[0];
        return JSON.stringify({ fixtureContract: 'APPROVED_DYNAMIC_' + employee.id, revision: revisions.get(employee.id),
          task: { runtimeTaskId: 'task-' + employee.id, objective: 'approved contract for ' + employee.id },
          budget: { occupied: revisions.get(employee.id) / 10, callsRemaining: 20 - revisions.get(employee.id) } });
      },
      loadPlugin: name => import(pathToFileURL(baseRequire.resolve(name)).href) });
    const captain = await factory.createAgent(host.ctx, { sessionId: captainId, meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'captain-model' } });
    const childOptions = (sessionId, employeeId) => ({ sessionId, parentAgent: captain.agent, meta: { cwd: root, parentSession: captainId },
      agentOptions: { provider: 'fixture', model: employeeId + '-model' }, setup(_ctx, agent) {
        agent.session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'fixture:' + employeeId, agentProvider: 'fixture', agentModel: employeeId + '-model' });
      } });
    let reader = await factory.createAgent(host.ctx, childOptions(readerId, 'reader'));
    const writer = await factory.createAgent(host.ctx, childOptions(writerId, 'writer'));
    assert.deepEqual(domain(captain.agent), ['filesystem']);
    assert.deepEqual(domain(reader.agent), ['filesystem', 'knowledge_search']);
    assert.deepEqual(domain(writer.agent), ['artifact_write', 'terminal_test']);
    assert.deepEqual(host.ctx.tools.schemas().filter(tool => PRODUCT_TOOL_NAMES.includes(tool.name)).map(tool => tool.name).sort(), [...PRODUCT_TOOL_NAMES].sort());
    for (const agent of [captain.agent, reader.agent, writer.agent]) {
      for (const name of ['agent_teams_claim_task', 'agent_teams_update_task', 'agent_teams_send_message', 'agent_teams_status']) assert.ok(names(agent).includes(name), name);
      agent.followup(prompt('Inspect approved capabilities')); await agent.whenIdle();
    }
    for (const [agent, allowed] of [[reader.agent, snapshot.agents[1].tools], [writer.agent, snapshot.agents[2].tools]]) {
      const request = requests.find(item => item.sessionId === agent.id);
      assert.ok(request); assert.deepEqual(request.tools.filter(tool => PRODUCT_TOOL_NAMES.includes(tool.name)).map(tool => tool.name).sort(), [...allowed].sort());
    }
    const checkCurrentContext = (sessionId, employeeId, revision) => {
      const request = requests.filter(item => item.sessionId === sessionId).at(-1);
      const context = request.messages.findLast(message => message.source?.kind === 'plugin' &&
        message.source.plugin === '@deepseek-ai/dsh-system-prompt' && message.source.form === 'snapshot');
      assert.ok(context, 'the native model request carries a fresh runtime-context snapshot');
      const section = context.source.sections.find(item => item.name === 'department:approved-context');
      assert.ok(section);
      const contract = JSON.parse(section.text);
      assert.equal(contract.fixtureContract, 'APPROVED_DYNAMIC_' + employeeId); assert.equal(contract.revision, revision);
      assert.equal(contract.task.runtimeTaskId, 'task-' + employeeId);
      assert.equal(contract.budget.occupied, revision / 10); assert.equal(contract.budget.callsRemaining, 20 - revision);
      assert.ok(!JSON.stringify(context).includes('APPROVED_DYNAMIC_' + (employeeId === 'reader' ? 'writer' : 'reader')));
      assert.ok(!request.system?.includes('APPROVED_DYNAMIC_'), 'dynamic approved context is not cached in the request header');
    };
    checkCurrentContext(readerId, 'reader', 1); checkCurrentContext(writerId, 'writer', 1);
    revisions.set('reader', 2);
    reader.agent.followup(prompt('Use updated approved task and remaining budget')); await reader.agent.whenIdle();
    checkCurrentContext(readerId, 'reader', 2); checkCurrentContext(writerId, 'writer', 1);
    await assert.rejects(host.call(reader.agent, 'artifact_write', { path: 'fixed.mjs', content: 'not permitted' }), /UNKNOWN_TOOL/);
    const denied = await host.ctx.tools.execute({ callId: randomUUID(), name: 'artifact_write', arguments: { path: 'fixed.mjs', content: 'not permitted' }, agent: reader.agent, signal: AbortSignal.timeout(1000) });
    assert.equal(denied.isError, true); assert.match(denied.error.message, /TOOL_PERMISSION_DENIED/); assert.equal(sandboxCalls.length, 0);
    const file = await host.call(reader.agent, 'filesystem', { path: 'fixed.mjs' });
    assert.equal(file.content, '完整固定文件'); assert.equal(file.sha256, 'b'.repeat(64));
    const knowledge = await host.call(reader.agent, 'knowledge_search', { query: '授权版本' });
    assert.equal(knowledge[0].version, 3); assert.equal(knowledge[0].content, '固定授权版本资料');
    await host.call(writer.agent, 'terminal_test', { command: 'fixture-test' });
    assert.equal(approvals.length, 1); assert.equal(sandboxCalls.filter(call => call.name === 'terminal_test').length, 1);
    const firstCtx = reader.agent.ctx;
    await reader.dispose();
    assert.deepEqual(domain(writer.agent), ['artifact_write', 'terminal_test']); assert.deepEqual(domain(captain.agent), ['filesystem']);
    revisions.set('reader', 3);
    reader = await factory.resume(host.ctx, { resumeSessionId: readerId, parentAgent: captain.agent, agentOptions: { provider: 'fixture', model: 'reader-model' } });
    assert.notEqual(reader.agent.ctx, firstCtx); assert.deepEqual(domain(reader.agent), ['filesystem', 'knowledge_search']);
    assert.ok(reader.agent.session.snapshotEvents().some(event => event.type === 'subagent/descriptor' && event.data.label === 'fixture:reader'));
    reader.agent.followup(prompt('Resume with the same approved grants')); await reader.agent.whenIdle();
    checkCurrentContext(readerId, 'reader', 3); checkCurrentContext(writerId, 'writer', 1);
    assert.deepEqual(requests.filter(item => item.sessionId === readerId).at(-1).tools.filter(tool => PRODUCT_TOOL_NAMES.includes(tool.name)).map(tool => tool.name).sort(), ['filesystem', 'knowledge_search']);
    await assert.rejects(host.call(reader.agent, 'terminal', { command: 'unapproved' }), /UNKNOWN_TOOL/);
    assert.deepEqual(domain(writer.agent), ['artifact_write', 'terminal_test']); assert.deepEqual(domain(captain.agent), ['filesystem']);
    const records = readRun(join(root, 'runs'), archive.id).events.filter(event => event.type === 'runtime/tool-schema-filtered' && event.data.agentId === 'reader');
    assert.deepEqual(records.map(event => event.data.resumed), [false, true]);
    assert.ok(records.every(event => event.data.removed.includes('terminal') && !event.data.removed.includes('filesystem')));
  } finally { await factory?.close(); removeTools?.(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
