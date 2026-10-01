export type RelayRoute = { id: string; name: string; wireModel: string; baseUrl: string; apiKey: string; inputRate: number; outputRate: number; maxOutputTokens: number; contextBytes?: number; contextWindowTokens?: number };
export type RuntimeUsage = { id: string; modelId: string; inputTokens: number; outputTokens: number; cost: number; sessionId?: string; agentId?: string; employeeId?: string; taskId?: string; runtimeTaskId?: string; reworkRound?: number; attemptId?: string; requestId?: string; durationMs?: number; requestPurpose?: 'compaction'|'execution' };
export class OpenAiCompatibleAdapter {
  constructor(input: { routes: RelayRoute[]; maxBudget: number; priorSpend?: number; priorModelCalls?: number; maxModelCalls?: number; maxTaskModelCalls?: number;
    tasks?: {id:string;assigneeId?:string;maxBudget?:number;maxModelCalls?:number}[]; taskUsage?:Record<string,{cost:number;calls:number}>;
    contextBytes?:number;signal?:AbortSignal;onUsage?: (usage: RuntimeUsage) => void | Promise<void>; onError?: (error: unknown) => void;
    beforeRequest?:(event:any)=>Promise<void>;onCallError?:(event:any)=>Promise<void>;onBudget?:(event:any)=>void;onRequest?:(event:any)=>void;onContext?:(event:any)=>void;onFallback?:(event:any)=>void });
}
