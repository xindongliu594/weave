import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, CheckCircle2, ChevronDown, LoaderCircle, MessageSquare, Plus, Settings2, ShieldCheck, Users } from 'lucide-react';
import { departmentSchema, planSchema, policySchema, type DepartmentInput, type Model, type Plan, type Policy } from '../../../packages/contracts/index.ts';
import { api, ApiError } from './api.ts';
import './OrganizationChat.css';

type Message = { role: 'user' | 'assistant'; content: string };
type Preview = { previewId: string; department: DepartmentInput; plan: Plan; policy: Policy; requirement: string; source: string; validation: { valid: boolean; errors: string[]; warnings?: string[] } };
type ChatRequest = { key: string; settings: string; body: { messages: Message[]; modelId: string; policy: Policy; templateId: string; maxPlanningCost: number; previousPreviewId?: string } };
type SavedTeam = { departmentId: string; projectId: string; departmentVersion: number; projectVersion: number; previewId: string };
type DraftIssue = { code: string; message: string };
type Draft = { messages: Message[]; modelId: string; policy: Policy; maxPlanningCost: number; input: string; preview?: Preview; previewSettings?: string; projectId?: string; saved?: SavedTeam; draftIssue?: DraftIssue; previousPreviewId?: string; pendingRequest?: ChatRequest; awaitingPlan?: boolean };
const storageKey = 'agent-department:organization-chat:v1';
const defaults: Policy = { maxBudget: 1, maxAgents: 4, maxConcurrentAgents: 2, deadlineSeconds: 3600, mode: 'recommended', preference: 'balanced', maxModelCalls: 100, maxTaskModelCalls: 40, contextBytes: 64000, allowedTools: ['filesystem', 'artifact_write', 'terminal_test'] };
const toolNames: Record<string, string> = { filesystem: '读取项目文件', artifact_write: '制作与修改文件', terminal_test: '申请运行测试' };
const examples = [
  ['开发一个项目', '我想开发一个 Todo API，支持任务的新增、查询、修改和删除，并安排独立测试和验收。请帮我组建合适的团队。'],
  ['整理业务资料', '我有一批业务资料，想整理成结构清晰的分析报告。请帮我安排资料整理、分析和复核的岗位。'],
  ['先聊聊想法', '我有一个项目想法，但还没想清楚具体怎么做。请先问我几个关键问题，再帮我组建部门。'],
];
function settingsFingerprint(value: unknown): string {
  function ordered(item: any): any { return Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item; }
  return JSON.stringify(ordered(value));
}
function initialDraft(): Draft {
  const empty = { messages: [], modelId: '', policy: defaults, maxPlanningCost: .1, input: '' };
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (!value || !Array.isArray(value.messages) || !value.messages.every((m: Message) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.length <= 6000)) return empty;
    const policy = policySchema.safeParse(value.policy);
    if (!policy.success || typeof value.modelId !== 'string' || !Number.isFinite(value.maxPlanningCost) || value.maxPlanningCost <= 0 || value.maxPlanningCost > 10) return empty;
    const preview = value.preview;
    if (preview && (!departmentSchema.safeParse(preview.department).success || !planSchema.safeParse(preview.plan).success || !policySchema.safeParse(preview.policy).success || typeof preview.previewId !== 'string' || !Array.isArray(preview.validation?.errors))) return empty;
    const previewSettings = typeof value.previewSettings === 'string' ? settingsFingerprint(JSON.parse(value.previewSettings)) : undefined;
    if (value.pendingRequest && (typeof value.pendingRequest.key !== 'string' || !Array.isArray(value.pendingRequest.body?.messages) || typeof value.pendingRequest.settings !== 'string')) delete value.pendingRequest;
    return { ...value, input: typeof value.input === 'string' ? value.input.slice(0, 6000) : '', policy: policy.data, previewSettings };
  } catch { return empty; }
}

