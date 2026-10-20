import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {checkpointContract,checkpointDigest} from '../services/agent-runtime/step-checkpoints.mjs';

// Synthetic metadata exercises formatting/projection, not runtime acceptance or
// physical OpenShell effects. HTTP/SQL provenance is verified separately.
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const runId='10000000-0000-0000-0000-000000000001';
const projectId='10000000-0000-0000-0000-000000000002';
const sandboxId='10000000-0000-0000-0000-000000000003';
const key={runId,taskId:'a',attemptId:'attempt-a',generation:1};
const load=async()=>import('../apps/api/src/task-stop-maintenance.ts').catch(()=>({} as any));
const id=(n:number)=>'20000000-0000-0000-0000-'+String(n).padStart(12,'0');
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;
const digest=(v:any)=>sha(JSON.stringify(ordered(v)));
function fixture(state:string|null=null):any{
 const contract={id:'a',assignee:'employee',inputs:[],outputs:[],dependencies:[],verify:[]};
 const target={kind:'local',deviceId:id(1),grantId:id(2),backend:{kind:'openshell',fingerprint:sha('backend')}};
 const snapshot={projectId,planVersion:1,executionProfile:'task-attempt-openshell-v1',executionTarget:target,agents:[{id:'employee',tools:[]}],tasks:[contract]};
 const workspaceRevision=checkpointDigest([]),scopeHash=sha('scope'),capabilityHash=sha('capability');
 const refs:any={profile:snapshot.executionProfile,key,inputManifest:[],inputOrigins:[],workManifest:[],canonical:{revision:workspaceRevision,manifest:[],mergeId:id(3)},lastMerge:{mergeId:id(3),operationId:id(3),key,scopeHash,beforeRevision:workspaceRevision,afterRevision:workspaceRevision,workRevision:workspaceRevision,status:'committed'},scopeHash,capabilityHash};
 const accepted={seq:3,at:'2026-10-20T10:00:00.000Z',type:'handoff/accepted',data:{runId,taskId:'a',attemptId:'attempt-a',workspaceRevision,sandboxWorkRevision:workspaceRevision,taskExecution:{profile:snapshot.executionProfile,key,capabilityHash},commands:[],inputs:[],outputs:[]}};
 const boundary={taskId:'a',attemptId:'attempt-a',sessionId:'session',trigger:'node-accepted',eventCursor:4,contractHash:checkpointContract(snapshot,contract,refs),environment:sha('environment')};
 const metadata={id:id(4),version:2,runId,boundary,receipts:[],files:[],...refs};
 const checkpoint={seq:5,type:'step/checkpoint',data:{...metadata,sha256:checkpointDigest(metadata)}};
 const events=[{seq:1,type:'run/created',data:{snapshotSha256:sha(JSON.stringify(snapshot))}},{seq:2,type:'run/task-mapping',data:{tasks:[{task_id:'native-a',seed_id:'a'}]}},accepted,{seq:4,type:'step/boundary',taskId:'a',attemptId:'attempt-a',sessionId:'session',data:{taskId:'a',attemptId:'attempt-a',trigger:'node-accepted'}},checkpoint,{seq:6,type:'team/checkpoint',data:{members:[{id:'session',name:'employee'}],tasks:[{id:'native-a',assignee:'employee',attemptId:'attempt-a',status:'completed'}]}}];
 const contractHash=checkpointContract(snapshot,contract),permissionHash=sha('permission');
 const row:any={run_id:runId,task_id:'a',attempt_id:'attempt-a',generation:1,principal:'employee',session_id:'session',runtime_task_id:'native-a',contract_hash:contractHash,permission_hash:permissionHash,capability_hash:capabilityHash,contract,input_origins:[],committed_receipts:[{scope:{profile:refs.profile,key,workRevision:workspaceRevision,capabilityHash,inputOrigins:[]},receipt:{profile:refs.profile,key,scopeHash,operationId:id(3),beforeWorkRevision:workspaceRevision,afterWorkRevision:workspaceRevision}}],sandbox_identity:{sandboxId,localWorkspace:'/sandbox/private'},scope_metadata:{profile:refs.profile,key,workRevision:workspaceRevision,capabilityHash,inputOrigins:[],workspace:{scopeHash,inputManifest:[],binding:{projectId,planVersion:1,runId,taskId:'a',attemptId:'attempt-a',assigneeId:'employee',generation:1,contractHash,permissionHash}}},phase:'active',accepted_stop:null};
 const operation:any={id:id(3),run_id:runId,device_id:id(1),grant_id:id(2),status:'completed',started:true,claim_bound:true,result_ok:true,merge_state:'committed',scope_key:key,scope_hash:scopeHash,before_work_revision:workspaceRevision,workspace_revision:workspaceRevision,sandbox_id:sandboxId,local_workspace:'/sandbox/private',merge_digest:sha('merge'),merge_receipt:refs.lastMerge,task_execution:{profile:refs.profile,key,scopeHash,operationId:id(3),beforeWorkRevision:workspaceRevision,afterWorkRevision:workspaceRevision}};
 if(state){
  const proof={accepted:{seq:3,digest:digest(accepted)},checkpoint:{id:id(4),sha256:checkpoint.data.sha256,seq:5},originalOperationId:id(3),originalMergeDigest:sha('merge'),runtimeTaskId:'native-a',principal:'employee',sessionId:'session',contractHash,permissionHash,capabilityHash,deviceId:id(1),grantId:id(2),fingerprint:sha('backend')};
  const identity={version:1,stopId:id(5),key,sandboxId,workspaceRevision,proofDigest:digest({kind:'task-accepted-stop-proof',version:1,proof})};
  row.accepted_stop={version:1,identity,proof,state,preparedAt:'2026-10-20T10:00:00.000Z',digest:digest({kind:'task-accepted-stop',version:1,identity,proof})};
  if(state!=='prepared')row.accepted_stop.dispatchedAt='2026-10-20T10:00:01.000Z';
  if(state==='unknown')row.accepted_stop.lastError={code:'LOCAL_OUTCOME_UNKNOWN',message:'private device error / token'};
  if(state==='stopped')Object.assign(row.accepted_stop,{confirmedAt:'2026-10-20T10:00:02.000Z',result:{...identity,phase:'stopped',replayed:false}});
 }
 return structuredClone({run:{id:runId,project_id:projectId,project_version:1,snapshot},rows:[row],archive:{id:runId,snapshot,integrity:'ok',events},operations:[operation]});
}

