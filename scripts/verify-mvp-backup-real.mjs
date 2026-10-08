import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// This is a business-only API projection, not a full /backup/export backup.
// It never opens the source database, credentials, device grant or master key.
// Restoration is restricted to a fresh directory beneath this checkout's .data.
const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, data) => data && typeof data === 'object' && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))) : data);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const stopped = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const backupTables = ['gateways','departments','department_versions','models','projects','plan_versions','activity','usage','project_runs','templates','knowledge_spaces','knowledge_documents','knowledge_revisions','knowledge_chunks','product_settings','tool_approvals','organization_previews','model_reservations','knowledge_embeddings','model_capability_tests','manager_messages','mcp_connections','work_file_snapshots','automation_schedules','automation_occurrences','automation_notifications','automation_observations','automation_knowledge_candidates','automation_improvements','automation_evaluations','automation_reviews'];
const limitations = [
  'Business-only projection through existing read-only product APIs; not a full product /backup/export validation.',
  'Source master key and API credentials are never read or copied; credential migration is unverified.',
  'Device grants, model reservation leases/history, automation/manager-chat/MCP/work-file tables and external integrations are excluded.',
  'Knowledge revisions and citation reads are restored; original Vault files, live Vault paths and embeddings are excluded. Historical source metadata is retained.',
  'Cited knowledge-version line offsets are preserved from read-only citation APIs; uncited revisions use reconstructed body-relative coordinates.',
  'Department version data is verified; database-generated history timestamps are not asserted because restore triggers regenerate the current entry.',
  'Persistent isolated PGlite validates data restoration/reopen; independent PostgreSQL backend lock contention is not exercised.',
  'Capture includes the requested run, project-usage-linked runs and resumed ancestors; unbilled or orphan runs outside this chain are excluded.',
  'Run database lease/cancellation/error metadata and sequence numbers are reconstructed from the archived chain, not copied from the source database.',
  'Read-only API capture rechecks immutable run archives; it is not a transactional snapshot across every source API route.',
];

function inside(directory, target) {
  const path = relative(resolve(directory), resolve(target));
  assert.ok(path && !path.startsWith('..') && !isAbsolute(path), 'Destination must be a new child directory');
}
function assertNoCredentials(value, path = 'payload') {
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoCredentials(item, `${path}[${index}]`)); return; }
  if (value && typeof value === 'object') for (const [key, data] of Object.entries(value)) {
    if (/^(master|credential|api[_-]?key|authorization|password|secret|access[_-]?token)$/i.test(key))
      assert.ok(data === null || data === undefined || data === '' || data === '[REDACTED]', `Unexpected credential field at ${path}.${key}`);
    else assertNoCredentials(data, `${path}.${key}`);
  }
  else if (typeof value === 'string') assert.ok(!/\bsk-[A-Za-z0-9_-]{12,}|Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+\/-]+/i.test(value), `Credential-like content at ${path}`);
}
function safeSource(input) {
  const url = new URL(input);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash, 'Source must be an unauthenticated local product API URL');
  assert.ok(url.pathname.replace(/\/$/, '') === '/api', 'Source URL must end in /api');
  return url.href.replace(/\/$/, '');
}
function encryptBusinessBackup(payload, password) {
  assertNoCredentials(payload);
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(payload))), cipher.final()]);
  key.fill(0);
  return { format: 'agent-department-backup-v1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
async function get(base, path, binary = false) {
  let response;
  try { response = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch (error) { throw new Error(`Read-only API ${path} could not be read`, { cause: error }); }
  assert.equal(response.status, 200, `Read-only API ${path} failed (${response.status})`);
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}
function omit(value, keys) { return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))); }
function projectFields(project) { return Object.fromEntries(['id','departmentId','departmentVersion','departmentName','requirement','policy','plan','version','source','status','createdAt','planningCost'].map(key => [key, project[key]])); }

