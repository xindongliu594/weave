import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readRun } from '../services/agent-runtime/trace-store.mjs';
import { listArtifacts } from '../services/agent-runtime/sandbox.mjs';

// Read-only evidence capture. This never dispatches models, approves tools or
// edits employee files. The local session supplies the currently running port.
const [dataDirectory, runId, label = 'state'] = process.argv.slice(2);
if (!dataDirectory || !/^[a-f0-9-]{36}$/.test(runId ?? '') || !/^[a-z0-9-]+$/.test(label))
  throw Error('Usage: node scripts/capture-mvp-run.mjs <local data directory> <Run ID> <evidence label>');
const directory = resolve(dataDirectory), run = readRun(join(directory, 'runs'), runId);
if (!run || run.integrity !== 'ok') throw Error('Missing or invalid run archive');
const session = JSON.parse(readFileSync(join(directory, 'session.json'), 'utf8'));
const api = `http://127.0.0.1:${session.apiPort}/api`;
const get = async endpoint => {
  const response = await fetch(api + endpoint, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error(`${endpoint}: ${response.status}`);
  return response.json();
};
const [state, approvals, operations, usage, costs] = await Promise.all([
  get(`/runs/${runId}`), get(`/approvals?runId=${runId}`), get(`/runs/${runId}/local-operations`), get('/usage'), get('/costs'),
]);
const costReadiness = state.recovery?.costReadiness;
const openModelReceipts = costs.calls.filter(call => call.projectId === run.snapshot.projectId)
  .map(({id,modelName,status,amount,createdAt,runId}) => ({id,modelName,status,amount,createdAt,runId}));
const approvedCarry = run.snapshot.costCarryover?.retained === true && run.snapshot.approval?.retainUncertainCosts === true;
const carriedIds = new Set(openModelReceipts.filter(call => call.status === 'uncertain' && call.runId !== runId && approvedCarry &&
  run.snapshot.costCarryover.receipts.some(original => original.id === call.id && original.amount === call.amount &&
    (original.runId ?? undefined) === (call.runId ?? undefined))).map(call => call.id));
const requests = run.events.filter(e => e.type === 'model/wire-request');
const billing = run.events.filter(e => e.type === 'billing/usage');
const tasks = run.events.findLast(e => ['team/checkpoint', 'team/snapshot'].includes(e.type))?.data.tasks ?? [];
const projectUsage = usage.filter(row => row.projectId === run.snapshot.projectId);
const artifacts = listArtifacts(join(directory, 'runs', runId, 'artifacts'));
const downloads = await Promise.all(artifacts.slice(0, 20).map(async file => {
  const response = await fetch(`${api}/runs/${runId}/artifact?path=${encodeURIComponent(file.path)}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error(`Artifact ${file.path}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== file.sha256) throw Error(`Artifact download hash mismatch: ${file.path}`);
  return { path:file.path, size:bytes.length, sha256, contentDisposition:response.headers.get('content-disposition'), nosniff:response.headers.get('x-content-type-options') };
}));
const result = {
  capturedAt: new Date().toISOString(), dataDirectory: directory, runId, projectId: run.snapshot.projectId,
  status: state.status, archiveStatus: run.status, integrity: run.integrity, eventCount: run.eventCount,
  policy: run.snapshot.policy, executionBudget: run.snapshot.executionBudget, budgetHistory: run.snapshot.budgetHistory,
  costCarryover: run.snapshot.costCarryover, costReadiness,
  resumedFrom: run.snapshot.resumedFrom, completedCheckpoints: run.snapshot.completedCheckpoints,
  approvedTasks: run.snapshot.approvedTasks ?? run.snapshot.tasks, recovery: run.snapshot.recovery,
  tasks: tasks.map(({ id, subject, status, assignee, dependencies, attempt_id, output, verdict }) =>
    ({ id, subject, status, assignee, dependencies, attempt_id, output, verdict })),
  modelRequests: requests.length, models: [...new Set(requests.map(e => e.data.body?.model))],
  callsByTask: Object.fromEntries([...new Set(requests.map(e => e.taskId ?? e.data.taskId))].map(id =>
    [id, requests.filter(e => (e.taskId ?? e.data.taskId) === id).length])),
  billedCalls: billing.length, runCost: billing.reduce((n, e) => n + Number(e.data.cost), 0),
  unconfirmedCalls: run.events.filter(e => e.type === 'billing/unconfirmed').length,
  projectCost: projectUsage.reduce((n, row) => n + row.cost, 0), projectUsage,
  unknownOperations: state.recovery?.unknownOperations ?? [],
  checkpointBlocked: state.recovery?.checkpointBlocked,
  costBlocked: state.recovery?.costBlocked,
  openModelReceipts,
  // Explicitly retained unknown costs are still visible and reserved. They do
  // not disguise an in-flight request or an unconfirmed cost from this run.
  pendingModelReceipts: openModelReceipts.filter(call => call.status === 'pending' || !carriedIds.has(call.id)),
  carriedModelReceipts: openModelReceipts.filter(call => call.status === 'uncertain' && carriedIds.has(call.id)),
  runtime: run.events.findLast(e => e.type === 'runtime/status')?.data,
  handoffs: run.events.filter(e => e.type === 'handoff/accepted').map(e => ({ seq: e.seq, ...e.data })),
  commands: run.events.filter(e => e.type === 'handoff/command-observed').map(e => ({ seq: e.seq, ...e.data })),
  restored: run.events.filter(e => e.type === 'recovery/restored').map(e => ({ seq: e.seq, ...e.data })),
  artifacts, downloads, approvals, operations,
  employeeDeliverablesEditedByCodex: false,
};
const evidence = resolve('.data/mvp-evidence', `${runId}-${label}.json`);
mkdirSync(resolve('.data/mvp-evidence'), { recursive: true });
writeFileSync(evidence, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ evidence, status: result.status, tasks: result.tasks.map(t => [t.id, t.status]),
  modelRequests: result.modelRequests, billedCalls: result.billedCalls, runCost: result.runCost,
  projectCost: result.projectCost, pendingApprovals: approvals.filter(a => a.status === 'pending').map(a => ({id:a.id, agentId:a.agentId, arguments:a.arguments})),
  activeOperations: operations.filter(o => ['queued', 'claimed', 'started'].includes(o.status)).map(o => ({id:o.id, status:o.status})),
  unknownOperations: result.unknownOperations.length, artifacts: result.artifacts.map(f => f.path), checkpointBlocked: result.checkpointBlocked,
}, null, 2));
