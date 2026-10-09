import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from './provider.ts';
import { OpenRigBridge, OpenRigBridgeError, type OpenRigProjectReceipt, type OpenRigProjectView } from './openrig-bridge.ts';

type Database = { query: (sql: string, parameters?: any[]) => Promise<{ rows: any[] }> };
const employeeId = z.string().min(1).max(180).regex(/^[^\x00-\x1f\x7f]+$/);
const bindingSchema = z.object({
  departmentId: z.string().uuid(), rigId: z.string().min(1).max(100), rigName: z.string().min(1).max(63),
  seats: z.array(z.object({employeeId, logicalId: z.string().min(1).max(83), nodeId: z.string().min(1).max(100), role: z.string().min(1).max(100)}).strict()).min(1).max(32),
  sourceEmployeeId: employeeId, destinationEmployeeId: employeeId,
}).strict().superRefine((binding, ctx) => {
  if (new Set(binding.seats.map(seat => seat.employeeId)).size !== binding.seats.length ||
      !binding.seats.some(seat => seat.employeeId === binding.sourceEmployeeId) ||
      !binding.seats.some(seat => seat.employeeId === binding.destinationEmployeeId)) ctx.addIssue({code: 'custom', message: 'Invalid employee binding'});
});
const configSchema = z.object({
  schema: z.literal(1), enabled: z.literal(true),
  bridge: z.object({version: z.literal('0.6.6'), endpoint: z.string(), expectedSelfHostId: z.string(), tokenFile: z.string(), stateDirectory: z.string()}).strict(),
  departments: z.array(bindingSchema).max(100),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.departments.map(item => item.departmentId)).size !== config.departments.length) ctx.addIssue({code: 'custom', message: 'Duplicate department'});
});
type Binding = z.infer<typeof bindingSchema>;
type Loaded = {enabled: boolean; bridge?: OpenRigBridge; departments: Binding[]; invalid?: boolean};
export type OpenRigPublicStatus = 'disabled' | 'not_bound' | 'not_synced' | 'synced' | 'unknown' | 'unavailable';
export type OpenRigProjectStatus = {projectId: string; enabled: boolean; status: OpenRigPublicStatus; queueItemId: string | null; queueState: string | null; acceptanceAuthority: 'weiwu'; notSubmitted?: true; error?: {code: string; message: string}};

// Explicit, private, startup-only configuration. Broken optional configuration
// disables this integration, never application startup or the existing runner.
function loadConfig(file: string | undefined, request: typeof fetch): Loaded {
  if (!file) return {enabled: false, departments: []};
  try {
    if (!path.isAbsolute(file)) throw Error('absolute configuration path required');
    const absolute = path.resolve(file); let at = path.parse(absolute).root;
    for (const part of absolute.slice(at.length).split(path.sep).filter(Boolean)) {
      at = path.join(at, part); const stat = fs.lstatSync(at);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw Error('linked configuration');
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 128 * 1024 || fs.realpathSync(absolute) !== absolute) throw Error('invalid configuration file');
    const raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    if (raw?.schema === 1 && raw?.enabled === false) return {enabled: false, departments: []};
    const config = configSchema.parse(raw);
    return {enabled: true, departments: config.departments, bridge: new OpenRigBridge({...config.bridge, enabled: true}, request)};
  } catch {return {enabled: true, invalid: true, departments: []};}
}