async function capture(source, runId, kind) {
  assert.ok(uuid.test(runId), 'A concrete run UUID is required');
  const [projects, departments, modelCatalog, gateways, usages, settings] = await Promise.all([
    get(source, '/projects'), get(source, '/departments'), get(source, '/models'), get(source, '/gateways'), get(source, '/usage'), get(source, '/settings'),
  ]);
  const first = await get(source, `/runs/${runId}/export`);
  assert.ok(stopped.has(first.status) && first.integrity === 'ok', 'Selected run must be stopped with an intact archive');
  const project = projects.find(item => item.id === first.snapshot.projectId);
  assert.ok(project, 'Project metadata is missing');
  assert.ok(!['QUEUED','RUNNING'].includes(project.status), 'Selected project must be stopped for a stable business projection');
  const projectUsage = usages.filter(item => item.projectId === project.id);
  const queue = [...new Set([runId, ...projectUsage.map(item => item.runId).filter(Boolean)])];
  const runs = new Map(), artifactRows = [], files = {}, citationReads = [];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]; if (runs.has(id)) continue;
    const run = id === runId ? first : await get(source, `/runs/${id}/export`);
    assert.equal(run.snapshot.projectId, project.id); assert.equal(run.integrity, 'ok'); assert.ok(stopped.has(run.status));
    const snapshot = Buffer.from(JSON.stringify(run.snapshot));
    const expectedSeal = run.events.find(event => event.type === 'run/created')?.data.snapshotSha256;
    assert.ok(expectedSeal && hash(snapshot) === expectedSeal, 'API snapshot reconstruction must match its original creation seal');
    files[`${id}/snapshot.json`] = snapshot.toString('base64');
    files[`${id}/events.jsonl`] = Buffer.from(run.events.map(event => JSON.stringify(event) + '\n').join('')).toString('base64');
    const artifacts = await get(source, `/runs/${id}/artifacts`);
    for (const artifact of artifacts) {
      const bytes = await get(source, `/runs/${id}/artifact?path=${encodeURIComponent(artifact.path)}`, true);
      assert.equal(bytes.length, artifact.size); assert.equal(hash(bytes), artifact.sha256);
      files[`${id}/artifacts/${artifact.path}`] = bytes.toString('base64');
      artifactRows.push({ runId: id, ...artifact });
    }
    for (const event of run.events.filter(event => event.type === 'knowledge/citation')) for (const citation of event.data.sources ?? []) {
      if (citationReads.some(item => item.runId === id && item.chunkId === citation.chunkId)) continue;
      citationReads.push({ runId: id, chunkId: citation.chunkId, data: await get(source, `/runs/${id}/citations/${encodeURIComponent(citation.chunkId)}`) });
    }
    const after = await get(source, `/runs/${id}/export`);
    assert.equal(hash(canonical(after)), hash(canonical(run)), 'Source run changed during the read-only capture');
    runs.set(id, run);
    if (run.snapshot.resumedFrom && !queue.includes(run.snapshot.resumedFrom)) queue.push(run.snapshot.resumedFrom);
  }
  const selectedRun = runs.get(runId);
  assert.ok(artifactRows.some(item => item.runId === runId), 'Selected run must have delivery files');
  const runValues = [...runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const departmentIds = new Set([project.departmentId, ...runValues.flatMap(run => run.snapshot.departmentIds ?? [run.snapshot.departmentId])]);
  const selectedDepartments = departments.filter(item => departmentIds.has(item.id));
  assert.equal(selectedDepartments.length, departmentIds.size, 'Referenced department metadata is missing');
  const [versions, departmentVersions] = await Promise.all([
    get(source, `/projects/${project.id}/versions`),
    Promise.all(selectedDepartments.map(async department => ({ id: department.id, versions: await get(source, `/departments/${department.id}/versions`) }))),
  ]);
  const modelIds = new Set([...projectUsage.map(item => item.modelId), ...versions.flatMap(item => item.plan.agents.flatMap(agent => [agent.modelId, agent.fallbackModelId].filter(Boolean)))]);
  const selectedModels = modelCatalog.filter(item => modelIds.has(item.id));
  assert.equal(selectedModels.length, modelIds.size, 'Referenced model metadata is missing from the public API');
  const gatewayIds = new Set(selectedModels.map(item => item.gatewayId));
  const selectedGateways = gateways.filter(item => gatewayIds.has(item.id));
  assert.equal(selectedGateways.length, gatewayIds.size);
  const approvals = (await Promise.all(runValues.map(run => get(source, `/approvals?runId=${run.id}`)))).flat();
  assert.ok(approvals.every(item => item.status !== 'pending'), 'Selected project has pending approvals');
  const knowledgeIds = new Set(runValues.flatMap(run => run.snapshot.knowledge?.documents?.map(item => item.documentId) ?? []));
  const knowledge = [];
  if (knowledgeIds.size) {
    const [documents, spaces] = await Promise.all([get(source, '/knowledge/documents'), get(source, '/knowledge/spaces')]);
    for (const id of knowledgeIds) {
      const document = documents.find(item => item.id === id); assert.ok(document, 'Referenced knowledge document metadata is missing');
      const space = spaces.find(item => item.id === document.spaceId); assert.ok(space);
      const revisions = await get(source, `/knowledge/documents/${id}/versions`);
      knowledge.push({ document, space, revisions });
    }
  }
  const tables = Object.fromEntries(backupTables.map(name => [name, []]));
  tables.gateways = selectedGateways.map(item => ({ id: item.id, data: omit(item, ['id','version','hasCredential']), credential: null, version: item.version }));
  tables.models = selectedModels.map(item => ({ id: item.id, data: omit(item, ['id','version','status','checkedAt','capabilities']), credential: null, version: item.version, status: item.status, checked_at: item.checkedAt ?? null, capabilities: item.capabilities ?? {} }));
  tables.departments = selectedDepartments.map(item => ({ id: item.id, data: omit(item, ['id','version','createdAt','updatedAt','runCount']), version: item.version, created_at: item.createdAt, updated_at: item.updatedAt }));
  tables.department_versions = departmentVersions.flatMap(item => item.versions.map(version => ({ department_id: item.id, version: version.version, data: version.data, created_at: version.createdAt })));
  tables.projects = [{ id: project.id, department_id: project.departmentId, department_version: project.departmentVersion, department_name: project.departmentName, requirement: project.requirement, policy: project.policy, plan: project.plan, version: project.version, status: project.status, source: project.source, created_at: project.createdAt }];
  tables.plan_versions = versions.map(item => ({ project_id: project.id, version: item.version, plan: item.plan, policy: item.policy, created_at: item.createdAt }));
  tables.project_runs = runValues.map((run, index) => ({ id: run.id, project_id: project.id, project_version: run.snapshot.projectVersion ?? run.snapshot.planVersion ?? project.version, status: run.status, snapshot: run.snapshot, created_at: run.createdAt, started_at: run.events.find(event => event.type === 'run/started')?.at ?? run.createdAt, finished_at: run.events.findLast(event => event.type === 'run/finished')?.at ?? null, parent_run_id: run.snapshot.resumedFrom ?? null, attempt: index + 1, cancel_requested: false, department_ids: run.snapshot.departmentIds ?? [run.snapshot.departmentId] }));
  tables.usage = projectUsage.map(item => ({ id: item.id, model_id: item.modelId, project_id: item.projectId, department_id: item.departmentId, run_id: item.runId, agent_id: item.agentId, employee_id: item.employeeId, session_id: item.sessionId, task_id: item.taskId, attempt_id: item.attemptId, request_id: item.requestId, duration_ms: item.durationMs, input_tokens: item.inputTokens, output_tokens: item.outputTokens, cost: item.cost, purpose: item.purpose, created_at: item.createdAt }));
  tables.tool_approvals = approvals.map(item => ({ id: item.id, run_id: item.runId, agent_id: item.agentId, tool: item.tool, arguments: item.arguments, status: item.status, created_at: item.createdAt }));
  tables.product_settings = [{ id: 1, version: settings.version, data: settings.data }];
  const { chunkDocument } = await import('../services/agent-runtime/knowledge.mjs');
  let citedKnowledgeVersions = 0, reconstructedKnowledgeVersions = 0;
  for (const item of knowledge) {
    if (!tables.knowledge_spaces.some(space => space.id === item.space.id)) tables.knowledge_spaces.push({ id: item.space.id, name: item.space.name, scope: item.space.scope, department_id: item.space.departmentId, agent_ids: item.space.agentIds, version: item.space.version });
    tables.knowledge_documents.push({ id: item.document.id, space_id: item.document.spaceId, title: item.document.title, version: item.document.version, created_at: item.document.createdAt });
    for (const revision of item.revisions) {
      assert.equal(hash(revision.content), revision.sha256);
      tables.knowledge_revisions.push({ document_id: item.document.id, version: revision.version, content: revision.content, sha256: revision.sha256, source: revision.source, created_at: revision.createdAt });
      const chunks = chunkDocument(item.document.id, revision.version, revision.content);
      const citations = citationReads.filter(citation => citation.data.documentId === item.document.id && citation.data.version === revision.version);
      const offsets = citations.map(citation => {
        const chunk = chunks.find(chunk => chunk.id === citation.chunkId); assert.ok(chunk, 'Cited chunk must reproduce from the exact stored revision');
        assert.equal(chunk.content, citation.data.content);
        const offset = citation.data.lineStart - chunk.lineStart;
        assert.ok(Number.isSafeInteger(offset) && offset >= 0 && citation.data.lineEnd - chunk.lineEnd === offset, 'Cited line coordinates must have one valid document offset');
        return offset;
      });
      assert.ok(new Set(offsets).size <= 1, 'A document version has inconsistent citation offsets');
      const offset = offsets[0] ?? 0;
      if (offsets.length) citedKnowledgeVersions++; else reconstructedKnowledgeVersions++;
      for (const chunk of chunks) tables.knowledge_chunks.push({ id: chunk.id, document_id: item.document.id, version: revision.version, line_start: chunk.lineStart + offset, line_end: chunk.lineEnd + offset, content: chunk.content, tokens: chunk.tokens });
    }
  }
  const payload = { version: 1, createdAt: new Date().toISOString(), tables, files, master: null, vaultFiles: {} };
  assertNoCredentials(payload);
  const expected = {
    kind, requestedRunId: runId, projectId: project.id, sourceUrl: source, project: projectFields(project),
    departmentVersions: departmentVersions.map(item => ({ id: item.id, versions: item.versions.map(version => ({ version: version.version, data: version.data })) })),
    planVersions: versions, settings, usage: projectUsage.map(item => omit(item, ['agentName'])),
    runs: runValues.map(run => ({ id: run.id, status: run.status, snapshotHash: hash(canonical(run.snapshot)), eventsHash: hash(canonical(run.events)), eventCount: run.eventCount, wireCalls: run.events.filter(event => event.type === 'model/wire-request').length })),
    artifacts: artifactRows, citations: citationReads,
    tableCounts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    archiveFileHashes: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(Buffer.from(value, 'base64'))])),
    snapshotSealVerified: true, sourceUnchangedDuringCapture: true,
    knowledgeLineCoordinates: { citedVersionsPreserved: citedKnowledgeVersions, uncitedVersionsBodyRelative: reconstructedKnowledgeVersions },
  };
  return { payload, expected, selectedRun };
}

