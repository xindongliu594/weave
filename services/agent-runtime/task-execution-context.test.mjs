import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trustedTaskCandidate} from './host.mjs';
const f=()=>({runId:'run',agentId:'employee',sessionId:'session',taskId:'task',runtimeTaskId:'native',state:{members:[{id:'session',name:'employee'}],tasks:[{id:'native',assignee:'employee',attemptId:'attempt',status:'in_progress'}]},snapshot:{agents:[{id:'employee',tools:['filesystem']}],tasks:[]},contract:{id:'task',assignee:'employee',inputs:[],outputs:[]}});
test('host derives attempt and contract hash from active native state',()=>{
 const c=trustedTaskCandidate(f());assert.equal(c.attemptId,'attempt');assert.equal(c.runtimeTaskId,'native');assert.match(c.contractHash,/^[a-f0-9]{64}$/);assert.equal(c.generation,undefined);
});
for(const field of ['agentId','sessionId','taskId','runtimeTaskId'])test('host rejects forged '+field,()=>{const data=f();data[field]='forged';assert.throws(()=>trustedTaskCandidate(data));});
for(const status of ['completed','failed','pending'])test('host rejects '+status+' task',()=>{const data=f();data.state.tasks[0].status=status;assert.throws(()=>trustedTaskCandidate(data));});
