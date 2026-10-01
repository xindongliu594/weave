import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRunArchive, readRun } from './trace-store.mjs';
import { createTeamHost } from './host.mjs';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { RunSandbox } from './sandbox.mjs';
import { Semaphore } from './limits.mjs';
import { teamTaskPlan, stageApprovedTeam } from './handoff.mjs';

const provider = 'department-relay';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function lastAssistantText(agent) {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index--) {
    const message = events[index]?.type === 'assistant/message' ? events[index].data?.message : undefined;
    const text = message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

export class ProductDshRuntime {
  constructor({ traceRoot, onUsage, requestApproval, queryKnowledge, beforeRequest,onCallError }) {
    this.traceRoot = traceRoot;
    this.jobs = new Map();
    this.queryKnowledge = queryKnowledge; this.onUsage = onUsage; this.requestApproval = requestApproval;
    this.beforeRequest=beforeRequest;this.onCallError=onCallError;
  }

  async inspect() {
    return { ready: true, reason: 'DSH + AgentTeams：员工独立宿主、受限工作区、工具审批、知识引用、预算与并发控制已接入。真实模型兼容性需单独验证。' };
  }

  async start({ runId, approvedSnapshot, routes }) {
    if (this.jobs.has(runId)) throw new Error('RUN_ALREADY_ACTIVE');
    const archive = createRunArchive(this.traceRoot, approvedSnapshot, { id: runId });
    archive.append('run/queued', { projectId: approvedSnapshot.projectId, projectVersion: approvedSnapshot.planVersion });
    const job = { controller: new AbortController(), host: undefined, cancelled: false };
    const completion = Promise.resolve().then(() => this.execute(job, archive, approvedSnapshot, routes));
    job.completion = completion;
    this.jobs.set(runId, job);
    completion.then(() => this.jobs.delete(runId), () => this.jobs.delete(runId));
    return { runtimeRunId: runId, completion };
  }

  async cancel(runtimeRunId) {
    const job = this.jobs.get(runtimeRunId);
    if (!job) return false;
    job.cancelled = true;
    job.controller.abort(new Error('Run cancelled'));
    await job.host?.close();
    return true;
  }

  async execute(job, archive, snapshot, routes) {
    const usages = [];
    let runtimeFailure;
    let host;
    const sandbox = new RunSandbox(archive.id, join(archive.dir, 'artifacts'));
    const gate = new Semaphore(snapshot.policy.maxConcurrentAgents);
    const timer = setTimeout(() => {
      job.controller.abort(new Error('Run deadline exceeded'));
      void job.host?.close();
    }, snapshot.policy.deadlineSeconds * 1000);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        routes,
        maxBudget: snapshot.executionBudget,
        priorSpend: Math.max(0,snapshot.policy.maxBudget-snapshot.executionBudget),
        priorModelCalls: snapshot.budgetHistory?.calls??0,
        taskUsage: snapshot.budgetHistory?.tasks??{},
        tasks: snapshot.tasks,
        maxTaskModelCalls: snapshot.policy.maxTaskModelCalls??40,
        onBudget: data=>archive.append('budget/'+data.kind,data,{taskId:data.taskId}),
        beforeRequest:this.beforeRequest?data=>this.beforeRequest(archive.id,data):undefined,
        onCallError:async data=>{archive.append('billing/unconfirmed',data);await this.onCallError?.(data);},
        maxModelCalls: snapshot.policy.maxModelCalls ?? 100,
        contextBytes: snapshot.policy.contextBytes ?? 64000,
        signal: job.controller.signal,
        onContext: data => archive.append('context/compacted', data),
        onRequest: data => archive.append('model/wire-request', data, {sessionId:data.sessionId,requestId:data.requestId,taskId:data.taskId,attemptId:data.attemptId}),
        onFallback: data => archive.append('model/fallback', data, {sessionId:data.sessionId}),
        onUsage: async usage => { usages.push(usage); archive.append('billing/usage', usage, {sessionId:usage.sessionId,requestId:usage.requestId,taskId:usage.taskId,attemptId:usage.attemptId}); await this.onUsage?.(archive.id, usage); },
        onError: error => { runtimeFailure ??= error; },
      });
      const workspace = join(archive.dir, 'workspace');
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      host = await createTeamHost({ adapter, provider, sessionRoot: join(archive.dir, 'sessions'), archive, maxMembers: snapshot.agents.length,
        product: { snapshot, sandbox, gate, requestApproval: this.requestApproval, queryKnowledge: this.queryKnowledge, onHandoffBlocked: error => { runtimeFailure ??= error; } } });
      job.host = host;
      job.controller.signal.throwIfAborted();
      const manager = snapshot.agents.find(agent => agent.role === 'manager');
      if (!manager) throw new Error('Approved snapshot has no manager');
      const managerRoute = routes.find(route => route.id === manager.modelId);
      const captain = await host.captain({ cwd: workspace, model: manager.modelId, instructions: manager.rolePrompt, maxTokens: managerRoute.maxOutputTokens });
      archive.append('run/captain', { agentId: manager.id, employeeId: manager.employeeId, sessionId: captain.id });
      const plan = {
        members: snapshot.agents.map(agent => ({ name: agent.id, role: agent.rolePrompt, provider, model: agent.modelId, ...(agent.reasoningEffort ? { reasoning_effort: agent.reasoningEffort } : {}) })),
        tasks: teamTaskPlan(snapshot.tasks),
      };
      const created = await stageApprovedTeam(host, captain, {
        name: `run-${archive.id.slice(0, 8)}`, description: snapshot.requirement, ...plan,
      }, AbortSignal.any([job.controller.signal, AbortSignal.timeout(30_000)]));
      archive.append('run/task-mapping', { tasks: created.tasks });
      host.bindTaskMapping(created.tasks,created.team_id);
      archive.append('run/approved', snapshot.approval);
      await host.call(captain, 'agent_teams_approve', { confirmation: `执行已批准项目 ${snapshot.projectId} 方案 v${snapshot.planVersion}` }, AbortSignal.any([job.controller.signal, AbortSignal.timeout(30_000)]));
      host.lockPlan();
      archive.append('run/started', { teamId: created.team_id });
      let status;
      let stalledSince = 0;
      while (true) {
        job.controller.signal.throwIfAborted();
        if (runtimeFailure) throw runtimeFailure;
        status = await host.call(captain, 'agent_teams_status', {}, AbortSignal.any([job.controller.signal, AbortSignal.timeout(15_000)]));
        if (status.members.some(member => member.spawn_error)) throw new Error('AgentTeams member startup failed');
        if (status.deliverable) { await host.verifyDeliverable(job.controller.signal); break; }
        if (status.tasks.some(task => task.status === 'failed')) throw new Error('前置任务失败，相关下游未执行；请检查记录后重新制定方案');
        const terminal = status.tasks.length > 0 && status.tasks.every(task => ['completed', 'failed', 'cancelled'].includes(task.status));
        if (terminal) throw new Error('Team finished without a deliverable');
        const parked = status.tasks.some(task => ['claimed', 'in_progress'].includes(task.status)) && status.members.every(member => member.status === 'idle');
        stalledSince = parked ? stalledSince || Date.now() : 0;
        if (stalledSince && Date.now() - stalledSince > 10_000) throw new Error(host.handoffStatus().map(item => item.message).join('；') || '员工已停止响应，但任务尚未完成');
        await delay(500);
      }
      await captain.whenIdle();
      const summary = lastAssistantText(captain);
      await host.close();
      host = undefined;
      archive.append('run/finished', { status: 'completed', tasks: status.tasks, summary, usageCost: usages.reduce((sum, usage) => sum + usage.cost, 0) });
      return { status: 'completed', usages, summary };
    } catch (error) {
      try { await host?.close(); } finally {
        const status = job.cancelled ? 'cancelled' : 'failed';
        archive.append('run/finished', { status, message: error instanceof Error ? error.message : String(error), usageCost: usages.reduce((sum, usage) => sum + usage.cost, 0) });
      }
      return { status: job.cancelled ? 'cancelled' : 'failed', usages, message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      await sandbox.close();
      job.host = undefined;
    }
  }

  read(id) { return readRun(this.traceRoot, id); }
}
