import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {orchestrationFixture,orchestrationPatternIds,orchestrationPolicy} from './fixtures/orchestration-patterns.ts';
const base=process.env.DATABASE_URL!,admin=new pg.Pool({connectionString:base}),schema='orchestration_'+Date.now();
let pool:pg.Pool,app:any,server:any,gateway:any,url:string,dir:string,response:any,wire:any,requests=0;
async function call(path:string,body:any){const r=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};}
function candidate(id:string){
 const plan=orchestrationFixture(id);
 // New model plans have explicit host acceptance mappings for their test command.
 for(const t of plan.tasks)if(t.verify?.length)t.acceptanceChecks=[{criterionIndex:0,command:t.verify[0],minimumTests:1}];
 return {schemaVersion:2,target:{kind:'new',department:{name:'离线编排验证部',description:'仅测试草案',agents:plan.agents}},rationale:plan.rationale,tasks:plan.tasks,orchestration:plan.orchestration,deliveryCriteria:plan.deliveryCriteria};
}
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const connection=new URL(base);connection.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=connection.toString();
 dir=await mkdtemp(join(tmpdir(),'orchestration-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 gateway=http.createServer(async(req:any,res:any)=>{let raw='';for await(const chunk of req)raw+=chunk;wire=JSON.parse(raw);requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:typeof response==='string'?response:JSON.stringify(response)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}}));});
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 await pool.query("INSERT INTO gateways(id,data) VALUES('g',$1)",[{name:'Loopback fixture',baseUrl:'http://127.0.0.1:'+gateway.address().port+'/v1'}]);
 await pool.query("INSERT INTO models(id,data,status) VALUES('m',$1,'available')",[{name:'fixture',model:'fixture',gatewayId:'g',inputRate:1,outputRate:1}]);
 app=(await import('../apps/api/src/app.ts')).createApp();await app.locals.shutdown();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
});
after(async()=>{await app?.locals.shutdown();for(const s of [server,gateway])if(s){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});
async function chat(value:any){response={reply:'请查看离线草案。',candidate:value};return call('/organizations/chat',{organizationRouting:true,modelId:'m',policy:orchestrationPolicy,messages:[{role:'user',content:'仅整理可供确认的团队协作草案并独立核对结果。'}]});}
test('assembled generation schema excludes forbidden new-department fields without changing existing-team selection',async()=>{
 await chat(candidate('pipeline'));
 const prompt=wire.messages[0].content;
 assert.equal(prompt.includes('结构为 department、rationale、tasks'),false,'V2 must not be taught the legacy candidate envelope');
 const schema=JSON.parse(prompt.split('以下为输出 JSON Schema：')[1]),target=schema.properties.candidate.properties.target;
 const department=target.anyOf.find((o:any)=>o.properties.kind.const==='new').properties.department;
 assert.equal(department.properties.dailyBudget,undefined);
 const agent=department.properties.agents.items;
 for(const field of ['sourceDepartmentId','sourceAgentId','fallbackModelId','knowledgeSpaceIds','browserOrigins','mcpConnections'])assert.equal(agent.properties[field],undefined,field);
 for(const field of ['id','role','modelId','tools'])assert.ok(agent.required.includes(field),field);
 assert.equal(department.additionalProperties,false);assert.equal(agent.additionalProperties,false);
 assert.ok(target.anyOf.find((o:any)=>o.properties.kind.const==='existing').properties.departmentVersion);
});
test('legacy conversation uses the same restricted generation fields while retaining its old envelope',async()=>{
 response={reply:'继续讨论。'};
 const result=await call('/organizations/chat',{modelId:'m',policy:orchestrationPolicy,messages:[{role:'user',content:'讨论团队。'}]});
 assert.equal(result.status,200);const schema=JSON.parse(wire.messages[0].content.split('以下为输出 JSON Schema：')[1]);
 assert.ok(schema.properties.candidate.properties.department);assert.equal(schema.properties.candidate.properties.target,undefined);
 assert.equal(schema.properties.candidate.properties.department.properties.dailyBudget,undefined);
});
test('all seven untouched real failures stay rejected with safe output diagnostics and no hidden retry or saved artifacts',async()=>{
 const evidence=JSON.parse(readFileSync(new URL('../docs/validation/evidence/orchestration-jj-tests-2026-10-19/real-evaluation.json',import.meta.url),'utf8'));
 await pool.query("INSERT INTO models(id,data,status) VALUES($1,$2,'available')",[evidence.model.id,{...evidence.model,gatewayId:'g'}]);
 const counts=async()=>{const result:any={};for(const table of ['organization_previews','departments','projects','project_runs'])result[table]=(await pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n;return result;};
 const before=await counts(),beforeRequests=requests;
 for(const item of evidence.cases){
  response=item.rawResponse;
  const result=await call('/organizations/chat',{organizationRouting:true,modelId:evidence.model.id,policy:{...orchestrationPolicy,maxBudget:.25,allowedModelIds:[evidence.model.id],allowedTools:['filesystem','artifact_write',...(item.caseId==='bounded-code-review'?['terminal']:[])]},messages:[{role:'user',content:'离线回放原始虚构方案，仅检查拒绝与保存边界。'}]});
  assert.equal(result.status,200,item.caseId);assert.equal(result.data.preview,undefined,item.caseId);
  assert.equal(result.data.draftIssue.code,item.diagnostic.code,item.caseId);
  const diagnostic=result.data.outputDiagnostic;
  assert.ok(diagnostic,item.caseId);assert.equal(diagnostic.finishReason,'stop');
  assert.equal(diagnostic.originalOutputSHA,createHash('sha256').update(item.rawResponse).digest('hex'));
  assert.equal(diagnostic.outputBytes,Buffer.byteLength(item.rawResponse));
  if(item.diagnostic.code==='ORGANIZATION_CHAT_INVALID'){assert.equal(diagnostic.reason,'INVALID_JSON');assert.ok(Number.isInteger(diagnostic.position));}
  assert.ok(!JSON.stringify(diagnostic).includes('candidate'));
  assert.deepEqual(await counts(),before,item.caseId);
 }
 assert.equal(requests,beforeRequests+7,'local response fixtures, never another provider request');
 response={reply:'请补充要求。'};
 const next=await call('/organizations/chat',{organizationRouting:true,modelId:'m',policy:orchestrationPolicy,previousDraftIssue:evidence.cases[0].diagnostic,messages:[{role:'user',content:'继续讨论。'}]});
 assert.equal(next.status,200);assert.equal(next.data.reply,'请补充要求。');assert.deepEqual(await counts(),before);
});
test('assembled terminal routing request distinguishes template preview rework from legacy zero rework',async()=>{
 const calls=requests,result=await chat(candidate('review_repair'));
 assert.ok(result.data.preview,JSON.stringify(result));assert.equal(requests,calls+1);
 const prompt=wire.messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('\n');
 assert.equal(prompt.includes('maxReworkRounds 固定 0'),false,'no unconditional zero-only review instruction may survive request assembly');
 assert.equal(prompt.includes('无 orchestration.template 的旧方案：maxReworkRounds=0'),true);
 assert.equal(prompt.includes('orchestration.template.id=review_repair 时，绑定的独立审查任务 maxReworkRounds 必须为 1..2'),true);
 assert.equal(prompt.includes('普通批准或自动批准也不能执行'),true);
});
test('assembled terminal routing request requires independent criteria for every referenced template',async()=>{
 const calls=requests,result=await chat(candidate('pipeline'));
 assert.ok(result.data.preview,JSON.stringify(result));assert.equal(requests,calls+1);
 const prompt=wire.messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('\n');
 assert.equal(prompt.includes('存在 orchestration.template 时，每条 deliveryCriteria 都必须 independent=true，检查者与所有产出作者不同'),true,'all referenced-template criteria require independent=true and different authors/checkers');
 assert.equal(prompt.includes('无模板引用时沿用旧规则：需要独立核对时 independent=true'),true);
});
test('assembled non-routing terminal request retains the legacy zero-rework contract without the template catalog',async()=>{
 response={reply:'请继续明确需求。'};const calls=requests;
 const result=await call('/organizations/chat',{modelId:'m',policy:orchestrationPolicy,messages:[{role:'user',content:'先讨论团队。'}]});
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(requests,calls+1);
 const prompt=wire.messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('\n');
 assert.match(prompt,/maxReworkRounds 固定 0/);assert.doesNotMatch(prompt,/review_repair/);
 assert.equal(JSON.parse(wire.messages[1].content).orchestrationCatalog,undefined);
});
for(const id of orchestrationPatternIds)test(id+' previews and confirms frozen references, but all approval routes are blocked before effects',async()=>{
 const value=candidate(id),calls=requests,result=await chat(value);
 assert.equal(result.status,200,JSON.stringify(result));assert.ok(result.data.preview,JSON.stringify(result));assert.equal(requests,calls+1,'one loopback planning response, no hidden repair');
 const preview=result.data.preview;assert.deepEqual(preview.plan.orchestration,value.orchestration);
 const constraints=wire.messages.map((m:any)=>{try{return JSON.parse(m.content);}catch{return undefined;}}).find((m:any)=>m?.orchestrationCatalog);
 assert.equal(constraints.orchestrationCatalog.length,7);assert.ok(constraints.orchestrationCatalog.every((p:any)=>p.templateExample&&p.previewOnly===true));
 const confirmed=await call('/organizations/previews/'+preview.previewId+'/confirm',{previewVersion:1});assert.equal(confirmed.status,201,JSON.stringify(confirmed));
 const projectId=confirmed.data.projectId;
 for(const sql of ['SELECT plan FROM projects WHERE id=$1','SELECT plan FROM plan_versions WHERE project_id=$1'])assert.deepEqual((await pool.query(sql,[projectId])).rows[0].plan.orchestration,value.orchestration);
 const before=requests,usage=(await pool.query('SELECT count(*)::int n FROM usage')).rows[0].n;
 for(const flags of [{},{automatic:true},{automatic:true,executionVerified:true,status:'verified',acceptanceEvidence:['client']}]){
  const denied=await call('/projects/'+projectId+'/approve',{version:1,...flags});assert.equal(denied.status,422,JSON.stringify(denied));assert.equal(denied.data.code,'ORCHESTRATION_PREVIEW_ONLY');assert.match(denied.data.message,/待真实验收/);assert.match(denied.data.message,/旧协作方案|真实.*验收/);
 }
 assert.equal(requests,before);assert.equal((await pool.query('SELECT count(*)::int n FROM usage')).rows[0].n,usage);assert.equal((await pool.query('SELECT count(*)::int n FROM project_runs')).rows[0].n,0);
 assert.equal((await pool.query('SELECT status FROM projects WHERE id=$1',[projectId])).rows[0].status,'DRAFT');
});
test('bad template id, hash and binding yield explicit draft issues without saving a preview',async()=>{
 for(const mutate of [(t:any)=>t.id='unknown',(t:any)=>t.definitionHash='0'.repeat(64),(t:any)=>t.taskIds=['missing']]){
  const value=candidate('pipeline');mutate(value.orchestration!.template);const before=(await pool.query('SELECT count(*)::int n FROM organization_previews')).rows[0].n;
  const result=await chat(value);assert.equal(result.data.preview,undefined);assert.equal(result.data.draftIssue.code,'ORGANIZATION_CHAT_PLAN_INVALID');assert.match(result.data.draftIssue.message,/template|模板|绑定|missing/);assert.equal((await pool.query('SELECT count(*)::int n FROM organization_previews')).rows[0].n,before);
 }
});
test('legacy candidate without a template remains confirmable',async()=>{
 const value=candidate('pipeline');delete value.orchestration!.template;value.deliveryCriteria![0].independent=false;const result=await chat(value);assert.ok(result.data.preview,JSON.stringify(result));
 const confirmed=await call('/organizations/previews/'+result.data.preview.previewId+'/confirm',{previewVersion:1});assert.equal(confirmed.status,201,JSON.stringify(confirmed));
 assert.equal((await pool.query('SELECT plan FROM projects WHERE id=$1',[confirmed.data.projectId])).rows[0].plan.orchestration.template,undefined);
 assert.equal(result.data.preview.plan.deliveryCriteria[0].independent,false,'legacy criteria are not upgraded to template requirements');
});
test('archive reads and resource recovery retain frozen orchestration without selecting a current definition',async()=>{
 const {createRunArchive,readRun}=await import(new URL('../services/agent-runtime/trace-store.mjs',import.meta.url).href);
 const {createGoalContract}=await import('../packages/contracts/goal-contract.mjs');
 const {applyRecoveryResources}=await import('../apps/api/src/recovery-resource-plan.ts');
 const plan=orchestrationFixture('router'),snapshot:any={...plan,projectId:'offline-history',planVersion:1,policy:{...orchestrationPolicy,maxTaskModelCalls:10,maxModelCalls:100}};
 // A historical unknown definition must be readable verbatim, never upgraded.
 snapshot.orchestration.template.definitionHash='f'.repeat(64);snapshot.goalContract=createGoalContract(snapshot);
 const original=structuredClone(snapshot),root=join(dir,'metadata-regression'),archive=createRunArchive(root,snapshot),read=readRun(root,archive.id);
 assert.equal(read.integrity,'ok');assert.deepEqual(read.snapshot.orchestration,original.orchestration);
 const recovered=applyRecoveryResources(read.snapshot,{maxBudget:10,taskCallLimits:{manager:10},rationale:'保留原节点，仅确认已有额度'}, {newRevision:1,completedTaskIds:['a','check'],history:{calls:2,tasks:{}},ceiling:10});
 assert.deepEqual(recovered.orchestration,original.orchestration);assert.deepEqual(snapshot,original);assert.deepEqual(recovered.tasks.slice(0,2),original.tasks.slice(0,2));
 const resumed=createRunArchive(root,{...recovered,recovery:{sourceRunId:archive.id,completed:[{taskId:'a'},{taskId:'check'}]}});
 assert.deepEqual(readRun(root,resumed.id).snapshot.orchestration,original.orchestration);
});
