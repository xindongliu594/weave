import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { Semaphore } from './limits.mjs';
import { createRunArchive, readRun, openRunArchive } from './trace-store.mjs';
import { HandoffGate, stageApprovedTeam, teamTaskPlan } from './handoff.mjs';
import { dedupeReadOnlyEvidence, completedWriteEvidenceSignature } from './request-context.mjs';
import { createGoalContract } from '../../packages/contracts/goal-contract.mjs';
import { GoalGuard } from './goal-guard.mjs';

const { LocalExecutor, exportFiles, revision } = createRequire(import.meta.url)('../../apps/desktop/local-executor.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const initial = 'original file\n';

// This adapter only waits: no model response, generated delivery or provider request.
class PauseAdapter extends LlmAdapter {
  sessionPolicies = new Map();
  started = new Map();
  async *stream(options) {
    const ready = this.started.get(options.model);
    ready?.resolve(options);
    if (!options.signal.aborted) await new Promise(done => options.signal.addEventListener('abort', done, { once: true }));
    options.signal.throwIfAborted();
  }
}

function readGroups(proofs, values) {
  return proofs.flatMap((proof, index) => [
    { role: 'assistant', content: null, tool_calls: [{ id: proof.data.callId, type: 'function',
      function: { name: 'filesystem', arguments: JSON.stringify({ path: 'report.txt' }) } }] },
    { role: 'tool', tool_call_id: proof.data.callId, content: JSON.stringify(values[index]) },
  ]);
}

async function fixture({ writers = false, twoReaders = false, mutableOutput = false, sealedGoal=false, terminalFault=false } = {}, work) {
  const root = await mkdtemp(join(tmpdir(), 'weiwu-product-concurrency-'));
  const coordination = join(root, 'coordination'), grantRoot = join(root, 'workspaces'), archiveRoot = join(root, 'runs');
  mkdirSync(coordination); mkdirSync(grantRoot);
  const agents = [{ id: 'manager', employeeId: randomUUID(), role: 'manager', modelId: 'manager-model', tools: [] },
    { id: 'first', employeeId: randomUUID(), role: 'member', modelId: 'first-model', tools: writers ? ['filesystem', 'artifact_write'] : ['filesystem', 'knowledge_read'] }];
  if (twoReaders) agents.push({ id: 'second', employeeId: randomUUID(), role: 'member', modelId: 'second-model', tools: ['filesystem', 'knowledge_read'] });
  if(terminalFault)agents[1].tools.push('terminal_test');
  const tasks = agents.slice(1).map(agent => ({ id: 'work-' + agent.id, subject: 'isolated ' + agent.id,
    kind: 'work', assignee: agent.id, assigneeId: agent.employeeId, dependencies: [], objective: 'Verify concurrency guards in a disposable workspace',
    inputs: mutableOutput ? [] : [{ path: 'report.txt', sha256: hash(initial) }], outputs: writers ? [{ path: 'report.txt', format: 'text' }] : [],
    acceptanceCriteria: [], ...(writers ? { inScope: ['report.txt'] } : {}) }));
  const chunk = { id: 'authorized-chunk', documentId: 'document', version: 2, sha256: hash('authorized knowledge'),
    content: 'authorized knowledge', lineStart: 1, lineEnd: 1 };
  const snapshot = { planVersion: 3, agents, tasks, policy: { contextManagement: 'prune' }, knowledge: { first: [chunk], second: [] } };
  if(sealedGoal)snapshot.goalContract=createGoalContract(snapshot);
  const archive = createRunArchive(archiveRoot, snapshot), grant = { id: randomUUID(), root: grantRoot, allowCommands: terminalFault };
  const executor = new LocalExecutor(grant), job = { runId: archive.id, grantId: grant.id };
  await executor.execute({ ...job, name: 'prepare', files: [{ path: 'report.txt', content: Buffer.from(initial).toString('base64') }] });
  const workspace = join(grantRoot, archive.id), adapter = new PauseAdapter();
  for (const agent of agents) adapter.started.set(agent.modelId, Promise.withResolvers());
  let active = 0, maximumActive = 0, executions = 0, host;
  const sandbox = { root: workspace, revision: () => revision(exportFiles(workspace)), async execute(name, args, signal, operation={}) {
    executions++; active++; maximumActive = Math.max(maximumActive, active);
    try {
      // Ensure overlapping tool requests contend for the actual Host mutex.
      await new Promise(done => setTimeout(done, 10));
      const { files: _files, ...visible } = await executor.execute({ ...job, name, arguments: args, approvalId:operation.approvalId }, signal);
      return visible; // Same visible LocalRunExecutor result, including localWorkspace.
    } finally { active--; }
  } };
  try {
    const goal=sealedGoal?new GoalGuard({snapshot,archive}):undefined;
    host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive,
      product: { snapshot, sandbox, gate: new Semaphore(6), goal, requestApproval:async()=>randomUUID() } });
    const captain = await host.captain({ cwd: coordination, model: 'manager-model' });
    const created = await stageApprovedTeam(host, captain, { name: 'isolated-concurrency',
      members: agents.slice(1).map(agent => ({ name: agent.id, provider: 'fixture', model: agent.modelId })),
      tasks: teamTaskPlan(tasks, { hostContext: true, assertHostContext: values => host.assertApprovedTaskContext(values) }) });
    host.bindTaskMapping(created.tasks, created.team_id);
    await host.call(captain, 'agent_teams_approve', { confirmation: 'Run disposable engineering fixture without a model response' });
    host.lockPlan();
    await Promise.all(agents.slice(1).map(agent => adapter.started.get(agent.modelId).promise));
    const member = id => host.ctx.agents.list().find(agent => agent.options.model === id + '-model');
    assert.ok(member('first'));
    const current = id => host.checkpointState().tasks.find(task => task.assignee === id);
    const events = () => readRun(archiveRoot, archive.id).events;
    await work({ host, captain, member, current, events, archive, archiveRoot, snapshot, sandbox, workspace,
      counters: () => ({ maximumActive, executions }) });
  } finally {
    await host?.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'weiwu-product-concurrency-'));
    await rm(root, { recursive: true, force: true, maxRetries:3, retryDelay:100 });
  }
}

