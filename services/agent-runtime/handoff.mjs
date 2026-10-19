import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { readRun } from './trace-store.mjs';
import { commitStepCheckpoint, checkpointContract, checkpointEnvironment, validateInheritedEvidence } from './step-checkpoints.mjs';
import { artifactFile, listArtifacts } from './sandbox.mjs';
import { Semaphore } from './limits.mjs';
import { commandEvidence } from './run-evidence.mjs';
import { taskContractErrors } from '../../packages/contracts/task-contracts.mjs';
import { canonicalManifest } from '../../apps/desktop/local-executor.cjs';
import { observeAcceptanceChecks, assertAcceptanceChecks } from './acceptance-checks.mjs';
import { createHandoffReport, handoffContractError, handoffReportGuidance } from '../../packages/contracts/handoff-report.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function inspectArtifact(root, declaration) {
  let bytes;
  try { bytes = readFileSync(artifactFile(root, declaration.path)); }
  catch (error) { throw Error(`${error.code === 'ENOENT' ? 'MISSING_FILE' : 'INVALID_FILE'}: ${declaration.path}`); }
  if (declaration.format === 'text' && bytes.includes(0)) throw Error(`INVALID_TEXT: ${declaration.path}`);
  if (declaration.format === 'json') {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw Error(`INVALID_JSON: ${declaration.path}`); }
    if (declaration.requiredKeys?.length || Object.keys(declaration.expectedValues ?? {}).length) {
      if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(`INVALID_JSON_OBJECT: ${declaration.path}`);
      for (const key of declaration.requiredKeys ?? []) if (!Object.hasOwn(value, key)) throw Error(`MISSING_JSON_KEY: ${declaration.path}:${key}`);
      for (const [key, expected] of Object.entries(declaration.expectedValues ?? {})) if (!Object.hasOwn(value, key) || value[key] !== expected) throw Error(`ACCEPTANCE_FAILED: ${declaration.path}:${key}`);
    }
  }
  return { path: declaration.path, sha256: hash(bytes), size: bytes.length };
}
function sameVersion(root, expected) {
  const actual = inspectArtifact(root, expected);
  if (expected.sha256 && actual.sha256 !== expected.sha256) throw Error(`VERSION_MISMATCH: ${expected.path}`);
  return actual;
}
export function workspaceRevision(root) {
  return hash(JSON.stringify(canonicalManifest(listArtifacts(root))));
}
const scoped = (path, patterns = []) => patterns.some(pattern => path === pattern || path.startsWith(pattern.replace(/\/$/, '') + '/'));

