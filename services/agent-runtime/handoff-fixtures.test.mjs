import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createTeamHost } from './host.mjs';
import { employeeFor } from './product-tools.mjs';
import { Semaphore } from './limits.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { teamTaskPlan, stageApprovedTeam } from './handoff.mjs';
import { fixtureText, fixtureJson, makeFixtureFiles, inspectInput, validateFixtureGraph } from './test-support/handoff-fixtures.mjs';

const originalFetch = globalThis.fetch;
let networkAttempts = 0;
before(() => { globalThis.fetch = async () => { networkAttempts++; throw Error('FIXTURE_NETWORK_FORBIDDEN'); }; });
after(() => { globalThis.fetch = originalFetch; assert.equal(networkAttempts, 0, 'no HTTP/model request is allowed'); });

async function runScenario(scenario) {
  const root = await mkdtemp(join(tmpdir(), 'department-handoff-'));
  const workspace = join(root, 'workspace'), files = makeFixtureFiles(join(root, 'artifacts'));
  mkdirSync(workspace);
  const plan = fixtureJson('plan.json');
  assert.deepEqual(validateFixtureGraph(plan), []);
  const tasks = plan.tasks.map(task => ({ ...task,
    inputs: (task.inputs ?? []).map(input => ({ path: input.path, ...(input.producer === 'user' ? { sha256: files.read(input.path).sha256 } : { producerTaskId: input.producer }) })),
    outputs: (task.outputs ?? []).map(path => ({ path, format: path.endsWith('.json') ? 'json' : 'text',
      ...(task.id === 'verify' && path === 'report.json' ? { expectedValues: { orderCount: 2, totalCents: 4095 } } : {}),
      ...(path === 'checks/verify.json' ? { expectedValues: { accepted: true } } : {}),
    })),
  }));
  tasks.find(t => t.id === 'inspect').inputs.push({ path: 'lib/money.mjs', producerTaskId: 'library' });
  tasks.find(t => t.id === 'repair').inputs.push({ path: 'lib/money.mjs', producerTaskId: 'library' });
  const snapshot = { mode: 'fixture', title: scenario, tasks, agents: [
    { id: 'manager', role: 'manager', modelId: 'fixture-captain', tools: [] },
    ...plan.members.map(member => ({ id: member.name, role: 'member', modelId: 'same-fixture-model', tools: ['artifact_write', 'filesystem'] })),
  ] };
  const rawArchive = createRunArchive(root, snapshot);
  const archive = { ...rawArchive, append(type, data, links) {
    const event = rawArchive.append(type, data, links);
    // Fault injection after acceptance but before releasing the next worker.
    if (scenario === 'stale-input' && type === 'handoff/accepted' && data.taskId === 'library')
      files.write('lib/money.mjs', fixtureText('candidates/money-broken.mjs'), files.read('lib/money.mjs').sha256);
    return event;
  } };
  const requests = [], toolResults = [], errors = [], steps = new Map(), outputs = new Map();
  const privateNote = 'SESSION_ONLY_' + randomUUID();
  let releaseLibrary, waitingAtLibrary = false, host, captain;
  const libraryGate = new Promise(resolveGate => { releaseLibrary = resolveGate; });
  const call = (name, args) => [name, args];
  function output(task) {
    if (!outputs.has(task)) outputs.set(task, { task, handoffToken: randomUUID(),
      artifacts: files.manifest(), ...(task === 'inspect' || task === 'verify' ? { check: files.events.at(-1) } : {}) });
    return JSON.stringify(outputs.get(task));
  }
  function actions(task, taskId, attemptId) {
    const update = (status, result) => call('agent_teams_update_task', { task_id: taskId, attempt_id: attemptId, status, ...(result ? { output: result } : {}) });
    const work = [];
    let finalStatus = 'completed';
    if (task === 'library') {
      work.push(() => call('fixture_private_note', {}));
      if (!['missing-file', 'failed-upstream'].includes(scenario)) work.push(() => call('artifact_write', {
        path: 'lib/money.mjs', content: fixtureText(['happy', 'stale-input'].includes(scenario) ? 'candidates/money-fixed.mjs' : 'candidates/money-broken.mjs'),
      }));
      if (scenario === 'failed-upstream') finalStatus = 'failed';
    } else if (task === 'application') {
      work.push(() => call('filesystem', { path: 'lib/money.mjs' }));
      if (scenario === 'missing-file') finalStatus = 'failed';
      else work.push(() => call('artifact_write', { path: 'report.mjs', content: fixtureText('candidates/report.mjs') }));
    } else if (task === 'inspect' || task === 'verify') {
      work.push(() => call('fixture_check_report', { label: task }));
    } else if (task === 'repair') {
      work.push(() => call('filesystem', { path: 'checks/inspect.json' }));
      work.push(() => call('filesystem', { path: 'lib/money.mjs' }));
      if (files.events[0]?.accepted === false) work.push(() => call('artifact_write', {
        path: 'lib/money.mjs', content: fixtureText('candidates/money-fixed.mjs'), expectedSha256: files.read('lib/money.mjs').sha256,
      }));
    }
    return [
      () => call('agent_teams_claim_task', { task_id: taskId }),
      () => update('in_progress'), ...work,
      () => { if (task === 'verify') assert.equal(files.events.at(-1)?.accepted, true); return update(finalStatus, output(task)); },
      () => call('agent_teams_send_message', { to: 'captain', content: output(task) }),
    ];
  }
  class ScriptedAdapter extends LlmAdapter {
    async *stream(options) {
      try {
        const assignment = options.messages.filter(m => m.role === 'user').flatMap(m => m.content)
          .filter(b => b.type === 'text').map(b => b.text).reverse()
          .find(text => text.includes('AgentTeams automatic task assignment')) ?? '';
        const match = /^Task: (t\d+).*?\[fixture:(\w+)\]/m.exec(assignment);
        requests.push({ sessionId: options.sessionId, model: options.model, task: match?.[2], messages: options.messages });
        if (match) {
          const [, taskId, task] = match, attemptId = /Attempt id: ([a-f0-9-]+)/.exec(assignment)?.[1];
          assert.ok(attemptId);
          const key = options.sessionId + ':' + attemptId, step = steps.get(key) ?? 0;
          const script = actions(task, taskId, attemptId);
          steps.set(key, step + 1);
          if (step < script.length) {
            const [name, args] = script[step]();
            if (task === 'library' && name === 'agent_teams_update_task' && ['completed', 'failed'].includes(args.status)) {
              waitingAtLibrary = true;
              await libraryGate;
              options.signal.throwIfAborted();
            }
            yield { type: 'block-start', index: 0, blockType: 'tool-call' };
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) } };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
        }
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture turn finished; see recorded tool evidence.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } catch (error) { errors.push(error); throw error; }
    }
  }
  async function until(predicate) {
    // Five persisted task handoffs include cold Host resumes. Windows fsync and
    // the per-employee context plugins must fit without relying on a fast disk.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (errors.length) throw errors[0];
      if (await predicate()) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    const last = readRun(root, archive.id);
    throw Error('FIXTURE_TIMEOUT: ' + scenario + ' ' + JSON.stringify({
      requests: requests.map(r => r.task),
      failures: last.events.filter(e => e.type === 'model/error' || (e.type === 'tool/result' && e.data.result.isError)),
      team: last.events.findLast(e => e.type === 'team/snapshot')?.data,
    }));
  }
  try {
    host = await createTeamHost({ adapter: new ScriptedAdapter(), provider: 'fixture', sessionRoot: join(root, 'sessions'), archive,
      product: { snapshot, sandbox: files.sandbox, gate: new Semaphore(3) } });
    captain = await host.captain({ cwd: workspace, model: 'fixture-captain' });
    // These two tools are mounted only in this test, never in the production runtime.
    host.ctx.tools.register(defineTool({ name: 'fixture_private_note', description: 'Read a session-only fixture marker.', parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, async execute(_args, exec) {
      assert.equal(employeeFor(exec.agent, snapshot, captain.id)?.id, 'producer'); return { note: privateNote };
    } }));
    host.ctx.tools.register(defineTool({ name: 'fixture_check_report', description: 'Run only trusted fixed report code and compare its real output.',
      parameters: { label: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, async execute(args, exec) {
      assert.equal(employeeFor(exec.agent, snapshot, captain.id)?.id, 'checker');
      assert.ok(['inspect', 'verify'].includes(args.label)); return files.check(args.label);
    } }));
    host.ctx.on('tools/result', (exec, result) => { toolResults.push({ name: exec.name, args: exec.arguments, sessionId: exec.agent?.id, result }); });
    const created = await stageApprovedTeam(host, captain, { name: 'fixture-' + scenario,
      members: plan.members.map(member => ({ ...member, provider: 'fixture', model: 'same-fixture-model' })),
      tasks: teamTaskPlan(tasks),
    });
    host.bindTaskMapping(created.tasks, created.team_id);
    const staged = await host.call(captain, 'agent_teams_status');
    assert.equal(requests.length, 0);
    assert.ok(staged.tasks.every(task => task.status === 'pending'));
    await host.call(captain, 'agent_teams_approve', { confirmation: 'Run predetermined offline fixture only' });
    host.lockPlan();
    await until(() => waitingAtLibrary);
    assert.ok(!requests.some(request => request.task && request.task !== 'library'), 'downstream must wait for library completion');
    const early = await host.call(captain, 'agent_teams_status');
    assert.ok(early.tasks.slice(1).every(task => task.status === 'pending'));
    releaseLibrary();
    let status;
    const expectedReports = ['failed-upstream', 'missing-file', 'stale-input'].includes(scenario) ? 1 : 5;
    await until(async () => {
      status = await host.call(captain, 'agent_teams_status');
      assert.ok(status.members.every(member => !member.spawn_error));
      const reports = toolResults.filter(item => item.name === 'agent_teams_send_message' && !item.result.isError).length;
      return reports >= expectedReports && (['happy', 'repair'].includes(scenario) ? status.deliverable : ['missing-file', 'stale-input'].includes(scenario) ? host.handoffStatus().length > 0 : status.tasks.some(task => task.status === 'failed'));
    });
    await captain.whenIdle();
    await host.close(); host = undefined;
    const unexpectedErrors = toolResults.filter(item => item.result.isError && !(scenario === 'missing-file' && item.name === 'agent_teams_update_task' && item.args.status === 'completed'));
    assert.deepEqual(unexpectedErrors, []);
    const firstByTask = new Map();
    for (const request of requests) if (request.task && !firstByTask.has(request.task)) firstByTask.set(request.task, request);
    for (const [task, request] of firstByTask) for (const dep of plan.tasks.find(t => t.id === task).dependencies) {
      assert.ok(JSON.stringify(request.messages).includes(outputs.get(dep).handoffToken), 'actual dependency output must enter ' + task);
    }
    if (firstByTask.has('application')) {
      assert.notEqual(firstByTask.get('library').sessionId, firstByTask.get('application').sessionId);
      assert.equal(firstByTask.get('library').model, firstByTask.get('application').model);
      assert.ok(!requests.filter(r => r.task && ['application', 'inspect', 'verify'].includes(r.task)).some(r => JSON.stringify(r.messages).includes(privateNote)));
      assert.ok(requests.filter(r => r.task === 'library').some(r => JSON.stringify(r.messages).includes(privateNote)));
    }
    if (scenario === 'failed-upstream') {
      assert.deepEqual([...firstByTask.keys()], ['library']);
      assert.equal(status.tasks[0].status, 'failed');
      assert.ok(status.tasks.slice(1).every(task => task.status === 'pending'));
    } else if (scenario === 'stale-input') {
      assert.deepEqual([...firstByTask.keys()], ['library'], 'consumer must not make even its first model request');
      assert.equal(status.tasks[0].status, 'completed');
      assert.ok(readRun(root, archive.id).events.some(e => e.type === 'handoff/blocked' && e.data.message.includes('VERSION_MISMATCH')));
      assert.ok(!toolResults.some(item => item.name === 'filesystem'));
    } else if (scenario === 'missing-file') {
      assert.deepEqual([...firstByTask.keys()], ['library']);
      assert.equal(status.tasks[0].status, 'in_progress');
      assert.ok(status.tasks.slice(1).every(task => task.status === 'pending' && task.attempt === 0));
      assert.equal(inspectInput(join(root, 'artifacts'), { path: 'lib/money.mjs' }).reason, 'MISSING_FILE');
      assert.ok(toolResults.some(item => item.name === 'agent_teams_update_task' && item.result.isError));
      assert.ok(!toolResults.some(item => item.name === 'filesystem'));
    } else {
      assert.ok(status.tasks.every(task => task.status === 'completed'));
      assert.ok(status.tasks.every(task => task.attempt === 1), 'idle-member follow-up must not churn failed delivery attempts');
      assert.equal(firstByTask.get('library').sessionId, firstByTask.get('repair').sessionId, 'repair resumes the same employee session');
      assert.equal(firstByTask.get('inspect').sessionId, firstByTask.get('verify').sessionId, 'verification resumes the same reviewer session');
      assert.ok(JSON.stringify(firstByTask.get('repair').messages).includes(privateNote), 'resumed employee retains its own earlier history');
      assert.equal(files.events[0].accepted, scenario === 'happy');
      assert.equal(files.events[0].actual.totalCents, scenario === 'happy' ? 4095 : 1798);
      assert.equal(files.events[1].accepted, true);
      assert.deepEqual(JSON.parse(files.read('report.json').content), fixtureJson('expected/report.json'));
    }
    const result = { scenario, observation: 'PASS',
      mocked: ['model responses', 'sandbox file executor', 'preapproved repair plan'], real: ['DSH Host', 'AgentTeams scheduler', 'product file-tool registration and employee grants', 'session persistence', 'tool/message trace', 'fixed report code execution'],
      modelHttpCalls: networkAttempts, tasks: status.tasks.map(task => ({ subject: task.subject, status: task.status, attempt: task.attempt })),
      handoff: readRun(root, archive.id).events.filter(event => event.type.startsWith('handoff/')).map(event => ({ type: event.type, ...event.data })),
      distinctWorkerSessions: new Set(requests.filter(r => r.task).map(r => r.sessionId)).size,
      checks: files.events, artifacts: files.manifest(), toolErrors: toolResults.filter(item => item.result.isError).map(item => ({ tool: item.name, error: item.result.error })) };
    archive.append('fixture/result', result);
    archive.append('run/finished', { status: 'completed', note: 'Fixture assertions completed; inspect observation for product gaps.' });
    const trace = readRun(root, archive.id);
    assert.equal(trace.integrity, 'ok');
    assert.ok(trace.events.some(event => event.type === 'model/request'));
    assert.ok(trace.events.some(event => event.type === 'team/operation' && event.data.name === 'agent_teams_send_message'));
    if (process.env.HANDOFF_REPORT_DIR) {
      const out = resolve(process.env.HANDOFF_REPORT_DIR, scenario);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
      writeFileSync(join(out, 'trace.json'), JSON.stringify(trace, null, 2) + '\n');
      for (const item of files.manifest()) {
        const dest = join(out, 'artifacts', item.path); mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(root, 'artifacts', item.path), dest);
      }
    }
    return result;
  } finally { releaseLibrary(); await host?.close(); await rm(root, { recursive: true, force: true }); }
}

