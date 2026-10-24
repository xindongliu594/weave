import {after,before,describe,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {recoveryModel} from './model-fixture.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';

function admissionPostgresUrl(value:unknown){
 const rejected=()=>Error('RUN_ADMISSION_POSTGRES_URL must name an explicit owned loopback admission test database');
 if(typeof value!=='string'||!value)throw rejected();
 let url:URL;try{url=new URL(value);}catch{throw rejected();}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
  ||url.username!=='weiwu_test'||!url.password||!/^\d+$/.test(url.port)||Number(url.port)<1||Number(url.port)>65535
  ||!/^\/weiwu_admission_test_[a-f0-9]{32}$/.test(url.pathname)||url.search||url.hash)throw rejected();
 return url;
}

test('native admission fixture refuses missing, ambient, remote and non-owned database URLs before connecting',()=>{
 const own='postgresql://weiwu_test:synthetic@127.0.0.1:54329/weiwu_admission_test_'+'a'.repeat(32);
 assert.equal(admissionPostgresUrl(own).href,own);
 for(const value of [undefined,'',own.replace('127.0.0.1','db.example.com'),own.replace('weiwu_test:','postgres:'),
  own.replace('synthetic@','@'),own.replace('54329/','5432/agent_department/'),own.replace('admission_test_','identity_test_'),
  own+'?options=-c%20search_path=public',own+'#fragment','postgresql://agent_department:local-development-only@127.0.0.1:55432/agent_department']){
  assert.throws(()=>admissionPostgresUrl(value),/explicit owned loopback/);
 }
});

