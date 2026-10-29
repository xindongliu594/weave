import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use scripts/test-integration.mjs; no production DB fallback is allowed');
assert.ok(process.env.DATABASE_URL);
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='employee_history_'+Date.now();
let pool:pg.Pool,app:any,server:any,url:string,dir:string,emptyBackup:any;
async function call(path:string,method='GET',body?:any){const r=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json() as any};}
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const dbURL=new URL(base);dbURL.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=dbURL.toString();
 dir=await mkdtemp(join(tmpdir(),'employee-history-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdownBackground();await app.locals.ready;server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
 const exported=await call('/backup/export','POST',{password:'employee-history-backup'});assert.equal(exported.status,200,JSON.stringify(exported.data));emptyBackup=exported.data;
});
after(async()=>{await app?.locals.shutdown();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});
const manager={id:'manager',name:'经理',role:'manager',title:'协调经理',instructions:'协调任务',modelId:'',tools:[]};
const member={id:'member',name:'研究员',role:'member',title:'研究员',instructions:'查证资料',systemConstraints:'引用证据',outputFormat:'Markdown',modelId:'retained-model',fallbackModelId:'retained-fallback',tools:['knowledge_search'],knowledgeSpaceIds:['retained-private'],reasoningEffort:'high'};
async function department(){const {data}=await call('/departments','POST',{name:'可恢复部门',description:'保留部门说明',dailyBudget:3,agents:[manager,member]});return (await call('/departments')).data.find((d:any)=>d.id===data.id);}

