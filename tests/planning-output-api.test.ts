import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {PLANNING_OUTPUT_MAX_BYTES,PLANNING_SCHEMA_ISSUE_LIMIT} from '../apps/api/src/planning-output.ts';
import {readApiResponse,ApiError} from '../apps/web/src/api.ts';
import {toolEvidence} from './model-fixture.ts';

// Isolated in-memory database and loopback API/provider double only.
// No production fallback, employee execution, model probe or repair request.
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const modelId='planning-output-model',departmentId='planning-output-department';
const employee={id:'manager',name:'Isolated manager',title:'经理',role:'manager',instructions:'Fixture only',modelId,tools:[]};
const task={id:'report',subject:'Prepare a reviewable plan',objective:'Describe the fixture scope without execution',assigneeId:employee.id,dependencies:[],
 acceptanceCriteria:['Scope is explicit'],estimatedInputTokens:100,estimatedOutputTokens:100,kind:'work'};
const original={rationale:'Saved original',agents:[employee],tasks:[task]};
const policy={maxBudget:10,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300,allowedModelIds:[modelId],allowedTools:[],allowedKnowledgeSpaceIds:[],allowedDepartmentIds:[departmentId]};
let pool:pg.Pool,app:any,api:http.Server,gateway:http.Server,directory:string,traceRoot:string,url:string;
let content='',finish:unknown='stop',requests=0,wire:any,invalidCompletion=false;
const close=async(server?:http.Server)=>{if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}};
before(async()=>{
 if(!isolated)return;assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
 directory=await mkdtemp(join(tmpdir(),'planning-output-api-'));traceRoot=join(directory,'runs');process.env.DATA_DIR=directory;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(directory,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 gateway=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;wire=JSON.parse(raw);requests++;assert.equal(req.url,'/v1/chat/completions');
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:invalidCompletion?{secret:'sk-invalid-completion-fixture'}:content},finish_reason:finish}],usage:{prompt_tokens:40,completion_tokens:15}}));
 });gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)',['planning-output-gateway',{name:'Loopback fixture',baseUrl:'http://127.0.0.1:'+(gateway.address() as any).port+'/v1'}]);
 await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)",[modelId,{name:'Loopback fixture',gatewayId:'planning-output-gateway',model:'fixture-planner',thinkingMode:'disabled',inputRate:.2,outputRate:.4},toolEvidence]);
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'Isolated parsing',description:'Engineering fixture',agents:[employee]}]);
 app=(await import('../apps/api/src/app.ts')).createApp();await app.locals.shutdown();api=app.listen(0,'127.0.0.1');await once(api,'listening');url='http://127.0.0.1:'+(api.address() as any).port+'/api';
});
beforeEach(async()=>{
 if(!isolated)return;await pool.query('TRUNCATE usage,model_reservations,organization_previews,project_runs,plan_versions,projects,request_keys CASCADE');
 content=JSON.stringify({...structuredClone(original),rationale:'Reviewable " } { " candidate\nwith original fields'});finish='stop';requests=0;wire=undefined;invalidCompletion=false;
});
after(async()=>{
 if(!isolated)return;await app?.locals.shutdown();await close(api);await close(gateway);await pool?.end();
 const within=relative(resolve(tmpdir()),resolve(directory));assert.ok(within.startsWith('planning-output-api-')&&!within.startsWith('..')&&!isAbsolute(within));await rm(directory,{recursive:true,force:true});
});
async function call(path:string,body:any,key?:string){
 const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any};
}
async function seed(){
 const id=randomUUID();await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[id,departmentId,'Isolated parsing','Keep saved plan until confirmation',policy,original,'manual']);
 await pool.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)',[id,original,policy]);return id;
}
const generateInput={modelId,version:1,maxPlanningCost:.1,maxOutputTokens:5000};
const source=(id:string)=>pool.query('SELECT version,plan,policy,status,source FROM projects WHERE id=$1',[id]).then(result=>result.rows[0]);
async function noExecution(){assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,0);}
async function paidOnce(before=0){
 assert.equal(requests,before+1);const rows=(await pool.query('SELECT id,status,context FROM model_reservations ORDER BY created_at')).rows;assert.equal(rows.at(-1).status,'settled');
 const usage=(await pool.query('SELECT * FROM usage WHERE id=$1',[rows.at(-1).id])).rows[0];assert.equal(usage.input_tokens,40);assert.equal(usage.output_tokens,15);assert.ok(Number(usage.cost)>0);return rows.at(-1);
}