export function OrganizationChat({ models, onSaved, onDepartments, onProject, onModels, demo = false, onDemo }: { models: Model[]; onSaved: () => Promise<void>; onDepartments: () => void; onProject: (projectId: string) => void; onModels: () => void; demo?: boolean; onDemo?: () => void }) {
  const [draft, setDraft] = useState<Draft>(initialDraft), [busy, setBusy] = useState<'chat' | 'save' | null>(null), [error, setError] = useState(''), [pending, setPending] = useState('');
  const end = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLTextAreaElement>(null), inFlight = useRef(false);
  const available = models.filter(m => m.status === 'available');
  const model = available.find(m => m.id === draft.modelId);
  const settingsKey = settingsFingerprint({ modelId: draft.modelId, policy: draft.policy, maxPlanningCost: draft.maxPlanningCost });
  const settingsChanged = !!draft.preview && settingsKey !== draft.previewSettings;
  const stale = settingsChanged || !!draft.input.trim() || !!draft.pendingRequest || !!draft.awaitingPlan;
  const savedCurrent = !!draft.preview && draft.preview.previewId === draft.saved?.previewId;
  const settingsValid = Number.isFinite(draft.maxPlanningCost) && draft.maxPlanningCost > 0 && draft.maxPlanningCost <= 10 && policySchema.safeParse(draft.policy).success;
  useEffect(() => { if (!draft.modelId && available.length) setDraft(value => ({ ...value, modelId: available[0].id })); }, [draft.modelId, models]);
  useEffect(() => { if (!demo && settingsValid) try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Conversation remains usable if browser storage is unavailable. */ } }, [draft, demo, settingsValid]);
  useEffect(() => { if (draft.messages.length || pending) end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [draft.messages.length, pending]);
  function changePolicy(patch: Partial<Policy>) { setDraft(value => ({ ...value, policy: { ...value.policy, ...patch } })); }
  function reset() {
    if ((draft.messages.length || draft.input) && !window.confirm('开始新需求将清除当前对话草稿。已经创建的部门和项目会保留。')) return;
    setDraft(value => ({ messages: [], modelId: value.modelId, policy: value.policy, maxPlanningCost: value.maxPlanningCost, input: '' })); setError(''); inputRef.current?.focus();
  }
  async function send() {
    const content = draft.input.trim() || (settingsChanged ? '请按照更新后的预算、人数和模型设置，重新调整部门方案。' : draft.awaitingPlan ? '请根据以上对话继续完善部门方案。' : '');
    if (!content || inFlight.current || busy || !model || demo || draft.pendingRequest || !settingsValid) return;
    const messages: Message[] = [...draft.messages, { role: 'user', content }];
    const requirementLength = messages.filter(item => item.role === 'user').map(item => item.content).join('\n\n').length;
    if (messages.reduce((total, item) => total + item.content.length, 0) > 200000 || requirementLength > 50000) { setError('这段对话的资料量已达到容量上限。可以先保存当前团队，再开始新需求继续。'); return; }
    const request: ChatRequest = { key: crypto.randomUUID(), settings: settingsKey, body: { messages, modelId: model.id, policy: draft.policy, templateId: 'software', maxPlanningCost: draft.maxPlanningCost, previousPreviewId: draft.preview?.previewId ?? draft.previousPreviewId } };
    const next = { ...draft, pendingRequest: request }; setDraft(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* The in-memory request remains recoverable. */ }
    await requestReply(request);
  }
  async function requestReply(request: ChatRequest) {
    if (inFlight.current || demo) return;
    inFlight.current = true; setBusy('chat'); setError(''); setPending(request.body.messages.at(-1)?.content ?? '');
    try {
      const result = await api<{ reply: string; preview?: Preview; draftIssue?: DraftIssue }>('/organizations/chat', 'POST', request.body, request.key);
      setDraft(value => ({ ...value, messages: [...request.body.messages, { role: 'assistant', content: result.reply }], input: '', preview: result.preview ?? value.preview, previewSettings: result.preview ? request.settings : value.previewSettings, previousPreviewId: result.preview?.previewId ?? value.preview?.previewId ?? value.previousPreviewId, awaitingPlan: result.preview ? false : !!result.draftIssue || value.awaitingPlan, draftIssue: result.preview ? undefined : result.draftIssue ?? value.draftIssue, pendingRequest: undefined }));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status !== 409) setDraft(value => ({ ...value, pendingRequest: undefined }));
      setError((cause as Error).message);
    }
    finally { inFlight.current = false; setBusy(null); setPending(''); }
  }
  async function save() {
    if (!draft.preview || inFlight.current || busy || stale || !draft.preview.validation.valid || savedCurrent) return;
    inFlight.current = true; setBusy('save'); setError('');
    try {
      let target = draft.saved && { departmentId: draft.saved.departmentId, projectId: draft.saved.projectId, departmentVersion: draft.saved.departmentVersion, projectVersion: draft.saved.projectVersion };
      // Resolve a draft saved by an earlier UI version before allowing another confirmation.
      if (!target && draft.projectId) {
        const [projects, departments] = await Promise.all([api<any[]>('/projects'), api<any[]>('/departments')]);
        const project = projects.find(item => item.id === draft.projectId), department = departments.find(item => item.id === project?.departmentId);
        if (!project || !department) throw Error('原团队或项目不存在，请查看部门与员工，或开始新需求。');
        target = { departmentId: department.id, projectId: project.id, departmentVersion: department.version, projectVersion: project.version };
      }
      const result = await api<Omit<SavedTeam, 'previewId'>>('/organizations', 'POST', { ...draft.preview, ...(target ? { target } : {}) });
      const next = { ...draft, projectId: result.projectId, saved: { ...result, previewId: draft.preview.previewId } };
      setDraft(next);
      try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Saved team remains recoverable from the department list. */ }
      await onSaved();
    } catch (cause) { setError((cause as Error).message); }
    finally { inFlight.current = false; setBusy(null); }
  }
  return <section className={'organization-chat' + (draft.messages.length || pending ? ' has-conversation' : '') + (draft.preview ? ' has-preview' : '')}>
    <div className="organization-heading"><div><span className="organization-kicker">一个想法，一支团队</span><h1>从需求组建部门</h1><p>说说你的目标，AI 为你组建团队。</p></div>{!!draft.messages.length && <button disabled={!!busy} onClick={reset}><Plus size={15}/>新需求</button>}</div>
    {demo ? <div className="panel padded"><h2>当前是固定响应演示空间</h2><p>对话组建部门需要在本机工作空间配置真实模型。这里可以先体验已准备好的 Todo 团队。</p><button className="primary lower-small" onClick={onDemo}>查看 Todo 示例方案 <ArrowRight size={15}/></button></div> : <>
    <div className={'organization-layout' + (draft.preview ? ' with-preview' : '')}>
      <div className="organization-conversation">
        <div className="organization-messages" role="log" aria-label="组建部门对话" aria-live="polite" hidden={!draft.messages.length && !pending}>
          {draft.messages.map((message, index) => <article className={'organization-message ' + message.role} key={index}><span className="organization-avatar">{message.role === 'user' ? '你' : <SparkleMark/>}</span><div><strong>{message.role === 'user' ? '你' : '组建助手'}</strong><p>{message.content}</p></div></article>)}
          {pending && <><article className="organization-message user"><span className="organization-avatar">你</span><div><strong>你</strong><p>{pending}</p></div></article><div className="organization-thinking" role="status"><LoaderCircle className="spin" size={16}/>正在理解需求、规划团队…</div></>}
          <div ref={end}/>
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}
        {draft.projectId && <div className="organization-saved" role="status"><CheckCircle2 size={19}/><div><strong>团队已保存到部门与员工</strong><p>可以继续对话调整，确认新方案后更新同一团队。</p><div className="organization-saved-actions"><button onClick={onDepartments}>查看部门与员工 <ArrowRight size={14}/></button><button onClick={() => onProject(draft.projectId!)}>查看执行方案</button></div></div></div>}
        {draft.draftIssue && <p className="organization-draft-issue" role="status">{draft.draftIssue.message}</p>}
        <>
          {!available.length && <div className="organization-connect"><div><strong>连接模型，开始对话</strong><p>配置 API 后即可使用，已写的需求会保留。</p></div><button onClick={onModels}>先连接模型 <ArrowRight size={14}/></button></div>}
          {draft.pendingRequest && !busy && <div className="organization-connect"><div><strong>上次回复的结果还未确认</strong><p>继续获取原请求的结果，避免重复发起模型调用。</p></div><button onClick={() => void requestReply(draft.pendingRequest!)}>继续获取回复</button></div>}
          <form className="organization-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
            <label className="sr-only" htmlFor="organization-message">描述需求或补充想法</label><textarea id="organization-message" ref={inputRef} rows={3} maxLength={6000} disabled={!!busy || !!draft.pendingRequest} value={draft.input} placeholder={draft.messages.length ? '继续补充，或告诉我哪里需要调整…' : '描述你想完成的事…'} onChange={event => setDraft(value => ({ ...value, input: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/>
            <div className="organization-composer-actions"><select aria-label="负责组建的模型" disabled={!!busy || !!draft.pendingRequest} value={draft.modelId} onChange={event => setDraft(value => ({ ...value, modelId: event.target.value }))}><option value="">选择模型</option>{draft.modelId && !model && <option value={draft.modelId} disabled>原模型不可用，请重新选择</option>}{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="primary organization-send" aria-label="发送需求" title="发送需求（Ctrl / ⌘ + Enter）" disabled={!!busy || !!draft.pendingRequest || !model || !settingsValid || (!draft.input.trim() && !settingsChanged && !draft.awaitingPlan)} type="submit">{busy === 'chat' ? <LoaderCircle className="spin" size={19}/> : <ArrowUp size={19}/>}</button></div>
          </form>
          <div className="organization-composer-note"><span>每轮上限 ${Number.isFinite(draft.maxPlanningCost) ? draft.maxPlanningCost : '—'}</span><span className="organization-shortcut">Ctrl / ⌘ + Enter 发送</span></div>
          {!draft.messages.length && !pending && <div className="organization-examples" aria-label="需求示例">{examples.map(([title, content]) => <button key={title} disabled={!!busy || !!draft.pendingRequest} onClick={() => { setDraft(value => ({ ...value, input: content })); inputRef.current?.focus(); }}>{title}<ArrowRight size={13}/></button>)}</div>}
          <details className="organization-settings"><summary><Settings2 size={14}/>组建设置 <span>最多 {Number.isFinite(draft.policy.maxAgents) ? draft.policy.maxAgents : '—'} 人 · 预算 ${Number.isFinite(draft.policy.maxBudget) ? draft.policy.maxBudget : '—'}</span><ChevronDown className="organization-settings-chevron" size={14}/></summary><fieldset disabled={!!busy || !!draft.pendingRequest}><p className="subcopy">设置用于下一次对话。修改后重新生成方案，再确认创建。</p><div className="form-grid"><label className="field">项目预算（USD）<input type="number" min={.01} max={10000} step="any" value={Number.isFinite(draft.policy.maxBudget) ? draft.policy.maxBudget : ''} onChange={event => changePolicy({ maxBudget: event.target.valueAsNumber })}/></label><label className="field">部门最多人数（含经理）<input type="number" min={1} max={6} step={1} value={Number.isFinite(draft.policy.maxAgents) ? draft.policy.maxAgents : ''} onChange={event => changePolicy({ maxAgents: event.target.valueAsNumber, maxConcurrentAgents: Math.min(event.target.valueAsNumber, 2) })}/></label><label className="field">单次回复费用上限（USD）<input type="number" min={.000001} max={10} step="any" value={Number.isFinite(draft.maxPlanningCost) ? draft.maxPlanningCost : ''} onChange={event => setDraft(value => ({ ...value, maxPlanningCost: event.target.valueAsNumber }))}/></label></div><p className="organization-fee">模型调用按已配置服务计费。项目预算包含已保存方案的规划与执行，其余对话另计。</p><p className="subcopy">可为员工建议的工作能力</p><div className="organization-tool-options">{Object.entries(toolNames).map(([tool, label]) => <label key={tool}><input type="checkbox" checked={draft.policy.allowedTools?.includes(tool as any) ?? false} onChange={event => changePolicy({ allowedTools: event.target.checked ? [...(draft.policy.allowedTools ?? []), tool as any] : draft.policy.allowedTools?.filter(item => item !== tool) })}/>{label}</label>)}</div><small>创建后还需批准项目才会执行；运行测试命令需逐次确认。</small></fieldset></details>
        </>
      </div>
      {draft.preview && <aside className="organization-preview" aria-label="部门方案预览"><div className="organization-preview-head"><span><Users size={17}/>团队方案</span><span className="tag">{draft.awaitingPlan ? '上一份方案' : savedCurrent ? '已保存' : draft.projectId ? '待确认更新' : '待确认'}</span></div><h2>{draft.preview.department.name}</h2><p>{draft.preview.department.description}</p><div className="organization-draft-meta"><span>{draft.preview.department.agents.length} 位员工</span><span>{draft.preview.plan.tasks.length} 项任务</span><span>预算 ${draft.preview.policy.maxBudget}</span></div>
        <div className="organization-roles">{draft.preview.department.agents.map(agent => <article key={agent.id}><div className="organization-role-title"><span className="organization-role-icon">{agent.role === 'manager' ? <ShieldCheck size={18}/> : <Users size={18}/>}</span><div><strong>{agent.name}</strong><small>{agent.role === 'manager' ? '部门经理' : agent.title}</small></div></div><p>{agent.instructions}</p><div className="organization-role-tools">{agent.tools.length ? agent.tools.map(tool => <span key={tool}>{toolNames[tool] ?? tool}</span>) : <span>分析与协作</span>}</div></article>)}</div>
        <details className="organization-task-details"><summary>查看任务与验收标准</summary><ol>{draft.preview.plan.tasks.map(task => <li key={task.id}><strong>{task.subject}</strong><small>{draft.preview!.department.agents.find(agent => agent.id === task.assigneeId)?.name}{task.dependencies.length ? ' · 前置任务：' + task.dependencies.map(id => draft.preview!.plan.tasks.find(item => item.id === id)?.subject ?? id).join('、') : ' · 可先开始'}</small><p>{task.objective}</p><ul>{task.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></li>)}</ol></details>
        <p className="organization-rationale">{draft.preview.plan.rationale}</p>
        {!draft.preview.validation.valid && <p className="banner error">{draft.preview.validation.errors.join('；')}</p>}
        {stale && <p className="organization-stale">{draft.awaitingPlan ? '上一份方案已保留。请继续补充需求，生成有效的新方案后再确认。' : '需求或设置有调整。请发送补充，更新方案后再确认。'}</p>}
        <button className="primary organization-confirm" disabled={!!busy || stale || !draft.preview.validation.valid || savedCurrent} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={16}/> : <CheckCircle2 size={16}/>} {savedCurrent ? '团队已保存' : draft.projectId ? '确认更新团队' : '确认组建团队'}</button><small>确认后保存到部门与员工。任务执行需在项目方案中批准。</small>
      </aside>}
    </div></>}
  </section>;
}
function SparkleMark() { return <MessageSquare size={17}/>; }
