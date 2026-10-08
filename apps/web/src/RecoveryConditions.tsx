import type { RecoveryConditions } from '../../api/src/recovery-conditions.ts';
import type { CostReadiness } from './CostCarryoverChoice.tsx';

export type { RecoveryConditions } from '../../api/src/recovery-conditions.ts';
const dollars = (value: number) => '$' + value.toFixed(6);

export function recoveryConditionsKey(runId: string, version: number, readiness: CostReadiness | undefined,
  retainUncertainCosts: boolean, acknowledgeUnknownOperations: boolean, unknownOperationIds: string[] = []) {
  return JSON.stringify([runId, version, retainUncertainCosts, acknowledgeUnknownOperations, [...unknownOperationIds].sort(), readiness && [
    readiness.recordedCost, readiness.reserved, readiness.availableBudget, readiness.pendingCount, readiness.uncertainCount,
    readiness.receipts.map(receipt => [receipt.id, receipt.amount, receipt.status]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]]);
}

export function recoveryConditionsResultKey(result: RecoveryConditions) {
  return recoveryConditionsKey(result.runId, result.planVersion, result.costReadiness,
    result.choices.retainUncertainCosts, result.choices.acknowledgeUnknownOperations, result.unknownOperationIds);
}

/** A check is informational until both its choices and its current ledger still match. */
export function recoveryConditionsAllow(result: RecoveryConditions | undefined, resultKey: string | undefined,
  currentKey: string, resume: boolean) {
  return !!result && resultKey === currentKey && (resume ? result.resume.allowed : result.retry.allowed);
}

export function RecoveryConditionsView({ result, stale, checking, error, disabled, staticEstimate, onCheck }: {
  result?: RecoveryConditions; stale: boolean; checking: boolean; error?: string; disabled?: boolean;
  staticEstimate?: number; onCheck: () => void;
}) {
  const mode = (name: string, data: RecoveryConditions['resume']) => <div>
    <strong>{name}：{data.allowed ? '本地条件通过' : '检查时不能继续'}</strong>
    {data.reasons.map((reason, index) => <p className="validation-error" key={reason.code + ':' + index}>
      {reason.message} <small>（{reason.code}）</small>
    </p>)}
  </div>;
  return <div className="lower" role="region" aria-label="恢复条件检查">
    <div className="section-title"><h3>恢复条件检查</h3><button type="button" disabled={disabled || checking} onClick={onCheck}>
      {checking ? '正在检查…' : '检查恢复条件'}
    </button></div>
    {!result && !checking && !error && <p role="status">尚未检查。先读取原方案当前的费用、调用次数和授权条件，再选择恢复方式；检查不会调用模型或创建运行。</p>}
    {checking && <p role="status">正在只读检查本地账本、历史调用和检查点…</p>}
    {error && <p className="banner error" role="alert">{error} 请重新检查；没有因此启动新运行。</p>}
    {result && <>
      <p className="subcopy">检查时间：{new Date(result.checkedAt).toLocaleString('zh-CN')} · 原方案 v{result.planVersion} · 预算 {dollars(result.originalBudget)}</p>
      {stale && <p className="banner error" role="status">费用或确认条件已变化，以下是上次检查结果。请重新检查后继续。</p>}
      {result.unknownOperationCount > 0 && <p className="subcopy">检查时有 {result.unknownOperationCount} 项结果未知的外部操作，须逐项核对。如果上方列表与此数量不一致，请刷新本页读取最新操作记录。</p>}
      <p>检查时已记录 {dollars(result.costReadiness.recordedCost)} · 未结算预留 {dollars(result.costReadiness.reserved)} · 净可用 {dollars(result.costReadiness.availableBudget)}</p>
      {result.calls ? <p>原方案已调用 {result.calls.used} / {result.calls.limit} 次 · 剩余 {result.calls.remaining} 次</p>
        : <p className="validation-error">调用历史尚未核验，不能把未知次数当作零次。</p>}
      {mode('恢复未完成任务', result.resume)}
      {mode('完整重试', result.retry)}
      {result.resume.completedTaskIds.length > 0 && <p className="subcopy">恢复未完成任务将沿用 {result.resume.completedTaskIds.length} 项已核验完成节点；完整重试仍受这些任务的历史费用及次数约束。</p>}
      {result.existingRunId && <p><a href={'#run/' + result.existingRunId}>查看已经创建的后续运行</a></p>}
      {result.tasks.length > 0 && <details><summary>查看各任务的费用与调用余量</summary>{result.tasks.map(task => <div className="knowledge-result" key={task.id}>
        <strong>{task.subject}{task.completed ? ' · 已完成' : ''}</strong>
        <p>任务已记录 {dollars(task.recordedCost)} · 未结算预留 {dollars(task.reserved)} · 自身上限 {dollars(task.budgetLimit)} · 自身剩余 {dollars(task.availableBudget)}</p>
        <p>任务已调用 {task.calls} / {task.callLimit} 次 · 剩余 {task.remainingCalls} 次</p>
      </div>)}<p className="subcopy">任务自身剩余仍受项目净可用预算限制，不代表为该阶段单独锁定的资金。</p></details>}
    </>}
    {typeof staticEstimate === 'number' && Number.isFinite(staticEstimate) && <p className="subcopy">批准时方案静态估算 {dollars(staticEstimate)}，仅为累计 Token 的估算，不能据此保证恢复可付。</p>}
    <p className="subcopy">尚未检查具体模型请求。通过本地条件不保证下一次请求或整个项目可付；恢复提交仍会重新核验原预算和权限。</p>
  </div>;
}
