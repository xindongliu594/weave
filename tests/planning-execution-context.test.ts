import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import type pg from 'pg';
import { createRunArchive } from '../services/agent-runtime/trace-store.mjs';
import { inspectArtifact } from '../services/agent-runtime/handoff.mjs';
import { buildPlanningExecutionContext } from '../apps/api/src/planning-execution-context.ts';

// Only the runner's brand-new PGlite database and temporary fixture archives.
// No running product, credential store or model/provider is used.
const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
let pool: pg.Pool, directory: string, traceRoot: string;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const near = (value: number | undefined, expected: number) => assert.ok(value !== undefined && Math.abs(value - expected) < 1e-10);
const readQueries: string[] = [];
const readonlyDb = { query: async (sql: string, values: any[]) => {
  assert.match(sql, /^SELECT\b/i, 'Inspection can only issue SELECT statements');
  assert.doesNotMatch(sql, /\b(?:gateways|credentials?|local_devices|models)\b/i, 'No connection credential or device data is queried');
  readQueries.push(sql); return pool.query(sql, values);
} } as unknown as Pick<pg.PoolClient, 'query'>;

before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /@127\.0\.0\.1:\d+\/postgres$/);
  directory = await mkdtemp(join(tmpdir(), 'planning-execution-context-')); traceRoot = join(directory, 'runs');
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = traceRoot; process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)', ['planning-context-department', { name: '隔离规划上下文' }]);
  await pool.query('INSERT INTO models(id,data) VALUES($1,$2)', ['planning-context-model', { name: 'Never requested fixture model' }]);
});
beforeEach(async () => {
  if (!isolated) return;
  await pool.query('TRUNCATE model_reservations,usage,project_runs,projects CASCADE'); readQueries.length = 0;
});
after(async () => {
  if (!isolated) return;
  await pool?.end();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('planning-execution-context-'));
  await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const id = randomUUID(), runId = randomUUID(), priorId = randomUUID();
  const agents = [
    { id: 'developer', name: 'Developer', role: 'employee', modelId: 'planning-context-model', tools: ['filesystem', 'artifact_write', 'terminal_test'], knowledgeSpaceIds: ['shared'] },
    { id: 'qa', name: 'Independent QA', role: 'employee', modelId: 'planning-context-model', tools: ['filesystem', 'artifact_write', 'terminal_test', 'knowledge_read'], knowledgeSpaceIds: ['shared', 'private-qa'] },
    { id: 'manager', name: 'Manager', role: 'manager', modelId: 'planning-context-model', tools: ['filesystem', 'artifact_write', 'knowledge_read'], knowledgeSpaceIds: ['shared'] },
  ];
  const inputRoot = join(traceRoot, runId, 'artifacts'); await mkdir(inputRoot, { recursive: true });
  for (const path of ['server.mjs', 'todo.test.mjs', 'README.md', 'acceptance.test.mjs']) await writeFile(join(inputRoot, path), 'Local fixture file: ' + path);
  const producerOutputs = ['server.mjs', 'todo.test.mjs', 'README.md'].map(path => ({ path, format: 'text' }));
  const producerInputs = producerOutputs.map(({ path }) => ({ path, producerTaskId: 'dev' }));
  const fixedInput = inspectArtifact(inputRoot, { path: 'acceptance.test.mjs' });
  const tasks = [
    { id: 'dev', subject: 'Develop', objective: 'Produce bounded fixture files', assigneeId: 'developer', kind: 'implementation', dependencies: [],
      acceptanceCriteria: ['real developer evidence is retained'], estimatedInputTokens: 10, estimatedOutputTokens: 10,
      inputs: [], outputs: producerOutputs, inScope: producerOutputs.map(file => file.path), verify: ['node --test todo.test.mjs'] },
    { id: 'qa_verify', subject: 'Independent CLI test', objective: 'Only repair own original acceptance script after testing the producer files', assigneeId: 'qa', kind: 'verification', dependencies: ['dev'],
      acceptanceCriteria: ['real CLI tests'], estimatedInputTokens: 10, estimatedOutputTokens: 1400,
      inputs: [...producerInputs, { path: fixedInput.path, sha256: fixedInput.sha256 }], outputs: [{ path: fixedInput.path }], inScope: [fixedInput.path], verify: ['node --test todo.test.mjs', 'node --test acceptance.test.mjs'] },
    { id: 'qa_review', subject: 'Independent review', objective: 'Run real verification again', assigneeId: 'qa', kind: 'review', reviewedTaskId: 'dev', dependencies: ['dev', 'qa_verify'],
      acceptanceCriteria: ['independent verdict'], estimatedInputTokens: 10, estimatedOutputTokens: 1400,
      inputs: [...producerInputs, { path: fixedInput.path, producerTaskId: 'qa_verify' }], outputs: [], verify: ['node --test todo.test.mjs', 'node --test acceptance.test.mjs'] },
    { id: 'manager', subject: 'Deliver report', objective: 'Use shared knowledge only and preserve actual evidence', assigneeId: 'manager', kind: 'work', dependencies: ['qa_review'],
      acceptanceCriteria: ['report'], estimatedInputTokens: 10, estimatedOutputTokens: 10,
      inputs: [...producerInputs, { path: fixedInput.path, producerTaskId: 'qa_verify' }], outputs: [{ path: 'acceptance-report.md' }], inScope: ['acceptance-report.md'] },
  ];
  const project = { id, version: 6, requirement: 'Original frozen v6 requirement', plan: { rationale: 'Preserve all four tasks', agents, tasks }, policy: { maxBudget: .48 } };
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source,version) VALUES($1,$2,1,$3,$4,$5,$6,$7,6)',
    [id, 'planning-context-department', 'Fixture', project.requirement, project.policy, project.plan, 'manual']);
  const shared = { documentId: 'shared-doc', version: 2, title: 'Shared fixed instructions', spaceId: 'shared', sha256: hash('shared-v2'), source: { note: 'shared provenance', credential: 'SOURCE_SECRET' } };
  const privateDoc = { documentId: 'private-doc', version: 2, title: 'Private QA instructions', spaceId: 'private-qa', sha256: hash('private-v2'), source: { runId, note: 'private provenance' } };
  const historicalCitation = { documentId: 'shared-doc', version: 1, title: 'Old shared title', spaceId: 'shared', sha256: hash('shared-v1'), chunkId: 'shared-v1:1', source: { note: 'older provenance A' } };
  const snapshot: any = { projectId: id, planVersion: 6, requirement: project.requirement, departmentId: 'planning-context-department',
    agents: agents.map((agent, index) => ({ ...agent, id: 'employee-' + (index + 1), employeeId: agent.id, sourceAgentId: agent.id, sourceDepartmentId: 'planning-context-department' })),
    tasks: tasks.map((task, index) => ({ ...task, assignee: 'employee-' + (task.assigneeId === 'developer' ? 1 : task.assigneeId === 'qa' ? 2 : 3), taskPrompt: 'Runtime generated prompt ' + index })),
    knowledge: { format: 'document-versions-v2', documents: [shared, privateDoc], agentDocuments: { 'employee-1': ['shared-doc'], 'employee-2': ['shared-doc', 'private-doc'], 'employee-3': ['shared-doc'] } },
    budgetHistory: { calls: 900, tasks: { qa_verify: { cost: 99, calls: 80 } } }, // Must not be added to the durable wires again.
    recovery: { nodes: { qa_verify: { citations: [historicalCitation] } } },
    modelRoutes: [{ id: 'planning-context-model', apiKey: 'ROUTE_SECRET', baseUrl: 'https://audit.invalid/ROUTE_URL_SECRET' }],
    executionTarget: { kind: 'local', grantId: 'DEVICE_GRANT_SECRET' } };
  snapshot.approvedTasks = structuredClone(snapshot.tasks);
  const priorSnapshot = structuredClone(snapshot), prior = createRunArchive(traceRoot, priorSnapshot, { id: priorId });
  prior.append('run/task-mapping', { tasks: [{ task_id: 'native-dev', seed_id: 'dev' }, { task_id: 'native-qa', seed_id: 'qa_verify' }] });
  prior.append('model/request', {}, { sessionId: 'prior-session', taskId: 'native-dev' });
  prior.append('model/wire-request', {}, { sessionId: 'prior-session' });
  prior.append('model/wire-request', { taskId: 'qa_verify' }); prior.append('model/wire-request', {});
  prior.append('run/finished', { status: 'failed', message: 'OLD_FAILURE_SECRET' });
  const archive = createRunArchive(traceRoot, snapshot, { id: runId });
  archive.append('run/task-mapping', { tasks: tasks.map((task, index) => ({ task_id: 't' + (index + 1), seed_id: task.id })) });
  const accepted = { taskId: 'dev', attemptId: 'completed-attempt', outputs: producerOutputs.map(file => inspectArtifact(inputRoot, file)), commands: [{ command: 'node --test todo.test.mjs', exitCode: 0 }] };
  archive.append('handoff/accepted', accepted);
  archive.append('team/checkpoint', { tasks: tasks.map((task, index) => ({ task_id: 't' + (index + 1), attempt_id: index === 0 ? 'completed-attempt' : 'unfinished-attempt', status: index === 0 ? 'completed' : 'failed' })) });
  archive.append('model/wire-request', { taskId: 'qa_verify' });
  archive.append('knowledge/citation', { taskId: 'qa_verify', agentId: 'employee-2', sources: [historicalCitation, { ...historicalCitation, source: { note: 'older provenance B' } }, shared] });
  archive.append('runtime/operation-start', { name: 'artifact_write', arguments: { content: 'UNKNOWN_ARGUMENT_SECRET' } }, { callId: 'operation-unknown' });
  archive.append('runtime/operation-start', { name: 'terminal_test', arguments: { command: 'fixture' } }, { callId: 'operation-completed' });
  archive.append('runtime/operation-finished', {}, { callId: 'operation-completed' });
  archive.append('run/finished', { status: 'failed', message: 'LATEST_FAILURE_SECRET' });
  for (const [rid, at] of [[priorId, '2026-10-05T00:00:01Z'], [runId, '2026-10-05T00:00:02Z']]) await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,started_at,created_at) VALUES($1,$2,6,'failed',$3,$4,now(),$5)",
    [rid, id, snapshot, rid === priorId ? 1 : 2, at]);
  for (const [rid, taskId, cost] of [[priorId, 'dev', .02], [priorId, 'qa_verify', .03], [runId, 'qa_verify', .015542]]) await pool.query('INSERT INTO usage(id,model_id,project_id,run_id,task_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,$4,$5,1,1,$6,$7)',
    [randomUUID(), 'planning-context-model', id, rid, taskId, cost, 'isolated fixture']);
  const receiptIds: string[] = [];
  for (const [rid, taskId, amount, receiptStatus] of [[priorId, 'qa_verify', .01, 'uncertain'], [runId, 'qa_verify', .02, 'pending'], [runId, undefined, .005, 'uncertain']]) {
    const receiptId = randomUUID(); receiptIds.push(receiptId);
    await pool.query('INSERT INTO model_reservations(id,model_id,project_id,run_id,purpose,amount,input_rate,output_rate,status,context,history,expires_at) VALUES($1,$2,$3,$4,$5,$6,2,10,$7,$8,$9,now()-interval \'1 day\')',
      [receiptId, 'planning-context-model', id, rid, 'isolated historical receipt', amount, receiptStatus, { ...(taskId ? { taskId } : {}), secret: 'LEDGER_CONTEXT_SECRET' }, JSON.stringify([{ note: 'preserve actual history' }])]);
  }
  return { project, runId, priorId, snapshot, archive, inputRoot, receiptIds };
}
async function state() {
  return Promise.all(['projects', 'project_runs', 'usage', 'model_reservations'].map(async table => ({ table, rows: (await pool.query('SELECT row_to_json(t) AS data FROM ' + table + ' t ORDER BY t.id')).rows })));
}
const inspect = async (project: any) => {
  const savedFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('Planning evidence must not fetch'); };
  try { const result = await buildPlanningExecutionContext(readonlyDb, traceRoot, project); assert.equal(calls, 0); return result; }
  finally { globalThis.fetch = savedFetch; }
};

