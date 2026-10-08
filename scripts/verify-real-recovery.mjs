import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readRun, redact } from '../services/agent-runtime/trace-store.mjs';
import { listArtifacts } from '../services/agent-runtime/sandbox.mjs';
import { unresolvedOperations } from '../services/agent-runtime/recovery.mjs';

// This audit only reads captures, journals and file hashes. It never requests a
// model, approves/reconciles an operation, starts a project or edits deliverables.
const [dataDir, parentId, childId, modelWireName, outputPath] = process.argv.slice(2);
const expectedModels = modelWireName?.split(',');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
if (!dataDir || !uuid.test(parentId ?? '') || !uuid.test(childId ?? '') || parentId === childId ||
    !modelWireName || modelWireName.length > 200 || /[\x00-\x1f]/.test(modelWireName) ||
    expectedModels.some(name => !name || name.trim() !== name) || new Set(expectedModels).size !== expectedModels.length || !outputPath)
  throw Error('Usage: node scripts/verify-real-recovery.mjs <dataDir> <parentId> <childId> <comma-separated wire models> <new docs/test-evidence/report.json>');

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = resolve(workspace, 'docs/test-evidence');
const output = resolve(workspace, outputPath);
const within = (root, path) => { const value = relative(root, path); return !!value && !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep); };
if (!within(evidenceRoot, output) || !output.endsWith('.json')) throw Error('Output must be a new JSON file inside this workspace docs/test-evidence');
if (existsSync(output)) throw Error('Output already exists; choose a new report path to preserve existing evidence');
// Reject a junction/symlink in an output ancestor before creating anything.
for (let ancestor = dirname(output); relative(workspace, ancestor) !== ''; ancestor = dirname(ancestor)) {
  if (existsSync(ancestor) && (lstatSync(ancestor).isSymbolicLink() || !within(realpathSync(workspace), realpathSync(ancestor))))
    throw Error('Output ancestor must remain inside the workspace without a junction or symlink');
}

