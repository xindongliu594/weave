import { z } from 'zod';
import { isArtifactPath, taskContractErrors } from './task-contracts.mjs';

export const agentSchema = z.object({
  id: z.string().min(1).max(180), name: z.string().trim().min(1).max(80),
  role: z.enum(['manager', 'member']), title: z.string().trim().min(1).max(100),
  instructions: z.string().trim().min(1).max(10000), modelId: z.string().max(100),
  tools: z.array(z.enum(['artifact_write', 'filesystem', 'terminal_test', 'terminal', 'knowledge_search', 'knowledge_read', 'browser_read', 'mcp_call_readonly'])).max(8),
  browserOrigins: z.array(z.string().url().max(500).refine(value => { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && url.origin === value && !url.username && !url.password; }, '请填写精确网站来源，如 https://example.com')).max(10).optional(),
  mcpConnections: z.array(z.object({ connectionId: z.string().min(1).max(100), version: z.number().int().positive(), tools: z.array(z.string().min(1).max(200)).max(30) })).max(10).optional(),
  roleVersion: z.number().int().positive().optional(), templateId: z.string().max(100).optional(),
  systemConstraints: z.string().max(5000).optional(), outputFormat: z.string().max(2000).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  knowledgeSpaceIds: z.array(z.string().max(100)).max(30).optional(),
  fallbackModelId: z.string().max(100).optional(),
  sourceDepartmentId: z.string().min(1).max(100).optional(),
  sourceAgentId: z.string().min(1).max(100).optional(),
});
export const departmentSchema = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(2000),
  dailyBudget: z.number().finite().min(0).max(100000).optional(),
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
  maxTaskModelCalls: z.number().int().min(1).max(1000).optional(),
  contextBytes: z.number().int().min(4096).max(1000000).optional(),
  contextManagement: z.enum(['summary', 'prune', 'off']).optional(),
  progressTimeoutSeconds: z.number().int().min(60).max(3600).optional(),
  repeatActionLimit: z.number().int().min(3).max(20).optional(),
  repeatErrorLimit: z.number().int().min(2).max(10).optional(),
  maxReadRetries: z.number().int().min(0).max(2).optional(),
  executionTarget: z.discriminatedUnion('kind',[
    z.object({kind:z.literal('server')}),
    z.object({kind:z.literal('local'),deviceId:z.uuid(),grantId:z.uuid()}),
  ]).optional(),
  mode: z.enum(['recommended', 'automatic', 'custom']).optional(),
  preference: z.enum(['economy', 'balanced', 'quality', 'custom']).optional(),
  allowedModelIds: z.array(z.string().min(1).max(100)).max(200).optional(),
  allowedTools: z.array(agentSchema.shape.tools.element).max(6).optional(),
  allowedKnowledgeSpaceIds: z.array(z.string().min(1).max(100)).max(180).optional(),
  allowedDepartmentIds: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
});
export const artifactPathSchema = z.string().refine(isArtifactPath, '需要工作区相对路径，不能包含越界或团队状态目录');
export const artifactInputSchema = z.object({
  path: artifactPathSchema,
  producerTaskId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine(v => !!v.producerTaskId || !!v.sha256, '输入必须绑定来源任务或固定 SHA256');
export const artifactOutputSchema = z.object({
  path: artifactPathSchema, format: z.enum(['text', 'json']).optional(),
  requiredKeys: z.array(z.string().min(1).max(100)).max(30).optional(),
  expectedValues: z.record(z.string().min(1).max(100), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= 30).optional(),
}).refine(v => (!v.requiredKeys?.length && !Object.keys(v.expectedValues ?? {}).length) || v.format === 'json', '字段检查需要 JSON 格式');
export const taskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  subject: z.string().trim().min(1).max(200), objective: z.string().trim().min(1).max(5000),
  assigneeId: z.string().min(1), dependencies: z.array(z.string()).max(100),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  estimatedInputTokens: z.number().int().min(0).max(2000000),
  estimatedOutputTokens: z.number().int().min(1).max(200000),
  maxBudget: z.number().finite().positive().max(10000).optional(),
  maxModelCalls: z.number().int().min(1).max(1000).optional(),
  kind: z.enum(['work', 'requirements', 'implementation', 'verification', 'review', 'repair', 'integration']).optional(),
  inputs: z.array(artifactInputSchema).max(40).optional(),
  outputs: z.array(artifactOutputSchema).max(40).optional(),
  inScope: z.array(artifactPathSchema).max(40).optional().describe('允许修改的工作区相对文件或目录路径，例如 server.mjs 或 src；不能填写自然语言说明。必须覆盖本任务声明的全部 outputs。'),
  outOfScope: z.array(artifactPathSchema).max(40).optional().describe('禁止修改的工作区相对文件或目录路径，例如 secrets 或 config.json；不能填写自然语言说明，不能包含本任务声明的 outputs。'),
  verify: z.array(z.string().trim().min(1).max(5000).describe('需要实际执行的精确 shell 命令，例如 node --test todo.test.mjs。不得添加说明前缀、执行步骤或结果描述；说明写入 objective 或 acceptanceCriteria。')).max(20).optional(),
  reviewedTaskId: z.string().min(1).max(64).optional(),
  sourceTaskId: z.string().min(1).max(64).optional(),
  sourceFindingIds: z.array(z.string().min(1).max(100)).max(30).optional(),
  maxReworkRounds: z.number().int().min(0).max(2).optional(),
});
export const runInputSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(50000).refine(v=>!v.includes('\0'),'不支持二进制资料'),
  agentIds: z.array(z.string().min(1).max(80)).min(1).max(6),
});
export const planSchema = z.object({
  rationale: z.string().trim().min(1).max(5000),
  agents: z.array(agentSchema).min(1).max(6),
  tasks: z.array(taskSchema).min(1).max(50),
  knowledgeDocumentIds: z.array(z.string().min(1).max(100)).max(1000).optional(),
  runInputs: z.array(runInputSchema).max(20).optional(),
  workFileSelections: z.array(z.object({ snapshotId: z.string().uuid(), paths: z.array(artifactPathSchema).min(1).max(100), agentIds: z.array(z.string().min(1).max(180)).min(1).max(6), mode: z.enum(['reference','workspace']).optional() })).max(10).optional(),
}).superRefine((plan,ctx)=>{
  const inputs=plan.runInputs??[];
  if(new Set(inputs.map(i=>i.id)).size!==inputs.length)ctx.addIssue({code:'custom',message:'本次资料 ID 不能重复'});
  if(inputs.reduce((n,i)=>n+i.content.length,0)>250000)ctx.addIssue({code:'custom',message:'本次资料正文合计不能超过 250,000 字符'});
  if(inputs.some(i=>i.agentIds.some(id=>!plan.agents.some(a=>a.id===id))))ctx.addIssue({code:'custom',message:'本次资料的授权员工不在方案中'});
});
export const gatewaySchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url().max(500).refine(v => {
    const u = new URL(v);
    return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  }, '使用 HTTPS 地址，本机服务可使用 HTTP；地址不能包含凭证或查询参数'),
  apiKey: z.string().trim().max(2000).optional(),
  pricingSource: z.enum(['official', 'auto', 'models', 'new-api']).optional(),
});
export const modelSchema = z.object({
  name: z.string().trim().min(1).max(100), gatewayId: z.string().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  inputRate: z.number().finite().min(0).max(10000), outputRate: z.number().finite().min(0).max(10000),
  contextBytes: z.number().int().min(4096).max(2000000).optional(),
  contextWindowTokens: z.number().int().min(2048).max(2000000).optional(),
});
export type Agent = z.infer<typeof agentSchema>;
export type DepartmentInput = z.infer<typeof departmentSchema>;
export type Department = DepartmentInput & { id: string; version: number; createdAt: string; updatedAt: string; runCount: number };
export type Gateway = Omit<z.infer<typeof gatewaySchema>, 'apiKey'> & { id: string; hasCredential: boolean; version: number };
export type GatewayServiceCheck = {
  status: 'available' | 'empty' | 'failed';
  checkedAt: string; durationMs: number; gatewayVersion: number;
  modelCount?: number; upstreamStatus?: number; code?: string; message: string;
};
export type CatalogRate = { inputRate: number; outputRate: number };
export type CatalogPrice = {
  status: 'available' | 'missing' | 'unsupported' | 'group_required';
  source?: string; note?: string; inputRate?: number; outputRate?: number;
  basis?: 'official'; verifiedAt?: string; longContext?: CatalogRate; inputTokenLimit?: number;
  groups?: (CatalogRate & { name: string; ratio: number })[];
};
export type CatalogModel = { id: string; name: string; contextWindowTokens?: number; pricing: CatalogPrice };
export type GatewayCatalog = {
  models: string[]; catalog: CatalogModel[]; fetchedAt: string; gatewayVersion: number;
  modelSource: string; pricingSource?: string; warnings: string[];
  pricingVerifiedAt?: string;
};
export type Model = z.infer<typeof modelSchema> & { id: string; version: number; status: 'untested' | 'available' | 'error'; checkedAt?: string; capabilities?:{tools?:{status:'supported'|'failed';checkedAt:string;testId:string;probeVersion:string}} };
export type Policy = z.infer<typeof policySchema>;
/** Missing fields inherit the existing team once; an explicit empty list grants nothing. */
export function bindPolicy(policy:Policy,agents:Pick<Agent,'modelId'|'fallbackModelId'|'tools'|'knowledgeSpaceIds'|'sourceDepartmentId'>[],primaryDepartmentId?:string):Policy {
  const unique=(values:string[])=>[...new Set(values.filter(Boolean))];
  const departments=unique([primaryDepartmentId??'',...agents.map(a=>a.sourceDepartmentId??'')]);
  return {...policy,allowedModelIds:policy.allowedModelIds??unique(agents.flatMap(a=>[a.modelId,a.fallbackModelId??''])),allowedTools:policy.allowedTools??[...new Set(agents.flatMap(a=>a.tools))],allowedKnowledgeSpaceIds:policy.allowedKnowledgeSpaceIds??unique(agents.flatMap(a=>a.knowledgeSpaceIds??[])),...(policy.allowedDepartmentIds?{allowedDepartmentIds:policy.allowedDepartmentIds}:departments.length?{allowedDepartmentIds:departments}:{})};
}
export function permissionChecks(agents:Pick<Agent,'modelId'|'fallbackModelId'|'tools'|'knowledgeSpaceIds'|'sourceDepartmentId'>[],policy:Policy){
  return [
    {label:'策略允许的模型',pass:agents.every(a=>[a.modelId,a.fallbackModelId].filter(Boolean).every(id=>policy.allowedModelIds?.includes(id!)??false))},
    {label:'策略允许的工具',pass:agents.every(a=>a.tools.every(t=>policy.allowedTools?.includes(t)??false))},
    {label:'策略允许的知识空间',pass:agents.every(a=>(a.knowledgeSpaceIds??[]).every(id=>policy.allowedKnowledgeSpaceIds?.includes(id)??false))},
    {label:'策略允许的参与部门',pass:agents.every(a=>!a.sourceDepartmentId||(policy.allowedDepartmentIds?.includes(a.sourceDepartmentId)??false))},
  ];
}
export type Plan = z.infer<typeof planSchema>;
export type Validation = { valid: boolean; errors: string[]; estimate: number | null; checks: { label: string; pass: boolean }[] };
export type Project = { id: string; departmentId: string; departmentVersion: number; departmentName: string; requirement: string; policy: Policy; plan: Plan; version: number; status: string; source: 'manual' | 'model'; createdAt: string; validation: Validation; planningCost: number };
export type Activity = { id: string; kind: string; title: string; createdAt: string };
export type Usage = { runId?: string|null; agentId?: string|null; employeeId?: string|null; agentName?: string|null; departmentId?:string|null; sessionId?: string|null; taskId?: string|null; attemptId?: string|null; requestId?: string|null; durationMs?: number|null; id: string; modelId: string; projectId: string | null; inputTokens: number; outputTokens: number; cost: number; purpose: string; createdAt: string };

