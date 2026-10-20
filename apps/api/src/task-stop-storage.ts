import {createHash} from 'node:crypto';
import {taskStopKeySchema,taskStopMaintenanceSchema,taskStopReconcileInputSchema,type TaskStopMaintenanceScope,type TaskStopMaintenanceReasonCode} from '../../../packages/contracts/task-stop-maintenance.ts';

const keyText=(key:any)=>JSON.stringify([key.runId,key.taskId,key.attemptId,key.generation]);
/** Read-view join only: no device effect or stop authority is granted here. */
export async function withTaskStopMaintenance(scopes:any[],readProjection:(runId:string)=>Promise<unknown>){
 const taskRows=scopes.filter(row=>row&&Object.hasOwn(row,'key')),counts=new Map<string,number>();
 for(const row of taskRows){const parsed=taskStopKeySchema.safeParse(row.key);if(parsed.success){const id=keyText(parsed.data);counts.set(id,(counts.get(id)??0)+1);}}
 const projections=new Map<string,Promise<ReturnType<typeof taskStopMaintenanceSchema.safeParse>>>();
 const result:any[]=[];
 for(const [index,row] of scopes.entries()){
  if(!row||!Object.hasOwn(row,'key')){result.push(row);continue;}
  const parsed=taskStopKeySchema.safeParse(row.key),sandbox=taskStopReconcileInputSchema.shape.sandboxId.safeParse(row.sandboxId),revision=taskStopReconcileInputSchema.shape.workspaceRevision.safeParse(row.workspaceRevision);
  const unverified=(reasonCode:TaskStopMaintenanceReasonCode):TaskStopMaintenanceScope=>({
   state:'unverified',canReconcile:false,reasonCode,
   displayKey:createHash('sha256').update(JSON.stringify(['task-storage',parsed.success?keyText(parsed.data):null,sandbox.success?sandbox.data:null,index])).digest('hex'),
   ...(parsed.success?{key:parsed.data}:{}),...(sandbox.success?{sandboxId:sandbox.data}:{}),
  });
  let maintenance=unverified('TASK_STOP_IDENTITY_INVALID');
  if(taskRows.length>128)maintenance=unverified('TASK_STOP_LIMIT');
  else if(parsed.success&&(counts.get(keyText(parsed.data))??0)>1)maintenance=unverified('TASK_STOP_AMBIGUOUS');
  else if(parsed.success&&row.runId===parsed.data.runId&&sandbox.success&&revision.success){
   if(!projections.has(parsed.data.runId))projections.set(parsed.data.runId,Promise.resolve().then(()=>readProjection(parsed.data.runId)).then(value=>taskStopMaintenanceSchema.safeParse(value),()=>taskStopMaintenanceSchema.safeParse(undefined)));
   const projection=await projections.get(parsed.data.runId)!;
   maintenance=unverified('TASK_STOP_EVIDENCE_INVALID');
   if(projection.success){
    const matching=projection.data.scopes.find(scope=>'key' in scope&&scope.key&&keyText(scope.key)===keyText(parsed.data));
    if(matching?.state==='unverified')maintenance=unverified(matching.reasonCode);
    else if(matching&&matching.sandboxId===sandbox.data&&matching.workspaceRevision===revision.data)maintenance=matching;
    else maintenance=unverified('TASK_STOP_SCOPE_MISSING');
   }
  }
  result.push({...row,scopeKind:'task',taskStopMaintenance:maintenance});
 }
 return result;
}
