import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ResourceResumeConfirmation,resourceResumeBody} from '../apps/web/src/RunResourceResume.tsx';
const candidate:any={previewId:'preview',sourceRunId:'source',projectVersion:2,sourceGoalContract:{format:'approved-goal-v1',sha256:'fixed'},
  ceiling:.18,proposal:{maxBudget:.18,taskCallLimits:{accept:10},rationale:'Only finish the remaining manager review'},completedTaskIds:['develop','qa']};
const snapshot:any={planVersion:2,goalContract:candidate.sourceGoalContract,policy:{maxBudget:.13},tasks:[{id:'accept',subject:'经理验收',maxModelCalls:6}]};
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