/** Host-owned seals and observed command results; never trust a model's file manifest. */
export class HandoffGate {
  constructor({ snapshot, sandbox, archive }) {
    this.snapshot = snapshot; this.sandbox = sandbox; this.archive = archive;
    this.tasks = new Map((snapshot.tasks ?? []).map(t => [t.id, t]));
    this.accepted = new Map((snapshot.handoffCheckpoints ?? []).map(t => [t.taskId, t]));
    // Provisional seals unblock native scheduling behind the mutex, but they
    // are not yet durable cross-employee evidence.
    this.committed = new Map(this.accepted);
    this.bindings = new Map(); this.commands = new Map(); this.writes = new Map(); this.blocked = new Map(); this.scopeViolations = new Map();
    this.mutex = new Semaphore(1);
    this.stepStatus=new Map();this.stepSessions=new Map();this.inheritanceChecked=new Set();
    this.environment=archive?.dir?checkpointEnvironment(snapshot,readRun(dirname(archive.dir),archive.id)?.events.findLast(event=>event.type==='local/device-bound')?.data.execution):null;
    // Archived approvals may pin both fields. Keep their exact SHA checks in
    // begin/sameVersion; new approvals reject the ambiguous contract in validatePlan.
    const errors = taskContractErrors(snapshot.tasks ?? [], snapshot.agents, snapshot.handoffCheckpoints, { allowHistoricalPinnedProducerInputs: true });
    if (errors.length) throw Error('INVALID_HANDOFF_CONTRACT: ' + errors.join('；'));
    for (const task of this.tasks.values()) { const error=handoffContractError(task.handoff); if(error) throw Error('INVALID_HANDOFF_CONTRACT: '+error); }
  }
  async exclusive(signal, work) {
    const release = await this.mutex.acquire(signal);
    try { return await work(); } finally { release(); }
  }
  block(taskId, attemptId, error) {
    const message = String(error.message ?? error), old = this.blocked.get(taskId);
    if (old?.message !== message) this.archive.append('handoff/blocked', { taskId, attemptId, message });
    this.blocked.set(taskId, { taskId, attemptId, message });
    return Error('HANDOFF_BLOCKED: ' + taskId + ': ' + message);
  }
  key(taskId, attemptId) { return taskId + ':' + attemptId; }
  observedChangedPaths(taskId, attemptId) { return [...(this.writes.get(this.key(taskId, attemptId))?.keys() ?? [])].sort(); }
  inherit(taskId,attemptId) {
    const key=this.key(taskId,attemptId),task=this.tasks.get(taskId);
    const previous=this.stepStatus.get(key);
    if(previous?.reusable&&previous.evidenceRefs.some(entry=>entry.workspaceRevision!==workspaceRevision(this.sandbox.root)))this.stepStatus.set(key,{reusable:false,reasons:['FILES_CHANGED'],evidenceRefs:[]});
    if(!this.archive?.dir||this.inheritanceChecked.has(key))return;
    // A later readonly device receipt may attest the sandbox after task claim.
    if(!this.environment)return;
    this.inheritanceChecked.add(key);
    const result=validateInheritedEvidence({root:dirname(this.archive.dir),reference:this.snapshot.recovery?.nodes?.[taskId]?.stepCheckpoint,
      snapshot:this.snapshot,task,workspace:this.sandbox.root,environment:this.environment});
    this.stepStatus.set(key,result);
    if(result.reusable){this.commands.set(key,[...result.evidenceRefs,...(this.commands.get(key)??[])]);this.archive.append('step/evidence-inherited',{taskId,attemptId,commands:result.evidenceRefs},{taskId,attemptId});}
    else if(this.snapshot.recovery?.nodes?.[taskId]?.stepCheckpoint)this.archive.append('step/evidence-rejected',{taskId,attemptId,reasons:result.reasons},{taskId,attemptId});
  }
  checkpoint(taskId,attemptId,trigger,context={}) {
    if(!this.archive?.dir)return;
    const sessionId=context.sessionId??this.stepSessions.get(this.key(taskId,attemptId));if(!sessionId)return;
    const task=this.tasks.get(taskId);if(!task)return;
    const boundaryEvent=this.archive.append('step/boundary',{taskId,attemptId,trigger},{taskId,attemptId,sessionId});
    return commitStepCheckpoint({archive:this.archive,workspace:this.sandbox.root,
      boundary:{taskId,attemptId,sessionId,trigger,eventCursor:boundaryEvent.seq,contractHash:checkpointContract(this.snapshot,task),environment:this.environment,
        ...(context.sessionCursor===undefined?{}:{sessionCursor:context.sessionCursor})},receipts:this.commands.get(this.key(taskId,attemptId))??[]});
  }
  begin(taskId, attemptId) {
    const task = this.tasks.get(taskId);
    if (!task) throw Error('UNAPPROVED_TASK: ' + taskId);
    const key = this.key(taskId, attemptId);
    if (!this.bindings.has(key)) {
      const inputs = (task.inputs ?? []).map(input => {
        let expected = input.sha256;
        if (input.producerTaskId) {
          const producer = this.accepted.get(input.producerTaskId);
          const output = producer?.outputs.find(o => o.path === input.path);
          if (!output) throw Error(`UNACCEPTED_INPUT: ${input.producerTaskId}:${input.path}`);
          if (expected && expected !== output.sha256) throw Error(`VERSION_MISMATCH: ${input.path}`);
          expected = output.sha256;
        }
        return { ...sameVersion(this.sandbox.root, { path: input.path, sha256: expected }), producerTaskId: input.producerTaskId };
      });
      this.bindings.set(key, inputs);
      this.archive.append('handoff/inputs-bound', { taskId, attemptId, inputs });
    }
    this.assertInputs(taskId, attemptId);
    return task;
  }
  assertInputs(taskId, attemptId) {
    const key = this.key(taskId, attemptId), own = this.writes.get(key);
    for (const input of this.bindings.get(key) ?? []) sameVersion(this.sandbox.root, { ...input, sha256: own?.get(input.path) ?? input.sha256 });
  }
  beforeFile(taskId, attemptId, name, args) {
    const task = this.begin(taskId, attemptId);
    if (name === 'filesystem' && task.inputs !== undefined && !task.inputs.some(i => i.path === args.path) && !(task.outputs ?? []).some(o => o.path === args.path))
      throw Object.assign(Error('UNDECLARED_INPUT: ' + args.path),{code:'UNDECLARED_INPUT',notExecuted:true});
    if (name === 'artifact_write' && task.outputs !== undefined && !(task.outputs ?? []).some(o => o.path === args.path)) throw Error('UNDECLARED_OUTPUT: ' + args.path);
    if (name === 'artifact_write' && ((task.inScope?.length && !scoped(args.path, task.inScope)) || scoped(args.path, task.outOfScope))) throw Error('OUT_OF_SCOPE: ' + args.path);
    return listArtifacts(this.sandbox.root);
  }
  observe(taskId, attemptId, name, args, result, before, context = {}) {
    const task = this.tasks.get(taskId), key = this.key(taskId, attemptId);
    if(context.sessionId)this.stepSessions.set(key,context.sessionId);
    if(result.execution)this.environment=checkpointEnvironment(this.snapshot,result.execution);
    const previous = new Map(before.map(f => [f.path, f.sha256]));
    const current = new Map(listArtifacts(this.sandbox.root).map(f => [f.path, f.sha256]));
    const changed = [...new Set([...previous.keys(), ...current.keys()])].filter(path => previous.get(path) !== current.get(path));
    const writes = this.writes.get(key) ?? new Map(); this.writes.set(key, writes);
    for (const path of changed) {
      const violation = task.outputs !== undefined && !task.outputs.some(o => o.path === path) ? 'UNDECLARED_OUTPUT: ' + path :
        (task.inScope?.length && !scoped(path, task.inScope)) || scoped(path, task.outOfScope) ? 'OUT_OF_SCOPE: ' + path : undefined;
      if (violation) {
        // A terminal may already have changed the workspace. Its tool error must
        // not disappear when the model later claims completion in this attempt.
        this.scopeViolations.set(key, violation); throw Error(violation);
      }
      writes.set(path, current.get(path));
    }
    if (name === 'terminal' || name === 'terminal_test') {
      const entries = this.commands.get(key) ?? []; this.commands.set(key, entries);
      const observation = { command: args.command, exitCode: result.exitCode, workspaceRevision: workspaceRevision(this.sandbox.root),
        evidence: commandEvidence({ archive: this.archive, name, taskId, attemptId, args, result, context }) };
      if (task.acceptanceChecks !== undefined) observation.acceptanceChecks = observeAcceptanceChecks(task, args.command, result);
      entries.push(observation);
      const event = this.archive.append('handoff/command-observed', { taskId, attemptId, ...observation }, { sessionId: context.sessionId, callId: context.callId, taskId, attemptId });
      if (Number.isSafeInteger(event?.seq)) observation.observationSeq = event.seq;
    }
    this.assertInputs(taskId, attemptId);
    if(name!=='filesystem')this.checkpoint(taskId,attemptId,'tool-result',context);
  }
  prepare(taskId, attemptId, update) {
    const task = this.begin(taskId, attemptId), key = this.key(taskId, attemptId);
    this.inherit(taskId,attemptId);
    if (this.scopeViolations.has(key)) throw Error(this.scopeViolations.get(key));
    const outputs = (task.outputs ?? []).map(output => inspectArtifact(this.sandbox.root, output));
    const revision = workspaceRevision(this.sandbox.root), observed = this.commands.get(key) ?? [];
    for (const command of task.verify ?? []) {
      const actual = observed.findLast(entry => entry.command === command);
      const expectedExit = task.acceptanceChecks?.find(check => check.command === command)?.expectedExitCode ?? 0;
      if (!actual || actual.exitCode !== expectedExit || actual.workspaceRevision !== revision) throw Error('UNVERIFIED_COMMAND: ' + command);
    }
    const acceptanceChecks = assertAcceptanceChecks(task, observed, revision);
    const employeeReport = createHandoffReport(task, update);
    if (['implementation', 'repair'].includes(task.kind)) {
      const actual = this.observedChangedPaths(taskId, attemptId);
      if (JSON.stringify([...(update.changedPaths ?? [])].sort()) !== JSON.stringify(actual)) throw Error('CHANGED_PATHS_MISMATCH: 当前 attempt 的宿主观察为 changedPaths='+JSON.stringify(actual)+'；恢复或仅读取的旧文件不算本轮修改，交付文件由 outputs 独立核验。请修正清单，不要为通过校验而重写文件。');
    }
    return { taskId, attemptId, runId: this.archive.id, workspaceRevision: revision, inputs: this.bindings.get(key) ?? [], outputs, commands: observed,
      ...(employeeReport ? { employeeReport } : {}),
      ...(task.acceptanceChecks !== undefined ? { acceptanceChecks } : {}), acceptedAt: new Date().toISOString() };
  }
  stage(record) { this.accepted.set(record.taskId, record); }
  invalidateCommands(taskId, attemptId) { const key=this.key(taskId,attemptId);this.commands.delete(key);this.inheritanceChecked.add(key);this.stepStatus.set(key,{reusable:false,reasons:['OPERATION_INVALIDATED'],evidenceRefs:[]}); }
  commit(record) {
    this.accepted.set(record.taskId, record); this.blocked.delete(record.taskId);
    this.archive.append('handoff/accepted', record);
    this.committed.set(record.taskId, record);
    this.checkpoint(record.taskId,record.attemptId,'node-accepted');
  }
  rollback(record, previous) {
    if (previous) this.accepted.set(record.taskId, previous); else this.accepted.delete(record.taskId);
  }
  summary() { return [...this.blocked.values()]; }
}

