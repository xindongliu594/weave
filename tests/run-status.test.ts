import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunExtras } from '../apps/web/src/RunExtras.tsx';

const snapshot={policy:{maxBudget:1},executionBudget:1,agents:[{id:'qa',name:'独立测试员工'}],tasks:[]};
const events=[{type:'team/checkpoint',data:{tasks:[{id:'t2',subject:'独立验收',status:'in_progress',assignee:'qa',dependencies:[]}]}}];
const render=(status:string)=>renderToStaticMarkup(React.createElement(RunExtras,{id:'test-run',status,snapshot,events,onOpenProject:()=>{}}));
test('stopped execution labels refer to the interruption point rather than a live employee',()=>{
  const interrupted=render('interrupted');assert.match(interrupted,/停止时节点/);assert.match(interrupted,/停止时执行中/);assert.doesNotMatch(interrupted,/当前执行/);
  const running=render('running');assert.match(running,/当前执行/);assert.doesNotMatch(running,/停止时执行中/);
});

test('unresolved model charges disable both recovery actions and expose the reconciliation entry',()=>{
 const html=renderToStaticMarkup(React.createElement(RunExtras,{id:'test-run',status:'failed',snapshot,events,recovery:{unknownOperations:[],costBlocked:'请先核对供应方账单'},onOpenProject:()=>{}}));
 assert.match(html,/核对供应方账单/);assert.match(html,/href="#usage"/);
 assert.match(html,/<button disabled="">恢复未完成任务<\/button>/);
 assert.match(html,/<button disabled="">完整重试<\/button>/);
});