const messages: Record<string, string> = {
  OPENRIG_CONFIG_INVALID: 'OpenRig 私有配置不可用，请检查服务配置。原项目仍可在为伍执行。',
  OPENRIG_OUTCOME_UNKNOWN: '同步结果待核对。请查询原工作项，不要重复创建。',
  OPENRIG_MAPPING_CHANGED: 'OpenRig 部门或岗位绑定已变化，请先核对配置。',
  OPENRIG_IDENTITY_MISMATCH: 'OpenRig 实例身份或版本不匹配，已停止同步。',
  OPENRIG_RUNTIME_ACTIVE: 'OpenRig 部门存在独立运行会话，已阻止重复执行。',
  OPENRIG_PAYLOAD_MISMATCH: 'OpenRig 工作项与原项目映射不一致，请核对原记录。',
  OPENRIG_EMPLOYEE_UNBOUND: '配置岗位与该项目、部门的真实员工不一致。',
  OPENRIG_STATE_INVALID: 'OpenRig 本地映射无法核对，请保留原记录并检查。',
  OPENRIG_UNAVAILABLE: '暂时无法核对 OpenRig。原项目仍可在为伍执行。',
};
function publicError(error: unknown) {
  const code = error instanceof OpenRigBridgeError && messages[error.code] ? error.code : 'OPENRIG_UNAVAILABLE';
  return {code, message: messages[code]};
}
function status(projectId: string, enabled: boolean, value: OpenRigPublicStatus, receipt?: OpenRigProjectReceipt | null): OpenRigProjectStatus {
  return {projectId, enabled, status: value, queueItemId: receipt?.qitemId ?? null, queueState: null, acceptanceAuthority: 'weiwu'};
}
function verified(projectId: string, view: OpenRigProjectView): OpenRigProjectStatus {
  return {...status(projectId, true, view.receipt.outcome === 'confirmed' ? 'synced' : 'unknown', view.receipt), queueState: view.queueItem?.state ?? null,
    ...(view.receipt.outcome === 'confirmed' ? {} : {error: {code: 'OPENRIG_OUTCOME_UNKNOWN', message: messages.OPENRIG_OUTCOME_UNKNOWN}})};
}
function failure(projectId: string, bridge: OpenRigBridge | undefined, error: unknown): OpenRigProjectStatus {
  let receipt: OpenRigProjectReceipt | null = null;
  try {receipt = bridge?.peekProject(projectId) ?? null;} catch { /* Never leak a corrupt file or token path. */ }
  const unknown = receipt && receipt.outcome !== 'confirmed';
  return {...status(projectId, true, unknown ? 'unknown' : 'unavailable', receipt), error: publicError(error)};
}