test('short prose and one fence produce a paid candidate; only explicit confirmation saves it once', {skip:!isolated},async()=>{
 for(const wrapper of [(json:string)=>'Here is one candidate:\n'+json,(json:string)=>json+'\nPlease review before saving.',(json:string)=>'Candidate:\n```json\n'+json+'\n```\nRequires confirmation.']){
  const id=await seed(),before=await source(id),calls=requests,candidate=JSON.parse(content);content=wrapper(JSON.stringify(candidate));const key=randomUUID();
  const generated=await call('/projects/'+id+'/generate',generateInput,key);assert.equal(generated.status,200,JSON.stringify(generated.data));assert.equal(generated.data.plan.rationale,candidate.rationale);
  assert.deepEqual(await source(id),before);await paidOnce(calls);await noExecution();assert.equal(wire.response_format,undefined);assert.deepEqual(wire.thinking,{type:'disabled'});assert.equal(wire.max_tokens,5000);
  const repeat=await call('/projects/'+id+'/generate',generateInput,key);assert.equal(repeat.status,200);assert.equal(repeat.data.previewId,generated.data.previewId);assert.equal(requests,calls+1);
  const body={previewId:generated.data.previewId,version:1};const confirmed=await call('/projects/'+id+'/generated-plan/confirm',body);assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
  const again=await call('/projects/'+id+'/generated-plan/confirm',body);assert.equal(again.data.existing,true);const saved=await source(id);assert.equal(saved.version,2);assert.equal(saved.policy.maxBudget,10);assert.equal(saved.plan.rationale,candidate.rationale);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM plan_versions WHERE project_id=$1',[id])).rows[0].n,2);assert.equal(requests,calls+1);await noExecution();
  content=JSON.stringify({...structuredClone(original),rationale:'Another " } { " candidate\nwith original fields'});
 }
});

test('ambiguous, malformed, oversized and schema-invalid output retains known fees and safe diagnostics without preview', {skip:!isolated},async()=>{
 for(const [raw,reason] of [[JSON.stringify(original)+JSON.stringify(original),'AMBIGUOUS_JSON'],['{"secret":"sk-fixture-value","tasks":','TRUNCATED_JSON'],
  ['{"a":1,}','INVALID_JSON'],[JSON.stringify({padding:'x'.repeat(PLANNING_OUTPUT_MAX_BYTES)}),'OUTPUT_TOO_LARGE'],['{"rationale":"missing fields"}','PLAN_SCHEMA_INVALID']] as const){
  const id=await seed(),before=await source(id),calls=requests;content=raw;const key=randomUUID(),response=await call('/projects/'+id+'/generate',generateInput,key);
  assert.equal(response.status,422,JSON.stringify(response.data));assert.equal(response.data.diagnostic.reason,reason);assert.equal(response.data.diagnostic.finishReason,'stop');assert.equal(response.data.diagnostic.originalOutputSHA,createHash('sha256').update(raw).digest('hex'));
  assert.ok(!JSON.stringify(response.data).includes('sk-'));assert.deepEqual(await source(id),before);const receipt=await paidOnce(calls);assert.deepEqual(receipt.context.planningOutputDiagnostic,response.data.diagnostic);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM organization_previews WHERE project_id=$1',[id])).rows[0].n,0);await noExecution();
  const again=await call('/projects/'+id+'/generate',generateInput,key);assert.equal(again.status,422);assert.deepEqual(again.data,response.data);assert.equal(requests,calls+1,'cached paid failure cannot trigger a repair call');
 }
 const diagnostics=readdirSync(join(traceRoot,'planning-output-diagnostics')).map(name=>JSON.parse(readFileSync(join(traceRoot,'planning-output-diagnostics',name),'utf8')));
 assert.ok(diagnostics.some(item=>item.reason==='TRUNCATED_JSON'));assert.ok(!JSON.stringify(diagnostics).includes('sk-'));assert.ok(diagnostics.every(item=>!('content' in item)&&!('raw' in item)));
});