async function verifyTarget(base, expected, targetDirectory) {
  const [projects, usages, settings, gateways, models] = await Promise.all([get(base, '/projects'), get(base, '/usage'), get(base, '/settings'), get(base, '/gateways'), get(base, '/models')]);
  assert.deepEqual(projects.map(projectFields), [expected.project]);
  assert.equal(hash(canonical(usages.map(item => omit(item, ['agentName'])).sort((a,b) => a.id.localeCompare(b.id)))), hash(canonical(expected.usage.slice().sort((a,b) => a.id.localeCompare(b.id)))));
  assert.deepEqual(settings, expected.settings); assert.ok(gateways.every(item => item.hasCredential === false));
  assert.equal(models.length, expected.tableCounts.models);
  assert.equal(existsSync(join(targetDirectory, 'credentials', 'credential.key')), false, 'No original or replacement master key may be restored');
  const planVersions = await get(base, `/projects/${expected.projectId}/versions`); assert.equal(hash(canonical(planVersions)), hash(canonical(expected.planVersions)));
  for (const department of expected.departmentVersions) {
    const actual = await get(base, `/departments/${department.id}/versions`);
    assert.equal(hash(canonical(actual.map(item => ({ version: item.version, data: item.data })))), hash(canonical(department.versions)));
  }
  for (const item of expected.runs) {
    const run = await get(base, `/runs/${item.id}/export`); assert.equal(run.integrity, 'ok'); assert.equal(run.status, item.status); assert.equal(run.eventCount, item.eventCount);
    assert.equal(hash(canonical(run.snapshot)), item.snapshotHash); assert.equal(hash(canonical(run.events)), item.eventsHash);
    assert.equal(run.events.filter(event => event.type === 'model/wire-request').length, item.wireCalls);
    const artifacts = await get(base, `/runs/${item.id}/artifacts`);
    assert.deepEqual(artifacts.slice().sort((a,b) => a.path.localeCompare(b.path)), expected.artifacts.filter(artifact => artifact.runId === item.id).map(artifact => omit(artifact, ['runId'])).sort((a,b) => a.path.localeCompare(b.path)));
  }
  for (const artifact of expected.artifacts) assert.equal(hash(await get(base, `/runs/${artifact.runId}/artifact?path=${encodeURIComponent(artifact.path)}`, true)), artifact.sha256);
  for (const citation of expected.citations) {
    const actual = await get(base, `/runs/${citation.runId}/citations/${encodeURIComponent(citation.chunkId)}`);
    const fields = [...new Set([...Object.keys(actual), ...Object.keys(citation.data)])];
    const differences = fields.filter(key => canonical(actual[key]) !== canonical(citation.data[key]));
    assert.equal(hash(canonical(actual)), hash(canonical(citation.data)), `Restored citation fields differ: ${differences.join(', ')}; lines ${actual.lineStart}:${actual.lineEnd} versus ${citation.data.lineStart}:${citation.data.lineEnd}`);
  }
  for (const [file, expectedHash] of Object.entries(expected.archiveFileHashes)) { const path = join(targetDirectory, 'runs', file); inside(join(targetDirectory, 'runs'), path); assert.equal(hash(await readFile(path)), expectedHash); }
  return { status: 'passed', restoredProjectId: expected.projectId, runIds: expected.runs.map(item => item.id), artifactCount: expected.artifacts.length, usageCount: expected.usage.length, knownCost: expected.usage.reduce((sum,item) => sum + item.cost, 0), wireCalls: expected.runs.reduce((sum,item) => sum + item.wireCalls, 0), citationsChecked: expected.citations.length, sourceMasterRead: false, sourceCredentialsCopied: false, restoredCredentialKeyPresent: false };
}

