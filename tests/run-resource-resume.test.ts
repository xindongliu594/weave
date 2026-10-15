import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ResourceResumeConfirmation,resourceResumeBody,RunResourceResume,resourceContinuationLimits} from '../apps/web/src/RunResourceResume.tsx';
import * as resourceUi from '../apps/web/src/RunResourceResume.tsx';
const candidate:any={previewId:'preview',sourceRunId:'source',projectVersion:2,sourceGoalContract:{format:'approved-goal-v1',sha256:'fixed'},
  ceiling:.18,proposal:{maxBudget:.18,taskCallLimits:{accept:10},rationale:'Only finish the remaining manager review'},completedTaskIds:['develop','qa']};
const snapshot:any={planVersion:2,goalContract:candidate.sourceGoalContract,policy:{maxBudget:.13},tasks:[{id:'accept',subject:'经理验收',maxModelCalls:6}]};

test('confirmation displays explicit continuation calls separately from the cumulative task cap',()=>{
  const value={...candidate,taskContinuationLimits:{accept:3}};
  const html=renderToStaticMarkup(createElement(ResourceResumeConfirmation,{candidate:value,snapshot,retained:0,disabled:false,onConfirm:()=>{},onCancel:()=>{}}));
  assert.ok(html.includes('经理验收 · 本段最多新增 3 次调用'));
});

test('optional continuation input requires all inspected unfinished tasks and preserves omission',()=>{
  const tasks=[{id:'qa',subject:'QA'},{id:'accept',subject:'经理验收'}];
  assert.equal(resourceContinuationLimits({},tasks),undefined);
  assert.deepEqual(resourceContinuationLimits({qa:'4',accept:'7'},tasks),{qa:4,accept:7});
  const invalid:Record<string,string>[]=[{qa:'4'},{qa:'1',accept:'7'},{qa:'4',accept:'NaN'},{qa:'4',accept:'2.5'},{qa:'4',accept:'7',completed:'1'}];
  for(const values of invalid)
    assert.throws(()=>resourceContinuationLimits(values,tasks));
  assert.throws(()=>resourceContinuationLimits({qa:'4'},undefined));
  const form=renderToStaticMarkup(createElement(RunResourceResume,{id:'source',snapshot,retained:0,retainUncertainCosts:true,disabled:false,continuationTasks:tasks}));
  assert.ok(form.includes('QA · 本段最多新增调用次数'));assert.ok(form.includes('经理验收 · 本段最多新增调用次数'));
});

test('output allowance is visible before planning and confirmation shows per-task change',()=>{
  const original={...snapshot,tasks:[{...snapshot.tasks[0],maxOutputTokens:2048}]};
  const form=renderToStaticMarkup(createElement(RunResourceResume,{id:'source',snapshot:original,retained:0,retainUncertainCosts:true,disabled:false}));
  assert.ok(form.includes('允许的单次输出上限（Token）'));assert.ok(form.includes('16384'));
  const value={...candidate,proposal:{...candidate.proposal,taskOutputLimits:{accept:8192}}};
  const html=renderToStaticMarkup(createElement(ResourceResumeConfirmation,{candidate:value,snapshot:original,retained:0,disabled:false,onConfirm:()=>{},onCancel:()=>{}}));
  assert.ok(html.includes('单次输出上限 2048 → 8192 Token'));assert.ok(html.includes('按实际用量'));
});
test('resource confirmation names the unchanged task version, new ceiling and retained checkpoints without claiming acceptance',()=>{
  const html=renderToStaticMarkup(createElement(ResourceResumeConfirmation,{candidate,snapshot,retained:.0352938,disabled:false,onConfirm:()=>{},onCancel:()=>{}}));
  for(const text of ['原方案 v2','0.180000','develop','qa','经理验收','6 → 10','保留未知费用','确认额度并恢复未完成节点'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/已通过经理验收|完整重试/);
});
test('stale source/version/seal prevents constructing the approval request; unknown operations never get acknowledged',()=>{
  const body=resourceResumeBody(candidate,'source',snapshot,true);
  assert.equal(body.resume,true);assert.equal(body.retainUncertainCosts,true);assert.equal(body.acknowledgeUnknownOperations,false);
  assert.equal(body.confirmation,'APPROVE_RESOURCES_AND_RESUME');
  for(const value of [{...candidate,sourceRunId:'other'},{...candidate,projectVersion:3},
    {...candidate,sourceGoalContract:{...candidate.sourceGoalContract,sha256:'changed'}}])assert.throws(()=>resourceResumeBody(value,'source',snapshot,true));
});

test('node money confirmation shows cumulative caps under the shared project ceiling',()=>{
  const value={...candidate,proposal:{...candidate.proposal,taskBudgetLimits:{accept:.045}}};
  const original={...snapshot,tasks:[{...snapshot.tasks[0],maxBudget:.025}]};
  const html=renderToStaticMarkup(createElement(ResourceResumeConfirmation,{candidate:value,snapshot:original,retained:0,disabled:false,onConfirm:()=>{},onCancel:()=>{}}));
  for(const text of ['经理验收','节点累计费用上限','$0.025000','$0.045000','仍共享项目总上限'])assert.ok(html.includes(text),text);
});

test('confirmation names a larger total call ceiling while preserving shared dollars',()=>{
  const value={...candidate,proposal:{...candidate.proposal,maxModelCalls:48}};
  const html=renderToStaticMarkup(createElement(ResourceResumeConfirmation,{candidate:value,snapshot:{...snapshot,policy:{...snapshot.policy,maxModelCalls:32}},retained:0,disabled:false,onConfirm:()=>{},onCancel:()=>{}}));
  assert.ok(html.includes('项目累计调用上限 32 → 48'));assert.ok(html.includes('旧调用次数继续计入'));
});

test('context resource input is optional, bounded and cannot reduce the original request limit',()=>{
  const parse=(resourceUi as any).resourceContextBytes;assert.equal(typeof parse,'function');
  assert.equal(parse('',48000),undefined);assert.equal(parse('   ',48000),undefined);
  assert.equal(parse('64000',48000),64000);
  for(const value of ['47999','64000.5','NaN','Infinity','1000001','-1'])assert.throws(()=>parse(value,48000));
  assert.throws(()=>parse('48000',64000));
});

test('context changes are visible before confirmation while approval still uses the sealed candidate',()=>{
  const original={...snapshot,policy:{...snapshot.policy,contextBytes:48000}};
  const form=renderToStaticMarkup(createElement(RunResourceResume,{id:'source',snapshot:original,retained:0,retainUncertainCosts:true,disabled:false}));
  assert.ok(form.includes('本次上下文上限（字节，可选）'));assert.ok(form.includes('费用预留'));
  const value={...candidate,proposal:{...candidate.proposal,contextBytes:64000}};
  const html=renderToStaticMarkup(createElement(ResourceResumeConfirmation,{candidate:value,snapshot:original,retained:0,disabled:false,onConfirm:()=>{},onCancel:()=>{}}));
  assert.ok(html.includes('单次上下文上限 48000 → 64000 字节'));
  assert.equal(Object.hasOwn(resourceResumeBody(value,'source',original,true),'contextBytes'),false,'confirmation sends the sealed candidate id, not an editable context override');
});
