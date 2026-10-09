import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';

// OpenRig 0.6.6 control-plane adapter. This module never starts a daemon,
// kernel, harness, model session, or Weiwu run. OpenRig owns queue state;
// these files contain only immutable identities and write-outcome receipts.
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = z.string().uuid();
// Product employees use stable local IDs (for example "manager"), not UUIDs.
// Employee IDs are JSON values only; project/department file names remain UUIDs.
const employeeId = z.string().min(1).max(180).regex(/^[^\x00-\x1f\x7f]+$/);
const identifier = z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/);
const logicalId = z.string().regex(/^[a-z][a-z0-9-]{0,40}\.[a-z][a-z0-9-]{0,40}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const seatSchema = z.object({employeeId, logicalId, role: identifier, nodeId: identifier, session: z.string().min(3).max(180)}).strict();
const departmentSchema = z.object({schema: z.literal(1), endpointFingerprint: hash, departmentId: uuid, rigId: identifier, rigName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), seats: z.array(seatSchema).min(1).max(32)}).strict();
const receiptSchema = z.object({schema: z.literal(1), endpointFingerprint: hash, projectId: uuid, departmentId: uuid, sourceEmployeeId: employeeId, destinationEmployeeId: employeeId, qitemId: z.string().regex(/^qitem-weiwu-[a-f0-9]{64}$/), payloadSha256: hash, outcome: z.enum(['pending', 'confirmed', 'unknown']), lastError: z.string().max(100).optional()}).strict();
export type OpenRigDepartmentBinding = z.infer<typeof departmentSchema>;
export type OpenRigProjectReceipt = z.infer<typeof receiptSchema>;
export type OpenRigBridgeConfig = {enabled?: boolean; version: '0.6.6'; endpoint: string; expectedSelfHostId: string; tokenFile: string; stateDirectory: string};
export type OpenRigProjectInput = {projectId: string; departmentId: string; sourceEmployeeId: string; destinationEmployeeId: string; title: string; description: string};
export type OpenRigQueueItem = {qitemId: string; sourceSession: string; destinationSession: string; body: string; summary: string; priority: string; tags: string[]; state: string; [key: string]: unknown};
export type OpenRigProjectView = {receipt: OpenRigProjectReceipt; queueItem: OpenRigQueueItem | null; acceptanceAuthority: 'weiwu'};
export class OpenRigBridgeError extends Error {
  constructor(public code: string, message: string) {super(message); this.name = 'OpenRigBridgeError';}
}
const fail = (code: string, message: string): never => {throw new OpenRigBridgeError(code, message);};
// Only serialize bridge bookkeeping; this is not a second work dispatcher.
const localWrites = new Map<string, Promise<unknown>>();
async function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = localWrites.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(work); localWrites.set(key, next);
  try {return await next;} finally {if (localWrites.get(key) === next) localWrites.delete(key);}
}
function canonicalPath(value: string, directory: boolean): string {
  if (!path.isAbsolute(value)) fail('OPENRIG_PATH_INVALID', 'OpenRig 配置路径必须为绝对路径');
  const absolute = path.resolve(value); let at = path.parse(absolute).root;
  for (const part of absolute.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part); const stat = fs.lstatSync(at);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) fail('OPENRIG_PATH_INVALID', 'OpenRig 路径不能包含链接');
  }
  const stat = fs.lstatSync(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail('OPENRIG_PATH_INVALID', 'OpenRig 配置路径类型不正确');
  if (fs.realpathSync(absolute) !== absolute) fail('OPENRIG_PATH_INVALID', 'OpenRig 配置路径必须为规范路径');
  return absolute;
}
function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function writeJson(file: string, value: unknown, exclusive = false) {
  if (fs.existsSync(file)) canonicalPath(file, false);
  const target = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(target, 'wx', 0o600);
  try {fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  if (!exclusive) fs.renameSync(target, file);
  syncDirectory(path.dirname(file));
}
function readJson(file: string): unknown | null {
  if (!fs.existsSync(file)) return null;
  canonicalPath(file, false);
  if (fs.statSync(file).size > 128 * 1024) fail('OPENRIG_STATE_INVALID', 'OpenRig 映射记录超过限制');
  try {return JSON.parse(fs.readFileSync(file, 'utf8'));} catch {return fail('OPENRIG_STATE_INVALID', 'OpenRig 映射记录不完整，已停止同步');}
}
function payloadHash(item: Pick<OpenRigQueueItem, 'qitemId' | 'sourceSession' | 'destinationSession' | 'body' | 'summary' | 'priority' | 'tags'>) {
  return sha(JSON.stringify({qitemId: item.qitemId, sourceSession: item.sourceSession, destinationSession: item.destinationSession, body: item.body, summary: item.summary, priority: item.priority, tags: [...item.tags].sort()}));
}
const queueSchema = z.object({qitemId: z.string(), sourceSession: z.string(), destinationSession: z.string(), body: z.string(), summary: z.string(), priority: z.string(), tags: z.array(z.string()), state: z.enum(['pending', 'in-progress', 'done', 'blocked', 'failed', 'denied', 'canceled', 'handed-off'])}).passthrough();

export class OpenRigBridge {
  readonly enabled: boolean;
  private endpoint = '';
  private fingerprint = '';
  private directory = '';
  constructor(private config?: OpenRigBridgeConfig, private request: typeof fetch = fetch) {
    this.enabled = config?.enabled === true;
    if (!this.enabled) return; // Disabled is a no-I/O default.
    this.config = Object.freeze({...config!});
    if (config!.version !== '0.6.6') fail('OPENRIG_VERSION_MISMATCH', '仅接入已验证的 OpenRig 0.6.6');
    let url: URL; try {url = new URL(config!.endpoint);} catch {return fail('OPENRIG_ENDPOINT_INVALID', 'OpenRig 地址不正确');}
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('OPENRIG_ENDPOINT_INVALID', 'OpenRig 薄适配只允许明确端口的本机回环地址');
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(config!.expectedSelfHostId)) fail('OPENRIG_IDENTITY_REQUIRED', '需要固定 OpenRig 实例身份');
    this.endpoint = url.origin; this.directory = canonicalPath(config!.stateDirectory, true);
    canonicalPath(config!.tokenFile, false);
    this.fingerprint = sha(JSON.stringify({version: config!.version, endpoint: this.endpoint, selfHostId: config!.expectedSelfHostId}));
  }
  private assertEnabled() {if (!this.enabled) fail('OPENRIG_DISABLED', 'OpenRig 部门同步尚未启用'); canonicalPath(this.directory, true);}
  private file(kind: 'department' | 'project', id: string) {uuid.parse(id); return path.join(this.directory, `${kind}-${id}.json`);}
  private token() {
    const file = canonicalPath(this.config!.tokenFile, false);
    if (fs.statSync(file).size > 16 * 1024) fail('OPENRIG_TOKEN_INVALID', 'OpenRig 访问凭据格式不正确');
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!token || /[\r\n\x00]/.test(token)) fail('OPENRIG_TOKEN_INVALID', 'OpenRig 访问凭据格式不正确');
    return token;
  }
  private async http(route: string, body?: unknown, actor?: string) {
    const headers: Record<string, string> = {Authorization: `Bearer ${this.token()}`};
    if (actor) headers['X-OpenRig-Session'] = actor;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {response = await this.request(this.endpoint + route, {method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : {body: JSON.stringify(body)}), redirect: 'error', signal: AbortSignal.timeout(10000)});} catch {return fail('OPENRIG_UNREACHABLE', 'OpenRig 请求未取得完整回执');}
    const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try {
      if (reader) for (;;) {const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2 * 1024 * 1024) {await reader.cancel(); fail('OPENRIG_RESPONSE_INVALID', 'OpenRig 响应超过限制');} chunks.push(part.value);}
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); return {status: response.status, data};
    } catch {return fail('OPENRIG_RESPONSE_INVALID', 'OpenRig 响应不完整');}
  }
  private async identity() {
    const response = await this.http('/healthz'); const data = response.data as {status?: string; selfHostId?: string; semver?: string};
    if (response.status !== 200 || data?.status !== 'ok' || data.selfHostId !== this.config!.expectedSelfHostId || data.semver !== undefined && data.semver !== '0.6.6') fail('OPENRIG_IDENTITY_MISMATCH', 'OpenRig 实例身份或版本已变化');
  }
  private binding(departmentId: string) {
    const binding = departmentSchema.parse(readJson(this.file('department', departmentId)));
    if (binding.departmentId !== departmentId || binding.endpointFingerprint !== this.fingerprint) fail('OPENRIG_MAPPING_CHANGED', '部门 OpenRig 绑定与当前实例不一致');
    return binding;
  }
  private receipt(projectId: string) {
    const data = readJson(this.file('project', projectId)); if (data === null) return null;
    const receipt = receiptSchema.parse(data);
    if (receipt.projectId !== projectId || receipt.endpointFingerprint !== this.fingerprint) fail('OPENRIG_MAPPING_CHANGED', '项目 OpenRig 绑定与当前实例不一致');
    return receipt;
  }
  private async verifyDepartment(binding: OpenRigDepartmentBinding) {
    await this.identity();
    const id = encodeURIComponent(binding.rigId);
    // 0.6.6 detail returns {rig,nodes,edges}; only the list endpoint has bare rigs.
    const rigResponse = await this.http(`/api/rigs/${id}`), rig = (rigResponse.data as {rig?: {id?: string; name?: string}})?.rig;
    if (rigResponse.status !== 200 || rig?.id !== binding.rigId || rig.name !== binding.rigName) fail('OPENRIG_MAPPING_CHANGED', 'OpenRig 部门身份已变化');
    const sessions = await this.http(`/api/rigs/${id}/sessions`);
    if (sessions.status !== 200 || !Array.isArray(sessions.data) || sessions.data.length) fail('OPENRIG_RUNTIME_ACTIVE', '该 OpenRig 部门存在独立运行会话，不能同时交由为伍执行');
    const nodes = await this.http(`/api/rigs/${id}/nodes`);
    if (nodes.status !== 200 || !Array.isArray(nodes.data)) fail('OPENRIG_MAPPING_CHANGED', '无法核对 OpenRig 岗位');
    for (const seat of binding.seats) {
      const matches = (nodes.data as Array<Record<string, unknown>>).filter(node => node.logicalId === seat.logicalId);
      if (matches.length !== 1 || matches[0].nodeId !== seat.nodeId || matches[0].role !== seat.role || matches[0].runtime !== 'stub' || matches[0].sessionStatus != null || matches[0].canonicalSessionName) fail('OPENRIG_MAPPING_CHANGED', 'OpenRig 岗位绑定或运行状态已变化');
    }
  }
  async bindDepartment(input: {departmentId: string; rigId: string; rigName: string; seats: Array<{employeeId: string; logicalId: string; nodeId: string; role: string}>}): Promise<OpenRigDepartmentBinding> {
    this.assertEnabled();
    const binding = departmentSchema.parse({schema: 1, endpointFingerprint: this.fingerprint, ...input, seats: input.seats.map(seat => ({...seat, session: `${seat.logicalId.replace('.', '-')}@${input.rigName}`}))});
    for (const field of ['employeeId', 'logicalId', 'nodeId', 'session'] as const) if (new Set(binding.seats.map(seat => seat[field])).size !== binding.seats.length) fail('OPENRIG_MAPPING_CHANGED', '部门岗位映射不能重复');
    return serialize(this.file('department', binding.departmentId), async () => {
      const file = this.file('department', binding.departmentId), prior = readJson(file);
      if (prior && JSON.stringify(departmentSchema.parse(prior)) !== JSON.stringify(binding)) fail('OPENRIG_MAPPING_CHANGED', '已有部门绑定不能被静默替换');
      await this.verifyDepartment(binding);
      if (!prior) writeJson(file, binding, true);
      return binding;
    });
  }
  private inspectItem(receipt: OpenRigProjectReceipt, data: unknown): OpenRigQueueItem {
    const parsed = queueSchema.safeParse(data);
    if (!parsed.success) return fail('OPENRIG_PAYLOAD_MISMATCH', 'OpenRig 工作项回执格式不正确');
    if (payloadHash(parsed.data) !== receipt.payloadSha256 || parsed.data.qitemId !== receipt.qitemId) return fail('OPENRIG_PAYLOAD_MISMATCH', 'OpenRig 工作项来源、目标或内容与项目回执不一致');
    return parsed.data;
  }
  private async readItem(receipt: OpenRigProjectReceipt) {
    const response = await this.http(`/api/queue/${encodeURIComponent(receipt.qitemId)}`);
    if (response.status === 404 && (response.data as {error?: string})?.error === 'qitem_not_found') return null;
    if (response.status !== 200) fail('OPENRIG_QUERY_FAILED', '无法核对 OpenRig 工作项');
    return this.inspectItem(receipt, response.data);
  }
  private async reconcile(receipt: OpenRigProjectReceipt): Promise<OpenRigProjectView> {
    await this.verifyDepartment(this.binding(receipt.departmentId));
    const queueItem = await this.readItem(receipt);
    // A missing row does not prove that an earlier POST cannot still commit.
    // Query only; neither a timeout nor 404 is permission to send another POST.
    const updated: OpenRigProjectReceipt = {...receipt, outcome: queueItem ? 'confirmed' : 'unknown', ...(queueItem ? {lastError: undefined} : {lastError: 'OPENRIG_OUTCOME_UNKNOWN'})};
    writeJson(this.file('project', receipt.projectId), updated);
    return {receipt: updated, queueItem, acceptanceAuthority: 'weiwu'};
  }
  async reconcileProject(projectId: string): Promise<OpenRigProjectView> {
    this.assertEnabled();
    return serialize(this.file('project', projectId), async () => {const receipt = this.receipt(projectId); if (!receipt) return fail('OPENRIG_NOT_MAPPED', '项目尚未映射到 OpenRig'); return this.reconcile(receipt);});
  }
  // Local status for bounded UI lists: no remote calls, reservations or writes.
  peekProject(projectId: string): OpenRigProjectReceipt | null {
    this.assertEnabled(); return this.receipt(projectId);
  }
  async enqueueProject(input: OpenRigProjectInput): Promise<OpenRigProjectView> {
    this.assertEnabled();
    const request = z.object({projectId: uuid, departmentId: uuid, sourceEmployeeId: employeeId, destinationEmployeeId: employeeId, title: z.string().min(1).max(200), description: z.string().min(1).max(32000)}).strict().parse(input);
    return serialize(this.file('project', request.projectId), async () => {
      const binding = this.binding(request.departmentId), source = binding.seats.find(seat => seat.employeeId === request.sourceEmployeeId), destination = binding.seats.find(seat => seat.employeeId === request.destinationEmployeeId);
      if (!source || !destination) return fail('OPENRIG_EMPLOYEE_UNBOUND', '来源或目标员工不在已绑定部门中');
      const payload = {qitemId: `qitem-weiwu-${sha(`${request.departmentId}:${request.projectId}`)}`, sourceSession: source.session, destinationSession: destination.session, body: request.description, summary: request.title, priority: 'routine', tags: [`weiwu:department:${request.departmentId}`, `weiwu:project:${request.projectId}`], nudge: false};
      const prior = this.receipt(request.projectId), payloadSha256 = payloadHash(payload);
      if (prior) {if (prior.departmentId !== request.departmentId || prior.payloadSha256 !== payloadSha256) return fail('OPENRIG_PAYLOAD_MISMATCH', '同一项目不能复用不同的 OpenRig 请求内容'); return this.reconcile(prior);}
      await this.verifyDepartment(binding);
      const receipt: OpenRigProjectReceipt = {schema: 1, endpointFingerprint: this.fingerprint, projectId: request.projectId, departmentId: request.departmentId, sourceEmployeeId: request.sourceEmployeeId, destinationEmployeeId: request.destinationEmployeeId, qitemId: payload.qitemId, payloadSha256, outcome: 'pending'};
      const existing = await this.readItem(receipt);
      if (existing) {receipt.outcome = 'confirmed'; writeJson(this.file('project', request.projectId), receipt, true); return {receipt, queueItem: existing, acceptanceAuthority: 'weiwu'};}
      // Durably reserve this exact request identity before the only POST.
      // An exclusive-file conflict is a competing writer, never a reason to post.
      writeJson(this.file('project', request.projectId), receipt, true);
      try {
        const {sourceSession: _claimedSource, ...body} = payload;
        const response = await this.http('/api/queue/create', body, source.session);
        if (response.status !== 201 && response.status !== 200) fail('OPENRIG_CREATE_UNCONFIRMED', 'OpenRig 未确认工作项写入');
        const queueItem = this.inspectItem(receipt, response.data); receipt.outcome = 'confirmed'; writeJson(this.file('project', request.projectId), receipt);
        return {receipt, queueItem, acceptanceAuthority: 'weiwu'};
      } catch (error) {
        receipt.outcome = 'unknown'; receipt.lastError = error instanceof OpenRigBridgeError ? error.code : 'OPENRIG_OUTCOME_UNKNOWN'; writeJson(this.file('project', request.projectId), receipt);
        throw new OpenRigBridgeError('OPENRIG_OUTCOME_UNKNOWN', `OpenRig 请求结果待核对，禁止自动重发；工作项 ${receipt.qitemId}`);
      }
    });
  }
}
