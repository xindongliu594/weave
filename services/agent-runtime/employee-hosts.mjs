import { Context } from '@deepseek-ai/cordis';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { LlmAdapter, HarnessError } from '@deepseek-ai/dsh-llm';
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt';
import { randomUUID } from 'node:crypto';
import { installEmployeeContext } from './employee-context.mjs';
import { PRODUCT_TOOL_NAMES } from './product-tools.mjs';
import { installApprovedSkills } from './approved-skills.mjs';

const mergeNamed = (shared, local) => [...new Map([...shared, ...local].map(item => [item.name, item])).values()];

/** Public AgentFactory seam: coordination owns identities; each Agent owns a Host. */
export class EmployeeHostFactory {
  constructor({ coordinator, loadPlugin, provider, sessionRoot, trace, archive, identify, context, protectedContext, waitForProtectedContext, concludesAcceptedTask, skillManifest, queryKnowledge }) {
    Object.assign(this, { coordinator, loadPlugin, provider, sessionRoot, trace, archive, identify, context, protectedContext, waitForProtectedContext, concludesAcceptedTask, skillManifest, queryKnowledge });
    this.live = new Map();
    this.pending = new Set();
    this.closed = false;
  }

  createAgent(ownerCtx, options) { return this.materialize(ownerCtx, options, false); }
  resume(ownerCtx, options) { return this.materialize(ownerCtx, options, true); }

  async materialize(ownerCtx, options, resume) {
    if (this.closed) throw Error('EMPLOYEE_HOSTS_CLOSED');
    ownerCtx.fiber.assertActive();
    const sessionId = resume ? options.resumeSessionId : options.sessionId;
    if (this.live.has(sessionId)) throw Error('EMPLOYEE_ALREADY_ACTIVE: ' + sessionId);
    const hostId = randomUUID(), ctx = new Context(), fibers = [];
    const abort = new AbortController(), ready = Promise.withResolvers();
    const slot = { hostId, sessionId, ctx, agent: undefined, close: undefined };
    let handle, detachAgent, unfollowOwner, disposing;
    const signal = AbortSignal.any([abort.signal, ...(options.signal ? [options.signal] : [])]);
    const dispose = (ownerTriggered = false) => disposing ??= (async () => {
      abort.abort(Error('Employee host disposed'));
      await ready.promise;
      const failures = [];
      try { if (handle) await this.coordinator.subagents?.drainContinuableDescendants([handle.agent]); }
      catch (error) { failures.push(error); }
      try { await handle?.dispose(); } catch (error) { failures.push(error); }
      detachAgent?.();
      for (const fiber of fibers.reverse()) {
        try { await fiber.dispose(); } catch (error) { failures.push(error); }
      }
      this.live.delete(sessionId);
      try { if (handle) this.archive?.append('runtime/disposed', { hostId, sessionId, agentId: slot.agentId, employeeId: slot.employeeId }, { sessionId }); }
      catch (error) { failures.push(error); }
      try { if (!ownerTriggered) await unfollowOwner?.(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Employee host teardown failed');
    })();
    slot.close = dispose;
    this.live.set(sessionId, slot);
    this.pending.add(ready.promise);
    unfollowOwner = ownerCtx.effect(() => () => { if (!disposing) return dispose(true); }, `employeeHost(${sessionId})`);
    const mount = async (name, config) => {
      signal.throwIfAborted();
      const mod = typeof name === 'string' ? await this.loadPlugin(name) : { default: name };
      signal.throwIfAborted();
      const fiber = ctx.plugin(mod.default ?? mod, config);
      fibers.push(fiber);
      await fiber.await(); signal.throwIfAborted();
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
      const concludesAcceptedTask = this.concludesAcceptedTask;
      for (const schema of coordinator.tools.schemas()) {
        const definition = coordinator.tools.get(schema.name);
        ctx.tools.register({ ...definition, async execute(args, exec) {
          if (coordinator.agents.get(exec.agent?.id) !== exec.agent) throw Error('EMPLOYEE_NOT_LIVE');
          const result = await coordinator.tools.execute({ callId: exec.callId, name: schema.name, arguments: args, agent: exec.agent, signal: exec.signal });
          if (result.isError) throw new HarnessError(result.error.message, result.error.info?.code ?? 'COORDINATOR_TOOL_FAILED');
          for (const context of result.additionalContexts ?? []) exec.deferContext(context);
          // The committed handoff already contains the employee's report and
          // evidence. End at the official tool boundary without another model
          // request merely to restate that success.
          if (result.concludesTurn || concludesAcceptedTask?.(exec)) exec.concludeTurn();
          return result.value;
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
      const setup = async (agentCtx, agent) => {
        const prepared = await options.setup?.(agentCtx, agent);
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
          return { ...decision, messages };
        }, { prepend: true });
        const employee = this.identify?.(agent);
        if (employee) {
          await installApprovedSkills(ctx, mount, { manifest: this.skillManifest, employee, agent, archive: this.archive, queryKnowledge:this.queryKnowledge });
          // Child setup installs the durable descriptor first. Restrict only
          // this known employee's domain schemas before publication/assembly;
          // the coordinator's execution permission checks remain authoritative.
          if (!Array.isArray(employee.tools)) throw new HarnessError('无法核对员工已批准的工具权限', 'TOOL_PERMISSION_IDENTITY');
          const known = new Set(ctx.tools.schemas().map(schema => schema.name));
          const granted = PRODUCT_TOOL_NAMES.filter(name => known.has(name) && employee.tools.includes(name));
          const denied = PRODUCT_TOOL_NAMES.filter(name => known.has(name) && !employee.tools.includes(name));
          if (denied.length) agentCtx.tools.restrict({ deny: denied });
          this.archive?.append('runtime/tool-schema-filtered', { hostId, sessionId: agent.id, agentId: employee.id, granted, removed: denied, resumed: resume }, { sessionId: agent.id });
        }
        return { commit: () => {
          signal.throwIfAborted(); prepared?.commit();
          detachAgent = coordinator.agents.enter(agent, options.parentAgent);
        } };
      };
      handle = await ctx.agents[resume ? 'resume' : 'create']({ ...options, signal, setup });
      slot.agent = handle.agent;
      const employee = this.identify?.(handle.agent);
      slot.agentId = employee?.id;
      slot.employeeId = employee?.employeeId;
      this.archive?.append('runtime/created', { hostId, sessionId, agentId: employee?.id, employeeId: employee?.employeeId, resumed: resume, parentSessionId: options.parentAgent?.id, model: handle.agent.options.model }, { sessionId });
      signal.throwIfAborted();
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
  stopAdmission() { this.closed = true; }

  async close() {
    this.stopAdmission();
    const results = await Promise.allSettled([...this.live.values()].map(slot => slot.close()));
    await Promise.all([...this.pending]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Employee hosts teardown failed');
  }
}
