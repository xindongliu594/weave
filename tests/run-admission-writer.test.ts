import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type pg from 'pg';
import {recoveryModel} from './model-fixture.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';

// Real HTTP/SQL/native locks; no model calls or execution. PGlite does not prove
// independent PostgreSQL backend locking, which remains a separate gate.
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
let pool:pg.Pool,app:any,server:any,url:string,root:string,traceRoot:string,fence:ReturnType<typeof createArchiveWriteFence>;
before(async()=>{
 if(!isolated)return;
 assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
 root=await mkdtemp(join(tmpdir(),'run-admission-writer-'));traceRoot=join(root,'runs');
 console.log('ARCHIVE_WRITER_FIXTURE_CREATED='+JSON.stringify({root,pid:process.pid}));
 process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();await recoveryModel(pool);
 const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdownBackground();
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
 fence=createArchiveWriteFence({traceRoot,lockRoot:join(root,'.archive-write-locks')});
});
after(async()=>{
 if(!isolated)return;
 await app?.locals.shutdown();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}await pool?.end();
 // Uncertain commit cases intentionally retain native guards until process exit.
 console.log('ARCHIVE_WRITER_EXIT_CLEANUP='+root);
});
beforeEach(async()=>{if(isolated)await pool.query("UPDATE project_runs SET status='interrupted' WHERE status IN ('queued','running')");});
async function call(path:string,method='POST',body:any={}){
 const response=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json()};
}
async function project(){
 const department=await call('/departments','POST',{name:'准入隔离测试',description:'',agents:[{id:'employee',role:'manager',name:'经理',title:'经理',instructions:'只读整理三项核对规则',modelId:'recovery-model',tools:[]}]});assert.equal(department.status,201);
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
type QueryHook=(text:any,args:any[],next:()=>Promise<any>)=>Promise<any>;
async function intercept(hook:QueryHook,work:()=>Promise<void>,onConnect=()=>{},onRelease: (error:Error|boolean|undefined,client:pg.PoolClient)=>void=()=>{}){
 const connect=pool.connect;
 (pool as any).connect=function(callback?:any){
  if(typeof callback==='function')return (connect as any).call(pool,callback);
  onConnect();return (connect as ()=>Promise<pg.PoolClient>).call(pool).then(client=>{
   const query=client.query,release=client.release;
   (client as any).query=(text:any,...args:any[])=>hook(text,args,()=>Promise.resolve((query as any).call(client,text,...args)));
   client.release=function(error?:Error|boolean){client.query=query;client.release=release;onRelease(error,client);release.call(client,error);};return client;
  });
 };
 try{await work();}finally{pool.connect=connect;}
}
const pause=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
function lifetimeIds(){
 const lockRoot=join(root,'.archive-write-locks');
 // The otherwise-unused proposed UUID is observable even on an existing-child
 // path. Inspect only this test's private namespace, then probe its native lock.
 return new Set(readdirSync(lockRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()).flatMap(entry=>readdirSync(join(lockRoot,entry.name)))
  .filter(name=>/^[0-9a-f-]{36}\.lifetime$/.test(name)).map(name=>name.slice(0,-'.lifetime'.length)));
}
async function sourceProbe(id:string,blocked?:boolean){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/archive-admission-probe.mjs',import.meta.url))],{windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,ARCHIVE_WRITER_TEST:JSON.stringify({traceRoot,lockRoot:join(root,'.archive-write-locks'),runId:id})}});
 const exited=once(child,'exit');let timer:NodeJS.Timeout|undefined;
 try{
  const value=await Promise.race([once(child,'message').then(([value])=>value),exited.then(()=>{throw Error('Source probe exited before result');}),new Promise<never>((_yes,no)=>{timer=setTimeout(()=>no(Error('Source probe timeout')),10000);})]);
  if(blocked!==undefined)assert.deepEqual(value,blocked?{blocked:true}:{acquired:true});
  return value;
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}
}

for(const kind of ['approve','retry'] as const)test(kind+' waits for native target admission before opening SQL and rechecks stale state',{skip:!isolated,timeout:20000},async()=>{
 const p=kind==='approve'?await project():await stopped(),route=kind==='approve'?'/projects/'+p.id+'/approve':'/runs/'+p.id+'/retry';
 const guard=await fence.acquireRootExclusive();let released=false,connections=0,pending:Promise<any>|undefined;
 try{await intercept(async(_text,_args,next)=>next(),async()=>{
  pending=call(route,'POST',kind==='approve'?{version:p.version}:{});
  await pause(100);assert.equal(connections,0,'no SQL transaction while native target admission is blocked');
  if(kind==='approve')await pool.query('UPDATE projects SET version=version+1 WHERE id=$1',[p.id]);
  else await pool.query("UPDATE project_runs SET status='completed' WHERE id=$1",[p.id]);
  guard.release();released=true;const result=await pending;assert.equal(result.status,409,JSON.stringify(result.data));
 },()=>{connections++;});}finally{if(!released)guard.release();await pending;}
 const available=await fence.acquireRootExclusive();available.release();
});

test('confirmed rollback of admission errors releases target instead of permanently latching the archive',{skip:!isolated,timeout:20000},async()=>{
 for(const kind of ['approve','retry'] as const){
  const p=kind==='approve'?await project():await stopped();let rolls=0;
  await intercept(async(text,_args,next)=>{if(text==='ROLLBACK')rolls++;return next();},async()=>{
   if(kind==='retry')await pool.query("UPDATE project_runs SET status='completed' WHERE id=$1",[p.id]);
   const result=await call(kind==='approve'?'/projects/'+p.id+'/approve':'/runs/'+p.id+'/retry','POST',kind==='approve'?{version:999}:{});
   assert.equal(result.status,409,JSON.stringify(result.data));
  });
  assert.equal(rolls,1);
  const available=await fence.acquireRootExclusive();available.release();
 }
});

for(const kind of ['approve','retry'] as const)test(kind+' keeps target guarded through INSERT and rollback after the final project update fails',{skip:!isolated,timeout:20000},async()=>{
 const p=kind==='approve'?await project():await stopped();let target='',begins=0,rolls=0,observed:unknown;
 await intercept(async(text,args,next)=>{
  if(text==='BEGIN')begins++;
  if(typeof text==='string'&&text.startsWith('INSERT INTO project_runs')){target=args[0][0];observed=await sourceProbe(target);}
  if(typeof text==='string'&&text.startsWith("UPDATE projects SET status='QUEUED'"))throw Error('ADMISSION_PROJECT_WRITE_FAILED');
  if(text==='ROLLBACK')rolls++;return next();
 },async()=>{
  const result=await call(kind==='approve'?'/projects/'+p.id+'/approve':'/runs/'+p.id+'/retry','POST',kind==='approve'?{version:p.version}:{});
  assert.equal(result.status,500,JSON.stringify(result.data));
 });
 assert.ok(target);assert.deepEqual(observed,{blocked:true},'assert outside HTTP catch: target is guarded before its first write');assert.equal(begins,1);assert.equal(rolls,1);
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE id=$1',[target])).rowCount,0);
 await sourceProbe(target,false);assert.equal(existsSync(join(traceRoot,target)),false,'admission does not write archive or workspace');
});

test('existing active retry child is returned without acquiring that child writer or creating another child',{skip:!isolated,timeout:20000},async()=>{
 const old=await stopped(),child=randomUUID();
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,parent_run_id) VALUES($1,$2,$3,'running',$4,2,$5)",[child,old.project_id,old.project_version,old.snapshot,old.id]);
 const held=await fence.acquireSource(child);
 try{const result=await call('/runs/'+old.id+'/retry');assert.equal(result.status,200,JSON.stringify(result.data));assert.deepEqual(result.data,{id:child,existing:true});}
 finally{held.release();}
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[old.id])).rowCount,1);
});

