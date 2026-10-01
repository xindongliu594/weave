import { Context } from '@deepseek-ai/cordis';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { LlmAdapter, HarnessError } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';

const mergeNamed = (shared, local) => [...new Map([...shared, ...local].map(item => [item.name, item])).values()];

/** Public AgentFactory seam: coordination owns identities; each Agent owns a Host. */
export class EmployeeHostFactory {
  constructor({ coordinator, loadPlugin, provider, sessionRoot, trace, archive, identify }) {
    Object.assign(this, { coordinator, loadPlugin, provider, sessionRoot, trace, archive, identify });
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
      const mod = await this.loadPlugin(name);
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
      await mount('@deepseek-ai/dsh-session-query');
      await mount('@deepseek-ai/dsh-agent-loop', { agents: [] });
      for (const schema of coordinator.tools.schemas()) {
        const definition = coordinator.tools.get(schema.name);
        ctx.tools.register({ ...definition, async execute(args, exec) {
          if (coordinator.agents.get(exec.agent?.id) !== exec.agent) throw Error('EMPLOYEE_NOT_LIVE');
          const result = await coordinator.tools.execute({ callId: exec.callId, name: schema.name, arguments: args, agent: exec.agent, signal: exec.signal });
          if (result.isError) throw new HarnessError(result.error.message, result.error.info?.code ?? 'COORDINATOR_TOOL_FAILED');
          for (const context of result.additionalContexts ?? []) exec.deferContext(context);
          if (result.concludesTurn) exec.concludeTurn();
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
