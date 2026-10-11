import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as knowledge from '../apps/web/src/KnowledgeCenter.tsx';
test('knowledge library exposes distinct-work statistics and unverified efficiency honestly',()=>{
 const html=renderToStaticMarkup(createElement(knowledge.KnowledgeCenter,{departments:[]}));assert.ok(html.includes('复用统计'));
 const View=(knowledge as any).ReuseSourceCard;assert.equal(typeof View,'function');
 const view=renderToStaticMarkup(createElement(View,{group:{source:{title:'来源方法',version:2,sha256:'a'.repeat(64)},successWorkCount:3,works:[{runId:'run-1',planVersion:1,taskIds:['task'],notes:['采用边界检查'],efficiency:{current:{totalTokens:null,cost:null,activeMs:1200},baseline:null,comparison:null}}]}}));
 assert.ok(view.includes('3 个不同成功工作'));assert.ok(view.includes('v2'));assert.ok(view.includes('未验证'));assert.ok(view.includes('#run/run-1'));assert.ok(view.includes('采用边界检查'));assert.ok(view.includes('未知'));
});
test('learning threshold accepts bounded distinct-work counts and rejects one repeated work',async()=>{
 const {settingsSchema}=await import('../apps/api/src/product.ts');const base={autoBudgetLimit:1,dailyBudgetLimit:20,maxActiveRuns:1,retentionDays:0};
 assert.equal(settingsSchema.parse({...base,reuseMinSuccessfulWorks:4}).reuseMinSuccessfulWorks,4);
 assert.equal(settingsSchema.safeParse({...base,reuseMinSuccessfulWorks:1}).success,false);assert.equal(settingsSchema.safeParse({...base,reuseMinSuccessfulWorks:101}).success,false);
});
