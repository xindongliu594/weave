// Fixed synthetic prompts only. Reuse production budgeting; never execute returned code.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {matrix,limits,bodyFor,runMatrix,hash,baselineRequestSha256,independentCells} from './ab.mjs';
import {checkQuote} from './cases.mjs';
const [mode,repo,outArg,phase='planning-ab']=process.argv.slice(2),out=resolve(outArg);
assert.ok(['planning-ab','planning-ab-independent'].includes(phase));
assert.ok(['preflight','approved-real'].includes(mode));process.umask(0o077);mkdirSync(out);
const previous=phase==='planning-ab-independent'?JSON.parse(readFileSync(join(out,'..','real','broker-result.json'))):null;
const cells=previous?independentCells(previous):matrix,carryCost=previous?previous.requests.reduce((s,r)=>s+(r.cost??r.reserved),0):0,carryCalls=previous?.requests.length??0;
const report={mode,phase,sourceCommit:'db8153d',baselineRequestSha256,limits,carryCost,carryCalls,requests:[],startedAt:new Date().toISOString(),departmentWrites:0,projectWrites:0};
const save=()=>writeFileSync(join(out,'broker-result.json'),JSON.stringify(report,null,2));
const api=async route=>{const r=await fetch('http://127.0.0.1:4310/api/'+route);assert.ok(r.ok);return r.json();};
const totals=async()=>{const usage=await api('usage'),costs=await api('costs');const holds=costs.calls.map(c=>({id:c.id,status:c.status,amount:c.amount})).sort((a,b)=>a.id.localeCompare(b.id));return {spent:usage.reduce((s,u)=>s+u.cost,0),reserved:holds.reduce((s,c)=>s+c.amount,0),holds};};
let pool;
try{
 const catalog=await api('models'),selected={};
 for(const [slug,inputRate,outputRate] of [['deepseek-v4.1-flash',.3,1.2],['glm-5.3-flash',.15,.5]]){
  const matches=catalog.filter(m=>m.model===slug&&m.gatewayId==='a951fdd7-4eae-4ff3-9d6b-cfa26a6d8d95');assert.equal(matches.length,1);const m=matches[0];
  assert.equal(m.inputRate,inputRate);assert.equal(m.outputRate,outputRate);assert.equal(m.protocol,'chat-completions');assert.equal(m.thinkingMode,'disabled');selected[slug]=m;
 }
 assert.equal(selected['deepseek-v4.1-flash'].id,'c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051');
 assert.notEqual(selected['glm-5.3-flash'].id,selected['deepseek-v4.1-flash'].id);report.models=selected;
 report.before=await totals();assert.deepEqual(report.before.holds,previous?previous.after.holds:JSON.parse(readFileSync(join(out,'..','baseline.json'))).holds);
 assert.ok(report.before.spent+report.before.reserved+(limits.maxTrialCost-carryCost)<=limits.maxCumulative);
 assert.ok(!(await api('runs')).some(r=>['running','queued'].includes(r.status)));
 const {budgetedRequestEstimate,completeBudgeted}=await import(pathToFileURL(join(repo,'apps/api/src/cost-control.ts')).href);
 ({pool}=await import(pathToFileURL(join(repo,'apps/api/src/db.ts')).href));
 report.quotes=cells.map(cell=>{const b=bodyFor(cell.model,cell.variant),q=budgetedRequestEstimate(selected[cell.model],b.messages,b.max_tokens,{response_format:b.response_format});checkQuote({used:carryCost,calls:carryCalls,quote:q.reservation,occupied:report.before.spent+report.before.reserved},limits);return {...cell,...q,requestSha256:hash(b)};});save();
 if(mode==='approved-real'){
  assert.ok(process.env.DATABASE_URL&&process.env.DATA_DIR);
  await runMatrix({entries:report.requests,save,cells,
   async before(cell,body){
    const now=await totals(),current=(await api('models')).find(m=>m.id===selected[cell.model].id);assert.deepEqual(current,selected[cell.model],'Model configuration changed');
    assert.ok(!(await api('runs')).some(r=>['running','queued'].includes(r.status)));
    const quote=budgetedRequestEstimate(current,body.messages,body.max_tokens,{response_format:body.response_format}).reservation;
    checkQuote({used:carryCost+report.requests.reduce((s,r)=>s+(r.cost??r.reserved),0),calls:carryCalls+report.requests.length,quote,occupied:now.spent+now.reserved,unknownChanged:JSON.stringify(now.holds)!==JSON.stringify(report.before.holds)},limits);return quote;
   },
   dispatch(e){return completeBudgeted(selected[e.model],e.request.messages,e.request.max_tokens,{purpose:'规划模型与阶段提示对照',maxCost:Math.min(limits.maxCallCost,limits.maxTrialCost-carryCost-report.requests.slice(0,-1).reduce((s,r)=>s+(r.cost??r.reserved),0)),timeoutMs:180000,context:{experiment:'planning-ab-20261019',caseId:e.id,requestId:e.requestId,sessionId:'planning-ab:'+e.id}},{response_format:e.request.response_format});},
   async receipt(e){return (await pool.query(`SELECT r.id,r.status,r.amount::float8 AS amount,u.cost::float8 AS cost,u.input_tokens AS "inputTokens",u.output_tokens AS "outputTokens" FROM model_reservations r LEFT JOIN usage u ON u.id=r.id WHERE r.context->>'requestId'=$1`,[e.requestId])).rows;}
  });
 }
 report.completed=mode==='approved-real'&&report.requests.length===cells.length;
}catch(error){report.error={message:error.message,code:error.code};process.exitCode=1;}
finally{
 try{report.after=await totals();assert.deepEqual(report.after.holds,report.before?.holds,'Final holds changed');assert.ok(report.after.spent+report.after.reserved<=limits.maxCumulative+1e-9);assert.ok(carryCost+report.requests.reduce((s,r)=>s+(r.cost??r.reserved),0)<=limits.maxTrialCost+1e-9);}catch(e){report.error??={message:e.message};process.exitCode=1;}
 report.finishedAt=new Date().toISOString();save();await pool?.end();
}
console.log(JSON.stringify({mode,attemptedRequests:report.requests.length,completed:report.completed??false,error:report.error,out}));