test('reads verified completion and current-version wire/ledger evidence without double-counting inherited history or mutating anything', { skip: !isolated }, async () => {
  const fixtureData = await fixture(), before = await state();
  const paths = [join(fixtureData.archive.dir, 'snapshot.json'), join(fixtureData.archive.dir, 'events.jsonl'), join(fixtureData.inputRoot, 'acceptance.test.mjs')];
  const beforeHashes = paths.map(path => hash(readFileSync(path)));
  const result = await inspect(fixtureData.project);
  assert.equal(result.available, true); assert.equal(result.sourceRun?.currentVersion, true); assert.equal(result.sourceRun?.currentPlanMatches, true);
  assert.equal(result.sourceRun?.integrity, 'ok'); assert.deepEqual(result.completedTaskIds, ['dev']);
  assert.equal(result.budget.available, true); assert.equal(result.budget.calls, 5); assert.equal(result.budget.unattributedCalls, 2);
  assert.equal(result.budget.callsBasis, 'durable-admissions-and-archived-wire-requests');
  assert.deepEqual(result.budget.tasks?.dev, { cost: .02, calls: 1 }); near(result.budget.tasks?.qa_verify.cost, .045542); assert.equal(result.budget.tasks?.qa_verify.calls, 2);
  near(result.budget.tasks?.qa_verify.reserved, .03); near(result.budget.reserved, .035); near(result.budget.unattributedReserved, .005);
  assert.equal(result.files.length, 4); assert.equal(result.files.filter(file => file.state === 'accepted').length, 3);
  assert.equal(result.files.find(file => file.path === 'acceptance.test.mjs')?.state, 'fixed_input');
  assert.deepEqual(result.unknownOperationIds, ['operation-unknown']);
  assert.deepEqual(await state(), before); assert.deepEqual(paths.map(path => hash(readFileSync(path))), beforeHashes);
  assert.ok(readQueries.length >= 4); assert.ok(!result.issues.length);
  const serialized = JSON.stringify(result);
  for (const secret of ['ROUTE_SECRET', 'ROUTE_URL_SECRET', 'DEVICE_GRANT_SECRET', 'SOURCE_SECRET', 'UNKNOWN_ARGUMENT_SECRET', 'LEDGER_CONTEXT_SECRET', 'LATEST_FAILURE_SECRET']) assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('savedPlan')); assert.ok(result.rules.some(rule => rule.includes('不自动继承')));
});

