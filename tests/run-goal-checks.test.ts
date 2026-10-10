import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunGoalChecks } from '../apps/web/src/RunGoalChecks.tsx';
const snapshot={requirement:'只添加帮助',planVersion:2,tasks:[{id:'dev',subject:'开发',acceptanceCriteria:['旧17项通过']}],goalContract:{format:'approved-goal-v1',sha256:'a'.repeat(64)}};
const html=(s:any=snapshot,events:any[]=[])=>renderToStaticMarkup(createElement(RunGoalChecks,{snapshot:s,events}));
test('goal view distinguishes legacy, pending integrity and observed node evidence',()=>{
 assert.match(html({...snapshot,goalContract:undefined}),/历史运行未启用/);
 assert.match(html(),/尚未记录目标检查/);assert.doesNotMatch(html(),/节点检查已通过/);
 const anchored={type:'goal/anchored',data:{sha256:snapshot.goalContract.sha256}};
 assert.match(html(snapshot,[anchored]),/目标合同已固定/);assert.match(html(snapshot,[anchored]),/尚未记录节点交接检查/);
 assert.match(html(snapshot,[anchored,{type:'goal/node-checked',data:{taskId:'dev',sha256:snapshot.goalContract.sha256,evidence:'handoff/accepted'}}]),/节点交接证据已核验/);
 assert.match(html(),/dev:1/);assert.match(html(),/旧17项通过/);
});
test('goal boundary pause is visible and cannot be presented as acceptance',()=>{
 const output=html(snapshot,[{type:'goal/blocked',data:{message:'GOAL_CONTRACT_CHANGED: 目标已变化',point:'request'}}]);
 assert.match(output,/目标检查已暂停执行/);assert.match(output,/重新制定并批准方案/);assert.match(output,/目标已变化/);
 assert.doesNotMatch(output,/节点交接证据已核验/);
});