test('only legacy profile can project not-applicable; empty task evidence remains pending',async()=>{
 const module=await load();assert.equal(typeof module.projectTaskStopMaintenance,'function');
 const legacy=module.projectTaskStopMaintenance({run:{id:runId,snapshot:{executionProfile:'legacy-run-v1'}},rows:[],archive:null});
 assert.deepEqual(legacy,{version:1,state:'not-applicable',scopes:[]});
 for(const executionProfile of ['task-attempt-openshell-v1','unsupported']){
  const result=module.projectTaskStopMaintenance({run:{id:runId,snapshot:{executionProfile}},rows:[],archive:null});
  assert.equal(result.state,'pending');assert.equal(result.scopes.length,1);
  assert.equal(result.scopes[0].state,'unverified');assert.equal(result.scopes[0].canReconcile,false);
  assert.equal(result.scopes[0].unresolvedCount,1);
 }
});

test('NULL original marker is protected no-intent and every existing marker keeps its original ID',async()=>{
 const {projectTaskStopMaintenance}=await load();
 for(const state of [null,'stopped','prepared','dispatching','unknown']){
  const f=fixture(state),result=projectTaskStopMaintenance(f),scope=result.scopes[0];
  assert.equal(result.state,state==='stopped'?'stopped':'pending');
  assert.deepEqual(scope,{key,sandboxId,workspaceRevision:checkpointDigest([]),state:state??'no-intent',...(state?{stopId:id(5)}:{}),...(state==='stopped'?{}:{reasonCode:state?'TASK_STOP_'+state.toUpperCase():'TASK_STOP_NO_INTENT'}),canReconcile:state!==null&&state!=='stopped'});
  assert.equal(JSON.stringify(result).includes('private'),false);
  assert.equal(JSON.stringify(result).includes('proof'),false);
 }
});

