export type NodeTestCounts = {status:'unknown';reason:string}|{status:'available';format:'tap'|'spec';tests:number;suites:number;pass:number;fail:number;cancelled:number;skipped:number;todo:number};
export function nodeTestCounts(command:unknown,output:unknown,complete?:boolean):NodeTestCounts;
export function taskRunEvidence(options:any):any;
export function sourceBudgetEvidence(snapshot:any,events:any[],runId:string):any;
