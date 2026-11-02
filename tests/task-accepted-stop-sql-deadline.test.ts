import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../apps/api/src/db.ts';
import {isolated,queryText,queryValues,terminalReady,finalize,lastMarker} from './helpers/task-accepted-stop-delivery-support.ts';

for(const mode of ['abort','deadline'])for(const stage of ['begin','set','query','commit','rollback'])test('terminal review SQL '+stage+' reply hold obeys shared '+mode+' and discards client',{skip:!isolated},async t=>{
 const f=await terminalReady();const cancellation=new AbortController();let pending:Promise<any>|undefined,stream:any,onReadable:(()=>void)|undefined;let armed=false,held=false,settled=false,db:any;const releases:any[]=[];
 const released=(error:any,client:any)=>{if(client===db)releases.push(error);};
 try{
  db=await pool.connect();stream=db.connection.stream;const original=db.query.bind(db);let written:string|undefined,nativeCalls=0;
  let arrived!:()=>void;const responseHeld=new Promise<void>(done=>{arrived=done;});
  t.mock.method(db,'query',(...args:any[])=>{
   nativeCalls++;const text=queryText(args);
   if(stage==='rollback'&&!armed&&text==='SELECT project_id FROM project_runs WHERE id=$1'){armed=true;return (original as any)({text:'SELECT 1/0',query_timeout:args[0]?.query_timeout});}
   const target=stage==='begin'?text==='BEGIN':stage==='set'?text?.includes("set_config('statement_timeout'"):stage==='query'?text==='SELECT project_id FROM project_runs WHERE id=$1':stage==='commit'?text==='COMMIT'&&written==='dispatching':text==='ROLLBACK';
   if(target&&!held){held=true;stream.pause();onReadable=()=>arrived();stream.once('readable',onReadable);}
   if(text?.startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))written=JSON.parse(queryValues(args)[0]).state;
   return (original as any)(...args);
  });db.release();pool.on('release',released);
  if(mode==='deadline')t.mock.timers.enable({apis:['setTimeout']});
  const effects=f.control.effects;pending=Promise.resolve(finalize(f.executor,cancellation.signal));pending.then(()=>{settled=true;});await responseHeld;
  if(mode==='deadline')t.mock.timers.tick(120000);else cancellation.abort();
  await new Promise(done=>setImmediate(done));await new Promise(done=>setImmediate(done));
  assert.equal(settled,true,'SQL reply wait must settle on the shared signal before the reply is released');assert.equal((await pending).state,'pending');assert.equal(releases.filter(Boolean).length,1);assert.ok(releases.at(-1),'uncertain or aborted client must be discarded');
  const calls=nativeCalls;if(onReadable)stream.removeListener('readable',onReadable);stream.resume();await new Promise(done=>setImmediate(done));assert.equal(nativeCalls,calls,'late response cannot continue a transaction');assert.equal(f.control.effects,effects);
  t.mock.timers.reset();t.mock.restoreAll();const replacement=await pool.connect();try{assert.notEqual(replacement,db,'discarded connection is never reacquired');await replacement.query('SELECT 1');}finally{replacement.release();}
  if(stage==='commit')assert.ok(['prepared','dispatching'].includes((await lastMarker(f)).state));
 }finally{
  cancellation.abort();if(onReadable)stream?.removeListener('readable',onReadable);stream?.resume();t.mock.timers.reset();if(pending)await pending;t.mock.restoreAll();pool.removeListener('release',released);await f.close();
 }
});
