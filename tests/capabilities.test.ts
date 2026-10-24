import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='capabilities_'+Date.now();
let pool:pg.Pool,app:any,server:any,gateway:any,url:string,dir:string,modelId:string,gatewayId:string,requests=0,mode='ok';
let release:(()=>void)|undefined;
async function call(path:string,method='GET',body?:any){const r=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json() as any};}
const model=async()=>(await call('/models')).data.find((m:any)=>m.id===modelId);
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const dbURL=new URL(base);dbURL.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=dbURL.toString();
 dir=await mkdtemp(join(tmpdir(),'capabilities-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdownBackground();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
 gateway=http.createServer(async(req:any,res:any)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests++;
  let message:any={content:'OK'};
  if(body.tools){
   const nonce=body.tools[0].function.parameters.properties.nonce.enum[0];
   if(mode==='hold')await new Promise<void>(r=>{release=r;});
   if(mode==='changed')await pool.query("UPDATE models SET version=version+1,data=data||'{\"name\":\"Changed\"}'::jsonb,capabilities='{}' WHERE id=$1",[modelId]);
   message=mode==='no-tools'?{content:'I cannot call tools'}:{tool_calls:[{id:'probe-call',type:'function',function:{name:'capability_probe',arguments:JSON.stringify({nonce:mode==='bad-args'?'incorrect':nonce})}}]};
  }else if(body.messages.some((m:any)=>m.role==='tool'))message={content:mode==='bad-result'?'incorrect':JSON.parse(body.messages.find((m:any)=>m.role==='tool').content).result};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message}],...(mode==='no-usage'?{}:{usage:{prompt_tokens:10,completion_tokens:5}})}));
 });gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 gatewayId=(await call('/gateways','POST',{name:'Fixture',baseUrl:'http://127.0.0.1:'+gateway.address().port+'/v1'})).data.id;
 modelId=(await call('/models','POST',{gatewayId,name:'Fixture',model:'fixture',inputRate:1,outputRate:2,capabilities:{tools:{status:'supported'}}})).data.id;
 assert.deepEqual((await model()).capabilities,{},'clients cannot declare a successful capability probe');
});
beforeEach(async()=>{await pool.query("UPDATE models SET status='available',capabilities='{}',version=version+1 WHERE id=$1",[modelId]);requests=0;mode='ok';release=undefined;});
after(async()=>{release?.();await app?.locals.shutdown();for(const s of[server,gateway])if(s)await new Promise<void>(r=>s.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});

test('only a complete tool roundtrip enables execution; evidence, cost and route revision are retained',async()=>{
 const agent={id:'manager',role:'manager',name:'经理',title:'经理',instructions:'协调任务',modelId,tools:[]};
 const department=(await call('/departments','POST',{name:'Capability fixture',description:'',agents:[agent]})).data;
 const project=(await call('/projects','POST',{departmentId:department.id,requirement:'验证团队调度需要工具调用能力',policy:{maxBudget:1,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300}})).data;
 assert.equal((await call('/projects/'+project.id+'/approve','POST',{version:1})).data.code,'PLAN_NOT_READY');assert.equal(requests,0);
 const draft=(await call('/projects')).data.find((item:any)=>item.id===project.id);
 const plan={...draft.plan,tasks:draft.plan.tasks.map((task:any)=>({...task,subject:'核对工具能力验证的请求和回执',objective:'整理测试请求、工具结果与费用回执的对应关系',kind:'requirements',acceptanceCriteria:['每个工具能力请求都有对应结果与费用回执']}))};
 assert.equal((await call('/projects/'+project.id+'/plan','PUT',{version:1,plan})).status,200);
 const checked=await call('/models/'+modelId+'/test-tools','POST',{});assert.equal(checked.status,200,JSON.stringify(checked.data));assert.equal(requests,2);
 const current=await model();assert.equal(current.capabilities.tools.status,'supported');assert.equal(current.status,'available');
 const history=(await call('/models/'+modelId+'/capability-tests')).data[0];assert.equal(history.id,current.capabilities.tools.testId);assert.equal(history.status,'supported');assert.equal(history.requestIds.length,2);
 const receipts=(await pool.query("SELECT status FROM model_reservations WHERE context->>'probeId'=$1",[history.id])).rows;assert.ok(receipts.every(r=>r.status==='settled'));assert.equal((await pool.query('SELECT id FROM usage WHERE id=ANY($1::text[])',[history.requestIds])).rowCount,2);
 const approved=await call('/projects/'+project.id+'/approve','POST',{version:2});assert.equal(approved.status,202,JSON.stringify(approved.data));
 const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[approved.data.id])).rows[0].snapshot;assert.equal(snapshot.modelRoutes[0].toolCapabilityTestId,history.id);assert.equal(snapshot.modelRoutes[0].configurationHash.length,64);
 // A stopped approved-run fixture needs its original archive for goal validation.
 const {createRunArchive}=await import('../services/agent-runtime/trace-store.mjs');createRunArchive(join(dir,'runs'),snapshot,{id:approved.data.id});
 await call('/runs/'+approved.data.id+'/cancel','POST',{});
 const changed=await call('/models/'+modelId,'PUT',{...current,name:'Renamed configuration',version:current.version,capabilities:current.capabilities});assert.equal(changed.status,200);
 assert.deepEqual((await model()).capabilities,{});assert.equal((await call('/runs/'+approved.data.id+'/retry','POST',{resume:false})).data.code,'MODEL_CAPABILITY_REQUIRED');
 assert.equal((await call('/models/'+modelId+'/test','POST',{})).status,200);assert.equal((await call('/models/'+modelId+'/test-tools','POST',{})).status,200);
 assert.equal((await call('/runs/'+approved.data.id+'/retry','POST',{resume:false})).data.code,'MODEL_REAPPROVAL_REQUIRED');
 const gatewayRow=(await call('/gateways')).data.find((g:any)=>g.id===gatewayId);
 assert.equal((await call('/gateways/'+gatewayId,'PUT',{...gatewayRow,version:gatewayRow.version})).status,200);assert.deepEqual((await model()).capabilities,{});
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');const worker=new RunCoordinator(join(dir,'runs'),createArchiveWriterManager({traceRoot:join(dir,'runs')}));await worker.close();
 await pool.query("UPDATE project_runs SET status='running',lease_owner=$1,lease_until=now()+interval '1 minute' WHERE id=$2",[worker.owner,approved.data.id]);
 const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[approved.data.id])).rows[0],beforeLaunch=requests;
 await worker.launch(row);assert.equal(requests,beforeLaunch,'changed routes never reach the provider from the worker');assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[approved.data.id])).rows[0].status,'failed');
});