/** The same mapping is used by production and offline runtime regression tests. */
export function teamTaskPlan(tasks, { hostContext = false, assertHostContext } = {}) {
  const compact = hostContext === true;
  if (compact) {
    let ready = false;
    try { ready = typeof assertHostContext === 'function' && assertHostContext(tasks) === true; } catch {}
    if (!ready) {
      const error = Error('APPROVED_TASK_CONTEXT_REQUIRED: 紧凑任务说明需要绑定原批准合同的受保护宿主上下文');
      error.code = 'APPROVED_TASK_CONTEXT_REQUIRED';
      throw error;
    }
  }
  // Profile task aliases resolve dependencies/review references inside AgentTeams.
  return tasks.map(task => ({ id: task.id, subject: task.subject, assignee: task.assignee, dependencies: task.dependencies,
    description: (compact ? '完整需求、当前批准合同、恢复记录和预算见最新 department:approved-context；按当前任务及原生 attempt 执行。' : (task.taskPrompt ?? task.objective ?? '')) +
      '\n\n文件合同（由宿主核验；未就绪不得完成）：\n' + JSON.stringify({ inputs: task.inputs ?? [], outputs: task.outputs ?? [] }) +
      (task.handoff ? '\n经理交接要求：'+JSON.stringify(task.handoff)+'\n'+handoffReportGuidance(task) : ''),
    kind: task.kind ?? 'work', objective: task.objective ?? task.taskPrompt ?? task.subject,
    acceptance: task.acceptanceCriteria ?? [],
    ...Object.fromEntries(['inScope', 'outOfScope', 'verify', 'reviewedTaskId', 'sourceTaskId', 'sourceFindingIds'].filter(k => task[k] !== undefined).map(k => [k, task[k]])),
  }));
}

