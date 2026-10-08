import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type pg from 'pg';
import { taskSchema } from '../../../packages/contracts/index.ts';
import { readRun } from '../../../services/agent-runtime/trace-store.mjs';
import { inspectArtifact } from '../../../services/agent-runtime/handoff.mjs';
import { unresolvedOperations } from '../../../services/agent-runtime/recovery.mjs';
import { completedTasks, resumeHandoff } from './handoff-checkpoints.ts';
import { durableCallHistory } from './budget-history.ts';

type Database = Pick<pg.PoolClient, 'query'>;
type ProjectRow = { id: string; version: number; requirement: string; plan: { tasks: any[]; agents: any[] }; policy?: unknown };
type Issue = { code: string; message: string };
type FileSeal = { path: string; size: number; sha256: string; state: 'accepted' | 'fixed_input' | 'unverified'; inputTaskIds: string[]; producerTaskId?: string };
type KnowledgeReference = { documentId: string; version: number; sha256: string; title?: string; spaceId?: string;
  sourceSha256?: string; source?: { type?: string; runId?: string; inputId?: string } };
export type PlanningExecutionContext = {
  available: boolean;
  sourceRun?: { id: string; projectVersion: number; status: string; integrity: string; currentVersion: boolean; currentPlanMatches?: boolean; archiveStatus?: string };
  completedTaskIds: string[];
  files: FileSeal[];
  budget: { available: boolean; projectVersion: number; calls?: number; callsBasis?: string; tasks?: Record<string, { cost: number; calls: number; reserved?: number }>;
    reserved?: number; unattributedReserved?: number; unattributedCalls?: number };
  unknownOperationIds: string[];
  knowledge: { available: boolean; documents: KnowledgeReference[];
    citations: (KnowledgeReference & { taskId?: string; agentId?: string; chunkId?: string; lineStart?: number; lineEnd?: number })[];
    authorizations: { agentId: string; employeeId?: string; sourceAgentId?: string; sourceDepartmentId?: string; knowledgeSpaceIds: string[]; documentIds: string[] }[] };
  issues: Issue[];
  rules: string[];
};

const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: any): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const statuses = new Set(['queued', 'running', 'failed', 'completed', 'cancelled', 'interrupted', 'unfinished', 'incomplete']);
const status = (value: any) => statuses.has(value) ? value : 'unknown';
// Every saved contract field participates, including newly added explicit output
// limits. Runtime taskPrompt/assignee are generated fields, not saved contracts.
const fields = Object.keys(taskSchema.shape).filter(key => key !== 'assigneeId');
function contract(task: any, agents: any[]) {
  return { ...Object.fromEntries(fields.filter(key => task[key] !== undefined).map(key => [key, task[key]])),
    assigneeId: task.assigneeId ?? agents.find(agent => agent.id === task.assignee)?.employeeId ?? task.assignee };
}
function number(value: any) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw Error('Invalid recorded amount');
  return parsed;
}
function reference(value: any): KnowledgeReference {
  if (!object(value) || !identifier(value.documentId) || !Number.isSafeInteger(value.version) || value.version < 1 ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) throw Error('Invalid fixed reference');
  for (const key of ['title', 'spaceId']) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 1000)) throw Error('Invalid reference metadata');
  if (value.source !== undefined && !object(value.source)) throw Error('Invalid source metadata');
  const source = value.source;
  // Free-form notes, credentials and arbitrary source properties remain in the
  // original manifest. Its full fingerprint preserves distinct provenance.
  return { documentId: value.documentId, version: value.version, sha256: value.sha256,
    ...(value.title !== undefined ? { title: value.title } : {}), ...(value.spaceId !== undefined ? { spaceId: value.spaceId } : {}),
    ...(source ? { sourceSha256: fingerprint(source), source: Object.fromEntries(['type', 'runId', 'inputId'].filter(key => identifier(source[key])).map(key => [key, source[key]])) } : {}) };
}

/** Planning evidence only: no provider, receipt, reservation, archive or DB writes.
 * Call inside the caller's read-only transaction for a consistent ledger view.
 * A candidate plan must still be confirmed and pass the separate execution gates.
 */