test('preserves each fixed version and distinct source fingerprint plus exact employee authorization without returning document bodies', { skip: !isolated }, async () => {
  const { project } = await fixture(), result = await inspect(project);
  assert.equal(result.knowledge.available, true); assert.equal(result.knowledge.documents.length, 2);
  const qa = result.knowledge.authorizations.find(grant => grant.agentId === 'employee-2');
  assert.deepEqual(qa?.documentIds, ['shared-doc', 'private-doc']); assert.equal(qa?.employeeId, 'qa'); assert.equal(qa?.sourceDepartmentId, 'planning-context-department');
  assert.deepEqual(result.knowledge.authorizations.find(grant => grant.agentId === 'employee-3')?.documentIds, ['shared-doc']);
  const old = result.knowledge.citations.filter(citation => citation.documentId === 'shared-doc' && citation.version === 1);
  assert.equal(new Set(old.map(citation => citation.sourceSha256)).size, 2, 'Same document/version/SHA with distinct provenance is not collapsed');
  assert.ok(old.every(citation => citation.sha256 === hash('shared-v1')));
  assert.ok(!JSON.stringify(result.knowledge).includes('note')); assert.ok(!JSON.stringify(result.knowledge).includes('content'));
});

test('a different saved version reports historical provenance but never uses old completion as new-version completion', { skip: !isolated }, async () => {
  const { project } = await fixture(); const result = await inspect({ ...project, version: 7 });
  assert.equal(result.available, true); assert.equal(result.sourceRun?.currentVersion, false); assert.equal(result.sourceRun?.projectVersion, 6);
  assert.deepEqual(result.completedTaskIds, []); assert.equal(result.budget.available, true); assert.equal(result.budget.calls, 0); near(result.budget.reserved, 0);
  assert.ok(result.issues.some(issue => issue.code === 'HISTORICAL_PLAN_VERSION')); assert.equal(result.files.filter(file => file.state === 'accepted').length, 3);
});

