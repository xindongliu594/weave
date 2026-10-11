import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as knowledge from '../apps/web/src/KnowledgeCenter.tsx';

test('knowledge library exposes explicit method publication without promoting ordinary documents',()=>{
 const html=renderToStaticMarkup(createElement(knowledge.KnowledgeCenter,{departments:[]}));
 assert.ok(html.includes('发布为批准工作方法'));
 assert.ok(html.includes('普通资料'));
 const field=renderToStaticMarkup(createElement((knowledge as any).CompanyMethodField,{enabled:true,name:'delivery-check',onEnabledChange:()=>{},onNameChange:()=>{}}));
 assert.ok(field.includes('delivery-check'));assert.ok(field.includes('16,000'));assert.ok(field.includes('固定版本'));
});

test('editing a method preserves work provenance while explicit demotion removes its instruction flag',()=>{
 const source={runId:'source-run',note:'核验依据',skillName:'old-method'};
 const build=(knowledge as any).knowledgeDocumentSource;
 assert.deepEqual(build(source,'new-method'),{runId:'source-run',note:'核验依据',skillName:'new-method'});
 assert.deepEqual(build(source),{runId:'source-run',note:'核验依据'});
 assert.equal(source.skillName,'old-method');
});
