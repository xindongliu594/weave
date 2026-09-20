import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRunArchive, readRun } from './trace-store.mjs';
import { createTeamHost } from './host.mjs';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';

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
  constructor({ traceRoot }) {
    this.traceRoot = traceRoot;
    this.jobs = new Map();
  }

  async inspect() {
    return { ready: true, reason: 'DSH + AgentTeams 正式 Run 已接通；当前只允许纯文本协作，文件与终端工具仍处于关闭状态。' };
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
    const timer = setTimeout(() => {
      job.controller.abort(new Error('Run deadline exceeded'));
      void job.host?.close();
    }, snapshot.policy.deadlineSeconds * 1000);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        routes,
        maxBudget: snapshot.executionBudget,
        onUsage: usage => { usages.push(usage); archive.append('billing/usage', usage); },
        onError: error => { runtimeFailure ??= error; },
      });
      const workspace = join(archive.dir, 'workspace');
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      host = await createTeamHost({ adapter, provider, sessionRoot: join(archive.dir, 'sessions'), archive, maxMembers: snapshot.agents.length });
      job.host = host;
      job.controller.signal.throwIfAborted();
      const manager = snapshot.agents.find(agent => agent.role === 'manager');
      if (!manager) throw new Error('Approved snapshot has no manager');
      const managerRoute = routes.find(route => route.id === manager.modelId);
      const captain = await host.captain({ cwd: workspace, model: manager.modelId, instructions: manager.rolePrompt, maxTokens: managerRoute.maxOutputTokens });
      archive.append('run/captain', { agentId: manager.id, employeeId: manager.employeeId, sessionId: captain.id });
      const plan = {
        members: snapshot.agents.map(agent => ({ name: agent.id, role: agent.rolePrompt, provider, model: agent.modelId })),
        tasks: snapshot.tasks.map(task => ({ id: task.id, subject: task.subject, description: task.taskPrompt, assignee: task.assignee, dependencies: task.dependencies })),
      };
      const created = await host.call(captain, 'agent_teams_create', {
        name: `run-${archive.id.slice(0, 8)}`, description: snapshot.requirement, approval: 'required', plan,
      }, AbortSignal.any([job.controller.signal, AbortSignal.timeout(15_000)]));
      archive.append('run/task-mapping', { tasks: created.tasks });
      archive.append('run/approved', snapshot.approval);
      await host.call(captain, 'agent_teams_approve', { confirmation: `执行已批准项目 ${snapshot.projectId} 方案 v${snapshot.planVersion}` }, AbortSignal.any([job.controller.signal, AbortSignal.timeout(30_000)]));
      archive.append('run/started', { teamId: created.team_id });
      let status;
      let stalledSince = 0;
      while (true) {
        job.controller.signal.throwIfAborted();
        if (runtimeFailure) throw runtimeFailure;
        status = await host.call(captain, 'agent_teams_status', {}, AbortSignal.any([job.controller.signal, AbortSignal.timeout(15_000)]));
        if (status.members.some(member => member.spawn_error)) throw new Error('AgentTeams member startup failed');
        if (status.deliverable) break;
        const terminal = status.tasks.length > 0 && status.tasks.every(task => ['completed', 'failed', 'cancelled'].includes(task.status));
        if (terminal) throw new Error('Team finished without a deliverable');
        const parked = status.tasks.some(task => ['claimed', 'in_progress'].includes(task.status)) && status.members.every(member => member.status === 'idle');
        stalledSince = parked ? stalledSince || Date.now() : 0;
        if (stalledSince && Date.now() - stalledSince > 10_000) throw new Error('员工已停止响应，但任务尚未完成');
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
      job.host = undefined;
    }
  }

  read(id) { return readRun(this.traceRoot, id); }
}
