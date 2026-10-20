import test from 'node:test';
import assert from 'node:assert/strict';
import {executionBackend,assertExecutionBackendBinding,assertExecutionBackendReceipt} from '../apps/api/src/execution-backend.ts';
import {policySchema} from '../packages/contracts/index.ts';

const backend={kind:'openshell',version:'0.1.2',gateway:'weiwu-openshell-v012',image:'docker.io/library/node:24.19.0-bookworm-slim@sha256:'+'e'.repeat(64),policySha256:'a'.repeat(64),fingerprint:'b'.repeat(64)} as const;
const execution={...backend,sandboxId:'67e64e45-7302-4fb9-ac33-cb050825baef',sandboxName:'wwp-43170b8e3257',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'};
test('legacy native policies and receipts remain valid without added metadata',()=>{
 const native=executionBackend(undefined);assert.equal(native.kind,'native');
 assertExecutionBackendBinding(native,undefined);assertExecutionBackendReceipt(native,{});
 assert.throws(()=>assertExecutionBackendReceipt(native,{execution}),{code:'LOCAL_BACKEND_PROOF_INVALID'});
});
test('an OpenShell selection must bind the approved environment fingerprint',()=>{
 assertExecutionBackendBinding(backend,backend);
 assert.throws(()=>assertExecutionBackendBinding(backend,undefined),{code:'LOCAL_BACKEND_CHANGED'});
 assert.throws(()=>assertExecutionBackendBinding(backend,{...backend,fingerprint:'d'.repeat(64)}),{code:'LOCAL_BACKEND_CHANGED'});
 const policy=policySchema.parse({maxBudget:1,maxAgents:3,maxConcurrentAgents:1,deadlineSeconds:600,executionTarget:{kind:'local',deviceId:execution.sandboxId,grantId:execution.sandboxId,backend}});
 assert.deepEqual(policy.executionTarget?.kind==='local'&&policy.executionTarget.backend,backend);
});
test('sandbox receipts reject missing, changed or privileged execution identities',()=>{
 assertExecutionBackendReceipt(backend,{execution});
 assert.throws(()=>assertExecutionBackendReceipt(backend,{}),{code:'LOCAL_BACKEND_PROOF_INVALID'});
 for(const change of [{uid:0},{gid:0},{node:'v22.0.0'},{sandboxId:'unknown'},{fingerprint:'d'.repeat(64)},{policySha256:'d'.repeat(64)},{gateway:'another'},{effectivePolicyHash:''},{effectivePolicyHash:'c'.repeat(64)},{cpu:undefined},{cpu:['max','100000']},{cpu:[200000,100000]},{cpu:[0,0]},{cpu:[100000]},{memory:undefined},{memory:'max'},{memory:'1073741824'}])
  assert.throws(()=>assertExecutionBackendReceipt(backend,{execution:{...execution,...change}}),{code:'LOCAL_BACKEND_PROOF_INVALID'});
});

test('task backend receipts bind the exact task operation and both visible revisions',()=>{
 const taskExecution={profile:'task-attempt-openshell-v1',key:{runId:'run',taskId:'task',attemptId:'attempt',generation:1},scopeHash:'a'.repeat(64),operationId:'operation',beforeWorkRevision:'b'.repeat(64),afterWorkRevision:'c'.repeat(64)};
 assert.doesNotThrow(()=>(assertExecutionBackendReceipt as any)(backend,{execution,taskExecution},taskExecution));
 for(const change of [{operationId:'other'},{key:{...taskExecution.key,generation:2}},{beforeWorkRevision:'d'.repeat(64)},{afterWorkRevision:'d'.repeat(64)},{scopeHash:'d'.repeat(64)}])assert.throws(()=>(assertExecutionBackendReceipt as any)(backend,{execution,taskExecution:{...taskExecution,...change}},taskExecution),{code:'LOCAL_BACKEND_PROOF_INVALID'});
 assert.throws(()=>(assertExecutionBackendReceipt as any)(backend,{execution},taskExecution),{code:'LOCAL_BACKEND_PROOF_INVALID'});
});

