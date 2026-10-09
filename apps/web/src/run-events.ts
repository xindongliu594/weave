import type { TraceEvent } from '../../../services/agent-runtime/trace-store.mjs';

/** Routine polling is hidden only in the main view, never removed from history. */
export function isRoutineTracePoll(event: TraceEvent): boolean {
  if(event.type === 'team/snapshot') return true;
  if(event.data?.name !== 'agent_teams_status') return false;
  return event.type === 'tool/start' || event.type === 'tool/result' && event.data.result?.isError === false;
}
export function visibleRunTraceEvents(events: TraceEvent[], kind: string, employee: string, namedTypes: ReadonlySet<string>): TraceEvent[] {
  return events.filter(event => (!employee || event.sessionId === employee) && (kind === 'raw'
    || (kind === 'all' ? namedTypes.has(event.type) && event.type !== 'team/operation' && !isRoutineTracePoll(event) : event.type.startsWith(kind))));
}

// Polling and explicit pagination can return an overlapping page. Sequence
// numbers are archive identities, so an event must appear only once.
export function mergeRunEvents(current: TraceEvent[], incoming: TraceEvent[]): TraceEvent[] {
  return [...new Map([...current, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
}