test('changed current task contract or requirement cannot silently reuse completed IDs even under the same version', { skip: !isolated }, async () => {
  const { project } = await fixture();
  const changed = structuredClone(project); changed.plan.tasks[0].objective = 'different developer contract';
  for (const input of [changed, { ...project, requirement: 'new requirement without reapproval' }]) {
    const result = await inspect(input); assert.equal(result.sourceRun?.currentPlanMatches, false); assert.deepEqual(result.completedTaskIds, []);
    assert.ok(result.issues.some(issue => issue.code === 'PLANNING_CONTRACT_CHANGED'));
  }
});

test('explicit output/call/money limits and artifact/verify/review bindings are part of the frozen task contract', { skip: !isolated }, async () => {
  const { project } = await fixture();
  for (const change of [
    { maxOutputTokens: 900 }, { maxModelCalls: 1 }, { maxBudget: .01 }, { inScope: ['different.mjs'] },
    { verify: ['node --test different.test.mjs'] }, { inputs: [{ path: 'README.md', sha256: 'a'.repeat(64) }] }, { reviewedTaskId: 'different' },
  ]) {
    const changed = structuredClone(project); Object.assign(changed.plan.tasks[0], change);
    const result = await inspect(changed); assert.equal(result.sourceRun?.currentPlanMatches, false); assert.deepEqual(result.completedTaskIds, []);
  }
});

