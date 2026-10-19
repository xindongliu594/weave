// Read-only replay of the saved provider responses; never repairs a candidate.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const here=fileURLToPath(new URL('.',import.meta.url)),repo=resolve(here,'../../../..');
const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const report=read('real/broker-result.json'),results=read('real/planning-results.json');
assert.equal(report.profile,'repair-smoke');assert.equal(report.requests.length,2);assert.equal(report.error,undefined);
assert.deepEqual(report.before.holds,report.after.holds);assert.equal(report.after.holds.length,6);
assert.equal(report.workerResult.projectWrites,0);assert.equal(report.workerResult.departmentWrites,0);
const cases=report.requests.map(entry=>{
 const candidate=JSON.parse(entry.content).candidate;
 assert.equal(entry.finishReason,'stop');assert.ok(entry.usageId&&entry.receipts.length===1);
 assert.equal(entry.receipts[0].status,'settled');assert.ok(entry.cost<=.02);
 return {id:entry.id,requestId:entry.requestId,receiptId:entry.usageId,selectedTemplate:candidate.orchestration.template.id,
  validPreview:results.find(r=>r.id===entry.id).validPreview,finishReason:entry.finishReason,cost:entry.cost,...entry.usage,
  plannedBudget:candidate.tasks.reduce((s,t)=>s+t.maxBudget,0),assumedBudget:.25,
  handoffUnexpectedKeys:candidate.tasks.flatMap(t=>Object.keys(t.handoff??{}).filter(k=>k!=='sections').map(key=>({taskId:t.id,key}))),
  outputTasksWithoutWriter:candidate.tasks.filter(t=>t.outputs?.length&&!candidate.target.department.agents.find(a=>a.id===t.assigneeId).tools.some(tool=>['artifact_write','terminal'].includes(tool))).map(t=>t.id),
  dag:candidate.tasks.map(t=>({id:t.id,assignee:t.assigneeId,dependencies:t.dependencies,outputs:t.outputs??[]}))};
});
assert.equal(cases[0].validPreview,true);assert.equal(cases[0].selectedTemplate,'pipeline');assert.ok(cases[0].plannedBudget<=.25);
assert.deepEqual(cases[0].handoffUnexpectedKeys,[]);assert.deepEqual(cases[0].outputTasksWithoutWriter,[]);
assert.equal(cases[1].validPreview,false);assert.equal(cases[1].selectedTemplate,'review_repair');assert.ok(cases[1].plannedBudget>.25);
assert.equal(cases[1].handoffUnexpectedKeys.length,4);assert.deepEqual(cases[1].outputTasksWithoutWriter,['clarify']);
let verifiedFiles=0;
for(const line of readFileSync(new URL('source-hashes.sha256',import.meta.url),'utf8').trim().split('\n')){
 const [expected,path]=line.trim().split(/\s+/);
 const bytes=path.startsWith('apps/')?execFileSync('git',['show','4283f2b:'+path],{cwd:repo}):readFileSync(resolve(repo,path));
 // git archive on this Windows checkout emits CRLF; match bytes or newline-only conversion.
 const lf=bytes.toString('utf8').replace(/\r\n/g,'\n');
 assert.ok([bytes,lf,lf.replace(/\n/g,'\r\n')].some(value=>createHash('sha256').update(value).digest('hex')===expected),path);verifiedFiles++;
}
const cost=cases.reduce((s,c)=>s+c.cost,0);assert.ok(cost<=.04);
assert.ok(Math.abs(report.after.spent-report.before.spent-cost)<1e-9);
const summary={sourceCommit:report.sourceCommit,cases,cost,inputTokens:cases.reduce((s,c)=>s+c.prompt_tokens,0),outputTokens:cases.reduce((s,c)=>s+c.completion_tokens,0),
 occupied:report.after.spent+report.after.reserved,unchangedUnknowns:6,verifiedFiles,validPreviews:1,realCalls:2,extraCalls:0,projectWrites:0,departmentWrites:0,
 note:'Recorded preview contract checks plus read-only inspection; no employee execution or delivery acceptance.'};
writeFileSync(new URL('audit.json',import.meta.url),JSON.stringify(summary,null,2));
console.log(JSON.stringify({validPreviews:summary.validPreviews,realCalls:2,cost,inputTokens:summary.inputTokens,outputTokens:summary.outputTokens,occupied:summary.occupied,verifiedFiles}));
