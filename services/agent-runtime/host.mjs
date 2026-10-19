import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { isAbsolute,join,dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as teams from '@nanmicoder/dsh-agent-teams';
import { attachTrace } from './trace.mjs';
import { installProductTools, employeeFor } from './product-tools.mjs';
import { installNativePluginTools } from './native-plugin-tools.mjs';
import { assignedTask } from './task-attribution.mjs';
import { HandoffGate } from './handoff.mjs';
import {listArtifacts} from './sandbox.mjs';
import { ReworkGate } from './rework.mjs';
import { EmployeeHostFactory } from './employee-hosts.mjs';
import { recoveryContext } from './checkpoint-context.mjs';
import { restoreStagedCheckpoints } from './checkpoint-team.mjs';
import { executionBudgetContext } from './budget-context.mjs';
import { readOnlyEvidenceSignature, completedWriteEvidenceSignature } from './request-context.mjs';
import { captureBudgetEvidence, taskRunEvidence } from './run-evidence.mjs';
import {assertDeliveryCriteria} from './delivery-criteria.mjs';
import { handoffReportGuidance } from '../../packages/contracts/handoff-report.mjs';

// Resolve base-owned providers through the installed bundle, including nested npm dependencies.
const require = createRequire(import.meta.url);
const baseRequire = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));
// Pinned AgentTeams 0.1.20 exports these pure helpers from its installed
// scheduler module. Reuse its exact truncation/ordering for byte attestation.
const { collectCompletedDependencyOutputs, formatDependencyOutputs } = await import(pathToFileURL(join(dirname(require.resolve('@nanmicoder/dsh-agent-teams/package.json')),'lib/scheduler.js')).href);
const completeContextGuards = new WeakMap();
export function reviewCompletionGuidance(contract, outputLimit) {
  if (!['review', 'requirements'].includes(contract?.kind)) return undefined;
  const cap = Number.isSafeInteger(outputLimit) && outputLimit > 0 ? `单次输出最多 ${outputLimit} Token，实际请求或备用路线可更小。` : '单次输出遵守本次请求已批准的 Token 上限。';
  return `${cap}你在本节点是执行员工，即使职位是经理，也不能以协调回复代替交接。依据建议不超过600中文字；逐项用紧凑完整句，不写长表、不重复源码或完整测试日志，仍核对全部验收。工作完成先调用原生 agent_teams_update_task，提交完整JSON：task_id用runtimeTaskId、attempt_id用当前attemptId，status/output/verdict按真实结果填写。仅全部满足时status=completed、verdict=pass；needs_revision/reject用status=failed，并提交findings每项id、severity、problem、requiredFix及必要定位。合同/工具要求的acceptanceResults、commandsRun等字段仍须完整如实填写，不省略必需证据或编造测试。普通最终文字、send_message均不能完成节点；正式交接成功后由宿主结束当前回合，结论写在output中，不再额外调用模型重述。outputs为空时保持只读，不写报告文件。不能提高输出、预算、权限或调用上限。`;
}

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
  const internalStatusPolls = new Set();
  const handoff = product?.snapshot.tasks ? new HandoffGate({ snapshot: product.snapshot, sandbox: product.sandbox, archive }) : undefined;
  if (handoff && product.goal?.expected) {
    for (const method of ['beforeFile','observe']) {
      const original = handoff[method].bind(handoff);
      handoff[method] = (...args) => {
        try { return original(...args); }
        catch (error) {
          if(method==='beforeFile'&&args[2]==='filesystem'&&error.code==='UNDECLARED_INPUT'&&error.notExecuted===true){
            archive.append('goal/tool-denied',{point:'file-scope',taskId:args[0],code:error.code,message:error.message,notExecuted:true});
            throw error;
          }
          throw product.goal.block(error, 'file-scope', args[0]);
        }
      };
    }
  }
  const readEvidence = new Map();
  const writeEvidence = new Map();
  let employeeContext = context ?? (product ? { mode: product.snapshot.policy?.contextManagement ?? 'summary' } : undefined);
  if (employeeContext && typeof adapter.prepareRequest === 'function') {
    let guard = completeContextGuards.get(adapter);
    if (!guard) {
      guard = { sessions: new Set(), previous: adapter.requireCompleteContext };
      completeContextGuards.set(adapter, guard);
      adapter.requireCompleteContext = sessionId => guard.sessions.has(sessionId) ||
        (typeof guard.previous === 'function' && guard.previous.call(adapter, sessionId) === true);
    }
    const notifyRetained = employeeContext.onRetainOriginal;
    employeeContext = { ...employeeContext, requestPreview: options => adapter.prepareRequest(options),
      shouldDeferSummary:sessionId=>Boolean(adapter.handoffClosure?.(sessionId)),
      onRetainOriginal(sessionId, retained) {
        if (retained) guard.sessions.add(sessionId); else guard.sessions.delete(sessionId);
        notifyRetained?.(sessionId, retained);
      } };
  }
  const rework = handoff ? new ReworkGate({ snapshot: product.snapshot, handoff, archive, taskIds, state: teamState, onBlocked: product.onHandoffBlocked }) : undefined;
  function teamState() {
    if (!teamId || !workspaceRoot) throw Error('TASK_ATTRIBUTION_MISSING: 团队执行状态未就绪');
    return JSON.parse(readFileSync(join(workspaceRoot, '.agent-teams', teamId, 'team.json'), 'utf8'));
  }
  function checkpointState(point = 'runtime-checkpoint') {
    return teamId && workspaceRoot ? { ...teamState(), budgetEvidence: captureBudgetEvidence(product?.snapshot, adapter.budget, archive?.id, point) } : undefined;
  }
  function taskFor(sessionId) {
    product?.goal?.check('task-context');
    product?.supervisor?.check();
    rework?.check();
    if(sessionId===captainId)return undefined; // Coordination is charged to the project, not an arbitrary task.
    const employee=employeeFor(ctx.agents.get(sessionId),product.snapshot,captainId);
    if(!teamId||!workspaceRoot||!employee)throw Error('TASK_ATTRIBUTION_MISSING: 团队执行状态未就绪');
    const state=teamState();
    const task=assignedTask(state,sessionId,employee.id,assignments.get(sessionId));assignments.set(sessionId,task);return task;
  }
  function nativeTaskId(requested) {
    if(taskIds.has(requested))return requested;
    const matches=[...taskIds].filter(([,approved])=>approved===requested);
    return matches.length===1?matches[0][0]:requested;
  }
  function activeWork(agent, requested) {
    product?.goal?.check('tool',requested && taskIds.get(requested));
    product?.supervisor?.check();
    rework?.check();
    const state = teamState(), employee = employeeFor(agent, product.snapshot, captainId);
    const task = requested ? state.tasks.find(t => t.id === nativeTaskId(requested)) : state.tasks.find(t => t.assignee === employee?.id && ['claimed', 'in_progress'].includes(t.status));
    if (!task || !employee || task.assignee !== employee.id || !state.members.some(m => m.id === agent.id && m.name === employee.id) || !['claimed', 'in_progress'].includes(task.status)) throw Error('TASK_NOT_ACTIVE: 工具仅能用于当前分派的任务');
    const id = taskIds.get(task.id);
    if (!id) throw Error('UNAPPROVED_TASK: ' + task.id);
    return { taskId: id, attemptId: task.attemptId, task };
  }
  function captureReadScope(agent) {
    if (!product || !handoff || agent.id === captainId) return undefined;
    const employee=employeeFor(agent,product.snapshot,captainId),work=activeWork(agent);
    if(!employee?.employeeId||!work.attemptId)return undefined;
    return Object.freeze({sessionId:agent.id,employeeId:employee.employeeId,taskId:work.taskId,attemptId:work.attemptId,
      scopeId:createHash('sha256').update(JSON.stringify({runId:archive.id,planVersion:product.snapshot.planVersion,employeeId:employee.employeeId,taskId:work.taskId,attemptId:work.attemptId})).digest('hex')});
  }
  function onReadEvidence({name,args,value,scope,agent,callId}) {
    const current=captureReadScope(agent),signature=readOnlyEvidenceSignature(name,args,value);
    if(!signature||!current||JSON.stringify(current)!==JSON.stringify(scope)||typeof callId!=='string')return;
    const proof=Object.freeze({...scope,...signature,...(name==='filesystem'?{path:args.path,sha256:value.sha256}:{})});
    archive.append('context/read-evidence',{callId,...proof},{sessionId:agent.id,taskId:scope.taskId,attemptId:scope.attemptId});
    const key=agent.id+':'+callId;
    if(readEvidence.has(key))readEvidence.set(key,null);else readEvidence.set(key,proof);
  }
  function onWriteEvidence({args,value,scope,agent,callId}) {
    const current=captureReadScope(agent),signature=completedWriteEvidenceSignature(args,value);
    const contract=current&&handoff.tasks.get(current.taskId);
    if(!signature||!current||JSON.stringify(current)!==JSON.stringify(scope)||typeof callId!=='string'||
       !contract?.outputs?.some(file=>file.path===args.path)||contract.inputs?.some(file=>file.path===args.path))return;
    const proof=Object.freeze({...scope,...signature});
    archive.append('context/write-evidence',{callId,...proof},{sessionId:agent.id,taskId:scope.taskId,attemptId:scope.attemptId});
    const key=agent.id+':'+callId;
    if(writeEvidence.has(key))writeEvidence.set(key,null);else writeEvidence.set(key,proof);
  }
  function attestSupersededRead({sessionId,employeeId,taskId,attemptId,read,write}) {
    const old=readEvidence.get(sessionId+':'+read.callId),fresh=writeEvidence.get(sessionId+':'+write.callId);
    if(!old||!fresh||old.name!=='filesystem'||fresh.name!=='artifact_write'||old.scopeId!==fresh.scopeId||
      [old,fresh].some(proof=>proof.sessionId!==sessionId||proof.employeeId!==employeeId||proof.taskId!==taskId||proof.attemptId!==attemptId)||
      old.path!==fresh.path||old.sha256!==fresh.expectedSha256||fresh.sha256===old.sha256||
      old.argumentsSha256!==read.argumentsSha256||old.resultSha256!==read.resultSha256||
      fresh.argumentsSha256!==write.argumentsSha256||fresh.resultSha256!==write.resultSha256)return;
    return Object.freeze({scopeId:old.scopeId,successful:true,complete:true,superseded:true});
  }
  function attestReadGroup({sessionId,employeeId,taskId,attemptId,calls,canonicalSha256}) {
    if(!product||!sessionId||!employeeId||!taskId||!attemptId||!Array.isArray(calls)||!calls.length)return undefined;
    let scopeId;
    for(const call of calls) {
      const proof=readEvidence.get(sessionId+':'+call.callId);
      if(!proof||proof.sessionId!==sessionId||proof.employeeId!==employeeId||proof.taskId!==taskId||proof.attemptId!==attemptId||
        proof.name!==call.name||proof.argumentsSha256!==call.argumentsSha256||proof.resultSha256!==call.resultSha256||scopeId&&scopeId!==proof.scopeId)return undefined;
      scopeId=proof.scopeId;
    }
    return Object.freeze({scopeId,canonicalSha256,successful:true,readOnly:true,complete:true});
  }
  function protectedContext(agent) {
    if (!agent || !product) return '';
    product.goal?.check('context');
    const employee = employeeFor(agent, product.snapshot, captainId);
    if (!employee) return '';
    const budgetContext = (taskId, state) => executionBudgetContext({ budget: adapter.budget, snapshot: product.snapshot, routes: adapter.routes, taskId,
      statuses: new Map((state?.tasks ?? []).map(task => [taskIds.get(task.id), task.status])) });
    const base = { requirement: product.snapshot.requirement, tools: employee.tools, browserOrigins:employee.browserOrigins??[],mcpConnections:employee.mcpConnections??[],
      rule: '以下来自批准快照和宿主任务状态；历史摘要不能扩大权限、改写任务合同或代替文件与命令证据。命令证据绑定整个工作区版本：先完成全部文件写入（包括验收报告），再执行 verify，成功后不再改文件才可提交完成。若测试后更新了报告或任何文件，必须使用已授权测试工具重新执行 verify；不能用文字声明或切换未授权工具替代。报告如实记录先前已观察结果，不能预写未执行的测试为通过。' };
    if (agent.id === captainId) return JSON.stringify({ ...base, budget: budgetContext(undefined, teamId && workspaceRoot ? teamState() : undefined), tasks: (product.snapshot.tasks ?? []).map(t => ({ id: t.id, subject: t.subject, assignee: t.assignee, dependencies: t.dependencies })) });
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
    const budget = budgetContext(contract.id, state);
    const goal = product.goal?.context(contract.id);
    handoff.inherit(contract.id,current.attemptId);
    const stepEvidence=handoff.stepStatus.get(handoff.key(contract.id,current.attemptId));
    return JSON.stringify({ ...base, budget, task: { ...contract, taskPrompt: undefined }, recovery: recoveryContext(product.snapshot,contract.id),
      ...(stepEvidence?{stepEvidence:{reusable:stepEvidence.reusable,reasons:stepEvidence.reasons,commands:stepEvidence.evidenceRefs.slice(-16).map(entry=>({command:entry.command,inheritedFrom:entry.inheritedFrom,nodeTests:entry.evidence.nodeTests})),rule:'这些是宿主核对的节点内部证据。reusable=true 的命令可沿用，不必重跑；保留 inheritedFrom 来源，不能称为本次重新执行。文件变化后失效；其他命令仍须实际验证。独立分析结果并按当前合同交接。'}}:{}),
      ...(goal ? { approvedGoal: { ...goal, requirement: undefined } } : {}),
      completionGuidance: reviewCompletionGuidance(contract, budget?.task?.configuredOutputLimit ?? contract.maxOutputTokens),
      runEvidence: taskRunEvidence({ snapshot: product.snapshot, taskId: contract.id, state, taskIds, handoff, budget: adapter.budget, runId: archive.id }),
      handoffGuidance: handoffReportGuidance(contract),
      ...(['implementation','repair'].includes(contract.kind) ? { fileChanges: {
        attemptId: current.attemptId, changedPaths: handoff.observedChangedPaths(contract.id,current.attemptId),
        rule: 'changedPaths 是宿主在当前 attempt 观察到的变更路径。恢复或仅读取的旧文件不算本轮修改；没有变更时填 []，不是 outputs 清单。每次工具执行后刷新；不要为凑清单重写文件。交付文件与真实测试仍须独立核验。',
      } } : {}),
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
      productDispose = installProductTools(ctx, { ...product, archive, handoff, activeWork, captainId: () => captainId, captureReadScope, onReadEvidence, onWriteEvidence });
      const disposeProduct = productDispose;
      const disposeNative = installNativePluginTools(ctx, { ...product, archive, handoff, activeWork, captainId: () => captainId });
      productDispose = () => { disposeNative(); disposeProduct(); };
      ctx.on('llm/stream', async function* (options, next) {
        product.goal?.check('model');
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
            try { await handoff.exclusive(options.signal, () => { product.goal?.nodeStarted(taskId,task.attemptId);return handoff.begin(taskId, task.attemptId); }); }
            catch (error) { const blocked = handoff.block(taskId, task.attemptId, error); product.onHandoffBlocked?.(blocked); throw blocked; }
          }
        }
        const stopWaiting=product.supervisor?.enter(options.sessionId,'waiting_capacity');
        let release;
        try{release=await product.gate.acquire(options.signal);}finally{stopWaiting?.();}
        try { product.supervisor?.check(); yield* next(); } finally { release(); }
      });
      ctx.on('tools/pre-execute', async (exec,next) => {
        product.goal?.check('tool');
        product.supervisor?.check();
        if (locked && exec.name.startsWith('agent_teams_') && !['agent_teams_status','agent_teams_claim_task','agent_teams_update_task','agent_teams_send_message'].includes(exec.name)) {
          const error=Error('APPROVED_PLAN_IMMUTABLE: 运行中不能扩大批准的组织和任务范围');
          throw product.goal?.expected ? product.goal.block(error,'plan-change') : error;
        }
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
          product.goal?.check('handoff',work.taskId);
          let record;
          try { record = handoff.prepare(work.taskId, work.attemptId, args); }
          catch (error) { throw handoff.block(work.taskId, work.attemptId, error); }
          const previous = handoff.accepted.get(work.taskId);
          record.budgetEvidence = captureBudgetEvidence(product.snapshot, adapter.budget, archive.id, 'node-accepted');
          // Native update commits state and queues dependents before returning.
          // This provisional seal is usable only behind native completed state;
          // the shared mutex fences their first request until the outcome is known.
          handoff.stage(record);
          try {
            const result = await next();
            if (result.isError) handoff.rollback(record, previous); else {
              handoff.commit(record);
              product.goal?.nodeAccepted(record);
              if (['review','requirements'].includes(contract.kind)) archive.append('quality/reviewed', { taskId: work.taskId, runtimeTaskId: work.task.id, attemptId: work.attemptId, verdict: args.verdict, findings: args.findings ?? [], reworkRound: contract.reworkRound ?? 0, inputs: record.inputs }, { sessionId: exec.agent.id, taskId: work.taskId, attemptId: work.attemptId });
              archive.append('team/checkpoint',checkpointState('node-accepted'));
            }
            return result;
          } catch (error) { handoff.rollback(record, previous); throw error; }
        });
      });
    }
    if (archive) trace = attachTrace(ctx, archive,product?taskFor:undefined,exec=>internalStatusPolls.has(exec.callId));
    if(product)adapter.attribution=(sessionId)=>{const request=trace?.request(sessionId)??{},employee=adapter.sessionPolicies?.get(sessionId),taskId=taskIds.get(request.taskId)??request.taskId;return {...request,sessionId,agentId:employee?.id,employeeId:employee?.employeeId,taskId,runtimeTaskId:request.taskId,reworkRound:rework?.contractFor(request.taskId)?.reworkRound};};
    if(product)adapter.attestReadGroup=attestReadGroup;
    if(product)adapter.attestSupersededRead=attestSupersededRead;
    await mount('@deepseek-ai/dsh-session-persistence-jsonl', { root: sessionRoot, compression: 'none' });
    // The factory below places captain/member sessions in EmployeeHosts, which
    // mount the official checkpoint policy. This coordinator does not own their
    // sessions; flushing a bridged employee tool here would use the wrong store.
    // Idle continuable members can be disposed between assignments. Their next
    // task needs the public query service to read and resume the saved session.
    await mount('@deepseek-ai/dsh-session-query');
    const pendingCompletion=handoff ? agent => {
        if (agent.id === captainId) return;
        let work;
        try { work = activeWork(agent); }
        catch (error) { if (error.message.startsWith('TASK_NOT_ACTIVE:')) return; throw error; }
        if (handoff.committed.get(work.taskId)?.attemptId === work.attemptId) return;
        return { taskId: work.taskId, runtimeTaskId: work.task.id, attemptId: work.attemptId,taskStatus:work.task.status };
      } : undefined;
    const handoffClosure=agent=>{
      const work=pendingCompletion?.(agent),budget=adapter.budget;
      if(!work||!budget?.run)return;
      const task=budget.tasks.get(work.taskId);if(!task)return;
      if(Math.min(task.maxCalls-task.calls,budget.run.maxCalls-budget.run.calls)===1)return work;
    };
    if(handoff)adapter.handoffClosure=sessionId=>{
      const agent=ctx.agents.get(sessionId);return agent&&handoffClosure(agent);
    };
    employees = new EmployeeHostFactory({ coordinator: ctx, provider, sessionRoot, trace, archive,
      context: employeeContext, skillManifest: product?.snapshot.knowledge, queryKnowledge:product?.queryKnowledge, activeWork:product?activeWork:undefined,
      pendingCompletion,handoffClosure:handoff?handoffClosure:undefined,
      assignmentReports:handoff?agent=>{const work=activeWork(agent);return formatDependencyOutputs(collectCompletedDependencyOutputs(teamState().tasks,work.task.id));}:undefined,
      onIncompleteCompletion: product?.onHandoffBlocked,
      prepareToolArguments: handoff ? (agent,name,args) => {
        if(!['agent_teams_claim_task','agent_teams_update_task'].includes(name)||nativeTaskId(args.task_id)===args.task_id)return args;
        // Resolve a unique approved alias before the native registry freezes input.
        const work=activeWork(agent,args.task_id);
        if(name==='agent_teams_update_task'&&args.attempt_id!==work.attemptId)throw Error('STALE_ATTEMPT: 任务更新需要当前任务凭证');
        return {...args,task_id:work.task.id};
      } : undefined,
      concludesAcceptedTask: handoff ? exec => {
        if (exec.name !== 'agent_teams_update_task' || exec.arguments.status !== 'completed' || exec.agent.id === captainId) return false;
        const task = teamState().tasks.find(item => item.id === nativeTaskId(exec.arguments.task_id));
        const employee = employeeFor(exec.agent, product.snapshot, captainId);
        const accepted = handoff.committed.get(taskIds.get(task?.id));
        const concluded = Boolean(task?.status === 'completed' && task.assignee === employee?.id &&
          task.attemptId === exec.arguments.attempt_id && accepted?.attemptId === task.attemptId);
        if (concluded) archive.append('handoff/turn-concluded', { taskId: accepted.taskId, runtimeTaskId: task.id, attemptId: task.attemptId }, { sessionId: exec.agent.id });
        return concluded;
      } : undefined,
      protectedContext: product ? protectedContext : undefined,
      waitForProtectedContext: handoff ? async (agent, signal) => {
        if(agent.id===captainId)return;
        await agent.ctx.sessions.flush(agent.session);
        await handoff.exclusive(signal,()=>{
          product?.supervisor?.check();
          let work;try{work=activeWork(agent);}catch(error){if(error.message.startsWith('TASK_NOT_ACTIVE:'))return;throw error;}
          const events=agent.session.snapshotEvents();
          if(events.some(event=>event.type==='assistant/message'))handoff.checkpoint(work.taskId,work.attemptId,'cycle-complete',{sessionId:agent.id,sessionCursor:events.at(-1)?.seq});
        });
      } : undefined,
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
      assertApprovedTaskContext(tasks) {
        return Boolean(product && handoff && employees?.protectedContext === protectedContext &&
          handoff.snapshot === product.snapshot && JSON.stringify(tasks) === JSON.stringify(product.snapshot.tasks) &&
          tasks.every(task => handoff.tasks.get(task.id) === product.snapshot.tasks.find(approved => approved.id === task.id)));
      },
      checkpointState,
      attestReadGroup,
      attestSupersededRead,
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
          if(product.snapshot.deliveryCriteria?.length){
            const files=listArtifacts(product.sandbox.root);
            archive.append('delivery/checked',{files});
            const criteria=assertDeliveryCriteria(product.snapshot,handoff.committed,[...handoff.tasks.values()],files);
            archive.append('delivery/verified',{criteria,files});
          }
        });
      },
      bindTaskMapping(tasks,id) { teamId=id;for(const task of tasks)taskIds.set(task.task_id,task.seed_id); },
      async restoreCheckpoints(mapping) {
        if (!product?.snapshot.recovery) return;
        const state = await restoreStagedCheckpoints(join(workspaceRoot,'.agent-teams'),teamId,mapping,product.snapshot.recovery);
        archive.append('recovery/restored',{sourceRunId:product.snapshot.recovery.sourceRunId,completed:product.snapshot.recovery.completed.map(task=>task.taskId),files:product.snapshot.recovery.files});
        archive.append('team/checkpoint',{ ...state, budgetEvidence: captureBudgetEvidence(product.snapshot, adapter.budget, archive.id, 'restored') });
      },
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
        const callId = randomUUID();
        if (name === 'agent_teams_status' && agent.id === captainId) internalStatusPolls.add(callId);
        try {
          const result = await agent.ctx.tools.execute({ callId, name, arguments: args, agent, signal });
          if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
          trace?.check();
          if (archive && name === 'agent_teams_status' && agent.id !== captainId) archive.append('team/snapshot', result.value, { sessionId: agent.id });
          return result.value;
        } finally { internalStatusPolls.delete(callId); }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
