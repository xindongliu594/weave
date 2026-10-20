import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import http,{maxHeaderSize,type Server} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {createLocalStaticWeb} from '../scripts/local-static-web.mjs';
import {readApiResponse} from '../apps/web/src/api.ts';
import {toolEvidence} from './model-fixture.ts';

// Fresh PGlite plus real default-limit HTTP servers and the official static
// proxy. No production fallback, browser, employee operation or provider call.
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
let pool:pg.Pool,app:any,api:Server,provider:Server,web:Awaited<ReturnType<typeof createLocalStaticWeb>>,directory:string,apiPort:number,webPort:number;
let modelCalls=0;
const modelId='long-quote-model',departmentId='long-quote-department',projectId=randomUUID();
const policy={maxBudget:10,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300,allowedModelIds:[modelId],allowedTools:[],allowedKnowledgeSpaceIds:[],allowedDepartmentIds:[departmentId]};
const employee={id:'manager',role:'manager',name:'Isolated manager',title:'经理',instructions:'Fixture only',modelId,tools:[]};
const plan={rationale:'Preserve saved fixture',agents:[employee],tasks:[{id:'report',subject:'Review unchanged inputs',objective:'No provider or execution',assigneeId:'manager',dependencies:[],acceptanceCriteria:['Evidence remains unchanged'],estimatedInputTokens:100,estimatedOutputTokens:100,kind:'work'}]};
const close=async(server?:Server)=>{if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}};
before(async()=>{
 if(!isolated)return;assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
 directory=await mkdtemp(join(tmpdir(),'planning-quote-post-'));process.env.DATA_DIR=directory;process.env.TRACE_ROOT=join(directory,'runs');process.env.OBSIDIAN_VAULT=join(directory,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 provider=http.createServer((_req,res)=>{modelCalls++;res.writeHead(500);res.end('must never dispatch');});provider.listen(0,'127.0.0.1');await once(provider,'listening');
 await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)',['long-quote-gateway',{name:'No-call loopback fixture',baseUrl:'http://127.0.0.1:'+(provider.address() as any).port+'/v1'}]);
 for(const id of [modelId,'not-granted-model'])await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)",[id,{name:id,gatewayId:'long-quote-gateway',model:'fixture',inputRate:.3,outputRate:1.2},toolEvidence]);
 app=(await import('../apps/api/src/app.ts')).createApp();await app.locals.shutdownBackground();
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'Isolated readonly quote',agents:[employee]}]);
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[projectId,departmentId,'Isolated readonly quote','Keep all state unchanged',policy,plan,'manual']);
 await pool.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)',[projectId,plan,policy]);
 api=app.listen(0,'127.0.0.1');await once(api,'listening');apiPort=(api.address() as any).port;
 const buildRoot=join(directory,'web');await mkdir(join(buildRoot,'assets'),{recursive:true});await writeFile(join(buildRoot,'index.html'),'<!doctype html><script type="module" src="/assets/app.js"></script>');await writeFile(join(buildRoot,'assets/app.js'),'document.title="isolated quote";');
 web=await createLocalStaticWeb({buildRoot,apiPort,webPort:0});await web.listen();webPort=(web.server.address() as any).port;
});
after(async()=>{
 if(!isolated)return;await web?.close();await app?.locals.shutdown();await close(api);await close(provider);await pool?.end();
 const within=relative(resolve(tmpdir()),resolve(directory));assert.ok(within.startsWith('planning-quote-post-')&&!within.startsWith('..')&&!isAbsolute(within));await rm(directory,{recursive:true,force:true});assert.equal(modelCalls,0);
});
const input=(revisionRequest:string)=>({modelId,version:1,maxPlanningCost:.2,maxOutputTokens:5000,retainUncertainCosts:false,revisionRequest});
async function request(port:number,path:string,method='GET',body?:unknown,key?:string){
 const bytes=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));
 return new Promise<{status:number;bytes:Buffer;headers:http.IncomingHttpHeaders}>( (done,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{'content-type':'application/json','content-length':String(bytes.length),...(key?{'idempotency-key':key}:{})}},res=>{
   const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.once('error',reject);res.once('end',()=>done({status:res.statusCode!,bytes:Buffer.concat(chunks),headers:res.headers}));
  });req.once('error',reject);req.end(bytes);
 });
}
async function state(){
 const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
 return Promise.all(tables.map(async table=>({table,rows:(await pool.query('SELECT row_to_json(t) AS row FROM "'+table+'" t ORDER BY row_to_json(t)::text')).rows})));
}
const path='/api/projects/'+projectId+'/planning-quote';