// These must be last: uncertain outcomes intentionally keep native writer guards.
for(const kind of ['approve','retry'] as const)test(kind+' lost rollback acknowledgement retains target, discards connection and preserves original error',{skip:!isolated,timeout:20000},async()=>{
 const p=kind==='approve'?await project():await stopped(),before=lifetimeIds();let target='',inserts=0,rolls=0,commits=0,observed:unknown;
 const releases:{error:Error|boolean|undefined,client:pg.PoolClient}[]=[];
 const {AppError}=await import('../apps/api/src/provider.ts');
 const original=new AppError(409,'Original admission failure','ADMISSION_ORIGINAL_FAILURE');
 await intercept(async(text,args,next)=>{
  if(typeof text==='string'&&text.startsWith('INSERT INTO project_runs')){target=args[0][0];inserts++;}
  if(typeof text==='string'&&text.startsWith("UPDATE projects SET status='QUEUED'"))throw original;
  if(text==='COMMIT')commits++;
  const result=await next();
  if(text==='ROLLBACK'){rolls++;observed=await sourceProbe(target);throw Error('ADMISSION_ROLLBACK_ACK_LOST');}
  return result;
 },async()=>{
  const result=await call(kind==='approve'?'/projects/'+p.id+'/approve':'/runs/'+p.id+'/retry','POST',kind==='approve'?{version:p.version}:{});
  assert.equal(result.status,409,JSON.stringify(result.data));assert.equal(result.data.code,original.code);assert.equal(result.data.message,original.message);
 },()=>{},(error,client)=>releases.push({error,client}));
 assert.ok(target);assert.deepEqual([...lifetimeIds()].filter(id=>!before.has(id)),[target]);
 assert.equal(inserts,1);assert.equal(rolls,1);assert.equal(commits,0);assert.deepEqual(observed,{blocked:true},'guard is still held while rollback acknowledgement is lost');
 assert.equal(releases.length,1);assert.equal(releases[0].error,true,'uncertain rollback connection is discarded');
 const replacement=await pool.connect();try{assert.notEqual(replacement,releases[0].client,'the discarded physical client is not reused');}finally{replacement.release();}
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE id=$1',[target])).rowCount,0,'fixture completed the rollback, but the caller cannot prove that');
 await sourceProbe(target,true);assert.equal(existsSync(join(traceRoot,target)),false);
});

