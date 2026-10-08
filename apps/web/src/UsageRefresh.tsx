import { useSyncExternalStore } from 'react';
import { LoaderCircle } from 'lucide-react';
import { usageSync } from './usage-sync.ts';

export function UsageRefreshButton() {
  const state = useSyncExternalStore(usageSync.subscribe, usageSync.getSnapshot, usageSync.getSnapshot);
  return <button disabled={state.refreshing} onClick={() => void usageSync.refresh().catch(() => {})}>{state.refreshing && <LoaderCircle size={15} className="spin"/>}{state.refreshing ? '正在刷新用量…' : '刷新用量与费用'}</button>;
}
export function UsageRefreshStatus() {
  const state = useSyncExternalStore(usageSync.subscribe, usageSync.getSnapshot, usageSync.getSnapshot);
  return <div className="usage-refresh-status" role="status">
    {state.error && <p className="banner error">{state.error} 已保留上次读取的记录。</p>}
    <p className="subcopy">{state.updatedAt ? '本机记录更新于 ' + new Date(state.updatedAt).toLocaleString('zh-CN') : state.refreshing ? '正在读取本机用量记录…' : '尚未读取本机用量记录。'} · 页面可见时定期同步，也可手动刷新。读取本机记录不调用模型。</p>
  </div>;
}
