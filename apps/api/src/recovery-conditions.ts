import type pg from 'pg';
import { join } from 'node:path';
import {selectStepCheckpoint,stepCheckpointError} from './step-checkpoint-recovery.ts';
import { AppError } from './provider.ts';
import { projectCostReadiness, checkDailyBudget, type ProjectCostReadiness } from './cost-control.ts';
import { budgetHistory } from './budget-history.ts';
import { assertRunAuthorization } from './execution-policy.ts';
import { assertRunModels } from './model-capabilities.ts';
import { completedTasks, resumeHandoff } from './handoff-checkpoints.ts';
import { readRun } from '../../../services/agent-runtime/trace-store.mjs';
import { unresolvedOperations } from '../../../services/agent-runtime/recovery.mjs';
import { hasUnplannedTasks, planningRequiredMessage } from '../../../packages/contracts/index.ts';
import { assertGoalRecovery } from './goal-recovery.ts';
import { recoveryTaskCallLimit } from './recovery-resource-plan.ts';
import {requireResolvedProjectEffectsIn} from './tool-operations.ts';

type Database = Pick<pg.PoolClient, 'query'>;
type History = Awaited<ReturnType<typeof budgetHistory>>;
export type RecoveryIssue = { code: string; message: string; status: number; taskId?: string };
export type RecoveryConditions = {
  runId: string; projectId: string; planVersion: number; checkedAt: string;
  originalBudget: number; costReadiness: ProjectCostReadiness;
  calls?: { used: number; limit: number; remaining: number };
  coordinatorCalls?: { used:number;limit?:number;remaining?:number };
  tasks: { id: string; subject: string; recordedCost: number; reserved: number; budgetLimit: number;
    availableBudget: number; calls: number; callLimit: number; remainingCalls: number; completed: boolean }[];
  resume: { allowed: boolean; reasons: RecoveryIssue[]; completedTaskIds: string[] };
  retry: { allowed: boolean; reasons: RecoveryIssue[]; completedTaskIds: string[] };
  choices: { retainUncertainCosts: boolean; acknowledgeUnknownOperations: boolean; checkpointId?:string };
  unknownOperationCount: number; unknownOperationIds: string[]; nativeRequestChecked: false; existingRunId?: string;
};
const issue = (status: number, code: string, message: string, taskId?: string): RecoveryIssue =>
  ({ status, code, message, ...(taskId ? { taskId } : {}) });

/** The same original-cap and 90% checks used immediately before retry admission. */
export function recoveryProjectBudgetIssues(cost: ProjectCostReadiness, maxBudget: number): RecoveryIssue[] {
  const reasons: RecoveryIssue[] = [];
  if (cost.availableBudget <= 0) reasons.push(issue(422, 'REQUEST_FAILED', '项目预算已用尽，修改方案预算后重新批准'));
  if (cost.recordedCost >= maxBudget * .9) reasons.push(issue(422, 'BUDGET_RETRY_DISABLED', '项目费用已达到预算的 90%，不能通过重试增加调用；请检查已有结果并重新制定方案'));
  return reasons;
}

/** Completed tasks are skipped only in resume mode; a full retry spends their original counters too. */
export function recoveryHistoryBudgetIssues(snapshot: any, history: History, completed = new Set<string>()): RecoveryIssue[] {
  const reasons: RecoveryIssue[] = [];
  if (history.calls >= (snapshot.policy.maxModelCalls ?? 100)) reasons.push(issue(422, 'TURN_LIMIT', '该方案的模型调用次数已用尽，请修改方案后重新批准'));
  const coordinatorLimit=snapshot.resourceApproval?.coordinatorCallCeiling;
  if(coordinatorLimit!==undefined){
    if(!Number.isSafeInteger(coordinatorLimit)||coordinatorLimit<1||coordinatorLimit>(snapshot.policy.maxModelCalls??100)||
      !Number.isSafeInteger(history.coordinatorCalls)||history.coordinatorCalls<0||history.coordinatorCalls>history.calls)
      reasons.push(issue(409,'BUDGET_HISTORY_MISSING','协调调用额度或历史无法核对，请检查档案'));
    else if(history.coordinatorCalls>=coordinatorLimit)
      reasons.push(issue(422,'COORDINATOR_TURN_LIMIT','本段协调请求次数已用尽，请重新分配协调额度后确认恢复；旧调用保留'));
  }
  for (const task of snapshot.approvedTasks ?? snapshot.tasks) {
    if (completed.has(task.id)) continue;
    const used = history.tasks[task.id];
    if (used && (used.cost + (used.reserved ?? 0) >= (task.maxBudget ?? snapshot.policy.maxBudget)
      || used.calls >= recoveryTaskCallLimit(snapshot,task)))
      reasons.push(issue(422, 'TASK_BUDGET_EXHAUSTED', `任务「${task.subject ?? task.id}」已达到费用或调用次数上限，请调整方案后重新批准`, task.id));
  }
  return reasons;
}

