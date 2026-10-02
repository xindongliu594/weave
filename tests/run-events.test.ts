import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunEvents } from '../apps/web/src/run-events.ts';
import type { TraceEvent } from '../services/agent-runtime/trace-store.mjs';
const event=(seq:number)=>({seq,type:'tool/result',data:{},at:'2026-10-02T00:00:00Z'} as TraceEvent);
test('overlapping polling and manual pagination never duplicate or discard trace events',()=>{
  const first=[event(1),event(2)],page=[event(2),event(3),event(4)];
  const overlapping=mergeRunEvents(mergeRunEvents(first,page),page);
  assert.deepEqual(overlapping.map(e=>e.seq),[1,2,3,4]);
  assert.deepEqual(mergeRunEvents(overlapping,[event(6),event(5),event(3)]).map(e=>e.seq),[1,2,3,4,5,6]);
  assert.deepEqual(first.map(e=>e.seq),[1,2],'existing state is immutable');
});
