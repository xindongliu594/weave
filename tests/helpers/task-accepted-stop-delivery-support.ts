import {before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {LocalRunExecutor} from '../../apps/api/src/local-execution.ts';
import {TaskAcceptedStopLifecycle} from '../../apps/api/src/task-accepted-stop.ts';
import {storeArchiveObjects} from '../../services/agent-runtime/archive-objects.mjs';
import {pool,migrate} from '../../apps/api/src/db.ts';
import {acceptedStopApiFixture} from './task-accepted-stop-api-fixture.ts';
import {checkpointContract} from '../../services/agent-runtime/step-checkpoints.mjs';

// Shared owned fixture lifecycle; each test file runs in its own isolated process.
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';

let integrationRoot:string;

before(async()=>{if(!isolated)return;integrationRoot=mkdtempSync(join(tmpdir(),'accepted-stop-delivery-'));process.env.DATA_DIR=integrationRoot;process.env.TRACE_ROOT=integrationRoot;await migrate();});

beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,task_attempt_workspaces,project_runs,projects,departments,usage,model_reservations,tool_approvals CASCADE');});

afterEach(async()=>{if(isolated)for(const table of ['models','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);});

after(async()=>{if(isolated){await pool.end();rmSync(integrationRoot,{recursive:true,force:true});}});

const {createTaskWorkspace}=createRequire(import.meta.url)('../../apps/desktop/task-workspace.cjs');

const {manifest,revision}=createRequire(import.meta.url)('../../apps/desktop/local-executor.cjs');

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;

const digest=(v:any)=>sha(JSON.stringify(ordered(v)));

const queryText=(args:any[])=>typeof args[0]==='string'?args[0]:args[0]?.text;

const queryValues=(args:any[])=>typeof args[0]==='string'?args[1]:args[0]?.values??args[1];

// Synthetic provenance tests exercise the pure verifier, not product acceptance.
function originalCommit(){
 const root=mkdtempSync(join(tmpdir(),'accepted-stop-original-')),id=randomUUID(),operationId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID();
 const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')};
 const key={runId:id,taskId:'a',attemptId:'attempt-a',generation:1},run={id,project_id:'project',project_version:1};
 const binding={projectId:'project',planVersion:1,...key,assigneeId:'employee',contractHash:sha('contract'),permissionHash:sha('permission'),backend:{kind:'openshell',version:backend.version,image:backend.image,policyHash:backend.policySha256}};
 const workspace=createTaskWorkspace({binding,readPaths:[],writePaths:['a.txt'],canonicalFiles:[],origins:[]});
 const scope={profile:'task-attempt-openshell-v1',key,workspace,workRevision:revision([]),capabilityHash:sha('capability'),inputOrigins:[]};
 const files=[{path:'a.txt',content:Buffer.from('A').toString('base64')}],context={agentId:'employee',sessionId:'session',taskId:'a',attemptId:'attempt-a',generation:1};
 const result={localWorkspace:'/sandbox',path:'a.txt',bytes:1,sha256:sha('A'),files,artifacts:manifest(files),workspaceRevision:revision(files),execution:{...backend,sandboxId:randomUUID(),sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:scope.profile,key,scopeHash:workspace.scopeHash,operationId,beforeWorkRevision:revision([]),afterWorkRevision:revision(files)}};
 const claimToken=randomUUID();
 const row:any={id:operationId,run_id:id,device_id:deviceId,grant_id:grantId,lease_owner:'original-owner',status:'completed',started:true,claim_token:claimToken,merge_state:'committed',payload:{runId:id,deviceId,grantId,name:'artifact_write',arguments:{path:'a.txt',content:'A'},context,taskScope:scope,executionScope:{profile:scope.profile,key,binding,scopeHash:workspace.scopeHash,readPaths:workspace.readPaths,writePaths:workspace.writePaths,inputManifest:workspace.inputManifest,expectedWorkRevision:revision([])}},result:{claimToken,ok:true,result}};
 const receipt={mergeId:operationId,operationId,key,scopeHash:workspace.scopeHash,beforeRevision:revision([]),afterRevision:revision(files),workRevision:revision(files),status:'committed'};
 const record:any={version:1,operationId,resultDigest:digest(row.result),scopeDigest:digest(scope),before:{revision:revision([]),manifest:[],mergeId:null},after:{revision:revision(files),manifest:manifest(files),mergeId:operationId},receipt,delta:[{path:'a.txt',sha256:sha('A')}]};record.digest=digest(record);row.merge_record=record;
 const task:any={run_id:id,task_id:'a',attempt_id:'attempt-a',generation:1,principal:'employee',session_id:'session',contract_hash:binding.contractHash,permission_hash:binding.permissionHash,capability_hash:scope.capabilityHash,input_origins:[],sandbox_identity:{sandboxId:result.execution.sandboxId,localWorkspace:'/sandbox'},committed_outputs:[{scope,receipt:{profile:scope.profile,key,scopeHash:workspace.scopeHash,operationId,beforeWorkRevision:record.before.revision,afterWorkRevision:record.after.revision},files:record.delta}]};
 mkdirSync(join(root,id));storeArchiveObjects(join(root,id),[{sha256:sha('A'),size:1,content:Buffer.from('A')}]);
 return {root,run,task,row,backend,close:()=>rmSync(root,{recursive:true,force:true})};
}

async function ready(){const f=await acceptedStopApiFixture(integrationRoot);try{await f.acceptA();const context=await f.bind('b');return {f,context};}catch(error){await f.close();throw error;}}

const marker=async(runId:string)=>(await pool.query("SELECT accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='a'",[runId])).rows[0].accepted_stop;

function checkpointContractFor(snapshot:any,id:string){return checkpointContract(snapshot,snapshot.tasks.find((task:any)=>task.id===id));}

// Terminal acceptance uses the same real HTTP/result/CAS/Handoff path as above.
async function terminalReady(fresh=1){
 const f=await acceptedStopApiFixture(integrationRoot);
 try{
  if(fresh===3)for(const id of ['a','b','c'])await f.write(id,id.toUpperCase());
  await f.acceptA();
  if(fresh===2){await f.write('b','B');await f.write('c','C');}
  await f.acceptTask('b','B');await f.acceptTask('c','C');return f;
 }catch(error){await f.close();throw error;}
}

function finalize(executor:LocalRunExecutor,signal=new AbortController().signal){assert.equal(typeof (executor as any).finalizeAccepted,'function','terminal source-only entry must exist');return (executor as any).finalizeAccepted(signal);}

function observer(f:Awaited<ReturnType<typeof terminalReady>>){const lifecycle=new TaskAcceptedStopLifecycle(f.runId,f.service,f.maintenance);assert.equal(typeof (lifecycle as any).reconcileExact,'function','trusted original-ID observer must exist');return (identity:any,signal=new AbortController().signal)=>(lifecycle as any).reconcileExact(identity,signal);}

async function lastMarker(f:any){return (await pool.query("SELECT accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='c'",[f.runId])).rows[0].accepted_stop;}

export {isolated,integrationRoot,createTaskWorkspace,manifest,revision,sha,digest,queryText,queryValues,originalCommit,ready,marker,checkpointContractFor,terminalReady,finalize,observer,lastMarker};
