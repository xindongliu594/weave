import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalWaitMs,compareEfficiency,runEfficiency} from '../apps/api/src/work-efficiency.ts';

test('overlapping approvals are counted once and clipped to the measured run',()=>{
 const e=(type:string,id:string,at:number)=>({type,at:new Date(at).toISOString(),data:{id}});
 const events=[e('approval/requested','a',0),e('approval/requested','b',500),e('approval/decided','a',1000),e('approval/decided','b',1500)];
 assert.equal(approvalWaitMs(events,0,2000),1500);
 assert.equal(approvalWaitMs(events,750,2000),750);
});

test('receipts supply real tokens; missing duration, unknown costs and a different device stay explicit',async()=>{
 const event=(type:string,at:number,data:unknown={})=>({seq:0,type,at:new Date(at).toISOString(),data});
 const run:any={id:'fixture',status:'completed',integrity:'ok',snapshot:{requirement:'same',tasks:[],agents:[],executionTarget:{deviceId:'one'},knowledge:{documents:[{documentId:'doc',version:2,sha256:'fixed'}]}},events:[event('run/started',0),event('model/wire-request',1,{usageId:'call'}),event('approval/requested',100,{id:'approval'}),event('approval/decided',500,{id:'approval'}),event('knowledge/citation',600,{agentId:'qa',sources:[{documentId:'doc',version:2,chunkId:'chunk',sha256:'fixed'}]}),event('run/finished',1000)]};
 let unknown=0;const db:any={query:async(sql:string)=>({rows:sql.includes('FROM usage')?[{id:'call',input_tokens:100,output_tokens:20,cost:'.1',duration_ms:null}]:[{id:'call',status:unknown?'uncertain':'settled'}]})};
 const first=await runEfficiency(db,run);assert.equal(first.totalTokens,120);assert.equal(first.activeMs,600);assert.equal(first.modelMs,null);assert.equal(first.citations[0].version,2);
 const other=await runEfficiency(db,{...run,snapshot:{...run.snapshot,executionTarget:{deviceId:'two'}}});assert.equal(compareEfficiency(first,other).comparable,false);
 unknown=1;const pending=await runEfficiency(db,run);assert.equal(pending.usageComplete,false);assert.equal(pending.cost,null);assert.equal(pending.totalTokens,null);
});

test('matching successful goals compare raw values with signed savings and never divide by zero',()=>{
 const first={runId:'first',goalHash:'goal',acceptanceHash:'checks',modelHash:'model',deviceHash:'device',usageComplete:true,wallMs:2000,activeMs:1000,modelMs:800,inputTokens:200,outputTokens:100,totalTokens:300,modelCalls:10,cost:1};
 const reused={...first,runId:'reused',wallMs:1000,activeMs:500,modelMs:400,inputTokens:150,outputTokens:120,totalTokens:270,modelCalls:8,cost:.8};
 const c=compareEfficiency(first,reused);
 assert.equal(c.comparable,true);
 assert.deepEqual(c.changes.totalTokens,{baseline:300,current:270,saved:30,savedPercent:10});
 assert.deepEqual(c.changes.outputTokens,{baseline:100,current:120,saved:-20,savedPercent:-20});
 assert.equal(c.changes.activeMs.savedPercent,50);
 assert.equal(compareEfficiency({...first,cost:0},reused).changes.cost.savedPercent,null);
 assert.equal(compareEfficiency({...first,goalHash:'other'},reused).comparable,false);
 assert.equal(compareEfficiency({...first,usageComplete:false},reused).comparable,false);
 assert.equal(compareEfficiency({...first,resumed:true} as any,reused).comparable,false,'a resumed segment cannot claim skipping earlier work saved tokens');
});

test('fallback sends are counted separately and matched to their own receipts',async()=>{
 const run:any={id:'fallback',status:'completed',integrity:'ok',snapshot:{requirement:'same',tasks:[],agents:[]},events:[{type:'model/request',data:{}},{type:'model/wire-request',data:{usageId:'primary'}},{type:'model/wire-request',data:{usageId:'fallback'}}]};
 const db:any={query:async(sql:string)=>({rows:sql.includes('FROM usage')?[{id:'fallback',input_tokens:100,output_tokens:20,cost:.1,duration_ms:10}]:[{id:'primary',status:'released'},{id:'fallback',status:'settled'}]})};
 const metrics=await runEfficiency(db,run);assert.equal(metrics.modelCalls,2);assert.equal(metrics.usageComplete,true);assert.equal(metrics.totalTokens,120);
});