test('schema field diagnostics reach the existing web error message and one safe receipt history entry while usage bytes stay retained', {skip:!isolated},async()=>{
 const id=await seed(),before=await source(id),candidate:any=structuredClone(original);candidate.tasks[0].maxOutputTokens=32769;candidate.agents[0].role='sk-private-role';candidate.tasks[0].objective=null;candidate.tasks[0].outputs=[{path:'output.json',format:'json',expectedValues:{'sk-private-record-key':'x'.repeat(2001)}}];candidate['sk-private-extra']='sk-private-raw-output';content=JSON.stringify(candidate);
 const key=randomUUID(),response=await call('/projects/'+id+'/generate',generateInput,key);assert.equal(response.status,422);assert.equal(response.data.code,'PLANNING_SCHEMA_INVALID');assert.match(response.data.message,/tasks\[0\].maxOutputTokens：最大 32768/);
 assert.ok(response.data.diagnostic.schemaIssues.some((issue:any)=>issue.code==='invalid_type'&&issue.path.at(-1)==='objective'));assert.ok(response.data.diagnostic.schemaIssues.some((issue:any)=>issue.path.at(-1)==='<field>'));assert.ok(!JSON.stringify(response.data).includes('sk-private'));
 await assert.rejects(readApiResponse(new Response(JSON.stringify(response.data),{status:422}),{readOnly:false}),error=>error instanceof ApiError&&error.code==='PLANNING_SCHEMA_INVALID'&&error.message===response.data.message);
 const receipt=await paidOnce(),saved=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receipt.id])).rows[0];assert.equal(saved.status,'settled');assert.deepEqual(saved.context.planningOutputDiagnostic,response.data.diagnostic);const history=saved.history.filter((entry:any)=>entry.source==='planning-output');assert.equal(history.length,1);assert.deepEqual(history[0].diagnostic,response.data.diagnostic);assert.ok(!JSON.stringify(history).includes('sk-private'));
 const usage=(await pool.query('SELECT * FROM usage WHERE id=$1',[receipt.id])).rows[0],usageSHA=createHash('sha256').update(JSON.stringify(usage)).digest('hex');const again=await call('/projects/'+id+'/generate',generateInput,key);assert.deepEqual(again,response);assert.equal(requests,1);assert.equal(createHash('sha256').update(JSON.stringify((await pool.query('SELECT * FROM usage WHERE id=$1',[receipt.id])).rows[0])).digest('hex'),usageSHA);
 const after=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receipt.id])).rows[0];assert.deepEqual(after,saved);assert.deepEqual(await source(id),before);assert.equal((await pool.query('SELECT count(*)::int AS n FROM organization_previews WHERE project_id=$1',[id])).rows[0].n,0);await noExecution();
 const diagnostics=readdirSync(join(traceRoot,'planning-output-diagnostics')).map(name=>JSON.parse(readFileSync(join(traceRoot,'planning-output-diagnostics',name),'utf8')));assert.ok(diagnostics.some(item=>item.originalOutputSHA===response.data.diagnostic.originalOutputSHA&&item.schemaIssues?.length));assert.ok(!JSON.stringify(diagnostics).includes('sk-private'));
});

