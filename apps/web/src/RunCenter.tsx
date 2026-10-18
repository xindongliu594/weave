import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock3, Play, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api } from './api.ts';
import { RunExtras } from './RunExtras.tsx';
import { mergeRunDetailPage } from './run-detail-view.ts';
import { visibleRunTraceEvents } from './run-events.ts';
import type { RunSummary, RunDetail, TraceEvent } from '../../../services/agent-runtime/trace-store.mjs';

type Detail = RunDetail & { error?: string; hasMore: boolean; nextCursor: number; summaryEvents?: TraceEvent[];recovery?:{unknownOperations:any[];checkpointBlocked?:string;planningBlocked?:string;costBlocked?:string} };
const date = (value: string) => new Date(value).toLocaleString('zh-CN');
const stateName: Record<string, string> = { running:'运行中',queued: '排队中', interrupted: '已中断', completed: '已完成', failed: '失败', cancelled: '已取消', unfinished: '运行中 / 可能中断', incomplete: '记录不完整' };
const eventNames: Record<string, string> = {
  'capability/searched':'检索员工获授权的知识、方法与工具', 'capability/adopted':'登记实际采用声明',
  'skill/catalog':'加载员工获授权的工作方法目录', 'skill/loaded':'读取已批准的工作方法',
  'runtime/model-settling':'核对在途模型用量', 'runtime/model-settled':'在途模型收尾结果',
  'run/created': '创建运行档案', 'run/queued': '进入执行队列', 'run/captain': '绑定协调经理', 'run/task-mapping': '任务编号映射', 'run/approved': '确认启动', 'run/started': '团队开始执行', 'run/deadline-exceeded': '达到已批准的运行时限', 'run/finished': '运行结束', 'billing/usage': '记录执行用量', 'billing/unconfirmed': '调用费用待核对', 'budget/warning': '预算阈值提醒', 'budget/stopped': '预算或调用次数停止',
  'session/created': '创建员工会话', 'agent/created': '加载员工模型', 'model/wire-request': '实际发送的模型请求', 'model/fallback': '切换备用模型', 'context/compacted': '整理上下文', 'approval/requested': '请求工具审批', 'approval/decided': '用户处理审批', 'knowledge/citation': '引用知识资料', 'artifact/updated': '更新交付物', 'model/request': '运行时原始上下文', 'model/finish': '模型返回', 'model/error': '模型调用失败', 'model/usage': '模型用量',
  'tool/start': '开始调用工具', 'tool/result': '工具执行结果', 'team/operation': '团队操作', 'team/snapshot': '团队状态快照',
  'handoff/inputs-bound': '固定任务输入版本', 'handoff/accepted': '核验并接收交付物', 'handoff/blocked': '交接条件未满足', 'handoff/command-observed': '记录验证命令结果',
  'quality/review-submitted': '提交结构化审查问题', 'quality/reviewed': '独立审查通过', 'quality/rework-created': '授权范围内修复与独立复验', 'quality/escalated': '停止返工并交给用户处理',
  'runtime/status':'员工运行状态','runtime/anomaly':'发现停滞或重复失败','runtime/read-retry':'重试短暂失败的只读操作','runtime/outcome-unknown':'操作结果需要核对','team/checkpoint':'保存任务检查点','recovery/restored':'恢复任务图与工作资料','recovery/read':'查阅断点前的历史记录',
  'local/device-bound':'绑定本机工作区','local/operation-queued':'派发获授权的本机操作','local/operation-finished':'收到本机操作回执',
  'session/user/message': '收到任务或追加指令', 'session/system/message': '实际系统提示词', 'session/assistant/message': '员工回复', 'session/turn/start': '开始工作', 'session/turn/end': '本轮结束',
  'context/pruned': '缩减工具结果并保留证据', 'context/summarized': '生成员工历史摘要', 'context/capacity-unknown': '使用工具缩减保护上下文',
  'session/compaction/summary': '摘要内容、来源和用量', 'session/compaction/prune': '工具缩减来源', 'session/compaction/end': '历史整理结束',
};
export function eventSummary(e: TraceEvent) {
  if(e.type==='capability/searched')return `${e.data.query} · 知识 ${e.data.knowledge?.length??0} · 方法 ${e.data.skills?.length??0} · 工具 ${e.data.tools?.length??0}`;
  if(e.type==='capability/adopted')return `${e.data.note} · 来源 v${e.data.source?.version??'?'} · 验收结果见工作记录`;
  if (e.type === 'model/request') return `${e.data.provider} / ${e.data.model}`;
  if (typeof e.data.name === 'string') return e.data.name;
  if (e.type === 'team/snapshot') return `${e.data.phase} · ${e.data.tasks?.filter((t: any) => t.status === 'completed').length ?? 0}/${e.data.tasks?.length ?? 0} 项完成`;
  const value = e.data.description ?? e.data.message;
  if (typeof value === 'string') return value.slice(0, 180);
  if (Array.isArray(value?.content)) {
    let summary = '';
    for(const block of value.content) {
      if(summary.length >= 180) break;
      if(block.type === 'text' && typeof block.text === 'string') summary += (summary ? ' ' : '') + block.text.slice(0, 180 - summary.length);
    }
    return summary.slice(0, 180);
  }
  return '';
}
export function RunTraceEventBody({event,open}:{event:TraceEvent;open:boolean}) {
  const text = useMemo(() => open ? JSON.stringify(event.data, null, 2) : undefined, [open, event.data]);
  return open ? <>{event.attemptId && <p className="trace-id">执行尝试：{event.attemptId}</p>}<pre>{text}</pre></> : null;
}
export function RunTraceEvent({event,employeeName}:{event:TraceEvent;employeeName?:string}) {
  const [open,setOpen]=useState(false);
  return <details className="trace-event" onToggle={e=>setOpen(e.currentTarget.open)}><summary><span className="trace-dot"/><span><strong>{eventNames[event.type] ?? event.type}</strong><small>#{event.seq} · {new Date(event.at).toLocaleTimeString('zh-CN')}{event.taskId ? ` · 任务 ${event.taskId}` : ''}{event.sessionId ? ` · ${employeeName ?? '员工会话'}` : ''}</small><span className="trace-summary">{eventSummary(event)}</span></span></summary>{open&&<RunTraceEventBody event={event} open/>}</details>;
}
const namedEventTypes = new Set(Object.keys(eventNames));