test('marker structure alone cannot confirm mismatched accepted checkpoint or SQL operation metadata',async()=>{
 const {projectTaskStopMaintenance}=await load();
 for(const change of [(f:any)=>f.rows[0].accepted_stop.identity.key.generation++, (f:any)=>f.rows[0].accepted_stop.extra='private',
  (f:any)=>f.rows[0].sandbox_identity.sandboxId=id(10),(f:any)=>f.archive.events[2].data.sandboxWorkRevision=sha('different'),
  (f:any)=>f.archive.events[4].data.sha256=sha('wrong'),(f:any)=>f.archive.events[3].data.trigger='deviceReady',
  (f:any)=>f.operations[0].merge_digest=sha('different'),(f:any)=>f.operations[0].workspace_revision=sha('full canonical'),
  (f:any)=>f.operations[0].scope_key={...key,generation:2},(f:any)=>f.rows[0].contract_hash=sha('different'),
  (f:any)=>f.archive.events[5].data.tasks[0].id='captain',(f:any)=>f.rows[0].scope_metadata.workspace.binding.permissionHash=sha('different')]){
  const f=fixture('stopped');change(f);const result=projectTaskStopMaintenance(f);
  assert.equal(result.state,'pending');assert.equal(result.scopes[0].state,'unverified');assert.equal(result.scopes[0].canReconcile,false);
 }
});

test('missing archive, sandbox identity or accepted scope never becomes empty stopped output',async()=>{
 const {projectTaskStopMaintenance}=await load();
 const f=fixture('stopped');f.archive=null as any;const missingArchive=projectTaskStopMaintenance(f);
 assert.equal(missingArchive.state,'pending');assert.equal(missingArchive.scopes[0].reasonCode,'TASK_STOP_ARCHIVE_UNAVAILABLE');
 assert.deepEqual(Object.keys(missingArchive.scopes[0]).sort(),['canReconcile','displayKey','key','reasonCode','sandboxId','state']);
 const missingSandbox=fixture('stopped');missingSandbox.rows[0].sandbox_identity=null;
 const scope=projectTaskStopMaintenance(missingSandbox).scopes[0];assert.equal(scope.state,'unverified');assert.equal('sandboxId' in scope,false);assert.equal('workspaceRevision' in scope,false);
 const absent=fixture('stopped');absent.rows=[];
 const result=projectTaskStopMaintenance(absent);assert.equal(result.state,'pending');assert.equal(result.scopes.length,1);assert.equal(result.scopes[0].state,'unverified');assert.equal(result.scopes[0].canReconcile,false);
 const noAcceptance=fixture();noAcceptance.archive.events=noAcceptance.archive.events.slice(0,2) as any;
 assert.equal(projectTaskStopMaintenance(noAcceptance).scopes[0].state,'unverified');
 assert.equal(projectTaskStopMaintenance({run:null,rows:[],archive:null}).state,'pending');
});

test('retired and superseded NULL scopes keep their original no-intent identity without borrowing repair proof',async()=>{
 const {projectTaskStopMaintenance}=await load();
 for(const retired of [true,false]){
  const f=fixture();if(retired)f.rows[0].phase='retired';else f.archive.events.push({seq:7,type:'run/task-mapping',data:{tasks:[{task_id:'repair-a',seed_id:'a'}]}} as any);
  const result=projectTaskStopMaintenance(f),scope=result.scopes[0];
  assert.equal(result.state,'pending');assert.equal(scope.state,'no-intent');assert.equal(scope.reasonCode,'TASK_STOP_SCOPE_RETIRED');assert.equal(scope.canReconcile,false);assert.equal('stopId' in scope,false);assert.deepEqual(scope.key,key);
 }
 const f=fixture();f.rows[0].phase='retired';f.archive.events[4].data.key={...key,generation:2} as any;
 assert.equal(projectTaskStopMaintenance(f).scopes[0].state,'unverified');
});

