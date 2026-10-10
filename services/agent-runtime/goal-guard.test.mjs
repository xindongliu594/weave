import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalContract } from '../../packages/contracts/goal-contract.mjs';
import { GoalGuard } from './goal-guard.mjs';

test('admission uses an independent seal and retains first pause reason without log flooding',()=>{
 const snapshot={requirement:'原目标',tasks:[{id:'dev',acceptanceCriteria:['真实测试通过']}],agents:[],policy:{}};
 snapshot.goalContract=createGoalContract(snapshot);const events=[],failures=[];
 const guard=new GoalGuard({snapshot,archive:{append:(type,data)=>events.push({type,data})},onFailure:error=>failures.push(error)});
 guard.check('request');snapshot.tasks[0].acceptanceCriteria=[];snapshot.goalContract=createGoalContract(snapshot);
 assert.throws(()=>guard.check('tool','dev'),/GOAL_CONTRACT_CHANGED/);
 assert.throws(()=>guard.check('request'),/GOAL_CONTRACT_CHANGED/);
 assert.equal(events.filter(e=>e.type==='goal/blocked').length,1);assert.equal(failures.length,1);
 assert.equal(events.at(-1).data.point,'tool');assert.equal(events.at(-1).data.taskId,'dev');
});
test('node evidence and restored context always retain original acceptance during authorized rework',()=>{
 const snapshot={planVersion:2,requirement:'原目标',tasks:[{id:'dev',acceptanceCriteria:['原验收1','原验收2']}],agents:[],policy:{},recovery:{nodes:[{summary:'只需修复问题1'}]}};
 snapshot.goalContract=createGoalContract(snapshot);const events=[];
 const guard=new GoalGuard({snapshot,archive:{append:(type,data)=>events.push({type,data})}});
 assert.deepEqual(guard.context('dev').criteria.map(c=>c.text),['原验收1','原验收2']);
 guard.nodeStarted('dev','a1');guard.nodeStarted('dev','a1');guard.nodeAccepted({taskId:'dev',attemptId:'a1'});
 assert.equal(events.filter(e=>e.type==='goal/node-started').length,1);
 assert.deepEqual(events.at(-1).data.criteriaIds,['dev:1','dev:2']);assert.equal(events.at(-1).type,'goal/node-checked');
});
