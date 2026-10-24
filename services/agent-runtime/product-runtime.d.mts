import type { RunDetail } from './trace-store.mjs';
import type { RelayRoute, RuntimeUsage } from './openai-compatible.mjs';
import type { ToolEffectAuthority } from './tool-definition-effects.mjs';
export type RuntimeKnowledgeQuery=(snapshot: any, agentId: string, operation: 'search' | 'read' | 'skill', value: string) => Promise<any>;
export type RuntimeToolBindings={effectAuthority:ToolEffectAuthority;queryKnowledge:RuntimeKnowledgeQuery};
export function approvedTeamExecutionDescription(snapshot: any): string;
export type RuntimeCompletion = { status: 'completed' | 'failed' | 'cancelled'; usages: RuntimeUsage[]; summary?: string; message?: string; recording?: 'complete' | 'incomplete'; maintenance?: { version: 1; state: 'stopped' | 'pending'; reasonCode?: string } };
export class ProductDshRuntime {
  constructor(input: { traceRoot: string; effectAuthority?: ToolEffectAuthority; runtimeBindingsForRun?:(runId:string,snapshot:unknown)=>RuntimeToolBindings|undefined|Promise<RuntimeToolBindings|undefined>; externalTool?:(input:{runId:string;agentId:string;name:string;args:unknown;signal?:AbortSignal})=>Promise<unknown>; createExecutor?:(archive:any,snapshot:any)=>any; beforeTool?:(runId:string,signal?:AbortSignal)=>Promise<void>;beforeKnowledge?:(runId:string,signal?:AbortSignal)=>Promise<void>; beforeRequest?:(runId:string,data:any,signal?:AbortSignal)=>Promise<void>;onResponse?:(data:any)=>Promise<void>;onCallError?:(data:any)=>Promise<void>; queryKnowledge?: RuntimeKnowledgeQuery; onUsage?: (runId: string, usage: RuntimeUsage) => Promise<void>; requestApproval?: (input: any, signal?: AbortSignal) => Promise<any> });
  inspect(): Promise<{ ready: boolean; reason: string }>;
  start(input: { runId: string; approvedSnapshot: any; routes: RelayRoute[]; prepareWorkspace?: () => void }): Promise<{ runtimeRunId: string; completion: Promise<RuntimeCompletion>; readonly writerDrained: Promise<void> }>;
  cancel(runtimeRunId: string): Promise<boolean>;
  read(id: string): RunDetail | null;
}