test('default-limit real HTTP rejects long GET431 but readonly POST preserves full3840/4000 Chinese through the static proxy', {skip:!isolated},async()=>{
 assert.equal(maxHeaderSize,16384,'the fixture must use the unchanged Node header ceiling');const before=await state();
 for(const length of [3840,4000]){
  const body=input('中'.repeat(length)),longPath=path+'?'+new URLSearchParams(Object.entries(body).map(([key,value])=>[key,String(value)]));assert.ok(Buffer.byteLength(longPath)>maxHeaderSize);
  for(const port of [apiPort,webPort]){
   const old=await request(port,longPath);assert.equal(old.status,431);assert.equal(old.bytes.length,0);
   await assert.rejects(readApiResponse(new Response(old.bytes.toString('utf8'),{status:old.status})),{status:431,code:'HTTP_RESPONSE_ERROR'});
   const posted=await request(port,path,'POST',body,'read-only-key-must-not-persist');assert.equal(posted.status,200,posted.bytes.toString());const quote=JSON.parse(posted.bytes.toString());
   assert.equal(quote.revisionRequest,body.revisionRequest);assert.equal(quote.revisionRequest.length,length);assert.equal(quote.allowed,true);assert.equal(quote.nativeExecutionChecked,false);assert.equal(quote.costReadiness.recordedCost,0);
  }
 }
 assert.deepEqual(await state(),before,'no request_keys, usage, reservation, approval, preview, project or any other DB row changes');assert.equal(modelCalls,0);
});

test('short legacy GET and POST share the same quote while strict body schema, permissions and original budgets remain enforced', {skip:!isolated},async()=>{
 const before=await state(),body=input('Short adjustment');const legacy=await request(webPort,path+'?'+new URLSearchParams(Object.entries(body).map(([key,value])=>[key,String(value)]))),posted=await request(webPort,path,'POST',body);
 assert.equal(legacy.status,200);assert.equal(posted.status,200);const omitTime=(value:any)=>{const {checkedAt:_checked,...rest}=value;return rest;};assert.deepEqual(omitTime(JSON.parse(legacy.bytes.toString())),omitTime(JSON.parse(posted.bytes.toString())));
 for(const invalid of [{...body,revisionRequest:'中'.repeat(4001)},{...body,unexpected:true},{...body,version:'1'},{...body,retainUncertainCosts:'false'}]){
  const denied=await request(webPort,path,'POST',invalid);assert.equal(denied.status,422);assert.equal(JSON.parse(denied.bytes.toString()).code,'VALIDATION_ERROR');
 }
 const forbidden=await request(webPort,path,'POST',{...body,modelId:'not-granted-model'});assert.equal(forbidden.status,422);assert.equal(JSON.parse(forbidden.bytes.toString()).code,'POLICY_MODEL_DENIED');
 const tiny=await request(webPort,path,'POST',{...body,maxPlanningCost:.000000001});assert.equal(tiny.status,200);const tinyQuote=JSON.parse(tiny.bytes.toString());assert.equal(tinyQuote.allowed,false);assert.ok(tinyQuote.reasons.some((row:any)=>row.code==='CALL_BUDGET_EXCEEDED'));
 assert.deepEqual(await state(),before);assert.equal(modelCalls,0);
});

test('the actual planner packet separates new producer inputs from selected fixed imports without inheriting old hashes', {skip:!isolated},async()=>{
 const before=await state(),{prepareProjectPlanning}=await import('../apps/api/src/project-planning.ts');const prepared=await prepareProjectPlanning(pool,projectId,input('Use the current producer seal'));
 const system=prepared.messages[0].content!;assert.match(system,/本次任务产出的 inputs 只填 path 和 producerTaskId，不填 sha256/);assert.match(system,/宿主.*本次产物验收 accepted seal 后绑定/);
 assert.match(system,/不能把 executionHistory 或旧运行的文件SHA复制到本次 producer inputs/);assert.match(system,/只有用户明确选定的外部固定导入文件使用给定 sha256，且不得同时填写 producerTaskId/);
 const user=JSON.parse(prepared.messages[1].content!);assert.match(user.importedMaterials.notice,/inputs 使用给定 sha256 且不填 producerTaskId/);assert.deepEqual(user.policy,policy);assert.deepEqual(await state(),before);assert.equal(modelCalls,0);
});
