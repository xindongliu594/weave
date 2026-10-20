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

export function createUsageSync(load: (signal:AbortSignal) => Promise<Usage[]>, options: UsageSyncOptions = {}) {
  let snapshot: UsageSnapshot = { rows: [], refreshing: false, updatedAt: null, error: '' };
  let inFlight: Promise<Usage[]> | null = null, timer: unknown;
  let serial=0,controller:AbortController|undefined,suspended=false;
  const listeners = new Set<() => void>();
  const visible = options.visible ?? (() => true);
  const schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay));
  const cancel = options.cancel ?? (value => clearTimeout(value as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => new Date().toISOString());
  const publish = (next: UsageSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  function refresh() {
    if (inFlight) return inFlight;
    suspended=false;const ticket=++serial;controller=new AbortController();const signal=controller.signal;
    const request = Promise.resolve().then(()=>load(signal)).then(rows => {
      if(ticket!==serial||signal.aborted)throw new DOMException('登录状态已变更','AbortError');
      publish({ rows, refreshing: true, updatedAt: now(), error: '' });
      return rows;
    }).catch(failure => {
      if(ticket!==serial||signal.aborted)throw failure;
      const message = failure instanceof TypeError && /fetch/i.test(failure.message) ? '本机用量读取失败，请检查后端服务后刷新。' : failure instanceof Error ? failure.message : '本机用量读取失败，请刷新。';
      publish({ ...snapshot, error: message });
      throw failure;
    }).finally(() => { if(ticket===serial){inFlight = null; publish({ ...snapshot, refreshing: false });} });
    inFlight = request;
    publish({ ...snapshot, refreshing: true });
    return request;
  }
  function stopTimer() { if (timer !== undefined) { cancel(timer); timer = undefined; } }
  function scheduleNext() {
    if (suspended || timer !== undefined || !listeners.size || !visible()) return;
    timer = schedule(() => {
      timer = undefined;
      if (!listeners.size || !visible()) return;
      void refresh().catch(() => {}).finally(scheduleNext);
    }, 15000);
  }
  function wake() {
    stopTimer();
    if (!suspended && listeners.size && visible()) void refresh().catch(() => {}).finally(scheduleNext);
  }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
      suspended=false;
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
  function reset(){serial++;suspended=true;controller?.abort();inFlight=null;stopTimer();publish({rows:[],refreshing:false,updatedAt:null,error:''});}
  return { refresh, subscribe, reset, getSnapshot: () => snapshot };
}

export const usageSync = createUsageSync(signal => api<Usage[]>('/usage','GET',undefined,undefined,signal), {
  activity: typeof window === 'undefined' ? undefined : window,
  visibility: typeof document === 'undefined' ? undefined : document,
  visible: () => typeof document === 'undefined' || !document.hidden,
});
export function notifyCostsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(COSTS_CHANGED_EVENT));
}
