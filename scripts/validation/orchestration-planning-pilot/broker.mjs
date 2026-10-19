// Reuses the existing budget/receipt implementation; this is a bounded test driver.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {getTrial,checkQuote} from './cases.mjs';
const [mode,repo,outArg,profile='original']=process.argv.slice(2),out=resolve(outArg),trial=getTrial(profile),{cases,limits:trialLimits}=trial;
assert.ok(['dry-run','approved-real'].includes(mode));process.umask(0o077);mkdirSync(out); // An existing trial cannot be replayed.
const report={mode,profile,sourceCommit:trial.sourceCommit,limits:trialLimits,requests:[],startedAt:new Date().toISOString()},save=()=>writeFileSync(join(out,'broker-result.json'),JSON.stringify(report,null,2));
const api=async route=>{const r=await fetch('http://127.0.0.1:4310/api/'+route);assert.ok(r.ok);return r.json();};
const totals=async()=>{const usage=await api('usage'),costs=await api('costs');const holds=costs.calls.map(c=>({id:c.id,status:c.status,amount:c.amount})).sort((a,b)=>a.id.localeCompare(b.id));return {spent:usage.reduce((s,u)=>s+u.cost,0),reserved:holds.reduce((s,c)=>s+c.amount,0),holds};};
let model={id:'isolated-model',name:'Dry-run only',model:'deepseek-v4.1-flash',inputRate:.3,outputRate:1.2,status:'available'},pool,completeBudgeted,budgetedRequestEstimate;
if(mode==='approved-real'){
 assert.ok(process.env.DATABASE_URL&&process.env.DATA_DIR,'Operator-approved broker config required');
 const models=(await api('models')).filter(m=>m.id==='c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051'&&m.status==='available');assert.equal(models.length,1);model=models[0];
 report.before=await totals();assert.deepEqual(report.before.holds,JSON.parse(readFileSync(join(out,'..','baseline.json'),'utf8')).holds,'Pre-approved unknown receipt baseline changed');assert.ok(report.before.spent+report.before.reserved+trialLimits.maxTrialCost<=trialLimits.maxCumulative);
 assert.ok(!(await api('runs')).some(r=>['running','queued'].includes(r.status)));
 ({pool}=await import(pathToFileURL(join(repo,'apps/api/src/db.ts')).href));
 ({completeBudgeted,budgetedRequestEstimate}=await import(pathToFileURL(join(repo,'apps/api/src/cost-control.ts')).href));
}
const publicModel=Object.fromEntries(['id','name','model','inputRate','outputRate','protocol','thinkingMode','capabilities'].filter(k=>model[k]!==undefined).map(k=>[k,model[k]]));report.model=publicModel;save();
// The worker gets a fresh test DB and public metadata, never live configuration or keys.
const env={PATH:process.env.PATH,HOME:out,USERPROFILE:out,LANG:'C.UTF-8',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,TEMP:out,TMP:out}:{})};
const worker=spawn(process.execPath,['--import',join(repo,'node_modules/tsx/dist/loader.mjs'),join(repo,'scripts/validation/orchestration-planning-pilot/worker.mjs'),out,JSON.stringify(publicModel),profile,mode],{cwd:repo,env,stdio:['pipe','pipe','pipe']});
let busy=false,stopped=false,accepting=true;const activeHandlers=new Set();const timer=setTimeout(()=>{report.timeout=true;save();worker.kill('SIGTERM');},25*60*1000);
worker.stderr.on('data',b=>process.stderr.write(b));
const lines=createInterface({input:worker.stdout});
async function handleRequest(line){
 let request,entry,responseReply;
 const reply=value=>{if(!worker.stdin.destroyed)worker.stdin.write(JSON.stringify({id:request?.id,...value})+'\n');};
 try{
  request=JSON.parse(line.slice('ORCHESTRATION_REQUEST '.length));assert.equal(accepting,true);assert.equal(stopped,false);assert.equal(busy,false);busy=true;
  assert.equal(request.id,cases[report.requests.length]?.id,'Each case can dispatch only once in order');
  const body=request.body;assert.equal(body.model,model.model);assert.ok(Array.isArray(body.messages)&&body.messages.length<=5);assert.ok(body.messages.every(m=>['system','user'].includes(m.role)&&typeof m.content==='string'));assert.ok(Buffer.byteLength(JSON.stringify(body))<300000);assert.ok(Number.isSafeInteger(body.max_tokens)&&body.max_tokens>0&&body.max_tokens<=trialLimits.maxTokens);assert.ok(!body.tools&&!body.stream);
  const options=body.response_format?{response_format:body.response_format}:{};
  const used=report.requests.reduce((s,r)=>s+(r.cost??r.reserved),0);
  const quote=mode==='approved-real'?budgetedRequestEstimate(model,body.messages,body.max_tokens,options).reservation:.001;
  const now=mode==='approved-real'?await totals():{spent:0,reserved:0,holds:[]};
  checkQuote({used,calls:report.requests.length,quote,occupied:now.spent+now.reserved,unknownChanged:mode==='approved-real'&&JSON.stringify(now.holds)!==JSON.stringify(report.before.holds)},trialLimits);
  entry={id:request.id,requestId:randomUUID(),reserved:quote,request:body,attemptStartedAt:new Date().toISOString()};report.requests.push(entry);save();
  const result=mode==='approved-real'?await completeBudgeted(model,body.messages,body.max_tokens,{purpose:profile==='repair-smoke'?'编排修复两例复测':'七类编排隔离规划测试',maxCost:Math.min(trialLimits.maxCallCost,trialLimits.maxTrialCost-used),timeoutMs:180000,context:{experiment:'orchestration-planning-20261019'+(profile==='original'?'':':'+profile),caseId:request.id,requestId:entry.requestId,sessionId:'orchestration-test:'+(profile==='original'?'':profile+':')+request.id}},options):{choices:[{message:{content:JSON.stringify({reply:'DRY RUN：仅验证接口连通，不提供真实模型方案。'})}}],usage:{prompt_tokens:1,completion_tokens:1}};
  entry.returnedAt=new Date().toISOString();entry.usageId=result.usageId;entry.usage=result.usage;entry.content=result.choices[0].message.content;entry.finishReason=result.choices[0].finish_reason;
  if(mode==='approved-real'){const usage=(await api('usage')).find(u=>u.id===result.usageId);assert.ok(usage);entry.cost=usage.cost;assert.ok(entry.cost<=entry.reserved+1e-9);}else entry.cost=0;
  responseReply={result};
 }catch(e){stopped=true;report.error={message:e.message,code:e.code};responseReply={error:e.message};}
 finally{
  if(entry&&mode==='approved-real'){
   try{
    const receipts=(await pool.query(`SELECT r.id,r.status,r.amount::float8 AS amount,u.cost::float8 AS cost,u.input_tokens AS "inputTokens",u.output_tokens AS "outputTokens" FROM model_reservations r LEFT JOIN usage u ON u.id=r.id WHERE r.context->>'requestId'=$1`,[entry.requestId])).rows;
    assert.ok(receipts.length<=1);entry.receipts=receipts;
    if(receipts[0]?.cost!=null){const receipt=receipts[0];entry.usageId=receipt.id;entry.cost=receipt.cost;entry.usage={prompt_tokens:receipt.inputTokens,completion_tokens:receipt.outputTokens};}
    if(receipts.some(r=>r.status==='pending'||r.status==='uncertain'))throw Error('Unresolved receipt; retained without replay');
   }catch(e){stopped=true;report.error??={message:e.message};responseReply={error:e.message};}
  }
  save();busy=false;reply(responseReply);
 }
}
lines.on('line',line=>{
 if(line.startsWith('ORCHESTRATION_DONE ')){report.workerResult=JSON.parse(line.slice('ORCHESTRATION_DONE '.length));save();}
 if(!line.startsWith('ORCHESTRATION_REQUEST ')){console.log(line);return;}
 const work=handleRequest(line);activeHandlers.add(work);work.finally(()=>activeHandlers.delete(work));
});
const exit=await new Promise(resolve=>{worker.once('error',e=>{report.error={message:e.message};resolve({code:1,signal:null});});worker.once('exit',(code,signal)=>resolve({code,signal}));});
accepting=false;clearTimeout(timer);await Promise.all(activeHandlers);report.exit=exit;
try{
 if(mode==='approved-real'){
  report.after=await totals();assert.deepEqual(report.after.holds,report.before.holds,'Final unknown receipts changed');
  assert.ok(report.after.spent+report.after.reserved<=trialLimits.maxCumulative+1e-9,'Final cumulative budget exceeded');
  assert.ok(report.requests.reduce((s,r)=>s+(r.cost??r.reserved),0)<=trialLimits.maxTrialCost+1e-9,'Final trial budget exceeded');
 }
 assert.equal(exit.code,0);assert.ok(!exit.signal&&!report.timeout);
 assert.equal(report.workerResult?.cases,report.requests.length,'Worker must account for every request');
 assert.equal(report.workerResult?.projectWrites,0);assert.equal(report.workerResult?.departmentWrites,0);
 if(!(trial.stopOnInvalid&&report.workerResult?.stoppedAfterInvalid&&report.requests.length>0))assert.equal(report.requests.length,trialLimits.maxCalls);
 assert.ok(report.requests.every(r=>r.returnedAt));
 report.acceptancePassed=mode==='approved-real'&&report.workerResult?.cases===cases.length&&report.workerResult?.valid===cases.length;
}catch(e){report.error??={message:e.message};}
report.finishedAt=new Date().toISOString();save();await pool?.end();
console.log(JSON.stringify({mode,exit,attemptedRequests:report.requests.length,error:report.error,realModelRequestsAttempted:mode==='approved-real'?report.requests.length:0,out}));process.exitCode=report.error?1:0;
