import type {TaskWorkspace,TaskWorkspaceOrigin,TaskWorkspaceFile} from './task-workspace.ts';
export type TaskAttemptKey={runId:string;taskId:string;attemptId:string;generation:number};
export type TrustedTaskCandidate=Omit<TrustedTaskAssignment,'generation'>;
export type TrustedTaskAssignment=TaskAttemptKey&{agentId:string;sessionId:string;runtimeTaskId:string;contractHash:string};
export type TaskExecutionReceipt={profile:'task-attempt-openshell-v1';key:TaskAttemptKey;scopeHash:string;operationId:string;beforeWorkRevision:string;afterWorkRevision:string};
export type TaskInputOrigin={path:string;sha256:string;origin:TaskWorkspaceOrigin;source:
 {kind:'import';snapshotId:string;sha256:string;agentIds:string[]}|{kind:'accepted';runId:string;taskId:string;attemptId:string;revision:string}};
/** Private API state: workspace contains metadata of files outside this task. Never send to the device. */
export type TaskExecutionScope={profile:'task-attempt-openshell-v1';key:TaskAttemptKey;workspace:TaskWorkspace;workRevision:string;capabilityHash:string;inputOrigins:TaskInputOrigin[]};
/** Only a durable canonical commit writer may add these records. Input ancestry stays in input_origins. */
export type TaskCommittedOutput={scope:TaskExecutionScope;receipt:TaskExecutionReceipt;files:{path:string;sha256:string}[]};
export type TaskCanonical={files:TaskWorkspaceFile[];revision:string};
