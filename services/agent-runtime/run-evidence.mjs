import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { readRun, redact } from './trace-store.mjs';

const number = value => Number.isFinite(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const id = value => typeof value === 'string' && value ? value : null;
const unknown = reason => ({ status: 'unknown', reason });
const digest = value => ({ status: 'available', sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) });
const testKeys = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

/** Parse one complete Node runner summary, never a model's claimed counts.
 * Multiple commands, multiple summaries and partial output stay unknown. */
export function nodeTestCounts(command, output, complete = true) {
  if (!complete || typeof output !== 'string') return unknown('OUTPUT_MISSING_OR_INCOMPLETE');
  if (typeof command !== 'string' || !/^node(?:\.exe)?\s+--test(?:\s|$)/i.test(command) || /[;&|<>\r\n]/.test(command)) return unknown('NOT_SINGLE_NODE_TEST_COMMAND');
  const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const records = lines.flatMap((line, index) => {
    const match = /^(#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(line);
    return match ? [{ index, prefix: match[1], key: match[2], value: Number(match[3]) }] : [];
  });
  if (records.length !== testKeys.length || records.some((record, index) => record.key !== testKeys[index] || !Number.isSafeInteger(record.value) ||
      record.prefix !== records[0].prefix || record.index !== records[0].index + index)) return unknown('NODE_SUMMARY_MISSING_OR_AMBIGUOUS');
  const values = Object.fromEntries(records.map(record => [record.key, record.value]));
  if (values.tests !== values.pass + values.fail + values.cancelled + values.skipped + values.todo) return unknown('NODE_SUMMARY_INCONSISTENT');
  return { status: 'available', format: records[0].prefix === '#' ? 'tap' : 'spec', ...values };
}

/** This is the already completed local operation, not a new database query or
 * capability. Exact run/call/session/attempt/approval links are all required. */
export function localOperationEvidence(archive, { name, taskId, attemptId, sessionId, callId, approvalId } = {}) {
  if (!archive?.dir || !archive?.id || ![taskId, attemptId, sessionId, callId, approvalId].every(id)) return unknown('LOCAL_OPERATION_LINKS_MISSING');
  try {
    const run = readRun(dirname(archive.dir), archive.id);
    if (!run || run.integrity !== 'ok') return unknown('LOCAL_OPERATION_ARCHIVE_UNAVAILABLE');
    const matches = event => event.data?.name === name && event.data.taskId === taskId && event.data.attemptId === attemptId &&
      event.data.sessionId === sessionId && event.data.callId === callId && event.data.approvalId === approvalId && id(event.data.operationId);
    const queued = run.events.filter(event => event.type === 'local/operation-queued' && matches(event));
    const finished = run.events.filter(event => event.type === 'local/operation-finished' && matches(event));
    if (queued.length !== 1 || finished.length !== 1 || queued[0].data.operationId !== finished[0].data.operationId || queued[0].seq >= finished[0].seq)
      return unknown('LOCAL_OPERATION_NOT_UNIQUELY_COMPLETED');
    return { status: 'available', operationId: finished[0].data.operationId, queuedSeq: queued[0].seq, finishedSeq: finished[0].seq };
  } catch { return unknown('LOCAL_OPERATION_ARCHIVE_UNAVAILABLE'); }
}

/** Only host-returned strings are hashed. Current executors merge stdout and
 * stderr; do not mislabel the combined output as either individual stream. */
export function commandEvidence({ archive, name, taskId, attemptId, args, result, context = {} }) {
  const complete = result?.outputTruncated !== true && result?.truncated !== true;
  const output = typeof result?.output === 'string' ? { ...digest(result.output), complete, layout: 'combined' } : unknown('EXECUTOR_OUTPUT_MISSING');
  const stream = key => typeof result?.[key] === 'string' ? { ...digest(result[key]), complete } : unknown('EXECUTOR_STREAM_NOT_SEPARATE');
  return {
    version: 1, runId: id(archive?.id), observedAt: new Date().toISOString(), tool: name,
    sessionId: id(context.sessionId), callId: id(context.callId),
    approval: id(context.approvalId) ? { status: 'available', approvalId: context.approvalId } : unknown('APPROVAL_ID_MISSING'),
    operation: localOperationEvidence(archive, { name, taskId, attemptId, ...context }),
    hashBasis: 'executor-result-before-archive-redaction', output, stdout: stream('stdout'), stderr: stream('stderr'),
    nodeTests: nodeTestCounts(args?.command, result?.output, complete),
  };
}

/** Entry values are immutable admission evidence, not a current ledger. Missing
 * values in old snapshots must not become zero. */
export function inheritedBudgetEvidence(snapshot = {}) {
  const ledger = snapshot.costCarryover;
  return {
    basis: 'run-admission-snapshot', recordedCost: number(ledger?.recordedCost), retainedUnknownReservation: number(ledger?.reserved),
    availableBudget: number(snapshot.executionBudget), callsUsed: count(snapshot.budgetHistory?.calls),
    callsBasis: snapshot.budgetHistory?.callsBasis === 'durable-admissions-and-archived-wire-requests'
      ? snapshot.budgetHistory.callsBasis : 'archived-model-wire-request-count',
    note: '这些是入场时继承的账本与调用数；null 表示没有封存值，不代表零。',
  };
}

/** The live bucket's spent includes inherited unknown holds. Expose occupancy
 * rather than calling it all confirmed expense. No budget state is changed. */
export function captureBudgetEvidence(snapshot = {}, budget, runId, point = 'team-checkpoint') {
  const bucket = budget?.run;
  const limit = number(bucket?.limit), spent = number(bucket?.spent), reserved = number(bucket?.reserved);
  const occupied = spent !== null && reserved !== null ? number(spent + reserved) : null;
  return {
    version: 1, runId: id(runId), projectId: id(snapshot.projectId), projectVersion: count(snapshot.planVersion),
    capturedAt: new Date().toISOString(), point, basis: 'host-execution-budget', currency: 'USD',
    project: { limit, occupied, activeReserved: reserved, available: limit !== null && occupied !== null ? number(limit - occupied) : null,
      callsUsed: count(bucket?.calls), callLimit: count(bucket?.maxCalls), callsBasis: 'host-reserved-model-attempts' },
    inherited: inheritedBudgetEvidence(snapshot),
    note: '这是宿主执行预算，不是实时费用账本。occupied 含入场占用、已结算执行费用和在途预留；新增未知费用须另核对账本，不能把占用当已确认费用。null 为未知。',
  };
}

/** A node seal is not a stop-time seal. Use the latest real team checkpoint;
 * never relabel a previous recovery's budget as this source run's final value. */
export function sourceBudgetEvidence(snapshot, events, sourceRunId) {
  const event = events.findLast(event => event.type === 'team/checkpoint');
  const seal = event?.data?.budgetEvidence;
  if (!seal || seal.version !== 1 || seal.runId !== sourceRunId || seal.basis !== 'host-execution-budget' ||
      seal.projectId !== id(snapshot.projectId) || seal.projectVersion !== count(snapshot.planVersion))
    return { ...unknown('SOURCE_HOST_BUDGET_CHECKPOINT_MISSING'), sourceRunId, sourceAdmission: inheritedBudgetEvidence(snapshot) };
  // Whitelist numeric fields. Neither archive text nor private sources belong
  // in a cross-employee context, even if future checkpoint formats add them.
  const project = seal.project ?? {};
  const subsequentAccountingEvents = events.filter(item => item.seq > event.seq && ['model/wire-request', 'billing/usage', 'billing/unconfirmed'].includes(item.type)).length;
  return { status: 'available', sourceRunId, checkpointSeq: event.seq ?? null, checkpointAt: event.at ?? null,
    capturedAt: seal.capturedAt, point: seal.point, subsequentAccountingEvents, currentAtSourceEnd: subsequentAccountingEvents === 0,
    project: { limit: number(project.limit), occupied: number(project.occupied), activeReserved: number(project.activeReserved),
      available: number(project.available), callsUsed: count(project.callsUsed), callLimit: count(project.callLimit), callsBasis: 'host-reserved-model-attempts' },
    sourceAdmission: inheritedBudgetEvidence(snapshot) };
}

const streamProjection = value => value?.status === 'available' && /^[a-f0-9]{64}$/.test(value.sha256 ?? '')
  ? { status: 'available', sha256: value.sha256, bytes: count(value.bytes), ...(typeof value.complete === 'boolean' ? { complete: value.complete } : {}), ...(value.layout === 'combined' ? { layout: 'combined' } : {}) }
  : unknown(value?.reason === 'EXECUTOR_STREAM_NOT_SEPARATE' ? value.reason : 'OUTPUT_HASH_MISSING');
function receiptProjection(command, record, sourceRunId) {
  const evidence = command.evidence;
  const tests = evidence?.nodeTests;
  const counts = tests?.status === 'available' && testKeys.every(key => count(tests[key]) !== null) ?
    { status: 'available', format: tests.format === 'tap' ? 'tap' : 'spec', ...Object.fromEntries(testKeys.map(key => [key, tests[key]])) } : unknown('NODE_COUNTS_NOT_VERIFIED');
  return {
    command: redact(command.command), exitCode: Number.isSafeInteger(command.exitCode) ? command.exitCode : null,
    runId: id(evidence?.runId) ?? sourceRunId, observedAt: id(evidence?.observedAt), observationSeq: count(command.observationSeq),
    workspaceRevision: id(command.workspaceRevision), validAtAccepted: id(record.workspaceRevision) ? command.workspaceRevision === record.workspaceRevision : null,
    sessionId: id(evidence?.sessionId), callId: id(evidence?.callId),
    approval: evidence?.approval?.status === 'available' && id(evidence.approval.approvalId) ? { status: 'available', approvalId: evidence.approval.approvalId } : unknown('APPROVAL_ID_MISSING'),
    operation: evidence?.operation?.status === 'available' && id(evidence.operation.operationId) ?
      { status: 'available', operationId: evidence.operation.operationId, queuedSeq: count(evidence.operation.queuedSeq), finishedSeq: count(evidence.operation.finishedSeq) } : unknown('LOCAL_OPERATION_UNVERIFIED'),
    output: streamProjection(evidence?.output), stdout: streamProjection(evidence?.stdout), stderr: streamProjection(evidence?.stderr), nodeTests: counts,
  };
}

/** No arbitrary task output, terminal text, citations or model completion
 * claims. Only accepted ancestors with matching committed native attempts. */
export function taskRunEvidence({ snapshot, taskId, state, taskIds, handoff, budget, runId }) {
  const tasks = handoff?.tasks ?? new Map((snapshot.tasks ?? []).map(task => [task.id, task]));
  const ancestors = new Set();
  const visit = key => { for (const dep of tasks.get(key)?.dependencies ?? []) if (!ancestors.has(dep)) { ancestors.add(dep); visit(dep); } };
  visit(taskId); ancestors.delete(taskId);
  const completedAncestors = [], unavailableAncestors = [];
  for (const ancestorId of ancestors) {
    const native = (state?.tasks ?? []).findLast(task => (taskIds.get(task.id) ?? task.id) === ancestorId);
    const record = (handoff?.committed ?? handoff?.accepted)?.get(ancestorId);
    if (native?.status !== 'completed' || !id(native.attemptId) || !record || record.attemptId !== native.attemptId) {
      unavailableAncestors.push({ taskId: ancestorId, reason: 'NO_MATCHING_COMPLETED_HOST_SEAL' }); continue;
    }
    const restored = (snapshot.recovery?.completed ?? []).some(task => task.taskId === ancestorId && task.attemptId === record.attemptId);
    const sourceRunId = id(record.runId) ?? (restored ? id(snapshot.recovery.sourceRunId) : id(runId));
    completedAncestors.push({ taskId: ancestorId, attemptId: record.attemptId, runtimeTaskId: native.id, sourceRunId, restored,
      acceptedAt: id(record.acceptedAt), workspaceRevision: id(record.workspaceRevision),
      ...(record.acceptanceChecks !== undefined ? { acceptanceChecks: record.acceptanceChecks } : {}),
      outputs: (record.outputs ?? []).map(file => ({ path: file.path, sha256: file.sha256, size: count(file.size) })),
      commands: (record.commands ?? []).map(command => receiptProjection(command, record, sourceRunId)) });
  }
  return {
    version: 1, currentRunId: id(runId), taskId, completedAncestors, unavailableAncestors,
    currentBudget: captureBudgetEvidence(snapshot, budget, runId, 'employee-context'),
    ...(snapshot.recovery ? { recoveryBudget: { sourceRunId: snapshot.recovery.sourceRunId,
      sourceCheckpoint: snapshot.recovery.budgetEvidence ?? unknown('SOURCE_HOST_BUDGET_CHECKPOINT_MISSING'), inherited: inheritedBudgetEvidence(snapshot) } } : {}),
    rule: '这是宿主观察回执的只读元数据，不是上游员工口述。原结果按 runId/callId/operationId/seq 在运行档案追溯；没有终端正文或私有知识。恢复的 completed 节点禁止重复执行，旧审批不得重放。分流哈希或测试汇总未知时必须如实说明；预算占用不是已确认费用。',
  };
}