export function RunCenter({onOpenProject}:{onOpenProject:(id:string)=>void}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => { const id = location.hash.split('/')[1]; return /^[a-f0-9-]{36}$/.test(id ?? '') ? id : null; });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError,setDetailError]=useState(''),[detailRefresh,setDetailRefresh]=useState(0);
  const latestDetail=useRef<Detail|null>(null);latestDetail.current=detail;
  const [employee, setEmployee] = useState('');
  const [kind, setKind] = useState('all');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  async function refresh() { setRuns(await api<RunSummary[]>('/runs')); }
  async function refreshDetail() {
    if (!selected) return;
    const current = latestDetail.current;
    const more = await api<Detail>(`/runs/${selected}?limit=30&after=${current?.id === selected ? current.nextCursor : 0}`);
    setDetail(current => current?.id === selected ? mergeRunDetailPage(current, more) : current);
  }
  useEffect(() => { refresh().catch(e => setError(e.message)).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    const update=()=>{const [page,id]=location.hash.slice(1).split('/');if(page==='run')setSelected(/^[a-f0-9-]{36}$/.test(id??'')?id:null);};
    window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);
  }, []);
  useEffect(() => {
    history.replaceState(null, '', selected ? '#run/' + selected : '#run');
    if (!selected) { setDetail(null); return; }
    let active = true;
    setDetail(null); setEmployee(''); setError('');setDetailError('');
    api<Detail>(`/runs/${selected}?limit=30`).then(d => { if (active) setDetail(d); }).catch(e => { if (active) setDetailError(e.message); });
    return () => { active = false; };
  }, [selected,detailRefresh]);
  useEffect(() => {
    if (!selected || !['unfinished','queued','running'].includes(detail?.status ?? '')) return;
    let active=true,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{
        const more=await api<Detail>(`/runs/${selected}?limit=30&after=${latestDetail.current?.nextCursor??0}`);
        if(!active)return;
        setDetail(current=>current?.id===selected?mergeRunDetailPage(current,more):current);
        await refresh();
      }catch(e){if(active)setError((e as Error).message);}
      finally{if(active)timer=setTimeout(()=>void poll(),1000);}
    };
    timer=setTimeout(()=>void poll(),1000);
    return()=>{active=false;clearTimeout(timer);};
  }, [selected, detail?.status]);
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
  const visible = useMemo(()=>visibleRunTraceEvents(detail?.events??[],kind,employee,namedEventTypes),[detail?.events,kind,employee]);
  const assigned = detail?.snapshot.agents.find(a => a.id === sessions.find(s => s.id === employee)?.agentId);
  return <>
    <div className="page-head"><div><div className="eyebrow">EXECUTION HISTORY</div><h1>执行记录</h1><p>查看当时的职责、任务指令和实际操作。历史快照独立保留。</p></div><button className="primary" disabled={busy} onClick={verify}><Play size={16}/>{busy ? '正在验证…' : '运行追溯验证'}</button></div>
    <div className="notice-box"><ShieldCheck size={18}/><p>工具执行受岗位授权约束；文件与终端按批准的执行位置操作，终端需要逐次审批。追溯验证使用测试模型，不会调用真实 API。</p></div>
    {error && <div className="banner error" role="alert">{error}</div>}
    {!selected ? <section className="panel lower"><div className="trace-list-head"><h2>历史运行</h2><button onClick={() => refresh().catch(e => setError(e.message))}><RefreshCw size={14}/>刷新</button></div>{loading ? <p className="compact-empty">正在读取本地档案…</p> : runs.length ? runs.map(run => <button className="project-row run-list-row" key={run.id} onClick={() => setSelected(run.id)}><Clock3 size={20}/><span><strong>{run.title}</strong><small>{date(run.createdAt)} · {run.eventCount} 条事件</small></span><span className="tag">{run.mode === 'fixture' ? '测试模型' : run.mode}</span><span className={'tag ' + (run.status === 'completed' ? 'green' : 'amber')}>{stateName[run.status] ?? run.status}</span></button>) : <div className="empty"><Search size={28}/><h3>还没有执行记录</h3><p>运行一次追溯验证，查看真实采集的团队过程。</p></div>}</section> : <>
      <button className="text-button back lower" onClick={() => setSelected(null)}><ArrowLeft size={15}/>返回运行列表</button>
      {!detail ? detailError?<div className="notice-box" role="alert"><p>{detailError}</p><button onClick={()=>setDetailRefresh(value=>value+1)}>重新读取运行记录</button></div>:<p>正在读取运行记录…</p> : <>
<section className="panel padded run-overview"><div className="run-detail-heading"><h2 className="run-detail-title" title={detail.title}>{detail.title}</h2><div className="run-detail-actions"><span className="tag">{detail.mode === 'fixture' ? '测试模型验证' : '正式项目'}</span><span className="tag">{stateName[detail.status]}</span>{detail.mode === 'product' && ['unfinished','queued','running'].includes(detail.status) && <button onClick={async () => { try { await api(`/runs/${detail.id}/cancel`, 'POST', {}); } catch (e) { setError((e as Error).message); } }}>停止运行</button>}</div></div><p className="trace-id">Run ID：{detail.id}</p><details className="run-requirement"><summary>查看完整需求</summary><div className="project-requirement-full">{detail.snapshot.requirement}</div></details><small>方案 v{detail.snapshot.planVersion} · 模板 {detail.snapshot.templateVersion} · {detail.eventCount} 条事件</small>{detail.integrity !== 'ok' && <p className="validation-error">档案完整性检查未通过，不能视为完整执行记录。</p>}</section>
        <RunExtras key={detail.id} id={detail.id} status={detail.status} integrity={detail.integrity} events={detail.summaryEvents ?? detail.events} traceEvents={detail.events} snapshot={detail.snapshot} recovery={detail.recovery} runError={detail.error} onOpenProject={onOpenProject} onRefreshDetail={refreshDetail}/>
        <div className="trace-layout lower"><aside><section className="panel padded"><h3>员工与岗位快照</h3><button className={'trace-member ' + (!employee ? 'selected' : '')} onClick={() => setEmployee('')}>全部员工与运行操作</button>{sessions.map(s => <button key={s.id} className={'trace-member ' + (employee === s.id ? 'selected' : '')} onClick={() => setEmployee(s.id)}><strong>{s.name}</strong><small>{s.model}</small></button>)}{assigned && <div className="trace-role"><span className="tag">岗位提示词 v{assigned.roleVersion}</span><p>{assigned.rolePrompt}</p></div>}</section><section className="panel padded lower"><h3>本次任务提示词</h3>{detail.snapshot.tasks.filter(t => !assigned || t.assignee === assigned.id).map(t => <details className="trace-task trace-task-prompt" key={t.id}><summary><strong>{t.subject}</strong><small>查看完整任务提示词</small></summary><p className="trace-prompt-content">{t.taskPrompt}</p><small>{t.dependencies.length ? `前置任务：${t.dependencies.join('、')}` : '无前置依赖'}</small></details>)}</section></aside>
        <section className="panel padded"><div className="section-title"><h2>执行时间线</h2><select aria-label="事件类型" value={kind} onChange={e => setKind(e.target.value)}><option value="all">主要事件</option><option value="model/">模型请求与返回</option><option value="tool/">工具调用</option><option value="team/">团队操作与状态</option><option value="session/">会话事件</option><option value="raw">全部原始事件</option></select></div><p className="subcopy">主要事件默认省略例行团队状态快照和成功轮询；可切换团队、工具或全部原始事件查看。展开事件才渲染正文，实际消息与工具定义保持完整。</p><div className="trace-timeline">{visible.map(e => <RunTraceEvent key={e.seq} event={e} employeeName={sessions.find(s => s.id === e.sessionId)?.name}/>)}</div>{!visible.length && <p className="compact-empty">此筛选下暂无事件。</p>}{detail.hasMore && <button onClick={async () => { try { await refreshDetail(); } catch (e) { setError((e as Error).message); } }}>加载后续事件</button>}<p className="subcopy"><CheckCircle2 size={13}/> 记录来自本地持久化档案；页面刷新不会重跑任务。</p></section></div>
      </>}
    </>}
  </>;
}