test('Host attests a superseded own output only after a real known CAS write and refuses foreign scope', { timeout: 15000 }, () => fixture({ writers: true, mutableOutput: true }, async f => {
  const employee=f.member('first'),old=await f.host.call(employee,'filesystem',{path:'report.txt'});
  const read=f.events().findLast(event=>event.type==='context/read-evidence').data;
  const args={path:'report.txt',content:'known current full file\n',expectedSha256:old.sha256};
  const result=await f.host.call(employee,'artifact_write',args),write=f.events().findLast(event=>event.type==='context/write-evidence').data;
  assert.equal(write.expectedSha256,old.sha256);assert.equal(write.sha256,hash(args.content));
  assert.deepEqual(completedWriteEvidenceSignature(args,result),Object.fromEntries(['name','path','expectedSha256','sha256','argumentsSha256','resultSha256'].map(key=>[key,write[key]])));
  const scope={sessionId:employee.id,employeeId:f.snapshot.agents[1].employeeId,taskId:'work-first',attemptId:f.current('first').attemptId};
  assert.equal(f.host.attestSupersededRead({...scope,read,write}).superseded,true);
  for(const altered of [{...scope,sessionId:randomUUID()},{...scope,taskId:'foreign'},{...scope,attemptId:randomUUID()}])
    assert.equal(f.host.attestSupersededRead({...altered,read,write}),undefined);
  assert.equal(f.host.attestSupersededRead({...scope,read:{...read,resultSha256:'f'.repeat(64)},write}),undefined);
  await assert.rejects(f.host.call(employee,'artifact_write',{...args,content:'failed stale write'}),/文件已变化|FILE_VERSION_CONFLICT/);
  assert.equal(f.events().filter(event=>event.type==='context/write-evidence').length,1,'failed/unknown CAS never creates write proof');
}));

test('sealed Host pauses unauthorized file write before executor and refuses later admission', {timeout:15000},()=>fixture({writers:true,sealedGoal:true},async f=>{
 const employee=f.member('first'),before=f.counters().executions;
 await assert.rejects(f.host.call(employee,'artifact_write',{path:'unapproved.txt',content:'must never be written'}),/UNDECLARED_OUTPUT|OUT_OF_SCOPE/);
 assert.equal(f.counters().executions,before);
 assert.equal(f.events().filter(e=>e.type==='goal/blocked').length,1);
 await assert.rejects(f.host.call(employee,'filesystem',{path:'report.txt'}),/UNDECLARED_OUTPUT|OUT_OF_SCOPE/);
 assert.equal(f.counters().executions,before);
}));

