import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { Semaphore } from './limits.mjs';
import { ExecutionBudget } from './budget.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { listArtifacts } from './sandbox.mjs';
import { teamTaskPlan, stageApprovedTeam } from './handoff.mjs';

async function scenario(mode, maxRounds = 1) {
  const root = await mkdtemp(join(tmpdir(), 'controlled-rework-')), files = join(root, 'files'); mkdirSync(files);
  const snapshot = { agents: [
    { id: 'manager', role: 'manager', tools: [] },
    { id: 'producer', role: 'member', tools: ['filesystem', 'artifact_write', 'terminal_test'] },
    { id: 'reviewer', role: 'member', tools: ['filesystem'] },
  ].map(agent => ({ ...agent, employeeId: 'original-' + agent.id, modelId: 'fixture' })), tasks: [
    { id: 'implement', kind: 'implementation', subject: 'Build result', objective: 'Write a usable result', assignee: 'producer', assigneeId: 'original-producer', dependencies: [], acceptanceCriteria: ['result exists'], inputs: [], outputs: [{ path: 'result.txt', format: 'text' }], inScope: ['result.txt'], outOfScope: ['private'], verify: ['check-file'], maxModelCalls: mode === 'budget' ? 8 : 40 },
    { id: 'review', kind: 'review', subject: 'Review result', objective: 'Independently check content', assignee: 'reviewer', assigneeId: 'original-reviewer', dependencies: ['implement'], acceptanceCriteria: ['content is expected'], reviewedTaskId: 'implement', inputs: [{ path: 'result.txt', producerTaskId: 'implement' }], outputs: [], maxReworkRounds: maxRounds },
    { id: 'deliver', kind: 'work', subject: 'Deliver result', objective: 'Use the approved result', assignee: 'producer', assigneeId: 'original-producer', dependencies: ['review'], acceptanceCriteria: ['latest result delivered'], inputs: [{ path: 'result.txt', producerTaskId: 'implement' }], outputs: [{ path: 'delivery.txt' }] },
  ] };
  const archive = createRunArchive(root, snapshot), requests = [], results = [], budgetEvents = [], steps = new Map();
  const budget = new ExecutionBudget({ maxBudget: 1, tasks: snapshot.tasks, onEvent: event => budgetEvents.push(event) });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let host, failure, status, approvals = 0;
  const sandbox = { root: files, revision: () => hash(JSON.stringify(listArtifacts(files))), async execute(name, args) {
    if (name === 'filesystem') { const content = readFileSync(join(files, args.path), 'utf8'); return { content, sha256: hash(content) }; }
    if (name === 'artifact_write') {
      assert.ok(['result.txt', 'delivery.txt'].includes(args.path));
      const file = join(files, args.path), previous = existsSync(file) ? hash(readFileSync(file)) : undefined;
      if (previous !== args.expectedSha256) throw Error('FILE_VERSION_CONFLICT');
      writeFileSync(file, args.content); return { artifacts: listArtifacts(files) };
    }
    assert.equal(name, 'terminal_test'); assert.equal(args.command, 'check-file');
    return { exitCode: readFileSync(join(files, 'result.txt'), 'utf8').length ? 0 : 1, output: 'nonempty result checked' };
  } };
  class Adapter extends LlmAdapter {
    constructor() { super(); this.sessionPolicies = new Map(); }
    async *stream(options) {
      const system = options.system ?? options.messages.filter(message => message.role === 'system').flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
      let pinned = system.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(value => value?.runtimeTaskId);
      const assignment = options.messages.filter(message => message.role === 'user').flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).reverse().find(text => text.includes('AgentTeams automatic task assignment')) ?? '';
      const assignedId = /Task: (t\d+)/.exec(assignment)?.[1];
      if (assignedId && pinned?.runtimeTaskId !== assignedId) {
        const native = JSON.parse(readFileSync(join(root, '.agent-teams', 'rework-' + mode, 'team.json'), 'utf8')).tasks.find(task => task.id === assignedId);
        const original = snapshot.tasks.find(task => task.kind === (native.kind === 'repair' ? 'implementation' : native.kind));
        pinned = { runtimeTaskId: native.id, attemptId: native.attemptId, task: { ...original, kind: native.kind,
          acceptanceCriteria: native.acceptance, reworkRound: native.round ? native.round - 1 : undefined } };
      }
      if (pinned) {
        const reservation = budget.reserve(.001, this.attribution(options.sessionId)); reservation.settle(.001); reservation.check();
        const { task, runtimeTaskId: id, attemptId: attempt } = pinned;
        requests.push({ id, task: task.id, kind: task.kind, round: task.reworkRound, attempt, attribution: this.attribution(options.sessionId) });
        const key = id + ':' + attempt, step = steps.get(key) ?? 0; steps.set(key, step + 1);
        const update = (status, extra = {}) => ['agent_teams_update_task', { task_id: id, attempt_id: attempt, status, ...extra }];
        const actions = [['agent_teams_claim_task', { task_id: id }], update('in_progress')];
        if (['implementation', 'repair'].includes(task.kind)) {
          if (task.kind === 'repair') actions.push(['filesystem', { path: 'result.txt' }]);
          actions.push(['artifact_write', { path: 'result.txt', content: task.kind === 'repair' ? (mode==='limit'?'expected-round-'+task.reworkRound:'expected') : 'initial',
            ...(task.kind === 'repair' ? { expectedSha256: mode === 'stale' ? 'a'.repeat(64) : hash(readFileSync(join(files, 'result.txt'))) } : {}) }]);
          if (!(mode === 'forged' && task.kind === 'repair')) actions.push(['terminal_test', { command: 'check-file' }]);
          actions.push(update('completed', { output: 'file and command checked', changedPaths: ['result.txt'],
            acceptanceResults: task.acceptanceCriteria.map(criterion => ({ criterion, status: 'passed', evidence: 'fixed executor' })),
            commandsRun: [{ command: 'check-file', status: 'passed', exitCode: 0, evidence: 'model claim' }] }));
        } else if (task.kind === 'review') {
          actions.push(['filesystem', { path: 'result.txt' }]);
          const pass = task.reworkRound && mode !== 'limit';
          const findings = [{ id: 'F1', severity: 'high', file: mode === 'scope' ? 'private/secret.txt' : 'result.txt',
            problem: 'Content does not meet the requested result', requiredFix: mode === 'text-scope' ? 'Update private/secret.txt' : 'Set result.txt to expected' }];
          actions.push(pass ? update('completed', { verdict: 'pass', output: 'independent content review passed' }) :
            update('failed', { verdict: mode === 'reject' ? 'reject' : 'needs_revision', findings: mode === 'duplicate' ? [...findings, ...findings] : findings }));
        } else {
          actions.push(['filesystem', { path: 'result.txt' }], ['artifact_write', { path: 'delivery.txt', content: readFileSync(join(files, 'result.txt'), 'utf8') }], update('completed', { output: 'latest reviewed file delivered' }));
        }
        if (step < actions.length) {
          const [name, args] = actions[step]; yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }; yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  try {
    host = await createTeamHost({ adapter: new Adapter(), provider: 'fixture', sessionRoot: join(root, 'sessions'), archive,
      product: { snapshot, sandbox, gate: new Semaphore(2), requestApproval: async () => { approvals++; }, onHandoffBlocked: error => { failure = error; } } });
    host.ctx.on('tools/result', (exec, result) => results.push({ args: exec.arguments, name: exec.name, result }));
    const captain = await host.captain({ cwd: root, model: 'fixture' });
    const created = await stageApprovedTeam(host, captain, { name: 'rework-' + mode, members: snapshot.agents.slice(1).map(agent => ({ name: agent.id, provider: 'fixture', model: 'fixture' })), tasks: teamTaskPlan(snapshot.tasks) });
    host.bindTaskMapping(created.tasks, created.team_id);
    await host.call(captain, 'agent_teams_approve', { confirmation: 'approved bounded rework fixture' }); host.lockPlan();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      status = await host.call(captain, 'agent_teams_status');
      if(mode==='pass')assert.equal(host.hasBlockingFailure(status.tasks),false,'a authorized failed review with native follow-up must not stop delivery');
      if (failure || status.deliverable || budgetEvents.some(event => event.kind === 'stopped') ||
          (['stale', 'forged', 'duplicate'].includes(mode) && results.some(item => item.result.isError))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (status.deliverable) await host.verifyDeliverable();
    await host.close(); host = undefined;
    const events = readRun(root, archive.id).events, repairs = events.filter(event => event.type === 'quality/rework-created');
    if (mode === 'pass') {
      assert.equal(status.deliverable, true, JSON.stringify({ requests, results: results.filter(item => item.result.isError), events: events.filter(event => ['model/error','handoff/blocked','quality/escalated'].includes(event.type)) }));
      assert.equal(repairs.length, 1); assert.equal(approvals, 2); assert.equal(status.tasks.length, 5);
      assert.equal(readFileSync(join(files, 'delivery.txt'), 'utf8'), 'expected');
      const seals = events.filter(event => event.type === 'handoff/accepted');
      const implementationSeals = seals.filter(event => event.data.taskId === 'implement'); assert.equal(implementationSeals.length, 2);
      assert.notEqual(implementationSeals[0].data.outputs[0].sha256, implementationSeals[1].data.outputs[0].sha256);
      const delivery = seals.find(event => event.data.taskId === 'deliver'); assert.equal(delivery.data.inputs[0].sha256, implementationSeals[1].data.outputs[0].sha256);
      const repeated = requests.filter(request => request.round);
      assert.ok(repeated.some(request => request.kind === 'repair')); assert.ok(repeated.some(request => request.kind === 'review'));
      assert.ok(repeated.every(request => request.attribution.taskId === request.task && request.attribution.attemptId === request.attempt));
    } else {
      assert.equal(status.deliverable, false); assert.ok(!existsSync(join(files, 'delivery.txt')));
      if (mode === 'limit') { assert.equal(repairs.length, maxRounds); assert.match(failure?.message??JSON.stringify(results.filter(item=>item.result.isError)), /REWORK_LIMIT/); }
      if (['scope', 'text-scope', 'reject'].includes(mode)) {
        assert.equal(repairs.length, 0); assert.ok(failure); assert.ok(!requests.some(request => request.kind === 'repair'));
        assert.ok(events.some(event => event.type === 'quality/escalated'));
        if (mode === 'scope' || mode === 'reject') assert.equal(status.tasks.length, 3);
      }
      if (mode === 'budget') { assert.equal(repairs.length, 1); assert.ok(budgetEvents.some(event => event.code === 'TASK_TURN_LIMIT')); assert.equal(budget.tasks.get('implement').calls, 8); }
      if (mode === 'forged') { assert.equal(repairs.length, 1); assert.ok(events.some(event=>event.type==='handoff/blocked'&&event.data.message.includes('UNVERIFIED_COMMAND'))); assert.equal(approvals, 1); }
      if (mode === 'stale') { assert.equal(repairs.length, 1); assert.ok(results.some(item => item.result.isError && JSON.stringify(item.result).includes('FILE_VERSION_CONFLICT'))); assert.equal(readFileSync(join(files, 'result.txt'), 'utf8'), 'initial'); }
      if (mode === 'duplicate') { assert.equal(repairs.length, 0); assert.ok(results.some(item => item.result.isError && JSON.stringify(item.result).includes('INVALID_REVIEW_FINDINGS'))); }
    }
  } finally { await host?.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
}

test('approved review creates bounded native repair and independent re-review, then delivers newest sealed files', { timeout: 25000 }, () => scenario('pass'));
test('two failed repair rounds stop at the approved limit with structured escalation', { timeout: 25000 }, () => scenario('limit', 2));
test('out-of-scope finding cannot create a repair task', { timeout: 25000 }, () => scenario('scope'));
test('scope expansion in repair instructions is refused before any generated employee request', { timeout: 25000 }, () => scenario('text-scope'));
test('explicit reject stops the loop even with spare rework allowance', { timeout: 25000 }, () => scenario('reject'));
test('repair model calls share the original task allowance', { timeout: 25000 }, () => scenario('budget'));
test('repair cannot reuse the original implementation command as new verification evidence', { timeout: 25000 }, () => scenario('forged'));
test('repair cannot overwrite a changed file with a stale hash', { timeout: 25000 }, () => scenario('stale'));
test('duplicate finding IDs cannot authorize a repair graph', { timeout: 25000 }, () => scenario('duplicate'));
