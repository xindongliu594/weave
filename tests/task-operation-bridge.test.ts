import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import express from 'express';
import {gzipSync} from 'node:zlib';
import {nativeManifestId} from '../services/agent-runtime/native-capabilities.mjs';
import {setNativeCapability} from '../apps/api/src/native-capabilities.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';
import {LocalOperationService,LocalRunExecutor,localDeviceRouter} from '../apps/api/src/local-execution.ts';
import {readCommittedCanonical} from '../apps/api/src/task-canonical.ts';
import {assertExecutionProfile} from '../apps/api/src/execution-policy.ts';
import {pool,migrate} from '../apps/api/src/db.ts';
const {manifest,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex'),file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
const signal=new AbortController().signal;
let directory:string,server:any,url:string;
const employee={id:'employee',employeeId:'employee',modelId:'unused',tools:['filesystem','artifact_write','terminal','terminal_test'],name:'Fixture',role:'manager'};
before(async()=>{if(!isolated)return;assert.match(process.env.DATABASE_URL??'',/@127\.0\.0\.1:\d+\/postgres$/);directory=mkdtempSync(join(tmpdir(),'task-operation-bridge-'));process.env.DATA_DIR=directory;process.env.TRACE_ROOT=directory;process.env.OBSIDIAN_VAULT=join(directory,'vault');await migrate();await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'fixture',agents:[employee]}]);const app=express();app.use(express.json({limit:'32mb'}));app.use(localDeviceRouter(directory));app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status??500).json({code:e.code,message:e.message}));server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port;});
beforeEach(async()=>{if(isolated){await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,tool_approvals,native_capabilities CASCADE');await pool.query('UPDATE departments SET data=$1',[{name:'fixture',agents:[employee]}]);}});
afterEach(async()=>{if(isolated)for(const table of ['usage','model_reservations','models'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);});
after(async()=>{if(!isolated)return;if(server)await new Promise<void>(done=>{server.closeAllConnections();server.close(done);});await pool.end();assert.ok(directory.startsWith(join(tmpdir(),'task-operation-bridge-')));rmSync(directory,{recursive:true,force:true});});
async function fixture({bWritesInput=false,nativeTool=false}={}){
 const runId=randomUUID(),projectId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID(),owner=randomUUID(),token=randomBytes(32).toString('hex');
 const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')};
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:10,maxTaskModelCalls:5,deadlineSeconds:180,executionTarget:{kind:'local',deviceId,grantId,backend}};
 const tasks=['a','b'].map(id=>({id,assignee:'employee',inputs:[{path:'in.txt'}],outputs:[{path:id==='b'&&bWritesInput?'in.txt':id+'.txt'}],inScope:[id==='b'&&bWritesInput?'in.txt':id+'.txt'],outOfScope:[],dependencies:[]}));
 const snapshot:any={projectId,planVersion:1,departmentId:'department',executionProfile:'task-attempt-openshell-v1',policy,agents:[employee],tasks,executionTarget:{...policy.executionTarget,platform:'linux',allowCommands:true},importedFiles:[{path:'in.txt',content:'input',snapshotId:'snapshot',sha256:sha('input'),agentIds:['employee']}]};
 if(nativeTool){
  process.env.LOCAL_WORKSPACE_ROOT=directory;
  const code=Buffer.from('engineering fixture only'),compressed=gzipSync(code),metadata=Buffer.from('{}'),hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
  const native={format:'dsh-native-tools-v1',namespace:'office',package:'@company/office',version:'1.0.0',source:{kind:'company',reference:'engineering fixture'},dshVersion:'0.1.5-rc.1',config:{},lockSha256:sha('lock'),bundle:{sha256:hash(compressed),codeSha256:hash(code),metadataSha256:hash(metadata),bytes:compressed.length},tools:[{name:'plugin__office__write',originalName:'write',description:'fixture',parameters:{type:'object'},files:{read:[],write:['path']}}]};
  const id=nativeManifestId(native),root=join(directory,'native-plugins',id);mkdirSync(root,{recursive:true});writeFileSync(join(root,'manifest.json'),JSON.stringify(native));writeFileSync(join(root,'bundle.gz'),compressed);writeFileSync(join(root,'package.json'),metadata);await setNativeCapability(id,true,pool);
  snapshot.nativeCapabilities=[{id,manifest:native}];snapshot.agents=[{...employee,tools:[...employee.tools,'plugin__office__write']}];await pool.query('UPDATE departments SET data=$1',[{name:'fixture',agents:snapshot.agents}]);
 }
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$3,$4,$5,$3)',[projectId,'department','fixture',policy,{agents:[employee],tasks}]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 await pool.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,$3,$4,$5,$3,true,$6)',[deviceId,sha(token),'fixture','linux',grantId,backend]);
 const archive=createRunArchive(directory,snapshot,{id:runId});mkdirSync(join(archive.dir,'artifacts'));writeFileSync(join(archive.dir,'artifacts/in.txt'),'input');writeFileSync(join(archive.dir,'artifacts/private.txt'),'private');
 const state={members:[{id:'session',name:'employee'}],tasks:tasks.map(t=>({id:'native-'+t.id,assignee:'employee',attemptId:'attempt-'+t.id,status:'in_progress'}))};
 archive.append('run/task-mapping',{tasks:tasks.map(t=>({task_id:'native-'+t.id,seed_id:t.id}))});archive.append('team/checkpoint',state);
 const storedSnapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;const service=new LocalOperationService(directory,owner),executor=new LocalRunExecutor(archive,storedSnapshot,service),workspaces=new Map<string,any>(),jobs:any[]=[];
 const f={runId,projectId,deviceId,grantId,token,backend,archive,snapshot:storedSnapshot,state,service,executor,workspaces,jobs};
 return f;
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const publicScope=(scope:any)=>({profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,workRevision:scope.workRevision});
const scopedArgs=(scope:any,args:any)=>({...args,expectedWorkspaceRevision:scope.workRevision,executionScope:publicScope(scope)});
async function request(f:Fixture,endpoint:string,body:any){const response=await fetch(url+'/local-devices/'+f.deviceId+endpoint,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':f.token},body:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};}
async function assignment(f:Fixture,id='a'){const bound=await f.executor.bindAttempt({runId:f.runId,taskId:id,attemptId:'attempt-'+id,agentId:'employee',sessionId:'session',runtimeTaskId:'native-'+id,contractHash:checkpointContract(f.snapshot,f.snapshot.tasks.find((t:any)=>t.id===id))},signal);return {agentId:bound.agentId,sessionId:bound.sessionId,taskId:bound.taskId,attemptId:bound.attemptId,generation:bound.generation};}
// An engineering device fixture exercises the real HTTP claim/start/result path.
// Physical OpenShell policy and process isolation remain the separate JJ gate.
async function deliver(f:Fixture,job:any){
 assert.equal(JSON.stringify(job).includes('private.txt'),false,'poll never exposes a private canonical path');assert.equal(job.taskScope,undefined);assert.equal(job.deviceArguments,undefined);
 assert.equal((await request(f,'/operations/'+job.id+'/start',{claimToken:job.claimToken})).status,200);
 const key=JSON.stringify(job.executionScope.key);let work=f.workspaces.get(key);
 if(job.name==='prepare'){assert.equal(work,undefined,'prepare is exactly once');work={files:job.files,sandboxId:randomUUID()};f.workspaces.set(key,work);}else{assert.ok(work);assert.equal(revision(work.files),job.executionScope.expectedWorkRevision);}
 if(job.arguments.expectedWorkspaceRevision)assert.equal(job.arguments.expectedWorkspaceRevision,revision(work.files),'transport uses partial revision');
 if(job.name==='artifact_write')work.files=[...work.files.filter((v:any)=>v.path!==job.arguments.path),file(job.arguments.path,job.arguments.content)];
 if(job.name==='native_plugin')work.files=[...work.files.filter((v:any)=>v.path!==job.arguments.arguments.path),file(job.arguments.arguments.path,job.arguments.arguments.content)];
 const args=job.arguments,files=work.files,result:any={localWorkspace:'openshell://fixture/'+work.sandboxId+'/sandbox',files,artifacts:manifest(files),workspaceRevision:revision(files),execution:{...f.backend,sandboxId:work.sandboxId,sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:job.executionScope.profile,key:job.executionScope.key,scopeHash:job.executionScope.scopeHash,operationId:job.id,beforeWorkRevision:job.executionScope.expectedWorkRevision,afterWorkRevision:revision(files)}};
 if(job.name==='artifact_write')Object.assign(result,{path:args.path,bytes:Buffer.byteLength(args.content),sha256:sha(args.content)});
 if(job.name==='filesystem')Object.assign(result,{path:args.path,content:Buffer.from(files.find((v:any)=>v.path===args.path).content,'base64').toString(),sha256:sha(Buffer.from(files.find((v:any)=>v.path===args.path).content,'base64').toString())});
 if(['terminal','terminal_test'].includes(job.name))Object.assign(result,{exitCode:0,output:'fixture command'});
 if(job.name==='native_plugin')Object.assign(result,{pluginId:args.pluginId,toolName:args.toolName,nativeResult:{isError:false,value:{written:true}}});
 assert.equal((await request(f,'/operations/'+job.id+'/result',{claimToken:job.claimToken,ok:true,result})).status,200);f.jobs.push(job);
}
async function drive<T>(f:Fixture,promise:Promise<T>):Promise<T>{let done=false,error:any,value:T;promise.then(v=>{done=true;value=v;},e=>{done=true;error=e;});const deadline=Date.now()+15000;while(!done&&Date.now()<deadline){const poll=await request(f,'/poll',{});assert.equal(poll.status,200,JSON.stringify(poll.data));if(poll.data.job)await deliver(f,poll.data.job);else await new Promise(r=>setTimeout(r,10));}assert.ok(done,'operation settles');if(error)throw error;return value!;}
async function prepared(f:Fixture,id='a'){const context=await assignment(f,id),scope=await drive(f,f.executor.prepareTask(context,signal));return {context,scope};}
async function write(f:Fixture,context:any,scope:any,text:string){return drive(f,f.executor.execute('artifact_write',scopedArgs(scope,{path:context.taskId+'.txt',content:text}),signal,{...context,executionScope:publicScope(scope),callId:randomUUID()}));}
const run=async(f:Fixture)=>(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.runId])).rows[0];

test('two consecutive task writes roll scope and preserve original input lineage',{skip:!isolated},async()=>{
 const f=await fixture();assert.throws(()=>assertExecutionProfile(f.snapshot),{code:'TASK_EXECUTION_UNAVAILABLE'});
 const first=await prepared(f),one=await write(f,first.context,first.scope,'one');const second=await prepared(f),two=await write(f,second.context,second.scope,'two');
 assert.notEqual(first.scope.workspace.scopeHash,second.scope.workspace.scopeHash);assert.deepEqual(first.scope.inputOrigins,second.scope.inputOrigins);assert.equal(second.scope.inputOrigins[0].origin.acceptedRevision,first.scope.inputOrigins[0].origin.acceptedRevision);assert.equal(two.merge.beforeRevision,one.merge.afterRevision);assert.equal(one.execution.sandboxId,two.execution.sandboxId);
 assert.equal(f.jobs.filter(j=>j.name==='prepare').length,1);assert.deepEqual(readCommittedCanonical(directory,await run(f)).files,[file('a.txt','two'),file('in.txt','input'),file('private.txt','private')]);assert.ok(!JSON.stringify(two).includes('private.txt'));assert.notEqual(two.taskExecution.afterWorkRevision,two.merge.afterRevision);
 const reopened=new LocalRunExecutor(f.archive,f.snapshot,f.service);await reopened.prepareTask(second.context,signal);assert.equal(f.jobs.filter(j=>j.name==='prepare').length,1);
});
test('file operations preserve canonical arguments and transport only the visible revision',{skip:!isolated},async()=>{
 const f=await fixture();let a=await prepared(f);
 assert.notEqual(a.scope.workRevision,revision(a.scope.workspace.importedFiles),'private canonical file separates both revision domains');
 for(const [name,business] of [['filesystem',{path:'in.txt'}],['artifact_write',{path:'a.txt',content:'scoped file'}]] as const){
  const args=scopedArgs(a.scope,business),context={...a.context,executionScope:publicScope(a.scope),callId:randomUUID()};
  await drive(f,f.executor.execute(name,args,signal,context));const job=f.jobs.at(-1);
  assert.equal(job.arguments.expectedWorkspaceRevision,revision(a.scope.workspace.importedFiles));assert.notEqual(job.arguments.expectedWorkspaceRevision,args.expectedWorkspaceRevision);
  const stored=(await pool.query('SELECT payload FROM local_operations WHERE id=$1',[job.id])).rows[0].payload;assert.deepEqual(stored.arguments,args);assert.equal(stored.deviceArguments.expectedWorkspaceRevision,job.arguments.expectedWorkspaceRevision);
  a=await prepared(f);
  for(const bad of [{...scopedArgs(a.scope,business),expectedWorkspaceRevision:sha('stale')},{...scopedArgs(a.scope,business),executionScope:undefined}])await assert.rejects(()=>f.executor.execute(name,bad,signal,{...a.context,executionScope:publicScope(a.scope),callId:randomUUID()}),{code:'TASK_SCOPE_DENIED'});
 }
 assert.deepEqual(readCommittedCanonical(directory,await run(f)).files,[file('a.txt','scoped file'),file('in.txt','input'),file('private.txt','private')]);
});
test('unrelated task commit rebuilds next scope without rebinding inputs',{skip:!isolated},async()=>{
 const f=await fixture(),a=await prepared(f);await write(f,a.context,a.scope,'one');const b=await prepared(f,'b');await write(f,b.context,b.scope,'B');const next=await prepared(f);assert.deepEqual(next.scope.inputOrigins,a.scope.inputOrigins);assert.notEqual(next.scope.workRevision,a.scope.workRevision);await write(f,next.context,next.scope,'two');assert.ok(readCommittedCanonical(directory,await run(f)).files.some(v=>v.path==='b.txt'&&v.content===file('b.txt','B').content));
});
test('another task changing a fixed input blocks scope renewal',{skip:!isolated},async()=>{
 const f=await fixture({bWritesInput:true}),a=await prepared(f),b=await prepared(f,'b');
 await drive(f,f.executor.execute('artifact_write',scopedArgs(b.scope,{path:'in.txt',content:'changed by B'}),signal,{...b.context,executionScope:publicScope(b.scope),callId:randomUUID()}));
 const count=f.jobs.length;await assert.rejects(()=>f.executor.prepareTask(a.context,signal),{code:'TASK_SCOPE_DENIED'});assert.equal(f.jobs.length,count);assert.deepEqual(readCommittedCanonical(directory,await run(f)).files,[file('in.txt','changed by B'),file('private.txt','private')]);
});
test('approval cannot authorize a renewed scope',{skip:!isolated},async()=>{
 const f=await fixture(),a=await prepared(f),approvalId=randomUUID(),args={command:'node -e "0"',expectedWorkspaceRevision:a.scope.workRevision,executionScope:publicScope(a.scope)};
 await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,'terminal',$4,'approved')",[approvalId,f.runId,'employee',args]);
 const b=await prepared(f,'b');await write(f,b.context,b.scope,'B');await prepared(f);const count=f.jobs.length;
 await assert.rejects(()=>f.executor.execute('terminal',args,signal,{...a.context,executionScope:publicScope(a.scope),approvalId,callId:randomUUID()}));assert.equal(f.jobs.length,count);assert.equal((await pool.query("SELECT id FROM local_operations WHERE payload->>'name'='terminal'")).rowCount,0);
 const next=await prepared(f),renewed={...args,expectedWorkspaceRevision:next.scope.workRevision,executionScope:publicScope(next.scope)},renewedId=randomUUID();await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,'terminal',$4,'approved')",[renewedId,f.runId,'employee',renewed]);
 await drive(f,f.executor.execute('terminal',renewed,signal,{...next.context,executionScope:publicScope(next.scope),approvalId:renewedId,callId:randomUUID()}));const stored=(await pool.query("SELECT payload FROM local_operations WHERE payload->>'name'='terminal'")).rows[0].payload;assert.deepEqual(stored.arguments,renewed);assert.notEqual(stored.deviceArguments.expectedWorkspaceRevision,renewed.expectedWorkspaceRevision);
});
test('missing generation, widened private scope and cancelled lease are refused before queue',{skip:!isolated},async()=>{
 const f=await fixture(),a=await prepared(f),count=f.jobs.length;
 for(const context of [{...a.context,generation:undefined},{...a.context,executionScope:{...publicScope(a.scope),readPaths:['private.txt']}}])await assert.rejects(()=>f.executor.execute('artifact_write',{path:'a.txt',content:'forged'},signal,{...context,callId:randomUUID()}));
 await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[f.runId]);await assert.rejects(()=>f.executor.execute('artifact_write',{path:'a.txt',content:'forged'},signal,{...a.context,executionScope:publicScope(a.scope),callId:randomUUID()}));assert.equal(f.jobs.length,count);
});
test('unknown prepare cannot be replayed or bypassed by a new generation',{skip:!isolated},async()=>{
 const f=await fixture(),context=await assignment(f);let settled=false;const preparing=f.executor.prepareTask(context,signal);preparing.catch(()=>{settled=true;});let job:any;const deadline=Date.now()+15000;
 while(!job&&Date.now()<deadline){const reply=await request(f,'/poll',{});job=reply.data.job;if(!job)await new Promise(r=>setTimeout(r,10));}
 assert.ok(job);assert.equal((await request(f,'/operations/'+job.id+'/start',{claimToken:job.claimToken})).status,200);assert.equal((await request(f,'/operations/'+job.id+'/result',{claimToken:job.claimToken,ok:false,error:{code:'LOCAL_OUTCOME_UNKNOWN',message:'lost prepare receipt',notExecuted:true}})).status,200);
 await assert.rejects(()=>preparing);assert.ok(settled);await assert.rejects(()=>(new LocalRunExecutor(f.archive,f.snapshot,f.service)).prepareTask(context,signal));
 f.state.tasks[0].attemptId='replacement';f.archive.append('team/checkpoint',f.state);await assert.rejects(()=>f.executor.bindAttempt({runId:f.runId,taskId:'a',attemptId:'replacement',agentId:'employee',sessionId:'session',runtimeTaskId:'native-a',contractHash:checkpointContract(f.snapshot,f.snapshot.tasks[0])},signal));assert.equal((await pool.query('SELECT id FROM local_operations')).rowCount,1);
});
test('a task cannot accept a successful receipt from another sandbox',{skip:!isolated},async()=>{
 const f=await fixture(),a=await prepared(f);
 const id=await f.service.enqueue(f.runId,'terminal',{command:'fixture',expectedWorkspaceRevision:a.scope.workRevision,executionScope:publicScope(a.scope)},{...a.context,callId:randomUUID(),executionScope:publicScope(a.scope),approvalId:await approval(f,a.scope)},undefined,signal);
 const job=(await request(f,'/poll',{})).data.job;assert.equal(job.id,id);assert.equal((await request(f,'/operations/'+id+'/start',{claimToken:job.claimToken})).status,200);
 const files=a.scope.workspace.importedFiles,result={localWorkspace:'openshell://fixture/'+randomUUID()+'/sandbox',files,artifacts:manifest(files),workspaceRevision:revision(files),exitCode:0,output:'fixture',execution:{...f.backend,sandboxId:randomUUID(),sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:a.scope.profile,key:a.scope.key,scopeHash:a.scope.workspace.scopeHash,operationId:id,beforeWorkRevision:revision(files),afterWorkRevision:revision(files)}};
 const rejected=await request(f,'/operations/'+id+'/result',{claimToken:job.claimToken,ok:true,result});assert.equal(rejected.status,409);assert.equal((await pool.query('SELECT result FROM local_operations WHERE id=$1',[id])).rows[0].result,null);
});
async function approval(f:Fixture,scope:any){const id=randomUUID(),args={command:'fixture',expectedWorkspaceRevision:scope.workRevision,executionScope:publicScope(scope)};await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,'terminal',$4,'approved')",[id,f.runId,'employee',args]);return id;}
test('queued task state is rechecked by poll and start',{skip:!isolated},async()=>{
 for(const stage of ['poll','start']){
  const f=await fixture(),a=await prepared(f),id=await f.service.enqueue(f.runId,'artifact_write',scopedArgs(a.scope,{path:'a.txt',content:'queued'}),{...a.context,callId:randomUUID(),executionScope:publicScope(a.scope)},undefined,signal);
  const job=stage==='start'?(await request(f,'/poll',{})).data.job:null;
  f.state.tasks[0].attemptId='withdrawn';f.archive.append('team/checkpoint',f.state);
  if(stage==='poll')assert.equal((await request(f,'/poll',{})).data.job,null);
  else assert.equal((await request(f,'/operations/'+id+'/start',{claimToken:job.claimToken})).status,409);
  assert.equal((await pool.query('SELECT started FROM local_operations WHERE id=$1',[id])).rows[0].started,false);
 }
});
test('a late authenticated receipt after withdrawal stays evidence and cannot merge',{skip:!isolated},async()=>{
 const f=await fixture(),a=await prepared(f),id=await f.service.enqueue(f.runId,'artifact_write',scopedArgs(a.scope,{path:'a.txt',content:'late'}),{...a.context,callId:randomUUID(),executionScope:publicScope(a.scope)},undefined,signal),job=(await request(f,'/poll',{})).data.job;
 assert.equal((await request(f,'/operations/'+id+'/start',{claimToken:job.claimToken})).status,200);
 await pool.query('UPDATE project_runs SET lease_until=now()-interval \'1 minute\' WHERE id=$1',[f.runId]);
 const work=f.workspaces.get(JSON.stringify(a.scope.key)),files=[...work.files,file('a.txt','late')],result={localWorkspace:'openshell://fixture/'+work.sandboxId+'/sandbox',path:'a.txt',bytes:4,sha256:sha('late'),files,artifacts:manifest(files),workspaceRevision:revision(files),execution:{...f.backend,sandboxId:work.sandboxId,sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:a.scope.profile,key:a.scope.key,scopeHash:a.scope.workspace.scopeHash,operationId:id,beforeWorkRevision:revision(work.files),afterWorkRevision:revision(files)}};
 assert.equal((await request(f,'/operations/'+id+'/result',{claimToken:job.claimToken,ok:true,result})).status,200);const row=(await pool.query('SELECT * FROM local_operations WHERE id=$1',[id])).rows[0];assert.equal(row.result,null);assert.equal(row.late_result.ok,true);assert.equal(row.status,'cancelled');await assert.rejects(()=>f.service.wait(id,signal),{notExecuted:false});assert.equal(readCommittedCanonical(directory,await run(f)).files.some(v=>v.path==='a.txt'),false);
});
test('native dispatch derives effective paths and fixed bundle from the trusted scope',{skip:!isolated},async()=>{
 const f=await fixture({nativeTool:true}),a=await prepared(f),args={toolName:'plugin__office__write',arguments:{path:'a.txt',content:'native output'},expectedWorkspaceRevision:a.scope.workRevision,executionScope:publicScope(a.scope)},context={...a.context,callId:randomUUID(),executionScope:publicScope(a.scope)};
 await assert.rejects(()=>f.executor.execute('native_plugin',{...args,readPaths:['private.txt']},signal,context),{code:'TASK_SCOPE_DENIED'});
 await assert.rejects(()=>f.executor.execute('native_plugin',{...args,arguments:{path:'private.txt',content:'denied'}},signal,context),{code:'NATIVE_PATH_DENIED'});
 const result=await drive(f,f.executor.execute('native_plugin',args,signal,context));assert.equal(result.pluginId,f.snapshot.nativeCapabilities[0].id);assert.equal(result.nativeResult.isError,false);const job=f.jobs.at(-1);assert.deepEqual(job.arguments.readPaths,['in.txt']);assert.deepEqual(job.arguments.writePaths,['a.txt']);assert.equal(job.arguments.pluginId,f.snapshot.nativeCapabilities[0].id);
 const stored=(await pool.query("SELECT payload FROM local_operations WHERE payload->>'name'='native_plugin'")).rows[0].payload;assert.deepEqual(stored.arguments,args);assert.deepEqual(readCommittedCanonical(directory,await run(f)).files,[file('a.txt','native output'),file('in.txt','input'),file('private.txt','private')]);
 const renewed=await prepared(f),count=f.jobs.length;writeFileSync(join(directory,'native-plugins',f.snapshot.nativeCapabilities[0].id,'bundle.gz'),'damaged bundle');await assert.rejects(()=>f.executor.execute('native_plugin',{...args,expectedWorkspaceRevision:renewed.scope.workRevision,executionScope:publicScope(renewed.scope)},signal,{...context,executionScope:publicScope(renewed.scope)}));assert.equal(f.jobs.length,count);
});