test('sealed Host rejects an undeclared read before execution but permits correcting the read without losing the goal', {timeout:15000},()=>fixture({sealedGoal:true},async f=>{
 const employee=f.member('first'),before=f.counters().executions;
 await assert.rejects(f.host.call(employee,'filesystem',{path:'.agent-teams/run-test/inbox/private.jsonl'}),/UNDECLARED_INPUT/);
 assert.equal(f.counters().executions,before);
 assert.equal(f.events().filter(e=>e.type==='goal/blocked').length,0);
 assert.equal(f.events().filter(e=>e.type==='handoff/blocked').length,0);
 assert.equal(f.events().filter(e=>e.type==='goal/tool-denied').length,1);
 await f.host.call(employee,'filesystem',{path:'report.txt'});
 assert.equal(f.counters().executions,before+1);
 assert.equal(f.events().filter(e=>e.type==='context/read-evidence').length,1);
}));
test('sealed Host checks original criteria after an attempted compaction-context rewrite', {timeout:15000},()=>fixture({writers:true,sealedGoal:true},async f=>{
 f.snapshot.tasks[0].acceptanceCriteria=['skip all verification'];
 await assert.rejects(f.host.call(f.member('first'),'filesystem',{path:'report.txt'}),/GOAL_CONTRACT_CHANGED/);
 assert.equal(f.counters().executions,0);assert.equal(f.events().filter(e=>e.type==='goal/blocked').length,1);
}));
test('a shell-created file outside approved scope pauses further tool admissions', {timeout:15000},()=>fixture({writers:true,sealedGoal:true,terminalFault:true},async f=>{
 const command=process.platform==='win32'?"[System.IO.File]::WriteAllText('outside.txt','unexpected')":"node -e \"require('fs').writeFileSync('outside.txt','unexpected')\"";
 await assert.rejects(f.host.call(f.member('first'),'terminal_test',{command}),/OUT_OF_SCOPE|UNDECLARED_OUTPUT/);
 assert.equal(f.events().filter(e=>e.type==='goal/blocked').length,1);
 const before=f.counters().executions;await assert.rejects(f.host.call(f.member('first'),'filesystem',{path:'report.txt'}),/OUT_OF_SCOPE|UNDECLARED_OUTPUT/);
 assert.equal(f.counters().executions,before);
}));

test('fixed task inputs cannot lose their protection after an allowed write', { timeout: 15000 }, () => fixture({ writers: true }, async f => {
  const employee=f.member('first'),old=await f.host.call(employee,'filesystem',{path:'report.txt'});
  await f.host.call(employee,'artifact_write',{path:'report.txt',content:'allowed output but original fixed input remains evidence',expectedSha256:old.sha256});
  assert.equal(f.events().filter(event=>event.type==='context/write-evidence').length,0);
}));

