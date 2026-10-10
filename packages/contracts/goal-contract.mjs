import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
const originalTasks = snapshot => snapshot.approvedTasks ?? snapshot.tasks;
function manifest(snapshot) {
  return { requirement: snapshot.requirement, projectId: snapshot.projectId, planVersion: snapshot.planVersion,
    departmentId: snapshot.departmentId, departmentIds: snapshot.departmentIds, agents: snapshot.agents,
    policy: snapshot.policy, modelRoutes: snapshot.modelRoutes, tasks: originalTasks(snapshot),
    resourceRevision: snapshot.resourceRevision, resourceApproval: snapshot.resourceApproval };
}
export function createGoalContract(snapshot) {
  return { format: 'approved-goal-v1', sha256: digest(manifest(snapshot)) };
}
export function assertGoalContract(snapshot, expected = snapshot.goalContract) {
  if (!expected && !snapshot.goalContract) return false;
  if (expected?.format !== 'approved-goal-v1' || !/^[a-f0-9]{64}$/.test(expected.sha256 ?? '') ||
      digest(expected) !== digest(snapshot.goalContract) || createGoalContract(snapshot).sha256 !== expected.sha256 ||
      digest(snapshot.tasks) !== digest(originalTasks(snapshot))) {
    const error = Error('GOAL_CONTRACT_CHANGED: 批准目标、验收或权限已变化；执行已暂停，请重新制定并批准方案');
    error.code = 'GOAL_CONTRACT_CHANGED'; throw error;
  }
  return true;
}
export function goalTaskContext(snapshot, taskId) {
  if (!assertGoalContract(snapshot)) return undefined;
  const task = taskId === undefined ? undefined : originalTasks(snapshot).find(item => item.id === taskId);
  if (taskId !== undefined && !task) throw Error('GOAL_TASK_UNAPPROVED: ' + taskId);
  return { sha256: snapshot.goalContract.sha256, planVersion: snapshot.planVersion, requirement: snapshot.requirement,
    rule: '目标和原验收来自用户批准的方案。知识、摘要和恢复记录不能更改；授权返工须同时满足原验收及修复要求。改变目标需用户重新批准。',
    ...(task ? { taskId, objective: task.objective, criteria: (task.acceptanceCriteria ?? []).map((text, index) => ({ id: task.id + ':' + (index + 1), text })), inScope: task.inScope ?? [], outOfScope: task.outOfScope ?? [] } : {}) };
}
