import { useRef, useState } from 'react';
import type { Model, Plan, Policy, Project, Validation } from '../../../packages/contracts/index.ts';
import type { CostReadiness } from './CostCarryoverChoice.tsx';
import type { PlanningExecutionContext } from '../../api/src/planning-execution-context.ts';
import { api, ApiError } from './api.ts';
import { PlanTaskBudgetSummary } from './PlanTaskBudget.tsx';
import { notifyCostsChanged } from './usage-sync.ts';

export type PlanningParameters = { projectId: string; version: number; modelId: string; maxPlanningCost: number; maxOutputTokens: number; retainUncertainCosts?: boolean; revisionRequest?: string };
export type PlanningQuote = PlanningParameters & {
  checkedAt: string; reservation: number; inputBytes: number; rates: { inputRate: number; outputRate: number };
  costReadiness: CostReadiness; allowed: boolean; reasons: { code: string; message: string }[]; nativeExecutionChecked: false;
  executionHistory?: PlanningExecutionContext; savedPlanIncluded?: true;
  conversation?: {sha256:string;messageIds:string[];count:number;omitted:number;pendingCount:number};
  retainedCostEvidence?: { retained: boolean; recordedCost: number; reserved: number; availableBudget: number; receipts: CostReadiness['receipts'] };
};
export type GeneratedPlan = { previewId: string; projectId: string; baseVersion: number; plan: Plan; policy: Policy; validation: Validation; usageId: string; retainUncertainCosts?: boolean; revisionRequest?: string;conversation?:PlanningQuote['conversation'] };
export type ConfirmedPlan = { ok: true; version: number; existing?: true; validation?: Validation; costReadiness?: CostReadiness };
export type PlanningClient = <T>(path: string, method?: string, body?: unknown, requestKey?: string) => Promise<T>;
export type GenerationRequest = { key: string; parameters: PlanningParameters };
export type ConfirmationRequest = { key: string; previewId: string; version: number; retainUncertainCosts?: boolean };
const dollars = (value: number) => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function defaultPlanningParameters(project: Pick<Project, 'id' | 'version' | 'policy'>): PlanningParameters {
  return { projectId: project.id, version: project.version, modelId: '', maxPlanningCost: Math.min(1, project.policy.maxBudget * .1), maxOutputTokens: 5000, retainUncertainCosts: false };
}
export function planningParametersValid(value: PlanningParameters) {
  return !!value.projectId && Number.isInteger(value.version) && value.version > 0 && !!value.modelId
    && Number.isFinite(value.maxPlanningCost) && value.maxPlanningCost > 0 && value.maxPlanningCost <= 100
    && Number.isInteger(value.maxOutputTokens) && value.maxOutputTokens >= 1 && value.maxOutputTokens <= 32768
    && (value.retainUncertainCosts === undefined || typeof value.retainUncertainCosts === 'boolean')
    && (value.revisionRequest === undefined || typeof value.revisionRequest === 'string' && value.revisionRequest.length <= 4000);
}
export function planningQuoteMatches(quote: PlanningQuote | undefined, parameters: PlanningParameters) {
  return !!quote && quote.projectId === parameters.projectId && quote.version === parameters.version && quote.modelId === parameters.modelId
    && quote.maxPlanningCost === parameters.maxPlanningCost && quote.maxOutputTokens === parameters.maxOutputTokens
    && quote.revisionRequest === parameters.revisionRequest
    && (quote.retainUncertainCosts === undefined || typeof quote.retainUncertainCosts === 'boolean')
    && (quote.retainUncertainCosts !== true || !!quote.retainedCostEvidence)
    && (quote.retainUncertainCosts === true) === (parameters.retainUncertainCosts === true);
}
/** The timestamp is informational; changes to fees, rates or the request need fresh consent. */
export function planningQuoteKey(quote: PlanningQuote) {
  const costs = quote.costReadiness;
  return JSON.stringify([quote.projectId, quote.version, quote.modelId, quote.maxPlanningCost, quote.maxOutputTokens, quote.retainUncertainCosts === true, quote.revisionRequest,
    quote.reservation, quote.inputBytes, quote.rates, quote.allowed, quote.reasons, costs.recordedCost, costs.reserved,
    costs.availableBudget, costs.pendingCount, costs.uncertainCount,
    costs.receipts.map(receipt => [receipt.id, receipt.amount, receipt.status, receipt.runId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    quote.retainedCostEvidence, quote.savedPlanIncluded, quote.executionHistory,quote.conversation]);
}
export async function readPlanningQuote(parameters: PlanningParameters, client: PlanningClient = api) {
  if (!planningParametersValid(parameters)) throw new Error('请选择规划模型，并填写有效的单次规划限额和输出上限。');
  const quote = await client<PlanningQuote>(`/projects/${encodeURIComponent(parameters.projectId)}/planning-quote`, 'POST', {
    modelId: parameters.modelId, version: parameters.version, maxPlanningCost: parameters.maxPlanningCost, maxOutputTokens: parameters.maxOutputTokens,
    ...(parameters.retainUncertainCosts === undefined ? {} : { retainUncertainCosts: parameters.retainUncertainCosts }),
    ...(parameters.revisionRequest === undefined ? {} : { revisionRequest: parameters.revisionRequest }),
  });
  if (!planningQuoteMatches(quote, parameters)) throw new Error('预检返回的项目、版本或参数不一致，请重新检查。');
  return quote;
}
/** A generation always rechecks; an altered or refused quote cannot submit a model request. */
export async function generatePlanningCandidate(parameters: PlanningParameters, visibleQuote: PlanningQuote,
  requestKey: string, client: PlanningClient = api, onSubmit?: () => void) {
  if (!planningQuoteMatches(visibleQuote, parameters) || !visibleQuote.allowed) throw new Error('请先完成当前参数的费用预检。');
  const quote = await readPlanningQuote(parameters, client);
  if (!quote.allowed || planningQuoteKey(quote) !== planningQuoteKey(visibleQuote)) return { kind: 'recheck' as const, quote };
  onSubmit?.();
  const candidate = await readPlanningGeneration({ key: requestKey, parameters }, client);
  return { kind: 'candidate' as const, candidate, quote };
}
/** Explicit continuation always keeps the original body and idempotency key. */
export async function readPlanningGeneration({ key, parameters }: GenerationRequest, client: PlanningClient = api) {
  const candidate = await client<GeneratedPlan>(`/projects/${encodeURIComponent(parameters.projectId)}/generate`, 'POST', {
    modelId: parameters.modelId, version: parameters.version, maxPlanningCost: parameters.maxPlanningCost, maxOutputTokens: parameters.maxOutputTokens,
    ...(parameters.retainUncertainCosts === undefined ? {} : { retainUncertainCosts: parameters.retainUncertainCosts }),
    ...(parameters.revisionRequest === undefined ? {} : { revisionRequest: parameters.revisionRequest }),
  }, key);
  if (candidate.projectId !== parameters.projectId || candidate.baseVersion !== parameters.version
    || candidate.revisionRequest !== parameters.revisionRequest
    || candidate.retainUncertainCosts !== undefined && typeof candidate.retainUncertainCosts !== 'boolean'
    || (candidate.retainUncertainCosts === true) !== (parameters.retainUncertainCosts === true))
    throw new Error('候选的项目、原方案版本或保留费用选择不一致。原方案未被替换，请核对本次请求。');
  return candidate;
}
export async function confirmPlanningCandidate(candidate: GeneratedPlan, projectId: string, version: number, requestKey: string, client: PlanningClient = api) {
  if (candidate.projectId !== projectId || candidate.baseVersion !== version)
    throw new Error('候选已过期或项目不一致，不能保存到当前项目。');
  return readPlanningConfirmation({ key: requestKey, previewId: candidate.previewId, version,
    ...(candidate.retainUncertainCosts === undefined ? {} : { retainUncertainCosts: candidate.retainUncertainCosts }) }, projectId, client);
}
/** A saved confirmation is replayed with its original choice, including legacy omission. */
export function readPlanningConfirmation(request: ConfirmationRequest, projectId: string, client: PlanningClient = api) {
  return client<ConfirmedPlan>(`/projects/${encodeURIComponent(projectId)}/generated-plan/confirm`, 'POST', {
    previewId: request.previewId, version: request.version,
    ...(request.retainUncertainCosts === undefined ? {} : { retainUncertainCosts: request.retainUncertainCosts }),
  }, request.key);
}
export function planningConfirmationMessage(result: ConfirmedPlan) {
  return result.validation?.valid === false
    ? `候选已保存为方案 v${result.version}；最新执行校验未通过，尚不能运行。`
    : `候选已保存为方案 v${result.version}，尚未启动执行。`;
}

export function PlanningParametersView({ parameters, models, allowedModelIds, disabled, onChange }: {
  parameters: PlanningParameters; models: Model[]; allowedModelIds: string[]; disabled?: boolean; onChange: (patch: Partial<PlanningParameters>) => void;
}) {
  const available = models.filter(model => model.status === 'available');
  const selectedModel = available.find(model => model.id === parameters.modelId && allowedModelIds.includes(model.id));
  return <div className="form-grid">
    <label className="field">本次调整说明（可选）<textarea rows={3} maxLength={4000} disabled={disabled} value={parameters.revisionRequest ?? ''} onChange={event => onChange({ revisionRequest: event.target.value })}/><small>补充需求、修改分工或更换模型。本次说明优先于旧偏好，仍受原预算与授权限制；确认候选后才保存。</small></label>
    <label className="field">规划模型<select aria-label="规划模型" value={selectedModel?.id ?? ''} disabled={disabled} onChange={event => onChange({ modelId: event.target.value })}>
      <option value="">选择规划模型</option>{available.map(model => <option key={model.id} value={model.id} disabled={!allowedModelIds.includes(model.id)}>{model.name}{allowedModelIds.includes(model.id) ? '' : ' · 未加入本项目'}</option>)}
    </select></label>
    <label className="field">单次规划限额（USD）<input name="maxPlanningCost" type="number" min={.000001} max={100} step="any" disabled={disabled} value={Number.isFinite(parameters.maxPlanningCost) ? parameters.maxPlanningCost : ''} onChange={event => onChange({ maxPlanningCost: event.target.valueAsNumber })}/><small>默认原预算的 10%，最高 $1；可以明确调整，但不能突破项目净可用预算。</small></label>
    <label className="field">规划单次最大输出 Token<input name="planningMaxOutputTokens" type="number" min={1} max={32768} step={1} disabled={disabled} value={Number.isFinite(parameters.maxOutputTokens) ? parameters.maxOutputTokens : ''} onChange={event => onChange({ maxOutputTokens: event.target.valueAsNumber })}/><small>默认 5000，不会自动降低。过低可能截断方案；这是规划请求的输出上限，区别于任务累计估算。</small></label>
    <div className="field"><label className="cost-carryover-consent"><input name="planningRetainUncertainCosts" type="checkbox" checked={parameters.retainUncertainCosts === true} disabled={disabled} onChange={event => onChange({ retainUncertainCosts: event.target.checked })}/><span>保留未结算费用，在原预算重新规划</span></label><small>默认不选。勾选后全部未知预留仍占用原预算，不清零、不提高额度；进行中的调用仍须等待。选择改变后需要重新检查。</small></div>
  </div>;
}

export function PlanningQuoteView({ quote, stale, checking, onCheck, disabled }: {
  quote?: PlanningQuote; stale: boolean; checking: boolean; onCheck: () => void; disabled?: boolean;
}) {
  return <div className="lower-small" role="region" aria-label="规划费用预检">
    <div className="section-title"><h3>规划费用预检</h3><button type="button" disabled={disabled || checking} onClick={onCheck}>{checking ? '正在只读检查…' : '检查规划费用'}</button></div>
    {!quote && !checking && <p className="subcopy">尚未检查。选择模型后，先核对完整规划请求的费用；检查不调用模型、不保存方案。</p>}
    {checking && <p role="status">正在读取本地账本并计算本次规划预留…</p>}
    {quote && <>
      <p className="subcopy">检查时间：{new Date(quote.checkedAt).toLocaleString('zh-CN')} · 方案 v{quote.version}</p>
      {stale && <p role="status" className="validation-error">模型、参数、保留费用选择或版本已变化，以下预检已失效。请重新检查。</p>}
      <p>本次规划预留 {dollars(quote.reservation)} · 单次规划限额 {dollars(quote.maxPlanningCost)}</p>
      <p>已登记 {dollars(quote.costReadiness.recordedCost)} · 未结算预留 {dollars(quote.costReadiness.reserved)} · 净可用 {dollars(quote.costReadiness.availableBudget)}</p>
      <p className="subcopy">进行中 {quote.costReadiness.pendingCount} 笔 · 费用未知 {quote.costReadiness.uncertainCount} 笔。未知预留仍占用原预算，不按零费用处理。</p>
      {quote.retainUncertainCosts === true && <div role="group" aria-label="本次规划保留费用证据"><p className="subcopy">本次选择保留未结算费用。全部预留已从净可用预算扣除；本选择不授权重放结果未知的操作。</p>
        {quote.retainedCostEvidence ? <details><summary>查看待核对收据（{quote.retainedCostEvidence.receipts.length}）</summary>{quote.retainedCostEvidence.receipts.map(receipt => <p className="cost-carryover-receipt" key={receipt.id}><code>{receipt.id}</code><span>费用待核对 · 预留 {dollars(receipt.amount)}</span>{receipt.runId && <a href={'#run/' + encodeURIComponent(receipt.runId)}>查看所属运行</a>}</p>)}</details>
          : <p className="validation-error">未返回保留费用证据，请重新检查。</p>}
      </div>}
      <p className="subcopy">保守输入计数 {quote.inputBytes.toLocaleString('zh-CN')} 字节（完整 JSON 请求封装 + 1024 字节安全余量，并非实际 Token 或账单） · 单次最大输出 {quote.maxOutputTokens.toLocaleString('zh-CN')} Token · 每百万 Token 配置单价：输入 {dollars(quote.rates.inputRate)} / 输出 {dollars(quote.rates.outputRate)}</p>
      <PlanningExecutionHistoryView history={quote.executionHistory} savedPlanIncluded={quote.savedPlanIncluded}/>
      {quote.conversation&&<p className="subcopy">已参考本项目的 {quote.conversation.count-quote.conversation.omitted} 条需求对话，保留讨论时的方案版本；经理回复仅作参考。{quote.conversation.omitted>0&&`另有 ${quote.conversation.omitted} 条较早对话未进入本轮上下文。`}</p>}
      <strong>{stale ? '需重新预检' : quote.allowed ? '检查时可发起本次规划' : '检查时不能发起规划'}</strong>
      {quote.reasons.map((reason, index) => <p className="validation-error" key={reason.code + ':' + index}>{reason.message} <small>（{reason.code}）</small></p>)}
    </>}
    <p className="subcopy">预检不是调用许可；生成前和服务端提交时会重新核验。尚未检查具体执行模型请求，不能保证 QA、经理验收或整个项目的费用可付。</p>
  </div>;
}

export function PlanningExecutionHistoryView({ history, savedPlanIncluded }: { history?: PlanningExecutionContext; savedPlanIncluded?: true }) {
  const source = history?.sourceRun;
  const integrityNames: Record<string, string> = { ok: '完整', missing: '档案缺失', invalid: '档案无效', unavailable: '尚未核验', identity_mismatch: '项目身份不匹配', incomplete: '档案不完整' };
  const fileStates = { accepted: '已核验的交付版本', fixed_input: '与原批准固定输入匹配', unverified: '存在但未核验为已验收交付' };
  const callsKnown = history?.budget.available && typeof history.budget.calls === 'number' && Number.isSafeInteger(history.budget.calls) && history.budget.calls >= 0;
  return <div className="lower-small" role="group" aria-label="规划历史来源">
    <h4>本次规划参考的历史</h4>
    <p className="subcopy">{savedPlanIncluded ? '本次费用预留已计入完整已保存方案及历史元数据。' : '尚未确认本次预检是否包含完整已保存方案，请重新检查。'}</p>
    {!history && <p className="validation-error">尚未返回执行历史，不能推断没有历史调用或完成节点。</p>}
    {history && <>
      {!history.available && <p className="validation-error">执行历史未能完整核对。以下仅展示已返回的证据，未核对项见下方。</p>}
      {source ? <>
        <p className="subcopy">来源运行：<a href={'#run/' + encodeURIComponent(source.id)}>{source.id}</a> · 来源方案 v{source.projectVersion} · {source.currentVersion ? '与当前方案版本一致' : '来源为旧方案版本'}</p>
        <p className="subcopy">需求与任务合同：{source.currentPlanMatches === true ? '与当前方案一致' : source.currentPlanMatches === false ? '与当前方案不一致' : '尚未核对'} · 档案完整性：{integrityNames[source.integrity] ?? '未核验'}（{source.integrity}）</p>
      </> : <p className="subcopy">未返回可核对的来源运行；不能据此认定之前从未执行。</p>}
      <p className="subcopy">已核验的当前方案完成节点：{history.completedTaskIds.length ? history.completedTaskIds.join('、') : '未核验出完成节点'}。文件存在不代表任务完成。</p>
      <p className="subcopy">方案 v{history.budget.projectVersion} 的执行调用：{callsKnown ? `${history.budget.calls} 次` : '未知（历史未完整核对）'}。</p>
      {history.files.length > 0 ? <details><summary>查看 {history.files.length} 份历史文件的版本与状态</summary>{history.files.map(file => <div className="lower-small" key={file.path}>
        <strong style={{ overflowWrap: 'anywhere' }}>{file.path}</strong>
        <p className="subcopy">{fileStates[file.state]}（{file.state}）{file.producerTaskId ? ` · 来源任务 ${file.producerTaskId}` : ''}</p>
        <p className="subcopy" style={{ overflowWrap: 'anywhere' }}>SHA256：<code>{file.sha256}</code></p>
      </div>)}</details> : <p className="subcopy">尚无已返回的文件版本证据，不代表原交付为空。</p>}
      {history.unknownOperationIds.length > 0 && <p className="validation-error">有 {history.unknownOperationIds.length} 项外部操作结果未知；候选不授权重放。</p>}
      {history.issues.length > 0 && <div role="group" aria-label="历史未核对项"><strong>未能核对的项目</strong>{history.issues.map((issue, index) => <p className="validation-error" key={issue.code + ':' + index}>{issue.message} <small>（{issue.code}）</small></p>)}</div>}
    </>}
    <p className="subcopy">历史仅用于规划参考；保存候选不会自动继承执行检查点。原运行、实际费用与未知预留仍保留，执行或恢复另行核验。</p>
  </div>;
}

export function GeneratedPlanView({ candidate, currentVersion, models, busy, disabled, onConfirm, onDiscard }: {
  candidate: GeneratedPlan; currentVersion: number; models: Model[]; busy?: boolean; disabled?: boolean;
  onConfirm: () => void; onDiscard: () => void;
}) {
  const stale = candidate.baseVersion !== currentVersion;
  return <section className="panel padded lower" role="region" aria-label="AI 方案候选">
    <div className="section-title"><h3>AI 方案候选 · 尚未保存</h3><span className="tag">基于 v{candidate.baseVersion}</span></div>
    <p>{candidate.plan.rationale}</p>
    {candidate.conversation&&<p className="subcopy">候选已绑定当前需求对话。新增或修改对话后需重新规划，确认不会覆盖新要求。</p>}
    <p className="subcopy">确认保存仅生成方案新版本，不启动执行、不清零已登记费用或未知预留。原运行与交付保留；新版本需重新批准，不会自动继承原运行检查点。</p>
    {stale && <p className="validation-error" role="status">当前方案已是 v{currentVersion}，此候选不能覆盖新版本。请丢弃后重新检查。</p>}
    <h4>岗位与权限</h4>
    {candidate.plan.agents.map(agent => <details className="lower-small" key={agent.id}>
      <summary>{agent.name} · {agent.role === 'manager' ? '经理' : agent.title} · {models.find(model => model.id === agent.modelId)?.name ?? agent.modelId}</summary>
      <p>岗位：{agent.title} · 工具：{agent.tools.join('、') || '无'}</p>
      <pre className="product-pre" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 280, overflow: 'auto' }}>{agent.instructions}</pre>
      <details><summary>查看完整岗位配置</summary><pre className="product-pre" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(agent, null, 2)}</pre></details>
    </details>)}
    <h4 className="lower">任务、交付与预算</h4>
    {candidate.plan.tasks.map(task => <div className="lower" key={task.id}>
      <h4>{task.subject} <small>（{task.id}）</small></h4><p>{task.objective}</p>
      <p className="subcopy">负责人：{candidate.plan.agents.find(agent => agent.id === task.assigneeId)?.name ?? task.assigneeId} · 依赖：{task.dependencies.join('、') || '无'}</p>
      <ul>{task.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
      <p className="subcopy">输出：{task.outputs?.map(output => output.path).join('、') || '未声明文件输出'}</p>
      <PlanTaskBudgetSummary task={task} defaultMaxCalls={candidate.policy.maxTaskModelCalls ?? 40}/>
      <details><summary>查看完整任务合同、输入哈希与验证命令</summary><pre className="product-pre" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(task, null, 2)}</pre></details>
    </div>)}
    <div className="lower" role="group" aria-label="候选方案校验">
      <h4>候选校验：{candidate.validation.valid ? '通过' : '未通过'}</h4>
      {!candidate.validation.valid && <p className="validation-error">此候选尚不能运行。可以确认保存为草稿继续修改，批准执行时仍须通过全部校验。</p>}
      {candidate.validation.checks.map(check => <p className={check.pass ? 'subcopy' : 'validation-error'} key={check.label}>{check.label}：{check.pass ? '通过' : '待处理'}</p>)}
      {candidate.validation.errors.map((error, index) => <p className="validation-error" key={index}>{error}</p>)}
      <p>原项目预算 {dollars(candidate.policy.maxBudget)} · 静态执行估算 {candidate.validation.estimate === null ? '待估算' : dollars(candidate.validation.estimate)}</p>
      <p className="subcopy">静态估算含 20% 余量，实际以中转站账单为准；确认时仍需核对最新费用与版本。</p>
    </div>
    <details className="lower-small"><summary>查看完整候选与策略</summary><pre className="product-pre" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(candidate, null, 2)}</pre></details>
    <div className="planning-controls lower"><button type="button" className="primary" disabled={busy || disabled || stale} onClick={onConfirm}>{busy ? '正在保存…' : candidate.validation.valid ? '确认保存候选为新版本' : '确认保存候选为草稿'}</button><button type="button" disabled={busy || disabled} onClick={onDiscard}>丢弃候选</button></div>
    <p className="subcopy">丢弃只移除待确认候选，不退回本次模型费用、不修改已保存方案。</p>
  </section>;
}

