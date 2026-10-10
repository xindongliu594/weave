import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {attachTrace} from './trace.mjs';
import {createRunArchive,readRun} from './trace-store.mjs';

test('identical internal status polls reference their durable result, while changes and errors remain full',async()=>{
 const root=await mkdtemp(join(tmpdir(),'trace-poll-'));
 try {
  const archive=createRunArchive(root,{title:'poll storage fixture'}), handlers=new Map();
  const ctx={on(name,handler){handlers.set(name,handler);return()=>handlers.delete(name);}};
  const trace=attachTrace(ctx,archive,undefined,exec=>exec.callId.startsWith('poll-'));
  const large={isError:false,value:{phase:'running',tasks:[{id:'t1',status:'in_progress',objective:'x'.repeat(100000)}]}};
  for(let i=0;i<1000;i++){
   const exec={name:'agent_teams_status',arguments:{},agent:{id:'captain'},callId:'poll-'+i};
   await handlers.get('tools/pre-execute')(exec,()=>{});
   handlers.get('tools/result')(exec,large);
  }
  handlers.get('tools/result')({name:'agent_teams_status',agent:{id:'captain'},callId:'poll-changed'}, {isError:false,value:{...large.value,phase:'completed'}});
  handlers.get('tools/result')({name:'agent_teams_status',agent:{id:'captain'},callId:'poll-error'}, {isError:true,error:{message:'actual error'}});
  // A model-issued read is never suppressed, even with the identical payload.
  handlers.get('tools/result')({name:'agent_teams_status',agent:{id:'employee'},callId:'model-read'},large);
  const run=readRun(root,archive.id),results=run.events.filter(e=>e.type==='tool/result');
  assert.equal(results.length,4,'first state, changed state, actual error and model read all retained');
  const refs=run.events.filter(e=>e.type==='runtime/status-poll');
  assert.equal(refs.length,999);
  const first=results[0];
  assert.ok(refs.every(e=>e.data.resultSequence===first.seq));
  assert.ok(refs.every(e=>e.data.resultSha256===createHash('sha256').update(JSON.stringify(first.data.result)).digest('hex')));
  assert.deepEqual(run.events.filter(e=>e.type==='team/snapshot').map(e=>e.data.phase),['running','completed']);
  assert.equal(results.find(e=>e.callId==='poll-error').data.result.error.message,'actual error');
  assert.equal(run.integrity,'ok');
  assert.ok((await stat(join(archive.dir,'events.jsonl'))).size<1100000,'1000 polls stay below 1.1 MB rather than duplicating 100 MB');
  trace.dispose();
 } finally {await rm(root,{recursive:true,force:true});}
});
