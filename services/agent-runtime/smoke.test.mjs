import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';

test('real DSH host stages a team without model calls, then starts a dependency-aware team', { timeout: 15_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'department-runtime-'));
  const requests = [];
  const results = [];
  const steps = new Map();
  let releaseWriter;
  const writerGate = new Promise(resolve => { releaseWriter = resolve; });
  const adapter = new class extends LlmAdapter {
    async *stream(options) {
      requests.push(options);
      const step = steps.get(options.sessionId) ?? 0;
      steps.set(options.sessionId, step + 1);
      const text = options.messages.flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const task = /Task: (t\d+)/.exec(text)?.[1];
      const attempt = /Attempt id: ([a-f0-9-]+)/.exec(text)?.[1];
      if (options.model !== 'captain' && step < 4) {
        if (options.model === 'writer' && step === 0) await writerGate;
        assert.ok(task && attempt, 'the actual scheduler supplies an assignment and attempt');
        const calls = [
          ['agent_teams_claim_task', { task_id: task }],
          ['agent_teams_update_task', { task_id: task, attempt_id: attempt, status: 'in_progress' }],
          ['agent_teams_update_task', { task_id: task, attempt_id: attempt, status: 'completed', output: `${options.model}: fixture result` }],
          ['agent_teams_send_message', { to: 'captain', content: `${options.model}: fixture report` }],
        ];
        const [name, args] = calls[step];
        const block = { type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture turn finished.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(cwd, 'sessions') });
  try {
    host.ctx.on('tools/result', (exec, result) => { results.push({ name: exec.name, args: exec.arguments, agent: exec.agent, result }); });
    const captain = await host.captain({ cwd, model: 'captain' });
    const created = await host.call(captain, 'agent_teams_create', {
      name: 'smoke', approval: 'required',
      plan: {
        members: [
          { name: 'writer', role: 'Write the requirements', provider: 'fixture', model: 'writer' },
          { name: 'reviewer', role: 'Review the requirements', provider: 'fixture', model: 'reviewer' },
        ],
        tasks: [
          { id: 'draft', subject: 'Draft requirements', assignee: 'writer' },
          { id: 'review', subject: 'Review requirements', assignee: 'reviewer', dependencies: ['draft'] },
        ],
      },
    });
    assert.equal(created.phase, 'staged');
    const staged = await host.call(captain, 'agent_teams_status');
    assert.ok(staged.members.every(m => m.activity === 'unspawned'));
    assert.ok(staged.tasks.every(t => t.status === 'pending'));
    assert.equal(requests.length, 0);
    await host.call(captain, 'agent_teams_approve', { confirmation: 'Approve this isolated fixture test' });
    const blocked = await host.call(captain, 'agent_teams_status');
    assert.equal(blocked.tasks[1].status, 'pending');
    assert.equal(blocked.members[1].activity, 'unspawned');
    assert.ok(!requests.some(r => r.model === 'reviewer'));
    releaseWriter();
    let status;
    const deadline = Date.now() + 8_000;
    do {
      status = await host.call(captain, 'agent_teams_status');
      assert.ok(status.members.every(m => !m.spawn_error), JSON.stringify(status.members));
      if (status.deliverable && results.filter(r => r.name === 'agent_teams_send_message').length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.ok(status.deliverable, JSON.stringify(status));
    assert.equal(results.filter(r => r.name === 'agent_teams_send_message' && !r.result.isError).length, 2);
    assert.deepEqual(status.tasks.map(t => t.status), ['completed', 'completed']);
    const reviewRequest = requests.find(r => r.model === 'reviewer');
    assert.ok(JSON.stringify(reviewRequest.messages).includes('writer: fixture result'), 'reviewer receives real dependency output');
    const failures = results.filter(r => r.result.isError).map(r => ({ name: r.name, error: r.result.error }));
    assert.equal(failures.length, 0, JSON.stringify(failures));
    const memberTools = requests.find(r => r.model === 'writer').tools.map(t => t.name);
    assert.ok(!memberTools.includes('agent_teams_approve'));
    assert.ok(!memberTools.includes('agent_teams_create'));
    const writer = results.find(r => r.name === 'agent_teams_claim_task').agent;
    await assert.rejects(host.call(writer, 'agent_teams_create', { name: 'forbidden' }), /already belong to team/);
    await host.close();
    const restored = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(cwd, 'sessions') });
    try {
      const restoredCaptain = await restored.resumeCaptain({ id: captain.id, model: 'captain' });
      const history = await restored.call(restoredCaptain, 'agent_teams_status');
      assert.equal(history.team_id, created.team_id);
      assert.deepEqual(history.tasks.map(t => t.status), ['completed', 'completed']);
    } finally { await restored.close(); }
  } finally {
    releaseWriter();
    await host.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('host disposal aborts an in-flight member model request and drains it', { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'department-cancel-'));
  let started;
  let cancelled = false;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const adapter = new class extends LlmAdapter {
    async *stream(options) {
      started();
      await new Promise(resolve => {
        const abort = () => { cancelled = true; resolve(); };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
      options.signal.throwIfAborted();
    }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(cwd, 'sessions') });
  try {
    const captain = await host.captain({ cwd, model: 'captain' });
    await host.call(captain, 'agent_teams_create', {
      name: 'cancel', approval: 'required',
      plan: { members: [{ name: 'worker' }], tasks: [{ id: 'work', subject: 'Wait for cancellation', assignee: 'worker' }] },
    });
    // Programmatic dispatch must still traverse DSH's policy pipeline.
    const removeGuard = host.ctx.on('tools/pre-execute', async (exec, next) =>
      exec.name === 'agent_teams_approve' ? { kind: 'deny', reason: 'fixture approval gate' } : next());
    await assert.rejects(host.call(captain, 'agent_teams_approve', { confirmation: 'fixture' }), /fixture approval gate/);
    assert.equal((await host.call(captain, 'agent_teams_status')).phase, 'staged');
    removeGuard();
    await host.call(captain, 'agent_teams_approve', { confirmation: 'fixture' });
    await requestStarted;
    await host.close();
    assert.ok(cancelled, 'teardown must cancel the live model request before returning');
  } finally {
    await host.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
