import test from 'node:test';
import assert from 'node:assert/strict';
import {atAcceptedBoundary} from './controlled-boundary.mjs';
test('control passes ordinary requests through and holds only the selected accepted project before dispatch',async()=>{
 let dispatched=0,mark;const controller=new AbortController();
 let run={snapshot:{projectId:'other'},integrity:'ok',events:[{type:'handoff/accepted',data:{taskId:'writer'}}]};
 const invoke=atAcceptedBoundary(async()=>{dispatched++;return 'actual';},{projectId:'selected',taskId:'writer',read:()=>run,onBoundary:v=>{mark=v;}});
 assert.equal(await invoke('r',{id:'one'},controller.signal),'actual');
 run={snapshot:{projectId:'selected'},integrity:'ok',events:[]};
 assert.equal(await invoke('r',{id:'two'},controller.signal),'actual');
 run.events.push({type:'handoff/accepted',data:{taskId:'writer',outputs:[{path:'report.docx',sha256:'original'}]}});
 const waiting=invoke('r',{id:'three',taskId:'qa'},controller.signal);
 assert.equal(dispatched,2);assert.equal(mark.heldRequestId,'three');
 controller.abort(Error('service shutdown'));await assert.rejects(waiting,/service shutdown/);assert.equal(dispatched,2);
});