export function assertRecoveryBudgetIssues(reasons: RecoveryIssue[]) {
  const first = reasons[0];
  if (first) throw new AppError(first.status, first.message, first.code);
}

/** Inspection only: no locks, reservations, queue writes, archive appends or provider calls. */
export async function inspectRecoveryConditions(db: Database, traceRoot: string, runId: string,
  choices: RecoveryConditions['choices'], checkedAt = new Date().toISOString()): Promise<RecoveryConditions> {
  const row = (await db.query('SELECT * FROM project_runs WHERE id=$1', [runId])).rows[0];
  if (!row) throw new AppError(404, '运行不存在');
  const snapshot = structuredClone(row.snapshot);
  const maxBudget = snapshot.policy.maxBudget;
  const costs = await projectCostReadiness(db, row.project_id, maxBudget);
  const common: RecoveryIssue[] = [];
  const addError = (error: unknown, code = 'RECOVERY_CHECK_FAILED') => {
    common.push(error instanceof AppError ? issue(error.status, error.code, error.message)
      : issue(409, code, error instanceof Error ? error.message : '恢复条件无法核验，请检查本地档案'));
  };
  if (!['failed', 'interrupted', 'cancelled'].includes(row.status)) common.push(issue(409, 'RUN_NOT_STOPPED', '仅能恢复或重试已停止的运行'));
  const child = (await db.query('SELECT id FROM project_runs WHERE parent_run_id=$1', [runId])).rows[0];
  if (child) common.push(issue(409, 'RECOVERY_ALREADY_EXISTS', '此运行已创建后续运行，请查看该运行，避免重复提交'));
  if ((await db.query("SELECT id FROM project_runs WHERE project_id=$1 AND status IN ('queued','running')", [row.project_id])).rowCount)
    common.push(issue(409, 'PROJECT_ALREADY_RUNNING', '此项目已有运行'));
  if (hasUnplannedTasks({ tasks: snapshot.approvedTasks ?? snapshot.tasks })) common.push(issue(422, 'PLAN_NOT_READY', planningRequiredMessage + '旧运行不能直接重试，请修改项目方案后重新批准。'));
  const run = readRun(traceRoot, runId);
  try { await requireResolvedProjectEffectsIn(db,row.project_id); } catch(error) { addError(error); }
  try { assertGoalRecovery(snapshot,run); } catch(error) { addError(error); }
  if (run && run.integrity !== 'ok') common.push(issue(409, 'BUDGET_HISTORY_MISSING', '档案不完整，先导出并检查，不能自动恢复'));
  const unknown = run ? unresolvedOperations(run.events) : [];
  if (unknown.length && !choices.acknowledgeUnknownOperations) common.push(issue(409, 'OPERATION_RECONCILIATION_REQUIRED', '存在结果未知的修改操作，请核对操作和产物后确认重试，避免重复执行'));
  if (costs.pendingCount || (!choices.retainUncertainCosts && costs.uncertainCount))
    common.push(issue(409, 'COST_PENDING', '项目还有进行中或待核对的模型费用，请先等待返回或在设置中核对费用'));
  common.push(...recoveryProjectBudgetIssues(costs, maxBudget));
  // Admission validators take SHARE locks in the POST transaction. The GET
  // examines the same rows in its read-only snapshot without taking those locks.
  const authorizationReads = { query: (sql: string, values?: unknown[]) =>
    db.query(sql.replace(/\s+FOR SHARE(?:\s+OF\s+[\w,]+)?\s*$/i, ''), values) } as Database;
  try { await assertRunAuthorization(row, authorizationReads); } catch (error) { addError(error); }
  let history: History | undefined;
  try { history = await budgetHistory(db, traceRoot, row.project_id, row.project_version); } catch (error) { addError(error); }
  try { await assertRunModels(snapshot, db); } catch (error) { addError(error); }
  // Daily admission also has a read-only counterpart: use SELECT rather than the POST policy lock.
  try {
    const config = (await db.query('SELECT data FROM product_settings WHERE id=1')).rows[0]?.data;
    if (!config) throw new AppError(409, '本机费用策略缺失，无法检查恢复条件', 'RECOVERY_POLICY_MISSING');
    const previous = snapshot.departmentBudgets ?? { [snapshot.departmentId]: costs.availableBudget };
    const total = Object.values(previous).reduce((n: number, value: any) => n + Number(value), 0);
    const share = (departmentId: string) => total > 0 ? costs.availableBudget * Number(previous[departmentId] ?? 0) / total
      : departmentId === snapshot.departmentId ? costs.availableBudget : 0;
    await checkDailyBudget(db, config, snapshot.departmentId, share(snapshot.departmentId), costs.availableBudget);
    for (const departmentId of snapshot.departmentIds ?? [snapshot.departmentId]) if (departmentId !== snapshot.departmentId)
      await checkDailyBudget(db, config, departmentId, share(departmentId), 0);
  } catch (error) { addError(error); }
  snapshot.tasks = structuredClone(snapshot.approvedTasks ?? snapshot.tasks);
  const done = run ? completedTasks(run.events, snapshot) : new Map<string, any>();
  const resumeReasons = [...common], retryReasons = [...common];
  if(snapshot.resourceRevision)retryReasons.push(issue(409,'RESOURCE_RESUME_ONLY','资源补充只批准未完成节点，完整重试需要另外批准方案'));
  if (!run) resumeReasons.push(issue(409, 'BUDGET_HISTORY_MISSING', '运行档案缺失，无法恢复上下文和核对调用上限；请先恢复备份'));
  if (run && run.integrity === 'ok') {
    try {const selected=choices.checkpointId?selectStepCheckpoint(traceRoot,run,choices.checkpointId):undefined;resumeHandoff(snapshot, run.events, done, join(traceRoot, runId, 'artifacts'),selected?.checkpoint.files); }
    catch (error) { resumeReasons.push(issue(409, 'HANDOFF_CHECKPOINT_INVALID', stepCheckpointError(error))); }
  }
  if (!snapshot.tasks.some((task: any) => !done.has(task.id))) resumeReasons.push(issue(409, 'RUN_ALREADY_COMPLETE', '所有任务已有完成记录，请查看交付结果，无需重跑'));
  if (history) {
    resumeReasons.push(...recoveryHistoryBudgetIssues(snapshot, history, new Set(done.keys())));
    retryReasons.push(...recoveryHistoryBudgetIssues(snapshot, history));
  }
  return { runId, projectId: row.project_id, planVersion: row.project_version, checkedAt, originalBudget: maxBudget,
    costReadiness: costs, choices, nativeRequestChecked: false, unknownOperationCount: unknown.length,
    unknownOperationIds: unknown.map((operation: any) => operation.callId).sort(),
    ...(child ? { existingRunId: child.id } : {}),
    ...(history ? { calls: { used: history.calls, limit: snapshot.policy.maxModelCalls ?? 100,
      remaining: Math.max(0, (snapshot.policy.maxModelCalls ?? 100) - history.calls) } } : {}),
    ...(history?{coordinatorCalls:{used:history.coordinatorCalls,
      ...(snapshot.resourceApproval?.coordinatorCallCeiling===undefined?{}:{limit:snapshot.resourceApproval.coordinatorCallCeiling,
        remaining:Math.max(0,snapshot.resourceApproval.coordinatorCallCeiling-history.coordinatorCalls)})}}:{}),
    tasks: history ? snapshot.tasks.map((task: any) => {
      const used = history!.tasks[task.id] ?? { cost: 0, reserved: 0, calls: 0 };
      const budgetLimit = task.maxBudget ?? maxBudget, callLimit = recoveryTaskCallLimit(snapshot,task);
      return { id: task.id, subject: task.subject ?? task.id, recordedCost: used.cost, reserved: used.reserved ?? 0,
        budgetLimit, availableBudget: budgetLimit - used.cost - (used.reserved ?? 0), calls: used.calls,
        callLimit, remainingCalls: Math.max(0, callLimit - used.calls), completed: done.has(task.id) };
    }) : [],
    resume: { allowed: resumeReasons.length === 0, reasons: resumeReasons, completedTaskIds: [...done.keys()] },
    retry: { allowed: retryReasons.length === 0, reasons: retryReasons, completedTaskIds: [] } };
}
