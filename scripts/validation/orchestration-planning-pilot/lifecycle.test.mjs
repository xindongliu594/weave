// No production, network, credentials, subprocesses or file writes.
// Evaluates the actual broker source with in-memory boundary substitutes.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {cases,checkQuote,trialLimits} from '../../../scripts/validation/orchestration-planning-pilot/cases.mjs';

const source=readFileSync(new URL('../../../scripts/validation/orchestration-planning-pilot/broker.mjs',import.meta.url),'utf8')
 .replace(/^import .*;\r?\n/gm,'').replaceAll('await import(','await fakeImport(');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function launchFake({mode='approved-real',failSettled=false,finalUnknown=false}={}){
 const worker=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough()});
 const state={events:[],saved:[],printed:[],replies:[],ledger:[],timer:undefined,finishCall:undefined,exited:false};
 const exit=(code=0,signal=null)=>{state.exited=true;worker.emit('exit',code,signal);worker.emit('close',code,signal);};
 worker.kill=signal=>{state.events.push('kill:'+signal);exit(null,signal);};
 worker.stdin.on('data',buffer=>{for(const line of String(buffer).trim().split('\n'))state.replies.push(JSON.parse(line));});
 const fakeProcess={argv:['node','broker',mode,'C:/fake-repo','C:/fake-out'],env:{DATABASE_URL:'fake',DATA_DIR:'fake',PATH:''},platform:'linux',execPath:'node',umask(){},stderr:{write(){}},exitCode:undefined};
 const model={id:'c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051',model:'test-model',status:'available',inputRate:.3,outputRate:1.2};
 const context={assert,join,resolve,pathToFileURL,cases,checkQuote,trialLimits,Buffer,JSON,randomUUID:()=> 'request-'+(state.ledger.length+1),process:fakeProcess,
  console:{log(value){state.printed.push(value);}},readFileSync(){return JSON.stringify({holds:[]});},mkdirSync(){},writeFileSync(_file,data){state.saved.push(JSON.parse(data));},
  spawn(){return worker;},createInterface,setTimeout(fn){state.timer=fn;return 1;},clearTimeout(){},
  async fetch(url){const route=url.split('/').at(-1);return {ok:true,json:async()=>route==='models'?[model]:route==='costs'?{calls:finalUnknown&&state.exited?[{id:'new-unknown',status:'uncertain',amount:.01}]:[]}:route==='usage'?state.ledger:[]};},
  async fakeImport(url){return url.includes('db.ts')?{pool:{async query(_sql,params){return {rows:state.ledger.filter(r=>r.requestId===params[0]).map(r=>({...r,status:'settled',amount:.01}))};},async end(){state.events.push('pool.end');}}}:{
   budgetedRequestEstimate:()=>({reservation:.01}),
   completeBudgeted(_model,_messages,_maxTokens,options){
    state.events.push('dispatch');
    return new Promise((resolve,reject)=>{state.finishCall=()=>{
     const usageId='receipt-'+(state.ledger.length+1);
     state.ledger.push({id:usageId,sessionId:options.context.sessionId,requestId:options.context.requestId,cost:.005,inputTokens:1,outputTokens:1});
     state.events.push('provider.return');
     if(failSettled)reject(Object.assign(Error('output truncated after usage settlement'),{code:'MODEL_OUTPUT_TRUNCATED'}));
     else resolve({usageId,usage:{prompt_tokens:1,completion_tokens:1},choices:[{message:{content:'{}'}}]});
    };});
   }
  };}
 };
 const work=vm.runInNewContext('(async()=>{'+source+'})()',context);
 while(!state.timer)await tick();
 return {state,worker,process:fakeProcess,work,exit,
  request(index){worker.stdout.write('ORCHESTRATION_REQUEST '+JSON.stringify({id:cases[index].id,body:{model:'test-model',messages:[{role:'user',content:'synthetic'}],max_tokens:4000}})+'\n');},
  done(count){worker.stdout.write('ORCHESTRATION_DONE '+JSON.stringify({cases:count,valid:0,projectWrites:0,departmentWrites:0})+'\n');},
  async waitDispatch(count){while(state.events.filter(e=>e==='dispatch').length<count)await tick();},
  async waitReply(count){while(state.replies.length<count)await tick();},
 };
}

test('timeout or signal exit must not be reported as success',async()=>{
 const run=await launchFake({mode:'dry-run'});run.state.timer();await run.work;
 assert.notEqual(run.process.exitCode,0,'timeout=true, exit.code=null currently becomes exitCode=0');
});

test('worker exit must await outstanding provider and receipt work before pool.end',async()=>{
 const run=await launchFake();run.request(0);await run.waitDispatch(1);
 run.exit();await tick();const prematurelyClosed=run.state.events.includes('pool.end');
 run.state.finishCall();await run.work;await tick();
 assert.equal(prematurelyClosed,false,JSON.stringify(run.state.events));
 assert.ok(run.state.events.indexOf('provider.return')<run.state.events.indexOf('pool.end'));
});

test('a new unknown receipt in the final snapshot must fail the trial',async()=>{
 const run=await launchFake({finalUnknown:true});
 for(let i=0;i<cases.length;i++){run.request(i);await run.waitDispatch(i+1);run.state.finishCall();await run.waitReply(i+1);}
 run.done(cases.length);run.exit();await run.work;
 assert.notEqual(run.process.exitCode,0,'final after.holds is recorded but never checked');
});

test('a paid failure retains the settled usage id and actual fee for its case',async()=>{
 const run=await launchFake({failSettled:true});run.request(0);await run.waitDispatch(1);run.state.finishCall();await run.waitReply(1);
 run.done(1);run.exit();await run.work;
 const entry=run.state.saved.at(-1).requests[0];
 assert.equal(entry.usageId,'receipt-1');assert.equal(entry.cost,.005);
});
