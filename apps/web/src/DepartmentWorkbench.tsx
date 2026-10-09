import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Clock3, FileText, Inbox, Plus, RefreshCw, Settings2, ShieldCheck, Users } from 'lucide-react';
import type { Department } from '../../../packages/contracts/index.ts';
import { api } from './api.ts';
import { groupWorkbenchItems, workbenchItemLabel, type DepartmentWorkbenchData, type WorkbenchItem } from './department-workbench-view.ts';
import { OpenRigProjectLink, useOpenRigWorkbench } from './OpenRigWorkbench.tsx';
import './DepartmentWorkbench.css';

type Props = {
  departments: Department[]; selectedDepartmentId: string | null;
  onDepartment: (id: string) => void; onNewDepartment: () => void;
  onNewRequest: (id: string) => void; onEditDepartment: (department: Department) => void;
  onProject: (id: string) => void; onProjects: () => void; onCosts: () => void;
};
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function WorkItem({ item, completed = false, onProject, openRig }: { item: WorkbenchItem; completed?: boolean; onProject: (id: string) => void; openRig: ReturnType<typeof useOpenRigWorkbench> }) {
  const run = completed ? item.completedRun : item.latestRun;
  const title = item.requirement.trim().split(/\r?\n/, 1)[0];
  const label = completed ? `执行已完成 · 方案 v${run!.projectVersion}` : workbenchItemLabel(item);
  return <article className="workbench-item">
    <span className={'workbench-item-state ' + (completed ? 'done' : item.bucket)}>{label}</span>
    <h3 title={title}>{title || '项目需求'}</h3>
    <small>{date(completed ? run!.finishedAt ?? run!.createdAt : item.createdAt)}{!completed && ` · 方案 v${item.version}`}</small>
    {!completed && item.bucket === 'attention' && run?.error && <p className="workbench-failure">{run.error}</p>}
    <div className="workbench-item-actions">
      {run && <a href={'#run/' + encodeURIComponent(run.id)}>{completed ? '查看验收与交付' : (run.pendingApprovalCount ?? 0) > 0 ? '处理审批' : item.bucket === 'attention' ? '查看原因与恢复' : '查看执行'} <ArrowRight size={13}/></a>}
      <button className="text-button" onClick={() => onProject(item.id)}>{run ? '需求与方案' : '完善与确认方案'}{!run && <ArrowRight size={13}/>}</button>
    </div>
    <OpenRigProjectLink projectId={item.id} version={item.version} state={openRig}/>
  </article>;
}