test('ambiguous and invalid locators collapse to bounded aggregate without effect identity',async()=>{
 const {projectTaskStopMaintenance}=await load();
 for(const change of [(f:any)=>f.rows.push({...structuredClone(f.rows[0]),sandbox_identity:{sandboxId:id(80)}}),
  (f:any)=>f.rows[0].generation=1.5,(f:any)=>f.rows[0].run_id=id(70),
  (f:any)=>f.archive.events.push({...structuredClone(f.archive.events[2]),seq:7})]){
  const f=fixture('stopped');change(f);const result=projectTaskStopMaintenance(f),scope=result.scopes[0];
  assert.equal(result.state,'pending');assert.equal(result.scopes.length,1);assert.equal(scope.state,'unverified');assert.equal(scope.canReconcile,false);assert.ok(scope.unresolvedCount>0&&scope.unresolvedCount<=128);
  assert.deepEqual(Object.keys(scope).sort(),['canReconcile','displayKey','reasonCode','state','unresolvedCount']);
 }
});

test('missing approved row and all truncation signals remain visible and display keys stay stable',async()=>{
 const {projectTaskStopMaintenance}=await load();
 const f=fixture('stopped'),a=projectTaskStopMaintenance(f).scopes[0];
 f.run.snapshot.tasks.push({id:'b',assignee:'employee',inputs:[],outputs:[],dependencies:[],verify:[]});
 const missing=projectTaskStopMaintenance(f);assert.equal(missing.state,'pending');assert.equal(missing.scopes.length,2);assert.equal(missing.scopes[1].state,'unverified');
 const noArchive=fixture();noArchive.archive=null as any;
 const first=projectTaskStopMaintenance(noArchive).scopes[0];noArchive.rows[0].accepted_stop={private:'not for display'};
 assert.equal(projectTaskStopMaintenance(noArchive).scopes[0].displayKey,first.displayKey);
 for(const change of [(x:any)=>x.rowsTruncated=true,(x:any)=>x.rows=Array.from({length:129},()=>x.rows[0]),(x:any)=>x.operations=Array.from({length:1025},()=>x.operations[0]),(x:any)=>x.archive.events=Array.from({length:100001},(_,i)=>({seq:i+1,type:'ignored',data:{}}))]){
  const x=fixture('stopped');change(x);const result=projectTaskStopMaintenance(x);assert.equal(result.state,'pending');assert.equal(result.scopes.length,1);assert.equal(result.scopes[0].reasonCode,'TASK_STOP_LIMIT');assert.ok(result.scopes[0].unresolvedCount<=128);
 }
 assert.equal(a.state,'stopped');
});

test('DTO refuses unknown private fields, invalid effect identities and duplicate scope keys',async()=>{
 const module=await import('../packages/contracts/task-stop-maintenance.ts').catch(()=>({} as any));
 assert.equal(typeof module.taskStopMaintenanceSchema?.safeParse,'function');
 const scope={key,sandboxId,workspaceRevision:sha('partial'),state:'no-intent',canReconcile:false};
 const value={version:1,state:'pending',scopes:[scope]};
 assert.equal(module.taskStopMaintenanceSchema.safeParse(value).success,true);
 for(const bad of [{...value,proof:{}},{...value,scopes:[{...scope,proof:{}}]},{...value,scopes:[{...scope,key:{...key,extra:true}}]},
  {...value,scopes:[{...scope,sandboxId:'not-uuid'}]},{...value,scopes:[scope,scope]},{...value,state:'stopped'},
  {...value,scopes:[{state:'unverified',displayKey:sha('display'),reasonCode:'TASK_STOP_UNVERIFIED',unresolvedCount:0,canReconcile:false}]}]){
  assert.equal(module.taskStopMaintenanceSchema.safeParse(bad).success,false);
 }
});

