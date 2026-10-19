import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import * as teams from '@nanmicoder/dsh-agent-teams';
const require=createRequire(import.meta.url),baseRequire=createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));

test('public profiles stage and approve offline; public create_task bridge retains host file contract', {timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'orchestration-profile-')),ctx=new Context(),fibers=[];let handle,modelCalls=0;
 const mount=async(name,config)=>{const mod=await import(pathToFileURL(baseRequire.resolve(name)).href),f=ctx.plugin(mod.default??mod,config);fibers.push(f);await f.await();};
 const contract={inputs:[{path:'source.txt',sha256:'a'.repeat(64)}],outputs:[{path:'result.txt'}]};
 try{
  await mount('@deepseek-ai/dsh-llm');
  ctx.llm.registerAdapter(['offline'],new class extends LlmAdapter {async *stream(){modelCalls++;throw Error('Inference is forbidden in this probe');}}());
  await mount('@deepseek-ai/dsh-session');await mount('@deepseek-ai/dsh-session-projection');await mount('@deepseek-ai/dsh-system-prompt');await mount('@deepseek-ai/dsh-tools',{mode:'native'});await mount('@deepseek-ai/dsh-agent');
  await mount('@deepseek-ai/dsh-session-persistence-jsonl',{root:join(root,'sessions'),compression:'none'});
  await mount('@deepseek-ai/dsh-agent-loop',{agents:[]});
  // Public admission event prevents model dispatch even when approval schedules a task.
  ctx.on('agent/pre-step',async()=>({kind:'reject'}));
  await mount('@deepseek-ai/dsh-subagent');await mount('@deepseek-ai/dsh-subagent-spawn-in-process',{providerName:'spawn'});
  const profile={members:[{name:'writer',provider:'offline',model:'fixture'}],taskPlanning:'seed',tasks:[{id:'seed',subject:'Seed task',assignee:'writer'}]};
  const config=teams.Config({memberMaxDepth:0,maxMembers:6,slashCommand:false,profiles:{offline:profile,unsupported:{...profile,tasks:[{...profile.tasks[0],...contract}]}}});
  const fiber=ctx.plugin(teams,config);fibers.push(fiber);await fiber.await();
  handle=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:root},agentOptions:{provider:'offline',model:'fixture'}});const captain=handle.agent;
  const call=async(name,args={})=>{const result=await captain.ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent:captain,signal:AbortSignal.timeout(5000)});assert.equal(result.isError,false,JSON.stringify(result));return result.value;};
  const unsupported=await captain.ctx.tools.execute({callId:randomUUID(),name:'agent_teams_create',arguments:{name:'unsupported-contract',profile:'unsupported',approval:'required'},agent:captain,signal:AbortSignal.timeout(5000)});assert.equal(unsupported.isError,true);assert.match(unsupported.error.message,/inputs is unknown/);
  const created=await call('agent_teams_create',{name:'offline-profile',profile:'offline',approval:'required'});assert.equal(created.phase,'staged');
  const statePath=join(root,'.agent-teams',created.team_id,'team.json'),state=()=>readFile(statePath,'utf8').then(JSON.parse),staged=await state();
  assert.equal(staged.tasks.length,1);assert.equal(staged.members[0].id,'');assert.equal(modelCalls,0);
  assert.equal(staged.tasks[0].inputs,undefined);assert.equal(staged.tasks[0].outputs,undefined);
  const description=JSON.stringify({hostFileContract:contract});
  const bridged=await call('agent_teams_create_task',{subject:'Bridge fixed file contract',assignee:'writer',dependencies:[created.tasks[0].task_id],kind:'work',objective:'Read immutable source and produce result',description,acceptance:['fixed inputs and output'],deliverables:['result.txt']});
  const task=(await state()).tasks.find(t=>t.id===bridged.task_id);assert.deepEqual(JSON.parse(task.description).hostFileContract,contract);assert.deepEqual(task.deliverables,['result.txt']);
  await call('agent_teams_approve',{confirmation:'Isolated offline API compatibility probe only'});
  const approved=await state();assert.equal(approved.phase,'running');assert.deepEqual(JSON.parse(approved.tasks.find(t=>t.id===bridged.task_id).description).hostFileContract,contract);assert.equal(modelCalls,0);
  console.log('AgentTeams 0.1.20 public Config/create/stage/approve: pass; seed inputs/outputs absent; create_task description preserves host contract; inference 0; sandbox/tools/network 0. Scheduling suppressed by public agent/pre-step guard; no execution acceptance claimed.');
 }finally{await handle?.dispose();for(const f of fibers.reverse())await f.dispose();await rm(root,{recursive:true,force:true});}
});
