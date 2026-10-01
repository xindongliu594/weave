import { isArtifactPath } from '../../packages/contracts/task-contracts.mjs';

const same = (left, right) => JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
const scoped = (path, scopes = []) => scopes.some(scope => path === scope || path.startsWith(scope.replace(/\/$/, '') + '/'));
function approvedScope(path, source, findings) {
  if (!isArtifactPath(path)) return;
  if (scoped(path, source.inScope) && !scoped(path, source.outOfScope)) return path;
  // The pinned plugin's requiredFix path tokenizer can match '.js' at the
  // start of '.json'. Accept that extra native audit alias only when prose
  // explicitly names the approved full JSON path and never names the JS path.
  // Product file/command audit continues to enforce the full approved path.
  const full = source.outputs.find(output => output.path.endsWith('.json') && output.path.slice(0, -2) === path)?.path;
  if (!full || !scoped(full, source.inScope) || scoped(full, source.outOfScope)) return;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const standalone = new RegExp(escaped + '(?![A-Za-z0-9_./-])');
  if (findings.some(finding => standalone.test(finding.requiredFix)) || !findings.some(finding => finding.requiredFix.includes(full))) return;
  return full;
}

/** Authorize native follow-up graphs against immutable product contracts. The
 * plugin still owns task creation, attempts, dependency rewiring and scheduling.
 * Generated work shares the original employee, task budget and call allowance. */