test('interrupted database status is preserved while archive outcome stays separately visible', { skip: !isolated }, async () => {
  const { project, runId } = await fixture(); await pool.query("UPDATE project_runs SET status='interrupted' WHERE id=$1", [runId]);
  const result = await inspect(project); assert.equal(result.sourceRun?.status, 'interrupted'); assert.equal(result.sourceRun?.archiveStatus, 'failed'); assert.equal(result.available, true);
});

test('native completed status with changed delivery bytes is not a verified completion or accepted seal', { skip: !isolated }, async () => {
  const { project, inputRoot } = await fixture(); await writeFile(join(inputRoot, 'server.mjs'), 'changed fixture bytes');
  const result = await inspect(project); assert.deepEqual(result.completedTaskIds, []);
  assert.ok(result.issues.some(issue => issue.code === 'CHECKPOINT_UNVERIFIED'));
  assert.equal(result.files.find(file => file.path === 'server.mjs')?.sha256, hash('changed fixture bytes'));
  assert.equal(result.files.find(file => file.path === 'server.mjs')?.state, 'unverified');
});

test('missing/incomplete latest archives preserve explicit unavailable amounts/counters rather than manufactured zero', { skip: !isolated }, async () => {
  const { project, archive } = await fixture(); await appendFile(join(archive.dir, 'events.jsonl'), '{truncated');
  const result = await inspect(project); assert.equal(result.available, false); assert.equal(result.sourceRun?.integrity, 'incomplete');
  assert.equal(result.budget.available, false); assert.equal(result.budget.calls, undefined); assert.equal(result.budget.tasks, undefined); assert.equal(result.budget.reserved, undefined);
  assert.deepEqual(result.completedTaskIds, []); assert.equal(result.knowledge.available, false);
  assert.ok(result.issues.some(issue => issue.code === 'BUDGET_HISTORY_UNAVAILABLE'));
});

test('a foreign project archive cannot supply file/completion/knowledge evidence or current-version counters', { skip: !isolated }, async () => {
  const { project, runId, snapshot } = await fixture();
  const foreignId = randomUUID(), foreign = createRunArchive(traceRoot, { ...snapshot, projectId: foreignId });
  foreign.append('run/finished', { status: 'completed' });
  await pool.query('UPDATE project_runs SET id=$1 WHERE id=$2', [foreign.id, runId]);
  const result = await inspect(project); assert.equal(result.available, false); assert.equal(result.sourceRun?.integrity, 'identity_mismatch');
  assert.equal(result.budget.available, false); assert.deepEqual(result.files, []); assert.deepEqual(result.completedTaskIds, []);
});

test('no-run history and a proven cancelled-before-start entry are distinguishable from a missing started archive', { skip: !isolated }, async () => {
  const { project } = await fixture(); await pool.query('TRUNCATE model_reservations,usage,project_runs CASCADE');
  const empty = await inspect(project); assert.equal(empty.available, false); assert.equal(empty.sourceRun, undefined); assert.equal(empty.budget.available, true); assert.equal(empty.budget.calls, 0);
  const id = randomUUID(); await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt) VALUES($1,$2,6,'cancelled','{}',1)", [id, project.id]);
  const cancelled = await inspect(project); assert.equal(cancelled.budget.available, true); assert.equal(cancelled.budget.calls, 0); assert.equal(cancelled.sourceRun?.integrity, 'missing');
  await pool.query('UPDATE project_runs SET started_at=now() WHERE id=$1', [id]);
  const missing = await inspect(project); assert.equal(missing.budget.available, false); assert.equal(missing.budget.calls, undefined);
});

test('malformed knowledge grant/citation metadata is explicitly unavailable rather than expanded or defaulted', { skip: !isolated }, async () => {
  const { project, archive } = await fixture(); archive.append('knowledge/citation', { sources: [{ documentId: 'private-doc', sha256: hash('private-v2') }] });
  const result = await inspect(project); assert.equal(result.available, true); assert.equal(result.knowledge.available, false);
  assert.deepEqual(result.knowledge.documents, []); assert.deepEqual(result.knowledge.authorizations, []);
  assert.ok(result.issues.some(issue => issue.code === 'KNOWLEDGE_HISTORY_UNAVAILABLE'));
});
