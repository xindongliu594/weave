export type UnknownOperation = {callId:string;sessionId?:string;name:string;arguments?:Record<string,unknown>;message?:string};
export const READ_ONLY_TOOLS:Set<string>;
export function unresolvedOperations(events:any[]):UnknownOperation[];
export function classifyFailure(name:string,error:any,dispatched?:boolean):'retryable_read'|'blocked'|'outcome_unknown'|'failed';
export function retryRead<T>(name:string,operation:()=>Promise<T>,options?:{signal?:AbortSignal;maxRetries?:number;onRetry?:(data:any)=>void;wait?:any}):Promise<T>;
