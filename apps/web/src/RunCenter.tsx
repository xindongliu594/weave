import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock3, Play, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api } from './api.ts';
import { RunExtras } from './RunExtras.tsx';
import type { RunSummary, RunDetail, TraceEvent } from '../../../services/agent-runtime/trace-store.mjs';

type Detail = RunDetail & { hasMore: boolean; nextCursor: number; summaryEvents?: TraceEvent[] };
const date = (value: string) => new Date(value).toLocaleString('zh-CN');
const stateName: Record<string, string> = { queued: '排队中', interrupted: '已中断', completed: '已完成', failed: '失败', cancelled: '已取消', unfinished: '运行中 / 可能中断', incomplete: '记录不完整' };
const eventNames: Record<string, string> = {
  'run/created': '创建运行档案', 'run/queued': '进入执行队列', 'run/captain': '绑定协调经理', 'run/task-mapping': '任务编号映射', 'run/approved': '确认启动', 'run/started': '团队开始执行', 'run/finished': '运行结束', 'billing/usage': '记录执行用量', 'budget/warning': '预算阈值提醒', 'budget/stopped': '预算或调用次数停止',
  'session/created': '创建员工会话', 'agent/created': '加载员工模型', 'model/wire-request': '实际发送的模型请求', 'model/fallback': '切换备用模型', 'context/compacted': '整理上下文', 'approval/requested': '请求工具审批', 'approval/decided': '用户处理审批', 'knowledge/citation': '引用知识资料', 'artifact/updated': '更新交付物', 'model/request': '运行时原始上下文', 'model/finish': '模型返回', 'model/error': '模型调用失败', 'model/usage': '模型用量',
  'tool/start': '开始调用工具', 'tool/result': '工具执行结果', 'team/operation': '团队操作', 'team/snapshot': '团队状态快照',
  'session/user/message': '收到任务或追加指令', 'session/system/message': '实际系统提示词', 'session/assistant/message': '员工回复', 'session/turn/start': '开始工作', 'session/turn/end': '本轮结束',
};
function eventSummary(e: TraceEvent) {
  if (e.type === 'model/request') return `${e.data.provider} / ${e.data.model}`;
  if (typeof e.data.name === 'string') return e.data.name;
  if (e.type === 'team/snapshot') return `${e.data.phase} · ${e.data.tasks?.filter((t: any) => t.status === 'completed').length ?? 0}/${e.data.tasks?.length ?? 0} 项完成`;
  const value = e.data.description ?? e.data.message;
  if (typeof value === 'string') return value.slice(0, 180);
  if (Array.isArray(value?.content)) return value.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').slice(0, 180);
  return '';
}

