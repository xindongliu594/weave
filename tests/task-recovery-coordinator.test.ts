import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {pool,migrate} from '../apps/api/src/db.ts';
import {taskRecoverySourceFixture,completeTaskRecoverySnapshot} from './helpers/task-recovery-source-fixture.ts';
import {RunCoordinator} from '../apps/api/src/run-coordinator.ts';
const isolated=process.env.SIMULATED_INTEGRATION==='pglite',base=resolve('.private/recovery-live-20261102');let root:string;
before(async()=>{if(!isolated)return;mkdirSync(base,{recursive:true});root=mkdtempSync(join(base,'coordinator-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');await migrate();});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(resolve(root).startsWith(base+sep));rmSync(root,{recursive:true});});
test('queued recovery is genuinely initialized before coordinator claims its child owner and SQL lease',{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  await completeTaskRecoverySnapshot(f,root);
  const coordinator=new RunCoordinator(root,f.writers,undefined,{startPaused:true});
  let launched:any,drained:Promise<void>|undefined;
  coordinator.runtime.inspect=async()=>({ready:true,reason:'fixture: no model runtime started'});
  coordinator.launch=(row:any,writer:any)=>{launched=row;writer.finish();drained=writer.writerDrained;return drained!;};
  await coordinator.tick();await drained;
  assert.ok(launched,'queued child reaches dispatch only after preflight');
  assert.ok(launched.task_evidence?.recoveryInitialization,'dispatch sees durable initialization');
  assert.equal(launched.canonical_workspace.mergeId,null);assert.equal(launched.status,'queued','claim row retains original pre-CAS status');
  const stored=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.childRunId])).rows[0];
  assert.equal(stored.status,'running');assert.equal(stored.lease_owner,coordinator.owner);
  assert.equal((await pool.query('SELECT count(*)::int n FROM local_operations WHERE run_id=$1',[f.childRunId])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM model_reservations')).rows[0].n,0);
 }finally{await f.close();}
});
