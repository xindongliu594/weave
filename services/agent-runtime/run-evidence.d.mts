export type NodeTestCounts = {status:'unknown';reason:string}|{status:'available';format:'tap'|'spec';tests:number;suites:number;pass:number;fail:number;cancelled:number;skipped:number;todo:number};
export function nodeTestCounts(command:unknown,output:unknown,complete?:boolean):NodeTestCounts;
export function commandEvidence(options:{archive?:{id?:string;dir?:string};name:string;taskId:string;attemptId:string;args:any;result:any;context?:{sessionId?:string;callId?:string;approvalId?:string}}):{
 version:1;runId:string|null;observedAt:string;tool:string;sessionId:string|null;callId:string|null;verificationProfile?:any;
 approval:any;operation:{status:'unknown';reason:string}|{status:'available';operationId:string;queuedSeq:number;finishedSeq:number};
 hashBasis:string;output:any;stdout:any;stderr:any;nodeTests:NodeTestCounts;
};
export function taskRunEvidence(options:any):any;
export function sourceBudgetEvidence(snapshot:any,events:any[],runId:string):any;
