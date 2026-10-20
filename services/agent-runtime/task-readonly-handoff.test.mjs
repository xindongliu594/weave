import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createTeamHost} from './host.mjs';
import {createRunArchive,readRun} from './trace-store.mjs';
import {stageApprovedTeam,teamTaskPlan} from './handoff.mjs';
import {Semaphore} from './limits.mjs';
const {createTaskWorkspace}=createRequire(import.meta.url)('../../apps/desktop/task-workspace.cjs');
const sha='a'.repeat(64),profile='task-attempt-openshell-v1';

// Fixed model/scope fixtures exercise the real Host and AgentTeams protocol, not OpenShell.
for(const mode of ['success','cycle-hold','cycle-reject','accepted-hold','accepted-reject'])test('task Host private checkpoint barrier '+mode,{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'task-readonly-host-')),artifacts=join(root,'artifacts');await mkdir(artifacts);
 const task={id:'read',kind:'work',subject:'Read approved knowledge only',assignee:'reader',dependencies:[],inputs:[],outputs:[],inScope:[],outOfScope:[],verify:[]};
 const snapshot={executionProfile:profile,policy:{contextManagement:'prune'},tasks:[task],agents:[{id:'manager',role:'manager',modelId:'manager',tools:[]},{id:'reader',role:'member',modelId:'reader',tools:['knowledge_search']}],knowledge:{reader:[]}};
 const archive=createRunArchive(root,snapshot),steps=new Map(),results=[];let host,prepared=0,bound=0,completionProduced=false,barrierUsed=false;const entered=Promise.withResolvers(),barrier=Promise.withResolvers();
 const sandbox={root:artifacts,bindAttempt:async candidate=>{bound++;return{...candidate,generation:1};},prepareTask:async context=>{
  prepared++;
  const key={runId:archive.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation};
  const workspace=createTaskWorkspace({binding:{projectId:'fixture',planVersion:1,...key,assigneeId:'reader',contractHash:sha,permissionHash:sha,backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}},readPaths:[],writePaths:[],canonicalFiles:[],origins:[]});
  return{profile,key,workspace,workRevision:workspace.baseCanonicalRevision,capabilityHash:sha,inputOrigins:[]};
 },prepareCheckpoint:async(context,signal,{phase})=>{
  const acceptance=mode.startsWith('accepted')&&completionProduced,cycle=mode.startsWith('cycle')&&!completionProduced&&[...steps.values()].some(n=>n>0);
  if(!barrierUsed&&(acceptance||cycle)){barrierUsed=true;entered.resolve();await barrier.promise;}
  return {profile,key:{runId:archive.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation},inputManifest:[],inputOrigins:[],workManifest:[],canonical:{revision:"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",manifest:[],mergeId:null},lastMerge:null,scopeHash:sha,capabilityHash:sha};}};
 const adapter=new class extends LlmAdapter{
  async *stream(options){
   if(options.model==='reader'){
    const {runtimeTaskId,attemptId}=this.attribution(options.sessionId),step=steps.get(options.sessionId)??0;steps.set(options.sessionId,step+1);
    const actions=[['agent_teams_update_task',{task_id:runtimeTaskId,attempt_id:attemptId,status:'in_progress'}],['knowledge_search',{query:'reference'}],['agent_teams_update_task',{task_id:runtimeTaskId,attempt_id:attemptId,status:'completed',output:'Reviewed approved knowledge; no file output is required.'}]];
    if(step===2)completionProduced=true;
    if(step<actions.length){const [name,args]=actions[step];yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)}};yield{type:'finish',reason:{kind:'tool-calls'}};return;}
   }
   yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'fixture stop'}};yield{type:'finish',reason:{kind:'stop'}};
  }
 }();
 try{
  host=await createTeamHost({adapter,provider:'fixture',archive,sessionRoot:join(root,'sessions'),product:{snapshot,sandbox,gate:new Semaphore(1)}});
  host.ctx.on('tools/result',(exec,result)=>results.push({name:exec.name,args:exec.arguments,result}));
  const captain=await host.captain({cwd:root,model:'manager'}),created=await stageApprovedTeam(host,captain,{name:'task-readonly-host',members:[{name:'reader',provider:'fixture',model:'reader'}],tasks:teamTaskPlan([task])});
  host.bindTaskMapping(created.tasks,created.team_id);await host.call(captain,'agent_teams_approve',{confirmation:'Disposable knowledge-only Host fixture'});host.lockPlan();
  if(mode!=='success'){
   await Promise.race([entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('checkpoint barrier not reached')),5000))]);
   const count=[...steps.values()].reduce((a,b)=>a+b,0);await new Promise(setImmediate);assert.equal([...steps.values()].reduce((a,b)=>a+b,0),count,'no next model while private refs are pending');
   assert.equal(readRun(root,archive.id).events.filter(e=>e.type==='handoff/accepted').length,0,'no accepted publication while refs pending');
   if(mode.endsWith('reject')){barrier.reject(Error('PRIVATE_CHECKPOINT_REJECTED'));await host.ctx.agents.get([...steps.keys()][0]).whenIdle();assert.equal([...steps.values()].reduce((a,b)=>a+b,0),count);assert.equal(readRun(root,archive.id).events.filter(e=>e.type==='handoff/accepted').length,0);return;}
   barrier.resolve();
  }
  const deadline=Date.now()+5000;
  while(Date.now()<deadline&&!results.some(r=>r.name==='agent_teams_update_task'&&r.args.status==='completed')){await host.call(captain,'agent_teams_status');await new Promise(resolve=>setTimeout(resolve,10));}
  const completed=results.find(r=>r.name==='agent_teams_update_task'&&r.args.status==='completed');
  assert.ok(bound>0,'trusted attempt registration must precede the completion');
  assert.ok(results.some(r=>r.name==='knowledge_search'&&!r.result.isError),'authorized knowledge call succeeds');
  assert.ok(completed,'completion call reached the actual Host');
  assert.equal(completed.result.isError,false,JSON.stringify(completed.result.error));
  assert.ok(prepared>=1,'cycle and completion prepare private refs without a file or terminal command');
  const accepted=readRun(root,archive.id).events.filter(e=>e.type==='handoff/accepted');
  const checkpoints=readRun(root,archive.id).events.filter(e=>e.type==='step/checkpoint'&&e.data.boundary.trigger==='node-accepted');
  assert.equal(checkpoints.length,1);assert.equal(checkpoints[0].data.version,2);assert.deepEqual(checkpoints[0].data.files,[]);
  assert.equal(accepted.length,1);assert.equal(accepted[0].data.taskExecution.key.generation,1);
  assert.equal(accepted[0].data.taskExecution.key.runId,archive.id);assert.deepEqual(accepted[0].data.outputs,[]);
 }finally{barrier.resolve();await host?.close();await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

for(const faultType of ['step/boundary','step/checkpoint'])test('synchronous node-accepted '+faultType+' failure stops actual dependent Host dispatch',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'task-sync-publication-')),artifacts=join(root,'artifacts');await mkdir(artifacts);
 const task=(id,assignee,dependencies)=>({id,kind:'work',subject:'Approved knowledge '+id,assignee,dependencies,inputs:[],outputs:[],inScope:[],outOfScope:[],verify:[]});
 const tasks=[task('a','reader',[]),task('b','follower',['a'])],snapshot={executionProfile:profile,policy:{contextManagement:'prune'},tasks,agents:[{id:'manager',role:'manager',modelId:'manager',tools:[]},...['reader','follower'].map(id=>({id,role:'member',modelId:id,tools:['knowledge_search']}))],knowledge:{reader:[],follower:[]}};
 const archive=createRunArchive(root,snapshot),append=archive.append.bind(archive),fault=Promise.withResolvers(),steps=new Map(),modelCalls=[],bindings=[],prepares=[],checkpointPrepares=[],transports=[],fatalNotices=[];let host,faulted=false;
 archive.append=(type,data,...args)=>{if(!faulted&&type===faultType&&data?.boundary?.trigger==='node-accepted'&&data.boundary.taskId==='a'||!faulted&&type===faultType&&type==='step/boundary'&&data?.trigger==='node-accepted'&&data.taskId==='a'){faulted=true;fault.resolve();throw Error('SYNC_PUBLICATION_FAILURE');}return append(type,data,...args);};
 const sandbox={root:artifacts,bindAttempt:async candidate=>{bindings.push(candidate.taskId);return{...candidate,generation:1};},prepareTask:async context=>{
  prepares.push(context.taskId);const key={runId:archive.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation},workspace=createTaskWorkspace({binding:{projectId:'fixture',planVersion:1,...key,assigneeId:tasks.find(t=>t.id===context.taskId).assignee,contractHash:sha,permissionHash:sha,backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}},readPaths:[],writePaths:[],canonicalFiles:[],origins:[]});
  return{profile,key,workspace,workRevision:workspace.baseCanonicalRevision,capabilityHash:sha,inputOrigins:[]};
 },prepareCheckpoint:async context=>{checkpointPrepares.push(context.taskId);return{profile,key:{runId:archive.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation},inputManifest:[],inputOrigins:[],workManifest:[],canonical:{revision:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',manifest:[],mergeId:null},lastMerge:null,scopeHash:sha,capabilityHash:sha};},execute:async()=>{transports.push('unexpected');throw Error('NO_SANDBOX_TOOL_EXPECTED');}};
 const adapter=new class extends LlmAdapter{async *stream(options){
  if(['reader','follower'].includes(options.model)){
   const {taskId,runtimeTaskId,attemptId}=this.attribution(options.sessionId);modelCalls.push(taskId);const step=steps.get(options.sessionId)??0;steps.set(options.sessionId,step+1);
   const actions=[['agent_teams_update_task',{task_id:runtimeTaskId,attempt_id:attemptId,status:'in_progress'}],['agent_teams_update_task',{task_id:runtimeTaskId,attempt_id:attemptId,status:'completed',output:'Approved knowledge reviewed.'}]];
   if(step<actions.length){const[name,args]=actions[step];yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)}};yield{type:'finish',reason:{kind:'tool-calls'}};return;}
  }
  yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'fixture stop'}};yield{type:'finish',reason:{kind:'stop'}};
 }}();
 try{
  host=await createTeamHost({adapter,provider:'fixture',archive,sessionRoot:join(root,'sessions'),product:{snapshot,sandbox,gate:new Semaphore(1),onHandoffBlocked:error=>fatalNotices.push(error)}});
  const captain=await host.captain({cwd:root,model:'manager'}),created=await stageApprovedTeam(host,captain,{name:'sync-publication-failure',members:['reader','follower'].map(name=>({name,provider:'fixture',model:name})),tasks:teamTaskPlan(tasks)});
  host.bindTaskMapping(created.tasks,created.team_id);await host.call(captain,'agent_teams_approve',{confirmation:'Disposable synchronous publication fixture'});host.lockPlan();
  await Promise.race([fault.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('synchronous checkpoint fault not reached')),5000))]);
  await new Promise(setImmediate);await Promise.all(host.employeeHosts().map(slot=>slot.agent?.whenIdle()));
  assert.equal(fatalNotices.length,1,'fatal publication reaches the Product runtime failure callback without another request');
  assert.match(fatalNotices[0].message,/TASK_CHECKPOINT_PUBLICATION_FAILED/);
  const state=host.checkpointState(),aId=created.tasks.find(t=>t.seed_id==='a').task_id;
  assert.equal(state.tasks.find(t=>t.id===aId).status,'completed','native completion remains truthful historical evidence');
  const events=readRun(root,archive.id).events;
  assert.equal(events.filter(e=>e.type==='handoff/accepted'&&e.data.taskId==='a').length,1,'already appended acceptance history is preserved');
  assert.equal(events.filter(e=>e.type==='step/checkpoint'&&e.data.boundary.trigger==='node-accepted'&&e.data.boundary.taskId==='a').length,0);
  assert.equal(modelCalls.filter(id=>id==='b').length,0,'dependent model cannot use an uncertain publication');
  assert.equal(bindings.filter(id=>id==='b').length,0,'dependent native assignment preparation remains fenced');
  assert.equal(prepares.filter(id=>id==='b').length,0);assert.equal(checkpointPrepares.filter(id=>id==='b').length,0);assert.deepEqual(transports,[]);
  await assert.rejects(()=>host.verifyDeliverable(AbortSignal.timeout(2000)),/CHECKPOINT_PUBLICATION|SYNC_PUBLICATION/);
  await assert.rejects(()=>host.call(captain,'agent_teams_status'),/CHECKPOINT_PUBLICATION|SYNC_PUBLICATION/);
 }finally{await host?.close();await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('actual Product marks last native completed node failed when its synchronous checkpoint cannot publish',{timeout:15000},async()=>{
 const {default:http}=await import('node:http'),{once}=await import('node:events'),{ProductDshRuntime}=await import('./product-runtime.mjs');
 const root=await mkdtemp(join(tmpdir(),'task-last-publication-')),runId=randomUUID(),requests=[];let step=0,injected=false,closed=false,runtime;
 const server=http.createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests.push({model:body.model,afterFailure:injected});let message={content:'Fixture coordinator.'};
  if(body.model==='worker-fixture'){
   const combined=body.messages.map(row=>typeof row.content==='string'?row.content:JSON.stringify(row.content)).join('\n'),attempt=/"attemptId":"([a-f0-9-]+)"/.exec(combined)?.[1]??/Attempt id: ([a-f0-9-]+)/.exec(combined)?.[1];
   const actions=[['agent_teams_claim_task',{task_id:'t1'}],['agent_teams_update_task',{task_id:'t1',attempt_id:attempt,status:'in_progress'}],['agent_teams_update_task',{task_id:'t1',attempt_id:attempt,status:'completed',output:'Approved final knowledge task complete.'}]];
   if(step<actions.length){const[name,args]=actions[step++];message={content:null,tool_calls:[{id:'call-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]};}else message={content:'No further model request is required.'};
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:1}}));
 });
 const task={id:'last',kind:'work',subject:'Final knowledge task',objective:'Complete without a file command',assignee:'worker',assigneeId:'worker',dependencies:[],inputs:[],outputs:[],inScope:[],outOfScope:[],verify:[],acceptanceCriteria:[]};
 const snapshot={projectId:'isolated-last-checkpoint',planVersion:1,requirement:'Isolated runtime terminal failure fixture',executionProfile:profile,executionTarget:{kind:'local',backend:{kind:'openshell'}},executionBudget:1,approval:{kind:'project',projectVersion:1},policy:{maxBudget:1,maxConcurrentAgents:2,deadlineSeconds:10,contextManagement:'prune',maxModelCalls:12,maxTaskModelCalls:6,allowedTools:[]},agents:[{id:'manager',employeeId:'manager',role:'manager',modelId:'manager-fixture',rolePrompt:'Coordinate approved tasks.',tools:[]},{id:'worker',employeeId:'worker',role:'member',modelId:'worker-fixture',rolePrompt:'Complete the assigned approved knowledge task.',tools:[]}],tasks:[task]};
 try{
  runtime=new ProductDshRuntime({traceRoot:root,beforeRequest:async()=>{},createExecutor:archive=>{
   const append=archive.append.bind(archive),artifacts=join(archive.dir,'artifacts');archive.append=(type,data,...args)=>{if(!injected&&type==='step/checkpoint'&&data?.boundary?.trigger==='node-accepted'){injected=true;throw Error('LAST_NODE_SYNC_PUBLICATION_FAILURE');}return append(type,data,...args);};
   return{root:artifacts,prepare:async()=>{await mkdir(artifacts,{recursive:true});},bindAttempt:async candidate=>({...candidate,generation:1}),prepareTask:async context=>{
    const key={runId:archive.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation},workspace=createTaskWorkspace({binding:{projectId:snapshot.projectId,planVersion:1,...key,assigneeId:'worker',contractHash:sha,permissionHash:sha,backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}},readPaths:[],writePaths:[],canonicalFiles:[],origins:[]});return{profile,key,workspace,workRevision:workspace.baseCanonicalRevision,capabilityHash:sha,inputOrigins:[]};
   },prepareCheckpoint:async context=>({profile,key:{runId:archive.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation},inputManifest:[],inputOrigins:[],workManifest:[],canonical:{revision:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',manifest:[],mergeId:null},lastMerge:null,scopeHash:sha,capabilityHash:sha}),execute:async()=>{throw Error('NO_SANDBOX_COMMAND_EXPECTED');},finalizeAccepted:async()=>{throw Error('FINALIZER_MUST_NOT_RUN_AFTER_FAILED_CHECKPOINT');},close:async()=>{closed=true;}};
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const started=await runtime.start({runId,approvedSnapshot:snapshot,routes:['manager-fixture','worker-fixture'].map(model=>({id:model,name:model,wireModel:model,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,inputRate:1,outputRate:2,maxOutputTokens:512}))});
  const result=await started.completion,run=readRun(root,runId);assert.equal(injected,true,result.message);assert.equal(closed,true);assert.equal(result.status,'failed',result.message);assert.match(result.message,/TASK_CHECKPOINT_PUBLICATION_FAILED.*LAST_NODE_SYNC_PUBLICATION_FAILURE/);
  assert.equal(run.events.findLast(event=>event.type==='run/finished').data.status,'failed');
  assert.equal(run.events.filter(event=>event.type==='run/finished'&&event.data.status==='completed').length,0);
  assert.ok(run.events.filter(event=>event.type==='team/checkpoint').some(event=>event.data.tasks?.every(row=>row.status==='completed')),'all completed native nodes remain historical facts');
  assert.equal(run.events.filter(event=>event.type==='handoff/accepted').length,1);assert.equal(run.events.filter(event=>event.type==='step/checkpoint'&&event.data.boundary.trigger==='node-accepted').length,0);
  assert.equal(requests.filter(row=>row.afterFailure).length,0,'publication failure immediately closes model admission');
 }finally{await runtime?.cancel(runId);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