test('fixture: valid files flow through independent sessions with the same model', { timeout: 30000 }, () => runScenario('happy'));
test('fixture: real output 1798 fails the oracle, preapproved repair produces 4095', { timeout: 30000 }, () => runScenario('repair'));
test('fixture: failed upstream task keeps all dependents pending', { timeout: 20000 }, () => runScenario('failed-upstream'));
test('production handoff gate rejects missing output and never dispatches the dependent', { timeout: 20000 }, () => runScenario('missing-file'));
test('production input gate stops a changed accepted file before the consumer model request', { timeout: 20000 }, () => runScenario('stale-input'));

test('fixture oracle rejects a changed input version; this is not a production scheduling gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-version-'));
  try {
    const files = makeFixtureFiles(root);
    const original = files.read('inputs/orders.json');
    assert.equal(inspectInput(root, original).ready, true);
    files.write('inputs/orders.json', '[]\n', original.sha256);
    assert.equal(inspectInput(root, original).reason, 'VERSION_MISMATCH');
    assert.equal(inspectInput(root, { path: 'lib/money.mjs' }).reason, 'MISSING_FILE');
    assert.equal(inspectInput(root, { path: '../outside' }).reason, 'INVALID_FILE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fixture graph oracle catches cycles, undeclared input edges and concurrent writers', () => {
  const valid = fixtureJson('plan.json');
  assert.deepEqual(validateFixtureGraph(valid), []);
  const cycle = structuredClone(valid); cycle.tasks[0].dependencies = ['verify'];
  assert.ok(validateFixtureGraph(cycle).some(error => error.startsWith('CYCLE:')));
  const missing = structuredClone(valid); missing.tasks[1].dependencies = [];
  assert.ok(validateFixtureGraph(missing).includes('MISSING_DEPENDENCY:application:library'));
  const conflict = structuredClone(valid); conflict.tasks.push({ id: 'competing', dependencies: [], outputs: ['lib/money.mjs'] });
  assert.ok(validateFixtureGraph(conflict).includes('UNORDERED_WRITERS:lib/money.mjs'));
});
