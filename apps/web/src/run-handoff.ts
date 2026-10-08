type HandoffEvent = { type: string; seq?: number; at?: string; taskId?: string; data?: { taskId?: string; message?: unknown } };
type TaskState = { id: string; status?: string };
export type HandoffNotice = { taskId: string; taskStatus?: string; message: string; at?: string; seq?: number; acceptedLater: boolean };

export function handoffNotices(events: HandoffEvent[], tasks: TaskState[]) {
  const relevant = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'handoff/blocked' || event.type === 'handoff/accepted')
    .sort((a, b) => (a.event.seq ?? a.index) - (b.event.seq ?? b.index));
  const latest = new Map<string, typeof relevant[number]>(), accepted = new Map<string, number>();
  for (let index = 0; index < relevant.length; index++) {
    const item = relevant[index], taskId = item.event.data?.taskId ?? item.event.taskId ?? '';
    latest.set(taskId, item);
    if (item.event.type === 'handoff/accepted') accepted.set(taskId, index);
  }
  const current: HandoffNotice[] = [];
  const history: HandoffNotice[] = relevant.flatMap(({ event }, index) => {
    if (event.type !== 'handoff/blocked') return [];
    const taskId = event.data?.taskId ?? event.taskId ?? '';
    const notice: HandoffNotice = { taskId, taskStatus: tasks.find(task => task.id === taskId)?.status,
      message: typeof event.data?.message === 'string' ? event.data.message : JSON.stringify(event.data ?? {}),
      at: event.at, seq: event.seq, acceptedLater: (accepted.get(taskId) ?? -1) > index };
    if (latest.get(taskId)?.event === event && ['blocked', 'failed'].includes(notice.taskStatus ?? '') && !notice.acceptedLater) current.push(notice);
    return [notice];
  });
  return { current, history };
}
