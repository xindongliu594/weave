import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import * as trace from './trace-store.mjs';
const correlationId='22222222-2222-4222-8222-222222222222';
async function fixture(work){const root=fs.mkdtempSync(join(tmpdir(),'observation-trace-'));try{await work(root);}finally{const within=relative(resolve(tmpdir()),resolve(root));assert.ok(within.startsWith('observation-trace-')&&!within.startsWith('..')&&!isAbsolute(within));fs.rmSync(root,{recursive:true,force:true});}}
function observe(root,sink){assert.equal(typeof trace.observeRunArchive,'function');return trace.observeRunArchive(root,sink);}
test('successful fsync and sourceKey dedupe produce exactly one safe observation',()=>fixture(root=>{
 const received=[],stop=observe(root,value=>received.push(value));const archive=trace.createRunArchive(root,{auditContext:{correlationId},messages:['private']});
 archive.append('tool/start',{name:'private',arguments:{secret:'private'}},{sourceKey:'once'});archive.append('tool/start',{},{sourceKey:'once'});
 assert.equal(received.length,2);assert.equal(received[0].correlation.correlationId,correlationId);assert.equal(JSON.stringify(received).includes('private'),false);assert.equal(trace.readRun(root,archive.id).events.length,2);stop();
}));
test('failed fsync emits nothing and does not turn an exception into a successful append',()=>fixture(root=>{
 const archive=trace.createRunArchive(root,{}),received=[],stop=observe(root,v=>received.push(v)),original=fs.fsyncSync;
 try{fs.fsyncSync=()=>{throw Error('synthetic fsync failure');};syncBuiltinESMExports();assert.throws(()=>archive.append('run/finished',{status:'completed'}),/synthetic fsync/);assert.equal(received.length,0);}
 finally{fs.fsyncSync=original;syncBuiltinESMExports();stop();}
}));
test('observer throw or rejected promise never changes the durable append or leaks raw error',()=>fixture(async root=>{
 const a=observe(root,()=>{throw Error('private-secret');}),b=observe(root,()=>Promise.reject(Error('private-url'))),archive=trace.createRunArchive(root,{});
 assert.doesNotThrow(()=>archive.append('run/finished',{status:'completed'}));await new Promise(resolve=>setImmediate(resolve));assert.equal(trace.readRun(root,archive.id).status,'completed');
 const health=trace.runArchiveObservationHealth(root);assert.ok(health.failures>=2);assert.equal(JSON.stringify(health).includes('private'),false);a();b();
}));
test('observers receive isolated frozen values and disposal removes root state',()=>fixture(root=>{
 const archive=trace.createRunArchive(root,{}),values=[];const stop=observe(root,v=>values.push(v));const event=archive.append('tool/start',{name:'private'});event.type='private';assert.equal(values[0].name,'tool.started');
 stop();stop();archive.append('run/finished',{status:'completed'});assert.equal(values.length,1);assert.equal(trace.runArchiveObservationHealth(root).subscribers,0);
 for(let i=0;i<1000;i++){const dispose=observe(root,()=>{});dispose();}assert.equal(trace.runArchiveObservationHealth(root).subscribers,0);
}));
test('legacy snapshot without a verified created hash cannot invent correlation',()=>fixture(root=>{
 const archive=trace.createRunArchive(root,{auditContext:{correlationId}}),file=join(archive.dir,'events.jsonl');fs.writeFileSync(file,'');
 const seen=[],stop=observe(root,v=>seen.push(v));trace.openRunArchive(root,archive.id).append('run/finished',{status:'completed'},{requestId:correlationId});
 assert.deepEqual(seen[0].correlation,{runId:archive.id});stop();
}));
test('a snapshot changed during fsync cannot supply previously verified correlation',()=>fixture(root=>{
 const archive=trace.createRunArchive(root,{auditContext:{correlationId}}),file=join(archive.dir,'snapshot.json'),original=fs.fsyncSync,seen=[],stop=observe(root,v=>seen.push(v));
 try{
  fs.fsyncSync=(fd)=>{original(fd);const snapshot=JSON.parse(fs.readFileSync(file,'utf8'));snapshot.auditContext.correlationId='33333333-3333-4333-8333-333333333333';fs.writeFileSync(file,JSON.stringify(snapshot));};syncBuiltinESMExports();
  archive.append('tool/start',{});assert.deepEqual(seen[0].correlation,{runId:archive.id});assert.equal(trace.readRun(root,archive.id).integrity,'incomplete');
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();stop();}
}));
test('observer uses the exact serialized committed event rather than the caller object',()=>fixture(root=>{
 const archive=trace.createRunArchive(root,{}),seen=[],stop=observe(root,v=>seen.push(v));
 archive.append('billing/usage',{inputTokens:999,toJSON(){return {inputTokens:7};}});
 assert.equal(trace.readRun(root,archive.id).events.at(-1).data.inputTokens,7);assert.equal(seen[0].inputTokens,7);stop();
}));
test('subscription changes during dispatch cannot extend the current notification traversal',()=>fixture(root=>{
 const archive=trace.createRunArchive(root,{}),anchor=observe(root,()=>{});let calls=0,dispose=()=>{};
 const sink=()=>{calls++;dispose();if(calls<3)dispose=observe(root,sink);};dispose=observe(root,sink);
 try{archive.append('tool/start',{});assert.equal(calls,1);archive.append('tool/result',{});assert.equal(calls,2);}
 finally{dispose();anchor();}
}));
test('a synchronous observer cannot reenter itself through another durable append',()=>fixture(root=>{
 const archive=trace.createRunArchive(root,{});let calls=0;const stop=observe(root,()=>{calls++;if(calls<3)archive.append('tool/result',{});});
 try{archive.append('tool/start',{});assert.equal(calls,1);assert.equal(trace.runArchiveObservationHealth(root).dropped,1);assert.equal(trace.readRun(root,archive.id).events.length,3);}
 finally{stop();}
}));
test('root and subscriber limits are reusable after disposal and pending callbacks are bounded',()=>fixture(async root=>{
 const releases=[];try{
  for(let i=0;i<16;i++)releases.push(observe(join(root,String(i)),()=>{}));
  assert.throws(()=>observe(join(root,'overflow'),()=>{}),/OBSERVATION_ROOT_LIMIT/);
 }finally{for(const stop of releases)stop();}
 const listeners=[];try{for(let i=0;i<8;i++)listeners.push(observe(root,()=>{}));assert.throws(()=>observe(root,()=>{}),/OBSERVATION_SUBSCRIBER_LIMIT/);}
 finally{for(const stop of listeners)stop();}
 const archive=trace.createRunArchive(root,{});let done,calls=0;const stop=observe(root,()=>{calls++;return new Promise(resolve=>done=resolve);});
 try{for(let i=0;i<10;i++)archive.append('tool/start',{});assert.equal(calls,1);assert.equal(trace.runArchiveObservationHealth(root).dropped,9);done();await new Promise(resolve=>setImmediate(resolve));archive.append('tool/start',{});assert.equal(calls,2);done();}
 finally{stop();}
}));
