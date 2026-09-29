import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {recoveryModel} from './model-fixture.ts';
import {createRunArchive,openRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='run_state_'+Date.now();
let pool:pg.Pool,app:any,server:any,url:string,dir:string,state:typeof import('../apps/api/src/run-state.ts');
async function call(path:string,method='GET',body?:any){const response=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};}
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const dbURL=new URL(base);dbURL.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=dbURL.toString();
 dir=await mkdtemp(join(tmpdir(),'run-state-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();await recoveryModel(pool);state=await import('../apps/api/src/run-state.ts');
 const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdown();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
});
after(async()=>{await app?.locals.shutdown();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});
async function running(){
 const department=(await call('/departments','POST',{name:'状态测试',description:'',agents:[{id:'employee',role:'manager',name:'经理',title:'经理',instructions:'协调',modelId:'recovery-model',tools:[]}]})).data;
 const project=(await call('/projects','POST',{departmentId:department.id,requirement:'验证运行终态不会覆盖后继运行',policy:{maxBudget:1,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300}})).data;
 const approved=await call('/projects/'+project.id+'/approve','POST',{version:1});assert.equal(approved.status,202,JSON.stringify(approved.data));
 const row=(await pool.query("UPDATE project_runs SET status='running',lease_owner='worker',lease_until=now()+interval '1 minute' WHERE id=$1 RETURNING *",[approved.data.id])).rows[0];
 await pool.query("UPDATE projects SET status='RUNNING' WHERE id=$1",[project.id]);createRunArchive(join(dir,'runs'),row.snapshot,{id:row.id});return row;
}

test('terminal state is atomic with project state and closes pending tool approvals',async()=>{
 const row=await running();await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES($1,$2,'employee-1','terminal','{}')",[randomUUID(),row.id]);
 await pool.query("CREATE FUNCTION fail_terminal_project() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='COMPLETED' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_terminal_project BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION fail_terminal_project()");
 try{await assert.rejects(state.finishRun(row.id,'worker','completed'));assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[row.id])).rows[0].status,'running');assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[row.project_id])).rows[0].status,'RUNNING');assert.equal((await pool.query('SELECT status FROM tool_approvals WHERE run_id=$1',[row.id])).rows[0].status,'pending');}
 finally{await pool.query('DROP TRIGGER fail_terminal_project ON projects;DROP FUNCTION fail_terminal_project()');}
 assert.equal(await state.finishRun(row.id,'worker','completed'),true);
 assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[row.project_id])).rows[0].status,'COMPLETED');assert.equal((await pool.query('SELECT status FROM tool_approvals WHERE run_id=$1',[row.id])).rows[0].status,'cancelled');
});

test('a late worker waiting on the project lock cannot overwrite a successor or append a failure event',async()=>{
 const row=await running(),gate=await pool.connect();const pid=(await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;let pending:Promise<any>|undefined,wrote=false;
 await gate.query('BEGIN');await gate.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[row.project_id]);
 try{
  pending=state.finishRun(row.id,'worker','failed','late failure',()=>{wrote=true;});
  let waiting=false;for(let i=0;i<100;i++){const result=await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query='SELECT id FROM projects WHERE id=$1 FOR UPDATE'",[pid]);if(result.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert.ok(waiting);
  await gate.query("UPDATE project_runs SET status='interrupted',lease_owner=NULL,lease_until=NULL WHERE id=$1",[row.id]);
  const child=randomUUID();await gate.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,parent_run_id) VALUES($1,$2,1,'queued',$3,2,$4)",[child,row.project_id,row.snapshot,row.id]);await gate.query("UPDATE projects SET status='QUEUED' WHERE id=$1",[row.project_id]);await gate.query('COMMIT');
  assert.equal(await pending,false);assert.equal(wrote,false);assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[row.project_id])).rows[0].status,'QUEUED');
  assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[child])).rows[0].status,'queued');await call('/runs/'+child+'/cancel','POST',{});
 }finally{await gate.query('ROLLBACK');gate.release();if(pending)await pending;}
});

test('recovery owns a live lease until reconciliation and rejects expired owners including earlier recovery processes',async()=>{
 const row=await running();await pool.query("UPDATE project_runs SET lease_until=now()-interval '1 minute' WHERE id=$1",[row.id]);
 assert.equal(await state.finishRun(row.id,'worker','completed'),false);
 const claims=await Promise.all([state.claimExpiredRun(row.id),state.claimExpiredRun(row.id)]);assert.equal(claims.filter(Boolean).length,1);const claimed=claims.find(Boolean)!;
 assert.equal((await call('/runs/'+row.id+'/retry','POST',{resume:false})).status,409);assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[row.id])).rows[0].status,'running');
 assert.equal(await state.finishRun(row.id,'worker','failed'),false);
 await pool.query("UPDATE project_runs SET lease_until=now()-interval '1 minute' WHERE id=$1",[row.id]);const replacement=await state.claimExpiredRun(row.id);assert.notEqual(replacement.lease_owner,claimed.lease_owner);
 assert.equal(await state.finishRun(row.id,claimed.lease_owner,'failed'),false);assert.equal(await state.finishRun(row.id,replacement.lease_owner,'interrupted'),true);
 const retry=await call('/runs/'+row.id+'/retry','POST',{resume:false});assert.equal(retry.status,202,JSON.stringify(retry.data));await call('/runs/'+retry.data.id+'/cancel','POST',{});
});

test('recovery reconciles a recorded completion and API state remains authoritative over later trace events',async()=>{
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');const worker=new RunCoordinator(join(dir,'runs'));await worker.close();
 const row=await running();openRunArchive(join(dir,'runs'),row.id).append('run/finished',{status:'completed',message:'recorded before crash'});
 await pool.query("UPDATE project_runs SET lease_until=now()-interval '1 minute' WHERE id=$1",[row.id]);await worker.recover();
 assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[row.project_id])).rows[0].status,'COMPLETED');
 openRunArchive(join(dir,'runs'),row.id).append('run/finished',{status:'failed',message:'late stale observation'});
 assert.equal(readRun(join(dir,'runs'),row.id)?.status,'failed','raw trace observations remain available');
 const detail=(await call('/runs/'+row.id)).data;assert.equal(detail.status,'completed');assert.ok(detail.events.some((e:any)=>e.data.message==='late stale observation'));
 assert.equal((await call('/runs')).data.find((r:any)=>r.id===row.id).status,'completed');
});