async function worker() {
  const directory = resolve(process.argv[3]); inside(join(root, '.data'), directory);
  assert.ok(process.connected && typeof process.send === 'function', 'Isolated workers must be started by this script over IPC');
  assert.equal(process.env.SIMULATED_INTEGRATION, 'pglite');
  assert.equal(resolve(process.env.DATA_DIR), join(directory, 'credentials'));
  assert.equal(resolve(process.env.TRACE_ROOT), join(directory, 'runs'));
  assert.equal(resolve(process.env.OBSIDIAN_VAULT), join(directory, 'vault'));
  assert.match(process.env.DATABASE_URL, /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
  const { pool, migrate } = await import('../apps/api/src/db.ts'); await migrate();
  assert.equal(pool.options.max, 1, 'Isolated PGlite workers require a single product connection');
  pool.on('error', error => { console.error(`Isolated pool error: ${error.code ?? error.name}`); });
  pool.on('connect', client => {
    const query = client.query.bind(client);
    client.query = (...arguments_) => {
      const result = query(...arguments_);
      return result?.catch ? result.catch(error => { console.error(`Isolated SQL failure: ${error.code ?? error.name}`); throw error; }) : result;
    };
  });
  const { createApp } = await import('../apps/api/src/app.ts');
  const app = createApp(); await app.locals.shutdown();
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  server.on('request', (req, res) => { res.once('finish', () => console.log(`HTTP ${req.method} ${new URL(req.url, 'http://local').pathname} ${res.statusCode}`)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); assert.equal(url.origin, new URL(base).origin, 'Fixture/restore workers cannot access external models'); return nativeFetch(input, options); };
  let runId;
  if (process.argv[4] === 'source-fixture') {
    const agent = { id: 'fixture-manager', name: '本地备份检查员', role: 'manager', modelId: 'fixture-model', instructions: '仅本地数据 fixture，不调用模型。', tools: ['knowledge_search','knowledge_read'] };
    const tasks = [{ id: 'prepare', subject: '本地资料检查', objective: 'Verify fixture data', assigneeId: agent.id, dependencies: [], acceptanceCriteria: ['Fixture retained'], estimatedInputTokens: 10, estimatedOutputTokens: 5 }, { id: 'inspect', subject: '本地结构检查', objective: 'Verify fixture DAG', assigneeId: agent.id, dependencies: ['prepare'], acceptanceCriteria: ['Fixture DAG retained'], estimatedInputTokens: 10, estimatedOutputTokens: 5 }];
    const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 300, allowedModelIds: ['fixture-model'], allowedTools: agent.tools, allowedDepartmentIds: ['fixture-department'], allowedKnowledgeSpaceIds: [] };
    await pool.query("INSERT INTO gateways(id,data) VALUES('fixture-gateway',$1)", [{ name: 'Not called fixture', baseUrl: 'http://127.0.0.1:1/v1' }]);
    await pool.query("INSERT INTO models(id,data,status) VALUES('fixture-model',$1,'available')", [{ name: 'Not called fixture', gatewayId: 'fixture-gateway', model: 'not-called', inputRate: 1, outputRate: 1 }]);
    await pool.query("INSERT INTO departments(id,data) VALUES('fixture-department',$1)", [{ name: 'Business backup fixture', description: 'No paid models', agents: [agent] }]);
    const post = async (path, method, body) => { const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok); return response.json(); };
    const space = await post('/knowledge/spaces', 'POST', { name: 'Business backup knowledge fixture', scope: 'company' });
    const document = await post('/knowledge/documents', 'POST', { spaceId: space.id, title: 'Pinned fixture version', content: 'Version one: business backup citation fixture.' });
    agent.knowledgeSpaceIds = [space.id]; policy.allowedKnowledgeSpaceIds = [space.id];
    await pool.query("UPDATE departments SET data=$1,version=version+1 WHERE id='fixture-department'", [{ name: 'Business backup fixture', description: 'No paid models', agents: [agent] }]);
    const { knowledgeSnapshot, queryKnowledge } = await import('../apps/api/src/knowledge-store.ts');
    const knowledge = await knowledgeSnapshot([agent], 'fixture-department');
    const citation = (await queryKnowledge(knowledge, agent.id, 'search', 'version'))[0];
    const snapshot = { projectId: 'fixture-project', projectVersion: 1, departmentId: 'fixture-department', departmentIds: ['fixture-department'], policy, agents: [agent], tasks: tasks.map(item => ({ ...item, assignee: item.assigneeId })), approvedTasks: tasks, knowledge, title: 'Business-only backup fixture; no model execution' };
    await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,status,source) VALUES('fixture-project','fixture-department',2,'Business backup fixture','Local data backup fixture, not Todo acceptance',$1,$2,'COMPLETED','manual')", [policy, { rationale: 'Data fixture only', agents: [agent], tasks }]);
    await pool.query("INSERT INTO plan_versions(project_id,version,plan,policy) VALUES('fixture-project',1,$1,$2)", [{ rationale: 'Data fixture only', agents: [agent], tasks }, policy]);
    const { createRunArchive } = await import('../services/agent-runtime/trace-store.mjs');
    runId = randomUUID(); const archive = createRunArchive(process.env.TRACE_ROOT, snapshot, { id: runId });
    archive.append('model/wire-request', { fixture: true, taskId: 'prepare' });
    archive.append('knowledge/citation', { agentId: agent.id, sources: [{ documentId: citation.documentId, version: citation.version, chunkId: citation.id, sha256: citation.sha256 }] }, { taskId: 'prepare' });
    archive.append('run/finished', { status: 'completed', fixture: true });
    await mkdir(join(archive.dir, 'artifacts', 'nested'), { recursive: true }); await writeFile(join(archive.dir, 'artifacts', 'nested', 'fixture.txt'), 'Synthetic local backup fixture; not employee Todo delivery.\n');
    await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,'fixture-project',1,'completed',$2)", [runId, snapshot]);
    await pool.query("INSERT INTO usage(id,model_id,project_id,department_id,run_id,agent_id,task_id,input_tokens,output_tokens,cost,purpose) VALUES('fixture-usage','fixture-model','fixture-project','fixture-department',$1,'fixture-manager','prepare',10,5,.002,'synthetic-data-fixture')", [runId]);
    await post(`/knowledge/documents/${document.id}`, 'PUT', { spaceId: space.id, title: 'Current fixture version two', content: 'Version two must not replace pinned version one.', version: 1 });
  }
  process.send?.({ type: 'ready', base, runId });
  let closing;
  const close = () => closing ??= (async () => { server.closeAllConnections(); await new Promise(accept => server.close(accept)); await pool.end(); })();
  process.once('message', async value => { if (value === 'stop') { await close(); process.exit(0); } });
  process.once('disconnect', async () => { await close(); process.exit(0); });
}