for(const kind of ['approve','retry'] as const)for(const outcome of ['before','after'] as const)test(kind+' COMMIT fails '+outcome+' backend execution and conservatively retains one target',{skip:!isolated,timeout:20000},async()=>{
 const p=kind==='approve'?await project():await stopped(),before=lifetimeIds();let target='',inserts=0,commits=0,rolls=0;
 await intercept(async(text,args,next)=>{
  if(typeof text==='string'&&text.startsWith('INSERT INTO project_runs')){target=args[0][0];inserts++;}
  if(text==='ROLLBACK')rolls++;
  if(text==='COMMIT'){commits++;if(outcome==='after')await next();throw Error('ADMISSION_COMMIT_OUTCOME_UNKNOWN');}
  return next();
 },async()=>{
  const result=await call(kind==='approve'?'/projects/'+p.id+'/approve':'/runs/'+p.id+'/retry','POST',kind==='approve'?{version:p.version}:{});
  assert.equal(result.status,500,JSON.stringify(result.data));
 });
 assert.ok(target);assert.deepEqual([...lifetimeIds()].filter(id=>!before.has(id)),[target]);assert.equal(inserts,1);assert.equal(commits,1);assert.equal(rolls,1);
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE id=$1',[target])).rowCount,outcome==='after'?1:0);
 await sourceProbe(target,true);assert.equal(existsSync(join(traceRoot,target)),false);
});

for(const kind of ['approve','retry'] as const)for(const outcome of ['before','after'] as const)test(kind+' existing child COMMIT fails '+outcome+' backend execution without releasing proposed target or acquiring child writer',{skip:!isolated,timeout:20000},async()=>{
 const old=await stopped(),child=kind==='retry'?randomUUID():old.id;
 if(kind==='retry')await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,parent_run_id) VALUES($1,$2,$3,'running',$4,2,$5)",[child,old.project_id,old.project_version,old.snapshot,old.id]);
 else await pool.query("UPDATE project_runs SET status='running' WHERE id=$1",[child]);
 const held=await fence.acquireSource(child),before=lifetimeIds();let inserts=0,commits=0,rolls=0;
 try{await intercept(async(text,_args,next)=>{
  if(typeof text==='string'&&text.startsWith('INSERT INTO project_runs'))inserts++;
  if(text==='ROLLBACK')rolls++;
  if(text==='COMMIT'){commits++;if(outcome==='after')await next();throw Error('ADMISSION_EXISTING_COMMIT_UNKNOWN');}
  return next();
 },async()=>{
  const result=await call(kind==='approve'?'/projects/'+old.project_id+'/approve':'/runs/'+old.id+'/retry','POST',kind==='approve'?{version:old.project_version}:{});
  assert.equal(result.status,500,JSON.stringify(result.data));
 });}finally{held.release();}
 const targets=[...lifetimeIds()].filter(id=>!before.has(id));assert.equal(targets.length,1,'one proposed UUID is admitted even when returning an existing child');assert.notEqual(targets[0],child);
 assert.equal(inserts,0);assert.equal(commits,1,'existing branch was reached while the old child source lock was held');assert.equal(rolls,1);
 assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[child])).rows[0].status,'running');
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE project_id=$1',[old.project_id])).rowCount,kind==='retry'?2:1);
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE id=$1',[targets[0]])).rowCount,0);
 await sourceProbe(targets[0],true);await sourceProbe(child,false);assert.equal(existsSync(join(traceRoot,targets[0])),false);
});
