// Shared deterministic checks. This module is also used by the runtime, without a model.
export const taskKinds = ['work', 'requirements', 'implementation', 'verification', 'review', 'repair', 'integration'];
export function isArtifactPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\\\0]/.test(value) &&
    !value.startsWith('/') && !value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.agent'));
}
// Match the host permission gate: an exact file or a directory subtree.
const withinScope = (path, scopes) => scopes.some(scope => path === scope || path.startsWith(`${scope.replace(/\/$/, '')}/`));
export function taskContractErrors(tasks, agents = [], checkpoints = [], { allowHistoricalPinnedProducerInputs = false } = {}) {
  const errors = [], byId = new Map(tasks.map(t => [t.id, t]));
  const prior = new Map(checkpoints.map(t => [t.taskId, t]));
  // Approved snapshots use runtime names in assignee while retaining the
  // original employee ID in assigneeId. Draft plans only have assigneeId.
  const owner = task => task?.assignee ?? task?.assigneeId;
  const ancestors = id => {
    const found = new Set();
    const walk = key => { for (const dep of byId.get(key)?.dependencies ?? []) if (!found.has(dep)) { found.add(dep); walk(dep); } };
    walk(id); return found;
  };
  for (const task of tasks) {
    const kind = task.kind ?? 'work', upstream = ancestors(task.id);
    if (!taskKinds.includes(kind)) errors.push(`${task.id}: 未知任务类型`);
    for (const field of ['inputs', 'outputs']) {
      const files = task[field] ?? [];
      if (new Set(files.map(f => f.path)).size !== files.length) errors.push(`${task.id}: ${field} 文件路径重复`);
      if (files.some(f => !isArtifactPath(f.path))) errors.push(`${task.id}: 非法文件路径`);
    }
    for (const input of task.inputs ?? []) {
      if (input.producerTaskId && input.sha256 !== undefined && !allowHistoricalPinnedProducerInputs)
        errors.push(`${task.id}: 任务产物输入不能同时指定 producerTaskId 和固定 SHA256；请仅绑定来源任务，由宿主使用本次验收版本`);
      if (!input.producerTaskId) {
        if (!/^[a-f0-9]{64}$/.test(input.sha256 ?? '')) errors.push(`${task.id}: 固定输入必须指定 SHA256`);
        continue;
      }
      const producer = byId.get(input.producerTaskId), checkpoint = prior.get(input.producerTaskId);
      if ((!producer || !upstream.has(producer.id)) && !checkpoint) errors.push(`${task.id}: 输入来源不在前置任务中 ${input.producerTaskId}`);
      if (!(producer?.outputs ?? checkpoint?.outputs ?? []).some(output => output.path === input.path)) errors.push(`${task.id}: 来源未声明输出 ${input.path}`);
      // Never accidentally consume an older writer when a later upstream task replaces the file.
      if (producer && tasks.some(other => other.id !== producer.id && upstream.has(other.id) && ancestors(other.id).has(producer.id) && (other.outputs ?? []).some(o => o.path === input.path)))
        errors.push(`${task.id}: 输入应绑定最近的产出任务 ${input.path}`);
    }
    for (const output of task.outputs ?? []) {
      if (output.format !== undefined && !['text', 'json'].includes(output.format)) errors.push(`${task.id}: 未知文件格式`);
      if ((output.requiredKeys?.length || Object.keys(output.expectedValues ?? {}).length) && output.format !== 'json') errors.push(`${task.id}: 字段检查仅用于 JSON 输出`);
      if (task.inScope?.length && !withinScope(output.path, task.inScope)) errors.push(`${task.id}: 输出 ${output.path} 不在允许修改的文件或目录范围内`);
      if (task.outOfScope?.length && withinScope(output.path, task.outOfScope)) errors.push(`${task.id}: 输出 ${output.path} 位于禁止修改的文件或目录范围内`);
    }
    if (['implementation', 'repair'].includes(kind) && (!(task.inScope?.length) || !(task.verify?.length))) errors.push(`${task.id}: 实现和修复必须声明修改范围及验证命令`);
    if (kind === 'review' || kind === 'repair') {
      const ref = kind === 'review' ? task.reviewedTaskId : task.sourceTaskId, source = byId.get(ref);
      if (!source || !upstream.has(ref)) errors.push(`${task.id}: 审查或修复来源必须是前置任务`);
      if (kind === 'review' && (!['implementation', 'repair'].includes(source?.kind) || owner(task) === owner(source))) errors.push(`${task.id}: 需要另一位员工审查实现或修复任务`);
      if (kind === 'repair' && !task.sourceFindingIds?.length) errors.push(`${task.id}: 修复必须绑定问题编号`);
    }
    if (task.maxReworkRounds !== undefined && (!Number.isInteger(task.maxReworkRounds) || task.maxReworkRounds < 0 || task.maxReworkRounds > 2))
      errors.push(`${task.id}: 自动返工次数必须为 0 到 2`);
    if (task.maxReworkRounds) {
      const source = byId.get(task.reviewedTaskId);
      if (kind !== 'review' || source?.kind !== 'implementation') errors.push(`${task.id}: 自动返工仅能由独立实现审查授权`);
      if (source?.inputs === undefined || !source?.outputs?.length || task.outputs?.length !== 0)
        errors.push(`${task.id}: 自动返工需要实现的显式输入输出，审查不得写文件`);
      if (source?.outputs?.some(output => !task.inputs?.some(input => input.path === output.path && input.producerTaskId === source.id && !input.sha256)))
        errors.push(`${task.id}: 自动复验必须读取实现的全部输出，不能固定旧哈希`);
      if (tasks.some(other => other.id !== task.id && other.maxReworkRounds && other.reviewedTaskId === task.reviewedTaskId))
        errors.push(`${task.id}: 同一实现只能有一个自动返工审查入口`);
      for (const downstream of tasks) if (downstream.id !== task.id &&
        (downstream.inputs?.some(input => input.producerTaskId === source?.id) || ancestors(downstream.id).has(source?.id)) && !ancestors(downstream.id).has(task.id))
        errors.push(`${downstream.id}: 使用返工成果必须等待独立审查 ${task.id}`);
      if (agents.length && !agents.find(agent => agent.id === owner(source))?.tools?.includes('filesystem'))
        errors.push(`${task.id}: 原实现员工需读取旧文件版本后修复`);
    }
    if (agents.length) {
      const employee = agents.find(a => a.id === owner(task));
      if (task.inputs?.length && !employee?.tools?.includes('filesystem')) errors.push(`${task.id}: 输入文件需要工作区读取权限`);
      if (task.outputs?.length && !employee?.tools?.some(t => ['artifact_write', 'terminal', 'terminal_test'].includes(t))) errors.push(`${task.id}: 输出文件需要写入工具权限`);
      if (task.verify?.length && !employee?.tools?.some(t => ['terminal', 'terminal_test'].includes(t))) errors.push(`${task.id}: 验证命令需要终端权限`);
    }
  }
  for (let i = 0; i < tasks.length; i++) for (const other of tasks.slice(i + 1)) {
    const task = tasks[i];
    if (ancestors(task.id).has(other.id) || ancestors(other.id).has(task.id)) continue;
    for (const output of task.outputs ?? []) {
      if ((other.outputs ?? []).some(o => o.path === output.path)) errors.push(`${task.id}/${other.id}: 同一输出文件必须串行写入 ${output.path}`);
      if ((other.inputs ?? []).some(input => input.path === output.path)) errors.push(`${task.id}/${other.id}: 文件读取和写入必须有先后依赖 ${output.path}`);
    }
    for (const output of other.outputs ?? []) if ((task.inputs ?? []).some(input => input.path === output.path)) errors.push(`${other.id}/${task.id}: 文件读取和写入必须有先后依赖 ${output.path}`);
  }
  return [...new Set(errors)];
}
