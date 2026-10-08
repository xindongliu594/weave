import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { notifyCostsChanged } from './usage-sync.ts';

type ProviderQuery = {
  status: 'querying' | 'settled' | 'unresolved' | 'failed' | 'already-settled';
  message: string;
  checkedAt: string;
  requestId?: string;
  providerQuota?: number;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
};
type CostCall = {
  id: string; modelName: string; purpose: string; status: string; amount: number;
  createdAt: string; runId?: string; inputRate: number; outputRate: number; history: unknown;
  providerRequestId?: string; upstreamRequestId?: string; responseRequestId?: string; providerStatus?: number;
  providerReconciliation?: ProviderQuery;
  accountingMode?: 'conversation' | 'budgeted';
};
type CostData = {
  spent: number; reserved: number; timezone: string; conversationSpent?: number; recordedSpent?: number;
  departments: { id: string; name: string; spent: number; reserved: number; limit: number | null }[];
  calls: CostCall[]; recent: CostCall[];
};
const queryLabels: Record<ProviderQuery['status'], string> = { querying: '正在查询账单', settled: '账单已核对', unresolved: '暂未确定对应账单', failed: '账单查询失败', 'already-settled': '费用已结算' };
function errorMessage(error: unknown) { return error instanceof TypeError && /fetch/i.test(error.message) ? '后端连接失败，请检查本机服务后重新查询。' : error instanceof Error ? error.message : '请求失败，请稍后重新查询。'; }

function purposeLabel(call: Pick<CostCall, 'purpose' | 'accountingMode'>) {
  return call.accountingMode === 'conversation' ? '需求对话' : ({ planning: '项目规划', test: '连接测试', execution: '项目执行', compaction: '上下文整理' } as Record<string, string>)[call.purpose] ?? call.purpose;
}
export function CostCallSummary({ call }: { call: Pick<CostCall, 'modelName' | 'purpose' | 'status' | 'amount' | 'accountingMode'> }) {
  return <><strong>{call.modelName} · {purposeLabel(call)}</strong><p>{call.status === 'pending' ? '请求进行中' : '费用待核对'} · {call.accountingMode === 'conversation'
    ? '不设预算预留，实际费用待核对' : <>预留 ${Number(call.amount).toFixed(6)}</>}</p></>;
}
export function CostTotals({ data }: { data: Pick<CostData, 'spent' | 'reserved' | 'timezone' | 'conversationSpent' | 'recordedSpent'> }) {
  return <><p>今日预算计入的已确认费用 ${Number(data.spent).toFixed(6)} · 未结算预留 ${Number(data.reserved).toFixed(6)} · {data.timezone} 自然日</p>
    {data.conversationSpent !== undefined && <p>需求对话已记录费用 ${Number(data.conversationSpent).toFixed(6)}（不计入执行预算）{data.recordedSpent !== undefined && <> · 今日全部已记录费用 ${Number(data.recordedSpent).toFixed(6)}</>}</p>}
  </>;
}

function ProviderResponseDetails({ call }: { call: CostCall }) {
  const ids = [
    ['中转站请求 ID', call.providerRequestId],
    ['上游请求 ID', call.upstreamRequestId],
    ['响应请求 ID', call.responseRequestId],
  ] as const;
  const hasId = ids.some(([, value]) => value);
  return <div className="lower-small">
    <small>本次模型响应状态：{call.providerStatus === undefined ? '暂无' : 'HTTP ' + call.providerStatus}</small>
    {ids.map(([label, value], index) => value ? <label className="field" key={label}>{label}<input readOnly value={value} title="点击选中，可复制此编号" onFocus={e => e.currentTarget.select()} onClick={e => e.currentTarget.select()}/></label> : index === 0 ? <small key={label}>{label}：暂无</small> : null)}
    {!hasId && <small>暂无供应方请求编号；不能据此确认未调用或零费用。</small>}
  </div>;
}

