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
function drainError(error) {
  const unproven = value => value?.code === 'RUNTIME_WRITER_DRAIN_UNPROVEN' || value?.errors?.some(unproven);
  const code = unproven(error) ? 'RUNTIME_WRITER_DRAIN_UNPROVEN' : 'RUNTIME_WRITER_DRAIN_FAILED';
  return Object.assign(Error(code), { code });
}
const maintenancePending = reasonCode => ({ version: 1, state: 'pending', reasonCode });
function maintenanceResult(value) {
  if (!value || value.version !== 1 || !['stopped', 'pending'].includes(value.state) ||
    Object.keys(value).some(key => !['version', 'state', 'reasonCode'].includes(key)) ||
    (value.reasonCode !== undefined && (typeof value.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value.reasonCode))))
    return maintenancePending('TASK_STOP_RESULT_UNVERIFIED');
  return { version: 1, state: value.state, ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}) };
}

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
    if ([...this.jobs.values()].some(job => job.drainFailure))
      return { ready: false, reason: [...this.jobs.values()].find(job => job.drainFailure).drainFailure.code };
    if ([...this.jobs.values()].some(job => job.teardownPending))
      return { ready: false, reason: 'RUNTIME_TEARDOWN_PENDING: 已验收项目的宿主清理尚未结束，工具已停止；原清理结束后恢复接收新项目。' };
    return { ready: true, reason: 'DSH + AgentTeams：员工独立宿主、受限工作区、工具审批、知识引用、预算与并发控制已接入。真实模型兼容性需单独验证。' };
  }

  async start({ runId, approvedSnapshot, routes, prepareWorkspace }) {
    if ([...this.jobs.values()].some(job => job.teardownPending))
      throw Object.assign(Error('RUNTIME_TEARDOWN_PENDING: 原宿主清理尚未结束，请稍后重试'), { code: 'RUNTIME_TEARDOWN_PENDING' });
    if (this.jobs.has(runId)) throw new Error('RUN_ALREADY_ACTIVE');
    assertArchiveCapacity(this.traceRoot,ARCHIVE_ROOT_LIMIT_BYTES);
    // The coordinator supplies this synchronous, source-only preparation.
    // Admission and preparation share one stack, so a rejected launch cannot
    // leave imported files that prevent the same queued run from starting.
    prepareWorkspace?.();
    const archive = createRunArchive(this.traceRoot, approvedSnapshot, { id: runId });
    archive.append('run/queued', { projectId: approvedSnapshot.projectId, projectVersion: approvedSnapshot.planVersion });
    const job = { runId, controller: new AbortController(), host: undefined, cancelled: false };
    const completion = Promise.resolve().then(() => this.execute(job, archive, approvedSnapshot, routes));
    job.completion = completion;
    this.jobs.set(runId, job);
    const finished = () => { job.completionSettled = true; };
    completion.then(finished, finished);
    job.writerDrained = completion.then(() => this.drainJob(job), () => this.drainJob(job));
    job.writerDrained.then(() => { job.drained = true; this.releaseJob(job); }, error => { job.drainFailure = drainError(error); });
    return { runtimeRunId: runId, completion, writerDrained: job.writerDrained };
  }

  releaseJob(job) {
    if (!job.completionSettled || !job.drained) return;
    job.host = undefined;
    job.hostLifecycle = undefined;
    job.adapter = undefined;
    job.executor = undefined;
    if (this.jobs.get(job.runId) === job) this.jobs.delete(job.runId);
  }

  closeHost(job) {
    const host=job.host??job.hostLifecycle;
    if (!host) return Promise.resolve();
    if (!job.hostClosePromise) {
      job.hostClosePromise = Promise.resolve().then(() => host.close());
      job.hostClosePromise.catch(() => {});
    }
    return job.hostClosePromise;
  }

  closeResources(job) {
    if (!job.teardownPromise) {
      job.teardownPending = true;
      const hostClose = this.closeHost(job);
      job.executorClosePromise = Promise.resolve().then(() => job.executor?.close?.());
      job.executorClosePromise.catch(() => {});
      job.teardownPromise = Promise.allSettled([hostClose, job.executorClosePromise]).then(results => {
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw drainError(failure.reason);
      });
      job.teardownPromise.catch(() => {});
    }
    return job.teardownPromise;
  }

  async drainJob(job) {
    const results = await Promise.allSettled([this.closeResources(job), job.adapter?.writerDrained]);
    const failure = results.find(result => result.status === 'rejected');
    if (job.drainFailure || failure) throw drainError(job.drainFailure ?? failure.reason);
    job.teardownPending = false;
  }

  async closeAcceptedResources(job) {
    // The business timeout never replaces the original cleanup promises.
    const teardown = this.closeResources(job).then(() => ({ version: 1, state: 'stopped' }), () => maintenancePending('TASK_HOST_TEARDOWN_FAILED'));
    let timer;
    try {
      // The original promises and resource references remain in jobs after a
      // timeout. Their one eventual settlement, never a second close, releases
      // readiness and the completed job.
      return await Promise.race([teardown, new Promise(resolve => {
        timer = setTimeout(() => resolve(maintenancePending('TASK_HOST_TEARDOWN_PENDING')), 10000);
      })]);
    } finally { clearTimeout(timer); }
  }

  async cancel(runtimeRunId) {
    const job = this.jobs.get(runtimeRunId);
    if (!job) return false;
    if (!job.businessAccepted) job.cancelled = true;
    job.controller.abort(new Error('Run cancelled'));
    if (job.businessAccepted) return true;
    await this.closeHost(job);
    return true;
  }

  async execute(job, archive, snapshot, routes) {
    const usages = [];
    let runtimeFailure, deliveryStop;
    let deliverySettlementAttempted = false;
    let host, adapter, goal, sandbox, supervisor;
    const taskMode=snapshot.executionProfile==='task-attempt-openshell-v1';
    const gate = new Semaphore(snapshot.policy.maxConcurrentAgents);
    const timer = setTimeout(() => {
      job.deadlineExceeded = true;
      archive.append('run/deadline-exceeded', { deadlineSeconds: snapshot.policy.deadlineSeconds });
      job.controller.abort(new Error('Run deadline exceeded'));
      void this.closeHost(job).catch(() => {});
    }, snapshot.policy.deadlineSeconds * 1000);
    try {
      if(taskMode){
        if(snapshot.executionTarget?.kind!=='local'||snapshot.executionTarget.backend?.kind!=='openshell'||typeof this.createExecutor!=='function')throw Error('TASK_EXECUTION_REQUIRED: 任务执行只能使用已配置的 OpenShell 任务执行器');
        if(snapshot.recovery)throw Error('TASK_RECOVERY_UNAVAILABLE: 任务检查点恢复链路尚未完成');
        sandbox=this.createExecutor(archive,snapshot); job.executor=sandbox;
        if(!sandbox||['prepare','prepareTask','prepareCheckpoint','bindAttempt','execute','close'].some(name=>typeof sandbox[name]!=='function'))throw Error('TASK_EXECUTION_REQUIRED: 任务执行器缺少可信接口');
        if(typeof sandbox.finalizeAccepted!=='function')throw Error('TASK_FINALIZATION_REQUIRED: 任务执行器缺少可信终态停止接口');
        // The root is a compatibility cache, never the publication authority.
        // Rebuild it from the committed head before supervisor/Handoff reads.
        await sandbox.prepare(job.controller.signal);job.controller.signal.throwIfAborted();
      }else sandbox=this.createExecutor?.(archive,snapshot)??new RunSandbox(archive.id,join(archive.dir,'artifacts'));
      job.executor=sandbox;
      supervisor=new RuntimeSupervisor({archive,policy:snapshot.policy,artifacts:listArtifacts(sandbox.root),onFailure:error=>{runtimeFailure??=error;adapter?.stopAdmission(error);}});
      const durableArchive=archive;
      archive={...archive,append(type,data,ref){const event=durableArchive.append(type,data,ref);if(event)supervisor.observe(event);return event;}};
      archive.append('runtime/supervision',{version:1,progressTimeoutSeconds:snapshot.policy.progressTimeoutSeconds??300,repeatActionLimit:snapshot.policy.repeatActionLimit??8,repeatErrorLimit:snapshot.policy.repeatErrorLimit??3,maxReadRetries:snapshot.policy.maxReadRetries??2});
      goal = new GoalGuard({ snapshot, archive, onFailure: error => { runtimeFailure ??= error; supervisor.stop(error); adapter?.stopAdmission(error); } });
      if(!taskMode)await sandbox.prepare?.(job.controller.signal);
      for (const file of snapshot.recovery?.files ?? []) {
        if (inspectArtifact(sandbox.root,file).sha256 !== file.sha256) throw Error('RECOVERY_FILE_CHANGED: ' + file.path);
      }
      adapter = new OpenAiCompatibleAdapter({
        routes,
        maxBudget: snapshot.executionBudget,
        priorSpend: Math.max(0,snapshot.policy.maxBudget-snapshot.executionBudget),
        priorModelCalls: snapshot.budgetHistory?.calls??0,
        priorCoordinatorCalls: snapshot.budgetHistory?.coordinatorCalls,
        taskUsage: snapshot.budgetHistory?.tasks??{},
        taskCallCeilings: snapshot.resourceApproval?.taskCallCeilings,
        coordinatorCallCeiling: snapshot.resourceApproval?.coordinatorCallCeiling,
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
        onError: error => {
          // The adapter settles original usage before throwing this exact
          // internal stop. Other response/billing failures remain fatal.
          if (error === deliveryStop) return;
          runtimeFailure ??= error; supervisor.stop(error); adapter?.stopAdmission(error);
        },
      });
      job.adapter=adapter;
      const workspace = join(archive.dir, 'workspace');
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      job.hostCreatePromise = createTeamHost({ adapter, provider, onLifecycle: lifecycle => { job.hostLifecycle=lifecycle; }, sessionRoot: join(archive.dir, 'sessions'), archive, maxMembers: snapshot.agents.length,
        context: employeeContextPolicy(snapshot.policy, routes, provider),
        product: { snapshot, sandbox, gate, supervisor, goal, requestApproval: this.requestApproval?(input,signal)=>{assertArchiveCapacity(archive.dir);return this.requestApproval(input,signal);}:undefined, queryKnowledge: this.queryKnowledge, externalTool:this.externalTool, onHandoffBlocked: error => { runtimeFailure ??= error; supervisor.stop(error); adapter.stopAdmission(error); } } });
      host = await job.hostCreatePromise;
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
        // A member may fail while native status awaits its cold Host lifecycle.
        if (runtimeFailure) throw runtimeFailure;
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
      if (runtimeFailure) throw runtimeFailure;
      deliveryStop = Object.assign(Error('交付已核验，正在收尾原有模型调用'), { code: 'DELIVERY_FINALIZING' });
      adapter.stopAdmission(deliveryStop);
      if (adapter.pendingRequests) {
        deliverySettlementAttempted = true;
        archive.append('runtime/model-settling', { reason: 'delivery-completed', maxWaitMs: 30000, pendingRequests: adapter.pendingRequests });
        const settlement = await adapter.drain(30000, job.controller.signal);
        archive.append('runtime/model-settled', { reason: 'delivery-completed', ...settlement });
        job.controller.signal.throwIfAborted();
        if (settlement.pendingRequests !== 0 || settlement.timedOut || settlement.aborted || adapter.pendingRequests)
          throw Object.assign(Error('MODEL_SETTLEMENT_UNRESOLVED: 原模型调用尚未完成结算，已保留记录与费用预留，请核对后继续。'), { code: 'MODEL_SETTLEMENT_UNRESOLVED' });
      }
      job.controller.signal.throwIfAborted();
      if (runtimeFailure) throw runtimeFailure;
      const summary = lastAssistantText(captain);
      archive.append('team/checkpoint',host.checkpointState());
      if (taskMode) {
        // The original business timer governs work, settlement and this final
        // fsynced checkpoint. It cannot undo acceptance during maintenance.
        job.businessAccepted = true;
        clearTimeout(timer);
        host.stopAdmission();
        let maintenance;
        try {
          // The trusted executor starts its shared 120-second budget at entry.
          // Await actual settlement; no caller timeout can abandon a stop.
          maintenance = maintenanceResult(await sandbox.finalizeAccepted(job.controller.signal));
        } catch {
          maintenance = maintenancePending('TASK_ACCEPTED_STOP_UNRESOLVED');
        }
        const teardown = await this.closeAcceptedResources(job);
        if (teardown.state === 'pending') maintenance = teardown;
        archive.append(maintenance.state === 'stopped' ? 'runtime/maintenance-completed' : 'runtime/maintenance-pending', maintenance);
        archive.append('run/finished', { status: 'completed', tasks: status.tasks, summary, maintenance, usageCost: usages.reduce((sum, usage) => sum + usage.cost, 0) });
        return { status: 'completed', usages, summary, maintenance, recording: 'complete' };
      }
      await this.closeHost(job).catch(() => {});
      archive.append('run/finished', { status: 'completed', tasks: status.tasks, summary, usageCost: usages.reduce((sum, usage) => sum + usage.cost, 0) });
      return { status: 'completed', usages, summary };
    } catch (error) {
      if (['RUNTIME_WRITER_DRAIN_UNPROVEN','RUNTIME_WRITER_DRAIN_FAILED'].includes(error?.code)) job.drainFailure=drainError(error);
      // The final task checkpoint is already durable. Keep that trusted
      // business outcome even if later recording fails; do not fabricate a
      // terminal trace or let the coordinator relabel acceptance as failure.
      if (job.businessAccepted) return {
        status: 'completed', usages, recording: 'incomplete',
        maintenance: maintenancePending('TASK_TERMINAL_RECORDING_INCOMPLETE'),
        message: '交付已验收，终态记录尚未完整保存，请核对运行记录与维护状态。',
      };
      supervisor?.stop(error); adapter?.stopAdmission(error);
      try {
        if (!deliverySettlementAttempted && !job.cancelled && !job.deadlineExceeded && !job.controller.signal.aborted && adapter?.pendingRequests) {
          archive.append('runtime/model-settling', { maxWaitMs: 30000, pendingRequests: adapter.pendingRequests });
          const settlement = await adapter.drain(30000, job.controller.signal);
          archive.append('runtime/model-settled', settlement);
        }
      } catch (settlementError) { error = settlementError; }
      finally { if (!job.controller.signal.aborted) job.controller.abort(error); }
      const message = job.deadlineExceeded
        ? `运行达到已批准的 ${snapshot.policy.deadlineSeconds} 秒时限，已停止。已完成任务和文件保留；先核对待结算调用，再恢复未完成任务。`
        : error instanceof Error ? error.message : String(error);
      try { await this.closeHost(job).catch(() => {}); } finally {
        try { const checkpoint=host?.checkpointState();if(checkpoint)archive.append('team/checkpoint',checkpoint); } catch { /* Missing/incomplete evidence will refuse recovery. */ }
        const status = job.cancelled ? 'cancelled' : 'failed';
        archive.append('run/finished', { status, message, ...(job.deadlineExceeded ? { code: 'RUN_DEADLINE_EXCEEDED' } : {}), usageCost: usages.reduce((sum, usage) => sum + usage.cost, 0) });
      }
      return { status: job.cancelled ? 'cancelled' : 'failed', usages, message };
    } finally {
      clearTimeout(timer);
      adapter?.stopAdmission();
      this.closeResources(job);
    }
  }

  read(id) { return readRun(this.traceRoot, id); }
}