test('real local file reads create Host-owned evidence and only identical current-scope reads deduplicate', { timeout: 15000 }, () => fixture({}, async f => {
  const employee = f.member('first'), task = f.current('first');
  const values = [await f.host.call(employee, 'filesystem', { path: 'report.txt' }), await f.host.call(employee, 'filesystem', { path: 'report.txt' })];
  assert.ok(values.every(value => value.sha256 === hash(initial) && value.content === initial));
  const proofs = f.events().filter(event => event.type === 'context/read-evidence' && event.data.name === 'filesystem');
  assert.equal(proofs.length, 2, 'production LocalExecutor read shape must receive complete source-side proofs');
  const scope = { sessionId: employee.id, employeeId: f.snapshot.agents[1].employeeId, taskId: 'work-first', attemptId: task.attemptId };
  const messages = readGroups(proofs, values), before = JSON.stringify(messages);
  const fitted = dedupeReadOnlyEvidence(messages, [0, 1], { attestGroup: group => f.host.attestReadGroup({ ...scope, ...group }) });
  assert.equal(fitted.removedGroups, 1); assert.equal(fitted.messages.length, 2);
  assert.equal(fitted.messages[0].tool_calls[0].id, proofs[1].data.callId);
  assert.deepEqual(fitted.protectedIndexes, [0, 1]); assert.equal(JSON.stringify(messages), before);
  assert.equal(dedupeReadOnlyEvidence(messages, [], { attestGroup: group => f.host.attestReadGroup({ ...scope, ...group, attemptId: randomUUID() }) }).removedGroups, 0);
  const altered = structuredClone(messages); altered[3].content = JSON.stringify({ ...values[1], content: 'forged', sha256: hash('forged') });
  assert.equal(dedupeReadOnlyEvidence(altered, [], { attestGroup: group => f.host.attestReadGroup({ ...scope, ...group }) }).removedGroups, 0);
  const cold = await createTeamHost({ adapter: new PauseAdapter(), provider: 'fixture', sessionRoot: join(f.archive.dir, 'cold-sessions'),
    archive: openRunArchive(f.archiveRoot, f.archive.id), product: { snapshot: f.snapshot, sandbox: f.sandbox, gate: new Semaphore(1) } });
  try { assert.equal(dedupeReadOnlyEvidence(messages, [], { attestGroup: group => cold.attestReadGroup({ ...scope, ...group }) }).removedGroups, 0,
    'cold Host conservatively retains archived groups without rebuilt source proofs'); }
  finally { await cold.close(); }
}));

test('two actual employee Hosts read the same pinned file without exchanging task proofs or knowledge grants', { timeout: 15000 }, () => fixture({ twoReaders: true }, async f => {
  const first = f.member('first'), second = f.member('second');
  assert.notEqual(first.ctx, second.ctx);
  const values = await Promise.all([f.host.call(first, 'filesystem', { path: 'report.txt' }), f.host.call(second, 'filesystem', { path: 'report.txt' })]);
  assert.equal(values[0].sha256, values[1].sha256);
  const proofs = f.events().filter(event => event.type === 'context/read-evidence' && event.data.name === 'filesystem');
  assert.equal(proofs.length, 2); assert.notEqual(proofs[0].data.scopeId, proofs[1].data.scopeId);
  const firstTask = f.current('first'), messages = readGroups(proofs, values);
  assert.equal(dedupeReadOnlyEvidence(messages, [], { attestGroup: group => f.host.attestReadGroup({ ...group,
    sessionId: first.id, employeeId: f.snapshot.agents[1].employeeId, taskId: 'work-first', attemptId: firstTask.attemptId }) }).removedGroups, 0);
  assert.equal((await f.host.call(first, 'knowledge_read', { chunkId: 'authorized-chunk' })).version, 2);
  await assert.rejects(f.host.call(second, 'knowledge_read', { chunkId: 'authorized-chunk' }), /不存在或未授权/);
  assert.equal(f.counters().maximumActive, 1, 'current shared Host file mutex conservatively serializes even reads');
}));

