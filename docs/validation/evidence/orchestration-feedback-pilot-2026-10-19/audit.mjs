// Reads saved evidence only. Never edits a candidate or calls a model.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {organizationCandidateV2Schema} from '../../../../packages/contracts/organization.ts';
import {validatePlan} from '../../../../packages/contracts/index.ts';
import {organizationTaskContractErrors} from '../../../../apps/api/src/organization-draft-diagnostics.ts';
const read=name=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8'));
const report=read('real/broker-result.json'),response=read('real/bounded-code-review.json'),planning=read('real/planning-results.json');
assert.equal(report.mode,'approved-real');assert.equal(report.profile,'feedback-correction');assert.equal(report.requests.length,1);assert.equal(report.error,undefined);
assert.equal(report.workerResult.replayedResponses,1);assert.equal(report.workerResult.projectWrites,0);assert.equal(report.workerResult.departmentWrites,0);
assert.deepEqual(report.before.holds,report.after.holds);assert.equal(report.after.holds.length,6);
const entry=report.requests[0];assert.equal(entry.finishReason,'stop');assert.equal(entry.receipts.length,1);assert.equal(entry.receipts[0].status,'settled');
assert.equal(entry.usageId,entry.receipts[0].id);assert.equal(entry.cost,entry.receipts[0].cost);assert.ok(entry.cost<=entry.reserved&&entry.reserved<=.02);
assert.ok(Math.abs(report.after.spent-report.before.spent-entry.cost)<1e-9);assert.ok(report.after.spent+report.after.reserved<=3.41);
const sha=createHash('sha256').update(entry.content).digest('hex');assert.equal(sha,response.outputDiagnostic.originalOutputSHA);
const parsed=organizationCandidateV2Schema.safeParse(JSON.parse(entry.content).candidate);assert.ok(parsed.success,JSON.stringify(parsed.error));
const value=parsed.data,agents=value.target.department.agents,plan={agents,rationale:value.rationale,tasks:value.tasks,orchestration:value.orchestration,deliveryCriteria:value.deliveryCriteria};
const policy=JSON.parse(entry.request.messages[1].content).policy;
assert.deepEqual(organizationTaskContractErrors(plan.tasks,plan.agents),[],'Earlier independent file/acceptance defects must be gone');
const validation=validatePlan(plan,policy,[{...report.model,status:'available'}],false);
assert.equal(validation.valid,false);assert.ok(validation.errors.some(e=>e.includes('检查任务 verify')));
const criterion=value.deliveryCriteria[0];assert.equal(criterion.checkTaskId,'verify');assert.ok(criterion.producerTaskIds.includes(criterion.checkTaskId));
assert.equal(response.preview,undefined);assert.equal(planning[0].validPreview,false);assert.equal(report.acceptancePassed,false);
const summary={sourceCommit:report.sourceCommit,realCalls:1,localReplays:1,validPreviews:0,selectedTemplate:value.orchestration.template.id,
 requestId:entry.requestId,receiptId:entry.usageId,finishReason:entry.finishReason,cost:entry.cost,reserved:entry.reserved,inputTokens:entry.usage.prompt_tokens,outputTokens:entry.usage.completion_tokens,
 occupied:report.after.spent+report.after.reserved,unchangedUnknowns:6,strictSchemaValid:true,independentTaskContractErrors:[],deliveryErrors:[...new Set(validation.errors)],
 outputSHA256:sha,projectWrites:0,departmentWrites:0,criterion,
 dag:plan.tasks.map(t=>({id:t.id,assignee:t.assigneeId,dependencies:t.dependencies,outputs:t.outputs??[]})),
 note:'One real correction failed independent delivery acceptance; no employee execution, deployment, or automatic retry.'};
writeFileSync(new URL('audit.json',import.meta.url),JSON.stringify(summary,null,2));
console.log(JSON.stringify({realCalls:1,validPreviews:0,cost:summary.cost,occupied:summary.occupied,strictSchemaValid:summary.strictSchemaValid,independentTaskContractErrors:[],deliveryErrors:summary.deliveryErrors}));