/** Inline plans support ordinary work only in the pinned plugin. Build the approved
 * contracts through its public create_task tool while the entire team is staged. */
export async function stageApprovedTeam(host, captain, { name, description, members, tasks }, signal) {
  const created = await host.call(captain, 'agent_teams_create', { name, ...(description === undefined ? {} : { description }), approval: 'required', plan: { members, tasks: [] } }, signal);
  const byId = new Map(tasks.map(t => [t.id, t])), ids = new Map(), visiting = new Set(), mapping = [];
  async function add(id) {
    if (ids.has(id)) return;
    const task = byId.get(id);
    if (!task || visiting.has(id)) throw Error('INVALID_TASK_GRAPH: ' + id);
    visiting.add(id);
    for (const dep of task.dependencies) await add(dep);
    const { id: seed, ...args } = task;
    args.dependencies = task.dependencies.map(dep => ids.get(dep));
    for (const key of ['reviewedTaskId', 'sourceTaskId']) if (args[key]) {
      if (!ids.has(args[key])) throw Error('INVALID_QUALITY_REFERENCE: ' + args[key]);
      args[key] = ids.get(args[key]);
    }
    const result = await host.call(captain, 'agent_teams_create_task', args, signal);
    ids.set(seed, result.task_id); visiting.delete(seed);
    mapping.push({ task_id: result.task_id, seed_id: seed });
  }
  for (const task of tasks) await add(task.id);
  return { ...created, tasks: mapping };
}