test('overlapping current-task writes use the real local executor: one old SHA commits, the second is rejected, then explicit merge succeeds', { timeout: 15000 }, () => fixture({ writers: true }, async f => {
  const employee = f.member('first'), task = f.current('first');
  await f.host.call(employee, 'agent_teams_update_task', { task_id: task.id, attempt_id: task.attemptId, status: 'in_progress' });
  const observed = await f.host.call(employee, 'filesystem', { path: 'report.txt' });
  const edits = ['first change\n', 'second change\n'];
  const results = await Promise.allSettled(edits.map(content => f.host.call(employee, 'artifact_write', { path: 'report.txt', content, expectedSha256: observed.sha256 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected'); assert.match(rejected.reason.message, /HANDOFF_BLOCKED.*文件已变化/);
  const winner = edits[results.findIndex(result => result.status === 'fulfilled')];
  assert.equal(readFileSync(join(f.workspace, 'report.txt'), 'utf8'), winner);
  assert.equal(f.counters().maximumActive, 1);
  const failures = f.events().filter(event => event.type === 'runtime/operation-failed' && event.data.name === 'artifact_write');
  assert.equal(failures.length, 1); assert.equal(failures[0].data.code, 'FILE_VERSION_CONFLICT');
  assert.notEqual(failures[0].data.classification, 'outcome_unknown');
  assert.equal(f.events().filter(event => event.type === 'runtime/outcome-unknown').length, 0);
  const latest = await f.host.call(employee, 'filesystem', { path: 'report.txt' });
  const merged = winner + 'explicit merged contribution\n';
  await f.host.call(employee, 'artifact_write', { path: 'report.txt', content: merged, expectedSha256: latest.sha256 });
  assert.equal(readFileSync(join(f.workspace, 'report.txt'), 'utf8'), merged);
  await assert.rejects(f.host.call(employee, 'agent_teams_update_task', { task_id: task.id, attempt_id: randomUUID(), status: 'completed', output: 'stale' }), /STALE_ATTEMPT/);
  assert.notEqual(f.current('first').status, 'completed');
  await f.host.call(employee, 'agent_teams_update_task', { task_id: task.id, attempt_id: task.attemptId, status: 'completed', output: 'Disposable engineering conflict check complete' });
  assert.equal(f.current('first').status, 'completed');
  const seal = f.events().findLast(event => event.type === 'handoff/accepted');
  assert.equal(seal.data.outputs[0].sha256, hash(merged)); assert.equal(f.host.handoffStatus().length, 0);
  await assert.rejects(f.host.call(employee, 'artifact_write', { path: 'report.txt', content: 'after completion', expectedSha256: hash(merged) }), /TASK_NOT_ACTIVE/);
  assert.equal(readFileSync(join(f.workspace, 'report.txt'), 'utf8'), merged);
}));

test('an assigned semantic task alias completes through its native ID without accepting foreign or stale attempts', { timeout: 15000 }, () => fixture({ twoReaders: true }, async f => {
  const employee=f.member('first'),task=f.current('first'),second=f.current('second');
  const claim=await f.host.call(employee,'agent_teams_claim_task',{task_id:'work-first'});
  assert.equal(claim.task_id,task.id);assert.equal(claim.attempt_id,task.attemptId);
  assert.equal(f.current('first').attempt,task.attempt,'alias claims cannot create a new attempt');
  await assert.rejects(f.host.call(employee,'agent_teams_claim_task',{task_id:'work-second'}),/TASK_NOT_ACTIVE/);
  await assert.rejects(f.host.call(employee,'agent_teams_update_task',{task_id:'work-second',attempt_id:second.attemptId,status:'completed',output:'foreign'}),/TASK_NOT_ACTIVE/);
  await assert.rejects(f.host.call(employee,'agent_teams_update_task',{task_id:'work-first',attempt_id:randomUUID(),status:'completed',output:'stale'}),/STALE_ATTEMPT/);
  assert.notEqual(f.current('first').status,'completed');
  await f.host.call(employee,'agent_teams_update_task',{task_id:'work-first',attempt_id:task.attemptId,status:'in_progress'});
  await f.host.call(employee,'agent_teams_update_task',{task_id:'work-first',attempt_id:task.attemptId,status:'completed',output:'Read-only fixture complete'});
  assert.equal(f.current('first').id,task.id);
  assert.equal(f.current('first').status,'completed');
  assert.notEqual(f.current('second').status,'completed');
  const seal=f.events().findLast(event=>event.type==='handoff/accepted');
  assert.equal(seal.data.taskId,'work-first');
  assert.equal(seal.data.attemptId,task.attemptId);
  assert.equal(f.events().findLast(event=>event.type==='handoff/turn-concluded').data.runtimeTaskId,task.id);
  await assert.rejects(f.host.call(employee,'agent_teams_update_task',{task_id:'work-first',attempt_id:task.attemptId,status:'completed',output:'duplicate'}),/TASK_NOT_ACTIVE/);
}));

test('unsafe two-employee writer/writer and writer/reader plans are rejected before creating a worker or dispatching a model', () => {
  const base = { id: 'first', assignee: 'A', dependencies: [], inputs: [], outputs: [{ path: 'shared.txt' }] };
  for (const second of [
    { id: 'second', assignee: 'B', dependencies: [], outputs: [{ path: 'shared.txt' }] },
    { id: 'second', assignee: 'B', dependencies: [], inputs: [{ path: 'shared.txt', sha256: hash(initial) }], outputs: [] },
  ]) assert.throws(() => new HandoffGate({ snapshot: { tasks: [base, second] }, sandbox: {}, archive: {} }), /INVALID_HANDOFF_CONTRACT/);
});