const dataDirectory = resolve(dataDir), traceRoot = join(dataDirectory, 'runs');
const capturesRoot = join(workspace, '.data/mvp-evidence');
const beforePath = join(capturesRoot, `${parentId}-before-restart.json`);
const afterPath = join(capturesRoot, `${parentId}-after-restart.json`);
const sha = value => createHash('sha256').update(value).digest('hex');
const fileDigest = path => { try { return sha(readFileSync(path)); } catch { return undefined; } };
const equal = (left, right) => isDeepStrictEqual(left, right);
const sorted = values => [...values].sort();
const sum = values => values.reduce((total, value) => total + Number(value), 0);
const near = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
const ensure = (condition, message) => { if (!condition) throw Error(message); };
class Blocked extends Error {}
const blocked = message => { throw new Blocked(message); };
const checks = [];
const check = (id, group, description, evaluate) => {
  try { checks.push({ id, group, description, status: 'passed', evidence: evaluate() ?? {} }); }
  catch (error) { checks.push({ id, group, description, status: error instanceof Blocked ? 'blocked' : 'failed', message: String(error.message ?? error).slice(0, 800) }); }
};
const load = path => {
  try { const bytes = readFileSync(path); return { value: JSON.parse(bytes), path, sha256: sha(bytes) }; }
  catch (error) { return { path, missing: error.code === 'ENOENT', error: error.code === 'ENOENT' ? 'missing' : 'invalid JSON or unreadable evidence' }; }
};
const archive = id => { try { return { value: readRun(traceRoot, id), path: join(traceRoot, id) }; } catch { return { path: join(traceRoot, id), error: 'invalid or unreadable archive' }; } };
const beforeInput = load(beforePath), afterInput = load(afterPath), parentInput = archive(parentId), childInput = archive(childId);
const before = beforeInput.value, after = afterInput.value, parent = parentInput.value, child = childInput.value;
let latestChildCapture;
if (existsSync(capturesRoot)) {
  for (const name of readdirSync(capturesRoot).filter(name => name.startsWith(childId + '-') && name.endsWith('.json'))) {
    const candidate = load(join(capturesRoot, name));
    if (candidate.value?.runId === childId && Number.isFinite(Date.parse(candidate.value.capturedAt)) &&
        (!latestChildCapture || Date.parse(candidate.value.capturedAt) > Date.parse(latestChildCapture.value.capturedAt))) latestChildCapture = candidate;
  }
}
const needCaptures = () => { if (!before || !after) blocked('Both restart captures are required; capture them before and after restarting the service.'); };
const needArchives = () => { if (!parent || !child) blocked('Both real run archives are required.'); if (parent.integrity !== 'ok' || child.integrity !== 'ok') blocked('Archive integrity must be repaired or independently checked before using its evidence.'); };
const approved = run => run?.snapshot.approvedTasks ?? run?.snapshot.tasks ?? [];
const mapping = events => new Map(events.filter(event => event.type === 'run/task-mapping').flatMap(event => event.data.tasks ?? []).map(task => [task.task_id, task.seed_id]));
const stateMap = (run, events = run.events, capturedTasks) => {
  const ids = mapping(events), states = new Map((run.snapshot.recovery?.completed ?? []).map(task => [task.taskId, { ...task, status: 'completed' }]));
  const tasks = capturedTasks ?? events.findLast(event => ['team/checkpoint', 'team/snapshot'].includes(event.type))?.data.tasks ?? [];
  for (const [nativeId, approvedId] of ids) { const task = tasks.find(task => (task.id ?? task.task_id) === nativeId); if (task) states.set(approvedId, { ...task, nativeId }); }
  for (const task of tasks) if (!ids.has(task.id ?? task.task_id) && approved(run).some(contract => contract.id === (task.id ?? task.taskId))) states.set(task.id ?? task.taskId, task);
  return states;
};
const attemptIdentity = (task, description, required = false) => {
  const aliases = ['attempt_id', 'attemptId'].filter(field => Object.hasOwn(task ?? {}, field));
  for (const field of aliases) ensure(uuid.test(task[field] ?? ''), `${description} has an invalid ${field}.`);
  ensure(aliases.length < 2 || task.attempt_id === task.attemptId, `${description} has conflicting attempt aliases.`);
  ensure(!required || aliases.length > 0, `${description} is missing its full attempt identity.`);
  return { attemptId: aliases.length ? task[aliases[0]] : undefined, aliases };
};
const completedAttemptAtCursor = (run, events, taskId, capturedState) => {
  const ids = mapping(events), checkpoint = events.findLast(event => ['team/checkpoint', 'team/snapshot'].includes(event.type));
  const task = checkpoint?.data.tasks?.find(task => {
    const nativeId = task.id ?? task.task_id ?? task.taskId;
    return (ids.get(nativeId) ?? nativeId) === taskId;
  });
  ensure(task, `Completed task ${taskId} is missing from the full checkpoint at the capture cursor.`);
  const nativeId = task.id ?? task.task_id ?? task.taskId;
  ensure(nativeId === (capturedState?.nativeId ?? capturedState?.id ?? capturedState?.task_id ?? capturedState?.taskId), `Completed task ${taskId} has conflicting captured and checkpoint task identities.`);
  ensure(capturedState?.status === 'completed' && task.status === 'completed', `Completed task ${taskId} has conflicting captured and checkpoint status.`);
  ensure(equal(capturedState.output, task.output), `Completed task ${taskId} has conflicting captured and checkpoint output.`);
  const captured = attemptIdentity(capturedState, `Captured completed task ${taskId}`);
  const journal = attemptIdentity(task, `Checkpoint completed task ${taskId}`, true);
  if (captured.attemptId !== undefined) ensure(captured.attemptId === journal.attemptId, `Completed task ${taskId} has conflicting captured and checkpoint attempts.`);
  const seal = events.findLast(event => event.type === 'handoff/accepted' && event.data.taskId === taskId);
  ensure(seal && seal.data.attemptId === journal.attemptId, `Completed task ${taskId} has no matching host acceptance seal at the capture cursor.`);
  // Capture helpers may omit the other spelling of the native attempt field.
  // Only the full checkpoint and its already accepted seal at this cursor can
  // supply that missing field; a later checkpoint or another task cannot.
  return { taskId, nativeId, attemptId: journal.attemptId, capturedAliases: captured.aliases,
    checkpointAliases: journal.aliases, checkpointSeq: checkpoint.seq, checkpointType: checkpoint.type,
    acceptanceSeq: seal.seq, outputSha256: sha(String(task.output ?? '')) };
};
const taskAttribution = run => {
  const ids = mapping(run.events), sessions = new Map(), result = new Map();
  for (const event of run.events) {
    if (event.type === 'model/request' && event.sessionId && event.taskId) sessions.set(event.sessionId, ids.get(event.taskId) ?? event.taskId);
    const raw = event.data?.taskId ?? event.taskId ?? sessions.get(event.sessionId);
    result.set(event.seq, ids.get(raw) ?? raw);
  }
  return result;
};
const requests = run => run?.events.filter(event => event.type === 'model/wire-request') ?? [];
const receipts = run => run?.events.filter(event => event.type === 'billing/usage') ?? [];
const parentBeforeEvents = parent && before && Number.isSafeInteger(before.eventCount) ? parent.events.slice(0, before.eventCount) : [];
const beforeStates = parent ? stateMap(parent, parentBeforeEvents, before?.tasks) : new Map();
const childStates = child ? stateMap(child) : new Map();
const completedBefore = [...beforeStates].filter(([, state]) => state.status === 'completed').map(([id]) => id);
const unfinishedBefore = approved(parent).map(task => task.id).filter(id => !completedBefore.includes(id));
const attribution = new Map([parent, child].filter(Boolean).map(run => [run.id, taskAttribution(run)]));
const unresolvedCalls = run => {
  const settled = new Set(receipts(run).map(event => event.data.id));
  if (run?.id === childId) for (const row of latestChildCapture?.value.projectUsage ?? []) settled.add(row.id);
  return (run?.events.filter(event => event.type === 'billing/unconfirmed' && event.data.dispatched !== false) ?? []).filter(event => !settled.has(event.data.id)).map(event => ({ runId: run.id, seq: event.seq, id: event.data.id, code: event.data.code, providerRequestId: event.data.providerRequestId, providerStatus: event.data.providerStatus }));
};
const nativeReceipts = run => {
  const starts = new Map(run.events.filter(event => event.type === 'tool/start').map(event => [event.callId, event]));
  return run.events.filter(event => event.type === 'tool/result' && ['terminal', 'terminal_test'].includes(event.data.name) && !event.data.result?.isError).flatMap(event => {
    const start = starts.get(event.callId), result = event.data.result?.value;
    if (!start || !result || !Number.isInteger(result.exitCode) || typeof result.output !== 'string') return [];
    const taskId = attribution.get(run.id).get(event.seq), attemptId = event.attemptId ?? start.attemptId;
    const observed = run.events.find(item => item.type === 'handoff/command-observed' && item.data.taskId === taskId && item.data.attemptId === attemptId && item.data.command === start.data.arguments?.command && item.data.exitCode === result.exitCode && item.seq >= start.seq && item.seq <= event.seq);
    const queued = run.events.find(item => item.type === 'local/operation-queued' && item.data.callId === event.callId);
    const finished = queued && run.events.find(item => item.type === 'local/operation-finished' && item.data.operationId === queued.data.operationId);
    const plain = result.output.replace(/\u001b\[[0-9;]*m/g, '');
    const counts = Object.fromEntries([...plain.matchAll(/(?:#|ℹ)\s*(tests|pass|fail)\s+(\d+)/g)].map(match => [match[1], Number(match[2])]));
    return [{ runId: run.id, taskId, attemptId, command: start.data.arguments?.command, exitCode: result.exitCode, callId: event.callId,
      startSeq: start.seq, resultSeq: event.seq, observationSeq: observed?.seq, localOperationId: queued?.data.operationId,
      localFinishedSeq: finished?.seq, localWorkspace: result.localWorkspace, workspaceRevision: result.workspaceRevision,
      output: result.output, outputSha256: sha(result.output), ...(Object.keys(counts).length ? { testCounts: counts } : {}) }];
  });
};
const commands = [parent, child].filter(Boolean).flatMap(nativeReceipts);
const managerAgents = child?.snapshot.agents?.filter(agent => agent.role === 'manager') ?? [];
const managerTasks = approved(child).filter(task => managerAgents.some(agent => task.assignee === agent.id || agent.sourceAgentId && task.assigneeId === agent.sourceAgentId || agent.employeeId && task.assigneeId === agent.employeeId));
const finalStopped = child && ['failed', 'cancelled', 'interrupted'].includes(child.status);
const finalBlocked = !child || child.status === 'unfinished' || child.status === 'queued' || unresolvedCalls(child).length > 0;

check('inputs-and-integrity', 'recovery', 'Required evidence exists and both immutable journals are intact.', () => {
  for (const input of [beforeInput, afterInput]) { if (input.missing) blocked(`Missing capture: ${input.path}`); ensure(!input.error, `Unreadable capture: ${input.path}`); }
  for (const input of [parentInput, childInput]) { if (!input.value && !input.error) blocked(`Missing archive: ${input.path}`); ensure(!input.error, `Unreadable archive: ${input.path}`); }
  needCaptures();
  ensure(parent.integrity === 'ok' && child.integrity === 'ok', 'Run archive integrity is incomplete.');
  for (const capture of [before, after]) {
    ensure(Array.isArray(capture.tasks) && Array.isArray(capture.artifacts) && Array.isArray(capture.operations), 'Restart capture is missing task, file or operation evidence.');
    for (const field of ['modelRequests', 'billedCalls', 'runCost', 'projectCost']) ensure(Number.isFinite(capture[field]), `Restart capture is missing numeric ${field}.`);
    ensure(Number.isSafeInteger(capture.eventCount) && capture.eventCount >= 0 && capture.eventCount <= parent.eventCount, 'Restart capture journal cursor is invalid.');
  }
  ensure(after.eventCount >= before.eventCount, 'The after-restart capture precedes the interruption cursor.');
  ensure(before.runId === parentId && after.runId === parentId, 'Restart captures do not identify the parent run.');
  ensure(before.projectId === parent.snapshot.projectId && child.snapshot.projectId === parent.snapshot.projectId, 'Evidence belongs to different projects.');
  return { parentArchive: { path: parentInput.path, snapshotSha256: fileDigest(join(parentInput.path, 'snapshot.json')), eventsSha256: fileDigest(join(parentInput.path, 'events.jsonl')) }, childArchive: { path: childInput.path, snapshotSha256: fileDigest(join(childInput.path, 'snapshot.json')), eventsSha256: fileDigest(join(childInput.path, 'events.jsonl')) }, before: { path: beforePath, sha256: beforeInput.sha256 }, after: { path: afterPath, sha256: afterInput.sha256 }, parentEventCount: parent.eventCount, childEventCount: child.eventCount };
});
check('controlled-interruption', 'recovery', 'The interruption occurred between native operations and retained completed work.', () => {
  needCaptures(); needArchives();
  ensure(before.status === 'running', 'The before-restart capture must show a running project.');
  ensure(['interrupted', 'failed', 'cancelled'].includes(after.status), 'After restart the old run must be stopped.');
  ensure(completedBefore.length > 0 && unfinishedBefore.length > 0, 'This run must contain both completed and unfinished nodes at interruption.');
  ensure((before.operations ?? []).every(operation => !['queued', 'claimed', 'started'].includes(operation.status)), 'An active native operation was interrupted; controlled safe-point evidence is missing.');
  const pending = before.pendingModelReceipts ?? [];
  if (pending.length) blocked('The interruption capture still has unresolved model receipts; reconcile them before declaring a safe recovery.');
  ensure(Number.isSafeInteger(before.eventCount) && before.eventCount <= parent.eventCount, 'The before-restart journal cursor is invalid.');
  return { beforeStatus: before.status, afterStatus: after.status, completedTaskIds: completedBefore, unfinishedTaskIds: unfinishedBefore, activeOperations: 0, pendingModelReceipts: pending.length };
});
check('restart-preserves-state', 'recovery', 'Service restart preserved call receipts, expenses, task identity and file versions.', () => {
  needCaptures(); needArchives();
  for (const field of ['modelRequests', 'billedCalls', 'runCost', 'projectCost']) ensure(equal(before[field], after[field]), `Restart changed captured ${field}.`);
  const files = capture => sorted((capture.artifacts ?? []).map(file => `${file.path}:${file.sha256}:${file.size}`));
  ensure(equal(files(before), files(after)), 'Restart changed interrupted file versions.');
  ensure(equal(sorted(before.tasks.map(task => task.id)), sorted(after.tasks.map(task => task.id))), 'Restart lost or replaced task identities.');
  const parentAfterEvents = parent.events.slice(0, after.eventCount);
  const afterStates = stateMap(parent, parentAfterEvents, after.tasks), completedTaskAttempts = [];
  for (const id of completedBefore) {
    ensure(afterStates.get(id)?.status === 'completed', `Completed task ${id} was lost on restart.`);
    ensure(equal(beforeStates.get(id)?.output, afterStates.get(id)?.output), `Completed task ${id} output changed on restart.`);
    const prior = completedAttemptAtCursor(parent, parentBeforeEvents, id, beforeStates.get(id));
    const current = completedAttemptAtCursor(parent, parentAfterEvents, id, afterStates.get(id));
    ensure(prior.attemptId === current.attemptId, `Completed task ${id} attempt changed on restart.`);
    completedTaskAttempts.push({ taskId: id, attemptId: prior.attemptId, before: prior, after: current });
  }
  const stale = new Set((before.approvals ?? []).filter(approval => approval.status === 'pending').map(approval => approval.id));
  ensure(!(after.approvals ?? []).some(approval => stale.has(approval.id) && approval.status === 'pending'), 'An old pending approval survived restart.');
  return { modelCalls: before.modelRequests, billedCalls: before.billedCalls, runCost: before.runCost, projectCost: before.projectCost, fileCount: before.artifacts.length, cancelledOldApprovalIds: [...stale], completedTaskAttempts };
});
check('complete-dag-and-policy', 'recovery', 'Recovery retained the entire approved DAG and all original policy and permission boundaries.', () => {
  needArchives(); const contracts = approved(parent), ids = contracts.map(task => task.id), known = new Set(ids);
  ensure(ids.length > 0 && known.size === ids.length, 'Approved task IDs are empty or duplicated.');
  for (const task of contracts) ensure((task.dependencies ?? []).every(id => known.has(id)), `Task ${task.id} references a missing dependency.`);
  const visiting = new Set(), visited = new Set(), byId = new Map(contracts.map(task => [task.id, task]));
  const visit = id => { ensure(!visiting.has(id), 'The approved DAG contains a cycle.'); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id).dependencies ?? []) visit(dep); visiting.delete(id); visited.add(id); };
  for (const id of ids) visit(id);
  ensure(child.snapshot.resumedFrom === parentId && child.snapshot.recovery?.sourceRunId === parentId, 'The child does not resume this parent.');
  ensure(equal(approved(child), contracts), 'Approved task contracts changed on recovery.');
  for (const field of ['policy', 'agents', 'knowledge', 'executionTarget', 'modelRoutes']) ensure(equal(parent.snapshot[field], child.snapshot[field]), `Recovery changed ${field}.`);
  ensure(equal(sorted(Object.keys(child.snapshot.recovery.nodes)), sorted(ids)), 'Recovery omitted a DAG node.');
  return { resumedFrom: parentId, taskIds: ids, dependencies: Object.fromEntries(contracts.map(task => [task.id, task.dependencies ?? []])), policy: child.snapshot.policy, permissionSnapshotSha256: sha(JSON.stringify({ agents: child.snapshot.agents, knowledge: child.snapshot.knowledge, executionTarget: child.snapshot.executionTarget })) };
});
check('completed-nodes-not-replayed', 'recovery', 'All nodes completed at interruption were restored without new model calls, commands or acceptance.', () => {
  needCaptures(); needArchives();
  ensure(equal(sorted(child.snapshot.completedCheckpoints ?? []), sorted(completedBefore)), 'Recovery checkpoint IDs do not match completed tasks at interruption.');
  for (const id of completedBefore) {
    ensure(childStates.get(id)?.status === 'completed', `Completed node ${id} was not restored.`);
    ensure(!requests(child).some(event => attribution.get(child.id).get(event.seq) === id), `Completed node ${id} made a new model request.`);
    ensure(!child.events.some(event => event.type === 'handoff/accepted' && event.data.taskId === id), `Completed node ${id} was accepted again.`);
    ensure(!commands.some(command => command.runId === childId && command.taskId === id), `Completed node ${id} reran a native command.`);
    ensure(child.snapshot.recovery.nodes[id].output === String(beforeStates.get(id)?.output ?? '').slice(0, 4000), `Node ${id} lost its previous output context.`);
  }
  return { completedTaskIds: completedBefore, childModelCallsForCompletedTasks: 0, childCommandsForCompletedTasks: 0, childRepeatedAcceptance: 0 };
});
check('restored-file-history', 'recovery', 'The source hashes and actual recovery event identify the exact interrupted file versions.', () => {
  needCaptures(); needArchives();
  const files = child.snapshot.recovery?.files; ensure(Array.isArray(files) && files.length > 0, 'Recovery has no file-version snapshot.');
  const restored = child.events.find(event => event.type === 'recovery/restored'); ensure(restored, 'There is no successful host recovery event.');
  ensure(restored.data.sourceRunId === parentId && equal(restored.data.files, files), 'Recovery event differs from the fixed file snapshot.');
  ensure(equal(sorted(restored.data.completed), sorted(completedBefore)), 'Recovery event restored the wrong completed set.');
  ensure(!requests(child).some(event => event.seq < restored.seq), 'A model ran before successful checkpoint restoration.');
  const original = new Map(before.artifacts.map(file => [file.path, file]));
  ensure(files.length === original.size, 'Recovery did not retain all interrupted artifact files.');
  const parentFiles = new Map(listArtifacts(join(traceRoot, parentId, 'artifacts')).map(file => [file.path, file]));
  for (const file of files) {
    ensure(file.sha256 === original.get(file.path)?.sha256 && file.size === original.get(file.path)?.size, `Recovery selected the wrong interrupted version of ${file.path}.`);
    ensure(parentFiles.get(file.path)?.sha256 === file.sha256, `The historical parent copy of ${file.path} no longer matches its captured hash.`);
  }
  const current = new Map(listArtifacts(join(traceRoot, childId, 'artifacts')).map(file => [file.path, file]));
  return { restoredEventSeq: restored.seq, files: files.map(file => ({ ...file, finalSha256: current.get(file.path)?.sha256, changedAfterRestore: current.get(file.path)?.sha256 !== file.sha256 })), note: 'Final files may be legitimately updated by employees. This check uses immutable parent hashes, the fixed recovery snapshot and the host restoration event; it does not require final files to remain unchanged.' };
});
check('inherited-call-and-cost-budget', 'recovery', 'Global and task call counters, committed costs and remaining budget include all prior spending.', () => {
  needCaptures(); needArchives();
  const history = child.snapshot.budgetHistory; ensure(history && typeof history.calls === 'number', 'Recovery omitted durable call counters.');
  const parentRequests = requests(parent), expectedCalls = Number(parent.snapshot.budgetHistory?.calls ?? 0) + parentRequests.length;
  ensure(history.calls === expectedCalls, 'Recovery reset or altered the prior model call counter.');
  ensure(before.modelRequests === parentRequests.length, 'Parent gained a model call after the interruption capture.');
  const parentCounts = {}, parentCosts = {};
  for (const event of parentRequests) { const id = attribution.get(parent.id).get(event.seq); if (id) parentCounts[id] = (parentCounts[id] ?? 0) + 1; }
  const ledger = before.projectUsage;
  if (!Array.isArray(ledger)) blocked('The capture lacks the project usage ledger needed to verify persisted costs.');
  for (const row of ledger.filter(row => row.runId === parentId && row.taskId)) parentCosts[row.taskId] = (parentCosts[row.taskId] ?? 0) + Number(row.cost);
  const prior = parent.snapshot.budgetHistory?.tasks ?? {}, taskIds = new Set([...Object.keys(prior), ...Object.keys(parentCounts), ...Object.keys(parentCosts)]);
  for (const id of taskIds) {
    ensure((history.tasks[id]?.calls ?? 0) === (prior[id]?.calls ?? 0) + (parentCounts[id] ?? 0), `Recovery changed task ${id} call history.`);
    ensure(near(history.tasks[id]?.cost ?? 0, Number(prior[id]?.cost ?? 0) + (parentCosts[id] ?? 0)), `Recovery changed task ${id} committed cost.`);
  }
  const carry = child.snapshot.costCarryover;
  const retained = carry?.retained ? Number(carry.reserved) : 0;
  const heldBefore = before.carriedModelReceipts ?? [], heldAfter = after.carriedModelReceipts ?? [];
  ensure(equal(heldBefore, heldAfter), 'Restart changed the retained receipt ledger.');
  ensure(!heldAfter.length || carry?.retained === true, 'Recovery removed consent or its unknown cost reservations.');
  if (carry?.retained) {
    ensure(child.snapshot.approval?.retainUncertainCosts === true, 'Recovery has no explicit consent to retain unknown costs.');
    ensure(Array.isArray(carry.receipts) && carry.receipts.every(row => uuid.test(row.id) && Number.isFinite(row.amount) && row.amount >= 0), 'Recovery has invalid retained receipts.');
    ensure(new Set(carry.receipts.map(row => row.id)).size === carry.receipts.length && near(sum(carry.receipts.map(row => row.amount)), retained), 'Recovery retained receipt total is inconsistent.');
    ensure(near(carry.recordedCost, Number(before.projectCost)), 'Recovery changed the confirmed project spending.');
    ensure(equal(sorted(carry.receipts.map(row => `${row.id}:${row.amount}`)), sorted(heldAfter.map(row => `${row.id}:${row.amount}`))), 'Recovery dropped or altered an unknown cost reservation.');
    ensure(heldAfter.every(row => row.status === 'uncertain'), 'An unknown bill was silently relabeled as confirmed.');
    ensure(near(carry.availableBudget, child.snapshot.executionBudget), 'Recovery net allocation differs from its recorded carryover.');
  }
  ensure(near(child.snapshot.executionBudget, child.snapshot.policy.maxBudget - Number(before.projectCost) - retained), 'Recovery reset or increased the remaining project budget.');
  ensure(history.calls + requests(child).length <= (child.snapshot.policy.maxModelCalls ?? 100), 'The project exceeded its unchanged model-call allowance.');
  return { inheritedCalls: history.calls, parentCalls: parentRequests.length, earlierInheritedCalls: parent.snapshot.budgetHistory?.calls ?? 0, resumedCalls: requests(child).length, taskHistory: history.tasks, priorProjectCost: before.projectCost, policyBudget: child.snapshot.policy.maxBudget, executionBudget: child.snapshot.executionBudget, retainedUnknownCost: retained, retainedReceiptIds: carry?.retained ? carry.receipts.map(row => row.id) : [] };
});
check('unknown-operations-not-blindly-replayed', 'recovery', 'Unknown external operations and old approvals require recorded reconciliation before reuse.', () => {
  needCaptures(); needArchives();
  const unknown = unresolvedOperations(parent.events), acknowledgements = child.snapshot.approval?.reconciledOperations ?? [];
  for (const operation of unknown) ensure(acknowledgements.some(record => record.callId === operation.callId && record.name === operation.name), 'Recovery continued despite an unacknowledged unknown operation.');
  const oldPending = new Set((before.approvals ?? []).filter(approval => approval.status === 'pending').map(approval => approval.id));
  ensure(!child.events.some(event => event.type === 'approval/decided' && oldPending.has(event.data.id)), 'The child reused an old pending tool approval.');
  return { parentUnknownOperations: unknown.map(({ callId, name }) => ({ callId, name })), acknowledgedUnknownOperations: acknowledgements.map(({ callId, name }) => ({ callId, name })), oldApprovalsReused: 0, finalUnknownOperations: unresolvedOperations(child.events).map(({ callId, name }) => ({ callId, name })) };
});
check('real-configured-model-trace', 'execution', 'Model dispatches identify the requested real wire model and exclude the fixed-response fixture runtime.', () => {
  needArchives();
  for (const run of [parent, child]) {
    ensure(run.snapshot.mode !== 'fixture' && !run.snapshot.demo?.fixture, 'This evidence uses a fixed-response fixture.');
    ensure(requests(run).length > 0, 'A run lacks actual model wire-request evidence.');
    ensure(requests(run).every(event => expectedModels.includes(event.data.body?.model)), 'A recorded wire request used a different model.');
    if (expectedModels.length > 1) for (const event of requests(run)) {
      const taskId = attribution.get(run.id).get(event.seq), task = approved(run).find(task => task.id === taskId);
      const employee = run.snapshot.agents?.find(agent => agent.id === event.data.agentId && agent.employeeId === event.data.employeeId);
      const route = run.snapshot.modelRoutes?.find(route => route.id === event.data.modelId);
      const assigned = task ? task.assignee === employee?.id : !taskId && employee?.role === 'manager';
      ensure(employee && assigned && [employee.modelId, employee.fallbackModelId].includes(route?.id) && route?.wireModel === event.data.body?.model,
        'A wire request differs from the approved employee model route.');
    }
    ensure(receipts(run).length > 0, 'A run lacks returned model usage evidence.');
  }
  return { modelWireName, parentRequests: requests(parent).length, resumedRequests: requests(child).length, parentBilledCalls: receipts(parent).length, resumedBilledCalls: receipts(child).length, scope: 'Archived wire dispatches, configured model identity and actual usage receipts. The audit itself does not call or impersonate a model.' };
});
check('unfinished-nodes-continued', 'execution', 'Nodes unfinished at interruption actually continued under their original approved identities.', () => {
  needArchives(); needCaptures();
  const progress = unfinishedBefore.map(id => ({ taskId: id, status: childStates.get(id)?.status ?? 'missing', modelCalls: requests(child).filter(event => attribution.get(child.id).get(event.seq) === id).length }));
  ensure(progress.some(task => task.modelCalls > 0), 'No unfinished node continued after recovery.');
  if (!progress.every(task => task.status === 'completed')) { if (finalBlocked) blocked('Some restored unfinished nodes remain incomplete; final acceptance is still blocked.'); if (finalStopped) throw Error('Execution stopped with unfinished nodes.'); blocked('Wait for every unfinished node to complete.'); }
  return { tasks: progress };
});
check('native-development-and-independent-tests', 'execution', 'Development and separate testing have host-observed successful native commands and real outputs.', () => {
  needArchives();
  const contracts = approved(child), relevant = contracts.filter(task => ['implementation', 'verification', 'review', 'repair'].includes(task.kind));
  ensure(relevant.some(task => task.kind === 'implementation'), 'No approved implementation task is available.');
  const byId = new Map(contracts.map(task => [task.id, task]));
  const separate = relevant.filter(task => ['verification', 'review'].includes(task.kind)).filter(task => {
    const source = byId.get(task.sourceTaskId ?? task.reviewedTaskId) ?? task.dependencies?.map(id => byId.get(id)).find(source => source?.kind === 'implementation');
    return source && source.assignee !== task.assignee;
  });
  ensure(separate.length > 0, 'Testing/review is not assigned independently from development.');
  const verified = [];
  for (const task of relevant) {
    if (childStates.get(task.id)?.status !== 'completed') { if (finalBlocked) blocked(`Task ${task.id} has not completed its native verification.`); throw Error(`Task ${task.id} did not complete.`); }
    const sourceRun = completedBefore.includes(task.id) ? parent : child;
    const seal = sourceRun.events.findLast(event => event.type === 'handoff/accepted' && event.data.taskId === task.id)?.data ?? sourceRun.snapshot.handoffCheckpoints?.find(record => record.taskId === task.id);
    ensure(seal, `Task ${task.id} has no host acceptance seal.`);
    for (const expected of task.verify ?? []) {
      ensure(seal.commands?.some(command => command.command === expected && command.exitCode === 0), `Task ${task.id} did not seal required command ${expected}.`);
      const actual = commands.findLast(command => command.runId === sourceRun.id && command.taskId === task.id && command.attemptId === seal.attemptId && command.command === expected && command.exitCode === 0);
      ensure(actual?.observationSeq, `Task ${task.id} lacks the real command receipt for ${expected}.`);
      if (sourceRun.snapshot.executionTarget?.kind === 'local') ensure(actual.localOperationId && actual.localFinishedSeq && actual.localWorkspace, `Task ${task.id} command lacks completed native-device evidence.`);
      verified.push({ runId: actual.runId, taskId: task.id, command: expected, resultSeq: actual.resultSeq, observationSeq: actual.observationSeq, localOperationId: actual.localOperationId, outputSha256: actual.outputSha256, testCounts: actual.testCounts });
    }
    if (task.kind === 'review') ensure(sourceRun.events.some(event => event.type === 'quality/reviewed' && event.data.taskId === task.id && event.data.attemptId === seal.attemptId && event.data.verdict === 'pass'), `Independent review ${task.id} has no host-recorded pass verdict.`);
  }
  ensure(verified.length > 0 && commands.some(command => command.exitCode === 0 && command.testCounts?.tests > 0 && command.testCounts.fail === 0), 'There is no successful native test output with executed tests.');
  return { independentlyAssignedTasks: separate.map(task => task.id), requiredCommands: verified };
});
check('employee-delivery-provenance', 'delivery', 'Final delivery versions have corresponding successful employee write operations in the real run history.', () => {
  needArchives(); const files = listArtifacts(join(traceRoot, childId, 'artifacts'));
  if (!files.length) blocked('There are no delivery files yet.');
  const evidence = [];
  for (const file of files) {
    let origin;
    for (const run of [parent, child]) {
      for (const event of run.events.filter(event => event.type === 'artifact/updated' && event.data.files?.some(record => record.path === file.path && record.sha256 === file.sha256))) {
        const start = run.events.find(item => item.type === 'tool/start' && item.callId === event.callId);
        const result = run.events.find(item => item.type === 'tool/result' && item.callId === event.callId && !item.data.result?.isError);
        if (!start || !result || !['artifact_write', 'terminal', 'terminal_test'].includes(start.data.name) || start.data.name === 'artifact_write' && start.data.arguments?.path !== file.path) continue;
        const taskId = event.taskId ?? attribution.get(run.id).get(result.seq);
        if (!approved(run).some(task => task.id === taskId && task.outputs?.some(output => output.path === file.path))) continue;
        if (!requests(run).some(request => request.sessionId === event.sessionId && request.seq < event.seq)) continue;
        origin = { runId: run.id, taskId, callId: event.callId, artifactEventSeq: event.seq, toolResultSeq: result.seq, toolName: start.data.name }; break;
      }
      if (origin) break;
    }
    ensure(origin, `File ${file.path} has no matching successful employee-generated version in these archives.`);
    evidence.push({ ...file, origin });
  }
  if (child.status === 'completed') for (const task of approved(child)) for (const required of task.outputs ?? []) ensure(files.some(file => file.path === required.path), `Completed delivery is missing ${required.path}.`);
  return { files: evidence, verificationMethod: 'Hash matches in host artifact receipts linked to approved employee operations and preceding model dispatches; no employee file is created or changed by this audit.' };
});
check('manager-final-acceptance', 'delivery', 'The manager and all approved tasks completed and the host sealed final delivery.', () => {
  needArchives(); ensure(managerTasks.length > 0, 'No manager-owned approved acceptance task is present.');
  if (child.status !== 'completed') { if (finalBlocked) blocked('Manager final acceptance has not completed; unresolved model receipts or an active run require further work.'); throw Error('The resumed run ended without successful final delivery.'); }
  ensure(approved(child).every(task => childStates.get(task.id)?.status === 'completed'), 'Completed run has incomplete approved DAG nodes.');
  const accepted = [];
  for (const task of managerTasks) {
    const seal = child.events.findLast(event => event.type === 'handoff/accepted' && event.data.taskId === task.id);
    ensure(seal, `Manager task ${task.id} has no host acceptance record.`);
    for (const expected of task.verify ?? []) ensure(commands.some(command => command.runId === childId && command.taskId === task.id && command.attemptId === seal.data.attemptId && command.command === expected && command.exitCode === 0 && command.observationSeq), `Manager task ${task.id} lacks native verification ${expected}.`);
    accepted.push({ taskId: task.id, acceptanceSeq: seal.seq, attemptId: seal.data.attemptId, commands: seal.data.commands?.map(({ command, exitCode }) => ({ command, exitCode })) });
  }
  return { finalRunStatus: child.status, managerTasks: accepted, runFinishedSeq: child.events.findLast(event => event.type === 'run/finished')?.seq };
});
check('final-receipts-and-no-unknown-effects', 'delivery', 'Final delivery has no unaccounted sent model request or unknown external operation.', () => {
  needArchives(); const uncertain = unresolvedCalls(child), operations = unresolvedOperations(child.events);
  if (uncertain.length || operations.length) blocked('Final model fees or external outcomes remain unknown; delivery cannot be accepted yet.');
  const billedIds = new Set(receipts(child).map(event => event.data.id));
  for (const row of latestChildCapture?.value.projectUsage ?? []) billedIds.add(row.id);
  const missing = requests(child).filter(event => !billedIds.has(event.data.usageId));
  if (missing.length) blocked('Some model wire requests lack a returned or independently captured settled usage receipt.');
  return { knownRunCostFromTrace: sum(receipts(child).map(event => event.data.cost)), capturedProjectCost: latestChildCapture?.value.projectCost, settledRequestCount: billedIds.size, childWireRequests: requests(child).length, unresolvedModelReceipts: 0, unknownOperations: 0, ledgerCapture: latestChildCapture?.path };
});

const aggregate = values => values.some(value => value.status === 'failed') ? 'failed' : values.some(value => value.status === 'blocked') ? 'blocked' : 'passed';
const report = {
  schemaVersion: 1, auditedAt: new Date().toISOString(), status: aggregate(checks), recoveryMechanism: aggregate(checks.filter(check => check.group === 'recovery')),
  endToEndDelivery: aggregate(checks.filter(check => check.group !== 'recovery')), dataDirectory, parentRunId: parentId, resumedRunId: childId,
  modelWireName, projectId: parent?.snapshot.projectId, finalStatus: child?.status ?? 'missing', originalDataModifiedByAudit: false, employeeDeliverablesEditedByAudit: false,
  inputs: [beforeInput, afterInput, ...(latestChildCapture ? [latestChildCapture] : [])].map(({ path, sha256, error }) => ({ path, sha256, error })),
  checks, counts: Object.fromEntries(['passed', 'failed', 'blocked'].map(status => [status, checks.filter(check => check.status === status).length])),
  completedBefore: completedBefore, finalTasks: [...childStates].map(([taskId, task]) => ({ taskId, nativeId: task.nativeId, status: task.status, assignee: task.assignee, attemptId: task.attempt_id ?? task.attemptId, ...(task.output ? { outputSha256: sha(task.output) } : {}) })),
  nativeCommandResults: commands, unresolvedModelReceipts: unresolvedCalls(child),
  limitations: ['This report verifies captured real-run evidence; it does not create missing evidence, modify data, approve actions or invoke a model.', 'Final native outputs and file hashes are recorded; historical restored files may subsequently be legitimately updated by employees.'],
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(redact(report), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, status: report.status, recoveryMechanism: report.recoveryMechanism, endToEndDelivery: report.endToEndDelivery, finalStatus: report.finalStatus, counts: report.counts,
  incompleteChecks: checks.filter(check => check.status !== 'passed').map(({ id, status, message }) => ({ id, status, message })) }, null, 2));
process.exitCode = report.status === 'failed' ? 1 : report.status === 'blocked' ? 2 : 0;
