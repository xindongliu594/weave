import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchema, validatePlan, type Plan, type Model } from '../packages/contracts/index.ts';
import { toolEvidence } from './model-fixture.ts';
const model:Model={id:'model',name:'Test',gatewayId:'gateway',model:'model',inputRate:1,outputRate:1,version:1,status:'available',capabilities:toolEvidence};
const policy={maxBudget:1,maxAgents:2,maxConcurrentAgents:2,deadlineSeconds:600};
const base:Plan={rationale:'文件交接',agents:[{id:'manager',name:'经理',role:'manager',title:'经理',instructions:'协调',modelId:'model',tools:['artifact_write','filesystem','terminal_test']}],tasks:[
  {id:'produce',subject:'生成数据',objective:'生成结果',assigneeId:'manager',dependencies:[],acceptanceCriteria:['字段符合要求'],estimatedInputTokens:100,estimatedOutputTokens:100,outputs:[{path:'data.json',format:'json',requiredKeys:['count'],expectedValues:{count:2}}]},
  {id:'consume',subject:'消费数据',objective:'读取结果',assigneeId:'manager',dependencies:['produce'],acceptanceCriteria:['引用正确版本'],estimatedInputTokens:100,estimatedOutputTokens:100,inputs:[{path:'data.json',producerTaskId:'produce'}]},
]};
test('approved file contracts survive parsing and valid producer/consumer plans pass',()=>{
  const parsed=planSchema.parse(base);assert.equal(parsed.tasks[0].outputs?.[0].expectedValues?.count,2);assert.equal(validatePlan(parsed,policy,[model]).valid,true);
});
test('missing source edges, unknown output and unordered writers/readers fail product validation',()=>{
  const cases:Plan[]=[];
  const noEdge=structuredClone(base);noEdge.tasks[1].dependencies=[];cases.push(noEdge);
  const unknown=structuredClone(base);unknown.tasks[1].inputs![0].path='missing.json';cases.push(unknown);
  const competing=structuredClone(base);competing.tasks.push({...competing.tasks[0],id:'competing'});cases.push(competing);
  const missingGrant=structuredClone(base);missingGrant.agents[0].tools=['artifact_write'];cases.push(missingGrant);
  assert.equal(validatePlan(missingGrant,policy,[model],false).valid,true,'organization preview may declare files before user grants tools');
  for(const plan of cases)assert.equal(validatePlan(plan,policy,[model]).checks.find(c=>c.label==='文件交接与质量合同')?.pass,false);
});
test('downstream cannot name an older writer after an upstream replacement',()=>{
  const plan=structuredClone(base);plan.tasks.splice(1,0,{...plan.tasks[0],id:'replacement',dependencies:['produce']});plan.tasks[2].dependencies=['replacement'];
  assert.equal(validatePlan(plan,policy,[model]).valid,false);
  plan.tasks[2].inputs![0].producerTaskId='replacement';assert.equal(validatePlan(plan,policy,[model]).valid,true);
});
test('schema rejects unsafe paths, unpinned external files and incompatible JSON checks',()=>{
  for(const path of ['../outside','/etc/passwd','a\\b','a//b','.agent-teams/team.json']){const plan=structuredClone(base);plan.tasks[0].outputs![0].path=path;assert.equal(planSchema.safeParse(plan).success,false);}
  const fixed=structuredClone(base);fixed.tasks[1].inputs=[{path:'data.json'}];assert.equal(planSchema.safeParse(fixed).success,false);
  fixed.tasks[1].inputs[0].sha256='a'.repeat(64);assert.equal(planSchema.safeParse(fixed).success,true);
  fixed.tasks[0].outputs![0].format='text';assert.equal(planSchema.safeParse(fixed).success,false);
});
test('quality tasks require command grants, scope, valid references and an independent reviewer',()=>{
  const plan=structuredClone(base);plan.tasks[0].kind='implementation';plan.tasks[1].kind='review';plan.tasks[1].reviewedTaskId='produce';
  assert.equal(validatePlan(plan,policy,[model]).valid,false);
  plan.tasks[0].inScope=['data.json'];plan.tasks[0].verify=['node verify.mjs'];plan.agents.push({...plan.agents[0],id:'reviewer',role:'member'});plan.tasks[1].assigneeId='reviewer';
  assert.equal(validatePlan(plan,policy,[model]).valid,true);
  plan.agents[0].tools=['artifact_write','filesystem'];assert.equal(validatePlan(plan,policy,[model]).valid,false);
});