test('removed employees restore complete role configuration with a new version, without changing existing projects',async()=>{
 const d=await department();
 assert.equal((await call('/departments/'+d.id,'PUT',{...d,agents:[d.agents[0],{...d.agents[1],instructions:'查证原始来源并逐条引用'}]})).status,200);
 const updated=(await call('/departments')).data.find((item:any)=>item.id===d.id);
 const created=await call('/projects','POST',{departmentId:d.id,requirement:'需要保留员工移除前的项目配置',policy:{maxBudget:1,maxAgents:2,maxConcurrentAgents:1,deadlineSeconds:300}});assert.equal(created.status,201);
 const original=(await call('/projects')).data.find((p:any)=>p.id===created.data.id);
 assert.equal((await call('/departments/'+d.id,'PUT',{...updated,agents:[updated.agents[0]]})).status,200);
 const history=(await call('/departments/'+d.id+'/removed-employees')).data;assert.equal(history.departmentVersion,3);assert.equal(history.employees.length,1);assert.equal(history.employees[0].sourceVersion,2);assert.equal(history.employees[0].agent.roleVersion,2);
 const restore={agentId:'member',sourceVersion:2,departmentVersion:3,role:'member'};
 const results=await Promise.all([call('/departments/'+d.id+'/restore-employee','POST',restore),call('/departments/'+d.id+'/restore-employee','POST',restore)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const restored=(await call('/departments')).data.find((item:any)=>item.id===d.id);assert.equal(restored.version,4);assert.equal(restored.dailyBudget,3);assert.equal(restored.description,d.description);
 assert.deepEqual(restored.agents.find((a:any)=>a.id==='member'),{...updated.agents[1],roleVersion:3});assert.equal(restored.agents.filter((a:any)=>a.role==='manager').length,1);
 assert.deepEqual((await call('/departments/'+d.id+'/removed-employees')).data.employees,[]);
 const current=(await call('/projects')).data.find((p:any)=>p.id===created.data.id);assert.deepEqual(current.plan,original.plan);assert.equal(current.version,original.version);
 const versions=(await call('/departments/'+d.id+'/versions')).data;assert.equal(versions.length,4);assert.equal(versions[1].data.agents.length,1);assert.equal(versions[0].data.agents.length,2);
 assert.ok((await call('/activity')).data.some((a:any)=>a.kind==='employee_restore'));
});

test('manager restoration explicitly changes the incumbent role and keeps exactly one manager',async()=>{
 const d=await department();assert.equal((await call('/departments/'+d.id,'PUT',{...d,agents:[{...d.agents[1],role:'manager'}]})).status,200);
 const history=(await call('/departments/'+d.id+'/removed-employees')).data;assert.equal(history.employees[0].agent.id,'manager');
 const result=await call('/departments/'+d.id+'/restore-employee','POST',{agentId:'manager',sourceVersion:1,departmentVersion:2,role:'manager'});assert.equal(result.status,200,JSON.stringify(result.data));
 const restored=(await call('/departments')).data.find((item:any)=>item.id===d.id);assert.equal(restored.agents.filter((a:any)=>a.role==='manager').length,1);assert.equal(restored.agents.find((a:any)=>a.id==='manager').roleVersion,2);assert.equal(restored.agents.find((a:any)=>a.id==='member').role,'member');assert.equal(restored.agents.find((a:any)=>a.id==='member').roleVersion,2);
 assert.equal((await call('/departments/'+d.id+'/restore-employee','POST',{agentId:'manager',sourceVersion:1,departmentVersion:restored.version,role:'manager'})).status,409);
});

test('capacity, archive, stale version and wrong source cannot overwrite current employees',async()=>{
 const d=await department();await call('/departments/'+d.id,'PUT',{...d,agents:[d.agents[0],...Array.from({length:5},(_,i)=>({...member,id:'new'+i}))]});
 const input={agentId:'member',sourceVersion:1,departmentVersion:2,role:'member'};
 assert.equal((await call('/departments/'+d.id+'/restore-employee','POST',input)).status,422);
 const full=(await call('/departments')).data.find((item:any)=>item.id===d.id);await call('/departments/'+d.id,'PUT',{...full,agents:[full.agents[0]]});
 assert.equal((await call('/departments/'+d.id+'/restore-employee','POST',input)).data.code,'VERSION_CONFLICT');
 assert.equal((await call('/departments/'+d.id+'/restore-employee','POST',{...input,departmentVersion:3,sourceVersion:99})).status,404);
 assert.equal((await call('/departments/'+d.id+'/restore-employee','POST',{...input,departmentVersion:3,agentId:'foreign-employee'})).status,404);
 assert.equal((await call('/departments/'+d.id+'/restore-employee','POST',{...input,departmentVersion:3})).status,200);
 const current=(await call('/departments')).data.find((item:any)=>item.id===d.id);assert.equal(current.version,4);assert.deepEqual(current.agents.find((a:any)=>a.id==='member'),{...member,roleVersion:2});
 assert.equal((await call('/departments/'+d.id,'DELETE',{version:4})).status,200);
 const archived=(await pool.query('SELECT * FROM departments WHERE id=$1',[d.id])).rows;
 const denied=await call('/departments/'+d.id+'/restore-employee','POST',{...input,departmentVersion:5});assert.equal(denied.status,404);assert.equal(denied.data.code,'RESOURCE_NOT_FOUND');
 assert.deepEqual((await pool.query('SELECT * FROM departments WHERE id=$1',[d.id])).rows,archived);
});

test('audited employee history blocks business-only export and restore without replacing current history or files',async()=>{
 // The v1 business format cannot preserve the audit emitted by employee changes.
 // A complete history round trip requires the separately planned enterprise format.
 await mkdir(join(dir,'runs'),{recursive:true});const marker=join(dir,'runs','employee-history-marker.txt');await writeFile(marker,'Current employee archive must survive rejected restore');
 const snapshot=async()=>({
  departments:(await pool.query('SELECT * FROM departments ORDER BY id')).rows,
  versions:(await pool.query('SELECT * FROM department_versions ORDER BY department_id,version')).rows,
  projects:(await pool.query('SELECT * FROM projects ORDER BY id')).rows,
  audits:(await pool.query('SELECT * FROM human_audit_events ORDER BY id')).rows,
  outbox:(await pool.query('SELECT * FROM audit_outbox ORDER BY id')).rows,
  files:(await readdir(dir)).sort(),marker:await readFile(marker,'utf8'),
 });
 const original=await snapshot();assert.ok(original.audits.some((row:any)=>row.action==='employee.restore'));assert.ok(original.versions.length>0);
 const exported=await call('/backup/export','POST',{password:'employee-history-backup'});assert.equal(exported.status,409,JSON.stringify(exported.data));assert.equal(exported.data.code,'BACKUP_SOURCE_IDENTITY_UNSUPPORTED');
 const restored=await call('/backup/restore','POST',{password:'employee-history-backup',backup:emptyBackup,confirmation:'RESTORE'});assert.equal(restored.status,409,JSON.stringify(restored.data));assert.equal(restored.data.code,'BACKUP_DESTINATION_PROTECTED');
 assert.deepEqual(await snapshot(),original);
});
