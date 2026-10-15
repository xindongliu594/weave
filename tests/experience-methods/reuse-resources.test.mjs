import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allocateResources} from '../../scripts/validation/experience-methods/reuse-resources.mjs';
const base={tasks:['develop','qa-check','accept'].map(id=>({id,objective:'unchanged',maxBudget:.01})),agents:[{id:'dev',tools:['filesystem']}],knowledgeDocumentIds:['original']};
const allocation=()=>({tasks:base.tasks.map(t=>({id:t.id,maxBudget:.04,maxModelCalls:10,maxOutputTokens:8192,estimatedInputTokens:20000,estimatedOutputTokens:4000}))});
test('resource-only allocation preserves business tasks and permissions',()=>{
 const result=allocateResources(base,allocation(),.125);
 assert.deepEqual(result.agents,base.agents);assert.equal(result.tasks[0].objective,'unchanged');assert.equal(result.tasks[0].maxOutputTokens,8192);assert.equal(base.tasks[0].maxBudget,.01);
});
test('reject budgets beyond net balance, excess calls, changed task IDs or extra permissions',()=>{
 assert.throws(()=>allocateResources(base,allocation(),.11));
 for(const edit of [a=>a.tasks[0].maxModelCalls=17,a=>a.tasks[0].id='other',a=>a.tasks[0].tools=['terminal'],a=>a.tasks[0].maxOutputTokens=99999,a=>a.tasks[0].maxBudget=-1]){const a=allocation();edit(a);assert.throws(()=>allocateResources(base,a,.15));}
});
