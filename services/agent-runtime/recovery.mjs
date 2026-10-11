import { setTimeout as sleep } from 'node:timers/promises';

export const READ_ONLY_TOOLS = new Set(['filesystem', 'knowledge_read', 'knowledge_search', 'capability_search', 'recovery_read', 'agent_teams_status']);
const transient = new Set(['EAGAIN', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']);

/** Only repeat free, read-only operations. A dispatched model or mutation with
 * an unknown outcome requires reconciliation, never an automatic replay. */
export function classifyFailure(name, error, dispatched = true) {
  const code = error?.code ?? error?.name ?? 'UNKNOWN';
  if (READ_ONLY_TOOLS.has(name) && transient.has(code)) return 'retryable_read';
  if (/DENIED|PERMISSION|SCOPE|UNDECLARED|BUDGET|LIMIT|CONFLICT|STALE|ACCEPTANCE|UNVERIFIED/.test(code + ':' + (error?.message ?? ''))) return 'blocked';
  if (dispatched && !READ_ONLY_TOOLS.has(name)) return 'outcome_unknown';
  return 'failed';
}

export async function retryRead(name, operation, { signal, maxRetries = 2, onRetry, wait = sleep } = {}) {
  for (let retry = 0; ; retry++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (signal?.aborted || retry >= maxRetries || classifyFailure(name, error) !== 'retryable_read') throw error;
      onRetry?.({ name, retry: retry + 1, maxRetries, code: error.code });
      await wait(100 * 2 ** retry, undefined, { signal });
    }
  }
}

/** Derived from durable tool starts/results, rather than model declarations. */
export function unresolvedOperations(events) {
  const pending = new Map();
  const supervised = events.some(event => event.type === 'runtime/supervision');
  for (const event of events) {
    if ((!supervised && event.type === 'tool/start' || event.type === 'runtime/operation-start') && event.callId && !READ_ONLY_TOOLS.has(event.data.name) &&
        !event.data.name.startsWith('agent_teams_')) pending.set(event.callId, { callId: event.callId, sessionId: event.sessionId, name: event.data.name, arguments: event.data.arguments });
    if ((!supervised && event.type === 'tool/result' || event.type === 'runtime/operation-finished') && event.callId) pending.delete(event.callId);
    if (event.type === 'runtime/outcome-unknown') pending.set(event.data.callId, event.data);
  }
  return [...pending.values()];
}
