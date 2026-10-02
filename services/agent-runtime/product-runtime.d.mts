import type { RunDetail } from './trace-store.mjs';
import type { RelayRoute, RuntimeUsage } from './openai-compatible.mjs';
export type RuntimeCompletion = { status: 'completed' | 'failed' | 'cancelled'; usages: RuntimeUsage[]; summary?: string; message?: string };
export class ProductDshRuntime {
  constructor(input: { traceRoot: string; externalTool?:(input:{runId:string;agentId:string;name:string;args:unknown;signal?:AbortSignal})=>Promise<unknown>; createExecutor?:(archive:any,snapshot:any)=>any; beforeRequest?:(runId:string,data:any)=>Promise<void>;onCallError?:(data:any)=>Promise<void>; queryKnowledge?: (snapshot: any, agentId: string, operation: 'search' | 'read', value: string) => Promise<any>; onUsage?: (runId: string, usage: RuntimeUsage) => Promise<void>; requestApproval?: (input: any, signal?: AbortSignal) => Promise<any> });
  inspect(): Promise<{ ready: boolean; reason: string }>;
  start(input: { runId: string; approvedSnapshot: any; routes: RelayRoute[] }): Promise<{ runtimeRunId: string; completion: Promise<RuntimeCompletion> }>;
  cancel(runtimeRunId: string): Promise<boolean>;
  read(id: string): RunDetail | null;
}
