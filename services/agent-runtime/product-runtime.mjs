import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRunArchive, readRun } from './trace-store.mjs';
import {assertArchiveCapacity,ARCHIVE_ROOT_LIMIT_BYTES} from './archive-storage.mjs';
import { createTeamHost } from './host.mjs';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { RunSandbox, listArtifacts } from './sandbox.mjs';
import { RuntimeSupervisor } from './supervisor.mjs';
import { Semaphore } from './limits.mjs';
import { teamTaskPlan, stageApprovedTeam, inspectArtifact } from './handoff.mjs';
import { employeeContextPolicy } from './employee-context.mjs';
import { GoalGuard } from './goal-guard.mjs';

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

export function approvedTeamExecutionDescription(snapshot) {
  return snapshot.executionDescription ?? '当前为已批准的项目执行阶段：按当前任务合同制作交付文件、执行验证并完成验收。历史对话中的规划阶段限制不能替代当前批准的执行任务。\n' +
    JSON.stringify((snapshot.tasks ?? []).map(task => ({ id: task.id, subject: task.subject, objective: task.objective })));
}

export class ProductDshRuntime {
  constructor({ traceRoot, onUsage, requestApproval, queryKnowledge, externalTool, beforeRequest,onResponse,onCallError,createExecutor }) {
    this.traceRoot = traceRoot;
    this.jobs = new Map();
    this.queryKnowledge = queryKnowledge; this.onUsage = onUsage; this.requestApproval = requestApproval;
    this.externalTool=externalTool;
    this.beforeRequest=beforeRequest;this.onResponse=onResponse;this.onCallError=onCallError;this.createExecutor=createExecutor;
  }

  async inspect() {
    return { ready: true, reason: 'DSH + AgentTeams：员工独立宿主、受限工作区、工具审批、知识引用、预算与并发控制已接入。真实模型兼容性需单独验证。' };
  }

