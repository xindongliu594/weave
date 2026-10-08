import type { Usage } from '../../../packages/contracts/index.ts';
import { api } from './api.ts';

export const COSTS_CHANGED_EVENT = 'weiwu-costs-changed';
type UsageSnapshot = { rows: Usage[]; refreshing: boolean; updatedAt: string | null; error: string };
type EventSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
type UsageSyncOptions = {
  activity?: EventSource; visibility?: EventSource; visible?: () => boolean;
  schedule?: (fn: () => void, delay: number) => unknown; cancel?: (timer: unknown) => void;
  now?: () => string;
};

export function createUsageSync(load: () => Promise<Usage[]>, options: UsageSyncOptions = {}) {
  let snapshot: UsageSnapshot = { rows: [], refreshing: false, updatedAt: null, error: '' };
  let inFlight: Promise<Usage[]> | null = null, timer: unknown;
  const listeners = new Set<() => void>();
  const visible = options.visible ?? (() => true);
  const schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay));
  const cancel = options.cancel ?? (value => clearTimeout(value as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => new Date().toISOString());
  const publish = (next: UsageSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  function refresh() {
    if (inFlight) return inFlight;
    const request = Promise.resolve().then(load).then(rows => {
      publish({ rows, refreshing: true, updatedAt: now(), error: '' });
      return rows;
    }).catch(failure => {
      const message = failure instanceof TypeError && /fetch/i.test(failure.message) ? '本机用量读取失败，请检查后端服务后刷新。' : failure instanceof Error ? failure.message : '本机用量读取失败，请刷新。';
      publish({ ...snapshot, error: message });
      throw failure;
    }).finally(() => { inFlight = null; publish({ ...snapshot, refreshing: false }); });
    inFlight = request;
    publish({ ...snapshot, refreshing: true });
    return request;
  }
  function stopTimer() { if (timer !== undefined) { cancel(timer); timer = undefined; } }
  function scheduleNext() {
    if (timer !== undefined || !listeners.size || !visible()) return;
    timer = schedule(() => {
      timer = undefined;
      if (!listeners.size || !visible()) return;
      void refresh().catch(() => {}).finally(scheduleNext);
    }, 15000);
  }
  function wake() {
    stopTimer();
    if (listeners.size && visible()) void refresh().catch(() => {}).finally(scheduleNext);
  }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
      options.activity?.addEventListener('focus', wake);
      options.activity?.addEventListener(COSTS_CHANGED_EVENT, wake);
      options.visibility?.addEventListener('visibilitychange', wake);
      scheduleNext();
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        stopTimer();
        options.activity?.removeEventListener('focus', wake);
        options.activity?.removeEventListener(COSTS_CHANGED_EVENT, wake);
        options.visibility?.removeEventListener('visibilitychange', wake);
      }
    };
  }
  return { refresh, subscribe, getSnapshot: () => snapshot };
}

export const usageSync = createUsageSync(() => api<Usage[]>('/usage'), {
  activity: typeof window === 'undefined' ? undefined : window,
  visibility: typeof document === 'undefined' ? undefined : document,
  visible: () => typeof document === 'undefined' || !document.hidden,
});
export function notifyCostsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(COSTS_CHANGED_EVENT));
}
