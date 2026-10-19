import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {organizationDraftDiagnostics} from '../apps/api/src/organization-draft-diagnostics.ts';
import {organizationCandidateV2Schema} from '../packages/contracts/organization.ts';
import {policySchema,type Model} from '../packages/contracts/index.ts';
const evidence=JSON.parse(readFileSync(new URL('../docs/validation/evidence/orchestration-smoke-2026-10-19/real/broker-result.json',import.meta.url),'utf8'));
const raw=JSON.parse(evidence.requests[1].content).candidate;
const policy=policySchema.parse({maxBudget:.25,maxAgents:6,maxConcurrentAgents:3,deadlineSeconds:600,allowedModelIds:[evidence.model.id],allowedTools:['filesystem','artifact_write','terminal']});
const models=[{...evidence.model,status:'available',version:1,gatewayId:'fixture'} as Model];

test('real draft diagnostics reuse independent checks without mutation or acceptance',()=>{
 const before=JSON.stringify(raw),errors=organizationDraftDiagnostics(raw,true,policy,models);
 assert.ok(errors.some(e=>e.includes('clarify: 输出文件需要写入工具权限')));
 assert.ok(errors.some(e=>e.includes('develop: 逐项检查必须恰好覆盖每一条验收标准')));
 assert.equal(errors.filter(e=>e.includes('develop: 逐项检查必须恰好覆盖每一条验收标准')).length,1,'aggregate and individual errors must not duplicate the same contract finding');
 assert.ok(errors.some(e=>e.includes('verify: Node 测试映射必须填写最低测试数')));
 assert.equal(JSON.stringify(raw),before);assert.equal(organizationCandidateV2Schema.safeParse(raw).success,false);
 assert.ok(!errors.some(e=>e.includes('超过剩余预算')),'task ceilings share the project pool; they are not added as estimates');
 assert.ok(organizationDraftDiagnostics(raw,true,{...policy,maxBudget:.001},models).some(e=>e.includes('超过剩余预算')),'actual estimated overflow is still rejected');
});

test('malformed task, team or target data never enters typed task validation',()=>{
 const badDependency=structuredClone(raw);badDependency.tasks[0].dependencies='invalid';
 const badAgent=structuredClone(raw);badAgent.target.department.agents[0].tools={};
 const badInputs=structuredClone(raw);badInputs.tasks[0].inputs=[null];
 const oversized=structuredClone(raw);oversized.tasks=Array(51).fill(raw.tasks[0]);
 for(const value of [null,[],{}, {...raw,tasks:null},badDependency,badAgent,badInputs,oversized])assert.deepEqual(organizationDraftDiagnostics(value,true,policy,models),[]);
});

test('existing-team failure cannot resolve or invent employees for diagnostics',()=>{
 const value={...raw,target:{kind:'existing',departmentId:'private',departmentVersion:1,primaryAgentIds:['hidden'],collaboratingAgents:[]}};
 assert.deepEqual(organizationDraftDiagnostics(value,true,policy,models),[]);
});

test('legacy drafts use the same independent contract checks',()=>{
 const value={department:raw.target.department,rationale:raw.rationale,tasks:raw.tasks};
 assert.ok(organizationDraftDiagnostics(value,false,policy,models).some(e=>e.includes('clarify: 输出文件需要写入工具权限')));
});

test('multiple file-contract findings are returned individually once',()=>{
 const value=structuredClone(raw);value.tasks.find((t:any)=>t.id==='develop').inScope=['other.txt'];
 const errors=organizationDraftDiagnostics(value,true,policy,models);
 assert.equal(errors.filter(e=>e.includes('develop: 逐项检查必须恰好覆盖每一条验收标准')).length,1);
 assert.equal(errors.filter(e=>e.includes('不在允许修改的文件或目录范围内')).length,1);
});

test('valid real sequential preview has no additional diagnostics',()=>{
 const valid=JSON.parse(evidence.requests[0].content).candidate;
 assert.deepEqual(organizationDraftDiagnostics(valid,true,policy,models),[]);
});