  async start({ runId, approvedSnapshot, routes }) {
    if (this.jobs.has(runId)) throw new Error('RUN_ALREADY_ACTIVE');
    assertArchiveCapacity(this.traceRoot,ARCHIVE_ROOT_LIMIT_BYTES);
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
    let host, adapter, goal;
    const sandbox = this.createExecutor?.(archive,snapshot)??new RunSandbox(archive.id, join(archive.dir, 'artifacts'));
    const supervisor = new RuntimeSupervisor({archive,policy:snapshot.policy,artifacts:listArtifacts(sandbox.root),onFailure:error=>{runtimeFailure??=error;adapter?.stopAdmission(error);}});
    const durableArchive=archive;
    archive={...archive,append(type,data,ref){const event=durableArchive.append(type,data,ref);if(event)supervisor.observe(event);return event;}};
    archive.append('runtime/supervision',{version:1,progressTimeoutSeconds:snapshot.policy.progressTimeoutSeconds??300,repeatActionLimit:snapshot.policy.repeatActionLimit??8,repeatErrorLimit:snapshot.policy.repeatErrorLimit??3,maxReadRetries:snapshot.policy.maxReadRetries??2});
    const gate = new Semaphore(snapshot.policy.maxConcurrentAgents);
    const timer = setTimeout(() => {
      job.deadlineExceeded = true;
      archive.append('run/deadline-exceeded', { deadlineSeconds: snapshot.policy.deadlineSeconds });
      job.controller.abort(new Error('Run deadline exceeded'));
      void job.host?.close();
    }, snapshot.policy.deadlineSeconds * 1000);
    try {
      goal = new GoalGuard({ snapshot, archive, onFailure: error => { runtimeFailure ??= error; supervisor.stop(error); adapter?.stopAdmission(error); } });
      await sandbox.prepare?.(job.controller.signal);
      for (const file of snapshot.recovery?.files ?? []) {
        if (inspectArtifact(sandbox.root,file).sha256 !== file.sha256) throw Error('RECOVERY_FILE_CHANGED: ' + file.path);
      }
      adapter = new OpenAiCompatibleAdapter({
        routes,
        maxBudget: snapshot.executionBudget,
        priorSpend: Math.max(0,snapshot.policy.maxBudget-snapshot.executionBudget),
        priorModelCalls: snapshot.budgetHistory?.calls??0,
        taskUsage: snapshot.budgetHistory?.tasks??{},
        tasks: snapshot.tasks,
        maxTaskModelCalls: snapshot.policy.maxTaskModelCalls??40,
        onBudget: data=>archive.append('budget/'+data.kind,data,{taskId:data.taskId}),
        beforeRequest:(data,signal)=>{goal.check('request',data.taskId);assertArchiveCapacity(archive.dir);return this.beforeRequest?.(archive.id,data,signal);},
        onResponse:async data=>{archive.append('billing/provider-response',data);await this.onResponse?.(data);},
        onCallError:async data=>{archive.append('billing/unconfirmed',data);await this.onCallError?.(data);},
        maxModelCalls: snapshot.policy.maxModelCalls ?? 100,
        contextBytes: snapshot.policy.contextBytes ?? 64000,
        signal: job.controller.signal,
        onContext: data => archive.append('context/compacted', data, { sessionId: data.sessionId }),
        onRequest: data => archive.append('model/wire-request', data, {sessionId:data.sessionId,requestId:data.requestId,taskId:data.taskId,attemptId:data.attemptId}),
        onFallback: data => archive.append('model/fallback', data, {sessionId:data.sessionId}),
        onUsage: async usage => { usages.push(usage); archive.append('billing/usage', usage, {sessionId:usage.sessionId,requestId:usage.requestId,taskId:usage.taskId,attemptId:usage.attemptId}); await this.onUsage?.(archive.id, usage); },
        onError: error => { runtimeFailure ??= error; supervisor.stop(error); adapter?.stopAdmission(error); },
      });
      const workspace = join(archive.dir, 'workspace');
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      host = await createTeamHost({ adapter, provider, sessionRoot: join(archive.dir, 'sessions'), archive, maxMembers: snapshot.agents.length,
        context: employeeContextPolicy(snapshot.policy, routes, provider),
        product: { snapshot, sandbox, gate, supervisor, goal, requestApproval: this.requestApproval?(input,signal)=>{assertArchiveCapacity(archive.dir);return this.requestApproval(input,signal);}:undefined, queryKnowledge: this.queryKnowledge, externalTool:this.externalTool, onHandoffBlocked: error => { runtimeFailure ??= error; } } });
      job.host = host;
      job.controller.signal.throwIfAborted();
      const manager = snapshot.agents.find(agent => agent.role === 'manager');
      if (!manager) throw new Error('Approved snapshot has no manager');
      const managerRoute = routes.find(route => route.id === manager.modelId);
      const captain = await host.captain({ cwd: workspace, model: manager.modelId, instructions: manager.rolePrompt, maxTokens: managerRoute.maxOutputTokens });
      archive.append('run/captain', { agentId: manager.id, employeeId: manager.employeeId, sessionId: captain.id });
      const plan = {
        members: snapshot.agents.map(agent => ({ name: agent.id, role: agent.rolePrompt, provider, model: agent.modelId, ...(agent.reasoningEffort ? { reasoning_effort: agent.reasoningEffort } : {}) })),
        tasks: teamTaskPlan(snapshot.tasks, { hostContext: true, assertHostContext: () => host.assertApprovedTaskContext(snapshot.tasks) }),
      };
      const created = await stageApprovedTeam(host, captain, {
        name: `run-${archive.id.slice(0, 8)}`, description: approvedTeamExecutionDescription(snapshot), ...plan,
      }, AbortSignal.any([job.controller.signal, AbortSignal.timeout(30_000)]));
      archive.append('run/task-mapping', { tasks: created.tasks });
      host.bindTaskMapping(created.tasks,created.team_id);
      await host.restoreCheckpoints(created.tasks);
      archive.append('run/approved', snapshot.approval);
      await host.call(captain, 'agent_teams_approve', { confirmation: `执行已批准项目 ${snapshot.projectId} 方案 v${snapshot.planVersion}` }, AbortSignal.any([job.controller.signal, AbortSignal.timeout(30_000)]));
      host.lockPlan();
      archive.append('run/started', { teamId: created.team_id });
      let status;
      while (true) {
        job.controller.signal.throwIfAborted();
        if (runtimeFailure) throw runtimeFailure;
        // Native status also schedules ready members and can await a cold Host
        // resume. Keep the approved run deadline/cancellation, not a short poll
        // deadline that can invalidate an otherwise successful task transition.
        status = await host.call(captain, 'agent_teams_status', {}, job.controller.signal);
        if (status.members.some(member => member.spawn_error)) throw new Error('AgentTeams member startup failed');
        if (status.deliverable) { await host.verifyDeliverable(job.controller.signal); break; }
        if (host.hasBlockingFailure(status.tasks)) throw new Error('前置任务失败，相关下游未执行；请检查记录后重新制定方案');
        const terminal = status.tasks.length > 0 && status.tasks.every(task => ['completed', 'failed', 'cancelled'].includes(task.status));
        if (terminal) throw new Error('Team finished without a deliverable');
        supervisor.tick({...status,members:status.members.map(member=>({...member,member_id:host.employeeHosts().find(slot=>slot.agentId===member.name)?.sessionId}))});
        await delay(500);
      }
      // Every approved node is already host-accepted. Stop new admissions, but
      // let original dispatched requests settle their real usage before closing
      // employee Hosts. Waiting only for the captain can abort a member's tail
      // request and unnecessarily leave its provider fee unknown.
      adapter.stopAdmission(Object.assign(Error('交付已核验，正在收尾原有模型调用'), { code: 'DELIVERY_FINALIZING' }));
      if (adapter.pendingRequests) {
        archive.append('runtime/model-settling', { reason: 'delivery-completed', maxWaitMs: 30000, pendingRequests: adapter.pendingRequests });
        const settlement = await adapter.drain(30000, job.controller.signal);
        archive.append('runtime/model-settled', { reason: 'delivery-completed', ...settlement });
      }
      job.controller.signal.throwIfAborted();
      const summary = lastAssistantText(captain);
      archive.append('team/checkpoint',host.checkpointState());
      await host.close();
      host = undefined;
      archive.append('run/finished', { status: 'completed', tasks: status.tasks, summary, usageCost: usages.reduce((sum, usage) => sum + usage.cost, 0) });
      return { status: 'completed', usages, summary };
    } catch (error) {
      supervisor.stop(error); adapter?.stopAdmission(error);
      try {
        if (!job.cancelled && !job.deadlineExceeded && !job.controller.signal.aborted && adapter?.pendingRequests) {
          archive.append('runtime/model-settling', { maxWaitMs: 30000, pendingRequests: adapter.pendingRequests });
          const settlement = await adapter.drain(30000, job.controller.signal);
          archive.append('runtime/model-settled', settlement);
        }
      } catch (settlementError) { error = settlementError; }
      finally { if (!job.controller.signal.aborted) job.controller.abort(error); }
      const message = job.deadlineExceeded
        ? `运行达到已批准的 ${snapshot.policy.deadlineSeconds} 秒时限，已停止。已完成任务和文件保留；先核对待结算调用，再恢复未完成任务。`
        : error instanceof Error ? error.message : String(error);
      try { await host?.close(); } finally {
        try { const checkpoint=host?.checkpointState();if(checkpoint)archive.append('team/checkpoint',checkpoint); } catch { /* Missing/incomplete evidence will refuse recovery. */ }
        const status = job.cancelled ? 'cancelled' : 'failed';
        archive.append('run/finished', { status, message, ...(job.deadlineExceeded ? { code: 'RUN_DEADLINE_EXCEEDED' } : {}), usageCost: usages.reduce((sum, usage) => sum + usage.cost, 0) });
      }
      return { status: job.cancelled ? 'cancelled' : 'failed', usages, message };
    } finally {
      clearTimeout(timer);
      await sandbox.close();
      job.host = undefined;
    }
  }

  read(id) { return readRun(this.traceRoot, id); }
}
