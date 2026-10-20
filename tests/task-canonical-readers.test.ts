import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pool,migrate} from '../apps/api/src/db.ts';
import {inProgressTaskMaintenance} from './helpers/task-stop-maintenance.ts';
import {LocalOperationService,LocalRunExecutor,localDeviceRouter} from '../apps/api/src/local-execution.ts';
import {runManagementRouter} from '../apps/api/src/run-management.ts';
import {workFilesRouter,prepareImportedWorkspace} from '../apps/api/src/work-files.ts';
import {buildPlanningExecutionContext} from '../apps/api/src/planning-execution-context.ts';
import {acceptedWorkEvidence} from '../apps/api/src/work-records.ts';
import {readCommittedCanonical} from '../apps/api/src/task-canonical.ts';
import {readLiveCanonical} from '../apps/api/src/live-canonical-reader.ts';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';
import {createOfficeFile} from '../services/agent-runtime/office-files.mjs';
import {HandoffGate} from '../services/agent-runtime/handoff.mjs';

const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const {manifest,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
let root:string,url:string,server:any,f:any;
const employee={id:'employee',employeeId:'employee',modelId:'unused',tools:['filesystem','artifact_write'],name:'Fixture',role:'manager'};
const api=async(path:string,body?:any)=>{const r=await fetch(url+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json() as any};};
const row=async(id:string)=>(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0];
before(async()=>{
 if(!isolated)return;root=mkdtempSync(join(tmpdir(),'task-readers-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');await migrate();
 const app=express();app.use(express.json({limit:'32mb'}));app.use(localDeviceRouter(root));app.use(runManagementRouter(root));app.use(workFilesRouter(pool,root));app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status??500).json({code:e.code,message:e.message}));server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port;
});
after(async()=>{if(!isolated)return;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool.end();assert.ok(root.startsWith(join(tmpdir(),'task-readers-')));rmSync(root,{recursive:true,force:true});});
beforeEach(async()=>{if(!isolated)return;await pool.query('TRUNCATE local_operations,local_devices,task_attempt_workspaces,project_runs,projects,departments,usage,model_reservations,work_file_snapshots CASCADE');f=await fixture();});
async function fixture(){
 const runId=randomUUID(),projectId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID(),owner=randomUUID(),token='1'.repeat(64);
 const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+hash('image'),policySha256:hash('policy'),fingerprint:hash('backend')};
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:10,maxTaskModelCalls:5,deadlineSeconds:180,executionTarget:{kind:'local',deviceId,grantId,backend}};
 const office=createOfficeFile({format:'docx',title:'Committed Office',text:'Exact committed Office bytes'}).buffer;
 const task={id:'task',assignee:'employee',inputs:[{path:'in.txt',sha256:hash('input')}],outputs:[{path:'out.txt'}],inScope:['out.txt'],outOfScope:[],dependencies:[]};
 const snapshot:any={projectId,planVersion:1,departmentId:'department',requirement:'Reader engineering fixture',executionProfile:'task-attempt-openshell-v1',policy,agents:[employee],tasks:[task],executionTarget:{...policy.executionTarget,platform:'linux',allowCommands:true},importedFiles:[{path:'in.txt',content:'input',snapshotId:'snapshot',sha256:hash('input'),agentIds:['employee']}]};
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'fixture',agents:[employee]}]);
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$3)',[projectId,'department','fixture',snapshot.requirement,policy,{agents:[employee],tasks:[task]}]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 await pool.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,$3,$4,$5,$3,true,$6)',[deviceId,hash(token),'fixture','linux',grantId,backend]);
 const archive=createRunArchive(root,snapshot,{id:runId}),artifacts=join(archive.dir,'artifacts');mkdirSync(artifacts);writeFileSync(join(artifacts,'in.txt'),'input');writeFileSync(join(artifacts,'report.docx'),office);
 archive.append('run/task-mapping',{tasks:[{task_id:'native',seed_id:'task'}]});archive.append('team/checkpoint',{members:[{id:'session',name:'employee'}],tasks:[{id:'native',assignee:'employee',attemptId:'attempt',status:'in_progress'}]});
 const persisted=(await row(runId)).snapshot;
 const service=new LocalOperationService(root,owner),executor=new LocalRunExecutor(archive,persisted,service,inProgressTaskMaintenance(deviceId,grantId,backend.fingerprint)),signal=AbortSignal.timeout(30000),candidate={runId,taskId:'task',attemptId:'attempt',agentId:'employee',sessionId:'session',runtimeTaskId:'native',contractHash:checkpointContract(persisted,persisted.tasks[0])};
 const assignment=await executor.bindAttempt(candidate,signal),context={agentId:'employee',sessionId:'session',taskId:'task',attemptId:'attempt',generation:assignment.generation};let work:any[]=[],sandboxId=randomUUID();
 async function deliver(action:Promise<any>){
  // Exercise the actual queued -> HTTP poll/start/result -> executor merge path.
  let actionError:any;action.catch(error=>{actionError=error;});let job:any;for(let n=0;n<1000;n++){if(actionError)throw actionError;const response=await fetch(url+'/local-devices/'+deviceId+'/poll',{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':token},body:'{}'});const data=await response.json() as any;assert.equal(response.status,200,JSON.stringify(data));if(data.job){job=data.job;break;}await new Promise(r=>setTimeout(r,10));}assert.ok(job,'real operation reaches poll');
  const send=async(endpoint:string,body:any)=>{const response=await fetch(url+'/local-devices/'+deviceId+'/operations/'+job.id+endpoint,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':token},body:JSON.stringify({claimToken:job.claimToken,...body})});assert.equal(response.status,200,await response.text());};
  await send('/start',{});if(job.name==='prepare')work=job.files;else work=[...work.filter(v=>v.path!==job.arguments.path),{path:job.arguments.path,content:Buffer.from(job.arguments.content).toString('base64')}];
  const result:any={localWorkspace:'openshell://fixture/'+sandboxId,files:work,artifacts:manifest(work),workspaceRevision:revision(work),execution:{...backend,sandboxId,sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:job.executionScope.profile,key:job.executionScope.key,scopeHash:job.executionScope.scopeHash,operationId:job.id,beforeWorkRevision:job.executionScope.expectedWorkRevision,afterWorkRevision:revision(work)}};
  if(job.name==='artifact_write')Object.assign(result,{path:job.arguments.path,bytes:Buffer.byteLength(job.arguments.content),sha256:hash(job.arguments.content)});await send('/result',{ok:true,result});await action;
 }
 const scope=await deliver(executor.prepareTask(context,signal));const current=await executor.taskScope(context,signal);await deliver(executor.execute('artifact_write',{path:'out.txt',content:'committed output',expectedWorkspaceRevision:current.workRevision,executionScope:{profile:current.profile,key:current.key,scopeHash:current.workspace.scopeHash,workRevision:current.workRevision}},signal,{...context,callId:randomUUID(),executionScope:{profile:current.profile,key:current.key,scopeHash:current.workspace.scopeHash,workRevision:current.workRevision}}));
 const canonical=readCommittedCanonical(root,await row(runId)),ready=await executor.prepareTask(context,signal),refs=await executor.prepareCheckpoint(context,signal,{phase:'boundary'});
 const handoff=new HandoffGate({snapshot:persisted,archive,sandbox:{root:artifacts}});
 handoff.bindExecutionScope('task','attempt',ready);handoff.bindCheckpoint('task','attempt',refs,{sessionId:'session'});handoff.commit(handoff.prepare('task','attempt',{}));
 archive.append('team/checkpoint',{tasks:[{id:'native',status:'completed',attemptId:'attempt'}]});archive.append('run/finished',{status:'completed'});await pool.query("UPDATE project_runs SET status='completed' WHERE id=$1",[runId]);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1 AND started AND merge_state='committed'",[runId])).rows[0].n,2);
 return {runId,projectId,snapshot,artifacts,canonical,office,archive};
}
function partialCache(){unlinkSync(join(f.artifacts,'report.docx'));writeFileSync(join(f.artifacts,'out.txt'),'partial wrong cache');writeFileSync(join(f.artifacts,'rogue.txt'),'not committed');}
const planning=async()=>buildPlanningExecutionContext(pool,root,{id:f.projectId,version:1,requirement:f.snapshot.requirement,plan:{tasks:f.snapshot.tasks,agents:f.snapshot.agents}});
test('artifact list and download use one complete SQL committed head despite partial corrupt cache',{skip:!isolated},async()=>{
 partialCache();const list=await api('/runs/'+f.runId+'/artifacts');assert.equal(list.status,200);assert.deepEqual(list.data,f.canonical.ref.manifest);const download=await fetch(url+'/runs/'+f.runId+'/artifact?path=out.txt');assert.equal(download.status,200);assert.equal(await download.text(),'committed output');assert.equal(download.headers.get('x-content-type-options'),'nosniff');const office=await fetch(url+'/runs/'+f.runId+'/artifact?path=report.docx');assert.deepEqual(Buffer.from(await office.arrayBuffer()),f.office);assert.equal((await fetch(url+'/runs/'+f.runId+'/artifact?path=rogue.txt')).status,404);
});
test('from-run imports exact committed text with partial cache',{skip:!isolated},async()=>{
 partialCache();const result=await api('/work-files/from-run',{runId:f.runId,paths:['out.txt']});assert.equal(result.status,201,JSON.stringify(result.data));const stored=(await pool.query('SELECT files FROM work_file_snapshots WHERE id=$1',[result.data.id])).rows[0].files;assert.equal(stored.find((v:any)=>v.path==='out.txt').text,'committed output');
});
test('parent copies require a selected canonical head for task profile and retain all committed files',{skip:!isolated},async()=>{
 partialCache();const child=randomUUID();assert.throws(()=>prepareImportedWorkspace(root,child,[],f.runId,'resume'),/canonical|来源|任务/);assert.equal(existsSync(join(root,child)),false);const selected=await readLiveCanonical(pool,root,await row(f.runId),readRun(root,f.runId));prepareImportedWorkspace(root,child,[],f.runId,'resume',selected);assert.equal(readFileSync(join(root,child,'artifacts/out.txt'),'utf8'),'committed output');assert.deepEqual(readFileSync(join(root,child,'artifacts/report.docx')),f.office);assert.equal(existsSync(join(root,child,'artifacts/rogue.txt')),false);
});
test('planning context and accepted work evidence use committed seals with partial cache',{skip:!isolated},async()=>{
 partialCache();const context=await planning();assert.equal(context.available,true);assert.deepEqual(context.completedTaskIds,['task']);assert.equal(context.files.find(v=>v.path==='out.txt')?.sha256,hash('committed output'));const evidence=await acceptedWorkEvidence(pool,root,f.runId);assert.equal(evidence.files.find((v:any)=>v.path==='out.txt')?.sha256,hash('committed output'));
});
for(const damage of ['missing','corrupt'])test(damage+' committed object blocks every consumer even with good cache without mutation',{skip:!isolated},async()=>{
 const blob=join(root,f.runId,'checkpoint-objects',hash('committed output'));if(damage==='missing')unlinkSync(blob);else writeFileSync(blob,'wrong object');const before=await row(f.runId),operations=(await pool.query('SELECT * FROM local_operations ORDER BY id')).rows,events=readFileSync(join(root,f.runId,'events.jsonl'));
 assert.equal((await api('/runs/'+f.runId+'/artifacts')).status,409);assert.equal((await fetch(url+'/runs/'+f.runId+'/artifact?path=out.txt')).status,409);assert.equal((await api('/work-files/from-run',{runId:f.runId,paths:['out.txt']})).status,409);const context=await planning();assert.equal(context.available,false);assert.deepEqual(context.files,[]);await assert.rejects(()=>acceptedWorkEvidence(pool,root,f.runId));assert.deepEqual(await row(f.runId),before);assert.deepEqual((await pool.query('SELECT * FROM local_operations ORDER BY id')).rows,operations);assert.deepEqual(readFileSync(join(root,f.runId,'events.jsonl')),events);assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_file_snapshots')).rows[0].n,0);
});
test('unknown profile, SQL/archive profile mismatch, recovery and absent live operation evidence refuse cache fallback',{skip:!isolated},async()=>{
 for(const snapshot of [{...f.snapshot,executionProfile:'unknown-profile'},{...f.snapshot,executionProfile:'legacy-run-v1'},{...f.snapshot,recovery:{sourceRunId:randomUUID()}}]){await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[snapshot,f.runId]);assert.equal((await api('/runs/'+f.runId+'/artifacts')).status,409);assert.equal((await planning()).available,false);await assert.rejects(()=>acceptedWorkEvidence(pool,root,f.runId));}
 await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[f.snapshot,f.runId]);await pool.query('DELETE FROM local_operations WHERE run_id=$1',[f.runId]);assert.equal((await api('/runs/'+f.runId+'/artifacts')).status,409,'restored task head has no live origin proof');assert.equal((await api('/work-files/from-run',{runId:f.runId,paths:['out.txt']})).status,409);
});
test('SQL unknown remains blocked when archive is finished and human acknowledgment is present',{skip:!isolated},async()=>{
 const old=(await pool.query('SELECT * FROM local_operations WHERE run_id=$1 ORDER BY created_at LIMIT 1',[f.runId])).rows[0];await pool.query("UPDATE local_operations SET status='started',merge_state='unknown' WHERE id=$1",[old.id]);await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[{...f.snapshot,approval:{acknowledgeUnknownOperations:true,reconciledOperations:[old.id]}},f.runId]);
 const before=readFileSync(join(root,f.runId,'events.jsonl')),operations=(await pool.query('SELECT * FROM local_operations ORDER BY id')).rows;
 assert.equal(readRun(root,f.runId)?.status,'completed');assert.equal((await api('/runs/'+f.runId+'/artifacts')).status,409);assert.equal((await fetch(url+'/runs/'+f.runId+'/artifact?path=out.txt')).status,409);assert.equal((await api('/work-files/from-run',{runId:f.runId,paths:['out.txt']})).status,409);assert.equal((await planning()).available,false);await assert.rejects(()=>acceptedWorkEvidence(pool,root,f.runId));assert.deepEqual(readFileSync(join(root,f.runId,'events.jsonl')),before);assert.deepEqual((await pool.query('SELECT * FROM local_operations ORDER BY id')).rows,operations);
});
test('a head cannot certify another or damaged original committed SQL operation',{skip:!isolated},async()=>{
 const original=await row(f.runId),id=original.canonical_workspace.mergeId,op=(await pool.query('SELECT * FROM local_operations WHERE id=$1',[id])).rows[0];
 for(const changed of [{...op.merge_record,operationId:randomUUID()},{...op.merge_record,after:{...op.merge_record.after,revision:hash('forged')}}]){await pool.query('UPDATE local_operations SET merge_record=$1 WHERE id=$2',[changed,id]);assert.equal((await api('/runs/'+f.runId+'/artifacts')).status,409);}
 await pool.query('UPDATE local_operations SET merge_record=$1 WHERE id=$2',[op.merge_record,id]);await pool.query('UPDATE project_runs SET canonical_workspace=$1 WHERE id=$2',[{...original.canonical_workspace,mergeId:null,receipt:null},f.runId]);assert.equal((await api('/runs/'+f.runId+'/artifacts')).status,409,'unsupported initializer source cannot masquerade as restored live evidence');
});
