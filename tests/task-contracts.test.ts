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
test('Office binary files cannot be approved with text or JSON output checks',()=>{
  for(const path of ['report.docx','metrics.XLSX','brief.pptx']) {
    const plan=structuredClone(base);
    plan.tasks[0].outputs=[{path,format:'text'}];plan.tasks[1].inputs=[{path,producerTaskId:'produce'}];
    for(const format of ['text','json'] as const) {
      plan.tasks[0].outputs[0].format=format;
      assert.match(validatePlan(plan,policy,[model]).errors.join(';'),/二进制.*省略 format/);
    }
    delete plan.tasks[0].outputs[0].format;
    assert.equal(validatePlan(plan,policy,[model]).valid,true,'generic binary output retains host file/hash checks');
  }
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

test('declared outputs must fit host file scopes before any employee executes',()=>{
  const plan=structuredClone(base);plan.tasks[0].kind='implementation';plan.tasks[0].verify=['node check.mjs'];
  plan.tasks[0].inScope=['只生成要求的文件'];
  assert.equal(validatePlan(plan,policy,[model]).valid,false,'natural-language scope cannot authorize data.json');
  plan.tasks[0].inScope=['data.json'];assert.equal(validatePlan(plan,policy,[model]).valid,true);
  plan.tasks[0].outputs![0].path='src/data.json';plan.tasks[1].inputs![0].path='src/data.json';plan.tasks[0].inScope=['src'];
  assert.equal(validatePlan(plan,policy,[model]).valid,true,'directory scopes include descendants');
  plan.tasks[0].outOfScope=['src/data.json'];assert.equal(validatePlan(plan,policy,[model]).valid,false);
  plan.tasks[0].outOfScope=['src'];assert.equal(validatePlan(plan,policy,[model]).valid,false,'denied directories override allowed paths');
  plan.tasks[0].kind='verification';plan.tasks[0].outOfScope=[];plan.tasks[0].inScope=['src-old'];
  assert.equal(validatePlan(plan,policy,[model]).valid,false,'verification writers have the same scope boundary');
});

test('automatic rework is explicit, bounded, read-only in review and gates all consumers',()=>{
  const plan=structuredClone(base);
  plan.tasks[0]={...plan.tasks[0],kind:'implementation',inputs:[],inScope:['data.json'],verify:['node check.mjs']};
  plan.agents.push({...plan.agents[0],id:'reviewer',role:'member',tools:['filesystem']});
  plan.tasks[1]={...plan.tasks[1],kind:'review',assigneeId:'reviewer',reviewedTaskId:'produce',outputs:[],maxReworkRounds:2};
  assert.equal(planSchema.parse(plan).tasks[1].maxReworkRounds,2);assert.equal(validatePlan(plan,policy,[model]).valid,true);
  for(const mutate of [
    (p:Plan)=>{p.tasks[1].maxReworkRounds=3;},
    (p:Plan)=>{p.tasks[1].kind='work';},
    (p:Plan)=>{delete p.tasks[0].inputs;},
    (p:Plan)=>{p.tasks[1].inputs=[];},
    (p:Plan)=>{p.tasks[1].inputs![0].sha256='a'.repeat(64);},
    (p:Plan)=>{p.tasks[1].outputs=[{path:'review.md'}];},
    (p:Plan)=>{p.agents[0].tools=['artifact_write','terminal_test'];},
    (p:Plan)=>{p.tasks.push({...base.tasks[1],id:'deliver'});},
    (p:Plan)=>{p.tasks.push({...base.tasks[1],id:'textConsumer',inputs:undefined});},
    (p:Plan)=>{p.tasks.push({...p.tasks[1],id:'otherReview'});},
  ]){const invalid=structuredClone(plan);mutate(invalid);assert.equal(validatePlan(invalid,policy,[model]).valid,false);}
});
