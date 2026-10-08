import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { COSTS_CHANGED_EVENT } from './usage-sync.ts';

export type CostReadiness = {
  recordedCost: number;
  reserved: number;
  availableBudget: number;
  pendingCount: number;
  uncertainCount: number;
  receipts: { id: string; amount: number; status: 'pending' | 'uncertain'; runId?: string }[];
};
export type CostCarryover = {
  retained: boolean;
  recordedCost: number;
  reserved: number;
  availableBudget: number;
  receipts: { id: string; amount: number; runId?: string }[];
};
export type CostContinuationState = {
  readiness?: CostReadiness;
  loading: boolean;
  error: string;
  blocked: boolean;
  retainUncertainCosts: boolean;
  setRetainUncertainCosts: (value: boolean) => void;
  refresh: () => void;
};

export function costContinuationBlocked(readiness: CostReadiness | undefined, retainUncertainCosts: boolean) {
  return !readiness || !Number.isFinite(readiness.availableBudget) || readiness.availableBudget <= 0
    || readiness.pendingCount > 0 || readiness.uncertainCount > 0 && !retainUncertainCosts;
}

export function costReadinessForBudget(readiness: CostReadiness | undefined, budgetLimit?: number) {
  return readiness && budgetLimit !== undefined && Number.isFinite(budgetLimit)
    ? { ...readiness, availableBudget: budgetLimit - readiness.recordedCost - readiness.reserved } : readiness;
}

export function runContinuationBlocked(costs: Pick<CostContinuationState, 'blocked' | 'readiness'>, gate: {
  busy: boolean; legacyCostBlocked?: string; checkpointBlocked?: string; unknownCount: number; acknowledged: boolean; resume: boolean;
}) {
  return gate.busy || costs.blocked || !!gate.legacyCostBlocked && !costs.readiness
    || gate.resume && !!gate.checkpointBlocked || gate.unknownCount > 0 && !gate.acknowledged;
}

/** The consent applies only to the receipts the user actually saw, never to a later call. */
export function costConsentKey(identity: string, readiness?: CostReadiness) {
  return identity + ':' + JSON.stringify((readiness?.receipts ?? []).filter(receipt => receipt.status === 'uncertain')
    .map(receipt => [receipt.id, receipt.amount]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

export function CostContinuation({ projectId, identity, initial, budgetLimit, children }: {
  projectId?: string;
  identity: string;
  initial?: CostReadiness;
  budgetLimit?: number;
  children: (state: CostContinuationState) => ReactNode;
}) {
  const key = (projectId ?? '') + ':' + identity;
  const [state, setState] = useState({ key, readiness: initial, loading: !!projectId, error: '' });
  const [acceptedKey, setAcceptedKey] = useState<string>();
  const refreshRef = useRef<() => void>(() => {});
  const current = state.key === key ? state : { key, readiness: initial, loading: !!projectId, error: '' };
  useEffect(() => {
    let active = true, inFlight = false, queued = false, timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (active && projectId && document.visibilityState !== 'hidden') timer = setTimeout(() => { timer = undefined; void refresh(); }, 15000);
    };
    async function refresh() {
      if (!projectId || !active) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      clearTimeout(timer);
      setState(previous => ({ ...(previous.key === key ? previous : { readiness: initial }), key, loading: true, error: '' }));
      try {
        const readiness = await api<CostReadiness>('/projects/' + projectId + '/cost-readiness');
        if (active) setState({ key, readiness, loading: false, error: '' });
      } catch (failure) {
        if (active) setState(previous => ({ ...previous, key, loading: false, error: failure instanceof Error ? failure.message : '读取项目费用失败，请刷新。' }));
      } finally {
        inFlight = false;
        if (active && queued) { queued = false; void refresh(); }
        else schedule();
      }
    }
    const wake = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    refreshRef.current = () => { void refresh(); };
    window.addEventListener(COSTS_CHANGED_EVENT, wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      refreshRef.current = () => {};
      window.removeEventListener(COSTS_CHANGED_EVENT, wake);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [key, projectId]);
  const readiness = costReadinessForBudget(current.readiness, budgetLimit);
  const consentKey = costConsentKey(key, readiness);
  const retainUncertainCosts = (readiness?.uncertainCount ?? 0) > 0 && acceptedKey === consentKey;
  return children({ ...current, readiness, retainUncertainCosts,
    blocked: current.loading || !!current.error || (!!projectId || !!initial) && costContinuationBlocked(readiness, retainUncertainCosts),
    setRetainUncertainCosts: value => setAcceptedKey(value ? consentKey : undefined),
    refresh: () => refreshRef.current(),
  });
}

const dollars = (value: number) => '$' + value.toFixed(6);
export function CostCarryoverChoice({ state, disabled = false }: { state: CostContinuationState; disabled?: boolean }) {
  const { readiness, loading, error, retainUncertainCosts } = state;
  return <div className="cost-carryover">
    <div className="cost-carryover-head"><strong>项目费用状态</strong><button type="button" className="text-button" disabled={disabled || loading} onClick={state.refresh}>{loading ? '正在读取…' : '刷新费用'}</button></div>
    {readiness && <>
      <div className="cost-line"><span>已记录费用</span><span>{dollars(readiness.recordedCost)}</span></div>
      <div className="cost-line"><span>未结算预留</span><span>{dollars(readiness.reserved)}</span></div>
      <div className="cost-line"><span>扣除预留后可用预算</span><strong>{dollars(readiness.availableBudget)}</strong></div>
      {readiness.pendingCount > 0 && <p className="banner error" role="status">有 {readiness.pendingCount} 笔调用仍在进行中。请等待调用结束，再刷新费用状态；此时不能继续。</p>}
      {readiness.uncertainCount > 0 && <>
        <p className="subcopy">有 {readiness.uncertainCount} 笔调用费用尚未确定。预留继续占用原项目预算，未知金额不计为已消费，也不按零费用结算。</p>
        <label className="cost-carryover-consent"><input type="checkbox" checked={retainUncertainCosts} disabled={disabled || loading || readiness.pendingCount > 0 || readiness.availableBudget <= 0} onChange={event => state.setRetainUncertainCosts(event.target.checked)}/><span>保留未知费用预留，在原预算继续</span></label>
        <p className="subcopy">获得准确账单后，可在<a href="#usage">用量与费用</a>继续核对。本选择仅授权费用预留，不代替外部操作核对。</p>
      </>}
      {readiness.availableBudget <= 0 && <p className="banner error" role="status">原预算扣除已记录费用和未结算预留后已无可用额度，不能启动新执行。</p>}
      {readiness.receipts.length > 0 && <details><summary>查看未结算收据（{readiness.receipts.length}）</summary>{readiness.receipts.map(receipt => <p className="cost-carryover-receipt" key={receipt.id}><code>{receipt.id}</code><span>{receipt.status === 'pending' ? '进行中' : '费用待核对'} · 预留 {dollars(receipt.amount)}</span>{receipt.runId && <a href={'#run/' + receipt.runId}>查看所属运行</a>}</p>)}</details>}
    </>}
    {!readiness && loading && <p className="subcopy" role="status">正在读取原项目预算与未结算预留…</p>}
    {error && <p className="banner error" role="alert">{error} 请刷新费用状态后继续。</p>}
  </div>;
}
