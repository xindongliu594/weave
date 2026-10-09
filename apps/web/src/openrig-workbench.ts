import { z } from 'zod';
import { api, ApiError } from './api.ts';

const failure = z.object({ code: z.string(), message: z.string() });
export const openRigStatusSchema = z.object({ enabled: z.boolean(), status: z.enum(['disabled', 'ready', 'unavailable']), acceptanceAuthority: z.literal('weiwu'), error: failure.optional() });
export const openRigProjectSchema = z.object({
  projectId: z.string(), enabled: z.boolean(), status: z.enum(['disabled', 'unavailable', 'not_bound', 'not_synced', 'synced', 'unknown']),
  queueItemId: z.string().nullable(), queueState: z.string().nullable(), acceptanceAuthority: z.literal('weiwu'), error: failure.optional(), notSubmitted: z.literal(true).optional(),
}).refine(value => value.status !== 'synced' || !!value.queueItemId, '已同步待办缺少工作项编号')
  .refine(value => !value.notSubmitted || value.queueItemId === null && ['disabled', 'not_bound', 'unavailable'].includes(value.status), '未派发声明与同步状态不一致');
export type OpenRigStatus = z.infer<typeof openRigStatusSchema>;
export type OpenRigProject = z.infer<typeof openRigProjectSchema> & { checkedAt?: string };
export type OpenRigClient = <T>(path: string, method?: string, body?: unknown, requestKey?: string, signal?: AbortSignal) => Promise<T>;
export type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const intentSchema = z.object({ projectId: z.string(), version: z.number().int().positive(), requestKey: z.string().uuid() });
const intentKey = (id: string) => 'weiwu:openrig-sync:' + id;

export function hasOpenRigIntent(projectId: string, storage: IntentStorage) {
  try { return storage.getItem(intentKey(projectId)) !== null; }
  catch { return true; } // Inaccessible bookkeeping must not permit a new write.
}
export function confirmOpenRigIntent(view: OpenRigProject, storage: IntentStorage) {
  if (view.status === 'synced' && view.queueItemId) storage.removeItem(intentKey(view.projectId));
}
function projectResponse(value: unknown, projectId: string) {
  const result = openRigProjectSchema.parse(value);
  if (result.projectId !== projectId) throw new Error('OpenRig 返回的项目不一致，请核对同步结果。');
  return result;
}
export async function readOpenRigProjects(departmentId: string, projectIds: string[], client: OpenRigClient = api, signal?: AbortSignal) {
  const ids = [...new Set(projectIds)];
  if (ids.length > 100) throw new Error('每次最多读取 100 个项目的待办映射。');
  const result = z.object({ enabled: z.boolean(), status: z.enum(['disabled', 'ready', 'unavailable']), items: z.array(openRigProjectSchema) }).parse(
    await client(`/openrig/projects?departmentId=${encodeURIComponent(departmentId)}&projectIds=${encodeURIComponent(ids.join(','))}`, 'GET', undefined, undefined, signal));
  const returned = new Set(result.items.map(item => item.projectId));
  if (returned.size !== result.items.length || returned.size !== ids.length || ids.some(id => !returned.has(id))) throw new Error('OpenRig 项目映射不完整，请刷新核对。');
  return result;
}
export function mergeOpenRigProject(previous: OpenRigProject | undefined, incoming: OpenRigProject): OpenRigProject {
  return previous?.status === 'synced' && incoming.status === 'synced' && previous.queueItemId === incoming.queueItemId && incoming.queueState === null
    ? { ...incoming, queueState: previous.queueState, checkedAt: previous.checkedAt } : incoming;
}
export async function syncOpenRigProject(projectId: string, version: number, storage: IntentStorage, client: OpenRigClient = api) {
  if (hasOpenRigIntent(projectId, storage)) throw new Error('上次同步结果尚未确认，请先核对待办。');
  const intent = intentSchema.parse({ projectId, version, requestKey: crypto.randomUUID() });
  // Save before sending so a reload or a lost HTTP response cannot expose a retry.
  storage.setItem(intentKey(projectId), JSON.stringify(intent));
  try {
    const result = projectResponse(await client(`/projects/${encodeURIComponent(projectId)}/openrig/sync`, 'POST', { version }, intent.requestKey), projectId);
    if (result.notSubmitted) storage.removeItem(intentKey(projectId));
    confirmOpenRigIntent(result, storage); return result;
  } catch (error) {
    // Generic 409 may mean the original idempotent request is still in flight.
    if (error instanceof ApiError && ((error.status === 409 && error.code === 'OPENRIG_PROJECT_VERSION_CHANGED')
      || (error.status === 422 && error.code === 'OPENRIG_INPUT_INVALID'))) storage.removeItem(intentKey(projectId));
    throw error;
  }
}
export async function reconcileOpenRigProject(projectId: string, storage: IntentStorage, client: OpenRigClient = api) {
  const result = projectResponse(await client(`/projects/${encodeURIComponent(projectId)}/openrig`), projectId);
  confirmOpenRigIntent(result, storage);
  return { ...result, ...(result.queueState !== null ? { checkedAt: new Date().toISOString() } : {}) };
}
export function openRigProjectLabel(view: OpenRigProject | undefined, pending: boolean) {
  if (pending || view?.status === 'unknown') return '同步结果待核对';
  if (!view) return '正在读取待办映射';
  if (view.status === 'not_bound') return '部门尚未连接 OpenRig';
  if (view.status === 'disabled') return '未启用待办连接';
  if (view.status === 'not_synced') return '尚未同步待办';
  if (view.status === 'unavailable') return '待办连接暂不可用';
  const states: Record<string, string> = { pending: '待处理', 'in-progress': '处理中', done: '已结束', blocked: '受阻', failed: '失败', denied: '已拒绝', canceled: '已取消', 'handed-off': '已交接' };
  return view.queueState ? `队列状态：${states[view.queueState] ?? view.queueState}` : '已同步，待核对队列状态';
}
export function canSyncOpenRigProject(view: OpenRigProject | undefined, pending: boolean) {
  return view?.enabled === true && view.status === 'not_synced' && !pending;
}
