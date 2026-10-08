const amount = value => Number(Math.max(0, value).toFixed(8));
const terminal = new Set(['completed', 'failed', 'cancelled']);
const bucketView = bucket => ({
  limit: amount(bucket.limit), occupied: amount(bucket.spent + bucket.reserved),
  available: amount(bucket.limit - bucket.spent - bucket.reserved),
  callsRemaining: Math.max(0, bucket.maxCalls - bucket.calls),
});

/** Read-only planning feedback; reservations remain the sole admission authority. */
export function executionBudgetContext({ budget, snapshot, routes, statuses = new Map(), taskId }) {
  if (!budget?.run) return undefined;
  const models = routes instanceof Map ? routes : new Map((routes ?? []).map(route => [route.id, route]));
  const restored = new Set((snapshot.recovery?.completed ?? []).map(task => task.taskId));
  let remainingEstimate = 0, unknownEstimates = 0, exceededEstimates = 0, remainingTasks = 0;
  let current;
  for (const task of snapshot.tasks ?? []) {
    const assignee = snapshot.agents?.find(agent =>
      task.assigneeId !== undefined && (agent.employeeId === task.assigneeId || agent.id === task.assigneeId) ||
      task.assignee !== undefined && agent.id === task.assignee);
    const model = models.get(assignee?.modelId), bucket = budget.tasks.get(task.id);
    const estimatedCost = model && [task.estimatedInputTokens, task.estimatedOutputTokens, model.inputRate, model.outputRate].every(value => Number.isFinite(value) && value >= 0)
      ? (task.estimatedInputTokens * model.inputRate + task.estimatedOutputTokens * model.outputRate) * 1.2 / 1e6 : undefined;
    const status = statuses.get(task.id) ?? (restored.has(task.id) ? 'completed' : 'pending');
    const exceeded = estimatedCost !== undefined && (bucket?.spent ?? 0) > estimatedCost;
    if (!terminal.has(status)) {
      remainingTasks++;
      if (estimatedCost === undefined) unknownEstimates++;
      else if (exceeded) exceededEstimates++;
      else remainingEstimate += Math.max(0, estimatedCost - (bucket?.spent ?? 0));
    }
    if (task.id === taskId && bucket) current = {
      id: task.id, ...bucketView(bucket), available: amount(Math.min(bucketView(bucket).available, bucketView(budget.run).available)),
      recordedTaskCost: amount(bucket.spent),
      retainedTaskReservations: amount(bucket.reserved),
      ...(Number.isSafeInteger(task.estimatedOutputTokens) ? { estimatedOutputTokens: task.estimatedOutputTokens } : {}),
      ...(Number.isSafeInteger(task.maxOutputTokens) ? { maxOutputTokens: task.maxOutputTokens } : {}),
      ...(Number.isSafeInteger(model?.maxOutputTokens) ? { configuredOutputLimit: Math.min(model.maxOutputTokens, task.maxOutputTokens ?? model.maxOutputTokens) } : {}),
      ...(estimatedCost === undefined ? { originalEstimateUnknown: true } : { originalEstimate: amount(estimatedCost), estimateExceeded: exceeded }),
      ...(model ? { inputRate: model.inputRate, outputRate: model.outputRate } : {}),
    };
  }
  return {
    currency: 'USD', basis: 'configured-rates', project: bucketView(budget.run),
    ...(current ? { task: current } : {}),
    unfinished: { count: remainingTasks, originalRemainingEstimate: amount(remainingEstimate), exceededEstimates, unknownEstimates },
    rule: 'occupied 含历史费用和未知/在途预留；retainedTaskReservations 是历史或在途未结算预留，非已确认费用；原估算超出的未完成任务仍需费用。estimatedOutputTokens 是整任务累计估算；maxOutputTokens 是批准的单次输出上限，configuredOutputLimit 为主模型路线与该上限的较小值，请求或备用路线可更小。按余额和进度重估，合并必要操作，避免重复检索；保留全部验收，不得提高额度或调用上限。',
  };
}
