import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { EmployeeHostFactory } from './employee-hosts.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { stageApprovedTeam, teamTaskPlan } from './handoff.mjs';
import { Semaphore } from './limits.mjs';

const reply = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const task = { taskId: 'approved-qa', runtimeTaskId: 't2', attemptId: 'fixed-attempt' };
async function fixture(t, pending, stream) {
  const root = await mkdtemp(join(tmpdir(), 'handoff-reminder-'));
  const requests = [], blocked = [];
  const adapter = new class extends LlmAdapter {
    async *stream(request) { requests.push(request); yield* stream(requests.length, request); }
  }();
  const archive = createRunArchive(join(root, 'runs'), { mode: 'fixture' });
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions') });
  const require = createRequire(import.meta.url), baseRequire = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));
  const factory = new EmployeeHostFactory({ coordinator: host.ctx, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive,
    pendingCompletion: pending, onIncompleteCompletion: error => blocked.push(error),
    loadPlugin: name => import(pathToFileURL(baseRequire.resolve(name)).href) });
  t.after(async () => { await factory.close(); await host.close(); await rm(root, { recursive: true, force: true }); });
  const handle = await factory.createAgent(host.ctx, { sessionId: randomUUID(), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Protocol regression fixture, not real employee acceptance.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  return { requests, blocked, events: readRun(join(root, 'runs'), archive.id).events, agent: handle.agent,
    factory,host,handle,root,archive };
}

test('a plain final answer gets one native same-attempt handoff reminder, never automatic success', async t => {
  const f = await fixture(t, () => task, () => reply('I have finished reviewing the fixture.'));
  assert.equal(f.requests.length, 2);
  const notices = f.requests[1].messages.filter(message => message.source?.plugin === 'weiwu-handoff');
  assert.equal(notices.length, 1);
  const text = JSON.stringify(notices[0]);
  for (const value of ['t2', 'fixed-attempt', 'agent_teams_update_task', 'failed']) assert.ok(text.includes(value), value);
  assert.equal(f.blocked.length, 1); assert.equal(f.blocked[0].code, 'HANDOFF_NOT_SUBMITTED');
  assert.equal(f.events.filter(e => e.type === 'handoff/reminder').length, 1);
  assert.equal(f.events.filter(e => e.type === 'handoff/accepted').length, 0);
  assert.ok(f.agent.session.snapshotEvents().some(e => e.type === 'turn/end' && e.data.reason.kind === 'error'));
});

test('a sealed or unassigned task ends normally without a reminder or another request', async t => {
  const f = await fixture(t, () => undefined, () => reply('Ordinary or already sealed final response.'));
  assert.equal(f.requests.length, 1); assert.equal(f.blocked.length, 0);
  assert.equal(f.events.filter(e => e.type === 'handoff/reminder').length, 0);
});

test('the reminder stops when the same task becomes sealed; no third model request follows', async t => {
  let active = true;
  const f = await fixture(t, () => active ? task : undefined, call => {
    if (call === 2) active = false; // Protocol-only stand-in for the separately tested host seal.
    return reply('Fixture response');
  });
  assert.equal(f.requests.length, 2); assert.equal(f.blocked.length, 0);
  assert.equal(f.events.filter(e => e.type === 'handoff/reminder').length, 1);
  assert.equal(f.events.filter(e => e.type === 'handoff/accepted').length, 0);
});

test('a cold EmployeeHost resume retains the same-attempt reminder and a new attempt gets its own', { timeout: 15000 }, async t => {
  let pending=task;
  const f=await fixture(t,()=>pending,()=>reply('Protocol text without formal submission.'));
  const sessionId=f.agent.id;
  await f.handle.dispose();
  const resumed=await f.factory.resume(f.host.ctx,{resumeSessionId:sessionId,agentOptions:{provider:'fixture',model:'fixture'}});
  resumed.agent.followup(createUserMessage({content:[{type:'text',text:'Resume the same protocol attempt.'}],source:{kind:'user'}}));
  await resumed.agent.whenIdle();
  assert.equal(f.requests.length,3,'same attempt receives no second corrective request');
  assert.equal(f.blocked.length,2);
  let events=readRun(join(f.root,'runs'),f.archive.id).events;
  assert.equal(events.filter(e=>e.type==='handoff/reminder').length,1);
  pending={...task,attemptId:'new-attempt'};
  resumed.agent.followup(createUserMessage({content:[{type:'text',text:'New separately approved protocol attempt.'}],source:{kind:'user'}}));
  await resumed.agent.whenIdle();
  assert.equal(f.requests.length,5);
  events=readRun(join(f.root,'runs'),f.archive.id).events;
  assert.deepEqual(events.filter(e=>e.type==='handoff/reminder').map(e=>e.data.attemptId),['fixed-attempt','new-attempt']);
});

test('the production Host reminder accepts only the real native handoff and excludes the captain', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-handoff-reminder-'));
  const snapshot = { tasks: [{ id: 'qa', kind: 'work', subject: 'protocol regression only', assignee: 'qa', dependencies: [], inputs: [], outputs: [] }],
    agents: [{ id: 'manager', role: 'manager', modelId: 'manager', tools: [] }, { id: 'qa', role: 'member', modelId: 'qa', tools: [] }] };
  const archiveRoot = join(root, 'runs'), archive = createRunArchive(archiveRoot, snapshot);
  const artifacts = join(root, 'artifacts'); await mkdir(artifacts);
  const requests = [];
  const adapter = new class extends LlmAdapter {
    async *stream(options) {
      requests.push(options);
      const assignment = options.messages.flatMap(m => m.content).findLast(b => b.type === 'text' && b.text.includes('AgentTeams automatic task assignment'))?.text ?? '';
      const id = /Task: (t\d+)/.exec(assignment)?.[1], attempt = /Attempt id: ([a-f0-9-]+)/.exec(assignment)?.[1];
      if (options.model !== 'qa') { yield* reply('Coordination fixture'); return; }
      const step = requests.filter(r => r.model === 'qa').length;
      assert.ok(step <= 4, 'the protocol fixture must not retry a rejected handoff');
      if (step === 3) { yield* reply('Plain final text cannot seal a task.'); return; }
      const name = step === 1 ? 'agent_teams_claim_task' : 'agent_teams_update_task';
      const args = step === 1 ? { task_id: id } : { task_id: id, attempt_id: attempt, status: step === 2 ? 'in_progress' : 'completed', output: 'Protocol fixture handoff; no real model acceptance.' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }();
  const host = await createTeamHost({ adapter, provider: 'fixture', archive, sessionRoot: join(root, 'sessions'),
    product: { snapshot, sandbox: { root: artifacts, revision: () => 'fixture' }, gate: new Semaphore(1) } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const captain = await host.captain({ cwd: root, model: 'manager' });
  const created = await stageApprovedTeam(host, captain, { name: 'protocol-fixture', members: [{ name: 'qa', provider: 'fixture', model: 'qa' }], tasks: teamTaskPlan(snapshot.tasks) });
  host.bindTaskMapping(created.tasks, created.team_id);
  await host.call(captain, 'agent_teams_approve', { confirmation: 'Disposable protocol fixture only' });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !readRun(archiveRoot, archive.id).events.some(e => e.type === 'handoff/accepted')) await new Promise(done => setTimeout(done, 25));
  const events = readRun(archiveRoot, archive.id).events;
  assert.equal(events.filter(e => e.type === 'handoff/reminder').length, 1);
  assert.deepEqual(events.filter(e => e.type === 'handoff/accepted').map(e => e.data.taskId), ['qa'],
    JSON.stringify(events.filter(e => e.type === 'handoff/blocked' || e.type === 'model/error' || e.type === 'tool/result' && e.data.result.isError).slice(0, 3)));
  const reminder = events.find(e => e.type === 'handoff/reminder').data;
  const seal = events.find(e => e.type === 'handoff/accepted').data;
  assert.equal(reminder.attemptId, seal.attemptId);
  const worker = host.ctx.agents.get(events.find(e => e.type === 'handoff/reminder').sessionId);
  await worker?.whenIdle(); // Linux may already have disposed the successfully concluded member.
  assert.equal(requests.filter(r => r.model === 'qa').length, 4);
  captain.followup(createUserMessage({ content: [{ type: 'text', text: 'Only inspect fixture coordination.' }], source: { kind: 'user' } }));
  await captain.whenIdle();
  assert.equal(readRun(archiveRoot, archive.id).events.filter(e => e.type === 'handoff/reminder').length, 1);
});
