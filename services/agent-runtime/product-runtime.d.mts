import type { RunDetail } from './trace-store.mjs';
import type { RelayRoute, RuntimeUsage } from './openai-compatible.mjs';
export type RuntimeCompletion = { status: 'completed' | 'failed' | 'cancelled'; usages: RuntimeUsage[]; summary?: string; message?: string };
export class ProductDshRuntime {
  constructor(input: { traceRoot: string; onUsage?: (runId: string, usage: RuntimeUsage) => Promise<void>; requestApproval?: (input: any, signal?: AbortSignal) => Promise<void> });
  inspect(): Promise<{ ready: boolean; reason: string }>;
  start(input: { runId: string; approvedSnapshot: any; routes: RelayRoute[] }): Promise<{ runtimeRunId: string; completion: Promise<RuntimeCompletion> }>;
  cancel(runtimeRunId: string): Promise<boolean>;
  read(id: string): RunDetail | null;
}
