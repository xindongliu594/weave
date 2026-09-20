import { z } from 'zod';

export const agentSchema = z.object({
  id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80),
  role: z.enum(['manager', 'member']), title: z.string().trim().min(1).max(100),
  instructions: z.string().trim().min(1).max(10000), modelId: z.string().max(100),
  tools: z.array(z.enum(['artifact_write', 'filesystem', 'terminal_test', 'terminal', 'knowledge_search', 'knowledge_read'])).max(6),
  roleVersion: z.number().int().positive().optional(), templateId: z.string().max(100).optional(),
  systemConstraints: z.string().max(5000).optional(), outputFormat: z.string().max(2000).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  knowledgeSpaceIds: z.array(z.string().max(100)).max(30).optional(),
  fallbackModelId: z.string().max(100).optional(),
});
export const departmentSchema = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(2000),
  agents: z.array(agentSchema).min(1).max(6),
}).superRefine((d, ctx) => {
  if (d.agents.filter(a => a.role === 'manager').length !== 1)
    ctx.addIssue({ code: 'custom', message: '部门必须有且只有一位经理' });
  if (new Set(d.agents.map(a => a.id)).size !== d.agents.length)
    ctx.addIssue({ code: 'custom', message: '员工 ID 不能重复' });
});
export const policySchema = z.object({
  maxBudget: z.number().finite().positive().max(10000),
  maxAgents: z.number().int().min(1).max(6),
  maxConcurrentAgents: z.number().int().min(1).max(6),
  deadlineSeconds: z.number().int().min(60).max(86400),
  maxModelCalls: z.number().int().min(1).max(1000).optional(),
  contextBytes: z.number().int().min(4096).max(1000000).optional(),
  mode: z.enum(['recommended', 'automatic', 'custom']).optional(),
  preference: z.enum(['economy', 'balanced', 'quality', 'custom']).optional(),
});
export const taskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  subject: z.string().trim().min(1).max(200), objective: z.string().trim().min(1).max(5000),
  assigneeId: z.string().min(1), dependencies: z.array(z.string()).max(100),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  estimatedInputTokens: z.number().int().min(0).max(2000000),
  estimatedOutputTokens: z.number().int().min(1).max(200000),
});
export const planSchema = z.object({
  rationale: z.string().trim().min(1).max(5000),
  agents: z.array(agentSchema).min(1).max(6),
  tasks: z.array(taskSchema).min(1).max(50),
});
export const gatewaySchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url().max(500).refine(v => {
    const u = new URL(v);
    return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  }, '使用 HTTPS 地址，本机服务可使用 HTTP；地址不能包含凭证或查询参数'),
  apiKey: z.string().trim().max(2000).optional(),
});
export const modelSchema = z.object({
  name: z.string().trim().min(1).max(100), gatewayId: z.string().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  inputRate: z.number().finite().min(0).max(10000), outputRate: z.number().finite().min(0).max(10000),
  contextBytes: z.number().int().min(4096).max(2000000).optional(),
});
export type Agent = z.infer<typeof agentSchema>;
export type DepartmentInput = z.infer<typeof departmentSchema>;
export type Department = DepartmentInput & { id: string; version: number; createdAt: string; updatedAt: string; runCount: number };
export type Gateway = Omit<z.infer<typeof gatewaySchema>, 'apiKey'> & { id: string; hasCredential: boolean; version: number };
export type Model = z.infer<typeof modelSchema> & { id: string; version: number; status: 'untested' | 'available' | 'error'; checkedAt?: string };
export type Policy = z.infer<typeof policySchema>;
export type Plan = z.infer<typeof planSchema>;
export type Validation = { valid: boolean; errors: string[]; estimate: number | null; checks: { label: string; pass: boolean }[] };
export type Project = { id: string; departmentId: string; departmentVersion: number; departmentName: string; requirement: string; policy: Policy; plan: Plan; version: number; status: string; source: 'manual' | 'model'; createdAt: string; validation: Validation; planningCost: number };
export type Activity = { id: string; kind: string; title: string; createdAt: string };
export type Usage = { runId?: string|null; agentId?: string|null; employeeId?: string|null; agentName?: string|null; sessionId?: string|null; taskId?: string|null; attemptId?: string|null; requestId?: string|null; durationMs?: number|null; id: string; modelId: string; projectId: string | null; inputTokens: number; outputTokens: number; cost: number; purpose: string; createdAt: string };

/** Validation runs on the server again on every state-changing operation. */
export function validatePlan(plan: Plan, policy: Policy, models: Model[]): Validation {
  const errors: string[] = [];
  const checks: Validation['checks'] = [];
  const check = (label: string, pass: boolean, message: string) => { checks.push({ label, pass }); if (!pass) errors.push(message); };
  const ids = new Set(plan.agents.map(a => a.id));
  check('组织与人数', ids.size === plan.agents.length && plan.agents.filter(a => a.role === 'manager').length === 1 && plan.agents.length <= policy.maxAgents,
    '需恰好一名经理、唯一员工 ID，且总人数不能超过上限');
  check('并发上限', policy.maxConcurrentAgents <= policy.maxAgents, '并发数不能超过 Agent 人数上限');
  check('模型可用性', plan.agents.every(a => models.some(m => m.id === a.modelId && m.status === 'available')), '请为所有员工选择连接测试通过的模型');
  check('备用模型可用性', plan.agents.every(a => !a.fallbackModelId || models.some(m => m.id === a.fallbackModelId && m.status === 'available')), '备用模型也必须存在且可用');
  const taskIds = new Set(plan.tasks.map(t => t.id));
  const referencesOK = taskIds.size === plan.tasks.length && plan.tasks.every(t => ids.has(t.assigneeId) && t.dependencies.every(id => taskIds.has(id)));
  check('任务负责人和引用', referencesOK, '任务 ID 重复、负责人不存在或依赖任务不存在');
  const visiting = new Set<string>(), done = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return false;
    if (done.has(id)) return true;
    visiting.add(id);
    const task = plan.tasks.find(t => t.id === id);
    if (!task || !task.dependencies.every(visit)) return false;
    visiting.delete(id); done.add(id); return true;
  }
  check('任务依赖无环', referencesOK && plan.tasks.every(t => visit(t.id)), '任务依赖必须组成无环图');
  let estimate = 0;
  for (const task of plan.tasks) {
    const a = plan.agents.find(a => a.id === task.assigneeId), m = models.find(m => m.id === a?.modelId);
    if (m) estimate += (task.estimatedInputTokens * m.inputRate + task.estimatedOutputTokens * m.outputRate) / 1e6;
  }
  estimate = Math.ceil(estimate * 1.2 * 1e6) / 1e6;
  const pricesKnown = plan.tasks.every(t => models.some(m => m.id === plan.agents.find(a => a.id === t.assigneeId)?.modelId));
  check('预估执行费用', pricesKnown && estimate <= policy.maxBudget, pricesKnown ? '执行估算（含 20% 预留）超过剩余预算' : '模型配置不完整，暂时无法估算费用');
  return { valid: !errors.length, errors, estimate: pricesKnown ? estimate : null, checks };
}
