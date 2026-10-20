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
test('task Host prepares and accepts a knowledge-only task at its completion boundary',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'task-readonly-host-')),artifacts=join(root,'artifacts');await mkdir(artifacts);
 const task={id:'read',kind:'work',subject:'Read approved knowledge only',assignee:'reader',dependencies:[],inputs:[],outputs:[],inScope:[],outOfScope:[],verify:[]};
 const snapshot={executionProfile:profile,policy:{contextManagement:'prune'},tasks:[task],agents:[{id:'manager',role:'manager',modelId:'manager',tools:[]},{id:'reader',role:'member',modelId:'reader',tools:['knowledge_search']}],knowledge:{reader:[]}};
 const archive=createRunArchive(root,snapshot),steps=new Map(),results=[];let host,prepared=0,bound=0;
 const sandbox={root:artifacts,bindAttempt:async candidate=>{bound++;return{...candidate,generation:1};},prepareTask:async context=>{
  prepared++;
  const key={runId:archive.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation};
  const workspace=createTaskWorkspace({binding:{projectId:'fixture',planVersion:1,...key,assigneeId:'reader',contractHash:sha,permissionHash:sha,backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}},readPaths:[],writePaths:[],canonicalFiles:[],origins:[]});
  return{profile,key,workspace,workRevision:workspace.baseCanonicalRevision,capabilityHash:sha,inputOrigins:[]};
 }};
 const adapter=new class extends LlmAdapter{
  async *stream(options){
   if(options.model==='reader'){
    const {runtimeTaskId,attemptId}=this.attribution(options.sessionId),step=steps.get(options.sessionId)??0;steps.set(options.sessionId,step+1);
    const actions=[['agent_teams_update_task',{task_id:runtimeTaskId,attempt_id:attemptId,status:'in_progress'}],['knowledge_search',{query:'reference'}],['agent_teams_update_task',{task_id:runtimeTaskId,attempt_id:attemptId,status:'completed',output:'Reviewed approved knowledge; no file output is required.'}]];
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
  const deadline=Date.now()+5000;
  while(Date.now()<deadline&&!results.some(r=>r.name==='agent_teams_update_task'&&r.args.status==='completed')){await host.call(captain,'agent_teams_status');await new Promise(resolve=>setTimeout(resolve,10));}
  const completed=results.find(r=>r.name==='agent_teams_update_task'&&r.args.status==='completed');
  assert.ok(bound>0,'trusted attempt registration must precede the completion');
  assert.ok(results.some(r=>r.name==='knowledge_search'&&!r.result.isError),'authorized knowledge call succeeds');
  assert.ok(completed,'completion call reached the actual Host');
  assert.equal(completed.result.isError,false,JSON.stringify(completed.result.error));
  assert.equal(prepared,1,'completion prepares the task once without an undeclared file or terminal call');
  const accepted=readRun(root,archive.id).events.filter(e=>e.type==='handoff/accepted');
  assert.equal(accepted.length,1);assert.equal(accepted[0].data.taskExecution.key.generation,1);
  assert.equal(accepted[0].data.taskExecution.key.runId,archive.id);assert.deepEqual(accepted[0].data.outputs,[]);
 }finally{await host?.close();await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
