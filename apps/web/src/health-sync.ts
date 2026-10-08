import { api, ApiError } from './api.ts';

export type Health = { database: string; runtime: { ready: boolean; reason: string }; version: string;
  demo?: { title: string; projectId: string }; workspace?: { kind: 'local'; workspacesPath: string } };
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'reachable';
type HealthSnapshot = { health: Health | null; status: ConnectionStatus; checking: boolean;
  checkedAt: string | null; connectedAt: string | null; error: string };
type EventSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
type HealthSyncOptions = { activity?: EventSource; visibility?: EventSource; visible?: () => boolean;
  schedule?: (fn: () => void, delay: number) => unknown; cancel?: (timer: unknown) => void; now?: () => string };
export const HEALTH_INTERVAL_MS = 5000;

export function connectionText(status: ConnectionStatus) {
  return { connecting: '正在连接后端服务', connected: '后端服务已连接', disconnected: '后端服务已断开',
    reconnecting: '正在重新连接后端服务', reachable: '后端已响应，状态检查失败' }[status];
}

/** Local read-only liveness checks; cached workspace metadata survives failures. */
export function createHealthSync(load: () => Promise<Health>, options: HealthSyncOptions = {}) {
  let snapshot: HealthSnapshot = { health: null, status: 'connecting', checking: false, checkedAt: null, connectedAt: null, error: '' };
  let inFlight: Promise<Health> | null = null, timer: unknown;
  const listeners = new Set<() => void>(), visible = options.visible ?? (() => true);
  const schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay));
  const cancel = options.cancel ?? (value => clearTimeout(value as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => new Date().toISOString());
  const publish = (next: HealthSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  function stopTimer() { if (timer !== undefined) { cancel(timer); timer = undefined; } }
  function scheduleNext() {
    if (timer !== undefined || inFlight || !listeners.size || !visible()) return;
    timer = schedule(() => {
      timer = undefined;
      if (listeners.size && visible()) void refresh().catch(() => {});
    }, HEALTH_INTERVAL_MS);
  }
  function refresh() {
    if (inFlight) return inFlight;
    stopTimer();
    const status = snapshot.status === 'disconnected' || snapshot.status === 'reachable' ? 'reconnecting' : snapshot.status;
    const request = Promise.resolve().then(load).then(health => {
      const checkedAt = now();
      publish({ health, status: 'connected', checking: true, checkedAt, connectedAt: checkedAt, error: '' });
      return health;
    }).catch(failure => {
      // A confirmed HTTP error is evidence that the server answered. api's
      // READ_TIMEOUT is synthetic and has no received HTTP response.
      const replied = failure instanceof ApiError && failure.status >= 100 && failure.status <= 599 && failure.code !== 'READ_TIMEOUT';
      publish({ ...snapshot, status: replied ? 'reachable' : 'disconnected', checkedAt: now(),
        error: failure instanceof Error ? failure.message : '无法连接本机工作台服务。' });
      throw failure;
    }).finally(() => { inFlight = null; publish({ ...snapshot, checking: false }); scheduleNext(); });
    inFlight = request;
    publish({ ...snapshot, status, checking: true });
    return request;
  }
  function wake() {
    stopTimer();
    if (listeners.size && visible()) void refresh().catch(() => {});
  }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
      options.activity?.addEventListener('focus', wake);
      options.visibility?.addEventListener('visibilitychange', wake);
      scheduleNext();
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        stopTimer();
        options.activity?.removeEventListener('focus', wake);
        options.visibility?.removeEventListener('visibilitychange', wake);
      }
    };
  }
  return { refresh, subscribe, getSnapshot: () => snapshot };
}

export const healthSync = createHealthSync(() => api<Health>('/health'), {
  activity: typeof window === 'undefined' ? undefined : window,
  visibility: typeof document === 'undefined' ? undefined : document,
  visible: () => typeof document === 'undefined' || !document.hidden,
});
