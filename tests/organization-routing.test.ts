import test from 'node:test';
import assert from 'node:assert/strict';
import {loadOrganizationCatalog,resolveOrganizationCandidate} from '../apps/api/src/organization-routing.ts';
import {buildProjectTeam} from '../apps/api/src/collaboration.ts';
import type {OrganizationCandidateV2} from '../packages/contracts/organization.ts';
const employee=(id:string,role:'manager'|'member'='member')=>({id,role,name:id,title:'资料分析',instructions:'私有职责',modelId:'m',tools:['filesystem'] as const,knowledgeSpaceIds:['private']});
const primary={id:'primary',version:2,data:{name:'研究部',description:'整理资料',agents:[employee('manager','manager'),employee('worker'),employee('unused')]}};
const other={id:'other',version:1,data:{name:'复核部',description:'复核',agents:[employee('reviewer','manager')]}};
const rows=[primary,other];
const db:any={query:async(_sql:string,args:any[])=>({rows:rows.filter(d=>(Array.isArray(args[0])?args[0]:[args[0]]).includes(d.id))})};
const policy={maxBudget:1,maxAgents:3,maxConcurrentAgents:2,deadlineSeconds:600,allowedModelIds:['m'],allowedTools:['filesystem'] as any,allowedKnowledgeSpaceIds:[],allowedDepartmentIds:['primary','other']};
const task=(id:string,assigneeId:string,dependencies:string[]=[])=>({id,assigneeId,dependencies,subject:id,objective:'整理资料',acceptanceCriteria:['核对内容'],handoff:{sections:[{key:'evidence',requirement:'逐项说明依据'}]},estimatedInputTokens:100,estimatedOutputTokens:100});
const candidate=():OrganizationCandidateV2=>({schemaVersion:2,target:{kind:'existing',departmentId:'primary',departmentVersion:2,primaryAgentIds:['manager','worker'],collaboratingAgents:[{departmentId:'other',departmentVersion:1,agentId:'reviewer'}]},rationale:'已有员工适合',orchestration:{pattern:'pipeline',rationale:'先产出后复核'},tasks:[task('write','worker'),task('check','other::reviewer',['write']),task('deliver','manager',['check'])],deliveryCriteria:[{id:'content',description:'内容准确',producerTaskIds:['write'],checkTaskId:'check',checkCriteriaIndexes:[0],independent:true}]});

test('catalog exposes only allowed identity and capability summaries, not private instructions or knowledge',async()=>{
 const catalog=await loadOrganizationCatalog(db,{...policy,allowedDepartmentIds:['primary']});
 assert.deepEqual(catalog.departments.map(d=>d.id),['primary']);
 assert.equal(JSON.stringify(catalog).includes('私有职责'),false);assert.equal(JSON.stringify(catalog).includes('private'),false);
 assert.deepEqual((await loadOrganizationCatalog(db,{...policy,allowedDepartmentIds:undefined})).departments,[]);
});
test('resolved team keeps source identities, limits grants, and does not modify the department',async()=>{
 const before=JSON.stringify(rows),draft=await resolveOrganizationCandidate(candidate(),policy,db);
 assert.deepEqual(draft.plan.agents.map(a=>a.id),['manager','worker','other::reviewer']);
 assert.ok(draft.plan.agents.every(a=>a.knowledgeSpaceIds?.length===0));
 assert.equal(draft.plan.agents[2].role,'member');assert.equal(draft.plan.agents[2].sourceAgentId,'reviewer');
 assert.deepEqual(draft.sourceDepartmentVersions,[{id:'primary',version:2},{id:'other',version:1}]);assert.equal(JSON.stringify(rows),before);
});
test('subsets preserve legacy calls and cannot drop the manager or smuggle employee identity',async()=>{
 assert.equal((await buildProjectTeam(primary as any,[],db)).agents.length,3);
 for(const ids of [['worker'],['manager','missing'],['manager','manager']])await assert.rejects(buildProjectTeam(primary as any,[],db,ids));
 const stale=candidate();if(stale.target.kind==='existing')stale.target.departmentVersion=1;
 await assert.rejects(resolveOrganizationCandidate(stale,policy,db),/版本/);
 await assert.rejects(resolveOrganizationCandidate(candidate(),{...policy,allowedDepartmentIds:['primary']},db),/授权/);
 const malicious:any=candidate();malicious.target.sourceDepartmentId='forged';await assert.rejects(resolveOrganizationCandidate(malicious,policy,db));
});
