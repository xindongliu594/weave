import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pool} from '../apps/api/src/db.ts';
import {acceptedStopApiFixture} from './helpers/task-accepted-stop-api-fixture.ts';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {isolated,integrationRoot,queryText,terminalReady,finalize,lastMarker} from './helpers/task-accepted-stop-delivery-support.ts';

test('terminal source-only stops the last accepted scope without an active target',{skip:!isolated},async()=>{
 const f=await terminalReady();try{
  const result=await finalize(f.executor);assert.deepEqual(result,{version:1,state:'stopped'});assert.equal(f.control.effects,3);assert.equal((await lastMarker(f)).state,'stopped');assert.ok(f.control.signals.at(-1) instanceof AbortSignal);
  await finalize(f.executor);assert.equal(f.control.effects,3,'confirmed stops never replay');
 }finally{await f.close();}
});

for(const damage of ['incomplete-node','missing-row','null-provenance','missing-cp','retired-row'])test('terminal all-approved proof refuses '+damage+' before any fresh effect',{skip:!isolated},async()=>{
 const f=damage==='incomplete-node'?await acceptedStopApiFixture(integrationRoot):await terminalReady();try{
  if(damage==='incomplete-node')await f.acceptA();
  if(damage==='missing-row')await pool.query("DELETE FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='c'",[f.runId]);
  if(damage==='null-provenance')await pool.query("UPDATE task_attempt_workspaces SET sandbox_identity=NULL WHERE run_id=$1 AND task_id='c'",[f.runId]);
  if(damage==='retired-row')await pool.query("UPDATE task_attempt_workspaces SET phase='retired' WHERE run_id=$1 AND task_id='c'",[f.runId]);
  if(damage==='missing-cp'){const events=readRun(integrationRoot,f.runId)!.events;const cp=events.findLast(event=>event.type==='step/checkpoint'&&event.data.key?.taskId==='c')!;cp.type='unrelated';writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));}
  const effects=f.control.effects,result=await finalize(f.executor);assert.equal(result.state,'pending');assert.equal(f.control.effects,effects);
 }finally{await f.close();}
});

test('terminal prepare refuses capability mutation during initialization before any device prepare',{skip:!isolated},async t=>{
 const f=await acceptedStopApiFixture(integrationRoot);try{
  const db=await pool.connect(),query=db.query.bind(db);let changed=false;
  t.mock.method(db,'query',async(...args:any[])=>{const result=await (query as any)(...args);if(queryText(args)==='COMMIT'&&!changed){changed=true;f.maintenance().executor.acceptedStopCapabilities=()=>({version:1,deadline:'wrong'} as any);}return result;});db.release();
  await assert.rejects(async()=>f.executor.prepare(new AbortController().signal),{code:'TASK_STOP_UNAVAILABLE'});assert.equal(changed,true);assert.equal(f.jobs.length,0);assert.equal(f.control.effects,0);
  await assert.rejects(async()=>f.executor.prepare(new AbortController().signal),{code:'TASK_STOP_UNAVAILABLE'});
 }finally{t.mock.restoreAll();await f.close();}
});

for(const fresh of [2,3])test('terminal fresh-stop bound handles '+fresh+' real accepted scopes',{skip:!isolated},async()=>{
 const f=await terminalReady(fresh);try{
  const before=f.control.effects,result=await finalize(f.executor);
  assert.equal(result.state,fresh===2?'stopped':'pending');assert.equal(f.control.effects-before,fresh===2?2:0);
  if(fresh===3){assert.equal(result.reasonCode,'TASK_STOP_FINALIZE_LIMIT');assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_attempt_workspaces WHERE run_id=$1 AND accepted_stop IS NOT NULL',[f.runId])).rows[0].n,0);}
 }finally{await f.close();}
});
