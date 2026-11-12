import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pool,migrate} from '../apps/api/src/db.ts';
import {runManagementRouter} from '../apps/api/src/run-management.ts';
import {taskRecoverySourceFixture} from './helpers/task-recovery-source-fixture.ts';

// Real HTTP/SQL/native admission guards; profile closure is intentional.
// Physical device effects come from the existing fixture, with no model calls.
const isolated=process.env.SIMULATED_INTEGRATION==='pglite',base=resolve('.private/recovery-route-20261102');let root:string;
before(async()=>{if(!isolated)return;mkdirSync(base,{recursive:true});root=mkdtempSync(join(base,'http-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');await migrate();});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE departments,projects,project_runs,task_attempt_workspaces,local_operations,local_devices,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(isolated)for(const table of ['usage','model_reservations','models'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(resolve(root).startsWith(base+sep));rmSync(root,{recursive:true});});

async function fixture(){
 const f=await taskRecoverySourceFixture(root),app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.principal={kind:'local-owner'};next();});
 app.use(runManagementRouter(root,f.writers));app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as any).port;
 return {...f,post:async(body:any)=>{const response=await fetch(url+'/runs/'+f.runId+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};},close:async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await f.close();}};
}

test('task retry HTTP returns the same already committed child without rewriting source or launching work',{skip:!isolated},async()=>{
 const f=await fixture();try{
  const journal=readFileSync(join(root,f.runId,'events.jsonl')),jobs=f.jobs.length;
  for(let n=0;n<2;n++){const response=await f.post({resume:true,checkpointId:f.cp.id});assert.equal(response.status,200,JSON.stringify(response.data));assert.deepEqual(response.data,{id:f.childRunId,existing:true});}
  assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[f.runId])).rowCount,1);
  assert.equal(f.jobs.length,jobs);assert.deepEqual(readFileSync(join(root,f.runId,'events.jsonl')),journal);
  const other=await f.post({resume:true,checkpointId:randomUUID()});assert.equal(other.status,409);assert.equal(other.data.code,'CHECKPOINT_CHILD_EXISTS');
 }finally{await f.close();}
});

test('actual task-v2 retry reaches the unchanged public profile gate and leaves no child',{skip:!isolated},async()=>{
 const f=await fixture();try{
  await pool.query('DELETE FROM project_runs WHERE id=$1',[f.childRunId]);const journal=readFileSync(join(root,f.runId,'events.jsonl'));
  const response=await f.post({resume:true,checkpointId:f.cp.id});assert.equal(response.status,422,JSON.stringify(response.data));assert.equal(response.data.code,'TASK_EXECUTION_UNAVAILABLE');
  assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[f.runId])).rowCount,0);
  assert.deepEqual(readFileSync(join(root,f.runId,'events.jsonl')),journal);
 }finally{await f.close();}
});

test('task retry HTTP requires a selected checkpoint and rejects resource expansion without creating a child',{skip:!isolated},async()=>{
 const f=await fixture();try{
  await pool.query('DELETE FROM project_runs WHERE id=$1',[f.childRunId]);
  for(const body of [{resume:true},{resume:false},{resume:true,checkpointId:f.cp.id,budgetPreviewId:randomUUID(),confirmation:'APPROVE_RESOURCES_AND_RESUME'}]){
   const response=await f.post(body);assert.equal(response.status,409,JSON.stringify(response.data));assert.equal(response.data.code,'CHECKPOINT_RESUME_ONLY');
  }
  assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[f.runId])).rowCount,0);
 }finally{await f.close();}
});

test('a recovery-shaped source is rejected by task retry HTTP before inserting any successor',{skip:!isolated},async()=>{
 const f=await fixture();try{
  await pool.query('DELETE FROM project_runs WHERE id=$1',[f.childRunId]);
  await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{recovery}',$1::jsonb) WHERE id=$2",[JSON.stringify({sourceRunId:randomUUID()}),f.runId]);
  const response=await f.post({resume:true,checkpointId:f.cp.id});assert.equal(response.status,409,JSON.stringify(response.data));assert.equal(response.data.code,'TASK_RECOVERY_SOURCE_INVALID');
  assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[f.runId])).rowCount,0);
 }finally{await f.close();}
});