export function RunCenter() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => { const id = location.hash.split('/')[1]; return /^[a-f0-9-]{36}$/.test(id ?? '') ? id : null; });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [employee, setEmployee] = useState('');
  const [kind, setKind] = useState('all');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  async function refresh() { setRuns(await api<RunSummary[]>('/runs')); }
  useEffect(() => { refresh().catch(e => setError(e.message)).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    history.replaceState(null, '', selected ? '#run/' + selected : '#run');
    if (!selected) { setDetail(null); return; }
    let active = true;
    setDetail(null); setEmployee(''); setError('');
    api<Detail>(`/runs/${selected}`).then(d => { if (active) setDetail(d); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [selected]);
  useEffect(() => {
    if (!selected || !['unfinished','queued'].includes(detail?.status ?? '')) return;
    const timer = setInterval(() => api<Detail>(`/runs/${selected}?after=${detail?.nextCursor ?? 0}`).then(more => setDetail(current => current ? {...more,events:[...current.events,...more.events]} : more)).then(refresh).catch(e => setError(e.message)), 1000);
    return () => clearInterval(timer);
  }, [selected, detail?.status, detail?.nextCursor]);
  async function verify() {
    setBusy(true); setError('');
    try { const result = await api<{ id: string }>('/runs/verify', 'POST', {}); await refresh(); setSelected(result.id); }
    catch (e) { setError((e as Error).message); await refresh(); }
    finally { setBusy(false); }
  }
  const sessions = useMemo(() => {
    if (!detail) return [];
    const identities = new Map<string, string>();
    for (const event of detail.events) {
      if (event.type === 'run/captain') identities.set(event.data.sessionId, event.data.agentId);
      if (event.type === 'session/subagent/descriptor' && event.data.label?.startsWith('agent-teams:')) identities.set(event.sessionId!, event.data.label.split(':').at(-1));
    }
    const unique = new Map<string, { id: string; agentId?: string; model: string; name: string }>();
    for (const event of detail.events.filter(e => e.type === 'agent/created')) {
      const agentId = identities.get(event.sessionId!);
      unique.set(event.sessionId!, { id: event.sessionId!, agentId, model: event.data.model, name: detail.snapshot.agents.find(a => a.id === agentId)?.name ?? '未关联员工' });
    }
    return [...unique.values()];
  }, [detail]);
  const visible = detail?.events.filter(e => (!employee || e.sessionId === employee) && (kind === 'raw' || (kind === 'all' ? !!eventNames[e.type] && e.type !== 'team/operation' : e.type.startsWith(kind)))) ?? [];
  const assigned = detail?.snapshot.agents.find(a => a.id === sessions.find(s => s.id === employee)?.agentId);
  return <>
    <div className="page-head"><div><div className="eyebrow">EXECUTION HISTORY</div><h1>执行记录</h1><p>查看当时的职责、任务指令和实际操作。历史快照独立保留。</p></div><button className="primary" disabled={busy} onClick={verify}><Play size={16}/>{busy ? '正在验证…' : '运行追溯验证'}</button></div>
    <div className="notice-box"><ShieldCheck size={18}/><p>工具执行受岗位授权约束；终端操作在隔离工作区中执行并需要审批。追溯验证使用测试模型，不会调用真实 API。</p></div>
    {error && <div className="banner error" role="alert">{error}</div>}
    {!selected ? <section className="panel lower"><div className="trace-list-head"><h2>历史运行</h2><button onClick={() => refresh().catch(e => setError(e.message))}><RefreshCw size={14}/>刷新</button></div>{loading ? <p className="compact-empty">正在读取本地档案…</p> : runs.length ? runs.map(run => <button className="project-row" key={run.id} onClick={() => setSelected(run.id)}><Clock3 size={20}/><span><strong>{run.title}</strong><small>{date(run.createdAt)} · {run.eventCount} 条事件</small></span><span className="tag">{run.mode === 'fixture' ? '测试模型' : run.mode}</span><span className={'tag ' + (run.status === 'completed' ? 'green' : 'amber')}>{stateName[run.status] ?? run.status}</span></button>) : <div className="empty"><Search size={28}/><h3>还没有执行记录</h3><p>运行一次追溯验证，查看真实采集的团队过程。</p></div>}</section> : <>
      <button className="text-button back lower" onClick={() => setSelected(null)}><ArrowLeft size={15}/>返回运行列表</button>
      {!detail ? <p>正在读取运行记录…</p> : <>
        <section className="panel padded"><div className="row"><h2>{detail.title}</h2><span className="tag">{detail.mode === 'fixture' ? '测试模型验证' : '正式项目'}</span><span className="tag">{stateName[detail.status]}</span>{detail.mode === 'product' && ['unfinished','queued'].includes(detail.status) && <button onClick={async () => { try { await api(`/runs/${detail.id}/cancel`, 'POST', {}); } catch (e) { setError((e as Error).message); } }}>停止运行</button>}</div><p className="trace-id">Run ID：{detail.id}</p><p>{detail.snapshot.requirement}</p><small>方案 v{detail.snapshot.planVersion} · 模板 {detail.snapshot.templateVersion} · {detail.eventCount} 条事件</small>{detail.integrity !== 'ok' && <p className="validation-error">档案完整性检查未通过，不能视为完整执行记录。</p>}</section>
        <RunExtras id={detail.id} status={detail.status} events={detail.summaryEvents ?? detail.events} snapshot={detail.snapshot}/>
        <div className="trace-layout lower"><aside><section className="panel padded"><h3>员工与岗位快照</h3><button className={'trace-member ' + (!employee ? 'selected' : '')} onClick={() => setEmployee('')}>全部员工与运行操作</button>{sessions.map(s => <button key={s.id} className={'trace-member ' + (employee === s.id ? 'selected' : '')} onClick={() => setEmployee(s.id)}><strong>{s.name}</strong><small>{s.model}</small></button>)}{assigned && <div className="trace-role"><span className="tag">岗位提示词 v{assigned.roleVersion}</span><p>{assigned.rolePrompt}</p></div>}</section><section className="panel padded lower"><h3>本次任务提示词</h3>{detail.snapshot.tasks.filter(t => !assigned || t.assignee === assigned.id).map(t => <div className="trace-task" key={t.id}><strong>{t.subject}</strong><p>{t.taskPrompt}</p><small>{t.dependencies.length ? `前置任务：${t.dependencies.join('、')}` : '无前置依赖'}</small></div>)}</section></aside>
        <section className="panel padded"><div className="section-title"><h2>执行时间线</h2><select aria-label="事件类型" value={kind} onChange={e => setKind(e.target.value)}><option value="all">主要事件</option><option value="model/">模型请求与返回</option><option value="tool/">工具调用</option><option value="team/">团队操作与状态</option><option value="session/">会话事件</option><option value="raw">全部原始事件</option></select></div><p className="subcopy">展开模型请求可查看实际发送的消息与工具定义；岗位快照和任务快照分别保留。</p><div className="trace-timeline">{visible.map(e => <details key={e.seq} className="trace-event"><summary><span className="trace-dot"/><span><strong>{eventNames[e.type] ?? e.type}</strong><small>#{e.seq} · {new Date(e.at).toLocaleTimeString('zh-CN')}{e.taskId ? ` · 任务 ${e.taskId}` : ''}{e.sessionId ? ` · ${sessions.find(s => s.id === e.sessionId)?.name ?? '员工会话'}` : ''}</small><span className="trace-summary">{eventSummary(e)}</span></span></summary>{e.attemptId && <p className="trace-id">执行尝试：{e.attemptId}</p>}<pre>{JSON.stringify(e.data, null, 2)}</pre></details>)}</div>{!visible.length && <p className="compact-empty">此筛选下暂无事件。</p>}{detail.hasMore && <button onClick={async () => { try { const more = await api<Detail>(`/runs/${detail.id}?after=${detail.nextCursor}`); setDetail({ ...more, events: [...detail.events, ...more.events] }); } catch (e) { setError((e as Error).message); } }}>加载后续事件</button>}<p className="subcopy"><CheckCircle2 size={13}/> 记录来自本地持久化档案；页面刷新不会重跑任务。</p></section></div>
      </>}
    </>}
  </>;
}
