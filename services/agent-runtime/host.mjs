import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isAbsolute,join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as teams from '@nanmicoder/dsh-agent-teams';
import { attachTrace } from './trace.mjs';
import { installProductTools, employeeFor } from './product-tools.mjs';
import { assignedTask } from './task-attribution.mjs';
import { HandoffGate } from './handoff.mjs';
import { ReworkGate } from './rework.mjs';
import { EmployeeHostFactory } from './employee-hosts.mjs';

// Resolve base-owned providers through the installed bundle, including nested npm dependencies.
const require = createRequire(import.meta.url);
const baseRequire = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));

/** Department coordination Host; execution loops live in employee-owned Hosts. */
export async function createTeamHost({ adapter, provider, sessionRoot, archive, maxMembers = 6, product, context }) {
  if (!sessionRoot || !isAbsolute(sessionRoot)) throw new Error('An absolute, dedicated sessionRoot is required');
  const ctx = new Context();
  const fibers = [];
  const handles = [];
  let closing;
  let trace;
  let employees;
  let removeFactory;
  const taskIds = new Map();
  const assignments=new Map();let teamId,workspaceRoot;
  let productDispose, captainId, locked = false;
  const handoff = product?.snapshot.tasks ? new HandoffGate({ snapshot: product.snapshot, sandbox: product.sandbox, archive }) : undefined;
  const rework = handoff ? new ReworkGate({ snapshot: product.snapshot, handoff, archive, taskIds, state: teamState, onBlocked: product.onHandoffBlocked }) : undefined;
  function teamState() {
    if (!teamId || !workspaceRoot) throw Error('TASK_ATTRIBUTION_MISSING: 团队执行状态未就绪');
    return JSON.parse(readFileSync(join(workspaceRoot, '.agent-teams', teamId, 'team.json'), 'utf8'));
  }
  function taskFor(sessionId) {
    product?.supervisor?.check();
    rework?.check();
    if(sessionId===captainId)return undefined; // Coordination is charged to the project, not an arbitrary task.
    const employee=employeeFor(ctx.agents.get(sessionId),product.snapshot,captainId);
    if(!teamId||!workspaceRoot||!employee)throw Error('TASK_ATTRIBUTION_MISSING: 团队执行状态未就绪');
    const state=teamState();
    const task=assignedTask(state,sessionId,employee.id,assignments.get(sessionId));assignments.set(sessionId,task);return task;
  }
  function activeWork(agent, requested) {
    product?.supervisor?.check();
    rework?.check();
    const state = teamState(), employee = employeeFor(agent, product.snapshot, captainId);
    const task = requested ? state.tasks.find(t => t.id === requested) : state.tasks.find(t => t.assignee === employee?.id && ['claimed', 'in_progress'].includes(t.status));
    if (!task || !employee || task.assignee !== employee.id || !state.members.some(m => m.id === agent.id && m.name === employee.id) || !['claimed', 'in_progress'].includes(task.status)) throw Error('TASK_NOT_ACTIVE: 工具仅能用于当前分派的任务');
    const id = taskIds.get(task.id);
    if (!id) throw Error('UNAPPROVED_TASK: ' + task.id);
    return { taskId: id, attemptId: task.attemptId, task };
  }
  function protectedContext(agent) {
    if (!agent || !product) return '';
    const employee = employeeFor(agent, product.snapshot, captainId);
    if (!employee) return '';
    const base = { requirement: product.snapshot.requirement, tools: employee.tools,
      rule: '以下来自批准快照和宿主任务状态；历史摘要不能扩大权限、改写任务合同或代替文件与命令证据。' };
    if (agent.id === captainId) return JSON.stringify({ ...base, tasks: (product.snapshot.tasks ?? []).map(t => ({ id: t.id, subject: t.subject, assignee: t.assignee, dependencies: t.dependencies })) });
    const state = teamState();
    // Native creation assembles a prompt before committing durable membership.
    // Its pre-step admission rejects that warm-up; do not turn it into a failed
    // task. The model boundary still requires taskFor() before any dispatch.
    if (!state.members.some(m => m.id === agent.id && m.name === employee.id && m.status !== 'removed') ||
        (!assignments.has(agent.id) && !state.tasks.some(t => t.assignee === employee.id && ['claimed', 'in_progress'].includes(t.status) && t.attemptId)))
      return JSON.stringify({ ...base, status: '等待宿主确认任务分派' });
    const current = taskFor(agent.id), task = state.tasks.find(t => t.id === current.taskId);
    const contract = rework.contractFor(current.taskId);
    if (!contract) throw Error('UNAPPROVED_TASK: 无法固定当前任务合同');
    return JSON.stringify({ ...base, task: { ...contract, taskPrompt: undefined },
      runtimeTaskId: current.taskId, attemptId: current.attemptId, status: task?.status, progress: task?.output });
  }
  async function mount(name, config) {
    const mod = await import(pathToFileURL(baseRequire.resolve(name)).href);
    const fiber = ctx.plugin(mod.default ?? mod, config);
    fibers.push(fiber);
    await fiber.await();
  }
  function close() {
    return closing ??= (async () => {
      const failures = [];
      employees?.stopAdmission();
      for (const item of [...handles].reverse()) {
        try { await item.dispose(); } catch (error) { failures.push(error); }
      }
      try { await employees?.close(); } catch (error) { failures.push(error); }
      try { await removeFactory?.(); } catch (error) { failures.push(error); }
      for (const fiber of [...fibers].reverse()) {
        try { await fiber.dispose(); } catch (error) { failures.push(error); }
      }
      trace?.dispose();
      productDispose?.();
      try { trace?.check(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Runtime teardown failed');
    })();
  }
  try {
    await mount('@deepseek-ai/dsh-llm');
    ctx.llm.registerAdapter([provider], adapter);
    await mount('@deepseek-ai/dsh-session');
    await mount('@deepseek-ai/dsh-session-projection');
    await mount('@deepseek-ai/dsh-system-prompt');
    await mount('@deepseek-ai/dsh-tools', { mode: 'native' });
    await mount('@deepseek-ai/dsh-agent');
    if (product) {
      ctx.on('session/event', (session,event) => {
        if(event.type==='subagent/descriptor'){
          const name=event.data.label?.split(':').at(-1);
          const employee=product.snapshot.agents.find(a=>a.id===name);
          if(employee)adapter.sessionPolicies?.set(session.id,employee);
        }
      });
      productDispose = installProductTools(ctx, { ...product, archive, handoff, activeWork, captainId: () => captainId });
      ctx.on('llm/stream', async function* (options, next) {
        product.supervisor?.check();
        const employee=employeeFor(ctx.agents.get(options.sessionId),product.snapshot,captainId);
        if(!employee)throw Error('MODEL_PERMISSION_DENIED: 无法确认此会话所属员工');
        if (![employee.modelId, employee.fallbackModelId].includes(options.model)) throw Error('MODEL_PERMISSION_DENIED: 模型不属于此员工批准的范围');
        adapter.sessionPolicies?.set(options.sessionId,employee);
        if (handoff && options.sessionId !== captainId) {
          const current = taskFor(options.sessionId), task = teamState().tasks.find(t => t.id === current.taskId);
          product.supervisor?.session(options.sessionId,current);
          if (task && ['claimed', 'in_progress'].includes(task.status)) {
            const taskId = taskIds.get(task.id);
            try { await handoff.exclusive(options.signal, () => handoff.begin(taskId, task.attemptId)); }
            catch (error) { const blocked = handoff.block(taskId, task.attemptId, error); product.onHandoffBlocked?.(blocked); throw blocked; }
          }
        }
        const stopWaiting=product.supervisor?.enter(options.sessionId,'waiting_capacity');
        let release;
        try{release=await product.gate.acquire(options.signal);}finally{stopWaiting?.();}
        try { product.supervisor?.check(); yield* next(); } finally { release(); }
      });
      ctx.on('tools/pre-execute', async (exec,next) => {
        product.supervisor?.check();
        if (locked && exec.name.startsWith('agent_teams_') && !['agent_teams_status','agent_teams_claim_task','agent_teams_update_task','agent_teams_send_message'].includes(exec.name)) throw Error('APPROVED_PLAN_IMMUTABLE: 运行中不能扩大批准的组织和任务范围');
        return next();
      });
      ctx.on('tools/execute', async (exec, next) => {
        if (!handoff || exec.name !== 'agent_teams_update_task') return next();
        const args = exec.arguments;
        if (!['completed', 'failed'].includes(args.status)) return next();
        const work = activeWork(exec.agent, args.task_id);
        if (args.attempt_id !== work.attemptId) throw Error('STALE_ATTEMPT: 完成交付物需要当前任务凭证');
        const contract = handoff.tasks.get(work.taskId);
        if (args.status === 'failed') {
          if (['review', 'requirements'].includes(contract.kind) && ['needs_revision', 'reject'].includes(args.verdict))
            return handoff.exclusive(exec.signal, async () => {
              archive.append('quality/review-submitted', { taskId: work.taskId, runtimeTaskId: work.task.id, attemptId: work.attemptId, verdict: args.verdict, findings: args.findings }, { sessionId: exec.agent.id, taskId: work.taskId, attemptId: work.attemptId });
              rework.prepare(work, args);
              try { const result = await next(); rework.finish(result); return result; }
              catch (error) { rework.pending = undefined; throw error; }
            });
          return next();
        }
        return handoff.exclusive(exec.signal, async () => {
          let record;
          try { record = handoff.prepare(work.taskId, work.attemptId, args); }
          catch (error) { throw handoff.block(work.taskId, work.attemptId, error); }
          const previous = handoff.accepted.get(work.taskId);
          // Native update commits state and queues dependents before returning.
          // This provisional seal is usable only behind native completed state;
          // the shared mutex fences their first request until the outcome is known.
          handoff.stage(record);
          try {
            const result = await next();
            if (result.isError) handoff.rollback(record, previous); else {
              handoff.commit(record);
              if (['review','requirements'].includes(contract.kind)) archive.append('quality/reviewed', { taskId: work.taskId, runtimeTaskId: work.task.id, attemptId: work.attemptId, verdict: args.verdict, findings: args.findings ?? [], reworkRound: contract.reworkRound ?? 0, inputs: record.inputs }, { sessionId: exec.agent.id, taskId: work.taskId, attemptId: work.attemptId });
            }
            return result;
          } catch (error) { handoff.rollback(record, previous); throw error; }
        });
      });
    }
    if (archive) trace = attachTrace(ctx, archive,product?taskFor:undefined);
    if(product)adapter.attribution=(sessionId)=>{const request=trace?.request(sessionId)??{},employee=adapter.sessionPolicies?.get(sessionId),taskId=taskIds.get(request.taskId)??request.taskId;return {...request,sessionId,agentId:employee?.id,employeeId:employee?.employeeId,taskId,runtimeTaskId:request.taskId,reworkRound:rework?.contractFor(request.taskId)?.reworkRound};};
    await mount('@deepseek-ai/dsh-session-persistence-jsonl', { root: sessionRoot, compression: 'none' });
    // Idle continuable members can be disposed between assignments. Their next
    // task needs the public query service to read and resume the saved session.
    await mount('@deepseek-ai/dsh-session-query');
    employees = new EmployeeHostFactory({ coordinator: ctx, provider, sessionRoot, trace, archive,
      context: context ?? (product ? { mode: product.snapshot.policy?.contextManagement ?? 'summary' } : undefined),
      protectedContext: product ? protectedContext : undefined,
      identify: agent => product ? (agent.session.header.parentSession ? employeeFor(agent, product.snapshot, captainId) : product.snapshot.agents.find(item => item.role === 'manager')) : undefined,
      loadPlugin: name => import(pathToFileURL(baseRequire.resolve(name)).href) });
    removeFactory = ctx.agents.setFactory(employees);
    archive?.append('runtime/architecture', { version: 'employee-host-v1', isolation: 'host', process: 'shared', coordinatorOwns: ['team', 'budget', 'permissions', 'handoff'] });
    await mount('@deepseek-ai/dsh-subagent');
    await mount('@deepseek-ai/dsh-subagent-spawn-in-process', { providerName: 'spawn' });
    const fiber = ctx.plugin(teams, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers, slashCommand: false });
    fibers.push(fiber);
    await fiber.await();
    return {
      ctx,
      employeeHosts() { return employees.list(); },
      checkpointState() { return teamId && workspaceRoot ? teamState() : undefined; },
      close,
      lockPlan() { locked = true; },
      handoffStatus() { return handoff?.summary() ?? []; },
      hasBlockingFailure(tasks) { return rework ? rework.hasBlockingFailure(tasks) : tasks.some(task => task.status === 'failed'); },
      async verifyDeliverable(signal) {
        if (!handoff) return;
        await handoff.exclusive(signal, () => {
          rework.check();
          const state = teamState();
          for (const contract of handoff.tasks.values()) {
            const task = state.tasks.findLast(t => taskIds.get(t.id) === contract.id);
            if (task?.status !== 'completed' || handoff.accepted.get(contract.id)?.attemptId !== task.attemptId)
              throw Error('HANDOFF_NOT_COMMITTED: ' + contract.id);
          }
        });
      },
      bindTaskMapping(tasks,id) { teamId=id;for(const task of tasks)taskIds.set(task.task_id,task.seed_id); },
      async captain({ cwd, model, instructions, maxTokens, id = randomUUID() }) {
        workspaceRoot=cwd;
        const handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions: { provider, model, ...(maxTokens ? { maxTokens } : {}) },
          setup: instructions ? agentCtx => { agentCtx.systemPrompt.section({ name: 'department:role', order: 118, text: instructions }); } : undefined });
        handles.push(handle);
        captainId = handle.agent.id;
        if(product)adapter.sessionPolicies?.set(captainId,product.snapshot.agents.find(a=>a.role==='manager'));
        return handle.agent;
      },
      async resumeCaptain({ id, model }) {
        const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider, model } });
        handles.push(handle);
        return handle.agent;
      },
      async call(agent, name, args = {}, signal = AbortSignal.timeout(15_000)) {
        trace?.check();
        if (!agent) throw new Error('A live calling agent is required');
        if (ctx.agents.get(agent.id) !== agent) throw new Error('EMPLOYEE_NOT_LIVE: 员工宿主已释放');
        const result = await agent.ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent, signal });
        if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
        trace?.check();
        if (archive && name === 'agent_teams_status') archive.append('team/snapshot', result.value, { sessionId: agent.id });
        return result.value;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
