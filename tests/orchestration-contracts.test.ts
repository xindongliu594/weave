import test from 'node:test';
import assert from 'node:assert/strict';
import {planSchema,validatePlan,type Plan} from '../packages/contracts/index.ts';
import {organizationCandidateV2Schema} from '../packages/contracts/organization.ts';
import {deliveryCriteriaErrors,deliveryCriteriaRevisionErrors} from '../packages/contracts/orchestration.ts';

const agents:Plan['agents']=[{id:'worker',role:'member',name:'作者',title:'编写',instructions:'完成任务',modelId:'m',tools:[]},{id:'manager',role:'manager',name:'经理',title:'验收',instructions:'核对交付',modelId:'m',tools:[]}];
const task=(id:string,assigneeId:string,dependencies:string[]=[])=>({id,assigneeId,dependencies,subject:id,objective:'按要求工作',acceptanceCriteria:['核对内容'],handoff:{sections:[{key:'evidence',requirement:'逐项说明依据'}]},estimatedInputTokens:100,estimatedOutputTokens:100});
const base:Plan={rationale:'按职责交接',agents,tasks:[task('write','worker'),task('check','manager',['write'])]};
const extra={orchestration:{pattern:'single',rationale:'小任务只需一位作者及经理检查'},deliveryCriteria:[{id:'content',description:'材料完整',producerTaskIds:['write'],checkTaskId:'check',checkCriteriaIndexes:[0],independent:true}]};

test('delivery producers must be final declared writers of their files',()=>{
 const plan=planSchema.parse({...base,...extra});plan.tasks[0].outputs=[{path:'report.txt'}];plan.tasks[1].inputs=[{path:'report.txt',producerTaskId:'write'}];
 plan.tasks.push({...task('deliver','manager',['check']),outputs:[{path:'report.txt'}]});
 assert.match(deliveryCriteriaErrors(plan).join(';'),/report.txt/);
 plan.tasks[2].dependencies=[];assert.match(deliveryCriteriaErrors(plan).join(';'),/report.txt/);
 plan.tasks[0].dependencies=['deliver'];assert.deepEqual(deliveryCriteriaErrors(plan),[],'an earlier file version is valid if the selected producer replaces it before review');
});

test('legacy plans stay unchanged and new organization fields survive serialization',()=>{
 assert.deepEqual(planSchema.parse(base),base);
 const parsed=planSchema.parse({...base,...extra});
 assert.deepEqual(JSON.parse(JSON.stringify(parsed)),{...base,...extra});
 assert.deepEqual(deliveryCriteriaErrors(parsed),[]);
});
test('delivery checks require an evidence channel and the declared producer files',()=>{
 const plan=planSchema.parse({...base,...extra});delete plan.tasks[1].handoff;
 assert.match(deliveryCriteriaErrors(plan).join(';'),/证据/);
 plan.tasks[1].handoff=base.tasks[1].handoff;plan.tasks[0].outputs=[{path:'report.txt'}];
 assert.match(deliveryCriteriaErrors(plan).join(';'),/report.txt/);
 plan.tasks[1].inputs=[{path:'report.txt',producerTaskId:'write'}];assert.deepEqual(deliveryCriteriaErrors(plan),[]);
});
test('V2 requires a target and delivery criteria, preserving the existing identity selection',()=>{
 const candidate={schemaVersion:2,target:{kind:'existing',departmentId:'d',departmentVersion:1,primaryAgentIds:['worker','manager'],collaboratingAgents:[]},rationale:base.rationale,tasks:base.tasks,...extra};
 assert.deepEqual(organizationCandidateV2Schema.parse(candidate),candidate);
 assert.equal(organizationCandidateV2Schema.safeParse({...candidate,deliveryCriteria:[]}).success,false);
 assert.equal(organizationCandidateV2Schema.safeParse({...candidate,target:{...candidate.target,sourceDepartmentId:'forged'}}).success,false);
});
test('manager waits for delivery checks and AI revision cannot drop confirmed requirements',()=>{
 const plan=planSchema.parse({...base,...extra});plan.agents.push({...plan.agents[0],id:'qa'});plan.tasks[1].assigneeId='qa';
 assert.match(deliveryCriteriaErrors(plan).join(';'),/经理/);
 plan.tasks.push(task('deliver','manager',['check']));assert.deepEqual(deliveryCriteriaErrors(plan),[]);
 const dropped=structuredClone(plan);delete dropped.deliveryCriteria;
 assert.ok(deliveryCriteriaRevisionErrors(plan,dropped).length);
 const reduced=structuredClone(plan);reduced.deliveryCriteria![0].independent=false;assert.ok(deliveryCriteriaRevisionErrors(plan,reduced).length);
 assert.deepEqual(deliveryCriteriaRevisionErrors(plan,structuredClone(plan)),[]);
});
test('delivery checks reject missing, duplicate, cyclic, unordered or self-reviewed references',()=>{
 const valid=()=>planSchema.parse({...base,...extra});
 const missing=valid();missing.deliveryCriteria![0].producerTaskIds=['absent'];
 const unordered=valid();unordered.tasks[1].dependencies=[];
 const self=valid();self.tasks[1].assigneeId='worker';
 const cyclic=valid();cyclic.tasks[0].dependencies=['check'];
 const index=valid();index.deliveryCriteria![0].checkCriteriaIndexes=[4];
 const duplicate=valid();duplicate.deliveryCriteria!.push({...duplicate.deliveryCriteria![0]});
 for(const plan of [missing,unordered,self,cyclic,index,duplicate])assert.match(deliveryCriteriaErrors(plan).join(';'),/content/);
 const plan=valid();plan.tasks.splice(1,0,task('middle','worker',['write']));plan.tasks[2].dependencies=['middle'];
 assert.deepEqual(deliveryCriteriaErrors(plan),[],'transitive dependencies are valid');
});
