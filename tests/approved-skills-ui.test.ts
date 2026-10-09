import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunInputEditor, RunInputSummary } from '../apps/web/src/RunInputEditor.tsx';
import type { Plan } from '../packages/contracts/index.ts';

const plan:Plan={rationale:'验证工作方法',agents:[{id:'qa',name:'QA',role:'manager',title:'QA',instructions:'检查',modelId:'model',tools:['knowledge_search']}],
  tasks:[],runInputs:[{id:'method',title:'测试方法',skillName:'test-method',content:'<script>untrusted()</script>',agentIds:['qa']}]};

test('method editor explains required grant, method identity and instruction size',()=>{
  const html=renderToStaticMarkup(createElement(RunInputEditor,{projectId:'project',plan,onChange:()=>{}}));
  assert.ok(html.includes('test-method'));
  assert.ok(/maxlength="16000"/i.test(html));
  assert.ok(html.includes('否则无法批准执行'));
  assert.ok(!html.includes('<script>untrusted()'));
});

test('approval summary distinguishes a method and renders body as escaped text',()=>{
  const html=renderToStaticMarkup(createElement(RunInputSummary,{projectId:'project',plan}));
  assert.ok(html.includes('工作方法 test-method'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('QA'));
});
