import type { CompletionProtocol } from './completion-protocol.mjs';
export type RelayRoute = { id: string; name: string; wireModel: string; baseUrl: string; apiKey: string; inputRate: number; outputRate: number; maxOutputTokens: number; contextBytes?: number; contextWindowTokens?: number; protocol?: CompletionProtocol; thinkingMode?: 'disabled' };
export type RuntimeUsage = { id: string; modelId: string; inputTokens: number; outputTokens: number; cost: number; sessionId?: string; agentId?: string; employeeId?: string; taskId?: string; runtimeTaskId?: string; reworkRound?: number; attemptId?: string; requestId?: string; durationMs?: number; requestPurpose?: 'compaction'|'execution' };
export type RuntimeResponseMetadata = { id: string; providerStatus: number; providerRequestId?: string; upstreamRequestId?: string; responseRequestId?: string };
export type RuntimeCallError = { id: string; dispatched: boolean; code: string; providerStatus?: number; providerRequestId?: string; upstreamRequestId?: string; responseRequestId?: string };
export type PreparedRelayRequest = {
  path:'/chat/completions'|'/responses';protocol:CompletionProtocol;headers:Record<string,string>;
  body: Record<string,any> & {model:string;stream:false};
  reservation:number;maxTokens:number;fallback:boolean;attribution:Record<string,unknown>;
  fitted:{messages:any[];removed:number;beforeBytes:number;afterBytes:number;inputUpperBound:number;reservation:number;maxMessageBytes:number;availableBudget:number;
    deduplicatedGroups:number;deduplicatedBytes:number;evidenceDuplicates:{from:number[];to:number[];scopeId:string;canonicalSha256:string}[]};
};
export class OpenAiCompatibleAdapter {
  /** Pure request preview, never an admission ticket; stream rechecks synchronously. */
  prepareRequest(options:any):PreparedRelayRequest;
  stopAdmission(error?: unknown): void;
  readonly pendingRequests: number;
  drain(timeoutMs?: number, signal?: AbortSignal): Promise<{pendingRequests:number;finishedRequests:number;timedOut:boolean;aborted:boolean}>;
  constructor(input: { routes: RelayRoute[]; maxBudget: number; priorSpend?: number; priorModelCalls?: number; maxModelCalls?: number; maxTaskModelCalls?: number;
    tasks?: {id:string;assigneeId?:string;maxBudget?:number;maxModelCalls?:number;maxOutputTokens?:number}[]; taskUsage?:Record<string,{cost:number;calls:number;reserved?:number}>;
    contextBytes?:number;signal?:AbortSignal;onUsage?: (usage: RuntimeUsage) => void | Promise<void>; onError?: (error: unknown) => void;
    beforeRequest?:(event:any,signal?:AbortSignal)=>Promise<void>;onResponse?:(event:RuntimeResponseMetadata)=>void|Promise<void>;onCallError?:(event:RuntimeCallError)=>void|Promise<void>;onBudget?:(event:any)=>void;onRequest?:(event:any)=>void;onContext?:(event:any)=>void;onFallback?:(event:any)=>void });
}
