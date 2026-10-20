import {z} from 'zod';

const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const text=z.string().min(1).max(240).refine(value=>value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value));
export const taskStopKeySchema=z.strictObject({runId:uuid,taskId:text,attemptId:text,generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)});
export const taskStopReconcileInputSchema=z.strictObject({key:taskStopKeySchema,sandboxId:uuid,workspaceRevision:sha,stopId:uuid});
const reasonCode=z.enum(['TASK_STOP_UNVERIFIED','TASK_STOP_ARCHIVE_UNAVAILABLE','TASK_STOP_SCOPE_MISSING','TASK_STOP_IDENTITY_INVALID','TASK_STOP_MARKER_INVALID','TASK_STOP_EVIDENCE_INVALID','TASK_STOP_SCOPE_RETIRED','TASK_STOP_NO_INTENT','TASK_STOP_PREPARED','TASK_STOP_DISPATCHING','TASK_STOP_UNKNOWN','TASK_STOP_LIMIT','TASK_STOP_AMBIGUOUS']);
const verified=z.strictObject({key:taskStopKeySchema,sandboxId:uuid,workspaceRevision:sha,state:z.enum(['stopped','prepared','dispatching','unknown','no-intent']),stopId:uuid.optional(),reasonCode:reasonCode.optional(),canReconcile:z.boolean()}).superRefine((value,ctx)=>{
 if(value.state==='no-intent'?(value.stopId!==undefined||value.canReconcile):value.stopId===undefined||value.canReconcile!==(value.state!=='stopped'))ctx.addIssue({code:'custom',message:'维护状态与原停止身份不符'});
});
const unverified=z.strictObject({state:z.literal('unverified'),displayKey:sha,reasonCode,canReconcile:z.literal(false),key:taskStopKeySchema.optional(),sandboxId:uuid.optional(),workspaceRevision:sha.optional()});
const aggregate=z.strictObject({state:z.literal('unverified'),displayKey:sha,reasonCode,unresolvedCount:z.number().int().positive().max(128),canReconcile:z.literal(false)});
export const taskStopMaintenanceSchema=z.strictObject({version:z.literal(1),state:z.enum(['not-applicable','stopped','pending']),scopes:z.array(z.union([verified,unverified,aggregate])).max(128)}).superRefine((value,ctx)=>{
 const keys=value.scopes.map(scope=>scope.state==='unverified'?scope.displayKey:JSON.stringify([scope.key.runId,scope.key.taskId,scope.key.attemptId,scope.key.generation]));
 const identities=value.scopes.flatMap(scope=>'key' in scope&&scope.key?[JSON.stringify([scope.key.runId,scope.key.taskId,scope.key.attemptId,scope.key.generation])]:[]);
 if(new Set(keys).size!==keys.length||new Set(identities).size!==identities.length||value.state==='not-applicable'&&value.scopes.length!==0||value.state==='stopped'&&(!value.scopes.length||value.scopes.some(scope=>scope.state!=='stopped'))||value.state==='pending'&&(!value.scopes.length||value.scopes.every(scope=>scope.state==='stopped')))ctx.addIssue({code:'custom',message:'维护汇总与准确任务状态不符'});
});
export type TaskStopMaintenanceV1=z.infer<typeof taskStopMaintenanceSchema>;
export type TaskStopMaintenanceScope=TaskStopMaintenanceV1['scopes'][number];
export type TaskStopMaintenanceReasonCode=z.infer<typeof reasonCode>;
