import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pool} from '../../apps/api/src/db.ts';
import {LocalRunExecutor} from '../../apps/api/src/local-execution.ts';
import {initializeLiveTaskRecovery} from '../../apps/api/src/task-recovery-initialization.ts';
import {taskRecoverySourceFixture,completeTaskRecoverySnapshot} from './task-recovery-source-fixture.ts';
import {openRunArchive} from '../../services/agent-runtime/trace-store.mjs';
import {checkpointContract,checkpointEnvironment} from '../../services/agent-runtime/step-checkpoints.mjs';
import {HandoffGate} from '../../services/agent-runtime/handoff.mjs';

const signal=()=>new AbortController().signal;

/** Only device effects are fixtures; child admission, claims, commits and seals
 * use the same HTTP/SQL path as the original source fixture. */
export async function taskRecoveryRuntimeFixture(root:string){
 const f=await taskRecoverySourceFixture(root);
 try{
  await completeTaskRecoverySnapshot(f,root);
  const initialized=await initializeLiveTaskRecovery(f.writers,f.input,signal());
  await pool.query("UPDATE project_runs SET status='running',lease_owner=$1,lease_until=now()+interval '1 hour' WHERE id=$2",[f.owner,f.childRunId]);
  const archive=openRunArchive(root,f.childRunId),snapshot=f.childSnapshot;
  const retained=new Map<string,any>(snapshot.handoffCheckpoints.map((item:any)=>[item.taskId,item]));
  const state:any={members:[{id:'child-session',name:'employee'}],tasks:snapshot.tasks.map((task:any)=>({id:'child-native-'+task.id,assignee:task.assignee,attemptId:retained.get(task.id)?.attemptId??'child-attempt-'+task.id,status:retained.has(task.id)?'completed':'in_progress'}))};
  archive.append('run/task-mapping',{tasks:snapshot.tasks.map((task:any)=>({task_id:'child-native-'+task.id,seed_id:task.id}))});archive.append('team/checkpoint',state);
  const executor=new LocalRunExecutor(archive,snapshot,f.service,{sandboxMaintenance:f.maintenance}),contexts=new Map<string,any>();
  async function bind(taskId:string){
   const task=snapshot.tasks.find((item:any)=>item.id===taskId),assignment=await executor.bindAttempt({runId:f.childRunId,taskId,attemptId:'child-attempt-'+taskId,agentId:task.assignee,sessionId:'child-session',runtimeTaskId:'child-native-'+taskId,contractHash:checkpointContract(snapshot,task)},signal());
   const context={agentId:assignment.agentId,sessionId:assignment.sessionId,taskId,attemptId:assignment.attemptId,generation:assignment.generation};contexts.set(taskId,context);return context;
  }
  async function prepare(taskId:string){const context=contexts.get(taskId)??await bind(taskId),scope=await f.drive(executor.prepareTask(context,signal()));return {context,scope};}
  async function write(taskId:string,text:string){
   const {context,scope}=await prepare(taskId),executionScope={profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,workRevision:scope.workRevision};
   await f.drive(executor.execute('artifact_write',{path:taskId+'.txt',content:text,expectedWorkspaceRevision:scope.workRevision,executionScope},signal(),{...context,callId:randomUUID(),executionScope}));return context;
  }
  let handoff:any;
  async function acceptTask(taskId:string,text:string){
   const context=await write(taskId,text),scope=await executor.taskScope(context,signal()),refs=await executor.prepareCheckpoint(context,signal(),{phase:'boundary'});
   const operation=(await pool.query('SELECT result FROM local_operations WHERE id=$1',[refs.lastMerge!.operationId])).rows[0];archive.append('local/device-bound',{execution:operation.result.result.execution});
   const gate=handoff??=new HandoffGate({snapshot:{...snapshot,id:f.childRunId},sandbox:{root:join(archive.dir,'artifacts')},archive});
   gate.environmentProof=operation.result.result.execution;gate.environment=checkpointEnvironment(snapshot,gate.environmentProof);
   gate.bindExecutionScope(taskId,context.attemptId,scope);gate.bindCheckpoint(taskId,context.attemptId,refs,{sessionId:context.sessionId});
   const accepted=gate.prepare(taskId,context.attemptId,{});assert.equal(accepted.runId,f.childRunId);
   state.tasks.find((task:any)=>task.id==='child-native-'+taskId).status='completed';archive.append('team/checkpoint',state);gate.commit(accepted);archive.append('team/checkpoint',state);return context;
  }
  return {...f,initialized,child:{archive,snapshot,state,executor,bind,prepare,write,acceptTask,contexts}};
 }catch(error){await f.close();throw error;}
}
