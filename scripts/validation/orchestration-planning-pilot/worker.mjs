// Actual product planning route in an isolated database; no execution or credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {getTrial,stopAfterResult} from './cases.mjs';
const [out,modelJson,profile='original',mode='dry-run']=process.argv.slice(2),model=JSON.parse(modelJson),trial=getTrial(profile),{cases}=trial;
const correction=['feedback-correction','delivery-binding'].includes(profile);
assert.ok(out&&model.id);process.umask(0o077);
process.env.DATA_DIR=join(out,'isolated-data');process.env.TRACE_ROOT=join(out,'isolated-runs');process.env.OBSIDIAN_VAULT=join(out,'isolated-vault');
mkdirSync(process.env.DATA_DIR,{recursive:true});
const db=await PGlite.create({extensions:{vector}}),socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:8});
let port;socket.addEventListener('listening',e=>{port=e.detail.port;});await socket.start();
process.env.DATABASE_URL=`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;process.env.SIMULATED_INTEGRATION='pglite';
await import('../../test-support/pglite-pool.mjs');
const {pool,migrate}=await import('../../../apps/api/src/db.ts');await migrate();
let pending,current,replayContent,sourceSha256,replayedResponses=0;const replies=createInterface({input:process.stdin});
if(correction){
 const evidence=profile==='delivery-binding'?'orchestration-feedback-pilot-2026-10-19':'orchestration-smoke-2026-10-19';
 const source=JSON.parse(readFileSync(new URL('../../../docs/validation/evidence/'+evidence+'/real/broker-result.json',import.meta.url),'utf8'));
 replayContent=source.requests.find(r=>r.id==='bounded-code-review').content;
 sourceSha256=createHash('sha256').update(replayContent).digest('hex');
 assert.equal(sourceSha256,profile==='delivery-binding'?'60de83d7d1d006743a5325a50fbf429eb8b957f3d0f77b520b56cce8d33f984e':'492a6d51d11205e81b4bc0cd7ef9dce3ac1dfd015cf60e4f87fb6f132516fbbb');
 assert.equal(model.id,source.model.id);
}
replies.on('line',line=>{try{const value=JSON.parse(line);assert.equal(value.id,current);if(value.error)pending.reject(Error(value.error));else pending.resolve(value.result);}catch(e){pending?.reject(e);}});
const gateway=http.createServer(async(req,res)=>{
 try{
  let raw='';for await(const c of req)raw+=c;assert.ok(raw.length<300000);const body=JSON.parse(raw);
  let result;
  if(replayContent!==undefined){result={choices:[{message:{content:replayContent},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0}};replayContent=undefined;replayedResponses++;}
  else result=await new Promise((resolve,reject)=>{pending={resolve,reject};process.stdout.write('ORCHESTRATION_REQUEST '+JSON.stringify({id:current,body})+'\n');});
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:e.message}}));}
});
gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
await pool.query("INSERT INTO gateways(id,data) VALUES('pilot',$1)",[{name:'Isolated expense bridge',baseUrl:`http://127.0.0.1:${gateway.address().port}/v1`}]);
await pool.query("INSERT INTO models(id,data,status) VALUES($1,$2,'available')",[model.id,{...model,gatewayId:'pilot'}]);
const app=(await import('../../../apps/api/src/app.ts')).createApp();await app.locals.ready;await app.locals.shutdownBackground();const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const results=[];let stoppedAfterInvalid=false;
try{
 for(const item of cases){
  current=item.id;const start=performance.now();
  const policy={maxBudget:.25,maxAgents:6,maxConcurrentAgents:3,deadlineSeconds:600,contextBytes:96000,maxModelCalls:48,maxTaskModelCalls:16,allowedModelIds:[model.id],allowedTools:['filesystem','artifact_write',...(item.id==='bounded-code-review'?['terminal']:[])],allowedKnowledgeSpaceIds:[]};
  const input={organizationRouting:true,modelId:model.id,policy,messages:[{role:'user',content:'只生成可供讨论的组织方案，不执行。这是隔离测试，目录为空时提出待确认部门，不保存。请依据需求选择合适的编排模板并解释理由；全部资料均为虚构。假设执行预算最多0.25美元仅用于检验方案估算，不是执行授权。'+item.prompt}]};
  const post=()=>fetch(`http://127.0.0.1:${server.address().port}/api/organizations/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  if(correction){
   input.conversationId=randomUUID();const replay=await post(),seed=await replay.json();
   assert.equal(replay.status,200);assert.equal(seed.preview,undefined);assert.equal(seed.draftIssue?.code,'ORGANIZATION_CHAT_PLAN_INVALID');
   for(const field of profile==='delivery-binding'?['producerTaskIds','checkTaskId','verify','形成自我验收']:['handoff','clarify','develop','verify'])assert.ok(seed.draftIssue.message.includes(field));
   writeFileSync(join(out,'replayed-failure.json'),JSON.stringify({sourceSha256,modelCalls:0,result:seed},null,2),{flag:'wx'});
   input.previousDraftIssue=seed.draftIssue;
   input.messages.push({role:'assistant',content:seed.reply},{role:'user',content:'请保持原任务目标，根据上轮完整校验反馈一次修正组织方案。仍仅生成待确认预览，不保存部门或项目，不执行任务。'});
  }
  const response=await post();
  const body=await response.json();writeFileSync(join(out,item.id+'.json'),JSON.stringify(body,null,2),{flag:'wx'});
  results.push({id:item.id,httpStatus:response.status,milliseconds:Math.round(performance.now()-start),validPreview:Boolean(body.preview),selected:body.preview?.plan?.orchestration?.template?.id??null,issue:body.draftIssue??body.error??null,outputDiagnostic:body.outputDiagnostic??null,previewId:body.preview?.previewId??null});
  writeFileSync(join(out,'planning-results.json'),JSON.stringify(results,null,2));
  if(!response.ok)break;
  if(stopAfterResult(trial,mode,body)){stoppedAfterInvalid=true;break;}
 }
 for(const table of ['projects','departments'])assert.equal(Number((await pool.query('SELECT count(*) FROM '+table)).rows[0].count),0);
}finally{
 replies.close();for(const s of [server,gateway]){s.closeAllConnections();await new Promise(r=>s.close(r));}await pool.end();await socket.stop();await db.close();
}
process.stdout.write('ORCHESTRATION_DONE '+JSON.stringify({cases:results.length,valid:results.filter(r=>r.validPreview).length,stoppedAfterInvalid,replayedResponses,projectWrites:0,departmentWrites:0})+'\n');