export const placeholderTaskSubject = '完成需求并提交验收材料';
export const placeholderTaskCriterion = '交付内容覆盖用户需求，并提供可核验的结果';
export const planningRequiredMessage = '当前仍有默认占位任务。请先生成 AI 方案，或编辑任务的具体目标、负责人和验收标准，再批准运行。';
// Match the legacy seed as well as new drafts. Changing models, budgets or
// tools does not turn the automatically inserted task into an executable plan.
export function hasUnplannedTasks(plan: { tasks: readonly { subject?: string; acceptanceCriteria?: readonly string[] }[] }): boolean {
  return plan.tasks.some(task => task.subject === placeholderTaskSubject && task.acceptanceCriteria?.length === 1 && task.acceptanceCriteria[0] === placeholderTaskCriterion);
}

/** Validation runs on the server again on every state-changing operation. */
export function validatePlan(plan: Plan, policy: Policy, models: Model[],requireToolSupport=true): Validation {
  const errors: string[] = [];
  const checks: Validation['checks'] = [];
  const check = (label: string, pass: boolean, message: string) => { checks.push({ label, pass }); if (!pass) errors.push(message); };
  check('任务已规划', !hasUnplannedTasks(plan), planningRequiredMessage);
  for(const item of permissionChecks(plan.agents,bindPolicy(policy,plan.agents)))check(item.label,item.pass,item.label+'不包含方案请求的权限，请调整策略或员工配置');
  const ids = new Set(plan.agents.map(a => a.id));
  check('组织与人数', ids.size === plan.agents.length && plan.agents.filter(a => a.role === 'manager').length === 1 && plan.agents.length <= policy.maxAgents,
    '需恰好一名经理、唯一员工 ID，且总人数不能超过上限');
  check('并发上限', policy.maxConcurrentAgents <= policy.maxAgents, '并发数不能超过 Agent 人数上限');
  check('模型可用性', plan.agents.every(a => models.some(m => m.id === a.modelId && m.status === 'available')), '请为所有员工选择连接测试通过的模型');
  check('备用模型可用性', plan.agents.every(a => !a.fallbackModelId || models.some(m => m.id === a.fallbackModelId && m.status === 'available')), '备用模型也必须存在且可用');
  if(requireToolSupport)check('团队工具协议能力',plan.agents.every(a=>[a.modelId,a.fallbackModelId].filter(Boolean).every(id=>models.find(m=>m.id===id)?.capabilities?.tools?.status==='supported')),'团队调度本身需要工具调用；所有主模型和备用模型必须通过工具往返测试');
  check('本次资料授权', (plan.runInputs??[]).every(input=>input.agentIds.every(id=>plan.agents.some(a=>a.id===id&&a.tools.includes('knowledge_search')))), '本次资料的授权员工必须在方案中，并开启知识检索工具');
  check('导入资料授权', (plan.workFileSelections??[]).every(input=>input.agentIds.every(id=>plan.agents.some(a=>a.id===id&&a.tools.includes('knowledge_search')))), '导入资料的接收员工必须在方案中，并开启知识检索工具');
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
  const contracts = taskContractErrors(plan.tasks, requireToolSupport ? plan.agents : []);
  check('文件交接与质量合同', contracts.length === 0, contracts.join('；'));
  let estimate = 0;
  let taskBudgetsOK = true;
  for (const task of plan.tasks) {
    const a = plan.agents.find(a => a.id === task.assigneeId), m = models.find(m => m.id === a?.modelId);
    if (m) {
      const cost=(task.estimatedInputTokens * m.inputRate + task.estimatedOutputTokens * m.outputRate) / 1e6;
      estimate += cost;
      if(task.maxBudget!==undefined&&Math.ceil(cost*1.2*1e6)/1e6>task.maxBudget)taskBudgetsOK=false;
    }
  }
  check('任务费用上限',taskBudgetsOK,'任务执行估算（含 20% 预留）超过该任务的费用上限');
  check('员工每任务调用上限',plan.tasks.every(t=>t.maxModelCalls===undefined||t.maxModelCalls<=(policy.maxTaskModelCalls??40)),'任务调用上限不能超过策略允许的每任务调用次数');
  estimate = Math.ceil(estimate * 1.2 * 1e6) / 1e6;
  const pricesKnown = plan.tasks.every(t => models.some(m => m.id === plan.agents.find(a => a.id === t.assigneeId)?.modelId));
  check('预估执行费用', pricesKnown && estimate <= policy.maxBudget, pricesKnown ? '执行估算（含 20% 预留）超过剩余预算' : '模型配置不完整，暂时无法估算费用');
  return { valid: !errors.length, errors, estimate: pricesKnown ? estimate : null, checks };
}
