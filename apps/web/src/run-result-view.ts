import { runTaskView } from './run-detail-view.ts';
import {verifiedRecoveredReceipt,type RunLineageEvidence,type RecoveredReceipt} from '../../../packages/contracts/run-lineage-evidence.ts';

type Event = { type: string; seq?: number; data: any };
type Snapshot = { projectId?:string;planVersion?: number; agents?: any[]; tasks?: any[]; approvedTasks?: any[]; recovery?: any; handoffCheckpoints?: any[] };
export type RunResult = { kind: 'accepted-manager' | 'runtime'; text: string; originalSummary: string;
  taskId?: string; taskSubject?: string; acceptanceSeq?: number; receipt?: any; reason?: string;inheritedSources?:RecoveredReceipt[] };

/** The coordinator's last conversational reply can precede delivery. Display
 * the actual accepted terminal manager task without rewriting that transcript. */
export function runResultView(runId: string, status: string, integrity: string | undefined, snapshot: Snapshot,
  events: Event[], traceEvents: Event[] = [],lineage?:RunLineageEvidence): RunResult {
  const ordered = [...traceEvents, ...events].map((event, index) => ({ event, index }))
    .sort((left, right) => (left.event.seq ?? left.index) - (right.event.seq ?? right.index)).map(item => item.event);
  const finished = ordered.findLast(event => event.type === 'run/finished')?.data;
  const originalSummary = typeof finished?.summary === 'string' ? finished.summary : '';
  const fallback: RunResult = { kind: 'runtime', text: originalSummary || (typeof finished?.message === 'string' ? finished.message : ''), originalSummary };
  if (status !== 'completed' || integrity !== 'ok' || finished?.status !== 'completed') return fallback;
  const contracts = snapshot.approvedTasks ?? snapshot.tasks ?? [];
  const tasks = runTaskView(runId, snapshot, events, traceEvents);
  const unverified = { ...fallback, reason: '尚未核对全部批准节点的完整交接证据，以下保留原始运行回复。' };
  if (!contracts.length || tasks.length !== contracts.length || tasks.some(task => task.unapproved || task.status !== 'completed')) return unverified;
  const receipts = new Map<string, { receipt: any; seq?: number }>();
  const inheritedSources:RecoveredReceipt[]=[];
  const completeFile = (file: any) => typeof file?.path === 'string' && /^[a-f0-9]{64}$/i.test(file.sha256 ?? '') &&
    Number.isSafeInteger(file.size) && file.size >= 0;
  for (const task of tasks) {
    const same = (receipt: any) => receipt?.taskId === task.id && receipt.attemptId === task.attemptId &&
      (receipt.planVersion === undefined || receipt.planVersion === snapshot.planVersion);
    const accepted = ordered.findLast(event => event.type === 'handoff/accepted' && event.data.runId === runId && same(event.data));
    const recovery = snapshot.recovery;
    const inherited = !accepted ? verifiedRecoveredReceipt(lineage,runId,snapshot,task.id,task.attemptId):undefined;
    const receipt = accepted?.data ?? inherited?.receipt;
    const outputs = task.outputs ?? [], inputs = task.inputs ?? [];
    if (!receipt || !Array.isArray(outputs) || !Array.isArray(inputs) || !Array.isArray(receipt.outputs) || !Array.isArray(receipt.inputs) ||
      receipt.outputs.length !== outputs.length || receipt.inputs.length !== inputs.length ||
      new Set(receipt.outputs.map((file: any) => file.path)).size !== receipt.outputs.length ||
      new Set(receipt.inputs.map((file: any) => file.path)).size !== receipt.inputs.length ||
      !receipt.outputs.every(completeFile) || !receipt.inputs.every(completeFile) ||
      !outputs.every((file: any) => receipt.outputs.some((output: any) => output.path === file.path && (!file.sha256 || file.sha256 === output.sha256)))) return unverified;
    if (!accepted && !receipt.outputs.every((output: any) => recovery.files?.some((file: any) => file.state === 'accepted' &&
      file.producerTaskId === task.id && file.path === output.path && file.sha256 === output.sha256 && file.size === output.size))) return unverified;
    receipts.set(task.id, { receipt, seq: accepted?.seq });
    if(inherited)inheritedSources.push(inherited);
  }
  for (const task of tasks) for (const input of task.inputs ?? []) {
    const observed = receipts.get(task.id)!.receipt.inputs.find((file: any) => file.path === input.path);
    if (!observed) return unverified;
    if (input.producerTaskId) {
      const producer = receipts.get(input.producerTaskId)?.receipt.outputs.find((file: any) => file.path === input.path);
      if (!producer || observed.producerTaskId !== input.producerTaskId || producer.sha256 !== observed.sha256 || producer.size !== observed.size) return unverified;
    } else if (!/^[a-f0-9]{64}$/i.test(input.sha256 ?? '') || input.sha256 !== observed.sha256 || observed.producerTaskId) return unverified;
  }
  const managers = new Set((snapshot.agents ?? []).filter(agent => agent.role === 'manager').map(agent => agent.id));
  const dependedOn = new Set(contracts.flatMap(task => task.dependencies ?? []));
  const candidates = tasks.filter(task => managers.has(task.assignee) && !dependedOn.has(task.id));
  if (candidates.length !== 1) return fallback;
  const task = candidates[0];
  if (typeof task.output !== 'string' || !task.output.trim()) return fallback;
  const { receipt, seq } = receipts.get(task.id)!;
  return { kind: 'accepted-manager', text: task.output, originalSummary, taskId: task.id,
    taskSubject: task.subject, acceptanceSeq: seq, receipt,inheritedSources };
}
