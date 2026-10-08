import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffNotices } from '../apps/web/src/run-handoff.ts';
const blocked=(seq:number,taskId='developer')=>({type:'handoff/blocked',seq,at:'2026-10-04T12:00:00.000Z',data:{taskId,message:'ENOENT: original failure'}});
const accepted=(seq:number,taskId='developer')=>({type:'handoff/accepted',seq,data:{taskId}});

test('working tasks retain the earlier failure as history without a current blocker',()=>{
  const event=blocked(1),events=[event];
  const result=handoffNotices(events,[{id:'developer',status:'in_progress'}]);
  assert.equal(result.current.length,0);assert.equal(result.history.length,1);
  assert.equal(result.history[0].message,event.data.message);assert.equal(result.history[0].at,event.at);
  assert.deepEqual(events,[event]);
});
test('a currently blocked or failed task shows its latest unresolved handoff failure',()=>{
  for(const status of ['blocked','failed']){
    const result=handoffNotices([blocked(1),blocked(2)],[{id:'developer',status}]);
    assert.deepEqual(result.current.map(item=>item.seq),[2]);assert.equal(result.history.length,2);
  }
});
test('later acceptance and completion preserve the original failure without showing it as current',()=>{
  const afterAcceptance=handoffNotices([accepted(2),blocked(1)],[{id:'developer',status:'in_progress'}]);
  assert.equal(afterAcceptance.current.length,0);assert.equal(afterAcceptance.history[0].acceptedLater,true);
  const completed=handoffNotices([blocked(1)],[{id:'developer',status:'completed'}]);
  assert.equal(completed.current.length,0);assert.equal(completed.history.length,1);
});
test('a new failure after acceptance remains distinct and task statuses do not leak across tasks',()=>{
  const result=handoffNotices([blocked(1),accepted(2),blocked(3),blocked(4,'tester')],[{id:'developer',status:'blocked'},{id:'tester',status:'claimed'}]);
  assert.deepEqual(result.current.map(item=>item.seq),[3]);assert.equal(result.history[0].acceptedLater,true);
  assert.equal(result.history[1].acceptedLater,false);assert.equal(result.history.length,3);
});
test('older events without sequence IDs still show only the latest unresolved failure',()=>{
  const first={type:'handoff/blocked',data:{taskId:'developer',message:'first error'}},latest={type:'handoff/blocked',data:{taskId:'developer',message:'latest error'}};
  const result=handoffNotices([first,latest],[{id:'developer',status:'failed'}]);
  assert.equal(result.current.length,1);assert.equal(result.current[0].message,'latest error');assert.equal(result.history.length,2);
});
