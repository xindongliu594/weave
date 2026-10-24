import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import express from 'express';
import type pg from 'pg';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use the isolated integration runner');
let db:pg.Pool,root:string,url:string,server:ReturnType<ReturnType<typeof express>['listen']>;
let writers:ReturnType<typeof createArchiveWriterManager>;
const employee={id:'reader',name:'Reader',role:'manager',instructions:'Read the fixed method',modelId:'fixture-model',tools:[]};
const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:60,allowedModelIds:['fixture-model'],allowedTools:[]};
before(async()=>{
 root=await mkdtemp(join(tmpdir(),'effect-recovery-'));Object.assign(process.env,{DATA_DIR:root,TRACE_ROOT:join(root,'runs'),OBSIDIAN_VAULT:join(root,'vault'),WEIWU_AUTH_MODE:'legacy-local',WEIWU_EXECUTION_MODE:'legacy'});
 const product=await import('../apps/api/src/db.ts');db=product.pool;await product.migrate();
 // Explicit migration also supports the pre-wiring RED fixture.
 await (await import('../apps/api/src/tool-operations.ts')).migrateToolOperations(db);
 writers=createArchiveWriterManager({traceRoot:join(root,'runs')});
 await db.query("INSERT INTO departments(id,data) VALUES('effect-dept',$1)",[{name:'Effect fixture',agents:[employee]}]);
 const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.principal={kind:'local-owner'};next();});
 app.use('/api',(await import('../apps/api/src/run-management.ts')).runManagementRouter(writers.traceRoot,writers));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${(server.address() as any).port}/api`;
});
after(async()=>{if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}await db?.end();if(root){assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.match(root,/effect-recovery-/);await rm(root,{recursive:true,force:true});}});
async function seed(state:'unknown'|'confirmed'='unknown',status='failed'){
 const projectId=randomUUID(),runId=randomUUID(),operationId=randomUUID(),owner=randomUUID();
 const tasks=[{id:'read',assignee:'reader',assigneeId:'reader',subject:'Read fixed method',objective:'Read fixed method',dependencies:[],acceptanceCriteria:['Return the cited fact'],estimatedInputTokens:10,estimatedOutputTokens:10}];
 const snapshot={projectId,departmentId:'effect-dept',departmentIds:['effect-dept'],agents:[employee],tasks,approvedTasks:tasks,modelRoutes:[],policy,executionProfile:'legacy-run-v1',knowledge:{},effectContractVersion:1,effectContracts:[]};
 await db.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,'effect-dept',1,'Effect fixture','Read fixed method',$2,$3,'manual')",[projectId,policy,{agents:[employee],tasks}]);
 await db.query('INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids,lease_owner,lease_until) VALUES($1,$2,1,$3,$4,$5,$6,now()+interval \'10 minutes\')',[runId,projectId,status,snapshot,['effect-dept'],owner]);
 await db.query(`INSERT INTO local_operations(id,run_id,lease_owner,payload,status,executor_kind,effect_intent,effect_state,effect_version,evidence_records,started)
 VALUES($1,$2,$3,'{}',$4,'runtime',$5,$6,3,'[]',true)`,[operationId,runId,owner,state==='confirmed'?'completed':'unknown',{principal:{sessionId:'fixture'},callId:operationId},state]);
 const archive=createRunArchive(writers.traceRoot,snapshot,{id:runId});archive.append('run/finished',{status,message:'Isolated effect-state fixture'});
 return {projectId,runId,operationId,owner,snapshot};
}
test('retry and preflight cannot acknowledge away a persisted unknown runtime operation',async()=>{
 const row=await seed();
 const check=await fetch(`${url}/runs/${row.runId}/recovery-check?acknowledgeUnknownOperations=true&retainUncertainCosts=true`);
 assert.equal(check.status,200);const body=await check.json() as any;
 assert.ok(body.resume.reasons.some((reason:any)=>reason.code==='TOOL_OPERATION_UNRESOLVED'),JSON.stringify(body.resume.reasons));
 assert.ok(body.retry.reasons.some((reason:any)=>reason.code==='TOOL_OPERATION_UNRESOLVED'));
 const retry=await fetch(`${url}/runs/${row.runId}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resume:true,acknowledgeUnknownOperations:true,retainUncertainCosts:true})});
 assert.equal(retry.status,409);assert.equal((await retry.json() as any).code,'TOOL_OPERATION_UNRESOLVED');
 assert.equal((await db.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[row.runId])).rowCount,0);
 assert.equal((await db.query('SELECT effect_state FROM local_operations WHERE id=$1',[row.operationId])).rows[0].effect_state,'unknown');
});
test('run launch checks unresolved effects before runtime inspection or any model dispatch',async()=>{
 const row=await seed('unknown','running'),{RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');let inspections=0,starts=0;
 const coordinator=Object.assign(Object.create(RunCoordinator.prototype),{owner:row.owner,traceRoot:writers.traceRoot,writers,active:new Map(),stopped:false,runtime:{inspect:async()=>{inspections++;return {ready:true};},start:async()=>{starts++;throw Error('NO_MODEL_OR_RUNTIME_EXPECTED');}}}) as InstanceType<typeof RunCoordinator>;
 const record=(await db.query('SELECT * FROM project_runs WHERE id=$1',[row.runId])).rows[0];await coordinator.launch(record);
 assert.equal(inspections,0);assert.equal(starts,0);
 const stopped=(await db.query('SELECT status,error FROM project_runs WHERE id=$1',[row.runId])).rows[0];assert.equal(stopped.status,'failed');assert.match(stopped.error,/核对|UNRESOLVED/);
});
test('maintenance distinguishes confirmed runtime receipts from absent device results',async()=>{
 const {maintenanceCandidate}=await import('../apps/api/src/storage-lifecycle.ts');
 const confirmed=await seed('confirmed','completed');
 // A tiny archive is ineligible for compression, but a confirmed runtime result
 // must pass the operation check and reach that existing archive-size rule.
 await assert.rejects(maintenanceCandidate(writers.traceRoot,'journal',confirmed.runId,undefined,db),(error:any)=>error.code==='JOURNAL_ARCHIVE_NO_BENEFIT');
 const unknown=await seed('unknown','completed');
 await assert.rejects(maintenanceCandidate(writers.traceRoot,'journal',unknown.runId,undefined,db),(error:any)=>error.code==='TOOL_OPERATION_UNRESOLVED');
});