test('injected SQL reader selects bounded metadata, re-reads on each call and never emits private reader errors',async()=>{
 const module=await load();assert.equal(typeof module.readTaskStopMaintenance,'function');
 const f=fixture('unknown'),queries:Array<{sql:string;parameters:any[]}>=[];
 const db={query:async(sql:string,parameters:any[])=>{
  queries.push({sql,parameters});assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/SELECT\s+\*|importedFiles|result\s+AS|claim_token\s+AS/i);
  if(sql.includes('FROM project_runs'))return {rows:[f.run]};
  if(sql.includes('FROM task_attempt_workspaces'))return {rows:f.rows};
  if(sql.includes('FROM local_operations'))return {rows:f.operations};
  assert.fail('Unexpected SQL relation');
 }};
 const options={db,traceRoot:'unused',runId,readArchive:()=>f.archive};
 assert.equal((await module.readTaskStopMaintenance(options)).scopes[0].state,'unknown');
 const next=fixture('stopped');f.rows=next.rows;
 assert.equal((await module.readTaskStopMaintenance(options)).state,'stopped');
 assert.equal(queries.length,6);for(const query of queries)assert.equal(query.parameters[0],runId);
 assert.match(queries[1].sql,/LIMIT 129/);assert.match(queries[2].sql,/LIMIT 1025/);assert.deepEqual(queries[2].parameters[1],[id(3)]);
 const failed=await module.readTaskStopMaintenance({...options,db:{query:async()=>{throw Error('Bearer private sk-hidden / raw SQL');}}});
 assert.equal(failed.state,'pending');assert.equal(JSON.stringify(failed).includes('private'),false);
});

test('strict DTO rejects all extra fields and invalid state/reconciliation combinations',async()=>{
 const {taskStopMaintenanceSchema,taskStopReconcileInputSchema}=await import('../packages/contracts/task-stop-maintenance.ts');
 const scope={key,sandboxId,workspaceRevision:sha('partial'),state:'unknown',stopId:id(5),reasonCode:'TASK_STOP_UNKNOWN',canReconcile:true};
 const aggregate={state:'unverified',displayKey:sha('display'),reasonCode:'TASK_STOP_UNVERIFIED',unresolvedCount:1,canReconcile:false};
 for(const bad of [{...scope,canReconcile:false},{...scope,state:'stopped'},{...scope,stopId:undefined},{...scope,key:{...key,taskId:'secret\n'}},{...scope,reasonCode:'Bearer secret'},
  {...aggregate,key},{...aggregate,sandboxId},{...aggregate,workspaceRevision:sha('partial')},{...aggregate,unresolvedCount:129}]){
  assert.equal(taskStopMaintenanceSchema.safeParse({version:1,state:'pending',scopes:[bad]}).success,false);
 }
 assert.equal(taskStopReconcileInputSchema.safeParse({key,sandboxId,workspaceRevision:sha('partial'),stopId:id(5),proof:{}}).success,false);
 assert.equal(taskStopMaintenanceSchema.safeParse({version:1,state:'pending',scopes:[scope,{...scope,sandboxId:id(99)}]}).success,false);
});

test('partial task revision is compared with original device metadata separately from full canonical revision',async()=>{
 const {projectTaskStopMaintenance}=await load(),f=fixture(),canonicalBefore=sha('private canonical before');
 f.rows[0].committed_receipts[0].scope.workRevision=canonicalBefore;
 f.rows[0].committed_receipts[0].receipt.beforeWorkRevision=canonicalBefore;
 f.archive.events[4].data.lastMerge.beforeRevision=canonicalBefore;
 const {sha256,...metadata}=f.archive.events[4].data;f.archive.events[4].data.sha256=checkpointDigest(metadata);
 assert.equal(projectTaskStopMaintenance(f).scopes[0].state,'no-intent');
 f.operations[0].before_work_revision=canonicalBefore;
 assert.equal(projectTaskStopMaintenance(f).scopes[0].state,'unverified');
});

