import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OrganizationRecommendation,OrganizationDepartmentScope} from '../apps/web/src/OrganizationRecommendation.tsx';
import {organizationConfirmationRequest,createOrganizationChatRequest,type Preview} from '../apps/web/src/organization-draft.ts';
import {orchestrationFixture} from './fixtures/orchestration-patterns.ts';
const plan:any={rationale:'',agents:[{id:'a',name:'作者'},{id:'q',name:'复核员'}],tasks:[{id:'write',assigneeId:'a',subject:'写资料'},{id:'check',assigneeId:'q',subject:'核对资料'}],orchestration:{pattern:'parallel',rationale:'资料可以分别整理后汇总'},deliveryCriteria:[{id:'r1',description:'三条结论都有来源',producerTaskIds:['write'],checkTaskId:'check',checkCriteriaIndexes:[0],independent:true}]};
test('template recommendations show localized name, version, selection reason and pending real acceptance',()=>{
 const draft=orchestrationFixture('map_reduce'),html=renderToStaticMarkup(createElement(OrganizationRecommendation,{plan:draft}));
 for(const text of ['分片汇总','v1','离线校验','待真实验收',draft.orchestration!.rationale])assert.ok(html.includes(text),text);
 assert.equal(html.includes('offline_verified'),false);
});
test('recommendation explains collaboration and who verifies each user requirement',()=>{
 const html=renderToStaticMarkup(createElement(OrganizationRecommendation,{plan,existing:true}));
 for(const label of ['已有部门','并行汇总','三条结论都有来源','作者','复核员','独立检查'])assert.ok(html.includes(label));
 assert.equal(html.includes('命中模板'),false);
});
test('department scope is explicit, and V2 confirmation cannot mutate the saved department',()=>{
 const html=renderToStaticMarkup(createElement(OrganizationDepartmentScope,{departments:[{id:'d',name:'研发部'}],allowed:[],onChange:()=>{}}));
 assert.match(html,/研发部/);assert.equal(html.includes('checked=""'),false);
 const preview={kind:'organization-v2',previewVersion:1,previewId:'p',plan} as Preview;
 assert.deepEqual(organizationConfirmationRequest(preview,{departmentId:'old',projectId:'old',departmentVersion:4,projectVersion:4}),{path:'/organizations/previews/p/confirm',body:{previewVersion:1}});
 const legacy={...preview,kind:undefined};assert.equal(organizationConfirmationRequest(legacy).path,'/organizations');
});
test('new chat requests opt in without mutating an old pending request body',()=>{
 const draft:any={messages:[],modelId:'m',policy:{maxBudget:1,maxAgents:3,maxConcurrentAgents:2,deadlineSeconds:300},input:''};
 assert.equal(createOrganizationChatRequest(draft,'整理一份业务说明','settings').body.organizationRouting,true);
});