test('schema failure caps multiple field issues and preserves null failures without a preview or repair request', {skip:!isolated},async()=>{
 for(const candidate of [{...structuredClone(original),tasks:Array.from({length:20},()=>null)},null]){
  const id=await seed(),before=await source(id),calls=requests;content=JSON.stringify(candidate);const response=await call('/projects/'+id+'/generate',generateInput,randomUUID());assert.equal(response.status,422);
  if(candidate){assert.equal(response.data.diagnostic.schemaIssues.length,PLANNING_SCHEMA_ISSUE_LIMIT);assert.equal(response.data.diagnostic.schemaIssueCount,20);assert.equal(response.data.diagnostic.schemaIssuesTruncated,true);assert.ok(response.data.diagnostic.schemaIssues.every((issue:any)=>issue.code==='invalid_type'&&issue.expected.type==='object'));}
  else assert.equal(response.data.diagnostic.reason,'OBJECT_REQUIRED');
  await paidOnce(calls);assert.deepEqual(await source(id),before);assert.equal((await pool.query('SELECT count(*)::int AS n FROM organization_previews WHERE project_id=$1',[id])).rows[0].n,0);await noExecution();
 }
});

test('length and content_filter fail after usage settlement even when their visible JSON is complete', {skip:!isolated},async()=>{
 for(const stop of ['length','content_filter']){
  const id=await seed(),before=await source(id),calls=requests;finish=stop;const raw=content,key=randomUUID(),result=await call('/projects/'+id+'/generate',generateInput,key);
  assert.equal(result.status,422);assert.equal(result.data.code,stop==='length'?'MODEL_OUTPUT_TRUNCATED':'MODEL_OUTPUT_FILTERED');assert.equal(result.data.diagnostic.finishReason,stop);assert.equal(result.data.diagnostic.originalOutputSHA,createHash('sha256').update(raw).digest('hex'));
  await paidOnce(calls);assert.deepEqual(await source(id),before);assert.equal((await pool.query('SELECT count(*)::int AS n FROM organization_previews WHERE project_id=$1',[id])).rows[0].n,0);await noExecution();
  assert.equal((await call('/projects/'+id+'/generate',generateInput,key)).status,422);assert.equal(requests,calls+1);
 }
});

test('wrapped candidates still require allowed models and available project budget', {skip:!isolated},async()=>{
 const id=await seed(),before=await source(id),candidate={...structuredClone(original),agents:[{...employee,modelId:'not-approved'}]};content='Candidate:\n'+JSON.stringify(candidate);
 const denied=await call('/projects/'+id+'/generate',generateInput);assert.equal(denied.status,422);assert.equal(denied.data.code,'POLICY_PERMISSION_DENIED');await paidOnce();assert.deepEqual(await source(id),before);await noExecution();
 await pool.query("UPDATE projects SET policy=jsonb_set(policy,'{maxBudget}','0.000000001'::jsonb) WHERE id=$1",[id]);const calls=requests;
 const over=await call('/projects/'+id+'/generate',generateInput);assert.equal(over.status,422);assert.equal(requests,calls,'a parser change cannot bypass monetary admission');
});

test('a malformed completion envelope records paid failure diagnostics before any candidate parse', {skip:!isolated},async()=>{
 const id=await seed(),before=await source(id);invalidCompletion=true;const result=await call('/projects/'+id+'/generate',generateInput);
 assert.equal(result.status,502);assert.equal(result.data.code,'GATEWAY_INVALID_RESPONSE');assert.equal(result.data.diagnostic.reason,'INVALID_COMPLETION');assert.equal(result.data.diagnostic.finishReason,'stop');
 assert.ok(!JSON.stringify(result.data).includes('sk-'));await paidOnce();assert.deepEqual(await source(id),before);await noExecution();
});

test('normal completion preserves safe finish reason as metadata and keeps the wire envelope unchanged', {skip:!isolated},async()=>{
 const row=(await pool.query('SELECT id,data,version,status,capabilities FROM models WHERE id=$1',[modelId])).rows[0];
 const {completeBudgeted}=await import('../apps/api/src/cost-control.ts');
 const completed=await completeBudgeted({...row.data,id:row.id,version:row.version,status:row.status,capabilities:row.capabilities},[{role:'user',content:'Local metadata fixture only'}],100,{purpose:'Local metadata fixture',maxCost:.1});
 assert.equal(completed.choices[0].finish_reason,'stop');assert.equal(wire.response_format,undefined);assert.deepEqual(wire.thinking,{type:'disabled'});await paidOnce();await noExecution();
});
