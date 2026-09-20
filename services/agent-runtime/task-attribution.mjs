/** Read-only attribution from AgentTeams' host-owned state, never from message text. */
export function assignedTask(state,sessionId,employeeId,previous) {
  const member=state.members.find(member=>member.id===sessionId&&member.name===employeeId&&member.status!=='removed');
  if(!member)throw Error('TASK_ATTRIBUTION_MISSING: 无法核对团队成员会话');
  const tasks=state.tasks.filter(task=>task.assignee===member.name);
  const active=tasks.filter(task=>['claimed','in_progress'].includes(task.status)&&task.attemptId);
  if(active.length>1)throw Error('TASK_ATTRIBUTION_AMBIGUOUS: 员工同时占用多个任务');
  // The final report after task completion belongs to that task until the next dispatch.
  const task=active[0]??tasks.find(task=>task.id===previous?.taskId&&task.attemptId===previous?.attemptId);
  if(!task)throw Error('TASK_ATTRIBUTION_MISSING: 没有可核对的任务分派，停止模型请求');
  return {taskId:task.id,attemptId:task.attemptId};
}
