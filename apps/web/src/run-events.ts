import type { TraceEvent } from '../../../services/agent-runtime/trace-store.mjs';

// Polling and explicit pagination can return an overlapping page. Sequence
// numbers are archive identities, so an event must appear only once.
export function mergeRunEvents(current: TraceEvent[], incoming: TraceEvent[]): TraceEvent[] {
  return [...new Map([...current, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
}
