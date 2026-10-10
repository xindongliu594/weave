import { randomUUID, createHash } from 'node:crypto';
import { redact } from './trace-store.mjs';

/** Observe the actual runtime. Session records are deduplicated on durable source identity. */
export function attachTrace(ctx, archive,taskFor,internalStatusPoll=()=>false) {
  const disposers = [];
  const links = new Map();
  const requests = new Map();
  const statusResults = new Map();
  let failure;
  const write = (type, data, ref) => {
    try { return archive.append(type, data, ref); }
    catch (error) { failure ??= error; throw error; }
  };
  const check = () => { if (failure) throw new Error('Trace persistence failed', { cause: failure }); };
  const sessionRecord = (session, event) => write(`session/${event.type}`, event.data, {
    sessionId: session.id, ...links.get(session.id),
    sourceKey: `session:${session.id}:${session.header.version}:${event.seq}`, sourceSeq: event.seq, sourceTime: event.time,
  });
  const sessionCreated = session => {
    write('session/created', session.header, { sessionId: session.id });
    for (const event of session.snapshotEvents()) sessionRecord(session, event);
  };
  disposers.push(ctx.on('session/created', sessionCreated));
  disposers.push(ctx.on('session/event', sessionRecord));
  disposers.push(ctx.on('agent/created', ({ agent }) => write('agent/created', { model: agent.options.model, provider: agent.options.provider }, { sessionId: agent.id })));
  disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
    check();
    const data = exec.arguments;
    const link = { sessionId: exec.agent?.id, callId: exec.callId, taskId: data?.task_id, attemptId: data?.attempt_id };
    if (data?.task_id && exec.agent) links.set(exec.agent.id, { taskId: data.task_id, attemptId: data.attempt_id });
    write('tool/start', { name: exec.name, arguments: data }, link);
    return next();
  }));
  disposers.push(ctx.on('tools/result', (exec, result) => {
    const ref = { sessionId: exec.agent?.id, callId: exec.callId, ...links.get(exec.agent?.id) };
    if (exec.name === 'agent_teams_claim_task' && !result.isError) {
      const value = result.value;
      links.set(exec.agent.id, { taskId: value.task_id ?? exec.arguments.task_id, attemptId: value.attempt_id });
      Object.assign(ref, links.get(exec.agent.id));
    }
    // Only host-owned readonly polling is compacted. Model-issued tools,
    // errors and every changed state keep their complete original result.
    if (exec.name === 'agent_teams_status' && internalStatusPoll(exec) && result.isError === false) {
      const json = JSON.stringify(redact(result)), previous = statusResults.get(exec.agent?.id);
      if (previous?.json === json) {
        write('runtime/status-poll', { name: exec.name, unchanged: true, resultSequence: previous.seq, resultSha256: previous.sha256 }, ref);
      } else {
        const event = write('tool/result', { name: exec.name, result }, ref);
        statusResults.set(exec.agent?.id, { json, seq: event.seq, sha256: createHash('sha256').update(json).digest('hex') });
        write('team/snapshot', result.value, { sessionId: exec.agent?.id });
      }
    } else write('tool/result', { name: exec.name, result }, ref);
    if (exec.name.startsWith('agent_teams_') && exec.name !== 'agent_teams_status') {
      write('team/operation', { name: exec.name, arguments: exec.arguments, result }, ref);
    }
  }));
  disposers.push(ctx.on('llm/stream', async function* (options, next) {
    check();
    const assignment = options.messages.filter(m => m.role === 'user').flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).reverse().find(text => text.includes('AgentTeams automatic task assignment')) ?? '';
    const taskId = /Task: (t\d+)/.exec(assignment)?.[1];
    const attemptId = /Attempt id: ([a-f0-9-]+)/.exec(assignment)?.[1];
    if(taskFor)links.set(options.sessionId,taskFor(options.sessionId)??{});
    else if (taskId && attemptId) links.set(options.sessionId, { taskId, attemptId });
    const requestId = randomUUID();
    const ref = { sessionId: options.sessionId, requestId, ...links.get(options.sessionId) };
    requests.set(options.sessionId,ref);
    const started = Date.now();
    write('model/request', { provider: options.provider, model: options.model, purpose: options.purpose ?? 'execution', messages: options.messages, system: options.system, tools: options.tools, reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens }, ref);
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') write('model/usage', chunk.usage, ref);
        if (chunk.type === 'finish') write('model/finish', { reason: chunk.reason, durationMs: Date.now() - started }, ref);
        yield chunk;
      }
    } catch (error) {
      write('model/error', { message: String(error.message ?? error), durationMs: Date.now() - started }, ref);
      throw error;
    } finally { if(requests.get(options.sessionId)===ref)requests.delete(options.sessionId); }
  }));
  return { check, sessionCreated, sessionRecord, request(sessionId) { return requests.get(sessionId); }, dispose() { for (const dispose of disposers.reverse()) dispose(); } };
}