export function uncertainResponse(error: unknown) {
  return !(error instanceof ApiError) || (error.status === 409 && !error.code);
}
export function restoredPlanningDraft(project: Project) {
  const defaults = defaultPlanningParameters(project);
  try {
    const stored = JSON.parse(sessionStorage.getItem('agent-department:project-planning:' + project.id) ?? 'null');
    const parameters = stored?.parameters;
    const valid = parameters?.projectId === project.id && parameters?.version === project.version && planningParametersValid(parameters);
    const generation = stored?.generation;
    const confirmation = stored?.confirmation;
    return { parameters: valid ? parameters as PlanningParameters : defaults,
      generation: typeof generation?.key === 'string' && generation.parameters?.projectId === project.id && planningParametersValid(generation.parameters) ? generation as GenerationRequest : undefined,
      confirmation: typeof confirmation?.key === 'string' && typeof confirmation.previewId === 'string' && Number.isInteger(confirmation.version)
        && (confirmation.retainUncertainCosts === undefined || typeof confirmation.retainUncertainCosts === 'boolean') ? confirmation as ConfirmationRequest : undefined };
  } catch { return { parameters: defaults, generation: undefined, confirmation: undefined }; }
}

export function ProjectPlanning({ project, models, allowedModelIds, disabled, onChanged, onBusyChange, onCosts }: {
  project: Project; models: Model[]; allowedModelIds: string[]; disabled?: boolean;
  onChanged: () => Promise<void>; onBusyChange?: (busy: boolean) => void; onCosts: () => void;
}) {
  const [initial] = useState(() => restoredPlanningDraft(project));
  const [parameters, setParameters] = useState(initial.parameters), [quote, setQuote] = useState<PlanningQuote>();
  const [candidate, setCandidate] = useState<GeneratedPlan>(), [pendingGeneration, setPendingGeneration] = useState(initial.generation);
  const [pendingConfirmation, setPendingConfirmation] = useState(initial.confirmation);
  const [savedCosts, setSavedCosts] = useState<CostReadiness>();
  const [busy, setBusy] = useState<'check' | 'generate' | 'confirm' | ''>(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const inFlight = useRef(false), generation = useRef(initial.generation), confirmation = useRef(initial.confirmation);
  const currentParameters = { ...parameters, projectId: project.id, version: project.version };
  const available = models.filter(model => model.status === 'available');
  const selectedModel = available.find(model => model.id === parameters.modelId && allowedModelIds.includes(model.id));
  const valid = planningParametersValid(currentParameters) && !!selectedModel;
  const stale = !planningQuoteMatches(quote, currentParameters);
  const locked = !!disabled || !!busy || !!pendingGeneration || !!pendingConfirmation || !!candidate;

  function persist(nextParameters = currentParameters) {
    try { sessionStorage.setItem('agent-department:project-planning:' + project.id, JSON.stringify({ parameters: nextParameters, generation: generation.current, confirmation: confirmation.current })); } catch { /* Keep the same request key in memory when browser storage is unavailable. */ }
  }
  function change(patch: Partial<PlanningParameters>) {
    const next = { ...currentParameters, ...patch }; setParameters(next); setQuote(undefined); setSavedCosts(undefined); setError(''); setNotice(''); persist(next);
  }
  async function working(kind: 'check' | 'generate' | 'confirm', task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(kind); setError(''); setNotice(''); onBusyChange?.(true);
    try { await task(); } catch (cause) { setError((cause as Error).message); }
    finally { inFlight.current = false; setBusy(''); onBusyChange?.(false); }
  }
  async function check() {
    await working('check', async () => { setQuote(undefined); setQuote(await readPlanningQuote(currentParameters)); });
  }
  async function generate() {
    if (!quote || stale || !valid || !quote.allowed || locked) return;
    await working('generate', async () => {
      const request = { key: crypto.randomUUID(), parameters: currentParameters };
      try {
        const result = await generatePlanningCandidate(currentParameters, quote, request.key, api, () => {
          generation.current = request; setPendingGeneration(request); setQuote(undefined); persist();
        });
        setQuote(undefined);
        if (result.kind === 'recheck') { setQuote(result.quote); setNotice('费用或请求条件已变化，未调用模型。请核对最新预检后再生成。'); return; }
        setCandidate(result.candidate); setPendingGeneration(undefined); setNotice('候选已生成，原方案尚未修改。请检查后确认保存或丢弃。');
      } catch (cause) {
        if (generation.current && !uncertainResponse(cause)) { generation.current = undefined; setPendingGeneration(undefined); persist(); }
        throw cause;
      } finally { notifyCostsChanged(); await onChanged().catch(() => setNotice('最新费用读取失败，请在用量与费用中刷新。')); }
    });
  }
  async function readGeneration() {
    const request = pendingGeneration;
    if (!request) return;
    await working('generate', async () => {
      try {
        const result = await readPlanningGeneration(request);
        setCandidate(result); setPendingGeneration(undefined); setQuote(undefined); setNotice('已读取同一请求的候选结果；确认前原方案不变。');
      } catch (cause) {
        if (!uncertainResponse(cause)) { generation.current = undefined; setPendingGeneration(undefined); persist(); }
        throw cause;
      } finally { notifyCostsChanged(); await onChanged().catch(() => setNotice('最新费用读取失败，请在用量与费用中刷新。')); }
    });
  }
  async function confirm(readExisting = false) {
    const request = readExisting ? pendingConfirmation : candidate && candidate.baseVersion === project.version
      ? { key: crypto.randomUUID(), previewId: candidate.previewId, version: candidate.baseVersion,
        ...(candidate.retainUncertainCosts === undefined ? {} : { retainUncertainCosts: candidate.retainUncertainCosts }) } : undefined;
    if (!request) return;
    await working('confirm', async () => {
      confirmation.current = request; setPendingConfirmation(request); persist();
      try {
        const result = readExisting
          ? await readPlanningConfirmation(request, project.id)
          : await confirmPlanningCandidate(candidate!, project.id, project.version, request.key);
        generation.current = undefined; confirmation.current = undefined; setPendingGeneration(undefined); setPendingConfirmation(undefined); setCandidate(undefined); setQuote(undefined); persist();
        setNotice(planningConfirmationMessage(result)); setSavedCosts(result.costReadiness); notifyCostsChanged();
        await onChanged().catch(() => setError('候选已保存，但页面刷新失败。请刷新项目查看最新版本。'));
      } catch (cause) {
        if (!uncertainResponse(cause)) { confirmation.current = undefined; setPendingConfirmation(undefined); persist(); }
        throw cause;
      }
    });
  }
  function discard() {
    generation.current = undefined; confirmation.current = undefined; setCandidate(undefined); setPendingGeneration(undefined); setQuote(undefined); persist(); setError(''); setNotice('候选已丢弃；已保存方案、原运行和费用记录保留。');
  }
  return <div className="lower" role="region" aria-label="项目 AI 规划">
    <h3>生成待确认的 AI 方案</h3>
    <p className="subcopy">当前仍是已保存的 v{project.version}。检查费用、生成候选、确认保存分别操作；调整单次规划限额不会提高项目总预算。</p>
    <PlanningParametersView parameters={currentParameters} models={models} allowedModelIds={allowedModelIds} disabled={locked} onChange={change}/>
    <PlanningQuoteView quote={quote} stale={stale} checking={busy === 'check'} onCheck={() => void check()} disabled={locked || !valid}/>
    <button type="button" className="lower-small" disabled={locked || !valid || stale || !quote?.allowed} onClick={() => void generate()}>{busy === 'generate' ? '正在等待候选…' : '生成 AI 候选（会计费）'}</button>
    {busy === 'generate' && <p role="status">正在等待完整候选，最长 3 分钟。已保存的方案不变。</p>}
    {pendingGeneration && !pendingConfirmation && !busy && <div className="lower-small" role="status"><p>本次生成结果尚未确认。沿用同一请求编号继续读取；请先核对费用，不要新建第二次规划请求。若原请求未送达，这仍可能执行原来确认的规划调用。</p><button type="button" disabled={disabled} onClick={() => void readGeneration()}>继续读取同一生成请求</button></div>}
    {pendingConfirmation && !busy && <div className="lower-small" role="status"><p>保存结果尚未确认。请读取同一保存请求后再修改方案。</p><button type="button" disabled={disabled} onClick={() => void confirm(true)}>读取本次保存结果</button></div>}
    {error && <div className="planning-error" role="alert"><p>{error}</p><p className="subcopy">生成失败或丢弃候选不会退回已发生的规划费用。费用未知时保留预留，先核对账单。</p><button type="button" className="text-button" onClick={onCosts}>查看用量与费用</button></div>}
    {notice && <p className="subcopy" role="status">{notice}</p>}
    {savedCosts && <p className="subcopy">确认保存时已登记 {dollars(savedCosts.recordedCost)} · 未结算预留 {dollars(savedCosts.reserved)} · 净可用 {dollars(savedCosts.availableBudget)}；保存方案未清零费用或预留。</p>}
    {candidate && <GeneratedPlanView candidate={candidate} currentVersion={project.version} models={models} busy={!!busy} disabled={disabled || !!pendingConfirmation} onConfirm={() => void confirm()} onDiscard={discard}/>}
  </div>;
}
