export type RecoveredReceipt = {taskId:string;attemptId:string;sourceRunId:string;acceptanceSeq:number;receipt:any};
export type RecoveredTest = {taskId:string;attemptId:string;sourceRunId:string;operationId:string;command:string;exitCode:number;
 output:string;outputSha256:string;workspaceRevision:string;observationSeq:number;acceptanceSeq:number;nodeTests?:any};
export type RunLineageEvidence = {version:1;runId:string;projectId:string;planVersion:number;sourceRunId:string|null;status:'none'|'verified'|'partial'|'unavailable';
 receipts:RecoveredReceipt[];tests:RecoveredTest[];issues:{taskId?:string;code:string;message:string}[]};

// Host seal fields only. Budget notes, model prose and mutable UI summaries do
// not participate in proof of a completed task or an observed command.
export function handoffSealValue(record:any) {
 return Object.fromEntries(['runId','taskId','attemptId','workspaceRevision','inputs','outputs','commands','acceptedAt']
  .filter(key=>record?.[key]!==undefined).map(key=>[key,record[key]]));
}
export function canonicalEvidence(value:any):string {
 return JSON.stringify(value,(_key,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)
  ?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry);
}
export function sameHandoffSeal(left:any,right:any):boolean {
 return canonicalEvidence(handoffSealValue(left))===canonicalEvidence(handoffSealValue(right));
}
export function verifiedRecoveredReceipt(evidence:RunLineageEvidence|undefined,runId:string,snapshot:any,taskId:string,attemptId:string):RecoveredReceipt|undefined {
 if(!evidence||evidence.version!==1||!['verified','partial'].includes(evidence.status)||evidence.runId!==runId||
  evidence.projectId!==snapshot.projectId||evidence.planVersion!==snapshot.planVersion||evidence.sourceRunId!==snapshot.recovery?.sourceRunId)return;
 const completed=snapshot.recovery?.completed?.filter((entry:any)=>entry.taskId===taskId&&(entry.attemptId??entry.attempt_id)===attemptId)??[];
 const sealed=snapshot.handoffCheckpoints?.filter((entry:any)=>entry.taskId===taskId&&entry.attemptId===attemptId)??[];
 const verified=evidence.receipts?.filter(entry=>entry.taskId===taskId&&entry.attemptId===attemptId)??[];
 if(completed.length!==1||sealed.length!==1||verified.length!==1)return;
 const entry=verified[0];
 if(entry.sourceRunId===sealed[0].runId&&entry.sourceRunId===entry.receipt?.runId&&Number.isSafeInteger(entry.acceptanceSeq)&&entry.acceptanceSeq>0&&sameHandoffSeal(entry.receipt,sealed[0]))return entry;
}