// This suite never falls back to DATABASE_URL or the product's default server.
// The controller provisions and removes the explicit disposable database.
const nativeUrl=process.env.RUN_ADMISSION_POSTGRES_URL;
describe('native PostgreSQL target admission competition',{skip:nativeUrl===undefined?'requires RUN_ADMISSION_POSTGRES_URL for an owned PostgreSQL fixture':false,timeout:60000},()=>{
 const schema='admission_'+randomUUID().replaceAll('-',''),application=schema+'_product';
 let control:pg.Pool,pool:pg.Pool,app:any,server:Server,gateway:Server,base:string,root:string,traceRoot:string;
 let connectionString:string,schemaCreated=false,modelRequests=0,executors=0;
 const pause=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
 async function call(path:string,method='POST',body:any={}){
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},
   body:method==='GET'?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  return {status:response.status,data:await response.json()};
 }
 async function project(){
  const department=await call('/departments','POST',{name:'原生准入竞争测试',description:'',agents:[{id:'employee',role:'manager',name:'经理',title:'经理',instructions:'只读整理三项核对规则',modelId:'recovery-model',tools:[]}]});assert.equal(department.status,201);
  const created=await call('/projects','POST',{departmentId:department.data.id,requirement:'整理终态、租约与版本一致性的三项核对清单',policy:{maxBudget:.1,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300}});assert.equal(created.status,201);
  const draft=(await call('/projects','GET')).data.find((item:any)=>item.id===created.data.id);
  const plan={...draft.plan,tasks:[{...draft.plan.tasks[0],subject:'整理终态与版本核对清单',objective:'列出终态原子提交、过期 owner 隔离和版本一致性三条规则',kind:'requirements',acceptanceCriteria:['核对清单包含三项明确状态判定且不执行工具']}]};
  const edited=await call('/projects/'+created.data.id+'/plan','PUT',{version:1,plan});assert.equal(edited.status,200,JSON.stringify(edited.data));
  return {id:created.data.id,version:2};
 }
 async function stopped(){
  const p=await project(),approved=await call('/projects/'+p.id+'/approve','POST',{version:p.version});assert.equal(approved.status,202,JSON.stringify(approved.data));
  const row=(await pool.query("UPDATE project_runs SET status='interrupted' WHERE id=$1 RETURNING *",[approved.data.id])).rows[0];
  await pool.query("UPDATE projects SET status='INTERRUPTED' WHERE id=$1",[p.id]);
  createRunArchive(traceRoot,row.snapshot,{id:row.id});return row;
 }
 async function bothWaiting(gatePid:number,query:string,finished:()=>number){
  const deadline=Date.now()+5000;let observed:any[]=[];
  do{
   observed=(await control.query(`SELECT pid,query,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND state='active'
    AND wait_event_type='Lock' AND query=$2 ORDER BY pid`,[application,query])).rows;
   if(observed.length===2)break;
   assert.equal(finished(),0,'both HTTP requests must remain pending until the gate is released');await pause(10);
  }while(Date.now()<deadline);
  assert.equal(observed.length,2,'two independent product backends must be waiting at the original project row lock');
  assert.equal(new Set(observed.map(row=>row.pid)).size,2);assert.equal(finished(),0);
  const reachesGate=(pid:number,seen=new Set<number>()):boolean=>{
   if(pid===gatePid)return true;if(seen.has(pid))return false;seen.add(pid);
   return observed.find(row=>row.pid===pid)?.blockers.some((blocker:number)=>reachesGate(blocker,new Set(seen)))??false;
  };
  for(const row of observed)assert.ok(reachesGate(row.pid),'each waiting request must be blocked directly or transitively by this fixture gate');
  console.log(JSON.stringify({fixture:'native-admission-row-wait',gatePid,requests:observed}));
 }
 async function compete(projectId:string,query:string,request:()=>ReturnType<typeof call>,unchanged:()=>Promise<void>){
  const gate=new pg.Client({connectionString,options:'-c search_path='+schema,application_name:schema+'_gate',connectionTimeoutMillis:3000,statement_timeout:12000});
  await gate.connect();let pending:ReturnType<typeof call>[]=[],finished=0;
  try{
   const gatePid=(await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await gate.query('BEGIN');await gate.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
   pending=[request().finally(()=>{finished++;}),request().finally(()=>{finished++;})];
   // Observe failures promptly but preserve both original promises for the join.
   for(const item of pending)void item.catch(()=>{});
   await bothWaiting(gatePid,query,()=>finished);await unchanged();await gate.query('COMMIT');
   return await Promise.all(pending);
  }finally{try{await gate.query('ROLLBACK');}finally{await Promise.allSettled(pending);await gate.end();}}
 }
 async function assertNeverExecuted(ids:string[]){
  assert.equal(modelRequests,0,'the loopback model observer saw no inference request');assert.equal(executors,0,'no runtime executor was created');
  const rows=(await pool.query('SELECT id,status,started_at,lease_owner,lease_until FROM project_runs WHERE id=ANY($1::text[])',[ids])).rows;
  assert.equal(rows.length,ids.length);
  for(const row of rows){assert.equal(row.status,'queued');assert.equal(row.started_at,null);assert.equal(row.lease_owner,null);assert.equal(row.lease_until,null);assert.equal(existsSync(join(traceRoot,row.id)),false,'no runtime archive was created for the new queued run');}
 }
 before(async()=>{
  assert.notEqual(process.env.SIMULATED_INTEGRATION,'pglite','native evidence cannot use the PGlite pool shim');
  const checked=admissionPostgresUrl(nativeUrl);connectionString=checked.href;
  control=new pg.Pool({connectionString,max:3,connectionTimeoutMillis:3000,statement_timeout:12000});
  const identity=(await control.query('SELECT current_database() AS db,current_user AS role,version() AS version')).rows[0];
  assert.equal(identity.db,checked.pathname.slice(1));assert.equal(identity.role,'weiwu_test');assert.match(identity.version,/PostgreSQL 17\./);
  await control.query('CREATE SCHEMA '+schema);schemaCreated=true;
  const productUrl=new URL(connectionString);productUrl.searchParams.set('options','-c search_path='+schema+' -c statement_timeout=12000');productUrl.searchParams.set('application_name',application);
  process.env.DATABASE_URL=productUrl.href;process.env.WEIWU_AUTH_MODE='legacy-local';process.env.WEIWU_EXECUTION_MODE='legacy';
  root=await mkdtemp(join(tmpdir(),'run-admission-native-'));traceRoot=join(root,'runs');
  console.log('ARCHIVE_WRITER_FIXTURE_CREATED='+JSON.stringify({root,pid:process.pid}));
  console.log(JSON.stringify({fixture:'native-admission-full-migrate',database:identity.db,version:identity.version,schema}));
  process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');
  const db=await import('../apps/api/src/db.ts');pool=db.pool;pool.options.max=4;pool.options.connectionTimeoutMillis=3000;
  // Use the complete production migration, including pgvector; never emulate it.
  await db.migrate();await recoveryModel(pool);
  gateway=createServer((_request,response)=>{modelRequests++;response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:'Unexpected model request in native admission fixture'}));});
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  await pool.query("UPDATE gateways SET data=jsonb_set(data,'{baseUrl}',to_jsonb($1::text)) WHERE id='recovery-gateway'",['http://127.0.0.1:'+(gateway.address() as AddressInfo).port+'/v1']);
  const {createApp}=await import('../apps/api/src/app.ts');
  app=createApp({createExecutor:()=>{executors++;throw Error('NATIVE_ADMISSION_RUNTIME_MUST_NOT_START');}});await app.locals.shutdownBackground();await app.locals.ready;
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api';
 });
 after(async()=>{
  try{await app?.locals.shutdown();}finally{
   for(const item of [server,gateway])if(item){item.closeAllConnections();await new Promise<void>(done=>item.close(()=>done()));}
   try{await pool?.end();}finally{if(control){try{if(schemaCreated)await control.query('DROP SCHEMA '+schema+' CASCADE');}finally{await control.end();}}}
   if(root)console.log('ARCHIVE_WRITER_EXIT_CLEANUP='+root);
  }
 });
 test('simultaneous same-version approvals create exactly one run after two real row-lock waits',async()=>{
  const p=await project();
  const results=await compete(p.id,'SELECT * FROM projects WHERE id=$1 FOR UPDATE',()=>call('/projects/'+p.id+'/approve','POST',{version:p.version}),async()=>{
   assert.equal((await pool.query('SELECT id FROM project_runs WHERE project_id=$1',[p.id])).rowCount,0);
  });
  assert.deepEqual(results.map(result=>result.status).sort(),[200,202],JSON.stringify(results));
  const created=results.find(result=>result.status===202)!,existing=results.find(result=>result.status===200)!;
  assert.equal(existing.data.existing,true);assert.equal(existing.data.id,created.data.id);
  const rows=(await pool.query('SELECT id,attempt FROM project_runs WHERE project_id=$1 AND project_version=$2',[p.id,p.version])).rows;
  assert.deepEqual(rows,[{id:created.data.id,attempt:1}]);await assertNeverExecuted([created.data.id]);
 });
 test('simultaneous retries of one parent create exactly one child after two real row-lock waits',async()=>{
  const old=await stopped();
  const results=await compete(old.project_id,'SELECT id FROM projects WHERE id=$1 FOR UPDATE',()=>call('/runs/'+old.id+'/retry'),async()=>{
   assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[old.id])).rowCount,0);
  });
  assert.deepEqual(results.map(result=>result.status).sort(),[200,202],JSON.stringify(results));
  const created=results.find(result=>result.status===202)!,existing=results.find(result=>result.status===200)!;
  assert.deepEqual(existing.data,{id:created.data.id,existing:true});
  const rows=(await pool.query('SELECT id,attempt FROM project_runs WHERE parent_run_id=$1',[old.id])).rows;
  assert.deepEqual(rows,[{id:created.data.id,attempt:2}]);
  assert.equal((await pool.query('SELECT id FROM project_runs WHERE project_id=$1',[old.project_id])).rowCount,2);
  assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[old.id])).rows[0].status,'interrupted');
  await assertNeverExecuted([created.data.id]);
 });
});