test('bad arguments, ignored tool results and missing usage never mark the model supported',async()=>{
 for(const failure of ['no-tools','bad-args','bad-result','no-usage']){
  mode=failure;requests=0;const result=await call('/models/'+modelId+'/test-tools','POST',{});assert.notEqual(result.status,200);assert.equal(requests,failure==='bad-result'?2:1);
  assert.equal((await model()).capabilities.tools.status,'failed');assert.equal((await model()).status,'available','a tool failure does not falsify the separate text result');
  const history=(await call('/models/'+modelId+'/capability-tests')).data[0];assert.equal(history.status,'failed');assert.equal(history.requestIds.length,requests);
  if(failure==='no-usage')assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1',[history.requestIds[0]])).rows[0].status,'uncertain');
 }
});

test('local budget rejection retains prior evidence, and configuration changes prevent the second request',async()=>{
 assert.equal((await call('/models/'+modelId+'/test-tools','POST',{})).status,200);const evidence=(await model()).capabilities;requests=0;
 const rejected=await call('/models/'+modelId+'/test-tools','POST',{maxCost:.000001});assert.equal(rejected.data.code,'CALL_BUDGET_EXCEEDED');assert.equal(requests,0);assert.deepEqual((await model()).capabilities,evidence);
 mode='changed';const conflict=await call('/models/'+modelId+'/test-tools','POST',{});assert.equal(conflict.data.code,'MODEL_CONFIG_CHANGED');assert.equal(requests,1);assert.deepEqual((await model()).capabilities,{});
 const history=(await call('/models/'+modelId+'/capability-tests')).data[0];assert.equal(history.status,'not_applied');assert.equal(history.requestIds.length,1);
});

test('online backup refuses audited capability work without losing the completed evidence',async()=>{
 mode='hold';const pending=call('/models/'+modelId+'/test-tools','POST',{});
 for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10));assert.ok(release);
 try{const backup=await call('/backup/export','POST',{password:'capability-backup'});assert.equal(backup.status,409);assert.match(backup.data.message,/身份|审计/);}finally{release!();}
 assert.equal((await pending).status,200);mode='ok';const evidence=(await model()).capabilities;
 // Department creation now has a human audit. The legacy online package cannot silently omit it.
 // Full enterprise backup/restore remains separate; existing identity-free legacy roundtrip suites retain coverage.
 const exported=await call('/backup/export','POST',{password:'capability-backup'});assert.equal(exported.status,409);assert.match(exported.data.message,/身份|审计/);assert.deepEqual((await model()).capabilities,evidence);
});
