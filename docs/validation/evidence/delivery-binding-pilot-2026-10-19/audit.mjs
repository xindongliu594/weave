// Re-check saved real evidence only; never rewrites model candidates or dispatches.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {organizationCandidateV2Schema} from '../../../../packages/contracts/organization.ts';
import {validatePlan} from '../../../../packages/contracts/index.ts';
import {organizationTaskContractErrors} from '../../../../apps/api/src/organization-draft-diagnostics.ts';
const read=name=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8'));
const report=read('real/broker-result.json'),response=read('real/bounded-code-review.json'),planning=read('real/planning-results.json'),seed=read('real/replayed-failure.json');
assert.equal(report.mode,'approved-real');assert.equal(report.profile,'delivery-binding');assert.equal(report.requests.length,1);assert.equal(report.error,undefined);
assert.equal(report.workerResult.replayedResponses,1);assert.equal(report.workerResult.projectWrites,0);assert.equal(report.workerResult.departmentWrites,0);
assert.deepEqual(report.before.holds,report.after.holds);assert.equal(report.after.holds.length,6);
assert.equal(seed.sourceSha256,'60de83d7d1d006743a5325a50fbf429eb8b957f3d0f77b520b56cce8d33f984e');
assert.equal(seed.result.preview,undefined);assert.equal(seed.result.draftIssue.message.split('形成自我验收').length-1,1);
const entry=report.requests[0];assert.equal(entry.finishReason,'stop');assert.equal(entry.receipts.length,1);assert.equal(entry.receipts[0].status,'settled');
assert.equal(entry.usageId,entry.receipts[0].id);assert.equal(entry.cost,entry.receipts[0].cost);assert.ok(entry.cost<=entry.reserved&&entry.reserved<=.02);
assert.ok(Math.abs(report.after.spent-report.before.spent-entry.cost)<1e-9);assert.ok(report.after.spent+report.after.reserved<=3.41);
assert.equal(JSON.parse(entry.request.messages[2].content).message,seed.result.draftIssue.message);
const sha=createHash('sha256').update(entry.content).digest('hex');
if(response.outputDiagnostic)assert.equal(sha,response.outputDiagnostic.originalOutputSHA);
const parsed=organizationCandidateV2Schema.safeParse(JSON.parse(entry.content).candidate);assert.ok(parsed.success,JSON.stringify(parsed.error));
const value=parsed.data;assert.equal(value.target.kind,'new');
const plan={agents:value.target.department.agents,rationale:value.rationale,tasks:value.tasks,orchestration:value.orchestration,deliveryCriteria:value.deliveryCriteria};
const policy=JSON.parse(entry.request.messages[1].content).policy,validation=validatePlan(plan,policy,[{...report.model,status:'available'}],false);
const taskErrors=organizationTaskContractErrors(plan.tasks,plan.agents);
assert.equal(Boolean(response.preview),Boolean(planning[0].validPreview));assert.equal(report.acceptancePassed,Boolean(response.preview));
if(response.preview){
 assert.deepEqual(response.preview.plan.tasks,plan.tasks);assert.deepEqual(response.preview.plan.deliveryCriteria,plan.deliveryCriteria);
 assert.equal(response.preview.source,'model');assert.equal(response.preview.validation.valid,true);
}
const summary={sourceCommit:report.sourceCommit,realCalls:1,localReplays:1,validPreviews:Number(Boolean(response.preview)),selectedTemplate:value.orchestration.template.id,
 requestId:entry.requestId,receiptId:entry.usageId,previewId:response.preview?.previewId,finishReason:entry.finishReason,cost:entry.cost,reserved:entry.reserved,inputTokens:entry.usage.prompt_tokens,outputTokens:entry.usage.completion_tokens,
 occupied:report.after.spent+report.after.reserved,unchangedUnknowns:6,strictSchemaValid:true,trialPreviewPassed:Boolean(response.preview),currentContractPassed:validation.valid&&taskErrors.length===0,taskContractErrors:taskErrors,planErrors:validation.errors,
 outputSHA256:sha,projectWrites:0,departmentWrites:0,deliveryCriteria:plan.deliveryCriteria,
 dag:plan.tasks.map(t=>({id:t.id,assignee:t.assigneeId,dependencies:t.dependencies,inputs:t.inputs??[],outputs:t.outputs??[],verify:t.verify??[],handoff:t.handoff})),
 note:'Original trial preview is preserved. Current checks separately detect the future QA file dependency; do not treat preview success as overall planning quality. No employee execution, production deployment, or automatic retry.'};
writeFileSync(new URL('audit.json',import.meta.url),JSON.stringify(summary,null,2));
console.log(JSON.stringify({realCalls:1,validPreviews:summary.validPreviews,cost:summary.cost,occupied:summary.occupied,taskContractErrors:taskErrors,planErrors:validation.errors}));
