// Trusted composition plumbing has its own policies. Keep this explicit: a
// plugin name prefix is never permission to create tasks, resume, or load skills.
export const EMPLOYEE_INFRASTRUCTURE_TOOLS = Object.freeze([
  'agent_teams_create', 'agent_teams_edit_plan', 'agent_teams_approve',
  'agent_teams_add_member', 'agent_teams_remove_member', 'agent_teams_create_task',
  'agent_teams_reassign_task', 'agent_teams_claim_task', 'agent_teams_update_task',
  'agent_teams_amend_task', 'agent_teams_send_message', 'agent_teams_status',
  'agent_teams_resume', 'agent_teams_delete', 'recovery_read',
  'capability_search', 'capability_use', 'skill',
]);

/** Native registry remains authoritative; this adapter only narrows access. */
export function installEmployeeToolAccess(ctx, agentCtx, { agent, employee, infrastructureNames = EMPLOYEE_INFRASTRUCTURE_TOOLS, boundary }) {
  if (!Array.isArray(employee?.tools)) throw Error('TOOL_PERMISSION_IDENTITY: 无法核对员工工具授权');
  const infrastructure = new Set(infrastructureNames), grants = new Set(employee.tools);
  const definitions = new Map(ctx.tools.schemas().filter(schema => grants.has(schema.name) || infrastructure.has(schema.name))
    .map(schema => [schema.name, ctx.tools.get(schema.name)]));
  // An allow snapshot also hides global tools registered after admission.
  // Native restrict does not filter a scope's own registrations, so it must be
  // paired with the monotonic guard and exact definition binding below.
  if (definitions.size) agentCtx.tools.restrict({ allow: [...definitions.keys()] });
  const check = (exec, actual) => {
    if (exec.agent !== agent || ctx.agents.get(agent.id) !== agent)
      return 'TOOL_PERMISSION_IDENTITY: 工具调用不属于当前员工';
    const admitted = definitions.get(exec.name);
    if (!admitted || actual !== undefined && actual !== admitted || ctx.tools.get(exec.name, agent) !== admitted)
      return 'TOOL_PERMISSION_DENIED: 工具未获授权或注册定义已改变，请重新批准';
    return undefined;
  };
  ctx.tools.guard(exec=>check(exec));
  boundary?.setPolicy(check);
  return { granted: [...definitions.keys()].filter(name => grants.has(name)),
    removed: ctx.tools.schemas().map(schema => schema.name).filter(name => !definitions.has(name)) };
}
