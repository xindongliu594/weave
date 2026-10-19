import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {organizationCandidateV2Schema} from '../packages/contracts/organization.ts';
import {validatePlan,type Model,type Plan} from '../packages/contracts/index.ts';
import {deliveryCriteriaErrors} from '../packages/contracts/orchestration.ts';
import {resolveOrganizationCandidate} from '../apps/api/src/organization-routing.ts';
import {organizationTaskInstructionsFor} from '../apps/api/src/organization-task-planning.ts';

const saved=JSON.parse(readFileSync(new URL('../docs/validation/evidence/orchestration-feedback-pilot-2026-10-19/real/broker-result.json',import.meta.url),'utf8'));
const raw=saved.requests[0].content,policy=JSON.parse(saved.requests[0].request.messages[1].content).policy;
const models=[{...saved.model,status:'available'} as Model];
const candidate=()=>organizationCandidateV2Schema.parse(JSON.parse(raw).candidate);
const plan=():Plan=>{const c=candidate();assert.equal(c.target.kind,'new');return {agents:(c.target as any).department.agents,rationale:c.rationale,tasks:c.tasks,orchestration:c.orchestration,deliveryCriteria:c.deliveryCriteria};};
// A local positive fixture only; never overwrite or count it as a model response.
const correct=()=>{const p=plan();p.deliveryCriteria=[
 {id:'function',description:'QA验证开发的功能',producerTaskIds:['develop'],checkTaskId:'verify',checkCriteriaIndexes:[0],independent:true},
 {id:'package',description:'经理核对含测试文件的最终交付',producerTaskIds:['develop','verify'],checkTaskId:'accept',checkCriteriaIndexes:[0],independent:true},
];return p;};

test('self-bound delivery reports one actionable binding error and leaves the original response unchanged',()=>{
 const p=plan(),before=JSON.stringify(p),errors=deliveryCriteriaErrors(p);
 assert.equal(errors.length,1,JSON.stringify(errors));assert.match(errors[0],/verify.*producerTaskIds.*checkTaskId/);
 assert.equal(JSON.stringify(p),before);
 assert.equal(createHash('sha256').update(raw).digest('hex'),'60de83d7d1d006743a5325a50fbf429eb8b957f3d0f77b520b56cce8d33f984e');
});

test('both composed validation boundaries report each delivery error once',async()=>{
 const errors=validatePlan(plan(),policy,models,false).errors.flatMap(e=>e.split('；'));
 assert.equal(errors.length,new Set(errors).size,JSON.stringify(errors));
 await assert.rejects(resolveOrganizationCandidate(candidate(),policy,{query:async()=>{throw Error('unexpected database lookup');}} as any),(error:any)=>{
  const parts=error.message.split('；');assert.equal(parts.length,new Set(parts).size,error.message);return error.code==='ORGANIZATION_CHAT_PLAN_INVALID';
 });
});

test('QA may author and run tests while manager independently checks the final package',()=>{
 const p=correct(),result=validatePlan(p,policy,models,false);
 assert.equal(result.valid,true,JSON.stringify(result.errors));
 assert.deepEqual(p.tasks.find(t=>t.id==='verify')!.outputs,[{path:'test/temperature.test.js',format:'text'}]);
 assert.deepEqual(p.tasks.find(t=>t.id==='verify')!.verify,['node --test test/temperature.test.js']);
 assert.equal(p.agents.length,4,'no new reviewer invented');
 assert.ok(deliveryCriteriaErrors(plan()).length,'the untouched real candidate remains rejected');
});

test('different node with same author, missing inputs, wrong order and later writes still fail',()=>{
 const same=correct();same.tasks.find(t=>t.id==='verify')!.assigneeId='developer';assert.match(deliveryCriteriaErrors(same).join('；'),/不同/);
 const missing=correct();missing.tasks.find(t=>t.id==='accept')!.inputs=[];assert.match(deliveryCriteriaErrors(missing).join('；'),/当前产物/);
 const order=correct();order.tasks.find(t=>t.id==='accept')!.dependencies=[];assert.match(deliveryCriteriaErrors(order).join('；'),/之后/);
 const writes=correct();writes.tasks.find(t=>t.id==='accept')!.outputs=[{path:'src/temperature.js'}];assert.match(deliveryCriteriaErrors(writes).join('；'),/后续或无序写入/);
 const mixed=plan();mixed.tasks.find(t=>t.id==='verify')!.inputs=[];mixed.deliveryCriteria![0].checkCriteriaIndexes=[99];
 const errors=deliveryCriteriaErrors(mixed).join('；');assert.match(errors,/src\/temperature.js/);assert.match(errors,/索引/);
});

test('the actual planning prompt contains delivery examples that validate with its own task examples',()=>{
 for(const templatePreview of [false,true]){
  const prompt=organizationTaskInstructionsFor(['filesystem','artifact_write','terminal'],templatePreview),lines=prompt.split('\n');
  const line=lines.find(l=>l.startsWith('{"deliveryCriteria":'));assert.ok(line,'task examples need matching delivery bindings');
  const tasks=JSON.parse(lines.at(-1)!),deliveryCriteria=JSON.parse(line).deliveryCriteria,p=correct();
  p.tasks=tasks;p.deliveryCriteria=deliveryCriteria;p.agents=p.agents.filter(a=>a.id!=='analyst');
  if(!templatePreview)delete p.orchestration;
  const result=validatePlan(p,policy,models,false);assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(deliveryCriteria.find((c:any)=>c.checkTaskId==='verify').producerTaskIds.includes('verify'),false);
  const bad=structuredClone(p);bad.deliveryCriteria!.find(c=>c.checkTaskId==='verify')!.producerTaskIds.push('verify');assert.ok(deliveryCriteriaErrors(bad).length);
 }
});
