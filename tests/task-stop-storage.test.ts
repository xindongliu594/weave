import test from 'node:test';
import assert from 'node:assert/strict';
const module:any=await import('../apps/api/src/task-stop-storage.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const runId='10000000-0000-0000-0000-000000000001',sandboxId='10000000-0000-0000-0000-000000000002',stopId='10000000-0000-0000-0000-000000000003',revision='a'.repeat(64);
const key={runId,taskId:'same-task',attemptId:'attempt-a',generation:1};
const row=(patch:any={})=>({runId,key,sandboxId,phase:'stopped',workspaceRevision:revision,...patch});
const marker=(patch:any={})=>({key,sandboxId,workspaceRevision:revision,state:'unknown',stopId,reasonCode:'TASK_STOP_UNKNOWN',canReconcile:true,...patch});
const read=(scopes:any[])=>async()=>({version:1,state:scopes.every(scope=>scope.state==='stopped')?'stopped':'pending',scopes});
// Synthetic projection/device metadata tests joining only. These cannot prove
// SQL acceptance, device identity or a successful stop; the app fixture does.
test('storage joins full task attempt identity and reads each run once',async()=>{
 assert.equal(typeof module.withTaskStopMaintenance,'function');
 const other={...key,attemptId:'attempt-b',generation:2},secondSandbox='10000000-0000-0000-0000-000000000004';
 let reads=0;
 const result=await module.withTaskStopMaintenance([row(),row({key:other,sandboxId:secondSandbox})],async(id:string)=>{assert.equal(id,runId);reads++;return read([marker(),marker({key:other,sandboxId:secondSandbox,state:'stopped',reasonCode:undefined,canReconcile:false})])();});
 assert.equal(reads,1);assert.equal(result[0].scopeKind,'task');
 assert.equal(result[0].taskStopMaintenance.state,'unknown');assert.equal(result[0].taskStopMaintenance.canReconcile,true);
 assert.equal(result[1].taskStopMaintenance.state,'stopped');assert.equal(result[1].taskStopMaintenance.canReconcile,false);
});
test('matching run alone cannot borrow another sandbox, revision or attempt stop',async()=>{
 assert.equal(typeof module.withTaskStopMaintenance,'function');
 for(const patch of [{sandboxId:'10000000-0000-0000-0000-000000000005'},{workspaceRevision:'b'.repeat(64)},{key:{...key,generation:2}}]){
  const [result]=await module.withTaskStopMaintenance([row(patch)],read([marker()]));
  assert.equal(result.taskStopMaintenance.state,'unverified');assert.equal(result.taskStopMaintenance.canReconcile,false);assert.equal(result.taskStopMaintenance.stopId,undefined);
 }
});
test('absent, malformed and ambiguous projections are protected without invented stop identity',async()=>{
 assert.equal(typeof module.withTaskStopMaintenance,'function');
 for(const projection of [{version:1,state:'not-applicable',scopes:[]},{version:1,state:'pending',scopes:[marker(),marker()]},{version:1,state:'pending',scopes:[{...marker(),privateProof:'discard'}]}]){
  const [result]=await module.withTaskStopMaintenance([row()],async()=>projection);
  assert.equal(result.taskStopMaintenance.state,'unverified');assert.equal(result.taskStopMaintenance.canReconcile,false);
  assert.equal(JSON.stringify(result).includes('privateProof'),false);
 }
 const [failed]=await module.withTaskStopMaintenance([row()],async()=>{throw Error('PRIVATE_SQL_MESSAGE');});
 assert.equal(failed.taskStopMaintenance.state,'unverified');assert.equal(JSON.stringify(failed).includes('PRIVATE_SQL_MESSAGE'),false);
});
test('legacy rows retain existing behavior and invalid task keys cannot enter the SQL reader',async()=>{
 assert.equal(typeof module.withTaskStopMaintenance,'function');
 const legacy={runId,sandboxId,phase:'stopped'};
 let reads=0;const result=await module.withTaskStopMaintenance([legacy,row({key:{...key,generation:0}})],async()=>{reads++;throw Error('must not read');});
 assert.equal(reads,0);assert.equal(result[0],legacy);assert.equal(result[1].scopeKind,'task');
 assert.equal(result[1].taskStopMaintenance.state,'unverified');assert.equal(result[1].taskStopMaintenance.canReconcile,false);
});
test('duplicate device keys and over-limit task inventories cannot expose a reconciliation action',async()=>{
 assert.equal(typeof module.withTaskStopMaintenance,'function');
 let reads=0;
 for(const rows of [[row(),row()],Array.from({length:129},(_,n)=>row({key:{...key,generation:n+1}}))]){
  const result=await module.withTaskStopMaintenance(rows,async()=>{reads++;return read([marker()])();});
  assert.ok(result.every((item:any)=>item.taskStopMaintenance.state==='unverified'&&!item.taskStopMaintenance.canReconcile));
  assert.equal(new Set(result.map((item:any)=>item.taskStopMaintenance.displayKey)).size,result.length);
 }
 assert.equal(reads,0);
});
