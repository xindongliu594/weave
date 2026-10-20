import {after,before,beforeEach,describe,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import pg from 'pg';

// Only the owned native runner enables this suite. PGlite is not lock evidence.
describe('cost maintenance native PostgreSQL tails',{skip:process.env.COST_TAIL_NATIVE!=='1',timeout:60000},()=>{
 let control:pg.Client,source:pg.Client,pool:pg.Pool,directory:string;
 let cost:typeof import('../apps/api/src/cost-control.ts'),reconciliation:typeof import('../apps/api/src/provider-reconciliation.ts');
 let sourcePid:number,writerClient:pg.PoolClient|undefined;
 const schema='cost_tail_'+randomUUID().replaceAll('-','');
 const gate=918275,pauseGate=918276;
 const operations=['expiry','stale-query'] as const;
 type Operation=typeof operations[number];
 const run=(operation:Operation)=>{
  if(operation==='expiry')return cost.expireReservations();
  const service=new reconciliation.ProviderReconciliationService();service.start();return service.close();
 };
 const rows=async(db:Pick<pg.Client,'query'>)=> (await db.query('SELECT id,project_id,status,amount::text,context,history FROM model_reservations ORDER BY id')).rows;
 async function until<T>(read:()=>Promise<T>,ready:(value:T)=>boolean,label:string):Promise<T>{
  const end=Date.now()+4000;
  do{const value=await read();if(ready(value))return value;await pause(10);}while(Date.now()<end);
  throw Error('Timed out observing '+label);
 }
 async function backendWait(){
  return until(async()=> (await control.query("SELECT pid,query,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'",[schema+'_writer'])).rows,
   value=>value.length===1,'original writer backend blocked by fixture trigger');
 }
 async function assertSourceWaiting(writerPid:number,done:()=>boolean){
  const evidence=await until(async()=> (await control.query('SELECT pid,granted,mode,pg_blocking_pids(pid) AS blockers FROM pg_locks WHERE locktype=\'advisory\' AND objid=$1 AND pid=$2',[gate,sourcePid])).rows,
   value=>done()||value.some(row=>!row.granted),'source exclusive advisory wait');
  assert.equal(done(),false,'exclusive source gate must wait for the original writer transaction');
  assert.ok(evidence.some(row=>!row.granted&&row.mode==='ExclusiveLock'&&row.blockers.includes(writerPid)));
  console.log(JSON.stringify({case:'source-wait',writerPid,sourcePid,locks:evidence}));
 }
 async function installPause(kind:'commit'|'rollback'){
  await control.query(`CREATE FUNCTION tail_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   PERFORM pg_advisory_xact_lock(${pauseGate});
   ${kind==='rollback'?"RAISE EXCEPTION 'TAIL_FIXTURE_ROLLBACK';":'RETURN NEW;'} END $$`);
  await control.query(kind==='commit'
   ?'CREATE CONSTRAINT TRIGGER tail_pause AFTER UPDATE ON model_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tail_pause()'
   :'CREATE TRIGGER tail_pause AFTER UPDATE ON model_reservations FOR EACH STATEMENT EXECUTE FUNCTION tail_pause()');
 }
 before(async()=>{
  assert.ok(process.env.COST_TAIL_FIXTURE_CONFIG,'owned fixture config required');
  const fixture=JSON.parse(await readFile(process.env.COST_TAIL_FIXTURE_CONFIG,'utf8'));
  assert.equal(fixture.kind,'weiwu-cost-tail-private-fixture-v1');assert.equal(fixture.state,'ready');assert.equal(fixture.host,'127.0.0.1');
  assert.match(fixture.id,/^[a-f0-9]{32}$/);assert.equal(fixture.user,'weiwu_cost_tail_test');assert.equal(fixture.database,'weiwu_cost_tail_test_'+fixture.id);
  assert.ok(Number.isInteger(fixture.port)&&fixture.port>0&&fixture.port<65536);
  const config={host:fixture.host,port:fixture.port,user:fixture.user,password:fixture.password,database:fixture.database,connectionTimeoutMillis:3000,statement_timeout:12000};
  control=new pg.Client({...config,application_name:schema+'_control'});await control.connect();
  const identity=(await control.query('SELECT current_database() AS db,current_user AS role,version() AS version')).rows[0];
  assert.equal(identity.db,fixture.database);assert.equal(identity.role,fixture.user);assert.match(identity.version,/PostgreSQL 17\./);
  await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path='+schema);
  await control.query(`CREATE TABLE model_capability_tests(id text PRIMARY KEY,status text,code text,created_at timestamptz,finished_at timestamptz);
   CREATE TABLE model_reservations(id text PRIMARY KEY,model_id text,project_id text,department_id text,run_id text,purpose text,amount numeric,input_rate numeric,output_rate numeric,
    status text DEFAULT 'pending',expires_at timestamptz DEFAULT now()+interval '5 minutes',created_at timestamptz DEFAULT now(),context jsonb DEFAULT '{}',history jsonb DEFAULT '[]');
   CREATE TABLE product_settings(id int PRIMARY KEY,data jsonb);INSERT INTO product_settings VALUES(1,'{"dailyBudgetLimit":10}');
   CREATE TABLE projects(id text PRIMARY KEY,policy jsonb,department_id text,version int);
   CREATE TABLE models(id text,data jsonb);CREATE TABLE gateways(id text,version int,data jsonb);`);
  source=new pg.Client({...config,application_name:schema+'_source',options:'-c search_path='+schema});await source.connect();
  sourcePid=(await source.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const url=new URL('postgresql://127.0.0.1');url.port=String(fixture.port);url.username=fixture.user;url.password=fixture.password;url.pathname='/'+fixture.database;
  url.searchParams.set('options','-c search_path='+schema+' -c statement_timeout=12000');url.searchParams.set('application_name',schema+'_writer');
  process.env.DATABASE_URL=url.href;
  directory=await mkdtemp(join(fixture.fixtureRoot,'test-'));process.env.DATA_DIR=directory;process.env.TRACE_ROOT=join(directory,'runs');
  ({pool}=await import('../apps/api/src/db.ts'));pool.options.max=3;pool.options.connectionTimeoutMillis=3000;
  pool.on('connect',client=>{client.on('error',()=>{});});pool.on('acquire',client=>{writerClient=client;});
  cost=await import('../apps/api/src/cost-control.ts');reconciliation=await import('../apps/api/src/provider-reconciliation.ts');
  console.log(JSON.stringify({fixture:'native-minimal-owned-schema',database:identity.db,version:identity.version,sourcePid,schema}));
 });
 beforeEach(async()=>{
  await control.query('DROP TRIGGER IF EXISTS tail_pause ON model_reservations;DROP FUNCTION IF EXISTS tail_pause();TRUNCATE model_reservations,model_capability_tests');
  await control.query("INSERT INTO model_capability_tests VALUES('old-probe','running',NULL,now()-interval '7 minutes',NULL)");
  const history=[{source:'historical',note:'synthetic retained evidence'}];
  for(const [id,project,amount] of [['a','project-a','0.11'],['b','project-b','0.23']]){
   await control.query("INSERT INTO model_reservations(id,project_id,amount,status,expires_at,context,history) VALUES($1,$2,$3,'pending',now()-interval '1 second',$4,$5)",
    [id,project,amount,{providerReconciliation:{status:'querying',checkedAt:'2001-01-01T00:00:00.000Z',attempts:3,token:'old'},billingQueryClaim:{token:'old'},privateEvidence:'retained'},JSON.stringify(history)]);
  }
 });
 after(async()=>{
  await source?.query('ROLLBACK').catch(()=>{});await control?.query('SELECT pg_advisory_unlock_all()').catch(()=>{});
  await pool?.end();await source?.end();if(control){await control.query('DROP SCHEMA '+schema+' CASCADE');await control.end();}
  if(directory)await rm(directory,{recursive:true,force:true});
 });
 for(const operation of operations){
  test(operation+' cannot mutate across projects while source owns exclusive gate',async()=>{
   if(operation==='stale-query')await control.query("UPDATE model_reservations SET status='uncertain'");
   const before=await rows(control);await source.query('BEGIN');await source.query('SELECT pg_advisory_xact_lock($1)',[gate]);
   let done=false;const work=run(operation).finally(()=>{done=true;});
   try{
    const evidence=await until(async()=> (await control.query("SELECT a.pid,a.query,l.granted,l.mode,pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name=$1 AND l.locktype='advisory' AND l.objid=$2",[schema+'_writer',gate])).rows,
     value=>done||value.some(row=>!row.granted),'writer shared wait');
    assert.equal(done,false,'cleanup must wait for source before the original UPDATE');assert.ok(evidence.some(row=>!row.granted&&row.mode==='ShareLock'&&row.blockers.includes(sourcePid)));
    assert.deepEqual(await rows(source),before);console.log(JSON.stringify({case:operation+'-exclusive-before',sourcePid,locks:evidence}));
   }finally{await source.query('ROLLBACK');await work;}
   assert.equal((await rows(control)).length,2);
  });
  for(const outcome of ['commit','rollback'] as const){
   test(operation+' keeps shared gate through original '+outcome+' across projects',async()=>{
    if(operation==='stale-query')await control.query("UPDATE model_reservations SET status='uncertain'");
    const before=await rows(control);await installPause(outcome);await control.query('SELECT pg_advisory_lock($1)',[pauseGate]);
    let workError:unknown;const work=run(operation).catch(error=>{workError=error;});let sourceDone=false;
    let barrier:Promise<unknown>|undefined;
    try{
     const [writer]=await backendWait();assert.ok(writer.blockers.length>0);assert.equal(writer.query.startsWith('COMMIT'),outcome==='commit');
     await source.query('BEGIN');barrier=source.query('SELECT pg_advisory_xact_lock($1)',[gate]).then(result=>{sourceDone=true;return result;});
     await assertSourceWaiting(writer.pid,()=>sourceDone);assert.deepEqual(await rows(control),before,'uncommitted UPDATE is not yet visible');
     await control.query('SELECT pg_advisory_unlock($1)',[pauseGate]);await work;await barrier;
     const after=await rows(source);
     if(outcome==='rollback'){
      assert.deepEqual(after,before);assert.equal((await source.query("SELECT status FROM model_capability_tests WHERE id='old-probe'")).rows[0].status,'running');
      if(operation==='expiry')assert.match(String(workError),/TAIL_FIXTURE_ROLLBACK/);
     }else{
      assert.equal(workError,undefined);
      for(const row of after){assert.equal(row.amount,row.id==='a'?'0.11':'0.23');assert.equal(row.status,'uncertain');assert.deepEqual(row.history[0],before[0].history[0]);
       assert.equal(row.history.length,2);assert.equal(row.context.privateEvidence,'retained');
       if(operation==='stale-query'){assert.equal(row.context.providerReconciliation.status,'unresolved');assert.equal(row.context.providerReconciliation.attempts,3);assert.equal(row.context.billingQueryClaim,undefined);}
      }
     }
     console.log(JSON.stringify({case:operation+'-'+outcome,writerPid:writer.pid,sourcePid,originalQuery:writer.query,rows:after}));
    }finally{
     await control.query('SELECT pg_advisory_unlock($1)',[pauseGate]);await work;await barrier;await source.query('ROLLBACK');
    }
   });
  }
  test(operation+' reconciles disconnected COMMIT from persisted state after SQL barrier without replay',async()=>{
   if(operation==='stale-query')await control.query("UPDATE model_reservations SET status='uncertain'");
   const before=await rows(control);await installPause('commit');await control.query('SELECT pg_advisory_lock($1)',[pauseGate]);
   let workError:unknown;const work=run(operation).catch(error=>{workError=error;});let sourceDone=false;let barrier:Promise<unknown>|undefined;
   try{
    const [writer]=await backendWait();assert.equal(writer.query,'COMMIT');
    await source.query('BEGIN');barrier=source.query('SELECT pg_advisory_xact_lock($1)',[gate]).then(result=>{sourceDone=true;return result;});
    await assertSourceWaiting(writer.pid,()=>sourceDone);
    assert.ok(writerClient);(writerClient as pg.PoolClient & Pick<pg.Client,'connection'>).connection.stream.destroy();await work;
    // A local socket failure proves neither commit nor rollback. Resolve the
    // original backend via the barrier, then inspect rather than repeat work.
    await control.query('SELECT pg_advisory_unlock($1)',[pauseGate]);await barrier;
    const after=await rows(source),committed=after.every(row=>row.history.length===2),rolledBack=JSON.stringify(after)===JSON.stringify(before);
    assert.ok(committed||rolledBack,'resolved original transaction must be atomic');
    for(const row of after)assert.equal(row.amount,row.id==='a'?'0.11':'0.23');
    if(operation==='expiry'){
     assert.equal((workError as Error)?.message,'Connection terminated unexpectedly','failed rollback must preserve the original COMMIT connection error');
     assert.equal(pool.totalCount,0,'the failed transaction connection must be discarded');
    }
    console.log(JSON.stringify({case:operation+'-disconnect-unknown',writerPid:writer.pid,sourcePid,localError:workError instanceof Error?workError.message:undefined,resolvedOutcome:committed?'committed':'rolled-back',rows:after}));
   }finally{await control.query('SELECT pg_advisory_unlock($1)',[pauseGate]);await work;await barrier;await source.query('ROLLBACK');}
  });
 }
 test('reserveCall internal expiry remains in its one shared admission transaction and rolls back on rejection',async()=>{
  pool.options.max=1;
  try{
   await assert.rejects(cost.reserveCall({model:{id:'absent',inputRate:0,outputRate:0},amount:0,purpose:'组织需求对话',accountingMode:'conversation',context:{probeId:'absent'}}),
    (error:any)=>error.code==='PROBE_EXPIRED');
   assert.ok((await rows(control)).every(row=>row.status==='pending'&&row.history.length===1));
   assert.equal((await control.query("SELECT status FROM model_capability_tests WHERE id='old-probe'")).rows[0].status,'running');
  }finally{pool.options.max=3;}
 });
});
