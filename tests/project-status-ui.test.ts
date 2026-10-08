import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectStatusTag, projectStatusLabel } from '../apps/web/src/ProjectStatusTag.tsx';

test('completed project keeps its actual lifecycle label when remaining budget cannot fund a second full run',()=>{
  const project={status:'COMPLETED',validation:{valid:false}};
  const before=structuredClone(project),html=renderToStaticMarkup(createElement(ProjectStatusTag,{project}));
  assert.match(html,/<span class="tag green">已完成<\/span>/);assert.doesNotMatch(html,/待完善方案/);
  assert.deepEqual(project,before);assert.equal(project.validation.valid,false);
});

test('running, queued, failed, cancelled and interrupted states take precedence over either validation result',()=>{
  for(const [status,label] of Object.entries({RUNNING:'执行中',QUEUED:'等待执行',FAILED:'执行失败',CANCELLED:'已取消',INTERRUPTED:'执行中断'}))
    for(const valid of [true,false])assert.deepEqual(projectStatusLabel({status,validation:{valid}}),{label,tone:'amber'});
});

test('only a draft uses validation readiness; unknown lifecycle states are not relabeled as success or a draft',()=>{
  assert.equal(projectStatusLabel({status:'DRAFT',validation:{valid:false}}).label,'待完善方案');
  assert.equal(projectStatusLabel({status:'DRAFT',validation:{valid:true}}).label,'基础校验通过');
  assert.equal(projectStatusLabel({status:'DRAFT'}).label,'待完善方案');
  assert.equal(projectStatusLabel({status:'UNRECOGNIZED',validation:{valid:true}}).label,'UNRECOGNIZED');
});

test('both real project cards use lifecycle tags while the original validation and cost approval guards remain in place',()=>{
  const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
  assert.equal(source.match(/<ProjectStatusTag project=\{p\}\/>/g)?.length,2);
  assert.match(source,/disabled=\{!current\.validation\.valid \|\| !!busy \|\| costs\.blocked \|\| current\.status === 'RUNNING' \|\| current\.status === 'QUEUED'\}/);
  assert.match(source,/version: current\.version, retainUncertainCosts:costs\.retainUncertainCosts/);
});