export function openRigRouter(db: Database, options: {configFile?: string; request?: typeof fetch} = {}) {
  const router = Router();
  const config = loadConfig(options.configFile ?? process.env.WEIWU_OPENRIG_CONFIG, options.request ?? fetch);
  const global = () => ({enabled: config.enabled, status: !config.enabled ? 'disabled' : config.invalid ? 'unavailable' : 'ready', acceptanceAuthority: 'weiwu' as const,
    ...(config.invalid ? {error: {code: 'OPENRIG_CONFIG_INVALID', message: messages.OPENRIG_CONFIG_INVALID}} : {})});
  const department = (id: string) => config.departments.find(binding => binding.departmentId === id);
  const peek = (project: {id: string; department_id: string}): OpenRigProjectStatus => {
    if (!config.enabled) return status(project.id, false, 'disabled');
    if (config.invalid) return {...status(project.id, true, 'unavailable'), error: {code: 'OPENRIG_CONFIG_INVALID', message: messages.OPENRIG_CONFIG_INVALID}};
    try {
      const receipt = config.bridge!.peekProject(project.id);
      if (receipt && receipt.departmentId !== project.department_id) throw new OpenRigBridgeError('OPENRIG_MAPPING_CHANGED', 'Project department changed');
      return status(project.id, true, receipt ? receipt.outcome === 'confirmed' ? 'synced' : 'unknown' : department(project.department_id) ? 'not_synced' : 'not_bound', receipt);
    } catch (error) {return failure(project.id, config.bridge, error);}
  };
  async function project(id: string) {
    const {rows} = await db.query(`SELECT p.id,p.department_id,p.requirement,p.version,p.plan,p.department_name,d.data AS department
      FROM projects p JOIN departments d ON d.id=p.department_id WHERE p.id=$1 AND d.deleted_at IS NULL`, [id]);
    if (!rows[0]) throw new AppError(404, '项目不存在或所属部门已归档。');
    return rows[0];
  }
  async function reconcile(row: {id: string; department_id: string}) {
    const current = peek(row);
    // No receipt: GET must not create either a mapping or a remote work item.
    if (!current.queueItemId || current.status === 'unavailable') return current;
    try {return verified(row.id, await config.bridge!.reconcileProject(row.id));}
    catch (error) {return failure(row.id, config.bridge, error);}
  }
  router.get('/openrig/status', (_req, res) => res.json(global()));
  router.get('/openrig/projects', async (req, res) => {
    const query = z.object({departmentId: z.string().min(1).max(100), projectIds: z.string().min(1).max(10100)}).strict().safeParse(req.query);
    if (!query.success) throw new AppError(422, '请提供部门和最多 100 个项目 ID。');
    const ids = query.data.projectIds.split(',');
    if (ids.length > 100 || ids.some(id => !id || id.length > 100)) throw new AppError(422, '每次最多查询 100 个有效项目 ID。');
    const exists = await db.query('SELECT id FROM departments WHERE id=$1 AND deleted_at IS NULL', [query.data.departmentId]);
    if (!exists.rows.length) throw new AppError(404, '部门不存在或已归档。');
    const {rows} = await db.query('SELECT id,department_id FROM projects WHERE department_id=$1 AND id=ANY($2::text[]) ORDER BY id', [query.data.departmentId, [...new Set(ids)]]);
    res.json({...global(), items: rows.map(peek)});
  });
  router.get('/projects/:id/openrig', async (req, res) => res.json(await reconcile(await project(req.params.id))));
  router.post('/projects/:id/openrig/sync', async (req, res) => {
    const parsed = z.object({version: z.number().int().positive()}).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError(422, '同步只接受当前项目版本。', 'OPENRIG_INPUT_INVALID');
    const row = await project(req.params.id);
    if (row.version !== parsed.data.version) throw new AppError(409, '项目方案已更新，请刷新后再同步。', 'OPENRIG_PROJECT_VERSION_CHANGED');
    const current = peek(row);
    if (current.status !== 'not_synced') {res.json(current.queueItemId && current.status !== 'unavailable' ? await reconcile(row) : current); return;}
    const binding = department(row.department_id)!;
    let enqueueEntered = false;
    try {
      const agents: Array<{id: string; role: string}> = row.department?.agents ?? [];
      const plan: Array<{id: string; role: string; sourceDepartmentId?: string; sourceAgentId?: string}> = row.plan?.agents ?? [];
      const inProject = (id: string) => plan.some(agent => (agent.sourceDepartmentId ?? row.department_id) === row.department_id && (agent.sourceAgentId ?? agent.id) === id);
      if (!binding.seats.every(seat => agents.some(agent => agent.id === seat.employeeId)) ||
          !agents.some(agent => agent.id === binding.sourceEmployeeId && agent.role === 'manager') ||
          !inProject(binding.sourceEmployeeId) || !inProject(binding.destinationEmployeeId)) throw new OpenRigBridgeError('OPENRIG_EMPLOYEE_UNBOUND', 'Employee provenance mismatch');
      const {sourceEmployeeId, destinationEmployeeId, ...topology} = binding;
      await config.bridge!.bindDepartment(topology);
      // Immutable, bounded metadata only. No prompts, model settings, tools,
      // credentials, files, billing records, or run commands enter OpenRig.
      enqueueEntered = true;
      const view = await config.bridge!.enqueueProject({projectId: row.id, departmentId: row.department_id, sourceEmployeeId, destinationEmployeeId,
        title: String(row.requirement).slice(0, 200) || `为伍项目 ${row.id}`,
        description: JSON.stringify({source: 'weiwu', projectId: row.id, projectVersion: row.version, departmentId: row.department_id,
          departmentName: String(row.department_name).slice(0, 80), requirementSummary: String(row.requirement).slice(0, 1000),
          sourceEmployeeId, destinationEmployeeId, executionAuthority: 'weiwu', acceptanceAuthority: 'weiwu'})});
      res.json(verified(row.id, view));
    } catch (error) {
      const result = failure(row.id, config.bridge, error);
      // A complete preflight rejection can release the browser's own pending
      // marker. Missing/unknown receipts after entering enqueue are never proof.
      if (!enqueueEntered) {
        try {if (config.bridge!.peekProject(row.id) === null) result.notSubmitted = true;} catch { /* Cannot prove absence. */ }
      }
      res.json(result);
    }
  });
  return router;
}
