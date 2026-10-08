import type { RunDetail } from '../../../services/agent-runtime/trace-store.mjs';
import { mergeRunEvents } from './run-events.ts';

type RunPage = Pick<RunDetail, 'id' | 'snapshot' | 'events' | 'eventCount'> & { nextCursor: number; hasMore: boolean };

/** Detail metadata is fresh even when the GET returns only the next event page. */
export function mergeRunDetailPage<T extends RunPage>(current: T, incoming: T): T {
  if (current.id !== incoming.id || current.snapshot.planVersion !== incoming.snapshot.planVersion) return current;
  const latest = incoming.eventCount < current.eventCount ? current : incoming;
  const nextCursor = Math.max(current.nextCursor, incoming.nextCursor);
  return { ...latest, events: mergeRunEvents(current.events, incoming.events), nextCursor, hasMore: latest.eventCount > nextCursor };
}

type ViewEvent = { type: string; seq?: number; data: any };
type ViewTask = { id: string; [key: string]: any };
type ViewSnapshot = { planVersion?: number; tasks?: ViewTask[]; approvedTasks?: ViewTask[]; handoffCheckpoints?: any[]; recovery?: any };

/** Only the selected run's host mapping may attach native state to an approved contract. */
export function runTaskView(runId: string, snapshot: ViewSnapshot, events: ViewEvent[], traceEvents: ViewEvent[] = []): ViewTask[] {
  const contracts = snapshot.approvedTasks ?? snapshot.tasks ?? [];
  const approved = new Set(contracts.map(task => task.id));
  const ordered = [...traceEvents, ...events].map((event, index) => ({ event, index }))
    .sort((left, right) => (left.event.seq ?? left.index) - (right.event.seq ?? right.index)).map(item => item.event);
  const mapping = new Map<string, string>();
  for (const event of ordered) {
    const rows = event.type === 'run/task-mapping' ? event.data.tasks : event.type === 'quality/rework-created' ? event.data.bindings : undefined;
    for (const row of rows ?? []) if (typeof row.task_id === 'string' && approved.has(row.seed_id)) mapping.set(row.task_id, row.seed_id);
  }
  const nativeTasks: any[] = ordered.findLast(event => ['team/snapshot', 'team/checkpoint'].includes(event.type))?.data.tasks ?? [];
  const nativeId = (task: any) => task.id ?? task.task_id;
  const seedId = (task: any) => mapping.get(nativeId(task)) ?? task.seed_id ?? task.profileSeedId ?? nativeId(task);
  const current = new Map<string, any>((snapshot.recovery?.completed ?? []).filter((task: any) => approved.has(task.taskId))
    .map((task: any) => [task.taskId, { ...task, id: task.taskId, status: 'completed' }]));
  for (const task of nativeTasks) if (approved.has(seedId(task))) current.set(seedId(task), task);
  // Mapping order, rather than native array order, makes a new repair supersede
  // the old completed implementation. A missing fresh state cannot reuse it.
  for (const [id, seed] of mapping) current.set(seed, nativeTasks.find(task => nativeId(task) === id) ?? { id, status: 'pending' });

  const accepted = (taskId: string, task: any) => {
    const attempt = task.attemptId ?? task.attempt_id;
    if (typeof attempt !== 'string' || !attempt) return false;
    const sameAttempt = (record: any) => record?.taskId === taskId && record.attemptId === attempt
      && (record.planVersion === undefined || record.planVersion === snapshot.planVersion);
    if (events.some(event => event.type === 'handoff/accepted' && event.data.runId === runId && sameAttempt(event.data))) return true;
    const sourceRunId = snapshot.recovery?.sourceRunId;
    // Approved inherited seals may originate before the immediate parent when
    // a run has been resumed more than once. The snapshot binds their attempt.
    return typeof sourceRunId === 'string' && (snapshot.recovery?.completed ?? []).some((done: any) => done.taskId === taskId
      && (done.attemptId ?? done.attempt_id) === attempt) && (snapshot.handoffCheckpoints ?? []).some(record => typeof record.runId === 'string' && sameAttempt(record));
  };
  const result = contracts.map(contract => {
    const task = current.get(contract.id);
    const status = task?.status === 'completed' && !accepted(contract.id, task) ? 'awaiting_acceptance' : task?.status ?? 'pending';
    return { ...contract, status, output: task?.output, attemptId: task?.attemptId ?? task?.attempt_id,
      runtimeTaskId: task && nativeId(task) !== contract.id ? nativeId(task) : undefined };
  });
  // Unmapped native nodes remain visible, but cannot acquire approved status.
  return [...result, ...nativeTasks.filter(task => !approved.has(seedId(task))).map(task => ({ ...task, id: nativeId(task),
    unapproved: true, status: task.status === 'completed' ? 'awaiting_acceptance' : task.status }))];
}
