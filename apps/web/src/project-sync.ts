import type { Project } from '../../../packages/contracts/index.ts';
import { api } from './api.ts';

export const PROJECT_POLL_MS = 5000, PROJECT_POLL_LIMIT = 12;
export const projectIsActive = (project?: Pick<Project, 'status'>) => project?.status === 'RUNNING' || project?.status === 'QUEUED';
type Snapshot = { rows: Project[]; refreshing: boolean; error: string; updatedAt: string | null };
type Options = { visibility?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>; visible?: () => boolean;
  schedule?: (fn: () => void, delay: number) => unknown; cancel?: (timer: unknown) => void; now?: () => string };

/** Project GETs only. A newer action refresh supersedes a poll; saved versions
 * never regress even if a replica or a delayed read returns an older version. */
export function createProjectSync(load: (signal: AbortSignal) => Promise<Project[]>, options: Options = {}) {
  let snapshot: Snapshot = { rows: [], refreshing: false, error: '', updatedAt: null };
  let serial = 0, inFlight: { promise: Promise<Project[]>; controller: AbortController } | undefined, timer: unknown;
  let enabled = false, projectId: string | null = null, remaining = PROJECT_POLL_LIMIT;
  const listeners = new Set<() => void>(), visible = options.visible ?? (() => true);
  const schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay));
  const cancel = options.cancel ?? (value => clearTimeout(value as ReturnType<typeof setTimeout>));
  const publish = (next: Snapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  function stopTimer() { if (timer !== undefined) { cancel(timer); timer = undefined; } }
  function cancelRead() { serial++; inFlight?.controller.abort(); inFlight = undefined; publish({ ...snapshot, refreshing: false }); }
  function scheduleNext() {
    if (timer !== undefined || inFlight || !listeners.size || !enabled || !visible() || remaining <= 0 || !projectIsActive(snapshot.rows.find(row => row.id === projectId))) return;
    const ticket = serial;
    timer = schedule(() => {
      if (ticket !== serial || !listeners.size || !enabled || !visible()) return;
      timer = undefined; remaining--; void refresh().catch(() => {});
    }, PROJECT_POLL_MS);
  }
  function refresh({ fresh = false }: { fresh?: boolean } = {}) {
    if (inFlight && !fresh) return inFlight.promise;
    stopTimer(); if (inFlight) cancelRead();
    const ticket = ++serial, controller = new AbortController();
    const request = Promise.resolve().then(() => load(controller.signal)).then(rows => {
      if (ticket !== serial || controller.signal.aborted) return snapshot.rows;
      const previous = new Map(snapshot.rows.map(row => [row.id, row]));
      const latest = rows.map(row => { const old = previous.get(row.id); return old && old.version > row.version ? old : row; });
      publish({ rows: latest, refreshing: true, error: '', updatedAt: (options.now ?? (() => new Date().toISOString()))() }); return latest;
    }).catch(failure => {
      if (ticket !== serial || controller.signal.aborted) return snapshot.rows;
      publish({ ...snapshot, error: failure instanceof Error ? failure.message : '项目状态读取失败，请刷新。' }); throw failure;
    }).finally(() => { if (ticket === serial) { inFlight = undefined; publish({ ...snapshot, refreshing: false }); scheduleNext(); } });
    inFlight = { promise: request, controller }; publish({ ...snapshot, refreshing: true }); return request;
  }
  function watch(nextEnabled: boolean, nextProjectId: string | null) {
    if (enabled === nextEnabled && projectId === nextProjectId) return;
    enabled = nextEnabled; projectId = nextProjectId; remaining = PROJECT_POLL_LIMIT; stopTimer();
    if (!enabled) { cancelRead(); return; }
    if (listeners.size && visible()) void refresh({ fresh: true }).catch(() => {});
  }
  function visibilityChanged() {
    stopTimer();
    if (!visible()) { cancelRead(); return; }
    if (enabled && listeners.size) { remaining = PROJECT_POLL_LIMIT; void refresh({ fresh: true }).catch(() => {}); }
  }
  function subscribe(listener: () => void) {
    listeners.add(listener); if (listeners.size === 1) options.visibility?.addEventListener('visibilitychange', visibilityChanged);
    return () => { listeners.delete(listener); if (!listeners.size) { stopTimer(); cancelRead(); options.visibility?.removeEventListener('visibilitychange', visibilityChanged); } };
  }
  function reset(){stopTimer();enabled=false;projectId=null;remaining=PROJECT_POLL_LIMIT;serial++;inFlight?.controller.abort();inFlight=undefined;publish({rows:[],refreshing:false,error:'',updatedAt:null});}
  return { refresh, watch, subscribe, reset, getSnapshot: () => snapshot };
}

export const projectSync = createProjectSync(signal => api<Project[]>('/projects', 'GET', undefined, undefined, signal), {
  visibility: typeof document === 'undefined' ? undefined : document,
  visible: () => typeof document === 'undefined' || !document.hidden,
});
