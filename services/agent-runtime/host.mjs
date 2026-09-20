import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as teams from '@nanmicoder/dsh-agent-teams';
import { attachTrace } from './trace.mjs';

// Resolve base-owned providers through the installed bundle, including nested npm dependencies.
const require = createRequire(import.meta.url);
const baseRequire = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));

/** Integration host, not yet the product execution adapter. Only team tools are mounted. */
export async function createTeamHost({ adapter, provider, sessionRoot, archive, maxMembers = 6 }) {
  if (!sessionRoot || !isAbsolute(sessionRoot)) throw new Error('An absolute, dedicated sessionRoot is required');
  const ctx = new Context();
  const fibers = [];
  const handles = [];
  let closing;
  let trace;
  async function mount(name, config) {
    const mod = await import(pathToFileURL(baseRequire.resolve(name)).href);
    const fiber = ctx.plugin(mod.default ?? mod, config);
    fibers.push(fiber);
    await fiber.await();
  }
  function close() {
    return closing ??= (async () => {
      const failures = [];
      for (const item of [...handles].reverse().concat([...fibers].reverse())) {
        try { await item.dispose(); } catch (error) { failures.push(error); }
      }
      trace?.dispose();
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
    if (archive) trace = attachTrace(ctx, archive);
    await mount('@deepseek-ai/dsh-session-persistence-jsonl', { root: sessionRoot, compression: 'none' });
    await mount('@deepseek-ai/dsh-agent-loop', { agents: [] });
    await mount('@deepseek-ai/dsh-subagent');
    await mount('@deepseek-ai/dsh-subagent-spawn-in-process', { providerName: 'spawn' });
    const fiber = ctx.plugin(teams, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers, slashCommand: false });
    fibers.push(fiber);
    await fiber.await();
    return {
      ctx,
      close,
      async captain({ cwd, model, instructions, maxTokens, id = randomUUID() }) {
        const handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions: { provider, model, ...(maxTokens ? { maxTokens } : {}) },
          setup: instructions ? agentCtx => { agentCtx.systemPrompt.section({ name: 'department:role', order: 118, text: instructions }); } : undefined });
        handles.push(handle);
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