export function DepartmentWorkbench({ departments, selectedDepartmentId, onDepartment, onNewDepartment, onNewRequest, onEditDepartment, onProject, onProjects, onCosts }: Props) {
  const department = departments.find(item => item.id === selectedDepartmentId) ?? departments[0];
  const departmentId = department?.id;
  const [page, setPage] = useState({ departmentId, offset: 0 });
  const offset = page.departmentId === departmentId ? page.offset : 0;
  const [data, setData] = useState<DepartmentWorkbenchData | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const visible = data?.departmentId === departmentId && data.offset === offset ? data : null;
  const openRig = useOpenRigWorkbench(departmentId, visible?.items ?? [], visible?.refreshedAt);

  useEffect(() => {
    if (!departmentId) return;
    let active = true, serial = 0, controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
    async function load() {
      stopTimer(); controller?.abort(); const ticket = ++serial; controller = new AbortController();
      setRefreshing(true); setError('');
      try {
        const value = await api<DepartmentWorkbenchData>(`/department-workbench?departmentId=${encodeURIComponent(departmentId!)}&offset=${offset}&limit=100`, 'GET', undefined, undefined, controller.signal);
        if (!active || ticket !== serial) return;
        setData(value);
        if (!document.hidden && (value.summary.running > 0 || value.summary.pendingApprovals > 0)) timer = setTimeout(() => void load(), 8000);
      } catch (failure) {
        if (active && ticket === serial && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '工作台读取失败，请刷新。');
      } finally { if (active && ticket === serial) setRefreshing(false); }
    }
    const visibility = () => { stopTimer(); if (document.hidden) { serial++; controller?.abort(); setRefreshing(false); } else void load(); };
    document.addEventListener('visibilitychange', visibility);
    if (!document.hidden) void load();
    return () => { active = false; serial++; stopTimer(); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [departmentId, offset, revision]);

  if (!department) return <section className="workbench-empty panel">
    <span className="department-icon"><Users size={24}/></span><div className="eyebrow">YOUR DEPARTMENT</div>
    <h1>让团队，从这里开始工作。</h1><p>先说明目标、确认团队方案。部门保存后，可以持续接收新的需求。</p>
    <button className="primary" onClick={onNewDepartment}><Plus size={16}/>组建第一个部门</button>
  </section>;

  const groups = groupWorkbenchItems(visible?.items ?? []);
  const columns = [
    { key: 'attention', title: '需要我处理', icon: ShieldCheck, hint: '审批、失败与中断', empty: '当前页没有需要处理的项目' },
    { key: 'running', title: '正在进行', icon: Clock3, hint: '已批准的排队与执行', empty: '当前页没有正在执行的项目' },
    { key: 'backlog', title: '部门待办', icon: Inbox, hint: '已保存，等待确认方案', empty: '当前页没有待确认的需求' },
    { key: 'completed', title: '最近完成', icon: CheckCircle2, hint: '查看原运行的验收与文件', empty: '当前页还没有已完成的运行' },
  ] as const;
  return <div className="department-workbench">
    <div className="page-head"><div><div className="eyebrow">DEPARTMENT WORKBENCH</div><h1>部门工作台</h1><p>需求、进度与交付，都回到同一个团队。</p></div><button className="primary" onClick={() => onNewRequest(department.id)}><Plus size={16}/>给部门提需求</button></div>
    <section className="workbench-team panel">
      <div className="workbench-team-heading"><span className="department-icon"><Users size={22}/></span><label className="workbench-department"><span>当前部门</span><select aria-label="当前部门" value={department.id} onChange={event => onDepartment(event.target.value)}>{departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="text-button" onClick={() => onEditDepartment(department)}><Settings2 size={14}/>配置团队</button></div>
      {department.description && <p className="workbench-description"><span>部门说明</span>{department.description}<small>项目预算以各项目的当前方案为准。</small></p>}
      <div className="member-chips">{department.agents.map(agent => <span key={agent.id} title={agent.instructions}>{agent.role === 'manager' && <ShieldCheck size={13}/>} {agent.name}<small>{agent.title}</small></span>)}</div>
      <div className="workbench-team-footer"><span>{department.agents.length} 位员工 · 部门配置 v{department.version} · 方案确认后执行</span><button className="text-button" onClick={onNewDepartment}>组建其他部门 <Plus size={13}/></button></div>
    </section>
    <div className="workbench-toolbar"><p role="status">{error ? '更新未成功；已读取的内容可能已过时。' : visible ? `${refreshing ? '正在更新 · ' : ''}更新于 ${date(visible.refreshedAt)}${visible.summary.running || visible.summary.pendingApprovals ? ' · 执行期间自动更新' : ''}` : refreshing ? '正在读取部门工作…' : '等待读取部门工作'}</p><button disabled={refreshing} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/>刷新</button></div>
    {error && <div className="banner error" role="alert">{error}</div>}
    <div className="workbench-metrics">
      {columns.map(column => <div key={column.key}><span>{column.title}</span><strong>{visible ? visible.summary[column.key] : '—'}</strong><small>{column.key === 'attention' && visible?.summary.pendingApprovals ? `${visible.summary.pendingApprovals} 项工具审批` : column.hint}</small></div>)}
      <button onClick={onCosts}><span>部门已登记费用</span><strong>{visible ? '$' + Number(visible.summary.recordedCost).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '—'}</strong><small>查看待核对费用与账单 <ArrowRight size={12}/></small></button>
    </div>
    {visible && <><div className="workbench-page-summary"><p>共 {visible.summary.total} 个项目{visible.summary.total > visible.limit && ` · 当前第 ${offset + 1}–${Math.min(offset + visible.items.length, visible.summary.total)} 项；上方数量覆盖整个部门`}</p><button className="text-button" onClick={onProjects}>全部项目 <FileText size={13}/></button></div>
      <div className="workbench-board">{columns.map(column => <section key={column.key} className={'workbench-column ' + column.key} aria-labelledby={'workbench-' + column.key}><div className="workbench-column-heading"><column.icon size={17}/><h2 id={'workbench-' + column.key}>{column.title}</h2><span>{groups[column.key].length}</span></div><p className="workbench-column-hint">{column.hint}</p>{groups[column.key].length ? groups[column.key].map(item => <WorkItem key={item.id} item={item} completed={column.key === 'completed'} onProject={onProject} openRig={openRig}/>) : <p className="workbench-column-empty">{column.empty}</p>}</section>)}</div>
      {(offset > 0 || visible.hasMore) && <div className="workbench-pagination"><button disabled={offset === 0 || refreshing} onClick={() => setPage({ departmentId, offset: Math.max(0, offset - visible.limit) })}>上一页</button><span>每页最多 {visible.limit} 个项目</span><button disabled={!visible.hasMore || refreshing} onClick={() => setPage({ departmentId, offset: offset + visible.limit })}>下一页</button></div>}
      <p className="workbench-footnote">待办来自已保存的项目。完成区保留历史运行；验收结论、真实测试和交付文件请打开运行记录查看。</p>
      {openRig.status?.enabled && <p className="workbench-footnote" role="status">OpenRig 记录显式同步的待办；实际执行与验收由为伍负责。{openRig.status.error && <span> {openRig.status.error.message}</span>}</p>}
    </>}
  </div>;
}