export class ReworkGate {
  constructor({ snapshot, handoff, archive, taskIds, state, onBlocked }) {
    Object.assign(this, { snapshot, handoff, archive, taskIds, state, onBlocked });
    this.original = new Map(snapshot.tasks.map(task => [task.id, task]));
    this.rounds = new Map(); this.superseded = new Set(); this.contracts = new Map();
  }
  check() { this.reconcile(); if (this.failure) throw this.failure; }
  contractFor(runtimeTaskId) { return this.contracts.get(runtimeTaskId) ?? this.original.get(this.taskIds.get(runtimeTaskId)); }
  escalate(taskId, attemptId, message, findings = []) {
    const error = Error(message);
    this.archive.append('quality/escalated', { taskId, attemptId, message, findings });
    this.failure = this.handoff.block(taskId, attemptId, error);
    this.onBlocked?.(this.failure);
    return this.failure;
  }
  prepare(work, update) {
    this.check();
    const review = this.original.get(work.taskId), source = this.original.get(review.reviewedTaskId);
    const rounds = this.rounds.get(review.id) ?? 0;
    const findings = update.findings;
    if (!Array.isArray(findings) || !findings.length || findings.length > 30 ||
        findings.some(finding => !finding || typeof finding.id !== 'string' || !finding.id.trim() || finding.id.length > 100 ||
          !['low', 'medium', 'high', 'blocker'].includes(finding.severity) ||
          ['problem', 'requiredFix'].some(key => typeof finding[key] !== 'string' || !finding[key].trim() || finding[key].length > 5000)) ||
        new Set(findings.map(finding => finding.id.trim())).size !== findings.length)
      throw Error('INVALID_REVIEW_FINDINGS: 审查必须提供唯一问题编号、严重度、问题及修复要求');
    if (review.kind !== 'review' || update.verdict === 'reject' || !review.maxReworkRounds)
      throw this.escalate(review.id, work.attemptId, 'REPLAN_REQUIRED: 审查未授权自动返工或明确拒绝，请检查问题并重新批准方案', findings);
    if (rounds >= review.maxReworkRounds)
      throw this.escalate(review.id, work.attemptId, 'REWORK_LIMIT: 自动返工次数已用尽，请人工处理或重新批准方案', findings);
    const open = findings.filter(finding => finding.resolved !== true);
    if (!open.length) throw Error('INVALID_REVIEW_FINDINGS: 需要至少一个未解决的问题');
    for (const finding of open) if (finding.file && (!isArtifactPath(finding.file) || !source.outputs.some(output => output.path === finding.file) ||
        !scoped(finding.file, source.inScope) || scoped(finding.file, source.outOfScope)))
      throw this.escalate(review.id, work.attemptId, 'REWORK_SCOPE_REQUIRED: 问题要求修改批准文件范围之外的内容', findings);
    this.handoff.begin(review.id, work.attemptId);
    const before = this.state();
    this.pending = { review, source, findings: open, work, before, round: rounds + 1 };
  }
  reconcile() {
    if (!this.pending) return;
    const pending = this.pending;
    try {
      const state = this.state(), oldIds = new Set(pending.before.tasks.map(task => task.id));
      const created = state.tasks.filter(task => !oldIds.has(task.id));
      if (!created.length) return;
      const repair = created.find(task => task.kind === 'repair'), review = created.find(task => task.kind === 'review');
      const { source, review: approved, work, findings, round } = pending;
      const effectiveScope = repair?.inScope?.map(path => approvedScope(path, source, findings));
      const violations = [
        [created.length !== 2 || !repair || !review, '任务图'],
        [repair?.assignee !== source.assignee || review?.assignee !== approved.assignee || repair?.assignee === review?.assignee, '负责人及独立审查'],
        [repair?.sourceTaskId !== work.task.reviewedTaskId || review?.reviewedTaskId !== repair?.id, '任务来源'],
        [!same(repair?.dependencies, [work.task.reviewedTaskId]) || !same(review?.dependencies, [repair?.id]), '依赖'],
        [repair?.round !== (work.task.round ?? 1) + 1 || review?.round !== repair?.round, '轮次'],
        [!same(repair?.verify, source.verify), '验证命令'],
        [!same(repair?.sourceFindingIds, findings.map(finding => finding.id.trim())), '问题编号'],
        [!effectiveScope?.length || effectiveScope.some(path => !path), '修改范围'],
        [!same(repair?.outOfScope, source.outOfScope), '禁止范围'],
      ].filter(([failed]) => failed).map(([, label]) => label);
      if (violations.length) throw Error('REWORK_SCOPE_REQUIRED: 原生返工提案与批准合同不符（'+violations.join('、')+'）；尚未授权新员工执行');
      // Use the previous accepted output versions as repair inputs. Keeping the
      // product task ID makes downstream consumers bind the newest sealed output.
      const inputs = new Map((source.inputs ?? []).map(input => [input.path, input]));
      for (const output of source.outputs) inputs.set(output.path, { path: output.path, producerTaskId: source.id });
      const repairContract = { ...source, kind: 'repair', inputs: [...inputs.values()], inScope: [...new Set(effectiveScope)],
        sourceTaskId: source.id, sourceFindingIds: repair.sourceFindingIds, acceptanceCriteria: findings.map(finding => finding.requiredFix),
        reviewFindings: findings, reworkRound: round };
      const reviewContract = { ...approved, reviewFindings: findings, reworkRound: round };
      const bindings = [{ task_id: repair.id, seed_id: source.id }, { task_id: review.id, seed_id: approved.id }];
      // Reconcile durable state at employee admission and when the public update
      // returns. Informational plugin events are optional in the pinned harness.
      // No generated model/tool request can pass check() without both mappings.
      this.archive.append('quality/rework-created', { reviewTaskId: approved.id, round, findings, bindings, repairContract, reviewContract });
      this.archive.append('run/task-mapping', { tasks: bindings });
      this.handoff.tasks.set(source.id, repairContract); this.handoff.tasks.set(approved.id, reviewContract);
      this.contracts.set(repair.id, repairContract); this.contracts.set(review.id, reviewContract);
      for (const binding of bindings) this.taskIds.set(binding.task_id, binding.seed_id);
      this.rounds.set(approved.id, round); this.superseded.add(work.task.id);
      this.pending = undefined;
    } catch (error) {
      this.pending = undefined;
      this.escalate(pending.review.id, pending.work.attemptId, error.message, pending.findings);
    }
  }
  finish(result) {
    if (result.isError) { this.pending = undefined; return; }
    this.check();
    if (this.pending) {
      const { review, work, findings } = this.pending; this.pending = undefined;
      throw this.escalate(review.id, work.attemptId, 'REWORK_GRAPH_MISSING: 未生成完整返工和复验任务', findings);
    }
    this.check();
  }
  hasBlockingFailure(tasks) { this.check(); return tasks.some(task => task.status === 'failed' && !this.superseded.has(task.task_id ?? task.id)); }
}
