import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readRun } from '../services/agent-runtime/trace-store.mjs';
import { listArtifacts } from '../services/agent-runtime/sandbox.mjs';

// Read-only audit of real archived evidence. No model dispatch, reconciliation,
// tool approval or employee file edits occur here.
const [directory, parentId, resumedId, finalId = resumedId] = process.argv.slice(2);
if (!directory || [parentId, resumedId, finalId].some(id => !/^[a-f0-9-]{36}$/.test(id ?? '')))
  throw Error('Usage: node scripts/verify-mvp-recovery.mjs <data directory> <interrupted Run ID> <resumed Run ID> [final Run ID]');
const data = resolve(directory), traces = join(data, 'runs');
const report = label => JSON.parse(readFileSync(resolve('.data/mvp-evidence', parentId + '-' + label + '.json'), 'utf8'));
const before = report('before-restart'), after = report('after-restart');
const parent = readRun(traces, parentId), child = readRun(traces, resumedId), final = readRun(traces, finalId);
const checks = [];
const check = (description, fn) => { fn(); checks.push({ description, status: 'passed' }); };
const requests = run => run.events.filter(e => e.type === 'model/wire-request');
const billed = run => run.events.filter(e => e.type === 'billing/usage');
const tasks = run => run.events.findLast(e => ['team/checkpoint', 'team/snapshot'].includes(e.type))?.data.tasks ?? [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
check('All archives are intact; interruption preserved model calls, expenses, DAG state and file versions.', () => {
  for (const run of [parent, child, final]) assert.equal(run?.integrity, 'ok');
  assert.equal(before.status, 'running'); assert.equal(after.status, 'interrupted');
  assert.equal(before.modelRequests, after.modelRequests);
  assert.equal(before.runCost, after.runCost);
  assert.deepEqual(before.tasks, after.tasks);
  assert.deepEqual(before.artifacts, after.artifacts);
  assert.equal(before.unconfirmedCalls, 0);
  assert.equal(before.unknownOperations.length, 0);
  assert.equal(before.operations.filter(o => ['queued', 'claimed', 'started'].includes(o.status)).length, 0);
  assert.ok(before.approvals.some(a => a.status === 'pending'));
  assert.ok(!after.approvals.some(a => a.status === 'pending'), 'stale approval must be cancelled');
});
check('The original approved DAG and policy remain unchanged after recovery.', () => {
  assert.equal(child.snapshot.resumedFrom, parentId);
  assert.deepEqual(child.snapshot.policy, parent.snapshot.policy);
  const approvedTasks = parent.snapshot.approvedTasks ?? parent.snapshot.tasks;
  assert.ok(isDeepStrictEqual(child.snapshot.approvedTasks, approvedTasks), 'the approved task contracts must be unchanged');
  assert.deepEqual(Object.keys(child.snapshot.recovery.nodes).sort(), approvedTasks.map(t => t.id).sort());
});
check('Completed development was restored without a new development model call or repeated acceptance.', () => {
  assert.deepEqual(child.snapshot.completedCheckpoints, ['dev']);
  assert.equal(tasks(child).find(t => t.id === 't1')?.status, 'completed');
  assert.equal(requests(child).filter(e => (e.taskId ?? e.data.taskId) === 'dev').length, 0);
  assert.equal(child.events.filter(e => e.type === 'handoff/accepted' && e.data.taskId === 'dev').length, 0);
  assert.equal(child.snapshot.recovery.nodes.dev.output, before.tasks.find(t => t.id === 't1').output);
  assert.ok(child.snapshot.recovery.nodes.dev.commands.some(c => c.exitCode === 0));
});
check('Accepted files and unfinished QA material retained the precise interrupted versions.', () => {
  assert.equal(child.snapshot.recovery.files.length, before.artifacts.length);
  const restored = child.events.find(e => e.type === 'recovery/restored').data;
  assert.deepEqual(restored.files, child.snapshot.recovery.files);
  for (const file of child.snapshot.recovery.files) {
    assert.equal(file.sha256, before.artifacts.find(f => f.path === file.path)?.sha256);
    assert.equal(sha(readFileSync(join(data, 'workspaces', resumedId, file.path))), file.sha256);
    assert.equal(sha(readFileSync(join(traces, resumedId, 'artifacts', file.path))), file.sha256);
  }
  assert.equal(child.snapshot.recovery.files.find(f => f.path === 'acceptance.test.mjs').state, 'unverified');
});
check('Global and per-task call counters and all prior project costs were inherited.', () => {
  assert.equal(child.snapshot.budgetHistory.calls, before.modelRequests);
  for (const [taskId, usage] of Object.entries(child.snapshot.budgetHistory.tasks)) {
    assert.equal(usage.calls, before.callsByTask[taskId]);
    const priorCost = billed(parent).filter(e => e.taskId === taskId).reduce((sum, e) => sum + e.data.cost, 0);
    assert.ok(Math.abs(usage.cost - priorCost) < 1e-12, 'per-task expenses must remain exact to the recorded currency precision');
  }
  assert.ok(Math.abs(child.snapshot.executionBudget - (child.snapshot.policy.maxBudget - before.projectCost)) < 1e-12);
  assert.ok(child.snapshot.budgetHistory.calls + requests(child).length <= child.snapshot.policy.maxModelCalls);
});
check('Unfinished QA verification and independent review actually continued with successful native commands.', () => {
  assert.equal(tasks(child).find(t => t.id === 't2')?.status, 'completed');
  assert.equal(tasks(child).find(t => t.id === 't3')?.status, 'completed');
  const commands = child.events.filter(e => e.type === 'handoff/command-observed');
  assert.ok(commands.some(e => e.data.taskId === 'qa_verify' && e.data.command === 'node --test acceptance.test.mjs' && e.data.exitCode === 0));
  for (const command of ['node --test todo.test.mjs', 'node --test acceptance.test.mjs'])
    assert.ok(commands.some(e => e.data.taskId === 'qa_review' && e.data.command === command && e.data.exitCode === 0));
  assert.ok(child.events.some(e => e.type === 'quality/reviewed' && e.data.verdict === 'pass'));
  assert.ok(requests(child).every(e => e.data.body.model === 'gpt-6-luna'));
  assert.equal(child.snapshot.demo?.fixture, undefined);
});
const uncertainty = final.events.filter(e => e.type === 'billing/unconfirmed').map(e => e.data);
const completed = final.status === 'completed' && tasks(final).every(t => t.status === 'completed');
const result = {
  auditedAt: new Date().toISOString(), dataDirectory: data, originalDataModifiedByAudit: false,
  employeeDeliverablesEditedByCodex: false, parentRunId: parentId, resumedRunId: resumedId, finalRunId: finalId,
  recoveryMechanism: 'passed', endToEndDelivery: completed ? 'passed' : 'blocked', finalStatus: final.status,
  checks, parentCalls: before.modelRequests, inheritedCalls: child.snapshot.budgetHistory.calls,
  resumedCalls: requests(child).length, resumedBilledCalls: billed(child).length,
  resumedKnownCost: billed(child).reduce((sum, e) => sum + e.data.cost, 0),
  priorProjectCost: before.projectCost, executionBudget: child.snapshot.executionBudget, originalPolicy: child.snapshot.policy,
  finalTasks: tasks(final).map(({ id, subject, status, assignee, output }) => ({ id, subject, status, assignee, output })),
  files: listArtifacts(join(traces, finalId, 'artifacts')), unresolvedModelReceipts: uncertainty,
  limitation: completed ? undefined : 'Manager delivery has not completed. An interrupted real model receipt must be reconciled before another resume. No uncertain request is treated as zero or blindly replayed.',
};
mkdirSync(resolve('docs/test-evidence'), { recursive: true });
const output = resolve('docs/test-evidence/mvp-recovery-2026-10-02.json');
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, recoveryMechanism: result.recoveryMechanism, endToEndDelivery: result.endToEndDelivery, checks: checks.length }, null, 2));
if (!completed) process.exitCode = 2;
