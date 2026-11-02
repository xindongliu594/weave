import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pool} from '../../apps/api/src/db.ts';
import {readRunBounds} from '../../apps/api/src/source-bounds.ts';
import {acceptedStopApiFixture} from './task-accepted-stop-api-fixture.ts';
import {commitStepCheckpoint,checkpointContract,checkpointEnvironment} from '../../services/agent-runtime/step-checkpoints.mjs';
import {readRun} from '../../services/agent-runtime/trace-store.mjs';
import {captureLiveTaskRecoverySource} from '../../apps/api/src/task-recovery-source.ts';
import {completedTasks,checkpointTasks} from '../../apps/api/src/handoff-checkpoints.ts';
import {buildCheckpointContext} from '../../services/agent-runtime/checkpoint-context.mjs';
import {sourceBudgetEvidence} from '../../services/agent-runtime/run-evidence.mjs';

/** Uses real device HTTP claim/result, SQL canonical commits and Handoff seals.
 * Physical sandbox effects are fixture data, never real-model acceptance. */
export async function taskRecoverySourceFixture(root:string,trigger='tool-result'){
 const f=await acceptedStopApiFixture(root,{resourceRevision:1});
 try{
  const context=await f.write('a','A checkpoint'),signal=new AbortController().signal;
  const operationId=f.jobs.at(-1).id,refs=await f.executor.prepareCheckpoint(context,signal,trigger==='tool-result'?{phase:'after-tool',operationId}:{phase:trigger==='before-tool'?'before-tool':'boundary'});
  const op=(await pool.query('SELECT result FROM local_operations WHERE id=$1',[refs.lastMerge!.operationId])).rows[0];
  const boundary:any=f.archive.append('step/boundary',{taskId:'a',attemptId:context.attemptId,trigger},{taskId:'a',attemptId:context.attemptId,sessionId:context.sessionId});
  const cp=commitStepCheckpoint({archive:f.archive,taskRefs:refs,boundary:{taskId:'a',attemptId:context.attemptId,sessionId:context.sessionId,trigger,eventCursor:boundary.seq,contractHash:checkpointContract(f.snapshot,f.snapshot.tasks.find((task:any)=>task.id==='a'),refs),environment:checkpointEnvironment(f.snapshot,op.result.result.execution,refs)}});
  await f.write('a','A later');await f.acceptTask('b','B accepted later');
  await pool.query("UPDATE project_runs SET status='interrupted',finished_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1",[f.runId]);
  const childRunId=randomUUID(),bounds=await readRunBounds(pool,f.runId),childSnapshot={...structuredClone(f.snapshot),resumedFrom:f.runId,
   recovery:{sourceRunId:f.runId,workspaceCheckpoint:{id:cp.id,runId:f.runId,sha256:cp.sha256}},
   approval:{kind:'resume',approvedAt:new Date().toISOString(),parentRunId:f.runId,retainUncertainCosts:false}};
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,parent_run_id,source_bounds) VALUES($1,$2,1,'queued',$3,2,$4,$5)",[childRunId,f.projectId,childSnapshot,f.runId,bounds]);
  return {...f,cp,childRunId,childSnapshot,input:{sourceRunId:f.runId,childRunId,checkpointId:cp.id}};
 }catch(error){await f.close();throw error;}
}

/** Assemble the same full context needed by execution, from verified history. */
export async function completeTaskRecoverySnapshot(f:Awaited<ReturnType<typeof taskRecoverySourceFixture>>,root:string){
 const facts=await captureLiveTaskRecoverySource(f.writers,f.input,new AbortController().signal),events=readRun(root,f.runId)!.events;
 const prefix=events.filter(event=>event.seq<=facts.selected.event.seq),done=completedTasks(events,f.snapshot);
 const handoffCheckpoints=facts.scope.retained.map(item=>item.accepted);
 const recovery=JSON.parse(JSON.stringify(buildCheckpointContext({...f.snapshot,handoffCheckpoints},prefix,checkpointTasks(prefix,f.snapshot),done,join(root,f.runId,'artifacts'),f.runId,facts.scope.candidate.manifest)));
 recovery.workspaceCheckpoint=f.childSnapshot.recovery.workspaceCheckpoint;
 recovery.budgetEvidence=sourceBudgetEvidence(f.snapshot,events,f.runId);
 Object.assign(f.childSnapshot,{completedCheckpoints:[...done.keys()],handoffCheckpoints,recovery});
 await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[f.childSnapshot,f.childRunId]);
}
