import {after,before,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:http';
import type pg from 'pg';
import type {Principal} from '../apps/api/src/identity-types.ts';
import {toolEvidence} from './model-fixture.ts';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use the isolated integration runner');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const policy={maxBudget:1,maxAgents:2,maxConcurrentAgents:2,deadlineSeconds:300};
const employee=(id='manager')=>({id,name:id,role:'manager',title:'负责人',instructions:'完成职责并核对结果',modelId:'model',tools:[],knowledgeSpaceIds:[]});
const department=(name:string)=>({name,description:'合成部门',dailyBudget:5,agents:[employee()]});
let db:pg.Pool,app:any,server:any,url:string,temporary:string;
const principal=(userId:string):Principal=>({kind:'human',userId,sessionId:userId+'-session',issuer:'https://fixture.example',subject:userId,orgRole:userId==='admin'?'admin':userId==='auditor'?'auditor':'member',sessionEpoch:0,authenticatedAt:new Date().toISOString()});
async function call(path:string,actor='operator',method='GET',body?:unknown,key?:string){
  const response=await fetch(url+path,{method,headers:{'content-type':'application/json','x-fixture-actor':actor,'x-csrf-token':'fixture-csrf',...(key?{'idempotency-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data:any;try{data=JSON.parse(text);}catch{data=text;}return {status:response.status,data};
}
async function grant(user:string,departmentId:string,role='operator',canApprove=false){await db.query('INSERT INTO department_memberships(user_id,department_id,role,can_approve) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,department_id) DO UPDATE SET role=$3,can_approve=$4,version=department_memberships.version+1',[user,departmentId,role,canApprove]);}
async function project(departments=[A],extraPlan:Record<string,unknown>={}){
  const id=randomUUID(),agents=departments.map((departmentId,index)=>({...employee(index?'collaborator':'manager'),role:index?'member':'manager',sourceDepartmentId:departmentId,sourceAgentId:'manager'}));
  const plan={agents,rationale:'合成测试',tasks:[{id:'deliver',subject:'核对明确内容并形成结果',objective:'完成内容核对',assigneeId:'manager',dependencies:[],acceptanceCriteria:['说明核对依据与结论'],estimatedInputTokens:100,estimatedOutputTokens:100}],...extraPlan};
  const {bindPolicy}=await import('../apps/api/src/execution-policy.ts'),bound=bindPolicy({...policy,allowedDepartmentIds:departments},agents as any,departments[0]);
  await db.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,'A','合成任务说明至少十个字符',$3,$4,'manual')",[id,departments[0],bound,plan]);
  await db.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)',[id,plan,bound]);return {id,plan,policy:bound};
}
before(async()=>{
  temporary=await mkdtemp(resolve('.superpowers/sdd/2026-10-23-enterprise-plugin-completion/project-fixture-'));process.env.DATA_DIR=temporary;process.env.TRACE_ROOT=join(temporary,'runs');process.env.OBSIDIAN_VAULT=join(temporary,'vault');process.env.WEIWU_AUTH_MODE='legacy-local';
  const database=await import('../apps/api/src/db.ts');db=database.pool;await database.migrate();
  await (await import('../apps/api/src/project-route-access.ts')).migrateProjectRoutes(db);
  const {createApp}=await import('../apps/api/src/app.ts'),{apiAccess}=await import('../apps/api/src/api-access.ts'),{idempotency}=await import('../apps/api/src/idempotency.ts');
  app=createApp();await app.locals.shutdownBackground();await app.locals.ready;
  // Replace only the authentication dependency in the existing API-gate slot. The production gate,
  // idempotency and every actual handler still execute; no test identity endpoint is added to product code.
  const position=app.router.stack.findIndex((layer:any)=>layer.handle===idempotency);assert.ok(position>0);
  app.router.stack[position-1].handle=apiAccess({authenticate:async(req:any)=>req.get('x-fixture-actor')?principal(req.get('x-fixture-actor')):null,csrf:(_req:any,_res:any,next:any)=>next()} as any,{mode:'legacy-local'});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}/api`;
});
after(async()=>{await app?.locals.shutdown();server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await db?.end();if(temporary){assert.ok(temporary.startsWith(resolve('.superpowers/sdd/2026-10-23-enterprise-plugin-completion')+sep+'project-fixture-'));await rm(temporary,{recursive:true,force:true});}});
beforeEach(async()=>{
  await db.query('TRUNCATE departments,human_users,models,gateways,request_keys,knowledge_spaces,work_file_snapshots CASCADE');
  await db.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)",[{name:'No network fixture',baseUrl:'http://127.0.0.1:1/v1'}]);
  await db.query("INSERT INTO models(id,data,status,capabilities) VALUES('model',$1,'available',$2)",[{name:'Fixture',gatewayId:'gateway',model:'fixture',inputRate:1,outputRate:1},toolEvidence]);
  await db.query('INSERT INTO departments(id,data) VALUES($1,$2),($3,$4)',[A,department('A'),B,department('B')]);
  for(const user of ['operator','manager','viewer','admin','auditor'])await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES($1,'https://fixture.example',$1,'active',$2)",[user,user==='admin'?'admin':user==='auditor'?'auditor':'member']);
  await grant('operator',A);await grant('manager',A,'manager');await grant('viewer',A,'viewer');
});

test('department, project pagination and workbench counts filter the whole collaboration scope before LIMIT',async()=>{
  const own=await project(),foreign=await project([A,B]);
  await db.query("INSERT INTO usage(id,model_id,project_id,department_id,input_tokens,output_tokens,cost,purpose) VALUES('own','model',$1,$3,0,0,0.1,'fixture'),('foreign','model',$2,$3,0,0,0.9,'fixture')",[own.id,foreign.id,A]);
  const list=await call('/projects?limit=1');assert.equal(list.status,200);assert.deepEqual(list.data.map((row:any)=>row.id),[own.id]);
  const departments=await call('/departments');assert.equal(departments.status,200);assert.deepEqual(departments.data.map((row:any)=>[row.id,row.runCount]),[[A,1]]);
  const board=await call(`/department-workbench?departmentId=${A}&limit=1`);assert.equal(board.status,200);assert.equal(board.data.summary.total,1);assert.equal(Number(board.data.summary.recordedCost),0.1);assert.equal(board.data.items[0].id,own.id);
  assert.equal((await call(`/projects/${foreign.id}/versions`)).status,404);assert.equal((await call('/projects','auditor')).status,403);
});
test('creating a real project checks every department and assigned budget before writing',async()=>{
  const body={departmentId:A,collaboratingAgents:[{departmentId:B,agentId:'manager'}],requirement:'由两个部门协作完成合成测试需求',policy};
  assert.equal((await call('/projects','operator','POST',body)).status,404);assert.equal((await db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count,0);
  await grant('operator',B);const saved=await call('/projects','operator','POST',body);assert.equal(saved.status,201,JSON.stringify(saved.data));
  assert.equal((await call('/projects','viewer','POST',{...body,collaboratingAgents:[]})).status,404);
  assert.equal((await call('/projects','operator','POST',{...body,policy:{...policy,maxBudget:6}})).status,403);
});

test('project creation locks every authorized department before reading the team, and rejects missing or archived configuration',async()=>{
  await grant('operator',B);const body={departmentId:B,collaboratingAgents:[{departmentId:A,agentId:'manager'}],requirement:'合成协作配置锁顺序回归需求',policy};
  const connect=db.connect,observed:Array<{sql:string;values:any[]}>=[];
  (db as any).connect=function(callback?:unknown){if(callback)return (connect as any).call(db,callback);return (async()=>{const client=await (connect as ()=>Promise<pg.PoolClient>).call(db),query=client.query,release=client.release;
    client.query=function(...args:any[]){observed.push({sql:String(args[0]),values:args[1]??[]});return (query as any).apply(client,args);} as any;
    client.release=function(...args:any[]){client.query=query;client.release=release;return (release as any).apply(client,args);};return client;})();};
  try{const saved=await call('/projects','operator','POST',body);assert.equal(saved.status,201,JSON.stringify(saved.data));}finally{db.connect=connect;}
  const lock=observed.findIndex(item=>item.sql.includes('FROM departments')&&item.sql.includes('ANY($1::text[])')&&item.sql.includes('FOR SHARE'));
  assert.ok(lock>=0,'all participating configuration rows must be locked');assert.deepEqual(observed[lock].values[0],[A,B]);
  assert.ok(lock<observed.findIndex(item=>item.sql.startsWith('SELECT * FROM departments')),'lock before reading the primary and collaborator data');
  await db.query('UPDATE departments SET deleted_at=now() WHERE id=$1',[A]);
  assert.equal((await call('/projects','operator','POST',body)).status,404);
  assert.equal((await call('/projects','operator','POST',{...body,collaboratingAgents:[{departmentId:randomUUID(),agentId:'manager'}]})).status,404);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count,1,'neither invalid configuration creates another project');
});
test('plan writes reject budget increases and recheck revoked collaboration before same-key cached success',async()=>{
  await grant('operator',B);const current=await project([A,B]);
  assert.equal((await call(`/projects/${current.id}/plan`,'operator','PUT',{version:1,plan:current.plan,policy:{...current.policy,maxBudget:2}})).status,403);
  const body={version:1,plan:{...current.plan,rationale:'已授权调整'}};
  const saved=await call(`/projects/${current.id}/plan`,'operator','PUT',body,'plan-key-123');assert.equal(saved.status,200,JSON.stringify(saved.data));
  await db.query('DELETE FROM department_memberships WHERE user_id=$1 AND department_id=$2',['operator',B]);
  assert.equal((await call(`/projects/${current.id}/plan`,'operator','PUT',body,'plan-key-123')).status,404);
  assert.equal((await db.query('SELECT version FROM projects WHERE id=$1',[current.id])).rows[0].version,2);
});
test('human managers may edit local descriptions but cannot add budget or model/tool grants',async()=>{
  const body={...department('A'),version:1,description:'更新合成职责说明'};
  const saved=await call(`/departments/${A}`,'manager','PUT',body);assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal((await call(`/departments/${A}`,'manager','PUT',{...body,version:2,dailyBudget:6})).status,403);
  assert.equal((await call(`/departments/${A}`,'manager','PUT',{...body,version:2,agents:[{...employee(),tools:['terminal']}]})).status,403);
  assert.equal((await call(`/departments/${A}`,'operator','PUT',{...body,version:2})).status,404);
  assert.equal((await db.query('SELECT version FROM departments WHERE id=$1',[A])).rows[0].version,2);
});
test('approval checks every can_approve and persists the actual human authority plus same-transaction audit',async()=>{
  await grant('operator',A,'operator',true);await grant('operator',B,'operator',false);const current=await project([A,B]);
  assert.equal((await call(`/projects/${current.id}/approve`,'operator','POST',{version:1})).status,404);
  await grant('operator',B,'operator',true);
  const approved=await call(`/projects/${current.id}/approve`,'operator','POST',{version:1,authorizedBy:'admin',authorizedEpoch:999},'approve-key-123');assert.equal(approved.status,202,JSON.stringify(approved.data));
  const run=(await db.query('SELECT * FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];
  assert.equal(run.requested_by_user_id,'operator');assert.equal(run.authorized_by_user_id,'operator');assert.equal(Number(run.authorized_epoch),0);assert.equal(run.authority_kind,'human');assert.deepEqual(run.authority_department_ids,[A,B]);
  assert.deepEqual(run.source_bounds,{requiredDepartmentIds:[A,B],adminOnly:false,private:false,refs:[]});
  const audit=(await db.query("SELECT actor_user_id,run_id,authority_evidence FROM human_audit_events WHERE action='project.approve' AND resource_id=$1",[current.id])).rows[0];assert.equal(audit.actor_user_id,'operator');assert.equal(audit.run_id,run.id);assert.equal(audit.authority_evidence.membershipVersions.length,2);
  await db.query('DELETE FROM department_memberships WHERE user_id=$1 AND department_id=$2',['operator',B]);
  assert.equal((await call(`/projects/${current.id}/approve`,'operator','POST',{version:1,authorizedBy:'admin',authorizedEpoch:999},'approve-key-123')).status,404);
});
test('failed business audit rolls back approval and source-free plan updates',async()=>{
  await grant('operator',A,'operator',true);const current=await project();
  // Same narrow persistence-failure seam as run-transaction-fixture.ts: this PGlite
  // socket emits trailing commandComplete after SQL RAISE. BEGIN and ROLLBACK stay real.
  const connect=db.connect;let injected=0;
  (db as any).connect=function(callback?:unknown){if(callback)return (connect as any).call(db,callback);return (async()=>{const client=await (connect as ()=>Promise<pg.PoolClient>).call(db),query=client.query,release=client.release;
    client.query=function(...args:any[]){if(/INSERT INTO human_audit_events/.test(String(args[0]))){injected++;throw Error('fixture audit failure');}return (query as any).apply(client,args);} as any;
    client.release=function(...args:any[]){client.query=query;client.release=release;return (release as any).apply(client,args);};return client;})();};
  try{
    assert.equal((await call(`/projects/${current.id}/plan`,'operator','PUT',{version:1,plan:{...current.plan,rationale:'rollback'}})).status,500);
    assert.equal((await call(`/projects/${current.id}/approve`,'operator','POST',{version:1})).status,500);
    db.connect=connect;
    assert.equal((await db.query('SELECT count(*)::int AS count FROM project_runs')).rows[0].count,0);assert.deepEqual((await db.query('SELECT version,status FROM projects WHERE id=$1',[current.id])).rows[0],{version:1,status:'DRAFT'});
    assert.equal(injected,2);
  }finally{db.connect=connect;}
});
test('unknown run lineage and input-bearing historical plans cannot leak through project lists or versions',async()=>{
  const clean=await project(),legacy=await project(),privatePlan=await project([A],{runInputs:[{id:'private',title:'private',content:'private body',agentIds:['manager']}]});
  await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids) VALUES($1,$2,1,'completed','{}',$3)",[randomUUID(),legacy.id,[A]]);
  const response=await call('/projects');assert.equal(response.status,200);assert.deepEqual(response.data.map((row:any)=>row.id),[clean.id]);
  for(const id of [legacy.id,privatePlan.id])assert.equal((await call(`/projects/${id}/versions`)).status,404);
  assert.equal((await call(`/projects/${clean.id}/plan`,'operator','PUT',{version:1,plan:{...clean.plan,runInputs:[{id:'private',title:'private',content:'body',agentIds:['manager']}]}})).status,403);
  assert.equal((await call(`/projects/${privatePlan.id}/versions`,'admin')).status,200);
});
test('queued manager messages retain current authority and a revoked sender cannot replay or trigger a model call',async()=>{
  await grant('operator',B);const current=await project([A,B]);const body={version:1,content:'请核对合成需求'};
  const sent=await call(`/projects/${current.id}/messages`,'operator','POST',body,'message-key-123');assert.equal(sent.status,202,JSON.stringify(sent.data));
  const row=(await db.query('SELECT * FROM manager_messages WHERE id=$1',[sent.data.id])).rows[0];assert.equal(row.authorized_by_user_id,'operator');assert.deepEqual(row.authority_department_ids,[A,B]);
  await db.query('DELETE FROM department_memberships WHERE user_id=$1 AND department_id=$2',['operator',B]);
  assert.equal((await call(`/projects/${current.id}/messages`,'operator','POST',body,'message-key-123')).status,404);
  const {ManagerChatService}=await import('../apps/api/src/manager-chat.ts');const service=new ManagerChatService(db);await service.tick();await service.close();
  const result=(await db.query('SELECT status,error FROM manager_messages WHERE id=$1',[sent.data.id])).rows[0];assert.equal(result.status,'failed');assert.match(result.error,/授权|访问/);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM model_reservations')).rows[0].count,0);
});
test('member run list and cancellation use durable source bounds and current operator authority',async()=>{
  await grant('operator',A,'operator',true);const current=await project();const approved=await call(`/projects/${current.id}/approve`,'operator','POST',{version:1});assert.equal(approved.status,202);
  const runs=await call('/runs');assert.equal(runs.status,200);assert.deepEqual(runs.data.map((run:any)=>run.id),[approved.data.id]);assert.equal(runs.data[0].snapshot,undefined);
  assert.equal((await call(`/runs/${approved.data.id}/cancel`,'viewer','POST',{})).status,404);
  const cancelled=await call(`/runs/${approved.data.id}/cancel`,'operator','POST',{});assert.equal(cancelled.status,202,JSON.stringify(cancelled.data));
  assert.equal((await db.query('SELECT status FROM project_runs WHERE id=$1',[approved.data.id])).rows[0].status,'cancelled');
  assert.equal((await db.query("SELECT actor_user_id FROM human_audit_events WHERE action='run.cancel' AND resource_id=$1",[approved.data.id])).rows[0].actor_user_id,'operator');
  assert.equal((await call(`/runs/${approved.data.id}`)).status,403,'archive/body details are still closed');
});

test('owned planning quotes and confirmation are scoped and audit the human, without a model request',async()=>{
  const current=await project(),foreign=await project([A,B]);
  const query='?modelId=model&version=1&maxPlanningCost=0.02';
  assert.equal((await call(`/projects/${current.id}/planning-quote${query}`)).status,200);
  assert.equal((await call(`/projects/${foreign.id}/planning-quote${query}`)).status,404);
  const {planningProjectFingerprint}=await import('../apps/api/src/project-planning.ts'),row=(await db.query('SELECT * FROM projects WHERE id=$1',[current.id])).rows[0],previewId=randomUUID();
  await db.query('INSERT INTO organization_previews(id,data,project_id) VALUES($1,$2,$3)',[previewId,{kind:'project-plan',projectId:current.id,baseVersion:1,baseFingerprint:planningProjectFingerprint(row),plan:{...current.plan,rationale:'候选已核对'},policy:current.policy},current.id]);
  const input={previewId,version:1};assert.equal((await call(`/projects/${current.id}/generated-plan/confirm`,'viewer','POST',input)).status,404);
  const saved=await call(`/projects/${current.id}/generated-plan/confirm`,'operator','POST',input);assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal((await db.query("SELECT actor_user_id FROM human_audit_events WHERE action='project.plan'")).rows[0].actor_user_id,'operator');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM model_reservations')).rows[0].count,0);
});

test('planning admission rejects an epoch revoked after preparation before reserving or dispatching to the provider',async()=>{
  const current=await project();let dispatched=0;
  const provider=createServer((_req,res)=>{dispatched++;res.writeHead(500);res.end();});provider.listen(0,'127.0.0.1');await once(provider,'listening');
  try{
    await db.query("UPDATE gateways SET data=jsonb_set(data,'{baseUrl}',$1::jsonb) WHERE id='gateway'",[JSON.stringify(`http://127.0.0.1:${(provider.address() as any).port}/v1`)]);
    const actor=principal('operator');await db.query("UPDATE human_users SET session_epoch=1 WHERE id='operator'");
    const {completeBudgeted}=await import('../apps/api/src/cost-control.ts'),{lockProjectAuthority}=await import('../apps/api/src/project-route-access.ts');
    await assert.rejects(completeBudgeted({id:'model',name:'Fixture',model:'fixture',gatewayId:'gateway',inputRate:1,outputRate:1} as any,[{role:'user',content:'synthetic'}],10,{purpose:'组织规划',projectId:current.id,projectVersion:1,maxCost:1,authorize:async(db,row)=>{await lockProjectAuthority(db,actor,row);}}),(error:any)=>error.status===404);
    assert.equal(dispatched,0);assert.equal((await db.query('SELECT count(*)::int AS count FROM model_reservations')).rows[0].count,0);
  }finally{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});

test('AI employee history restore is manager-scoped, does not create human membership and cannot revive additional grants',async()=>{
  const former={...employee('former'),role:'member'},privileged={...employee('privileged'),role:'member',tools:['terminal']};
  await db.query('INSERT INTO department_versions(department_id,version,data) VALUES($1,7,$2)',[A,{...department('A'),agents:[employee(),former,privileged]}]);
  assert.equal((await call(`/departments/${A}/removed-employees`,'operator')).status,404);
  const history=await call(`/departments/${A}/removed-employees`,'manager');assert.equal(history.status,200);
  assert.deepEqual(history.data.employees.map((row:any)=>row.agent.id),['former']);
  const body={agentId:'former',sourceVersion:7,departmentVersion:1,role:'member'};
  const saved=await call(`/departments/${A}/restore-employee`,'manager','POST',body);assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal((await call(`/departments/${A}/restore-employee`,'manager','POST',{...body,agentId:'privileged',departmentVersion:2})).status,403);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM human_users')).rows[0].count,5);
  assert.equal((await db.query("SELECT actor_user_id FROM human_audit_events WHERE action='employee.restore'")).rows[0].actor_user_id,'manager');
});

test('project and run reservations acquire authority before the cost-policy lock, using the single locked resource row',async()=>{
  const current=await project(),runId=randomUUID();
  await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids) VALUES($1,$2,1,'running','{}',$3)",[runId,current.id,[A]]);
  const {reserveCall}=await import('../apps/api/src/cost-control.ts'),connect=db.connect.bind(db);
  for(const running of [false,true]){
    const queries:string[]=[];let seen:any;const stop=Error('fixture stop before cost lock');
    (db as any).connect=async()=>{const client=await connect(),query=client.query,release=client.release;client.query=function(...args:any[]){queries.push(String(args[0]));return (query as any).apply(client,args);} as any;client.release=function(...args:any[]){client.query=query;client.release=release;return (release as any).apply(client,args);};return client;};
    try{await assert.rejects(reserveCall({model:{id:'model',inputRate:1,outputRate:1},amount:0.001,purpose:'fixture',projectId:current.id,...(running?{runId}:{}),authorize:async(_client,row)=>{seen=row;throw stop;}}),error=>error===stop);}
    finally{db.connect=connect as any;}
    assert.equal(seen.id,running?runId:current.id);assert.equal(queries.some(sql=>/product_settings.*FOR UPDATE|cost_policy.*FOR UPDATE/i.test(sql)),false,queries.join('\n'));
    assert.equal(queries.filter(sql=>/SELECT \* FROM project_runs.*FOR UPDATE/.test(sql)).length,running?1:0);
  }
});

test('retry creates a new human approval and inherited source record, leaving the original authorization immutable',async()=>{
  await grant('operator',A,'operator',true);const current=await project();const approved=await call(`/projects/${current.id}/approve`,'operator','POST',{version:1});assert.equal(approved.status,202);
  const original=(await db.query('SELECT * FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];
  const {createRunArchive}=await import('../services/agent-runtime/trace-store.mjs');createRunArchive(join(temporary,'runs'),original.snapshot,{id:original.id});
  await db.query("UPDATE project_runs SET status='cancelled' WHERE id=$1",[original.id]);
  await grant('manager',A,'manager',true);
  const check=await call(`/runs/${original.id}/recovery-check`,'manager');assert.equal(check.status,200,JSON.stringify(check.data));
  const retry=await call(`/runs/${original.id}/retry`,'manager','POST',{resume:false},'retry-key-123');assert.equal(retry.status,202,JSON.stringify(retry.data));
  const child=(await db.query('SELECT * FROM project_runs WHERE id=$1',[retry.data.id])).rows[0];
  assert.equal(child.authorized_by_user_id,'manager');assert.equal(child.requested_by_user_id,'manager');assert.equal(Number(child.authorized_epoch),0);assert.equal(child.parent_run_id,original.id);
  assert.ok(child.source_bounds.refs.some((ref:any)=>ref.kind==='run'&&ref.id===original.id));assert.deepEqual(child.source_bounds.requiredDepartmentIds,[A]);
  assert.equal((await db.query('SELECT authorized_by_user_id FROM project_runs WHERE id=$1',[original.id])).rows[0].authorized_by_user_id,'operator');
  assert.equal((await db.query("SELECT actor_user_id FROM human_audit_events WHERE action='run.recover' AND resource_id=$1",[child.id])).rows[0].actor_user_id,'manager');
  assert.ok((await call('/runs','manager')).data.some((row:any)=>row.id===child.id));
  await db.query("UPDATE human_users SET session_epoch=1 WHERE id='manager'");
  assert.equal((await call(`/runs/${original.id}/retry`,'manager','POST',{resume:false},'retry-key-123')).status,404);
  assert.equal((await call(`/runs/${original.id}/resource-proposal`,'operator','POST',{modelId:'model',maxBudget:2,maxPlanningCost:0.01})).status,403);
});

test('cancellation rechecks revoked authority, rolls back and releases its writer so a valid actor can cancel',async()=>{
  await grant('operator',A,'operator',true);const current=await project(),approved=await call(`/projects/${current.id}/approve`,'operator','POST',{version:1});assert.equal(approved.status,202);
  const {requireRunRoute,lockProjectAuthority}=await import('../apps/api/src/project-route-access.ts'),actor=principal('operator');
  await requireRunRoute(db,actor,approved.data.id,'operator'); // The HTTP precheck succeeded.
  await db.query("UPDATE human_users SET session_epoch=1 WHERE id='operator'");
  const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts'),{createArchiveWriterManager}=await import('../services/agent-runtime/archive-writer-scope.mjs');
  const writers=createArchiveWriterManager({traceRoot:join(temporary,'runs')}),coordinator=Object.assign(Object.create(RunCoordinator.prototype),{writers,active:new Map()}) as InstanceType<typeof RunCoordinator>;
  await assert.rejects(coordinator.cancel(approved.data.id,async(client,row)=>{const project=(await client.query('SELECT * FROM projects WHERE id=$1',[row.project_id])).rows[0];await lockProjectAuthority(client,actor,project);}),(error:any)=>error.status===404);
  assert.equal((await db.query('SELECT status FROM project_runs WHERE id=$1',[approved.data.id])).rows[0].status,'queued');
  const {createArchiveWriteFence}=await import('../services/agent-runtime/archive-write-fence.mjs'),fence=createArchiveWriteFence({traceRoot:writers.traceRoot,lockRoot:writers.lockRoot});
  const maintenance=await fence.acquireMaintenance([approved.data.id],{timeoutMs:100});maintenance.release();
  const cancelled=await call(`/runs/${approved.data.id}/cancel`,'admin','POST',{});assert.equal(cancelled.status,202,JSON.stringify(cancelled.data));
});

test('a cancellation rollback failure preserves the authorization error and keeps the writer fenced',async()=>{
  const current=await project(),id=randomUUID();await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids) VALUES($1,$2,1,'queued','{}',$3)",[id,current.id,[A]]);
  const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts'),{createArchiveWriterManager}=await import('../services/agent-runtime/archive-writer-scope.mjs'),{AppError}=await import('../apps/api/src/provider.ts');
  const writers=createArchiveWriterManager({traceRoot:join(temporary,'runs')}),coordinator=Object.assign(Object.create(RunCoordinator.prototype),{writers,active:new Map()}) as InstanceType<typeof RunCoordinator>,denial=new AppError(404,'fixture revoked');
  const connect=db.connect;
  (db as any).connect=async()=>{const client=await (connect as ()=>Promise<pg.PoolClient>).call(db),query=client.query,release=client.release;
    client.query=function(...args:any[]){if(args[0]==='ROLLBACK')throw Error('fixture rollback unavailable');return (query as any).apply(client,args);} as any;
    client.release=function(...args:any[]){client.query=query;client.release=release;return (release as any).apply(client,args);};return client;};
  try{await assert.rejects(coordinator.cancel(id,async()=>{throw denial;}),error=>error===denial);}finally{db.connect=connect;await db.query('ROLLBACK');}
  const {createArchiveWriteFence}=await import('../services/agent-runtime/archive-write-fence.mjs'),fence=createArchiveWriteFence({traceRoot:writers.traceRoot,lockRoot:writers.lockRoot});
  await assert.rejects(fence.acquireMaintenance([id],{timeoutMs:100}),(error:any)=>error.code==='E_ARCHIVE_FENCE_TIMEOUT');
});

test('organization updates lock project then department then cost policy and still reject active collaboration',async()=>{
  const current=await project(),previewId=randomUUID(),data=department('A revised'),plan={...current.plan,agents:data.agents};
  await db.query('INSERT INTO organization_previews(id,data) VALUES($1,$2)',[previewId,{source:'template'}]);
  const input={department:data,requirement:'合成组织配置变更锁顺序回归',policy,plan,previewId,target:{departmentId:A,projectId:current.id,departmentVersion:1,projectVersion:1}};
  const connect=db.connect,observed:string[]=[];
  (db as any).connect=function(callback?:unknown){if(callback)return (connect as any).call(db,callback);return (async()=>{const client=await (connect as ()=>Promise<pg.PoolClient>).call(db),query=client.query,release=client.release;
    client.query=function(...args:any[]){observed.push(String(args[0]));return (query as any).apply(client,args);} as any;
    client.release=function(...args:any[]){client.query=query;client.release=release;return (release as any).apply(client,args);};return client;})();};
  try{const saved=await call('/organizations','admin','POST',input);assert.equal(saved.status,200,JSON.stringify(saved.data));}finally{db.connect=connect;}
  const projectLock=observed.findIndex(sql=>/FROM projects WHERE.*FOR UPDATE/.test(sql)),departmentLock=observed.findIndex(sql=>/FROM departments WHERE.*FOR UPDATE/.test(sql)),costLock=observed.findIndex(sql=>/FROM product_settings WHERE.*FOR UPDATE/.test(sql));
  assert.ok(projectLock>=0&&departmentLock>projectLock&&costLock>departmentLock,observed.join('\n'));
  const other=await project([B]);await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids) VALUES($1,$2,1,'queued',$3,$4)",[randomUUID(),other.id,{departmentId:B,departmentIds:[A,B]},[A,B]]);
  const nextPreview=randomUUID();await db.query('INSERT INTO organization_previews(id,data) VALUES($1,$2)',[nextPreview,{source:'template'}]);
  const rejected=await call('/organizations','admin','POST',{...input,previewId:nextPreview,target:{...input.target,departmentVersion:2,projectVersion:2}});
  assert.equal(rejected.status,409);assert.equal(rejected.data.code,'DEPARTMENT_ACTIVE');assert.equal((await db.query('SELECT version FROM departments WHERE id=$1',[A])).rows[0].version,2);
});

test('member plan edits cannot add or borrow another employee browser, MCP or model grants',async()=>{
  await grant('operator',B);
  await db.query("INSERT INTO models(id,data,status) SELECT 'second-model',data,'available' FROM models WHERE id='model'");
  const current=await project([A,B]),before={...current.plan,agents:current.plan.agents.map((agent:any,index:number)=>({...agent,modelId:index?'second-model':'model',tools:['browser_read','mcp_call_readonly'],browserOrigins:[`https://${index?'b':'a'}.example`],mcpConnections:[{connectionId:index?'connection-b':'connection-a',version:1,tools:['read']}]}))};
  const {bindPolicy}=await import('../apps/api/src/execution-policy.ts'),bound=bindPolicy({...policy,allowedDepartmentIds:[A,B]},before.agents as any,A);
  await db.query('UPDATE projects SET plan=$1,policy=$2 WHERE id=$3',[before,bound,current.id]);await db.query('UPDATE plan_versions SET plan=$1,policy=$2 WHERE project_id=$3',[before,bound,current.id]);
  const changes=[{browserOrigins:['https://new.example']},{browserOrigins:['https://b.example']},
    {mcpConnections:[{connectionId:'connection-b',version:1,tools:['read']}]},{mcpConnections:[{connectionId:'connection-a',version:2,tools:['read']}]},
    {mcpConnections:[{connectionId:'connection-a',version:1,tools:['write']}]},{modelId:'second-model'}];
  for(const change of changes){const result=await call(`/projects/${current.id}/plan`,'operator','PUT',{version:1,plan:{...before,agents:before.agents.map((agent:any,index:number)=>index?agent:{...agent,...change})}});assert.equal(result.status,403,JSON.stringify({change,result}));}
  assert.equal((await db.query('SELECT version FROM projects WHERE id=$1',[current.id])).rows[0].version,1);assert.equal((await db.query('SELECT count(*)::int AS count FROM human_audit_events')).rows[0].count,0);
  const narrowed={...before,agents:before.agents.map((agent:any,index:number)=>index?agent:{...agent,instructions:'合法职责调整',browserOrigins:[],mcpConnections:[]})};
  assert.equal((await call(`/projects/${current.id}/plan`,'operator','PUT',{version:1,plan:narrowed})).status,200);
  const administrative={...before,agents:before.agents.map((agent:any,index:number)=>index?agent:{...agent,browserOrigins:['https://admin-approved.example']})};
  assert.equal((await call(`/projects/${current.id}/plan`,'admin','PUT',{version:2,plan:administrative})).status,200);
});

test('fixed historical plan and run departments constrain versions, pagination and workbench before current scope can shrink',async()=>{
  const clean=await project(),historical=await project([A,B]);
  await db.query("UPDATE plan_versions SET plan=jsonb_set(plan,'{agents,1,instructions}','\"ONLY_B_INSTRUCTION_MARKER\"') WHERE project_id=$1",[historical.id]);
  const approval=await call(`/projects/${historical.id}/approve`,'admin','POST',{version:1});assert.equal(approval.status,202,JSON.stringify(approval.data));
  await db.query("UPDATE project_runs SET status='cancelled' WHERE id=$1",[approval.data.id]);
  const {bindPolicy}=await import('../apps/api/src/execution-policy.ts'),currentPlan={...historical.plan,agents:[historical.plan.agents[0]]},currentPolicy=bindPolicy({...policy,allowedDepartmentIds:[A]},currentPlan.agents as any,A);
  await db.query("UPDATE projects SET version=2,plan=$1,policy=$2,status='DRAFT',created_at=now()+interval '1 second' WHERE id=$3",[currentPlan,currentPolicy,historical.id]);await db.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,2,$2,$3)',[historical.id,currentPlan,currentPolicy]);
  assert.equal((await call(`/projects/${historical.id}/versions`)).status,404);
  assert.deepEqual((await call('/projects?limit=1')).data.map((row:any)=>row.id),[clean.id]);
  const board=await call(`/department-workbench?departmentId=${A}`);assert.equal(board.data.summary.total,1);assert.deepEqual(board.data.items.map((row:any)=>row.id),[clean.id]);
  assert.deepEqual((await call('/runs')).data,[]);
  await grant('operator',B,'viewer');
  const visible=await call(`/projects/${historical.id}/versions`);assert.equal(visible.status,200);assert.equal(visible.data.find((row:any)=>row.version===1).plan.agents[1].instructions,'ONLY_B_INSTRUCTION_MARKER');
  assert.ok((await call('/runs')).data.some((row:any)=>row.id===approval.data.id),'historical run is authorized by its fixed plan version, not the new A-only plan');
  const laundered=await call(`/projects/${historical.id}/approve`,'admin','POST',{version:2});assert.equal(laundered.status,422,JSON.stringify(laundered.data));assert.equal(laundered.data.code,'SOURCE_BOUNDS_INVALID');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM project_runs WHERE project_id=$1',[historical.id])).rows[0].count,1);
  await db.query('UPDATE plan_versions SET policy=NULL WHERE project_id=$1 AND version=1',[historical.id]);
  assert.equal((await call(`/projects/${historical.id}/versions`)).status,404);assert.equal((await call(`/projects/${historical.id}/versions`,'admin')).status,200);
});
