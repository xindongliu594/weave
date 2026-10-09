import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { canSyncOpenRigProject, confirmOpenRigIntent, hasOpenRigIntent, mergeOpenRigProject, openRigProjectLabel, openRigStatusSchema, readOpenRigProjects, reconcileOpenRigProject, syncOpenRigProject, type OpenRigProject, type OpenRigStatus } from './openrig-workbench.ts';

const intentStorage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
  removeItem: (key: string) => window.localStorage.removeItem(key),
};

export function useOpenRigWorkbench(departmentId: string | undefined, projects: { id: string; version: number }[], refreshedAt?: string) {
  const ids = [...new Set(projects.map(item => item.id))].sort().join(',');
  const scope = (departmentId ?? '') + ':' + ids, currentScope = useRef(scope); currentScope.current = scope;
  const [status, setStatus] = useState<OpenRigStatus | null>(null);
  const [rows, setRows] = useState<Record<string, OpenRigProject>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());
  const operationEpoch = useRef(new Map<string, number>());

  useEffect(() => {
    if (!departmentId) return;
    let active = true; const controller = new AbortController();
    void (async () => {
      try {
        const nextStatus = openRigStatusSchema.parse(await api('/openrig/status', 'GET', undefined, undefined, controller.signal));
        if (!active) return; setStatus(nextStatus);
        if (!nextStatus.enabled || nextStatus.status !== 'ready' || !ids) return;
        const epochs = new Map(ids.split(',').map(id => [id, operationEpoch.current.get(id) ?? 0]));
        const values = await readOpenRigProjects(departmentId, ids.split(','), api, controller.signal);
        if (!active) return;
        const fresh = values.items.filter(item => !inFlight.current.has(item.projectId) && epochs.get(item.projectId) === (operationEpoch.current.get(item.projectId) ?? 0));
        setRows(previous => ({ ...previous, ...Object.fromEntries(fresh.map(item => [item.projectId, mergeOpenRigProject(previous[item.projectId], item)])) }));
        const pendingRows: Record<string, boolean> = {};
        for (const item of fresh) {
          try { confirmOpenRigIntent(item, intentStorage); } catch { /* Retain the marker if browser storage is unavailable. */ }
          pendingRows[item.projectId] = hasOpenRigIntent(item.projectId, intentStorage);
        }
        setPending(previous => ({ ...previous, ...pendingRows }));
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setStatus(previous => previous?.enabled ? { ...previous, status: 'unavailable', error: { code: 'OPENRIG_READ_FAILED', message: (error as Error).message } } : previous);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [departmentId, ids, refreshedAt]);

  async function act(projectId: string, version: number, reconcile: boolean) {
    if (inFlight.current.has(projectId) || status?.status !== 'ready') return;
    if (!reconcile && !canSyncOpenRigProject(rows[projectId], hasOpenRigIntent(projectId, intentStorage))) return;
    const actionScope = scope;
    operationEpoch.current.set(projectId, (operationEpoch.current.get(projectId) ?? 0) + 1);
    inFlight.current.add(projectId); setBusy(previous => ({ ...previous, [projectId]: true }));
    setErrors(previous => ({ ...previous, [projectId]: '' }));
    try {
      const result = reconcile ? await reconcileOpenRigProject(projectId, intentStorage) : await syncOpenRigProject(projectId, version, intentStorage);
      if (currentScope.current === actionScope) setRows(previous => ({ ...previous, [projectId]: mergeOpenRigProject(previous[projectId], result) }));
    } catch (error) {
      if (currentScope.current === actionScope) setErrors(previous => ({ ...previous, [projectId]: (error as Error).message }));
    } finally {
      inFlight.current.delete(projectId);
      setPending(previous => ({ ...previous, [projectId]: hasOpenRigIntent(projectId, intentStorage) }));
      setBusy(previous => ({ ...previous, [projectId]: false }));
    }
  }
  return { status, rows, pending, busy, errors, act };
}

export function OpenRigProjectLink({ projectId, version, state }: { projectId: string; version: number; state: ReturnType<typeof useOpenRigWorkbench> }) {
  if (!state.status?.enabled) return null;
  const view = state.rows[projectId], pending = state.pending[projectId] ?? false;
  const busy = state.busy[projectId], ready = state.status.status === 'ready';
  const canSync = ready && canSyncOpenRigProject(view, pending);
  const canCheck = ready && (pending || view?.status === 'unknown' || view?.status === 'synced' || view?.status === 'unavailable');
  const error = state.errors[projectId] || view?.error?.message;
  return <div className="workbench-openrig">
    <div><span>OpenRig 待办</span><small>{ready ? openRigProjectLabel(view, pending) : '连接暂不可用'}</small></div>
    {view?.queueItemId && <code title={view.queueItemId}>{view.queueItemId}</code>}
    {(canSync || canCheck) && <button className="text-button" disabled={busy} onClick={() => void state.act(projectId, version, canCheck)}>{busy ? canCheck ? '正在核对…' : '正在同步…' : canCheck ? '核对待办' : '同步为待办'}</button>}
    {view?.checkedAt && !pending && <small>队列状态核对于 {new Date(view.checkedAt).toLocaleTimeString('zh-CN')}</small>}
    {pending && <small>上次同步的结果尚未确认，请核对工作项。</small>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
