import { Context } from '@deepseek-ai/cordis';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { LlmAdapter, HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt';
import { randomUUID } from 'node:crypto';
import { installEmployeeContext } from './employee-context.mjs';
import { installEmployeeToolAccess } from './employee-tool-access.mjs';
import { installApprovedSkills } from './approved-skills.mjs';
import { installEmployeeCapabilities } from './employee-capabilities.mjs';
import { projectAssignmentReports, projectClaimReport } from './assignment-reports.mjs';
import { employeeHandoffDefinition, nativeHandoffArguments } from './employee-handoff.mjs';
import {installTaskToolBoundary} from './task-tool-boundary.mjs';
import { observeNativeTeardown } from './host-lifecycle.mjs';
import { captureToolDefinition, indexEffectContracts } from './tool-definition-effects.mjs';
import { effectDigest } from './tool-effects.mjs';
import { installToolEffectRuntime } from './tool-effect-runtime.mjs';

const mergeNamed = (shared, local) => [...new Map([...shared, ...local].map(item => [item.name, item])).values()];

/** Public AgentFactory seam: coordination owns identities; each Agent owns a Host. */
export class EmployeeHostFactory {
  constructor({ coordinator, loadPlugin, provider, sessionRoot, trace, archive, identify, context, protectedContext, waitForProtectedContext, concludesAcceptedTask, skillManifest, queryKnowledge, beforeTool,beforeKnowledge,activeWork, prepareToolArguments, pendingCompletion, handoffClosure, onIncompleteCompletion, assignmentReports, taskToolBoundary, effectSnapshot, effectAuthority }) {
    Object.assign(this, { coordinator, loadPlugin, provider, sessionRoot, trace, archive, identify, context, protectedContext, waitForProtectedContext, concludesAcceptedTask, skillManifest, queryKnowledge,beforeTool,beforeKnowledge, activeWork, prepareToolArguments, pendingCompletion, handoffClosure, onIncompleteCompletion, assignmentReports });
    this.effectContracts = indexEffectContracts(effectSnapshot);
    this.effectSnapshot = this.effectContracts && { effectContractVersion: 1, effectContracts: [...this.effectContracts.values()] };
    this.effectAuthority = effectAuthority;
    if (this.effectContracts && (typeof effectAuthority?.assertSnapshot !== 'function' || typeof effectAuthority?.withAdmission !== 'function')) throw Error('TOOL_EFFECT_AUTHORITY_REQUIRED');
    this.taskToolBoundary=taskToolBoundary===true || Boolean(this.effectContracts);
    this.effectForwards = new Map();
    this.effectExecutions = new WeakMap();
    if (this.effectContracts) this.removeEffectGuard = coordinator.tools.guard(exec => {
      const permit = this.effectForwards.get(exec.callId);
      this.effectForwards.delete(exec.callId);
      if (!permit || permit.agent !== exec.agent || permit.name !== exec.name || permit.argumentsSha256 !== effectDigest(exec.arguments))
        return 'TOOL_EFFECT_FORWARD_REQUIRED: 必须经已批准的员工合同入口调用';
      this.effectExecutions.set(exec,permit);
    });
    this.live = new Map();
    this.pending = new Set();
    this.closed = false;
    this.completionReminders = new Set();
    this.closureNotices = new Set();
    // The factory is installed before agent-teams mounts its tools. Freeze at
    // first admission, after that native registration phase has completed.
    this.coordinatorDefinitions = undefined;
  }

  createAgent(ownerCtx, options) { return this.materialize(ownerCtx, options, false); }
  resume(ownerCtx, options) { return this.materialize(ownerCtx, options, true); }

  async materialize(ownerCtx, options, resume) {
    if (this.closed) throw Error('EMPLOYEE_HOSTS_CLOSED');
    if (this.effectContracts) await this.effectAuthority.assertSnapshot(this.effectSnapshot, options.signal);
    if (this.closed) throw Error('EMPLOYEE_HOSTS_CLOSED');
    this.coordinatorDefinitions ??= new Map(this.coordinator.tools.schemas().map(schema => {
      const definition = this.coordinator.tools.get(schema.name);
      return [schema.name, { definition, binding: captureToolDefinition(definition, 'weiwu-coordinator-registry-v1') }];
    }));
    ownerCtx.fiber.assertActive();
    const sessionId = resume ? options.resumeSessionId : options.sessionId;
    if (this.live.has(sessionId)) throw Error('EMPLOYEE_ALREADY_ACTIVE: ' + sessionId);
    const hostId = randomUUID(), ctx = new Context(), fibers = [];
    const nativeTeardown = observeNativeTeardown(ctx);
    const abort = new AbortController(), ready = Promise.withResolvers();
    const slot = { hostId, sessionId, ctx, agent: undefined, close: undefined, stopAdmission: () => { boundary?.stopAdmission(); runtimeEffects?.stopAdmission(); } };
    let handle, detachAgent, unfollowOwner, disposing, boundary, runtimeEffects, skillSourceCheck, nativeStarted = false;
    const setups = new Set();
    const signal = AbortSignal.any([abort.signal, ...(options.signal ? [options.signal] : [])]);
    const checkAdmission = () => {
      signal.throwIfAborted();
      if (this.closed) throw Error('EMPLOYEE_HOSTS_CLOSED');
    };
    const dispose = (ownerTriggered = false) => disposing ??= (async () => {
      slot.stopAdmission();
      abort.abort(Error('Employee host disposed'));
      await ready.promise;
      const failures = [];
      await Promise.allSettled([...setups]);
      if (nativeStarted && !handle) failures.push(Object.assign(Error('RUNTIME_WRITER_DRAIN_UNPROVEN'), { code: 'RUNTIME_WRITER_DRAIN_UNPROVEN' }));
      try { if (handle) await this.coordinator.subagents?.drainContinuableDescendants([handle.agent]); }
      catch (error) { failures.push(error); }
      try { await handle?.dispose(); } catch (error) { failures.push(error); }
      try { await runtimeEffects?.close(); } catch (error) { failures.push(error); }
      detachAgent?.();
      for (const fiber of fibers.reverse()) {
        try { await fiber.dispose(); } catch (error) { failures.push(error); }
      }

      try { if (handle) this.archive?.append('runtime/disposed', { hostId, sessionId, agentId: slot.agentId, employeeId: slot.employeeId }, { sessionId }); }
      catch (error) { failures.push(error); }
      try { if (!ownerTriggered) await unfollowOwner?.(); } catch (error) { failures.push(error); }
      try { nativeTeardown.check(); } catch (error) { failures.push(error); }
      if (failures.length) {
        const error = new AggregateError(failures, 'Employee host teardown failed');
        if (failures.some(failure => failure.code === 'RUNTIME_WRITER_DRAIN_UNPROVEN')) error.code = 'RUNTIME_WRITER_DRAIN_UNPROVEN';
        throw error;
      }
      this.live.delete(sessionId);
      boundary?.dispose();
      nativeTeardown.detach();
    })();
    slot.close = (...args) => { const work = dispose(...args); work.catch(() => {}); return work; };
    this.live.set(sessionId, slot);
    this.pending.add(ready.promise);
    unfollowOwner = ownerCtx.effect(() => () => { if (!disposing) return dispose(true); }, `employeeHost(${sessionId})`);
    const mount = async (name, config) => {
      checkAdmission();
      const mod = typeof name === 'string' ? await this.loadPlugin(name) : { default: name };
      checkAdmission();
      const fiber = ctx.plugin(mod.default ?? mod, config);
      fibers.push(fiber);
      await fiber.await(); checkAdmission();
    };
    try {
      await mount('@deepseek-ai/dsh-llm');
      const coordinator = this.coordinator;
      // Model transport and shared budgets stay at the coordination boundary.
      // Message history, prompt assembly, model selection and loops are local.
      ctx.llm.registerAdapter([this.provider], new class extends LlmAdapter {
        providerInfo(provider) { return { id: provider, name: 'Department relay' }; }
        listModels(provider) { return coordinator.llm.listModels(provider); }
        resolveModel(provider, model, signal) { return coordinator.llm.resolveModelInfo(provider, model, signal); }
        async *stream(request) { yield* coordinator.llm.stream(request); }
      }());
      await mount('@deepseek-ai/dsh-session');
      await mount('@deepseek-ai/dsh-session-projection');
      await mount('@deepseek-ai/dsh-system-prompt');
      await mount('@deepseek-ai/dsh-tools', { mode: 'native' });
      if(this.taskToolBoundary)boundary=installTaskToolBoundary(ctx);
      await mount('@deepseek-ai/dsh-agent');
      await mount('@deepseek-ai/dsh-session-persistence-jsonl', { root: this.sessionRoot, compression: 'none' });
      // Captain and members both own their session in this Host. Reuse the
      // official durability barriers before requests and top-level tool bodies.
      await mount('@deepseek-ai/dsh-session-checkpoint-policy');
      await mount('@deepseek-ai/dsh-session-query');
      await mount('@deepseek-ai/dsh-agent-loop', { agents: [] });
      if (this.context) await installEmployeeContext(ctx, mount, { ...this.context, archive: this.archive });
      if (this.protectedContext) ctx.systemPrompt.context({ name: 'department:approved-context', order: 119,
        text: context => this.protectedContext(context.agent) });
      // DSH preserves invalid model JSON as text. Keep rejecting it, but explain
      // the actual syntax problem before the native object-schema error hides it.
      if(this.protectedContext)ctx.on('tools/execute',async(exec,next)=>{
        if(exec.name!=='agent_teams_update_task'||exec.arguments&&typeof exec.arguments==='object'&&!Array.isArray(exec.arguments))return next();
        let location='';
        if(typeof exec.arguments==='string')try{JSON.parse(exec.arguments);}catch(error){
          // Never echo provider text or a parser excerpt containing private data.
          const position=/position (\d+)/i.exec(String(error.message))?.[1];
          if(position)location=`（字符位置 ${position}）`;
        }
        throw new HarnessError(`HANDOFF_ARGUMENTS_JSON: 工具 arguments 必须是合法 JSON 对象${location}；检查多余括号、引号和逗号，不能使用 commandsRun? 等 TypeScript 写法。经理交接使用 report 对象，不转义为 output 字符串。请缩短报告并依据已有真实证据重新提交。宿主不会自动修复或执行这次非法参数，也不会重跑文件或测试；纠正仍计入原调用次数和费用。`,'INVALID_ARGS');
      });
      const concludesAcceptedTask = this.concludesAcceptedTask;
      const prepareToolArguments = this.prepareToolArguments;
      const forwardedCalls = new Set();
      if (this.protectedContext) ctx.on('tools/result', (exec, result) => {
        const forwarded = forwardedCalls.delete(exec.callId);
        if (!forwarded && exec.name === 'agent_teams_update_task' && result.isError)
          this.trace?.localToolFailure(exec, result);
      });
      const claimReport=(agent,value)=>this.protectedContext&&this.assignmentReports
        ? projectClaimReport(value,JSON.parse(this.protectedContext(agent)),this.assignmentReports(agent)):value;
      const sourceCheck = name => {
        if(name==='skill' && skillSourceCheck && !skillSourceCheck())return false;
        const source = this.coordinatorDefinitions.get(name);
        return !source || source.binding.matches(coordinator.tools.get(name));
      };
      const effectContracts = this.effectContracts, effectForwards = this.effectForwards;
      for (const [name, { definition }] of this.coordinatorDefinitions) {
        const schema = { name };
        const structuredHandoff = this.protectedContext && schema.name === 'agent_teams_update_task';
        const contextForHandoff = this.protectedContext;
        ctx.tools.register({ ...(structuredHandoff ? employeeHandoffDefinition(definition) : definition), async execute(args, exec) {
          if (coordinator.agents.get(exec.agent?.id) !== exec.agent) throw Error('EMPLOYEE_NOT_LIVE');
          if (!sourceCheck(name)) throw new HarnessError('已批准的工具定义已变化，请重新核对运行版本', 'TOOL_DEFINITION_CHANGED');
          const normalized = !runtimeEffects && structuredHandoff && Object.hasOwn(args,'report')
            ? nativeHandoffArguments(args, JSON.parse(contextForHandoff(exec.agent) || '{}').task) : args;
          const forwarded=runtimeEffects?runtimeEffects.effectiveArguments(exec):prepareToolArguments?.(exec.agent,schema.name,normalized)??normalized;
          if (structuredHandoff) forwardedCalls.add(exec.callId);
          const permit=effectContracts?{agent:exec.agent,name,callId:exec.callId,argumentsSha256:effectDigest(forwarded),closed:false,bodyEntered:false}:undefined;
          if (permit) effectForwards.set(exec.callId, permit);
          let result;
          try { result = await coordinator.tools.execute({ callId: exec.callId, name: schema.name, arguments: forwarded, agent: exec.agent, signal: exec.signal }); }
          finally { if(permit)permit.closed=true;effectForwards.delete(exec.callId); }
          if (result.isError) throw new HarnessError(result.error.message, result.error.info?.code ?? 'COORDINATOR_TOOL_FAILED');
          for (const context of result.additionalContexts ?? []) exec.deferContext(context);
          // The committed handoff already contains the employee's report and
          // evidence. End at the official tool boundary without another model
          // request merely to restate that success.
          if (result.concludesTurn || concludesAcceptedTask?.(exec)) exec.concludeTurn();
          return schema.name==='agent_teams_claim_task'?claimReport(exec.agent,result.value):result.value;
        } });
      }
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const local = await next(), shared = await coordinator.systemPrompt.assemble(context);
        return { ...local, sections: mergeNamed(shared.sections, local.sections), contexts: mergeNamed(shared.contexts, local.contexts), variables: { ...shared.variables, ...local.variables } };
      });
      ctx.on('session/created', session => this.trace?.sessionCreated(session));
      ctx.on('session/event', (session, event) => this.trace?.sessionRecord(session, event));
      ctx.on('agent/created', ({ agent }) => coordinator.agents.announce(agent));
      for (const name of ['agent/session-start', 'agent/status']) {
        ctx.on(name, ({ agent, ...payload }) => emitAgentEvent(coordinator, agent, name, payload));
      }
      const setupBody = async (agentCtx, agent) => {
        const prepared = await options.setup?.(agentCtx, agent);
        checkAdmission();
        if(this.handoffClosure)agentCtx.on('agent/pre-step',async(event,next)=>{
          const decision=await next();
          if(decision.kind!=='enter'||event.signal.aborted)return decision;
          const work=this.handoffClosure(event.agent);if(!work)return decision;
          const key=JSON.stringify([event.agent.id,work.taskId,work.attemptId]);
          if(this.closureNotices.has(key))return decision;
          this.closureNotices.add(key);this.completionReminders.add(key);
          this.archive?.append('handoff/closure-started',{...work,reason:'last-authorized-call'},{sessionId:event.agent.id,taskId:work.taskId,attemptId:work.attemptId});
          const notice=createUserMessage({content:[{type:'text',text:
            `这是当前任务或项目最后一次已授权调用，仅用于正式交接。不要认领、检索、读取、写文件或再调用其他工具。根据已经核对的真实证据调用 agent_teams_update_task：task_id=${work.runtimeTaskId}、attempt_id=${work.attemptId}。${work.taskStatus==='claimed'?'当前仍为claimed，未进入in_progress，不能直接提交完成；请status=failed报告无法完成本次验收。':''}验收全部满足才status=completed；证据不足则status=failed，output如实报告缺项，按合同填写verdict、findings及必需字段。不编造成功，不改变额度或权限；文字回复不能完成任务，本轮未交接即停止。`}],
            source:{kind:'plugin',plugin:'weiwu-handoff',form:'notice',summary:'最后一次调用仅用于正式交接'}});
          return {...decision,messages:[...decision.messages,notice]};
        });
        if (this.pendingCompletion) agentCtx.on('agent/turn-stopping', event => {
          event.signal.throwIfAborted();
          const work = this.pendingCompletion(event.agent);
          if (!work) return;
          const key = JSON.stringify([event.agent.id, work.taskId, work.attemptId]);
          const ref = { sessionId: event.agent.id, taskId: work.taskId, attemptId: work.attemptId };
          if (this.completionReminders.has(key)) {
            const error = Object.assign(Error('HANDOFF_NOT_SUBMITTED: 员工回复已结束，但当前任务仍缺少正式交接'), { code: 'HANDOFF_NOT_SUBMITTED' });
            this.archive?.append('handoff/missing', { ...work, code: error.code, message: error.message }, ref);
            this.onIncompleteCompletion?.(error);
            throw error;
          }
          this.completionReminders.add(key);
          this.archive?.append('handoff/reminder', { ...work }, ref);
          event.agent.inject(createUserMessage({ content: [{ type: 'text', text:
            `宿主尚未收到当前任务的正式交接，普通文字不能完成节点。不要重新认领或重复读取已有证据；继续核对仍缺的验收，然后调用 agent_teams_update_task，task_id=${work.runtimeTaskId}、attempt_id=${work.attemptId}，有经理交接合同时用report对象提交真实结果；旧任务仍可用output文本。全部满足才提交status=completed；未满足则status=failed，按合同提交verdict与findings。不能编造通过、改目标或增加权限。此纠正仍计入原预算和调用次数；再次不交接将停止项目。` }],
            source: { kind: 'plugin', plugin: 'weiwu-handoff', form: 'notice', summary: '当前任务缺少正式交接；一次纠正机会' } }));
        });
        if (this.protectedContext) agentCtx.on('agent/pre-step', async (event, next) => {
          // Assembly precedes native membership admission. Refresh only the
          // admitted snapshot, before the loop durably appends these messages.
          const decision = await next();
          if (decision.kind !== 'enter' || event.signal.aborted) return decision;
          // A native completion may schedule this member before its host seal
          // commits. Fence the late refresh, not merely the later model fetch.
          await this.waitForProtectedContext?.(event.agent, event.signal);
          event.signal.throwIfAborted();
          const index = decision.messages.findLastIndex(message => message.source?.kind === 'plugin' &&
            message.source.plugin === '@deepseek-ai/dsh-system-prompt' && message.source.form === 'snapshot' &&
            message.source.sections?.some(section => section.name === 'department:approved-context'));
          if (index < 0) return decision;
          const message = decision.messages[index], text = this.protectedContext(event.agent);
          const sections = message.source.sections.map(section => section.name === 'department:approved-context' ? { ...section, text } : section);
          const messages = [...decision.messages];
          messages[index] = { ...message, source: { ...message.source, sections }, content: [{ type: 'text', text: joinContextSections(sections) }] };
          return { ...decision, messages:this.assignmentReports?projectAssignmentReports(messages,JSON.parse(text),this.assignmentReports(event.agent)):messages };
        }, { prepend: true });
        const employee = this.identify?.(agent);
        if (employee) {
          if(this.beforeTool)ctx.on('tools/pre-execute',async(exec,next)=>{
            await this.beforeTool(exec.signal);exec.signal?.throwIfAborted();return next();
          });
          skillSourceCheck=await installApprovedSkills(ctx, mount, { manifest: this.skillManifest, employee, agent, archive: this.archive, queryKnowledge:this.queryKnowledge,beforeKnowledge:this.beforeKnowledge, fixedRegistry:Boolean(this.effectAuthority?.runtimeOperations) });
          // Child setup installs the durable descriptor first. Restrict only
          // this known employee's domain schemas before publication/assembly;
          // the coordinator's execution permission checks remain authoritative.
          if (!Array.isArray(employee.tools)) throw new HarnessError('无法核对员工已批准的工具权限', 'TOOL_PERMISSION_IDENTITY');
          let access;
          installEmployeeCapabilities(ctx,{employee,agent,manifest:this.skillManifest,queryKnowledge:this.queryKnowledge,beforeKnowledge:this.beforeKnowledge,archive:this.archive,activeWork:this.activeWork,toolCatalog:()=>access.catalog()});
          access = installEmployeeToolAccess(ctx, agentCtx, { agent, employee, boundary, sourceCheck, effectContracts: this.effectContracts,
            contractBinding: name => this.coordinatorDefinitions.get(name)?.binding });
          if(this.effectContracts && this.effectAuthority.runtimeOperations)runtimeEffects=installToolEffectRuntime(ctx,{
            operations:this.effectAuthority.runtimeOperations,contracts:this.effectContracts,access,boundary,employee,activeWork:this.activeWork,
            prepareArguments:exec=>{
              if(!this.coordinatorDefinitions.has(exec.name))return exec.arguments;
              const args=this.protectedContext&&exec.name==='agent_teams_update_task'&&Object.hasOwn(exec.arguments,'report')
                ?nativeHandoffArguments(exec.arguments,JSON.parse(this.protectedContext(exec.agent)||'{}').task):exec.arguments;
              return prepareToolArguments?.(exec.agent,exec.name,args)??args;
            },
          });
          else if (this.effectContracts) ctx.on('tools/execute', async (exec, next) => {
            const contract = this.effectContracts.get(exec.name), originalSignal = exec.signal;
            if (!contract || access.check(exec) !== undefined) throw Error('TOOL_EFFECT_UNREVIEWED');
            try {
              return await this.effectAuthority.withAdmission(contract, async signal => {
                exec.signal = signal; signal.throwIfAborted();
                const denied = access.check(exec); if (denied) throw Error(denied);
                return next();
              }, originalSignal);
            } finally { exec.signal = originalSignal; }
          });
          this.archive?.append('runtime/tool-schema-filtered', { hostId, sessionId: agent.id, agentId: employee.id, granted: access.granted, removed: access.removed, resumed: resume }, { sessionId: agent.id });
        }
        return { commit: () => {
          checkAdmission(); prepared?.commit();
          detachAgent = coordinator.agents.enter(agent, options.parentAgent);
        } };
      };
      const setup = (...args) => {
        const work = setupBody(...args); setups.add(work);
        work.then(() => setups.delete(work), () => setups.delete(work));
        return work;
      };
      nativeStarted = true;
      handle = await ctx.agents[resume ? 'resume' : 'create']({ ...options, signal, setup });
      slot.agent = handle.agent;
      const employee = this.identify?.(handle.agent);
      slot.agentId = employee?.id;
      slot.employeeId = employee?.employeeId;
      this.archive?.append('runtime/created', { hostId, sessionId, agentId: employee?.id, employeeId: employee?.employeeId, resumed: resume, parentSessionId: options.parentAgent?.id, model: handle.agent.options.model }, { sessionId });
      checkAdmission();
      return { agent: handle.agent, dispose };
    } catch (error) {
      ready.resolve();
      await dispose().catch(() => undefined);
      throw error;
    } finally {
      ready.resolve(); this.pending.delete(ready.promise);
    }
  }

  list() { return [...this.live.values()]; }
  checkForwardBody(exec) {
    const permit=this.effectExecutions.get(exec);
    if(!permit||permit.closed||permit.bodyEntered||permit.agent!==exec.agent||permit.name!==exec.name||permit.callId!==exec.callId||permit.argumentsSha256!==effectDigest(exec.arguments))return 'TOOL_EFFECT_FORWARD_REQUIRED';
    permit.bodyEntered=true;
  }
  stopAdmission() {
    this.closed = true;
    for (const slot of this.live.values()) slot.stopAdmission();
  }

  close() {
    this.stopAdmission();
    if (!this.closing) {
      this.closing = (async () => {
        const results = await Promise.allSettled([...this.live.values()].map(slot => slot.close()));
        await Promise.all([...this.pending]);
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) {
          const error = new AggregateError(failures, 'Employee hosts teardown failed');
          if (failures.some(failure => failure.code === 'RUNTIME_WRITER_DRAIN_UNPROVEN')) error.code = 'RUNTIME_WRITER_DRAIN_UNPROVEN';
          throw error;
        }
        this.removeEffectGuard?.();
      })();
      this.closing.catch(() => {});
    }
    return this.closing;
  }
}
