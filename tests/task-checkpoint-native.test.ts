import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {join,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';

const url=process.env.TASK_WRITER_POSTGRES_URL;
if(url){const parsed=new URL(url);if(!['postgres:','postgresql:'].includes(parsed.protocol)||!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||parsed.username!=='weiwu_test'||!/^\/weiwu_backup_test_[a-f0-9]{32}$/.test(parsed.pathname)||!parsed.port||parsed.search||parsed.hash)throw Error('Explicit owned task writer PostgreSQL database required');process.env.DATABASE_URL=url;}
let pool:pg.Pool,observers:pg.Pool,root:string,writers:ReturnType<typeof createArchiveWriterManager>,fence:ReturnType<typeof createArchiveWriteFence>,serviceModule:typeof import('../apps/api/src/local-execution.ts');
before(async()=>{
 if(!url)return;
 const base=realpathSync('.private/checkpoint-drain-20261029');root=mkdtempSync(join(base,'native-fixture-'));writeFileSync(join(root,'owned.json'),JSON.stringify({root,pid:process.pid}));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;pool.options.max=1;pool.options.application_name='checkpoint-writer-'+randomUUID();await db.migrate();await pool.query("INSERT INTO departments(id,data) VALUES('department','{}')");
 serviceModule=await import('../apps/api/src/local-execution.ts');observers=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:3000});writers=createArchiveWriterManager({traceRoot:root});fence=createArchiveWriteFence({traceRoot:root,lockRoot:writers.lockRoot});
});
after(async()=>{if(!url)return;await observers?.end();await pool?.end();if(root){assert.equal(realpathSync(root),root);assert.match(relative(realpathSync('.private/checkpoint-drain-20261029'),root),/^native-fixture-[a-zA-Z0-9]+$/);rmSync(root,{recursive:true});}});

for(const decision of ['COMMIT','ROLLBACK'])test('native checkpoint cancellation drains the original row-lock wait after blocker '+decision,{skip:!url,timeout:20000},async t=>{
 const runId=randomUUID(),projectId=randomUUID(),owner=randomUUID(),snapshot={projectId,planVersion:1,executionProfile:'task-attempt-openshell-v1',agents:[],tasks:[]};
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,'department',1,'fixture','fixture','{}','{}','manual')",[projectId]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 const archive=createRunArchive(root,snapshot,{id:runId}),executor=new serviceModule.LocalRunExecutor(archive,snapshot,new serviceModule.LocalOperationService(root,owner,writers)),blocker=await observers.connect(),abort=new AbortController(),reason=Error('native checkpoint cancelled');let work:Promise<unknown>|undefined,called=0,settled=false;
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);const blockerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  work=(executor as any).taskTransaction(abort.signal,async()=>{called++;}).catch((error:unknown)=>error);work!.then(()=>{settled=true;});
  let waiting:any;const deadline=Date.now()+5000;while(Date.now()<deadline){waiting=(await observers.query("SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[pool.options.application_name])).rows.find(row=>row.blockers.includes(blockerPid));if(waiting)break;await new Promise(done=>setTimeout(done,10));}
  assert.ok(waiting,'the original independent PostgreSQL backend must actually wait on the project row lock');assert.notEqual(waiting.pid,blockerPid);
  abort.abort(reason);await new Promise(done=>setImmediate(done));assert.equal(settled,false);assert.equal(called,0);await assert.rejects(fence.acquireSource(runId,{timeoutMs:50}),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  await blocker.query(decision);assert.equal(await work,reason);assert.equal(called,0);const available=await fence.acquireSource(runId,{timeoutMs:500});available.release();
  for(const table of ['models','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);
  t.diagnostic(JSON.stringify({runId,blockerPid,writerPid:waiting.pid,decision,actualLockWait:true,checkpointCallbackCalls:called,sourceReleasedAfterOriginalSettled:true}));
 }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();await work;}
});