export async function buildPlanningExecutionContext(db: Database, traceRoot: string, project: ProjectRow): Promise<PlanningExecutionContext> {
  const result: PlanningExecutionContext = { available: false, completedTaskIds: [], files: [],
    budget: { available: false, projectVersion: project.version }, unknownOperationIds: [],
    knowledge: { available: false, documents: [], citations: [], authorizations: [] }, issues: [], rules: [
      '历史完成、交接与文件版本仅作为候选规划依据，不自动继承或批准执行。',
      '不得因文件存在就标记完成；旧版本完成节点不能冒充当前方案的完成节点。',
      '保留原费用、未知预留、工具和知识授权；新候选仍需用户确认及独立恢复/执行校验。',
      '调用次数来自持久化登记与实际 wire 档案，每个运行保守取较大值；未归属的费用和调用不得凭猜测分摊或视为零。',
    ] };
  const issue = (code: string, message: string) => result.issues.push({ code, message });
  const cache = new Map<string, any>();
  const archiveFor = (row: any) => {
    if (cache.has(row.id)) return cache.get(row.id);
    const failure = (integrity: string) => Object.assign(Error('Invalid project archive'), { integrity });
    let archive: any;
    try { archive = readRun(traceRoot, row.id); } catch { throw failure('invalid'); }
    if (!archive) throw failure('missing');
    if (archive.integrity !== 'ok') throw failure(archive.integrity);
    if (archive.id !== row.id || archive.snapshot.projectId !== project.id || archive.snapshot.planVersion !== row.project_version || row.project_id !== project.id) throw failure('identity_mismatch');
    cache.set(row.id, archive); return archive;
  };

  let latest: any;
  try { latest = (await db.query('SELECT id,project_id,project_version,status,started_at FROM project_runs WHERE project_id=$1 ORDER BY created_at DESC,attempt DESC,id DESC LIMIT 1', [project.id])).rows[0]; }
  catch { issue('PLANNING_HISTORY_UNAVAILABLE', '无法只读核对历史运行；不推断没有执行记录。'); return result; }

  // Share recovery's current-version admission/wire counts without adding
  // inherited budgetHistory again. Amount and hold queries remain unchanged.
  try {
    const history = await durableCallHistory(db, traceRoot, project.id, project.version), calls = history.calls;
    const tasks = new Map<string, { cost: number; calls: number; reserved?: number }>(Object.entries(history.tasks).map(([id, calls]) => [id, { cost: 0, calls }]));
    const task = (id: any) => { if (!identifier(id)) throw Error('Invalid task attribution'); if (!tasks.has(id)) tasks.set(id, { cost: 0, calls: 0 }); return tasks.get(id)!; };
    const costs = (await db.query(`SELECT u.task_id,sum(u.cost) AS cost,bool_and(u.project_id IS NOT DISTINCT FROM r.project_id) AS ownership_matches FROM usage u JOIN project_runs r ON r.id=u.run_id
      WHERE r.project_id=$1 AND r.project_version=$2 AND u.task_id IS NOT NULL GROUP BY u.task_id`, [project.id, project.version])).rows;
    for (const row of costs) { if (row.ownership_matches !== true) throw Error('Invalid cost owner'); task(row.task_id).cost = number(row.cost); }
    const holds = (await db.query(`SELECT c.context->>'taskId' AS task_id,sum(c.amount) AS amount,bool_and(c.project_id IS NOT DISTINCT FROM r.project_id) AS ownership_matches FROM model_reservations c JOIN project_runs r ON r.id=c.run_id
      WHERE r.project_id=$1 AND r.project_version=$2 AND c.status IN ('pending','uncertain') GROUP BY c.context->>'taskId'`, [project.id, project.version])).rows;
    let reserved = 0, unattributedReserved = 0;
    for (const row of holds) { if (row.ownership_matches !== true) throw Error('Invalid reservation owner'); const amount = number(row.amount); reserved += amount; if (row.task_id == null) unattributedReserved += amount; else task(row.task_id).reserved = amount; }
    result.budget = { available: true, projectVersion: project.version, calls, callsBasis: history.callsBasis, tasks: Object.fromEntries(tasks), reserved, unattributedReserved,
      unattributedCalls: calls - [...tasks.values()].reduce((sum, entry) => sum + entry.calls, 0) };
  } catch { issue('BUDGET_HISTORY_UNAVAILABLE', '当前版本的档案或费用归属无法完整核对；不重置次数或金额。'); }

  if (!latest) { issue('NO_RUN_HISTORY', '项目还没有运行档案；不能声明已有完成节点。'); return result; }
  result.sourceRun = { id: latest.id, projectVersion: latest.project_version, status: status(latest.status), integrity: 'unavailable', currentVersion: latest.project_version === project.version };
  let archive: any;
  try { archive = archiveFor(latest); }
  catch (error) { result.sourceRun.integrity = (error as any)?.integrity ?? 'invalid'; issue('PLANNING_ARCHIVE_UNAVAILABLE', '最近运行档案缺失、不完整或不属于此项目；已有成果不会被推定为完成。'); return result; }
  result.sourceRun.integrity = archive.integrity; result.sourceRun.archiveStatus = status(archive.status); result.available = true;
  const snapshot = archive.snapshot, root = join(traceRoot, latest.id, 'artifacts');
  const taskShape = (entry: any) => object(entry) && identifier(entry.id) && ['inputs', 'outputs', 'dependencies'].every(key => entry[key] === undefined || Array.isArray(entry[key])) &&
    [...(entry.inputs ?? []), ...(entry.outputs ?? [])].every(file => object(file) && identifier(file.path));
  if (!Array.isArray(snapshot.tasks) || !snapshot.tasks.every(taskShape) || !Array.isArray(snapshot.agents) || snapshot.agents.some((entry: any) => !object(entry) || !identifier(entry.id)) ||
      (snapshot.approvedTasks !== undefined && (!Array.isArray(snapshot.approvedTasks) || !snapshot.approvedTasks.every(taskShape)))) {
    result.available = false; issue('PLANNING_ARCHIVE_UNAVAILABLE', '最近运行的任务合同结构不完整；不能推定已有节点通过。'); return result;
  }
  const currentPlanMatches = snapshot.requirement === project.requirement && fingerprint((snapshot.approvedTasks ?? snapshot.tasks).map((entry: any) => contract(entry, snapshot.agents ?? []))) ===
    fingerprint(project.plan.tasks.map(entry => contract(entry, project.plan.agents)));
  result.sourceRun.currentPlanMatches = currentPlanMatches;
  if (!result.sourceRun.currentVersion) issue('HISTORICAL_PLAN_VERSION', '最近运行属于旧方案版本；其完成节点不作为当前版本完成状态。');
  else if (!currentPlanMatches) issue('PLANNING_CONTRACT_CHANGED', '当前需求或完整任务合同与最近运行不同；不自动复用完成状态。');

  let checkpoints: any[] = [];
  try {
    const done = completedTasks(archive.events, snapshot);
    checkpoints = resumeHandoff(snapshot, archive.events, done, root);
    if (result.sourceRun.currentVersion && currentPlanMatches) result.completedTaskIds = [...done.keys()];
  } catch { issue('CHECKPOINT_UNVERIFIED', '完成节点、验收记录或实际输入文件版本未通过宿主核对；不声明可跳过。'); }
  const declared = new Map<string, any>();
  for (const entry of snapshot.tasks) for (const file of entry.inputs ?? []) if (!declared.has(file.path)) declared.set(file.path, file);
  for (const record of checkpoints) for (const file of record.outputs ?? []) if (!declared.has(file.path)) declared.set(file.path, file);
  for (const declaration of declared.values()) {
    try {
      const seal = inspectArtifact(root, { path: declaration.path });
      const producer = [...checkpoints].reverse().find(record => record.outputs?.some((file: any) => file.path === seal.path && file.sha256 === seal.sha256));
      const fixed = (snapshot.tasks ?? []).some((entry: any) => entry.inputs?.some((file: any) => !file.producerTaskId && file.path === seal.path && file.sha256 === seal.sha256));
      result.files.push({ ...seal, state: producer ? 'accepted' : fixed ? 'fixed_input' : 'unverified',
        ...(producer ? { producerTaskId: producer.taskId } : {}), inputTaskIds: (snapshot.tasks ?? []).filter((entry: any) => entry.inputs?.some((file: any) => file.path === seal.path)).map((entry: any) => entry.id) });
    } catch { issue('PLANNING_FILE_UNAVAILABLE', '一份声明文件不能核对其实际版本；不会把声明 SHA 当实际文件 SHA。'); }
  }
  try { result.unknownOperationIds = unresolvedOperations(archive.events).map((operation: any) => { if (!identifier(operation.callId)) throw Error('Invalid operation id'); return operation.callId; }); }
  catch { result.available = false; issue('OPERATION_HISTORY_UNAVAILABLE', '无法完整核对结果未知的外部操作；不能按没有未知操作处理。'); }

  try {
    const manifest = snapshot.knowledge;
    if (manifest?.format !== 'document-versions-v2' || !Array.isArray(manifest.documents) || !object(manifest.agentDocuments)) throw Error('Unsupported manifest');
    const documents = new Map<string, KnowledgeReference>(), citations = new Map<string, PlanningExecutionContext['knowledge']['citations'][number]>();
    for (const value of manifest.documents) { const metadata = reference(value); documents.set(fingerprint(metadata), metadata); }
    for (const [agentId, ids] of Object.entries(manifest.agentDocuments)) {
      const agent = (snapshot.agents ?? []).find((entry: any) => entry.id === agentId);
      if (!agent || !Array.isArray(ids) || ids.some(id => !identifier(id)) || !Array.isArray(agent.knowledgeSpaceIds ?? []) ||
          (agent.knowledgeSpaceIds ?? []).some((id: any) => !identifier(id))) throw Error('Unbound knowledge authorization');
      result.knowledge.authorizations.push({ agentId, ...(identifier(agent.employeeId) ? { employeeId: agent.employeeId } : {}),
        ...(identifier(agent.sourceAgentId) ? { sourceAgentId: agent.sourceAgentId } : {}),
        ...(identifier(agent.sourceDepartmentId ?? snapshot.departmentId) ? { sourceDepartmentId: agent.sourceDepartmentId ?? snapshot.departmentId } : {}),
        knowledgeSpaceIds: [...(agent.knowledgeSpaceIds ?? [])], documentIds: [...ids] });
    }
    const addCitation = (value: any, links: { taskId?: string; agentId?: string } = {}) => {
      if (value.chunkId !== undefined && !identifier(value.chunkId)) throw Error('Invalid citation chunk');
      for (const key of ['lineStart', 'lineEnd']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1)) throw Error('Invalid citation location');
      const metadata = { ...reference(value), ...links, ...Object.fromEntries(['chunkId', 'lineStart', 'lineEnd'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) };
      citations.set(fingerprint(metadata), metadata);
    };
    for (const event of archive.events.filter((entry: any) => entry.type === 'knowledge/citation')) for (const value of event.data.sources ?? [])
      addCitation(value, { ...(identifier(event.data.taskId ?? event.taskId) ? { taskId: event.data.taskId ?? event.taskId } : {}), ...(identifier(event.data.agentId) ? { agentId: event.data.agentId } : {}) });
    for (const [taskId, node] of Object.entries(snapshot.recovery?.nodes ?? {})) for (const value of (node as any).citations ?? []) addCitation(value, { taskId });
    // Temporary inputs have their own fixed origin and employee recipients.
    for (const input of manifest.runInputs ?? []) {
      for (const value of input.chunks ?? []) { const metadata = reference(value); documents.set(fingerprint(metadata), metadata); }
      for (const agentId of input.agentIds ?? []) { const grant = result.knowledge.authorizations.find(entry => entry.agentId === agentId); if (!grant) throw Error('Unbound input recipient'); if (!grant.documentIds.includes(input.documentId)) grant.documentIds.push(input.documentId); }
    }
    result.knowledge.documents = [...documents.values()]; result.knowledge.citations = [...citations.values()]; result.knowledge.available = true;
  } catch { result.knowledge = { available: false, documents: [], citations: [], authorizations: [] }; issue('KNOWLEDGE_HISTORY_UNAVAILABLE', '固定资料版本或授权来源不完整；不会改用当前资料或省掉不同来源。'); }
  return result;
}
