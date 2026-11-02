import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import * as execution from '../apps/api/src/task-execution.ts';
import {pool,migrate} from '../apps/api/src/db.ts';
import {acceptedStopApiFixture} from './helpers/task-accepted-stop-api-fixture.ts';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {commitStepCheckpoint,checkpointContract,checkpointEnvironment,checkpointDigest} from '../services/agent-runtime/step-checkpoints.mjs';

const {createTaskWorkspace}=createRequire(import.meta.url)('../apps/desktop/task-workspace.cjs');
const {manifest,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
const signal=()=>new AbortController().signal;
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const scratch=join(process.cwd(),'.superpowers','sdd','2026-10-21-task-recovery-source');
let root:string;
before(async()=>{if(!isolated)return;assert.match(process.env.DATABASE_URL??'',/@127\.0\.0\.1:\d+\/postgres$/);mkdirSync(scratch,{recursive:true});root=mkdtempSync(join(scratch,'scope-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');await migrate();});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE departments,local_operations,local_devices,project_runs,projects,usage,model_reservations,tool_approvals CASCADE');});
after(async()=>{if(!isolated)return;for(const table of ['models','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);await pool.end();assert.ok(resolve(root).startsWith(resolve(scratch)+sep));rmSync(root,{recursive:true,force:true});});

function pure(){
 const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')};
 const employee={id:'e',employeeId:'e',tools:['filesystem']},contract={id:'a',kind:'work',assignee:'e',inputs:[{path:'in.txt',sha256:sha('input')}],outputs:[{path:'a.txt'}],inScope:['a.txt'],outOfScope:[],dependencies:[]};
 const run:any={id:randomUUID(),project_id:randomUUID(),project_version:1,status:'interrupted',snapshot:{resourceRevision:1,policy:{},tasks:[contract],agents:[employee],executionTarget:{kind:'local',backend},importedFiles:[{path:'in.txt',content:'input',sha256:sha('input'),snapshotId:'import',agentIds:['e']}]},events:[]};
 const assignment={runId:run.id,taskId:'a',attemptId:'attempt-a',generation:1,agentId:'e',sessionId:'session',runtimeTaskId:'native-a',contractHash:checkpointContract(run.snapshot,contract)};
 const hashes=execution.taskCapabilityHashes(run.snapshot,employee),initial=[file('in.txt','input'),file('private.txt','opaque')],inputs=execution.pinnedInputs(run,assignment,contract,revision(initial));
 const workspace=createTaskWorkspace({binding:{projectId:run.project_id,planVersion:1,runId:run.id,taskId:'a',attemptId:'attempt-a',generation:1,assigneeId:'e',contractHash:assignment.contractHash,permissionHash:hashes.permissionHash,backend:{kind:'openshell',version:'0.1.2',image:backend.image,policyHash:backend.policySha256}},readPaths:['in.txt'],writePaths:['a.txt'],canonicalFiles:initial,origins:inputs.map(input=>input.origin)});
 const key={runId:run.id,taskId:'a',attemptId:'attempt-a',generation:1},scope={profile:'task-attempt-openshell-v1',key,workspace,workRevision:revision(initial),capabilityHash:hashes.capabilityHash,inputOrigins:inputs};
 const current=[...initial,file('a.txt','current')],commit={scope,receipt:{profile:scope.profile,key,scopeHash:workspace.scopeHash,operationId:randomUUID(),beforeWorkRevision:scope.workRevision,afterWorkRevision:revision(current)},files:[{path:'a.txt',sha256:sha('current')}]};
 const task={run_id:run.id,task_id:'a',attempt_id:'attempt-a',generation:1,principal:'e',session_id:'session',runtime_task_id:'native-a',contract_hash:assignment.contractHash,permission_hash:hashes.permissionHash,capability_hash:hashes.capabilityHash,contract,input_origins:inputs,committed_outputs:[commit]};
 return {run,task,assignment,contract,hashes,inputs,current,commit};
}

test('pure builder reconstructs stopped historical own outputs without importing opaque canonical files',()=>{
 const f=pure(),build=(execution as any).rebuildTaskScope;
 assert.equal(typeof build,'function','shared pure reconstruction must exist without live admission');
 const scope=build({run:f.run,assignment:f.assignment,contract:f.contract,hashes:f.hashes,canonical:{revision:revision(f.current),files:f.current},inputs:f.inputs,committedOutputs:[f.commit]});
 assert.deepEqual(scope.workspace.importedFiles.map((entry:any)=>entry.path),['a.txt','in.txt']);
 assert.deepEqual(scope.workspace.baseCanonicalManifest,manifest(f.current));
 assert.equal(scope.workspace.inputManifest[0].origin.acceptedRevision,f.commit.receipt.afterWorkRevision);
 const bad=[...f.current.filter(entry=>entry.path!=='a.txt'),file('a.txt','changed')];
 assert.throws(()=>build({run:f.run,assignment:f.assignment,contract:f.contract,hashes:f.hashes,canonical:{revision:revision(bad),files:bad},inputs:f.inputs,committedOutputs:[f.commit]}),/固定输入|输出已变化/);
});

test('historical reconstruction checks the exact frozen contract and input identities',async()=>{
 const f=pure();
 const api:any=await import('../apps/api/src/task-recovery-scope.ts').catch((error:any)=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
 assert.equal(typeof api.reconstructHistoricalTaskScope,'function','historical scope reconstruction must be exported');
 const options={run:f.run,task:f.task,canonical:{revision:revision(f.current),files:f.current},committedOutputs:[f.commit]};
 assert.deepEqual(api.reconstructHistoricalTaskScope(options).workspace.importedFiles.map((entry:any)=>entry.path),['a.txt','in.txt']);
 const task=structuredClone(f.task);task.input_origins[0].sha256=sha('changed');
 assert.throws(()=>api.reconstructHistoricalTaskScope({...options,task}),/提交链|输入/);
 task.input_origins=structuredClone(f.task.input_origins);task.contract.outputs=[];
 assert.throws(()=>api.reconstructHistoricalTaskScope({...options,task}),/合同/);
});

async function checkpoint(f:any,context:any,trigger:string){
 const phase=trigger==='tool-result'?'after-tool':trigger==='before-tool'?'before-tool':'boundary';
 const operation=f.jobs.findLast((job:any)=>job.executionScope.key.taskId===context.taskId);
 const refs=await f.executor.prepareCheckpoint(context,signal(),{phase,...(phase==='after-tool'?{operationId:operation.id}:{})});
 const original=(await pool.query('SELECT result FROM local_operations WHERE id=$1',[refs.lastMerge.operationId])).rows[0];
 const boundary=f.archive.append('step/boundary',{taskId:context.taskId,attemptId:context.attemptId,trigger},{taskId:context.taskId,attemptId:context.attemptId,sessionId:context.sessionId});
 return commitStepCheckpoint({archive:f.archive,taskRefs:refs,boundary:{taskId:context.taskId,attemptId:context.attemptId,sessionId:context.sessionId,trigger,eventCursor:boundary.seq,contractHash:checkpointContract(f.snapshot,f.snapshot.tasks.find((task:any)=>task.id===context.taskId),refs),environment:checkpointEnvironment(f.snapshot,original.result.result.execution,refs)},receipts:[]});
}
async function source(f:any,cp:any){
 await pool.query("UPDATE project_runs SET status='interrupted',finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL WHERE id=$1",[f.runId]);
 const run=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.runId])).rows[0],events=readRun(root,f.runId)!.events;run.events=events;
 const scopes=(await pool.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1',[run.id])).rows,operations=(await pool.query('SELECT * FROM local_operations WHERE run_id=$1',[run.id])).rows;
 const provenance=await import('../apps/api/src/task-recovery-provenance.ts');
 const chain=provenance.verifyRecoveryCommitChain(root,run,scopes,operations,f.backend),selected=provenance.verifyRecoveryCheckpoint(root,run,events,cp.id,chain);
 return {traceRoot:root,run,events,chain,selected};
}

for(const trigger of ['tool-result','before-tool','cycle-complete'])test(trigger+' restores only historical A bytes and retains independently accepted B',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(root,{resourceRevision:1});try{
  const a=await f.write('a','old A'),cp=await checkpoint(f,a,trigger);await f.write('a','latest A');await f.acceptTask('b','independent B');
  const input=await source(f,cp),scope=await import('../apps/api/src/task-recovery-scope.ts');
  const before=JSON.stringify({run:input.run,events:input.events,scopes:input.chain.scopes}),result=scope.verifyRecoveryScope(input);
  assert.equal(result.candidate.files.find((entry:any)=>entry.path==='a.txt')!.content,file('a.txt','old A').content);
  assert.equal(result.candidate.files.find((entry:any)=>entry.path==='b.txt')!.content,file('b.txt','independent B').content);
  assert.equal(result.candidate.files.find((entry:any)=>entry.path==='private.txt')!.content,file('private.txt','private').content);
  assert.deepEqual(result.candidate.delta.map((entry:any)=>entry.path),['a.txt']);assert.equal(result.retained.length,1);
  assert.equal(result.retained[0].key.taskId,'b');assert.equal(result.historicalScope.workspace.scopeHash,trigger==='tool-result'?input.selected.original.scope.workspace.scopeHash:cp.scopeHash);
  assert.equal(JSON.stringify({run:input.run,events:input.events,scopes:input.chain.scopes}),before);
  const accepted=input.events.findLast((event:any)=>event.type==='handoff/accepted'&&event.data.taskId==='b')!.data;
  accepted.inputs[0].sha256=sha('wrong input');assert.throws(()=>scope.verifyRecoveryScope(input),/输入/);
 }finally{await f.close();}
});

test('recovery rejects a newly created A path after a before-tool checkpoint',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(root,{resourceRevision:1});try{
  const a=await f.bind('a');await f.drive(f.executor.prepareTask(a,signal()));const cp=await checkpoint(f,a,'before-tool');await f.write('a','new path');
  const input=await source(f,cp),scope=await import('../apps/api/src/task-recovery-scope.ts');assert.throws(()=>scope.verifyRecoveryScope(input),/路径/);
 }finally{await f.close();}
});

test('historical fixed inputs prove the original producer seal and reject ambiguous generations',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(root,{producerInput:true,resourceRevision:1});try{
  await f.acceptTask('p','producer bytes');const a=await f.write('a','old A'),cp=await checkpoint(f,a,'before-tool');await f.write('a','latest A');
  const input=await source(f,cp),api=await import('../apps/api/src/task-recovery-scope.ts');
  const row=input.chain.scopes.find((task:any)=>task.task_id==='a'),producer=input.events.findLast((event:any)=>event.type==='handoff/accepted'&&event.data.taskId==='p')!.data;
  assert.equal(row.input_origins[0].source.revision,producer.workspaceRevision);assert.notEqual(producer.workspaceRevision,input.chain.head.ref.revision);
  const result=api.verifyRecoveryScope(input);assert.equal(result.retained.length,1);assert.equal(result.retained[0].key.taskId,'p');
  assert.equal(result.candidate.files.find((entry:any)=>entry.path==='a.txt')!.content,file('a.txt','old A').content);
  input.chain.scopes.push({...input.chain.scopes.find((task:any)=>task.task_id==='p'),generation:2,phase:'retired'});
  assert.throws(()=>api.verifyRecoveryScope(input),/generation/);
 }finally{await f.close();}
});

test('retained commands cannot borrow an artifact write as a terminal verification receipt',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(root,{resourceRevision:1});try{
  const a=await f.write('a','old A'),cp=await checkpoint(f,a,'before-tool');await f.write('a','latest A');await f.write('b','B');
  const row=(await pool.query('SELECT * FROM local_operations WHERE id=$1',[f.jobs.at(-1).id])).rows[0];
  const receipt=row.result.result.taskExecution;
  const command:any={command:'node fake-check',exitCode:0,workspaceRevision:receipt.afterWorkRevision,mergeId:row.id,taskExecution:receipt,evidence:{runId:f.runId}};
  const observed:any=f.archive.append('handoff/command-observed',{taskId:'b',attemptId:'attempt-b',...command},{taskId:'b',attemptId:'attempt-b',sessionId:'session'});command.observationSeq=observed.seq;
  await f.acceptTask('b','B');
  // Negative archive corruption only: no successful SQL commit/claim is seeded.
  const events=readRun(root,f.runId)!.events,accepted=events.findLast(event=>event.type==='handoff/accepted'&&event.data.taskId==='b')!;
  const boundary=events.findLast(event=>event.type==='step/checkpoint'&&event.data.key?.taskId==='b')!;
  accepted.data.commands=[command];boundary.data.receipts=[command];const {sha256,...metadata}=boundary.data;boundary.data.sha256=checkpointDigest(metadata);
  writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));
  const input=await source(f,cp),api=await import('../apps/api/src/task-recovery-scope.ts');
  assert.throws(()=>api.verifyRecoveryScope(input),/命令|收据/);
 }finally{await f.close();}
});