function ProviderQueryResult({ result }: { result?: ProviderQuery }) {
  if (!result) return null;
  return <div className="provider-reconciliation" role="status">
    <strong>{queryLabels[result.status] ?? '最近一次账单查询'}</strong><p>{result.message}</p>
    <small>{new Date(result.checkedAt).toLocaleString('zh-CN')}{result.requestId && <> · 中转站请求 ID：{result.requestId}</>}</small>
    {result.inputTokens !== undefined && result.outputTokens !== undefined && <small>输入 {result.inputTokens} · 输出 {result.outputTokens} Token{result.cost !== undefined && ' · 本机结算 $' + Number(result.cost).toFixed(6)}</small>}
    {result.providerQuota !== undefined && <small>中转站账单原始额度：{result.providerQuota}（未换算为美元或 Token）</small>}
  </div>;
}

export function CostControl() {
  const [data, setData] = useState<CostData | null>(null), [readError, setReadError] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [querying, setQuerying] = useState(''), [refreshing, setRefreshing] = useState(false), [queries, setQueries] = useState<Record<string, ProviderQuery>>({});
  const [selected, setSelected] = useState(''), [input, setInput] = useState(''), [output, setOutput] = useState(''), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const pendingRead = useRef<Promise<void> | null>(null), mutation = useRef(false), mounted = useRef(true);
  const refresh = useCallback(() => {
    if (pendingRead.current) return pendingRead.current;
    if (mounted.current) setRefreshing(true);
    const request = api<CostData>('/costs').then(next => { if (mounted.current) { setData(next); setReadError(''); } }).catch(failure => {
      if (mounted.current) setReadError(errorMessage(failure));
      throw failure;
    }).finally(() => { pendingRead.current = null; if (mounted.current) setRefreshing(false); });
    pendingRead.current = request;
    return request;
  }, []);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await refresh(); } catch { /* refresh retains the readable error. */ }
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); };
  }, [refresh]);

  async function refreshAfterChange() {
    if (pendingRead.current) { try { await pendingRead.current; } catch { /* Start a fresh read after the change. */ } }
    await refresh();
  }

  async function reconcile() {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/costs/' + selected + '/reconcile', 'POST', { inputTokens: Number(input), outputTokens: Number(output), note, confirmation: 'RECONCILE' });
      notifyCostsChanged();
      if (mounted.current) { setSelected(''); setNotice('费用已按请求时的单价核对，记录与核对依据均已保留。'); }
      await refreshAfterChange();
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { mutation.current = false; if (mounted.current) setBusy(false); }
  }
  async function queryProvider(call: CostCall) {
    if (mutation.current) return;
    mutation.current = true;
    setQuerying(call.id); setError(''); setNotice('');
    try {
      const result = await api<ProviderQuery>('/costs/' + call.id + '/query-provider', 'POST', {});
      if (result.status === 'settled' || result.status === 'already-settled') notifyCostsChanged();
      if (mounted.current) {
        setQueries(current => ({ ...current, [call.id]: result }));
        setNotice(result.message);
        if (result.status === 'settled' || result.status === 'already-settled') setSelected(current => current === call.id ? '' : current);
      }
      await refreshAfterChange();
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { mutation.current = false; if (mounted.current) setQuerying(''); }
  }
  function latestQuery(call: CostCall) {
    const local = queries[call.id], saved = call.providerReconciliation;
    if (saved?.status === 'settled' || saved?.status === 'already-settled') return saved;
    return local && (!saved || new Date(local.checkedAt).getTime() >= new Date(saved.checkedAt).getTime()) ? local : saved;
  }
  function queryInProgress(call: CostCall) {
    const result = call.providerReconciliation?.status === 'querying' ? call.providerReconciliation : latestQuery(call);
    return result?.status === 'querying' && Date.now() - new Date(result.checkedAt).getTime() < 30000;
  }
  const locked = busy || !!querying;
  const current = data?.calls.find(call => call.id === selected);
  return <section className="panel padded lower"><div className="section-title"><h2>每日预算与待核对费用</h2><button type="button" disabled={refreshing || locked} onClick={() => void refresh().catch(() => {})}>{refreshing ? '正在刷新…' : '刷新费用'}</button></div>
    {(error || readError) && <p className="banner error" role="alert">{error || readError}</p>}{notice && <p className="banner" role="status">{notice}</p>}
    {data && <><CostTotals data={data}/>
      <p className="subcopy">新需求对话不预留或拦截，实际费用单独记录，不计入执行的每日预算。项目规划、连接测试和执行仍受每日限额约束；这些请求超时或未返回用量时保留原有预留。预留不是账单。可以先查询中转站账单，只有确定对应请求后才核对费用。查询不发起模型推理，也不会自动恢复项目；结果不明确时保留待核对状态。</p>
      {data.departments.map(d => <p key={d.id}>{d.name}：已确认 ${Number(d.spent).toFixed(6)} + 预留 ${Number(d.reserved).toFixed(6)} / {d.limit === null ? '沿用全局限制' : '$' + d.limit}</p>)}
      {data.calls.length === 0 ? <p className="subcopy">没有进行中或待核对的调用。</p> : data.calls.map(call => <div className="document-row cost-call" key={call.id}>
        <CostCallSummary call={call}/><small>{new Date(call.createdAt).toLocaleString('zh-CN')}<br/>本机调用 ID：{call.id}</small>
        <ProviderResponseDetails call={call}/>
        <div className="cost-call-actions">{call.runId && <a href={'#run/' + call.runId}>查看对应运行</a>}{call.status === 'uncertain' && <><button type="button" disabled={locked || queryInProgress(call)} onClick={() => void queryProvider(call)}>{querying === call.id || queryInProgress(call) ? '正在查询中转站账单…' : '查询中转站账单'}</button><button type="button" disabled={locked} onClick={() => { setSelected(call.id); setInput(''); setOutput(''); setNote(''); setConfirmed(false); }}>手动核对费用</button></>}</div>
        <ProviderQueryResult result={latestQuery(call)}/>
      </div>)}
      {current && <form className="lower" onSubmit={e => { e.preventDefault(); void reconcile(); }}><h3>核对 {current.modelName} 的这次请求</h3><ProviderResponseDetails call={current}/><p className="subcopy">请依据中转站账单填写完整输入与输出 Token。只有确认没有扣费时才将两项都填 0。单价固定为请求时输入 ${current.inputRate}、输出 ${current.outputRate} / 百万 Token。</p><div className="form-grid"><label className="field">账单输入 Token<input required disabled={locked} type="number" min={0} max={2147483647} value={input} onChange={e => setInput(e.target.value)}/></label><label className="field">账单输出 Token<input required disabled={locked} type="number" min={0} max={2147483647} value={output} onChange={e => setOutput(e.target.value)}/></label></div><label className="field">核对依据<textarea required disabled={locked} minLength={5} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder="例如账单请求编号、查询时间及确认结果"/></label><label><input disabled={locked} type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>我已核对供应方账单，确认以上用量</label><div className="lower-small"><button className="primary" disabled={locked || !confirmed || input === '' || output === '' || note.trim().length < 5}>{busy ? '正在记录…' : '确认记录用量'}</button><button type="button" disabled={locked} onClick={() => setSelected('')}>取消</button></div></form>}
      <details className="lower"><summary>最近 20 次已结算或未发送的请求</summary>{data.recent.map(call => <details key={call.id}><summary>{call.modelName} · {purposeLabel(call)} · {call.status === 'released' ? '请求未发送' : '已结算'}</summary><ProviderResponseDetails call={call}/><ProviderQueryResult result={latestQuery(call)}/><pre className="product-pre">{JSON.stringify({ id: call.id, history: call.history }, null, 2)}</pre></details>)}</details>
    </>}
  </section>;
}