async function openIsolated(directory, phase) {
  inside(join(root, '.data'), directory); await mkdir(directory, { recursive: true });
  const { PGlite } = await import('@electric-sql/pglite'); const { vector } = await import('@electric-sql/pglite-pgvector'); const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const db = await PGlite.create({ dataDir: join(directory, 'database'), extensions: { vector } });
  const socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 4 }); let port;
  socket.addEventListener('listening', event => { port = event.detail.port; }); await socket.start();
  const child = spawn(process.execPath, ['--import','tsx','--import','./scripts/test-support/pglite-pool.mjs',script,'--worker',directory,phase], { cwd: root, env: { ...process.env, SIMULATED_INTEGRATION: 'pglite', DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, DATA_DIR: join(directory,'credentials'), TRACE_ROOT: join(directory,'runs'), OBSIDIAN_VAULT: join(directory,'vault') }, stdio: ['ignore','pipe','pipe','ipc'], windowsHide: true });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const exited = new Promise(accept => child.once('exit', accept));
  try {
    const ready = await Promise.race([new Promise(accept => child.on('message', value => { if (value?.type === 'ready') accept(value); })), new Promise((_accept,reject) => child.once('error', reject)), exited.then(code => { throw Error(`Isolated worker exited before ready (${code})`); }), new Promise((_accept,reject) => { const timer = setTimeout(() => reject(Error('Isolated worker start timed out')), 45000); timer.unref(); })]);
    return { ...ready, async close() { if (child.connected) child.send('stop'); await exited; await writeFile(join(dirname(directory),`${phase}.log`), output); await socket.stop(); await db.close(); } };
  } catch (error) { child.kill(); await exited; await writeFile(join(dirname(directory),`${phase}.log`), output); await socket.stop(); await db.close(); throw error; }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--help')) { console.log('Safe fixture: node scripts/verify-mvp-backup-real.mjs --fixture\nReal stopped run (read-only source API): node scripts/verify-mvp-backup-real.mjs --source=http://127.0.0.1:4310/api --run-id=<UUID>\nAll restores use new workspace .data directories; credentials/master are excluded.'); return; }
  const sourceArgument = arguments_.find(value => value.startsWith('--source='));
  assert.ok(arguments_.every(value => value === '--fixture' || value.startsWith('--source=') || value.startsWith('--run-id=')), 'Unknown argument');
  assert.ok(!(sourceArgument && arguments_.includes('--fixture')), 'Fixture and actual source modes are exclusive');
  const kind = sourceArgument ? 'real-business-only-backup-validation' : 'fixture-business-only-backup-validation';
  const dataRoot = join(root, '.data'); await mkdir(dataRoot, { recursive: true }); const directory = await mkdtemp(join(dataRoot, 'mvp-business-backup-')); inside(dataRoot, directory);
  const startedAt = new Date().toISOString(); const sourceDirectory = join(directory, 'source'), targetDirectory = join(directory, 'target');
  let fixture;
  try {
    let source, runId;
    if (sourceArgument) { source = safeSource(sourceArgument.slice('--source='.length)); runId = arguments_.find(value => value.startsWith('--run-id='))?.slice('--run-id='.length); assert.ok(runId, 'Real capture requires a run ID'); }
    else { fixture = await openIsolated(sourceDirectory, 'source-fixture'); source = fixture.base; runId = fixture.runId; }
    const captured = await capture(source, runId, kind);
    const passphrase = randomBytes(24).toString('hex'); const backup = encryptBusinessBackup(captured.payload, passphrase);
    await writeFile(join(directory,'business-backup.json'), JSON.stringify(backup), { mode: 0o600 });
    await writeFile(join(directory,'business-backup.password'), passphrase + '\n', { mode: 0o600 });
    await writeFile(join(directory,'capture-summary.json'), JSON.stringify(omit(captured.expected,['project','departmentVersions','planVersions','settings','usage','citations']), null, 2));
    if (fixture) { await fixture.close(); fixture = undefined; }
    const phases = [];
    for (const phase of ['restore','reopen']) {
      const target = await openIsolated(targetDirectory, phase);
      try {
        assert.notEqual(new URL(target.base).origin, new URL(source).origin, 'Restore cannot target the source service');
        if (phase === 'restore') {
          assert.equal((await get(target.base,'/projects')).length,0);
          const post = (password) => fetch(target.base + '/backup/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, backup, confirmation: 'RESTORE' }), redirect: 'error', signal: AbortSignal.timeout(30000) });
          const wrong = await post('incorrect-backup-password'); await wrong.arrayBuffer(); assert.equal(wrong.status,422); assert.equal((await get(target.base,'/projects')).length,0);
          const response = await post(passphrase); const restoreResult = await response.json(); assert.equal(response.status,200, `Isolated product backup restore failed: ${restoreResult.code ?? response.status}: ${restoreResult.message ?? ''}`);
        }
        const result = { phase, ...await verifyTarget(target.base,captured.expected,targetDirectory) }; phases.push(result);
        await writeFile(join(directory,`${phase}.json`),JSON.stringify(result,null,2));
      } finally { await target.close(); }
    }
    const report = { kind,status:'passed',startedAt,finishedAt:new Date().toISOString(),command:process.argv.slice(1).join(' '),directory,sourceUrl:source,requestedRunId:runId,projectId:captured.expected.projectId,sourceDatabaseOpened:false,sourceMasterRead:false,sourceCredentialsCopied:false,modelHttpCalls:0,backupKind:'business-only API projection',credentialMigration:'unverified/excluded',encryptedBackupPath:join(directory,'business-backup.json'),backupPasswordPath:join(directory,'business-backup.password'),restoredRunDirectory:join(targetDirectory,'runs',runId),artifacts:captured.expected.artifacts,archiveFileHashes:captured.expected.archiveFileHashes,tableCounts:captured.expected.tableCounts,limitations,phases };
    const evidence = join(root,'docs','test-evidence',kind === 'real-business-only-backup-validation' ? `mvp-backup-real-${new Date().toISOString().slice(0,10)}-${runId.slice(0,8)}.json` : `mvp-backup-fixture-${new Date().toISOString().slice(0,10)}.json`);
    await mkdir(dirname(evidence), { recursive:true }); await writeFile(evidence,JSON.stringify(report,null,2)+'\n');
    console.log(`PASS ${kind}: ${evidence}; restored ${captured.expected.artifacts.length} files; isolated target ${targetDirectory}`);
  } finally { if (fixture) await fixture.close(); }
}

if (process.argv[2] === '--worker') await worker(); else await main();