test('historical stopped scope cannot hide a latest repair slot whose SQL row is missing',async()=>{
 const {projectTaskStopMaintenance}=await load(),f=fixture('stopped');f.rows[0].phase='retired';
 f.archive.events.push({seq:7,type:'run/task-mapping',data:{tasks:[{task_id:'repair-a',seed_id:'a'}]}},{seq:8,type:'team/checkpoint',data:{members:[{id:'repair-session',name:'employee'}],tasks:[{id:'repair-a',assignee:'employee',attemptId:'attempt-repair',status:'in_progress'}]}});
 const result=projectTaskStopMaintenance(f);assert.equal(result.state,'pending');assert.equal(result.scopes[0].state,'stopped');assert.equal(result.scopes.length,2);assert.equal(result.scopes[1].state,'unverified');assert.equal(result.scopes[1].canReconcile,false);
 f.rows=[];
 const absent=projectTaskStopMaintenance(f);assert.equal(absent.state,'pending');assert.equal(absent.scopes.length,2);assert.deepEqual(absent.scopes[0].key,key);assert.equal('key' in absent.scopes[1],false);assert.equal(absent.scopes[1].canReconcile,false);
});

test('duplicate native tasks, sessions and mappings cannot select one matching locator as stopped',async()=>{
 const {projectTaskStopMaintenance}=await load();
 for(const change of [
  (f:any)=>f.archive.events[5].data.tasks.push({id:'native-a',assignee:'employee',attemptId:'attempt-repair',status:'in_progress'}),
  (f:any)=>f.archive.events[5].data.tasks.push(structuredClone(f.archive.events[5].data.tasks[0])),
  (f:any)=>f.archive.events[5].data.members.push({id:'session',name:'another-employee',status:'removed'}),
  (f:any)=>f.archive.events[5].data.members.push(structuredClone(f.archive.events[5].data.members[0])),
  (f:any)=>f.archive.events.push({seq:7,type:'run/task-mapping',data:{tasks:[{task_id:'native-a',seed_id:'other-approved'},{task_id:'native-a',seed_id:'a'}]}}),
  (f:any)=>f.archive.events[1].data.tasks.push(structuredClone(f.archive.events[1].data.tasks[0])),
  (f:any)=>f.archive.events.push({seq:7,type:'run/task-mapping',data:{tasks:[{task_id:'native-a',seed_id:'other-approved'}]}}),
 ]){
  const f=fixture('stopped');change(f);const result=projectTaskStopMaintenance(f);
  assert.equal(result.state,'pending');assert.equal(result.scopes.length,1);assert.equal(result.scopes[0].reasonCode,'TASK_STOP_AMBIGUOUS');
  assert.deepEqual(Object.keys(result.scopes[0]).sort(),['canReconcile','displayKey','reasonCode','state','unresolvedCount']);
 }
});

test('repeated unchanged mappings and one missing latest accepted locator do not add false ambiguity or duplicate slots',async()=>{
 const {projectTaskStopMaintenance}=await load(),f=fixture('stopped');
 f.archive.events.push({seq:7,type:'run/task-mapping',data:{tasks:[{task_id:'native-a',seed_id:'a'}]}});
 assert.equal(projectTaskStopMaintenance(f).state,'stopped');
 f.rows=[];const result=projectTaskStopMaintenance(f);assert.equal(result.state,'pending');assert.equal(result.scopes.length,1);assert.deepEqual(result.scopes[0].key,key);
});

test('no-intent requires complete accepted input/output and verification metadata',async()=>{
 const {projectTaskStopMaintenance}=await load();
 for(const change of [(f:any)=>f.archive.events[2].data.outputs=[{path:'extra.txt',size:1,sha256:sha('x')}],
  (f:any)=>f.archive.events[2].data.inputs=[{path:'private.txt',size:1,sha256:sha('x')}],
  (f:any)=>{f.rows[0].contract.verify=['node verify.mjs'];f.rows[0].contract_hash=checkpointContract(f.run.snapshot,f.rows[0].contract);f.rows[0].scope_metadata.workspace.binding.contractHash=f.rows[0].contract_hash;const cp=f.archive.events[4].data;const {id,version,runId,boundary,files,receipts,sha256,...refs}=cp;cp.boundary.contractHash=checkpointContract(f.run.snapshot,f.rows[0].contract,refs);const {sha256:old,...metadata}=cp;cp.sha256=checkpointDigest(metadata);}]){
  const f=fixture();change(f);assert.equal(projectTaskStopMaintenance(f).scopes[0].state,'unverified');
 }
});
