import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {acceptedStopApiFixture} from './helpers/task-accepted-stop-api-fixture.ts';
import {pool,migrate} from '../apps/api/src/db.ts';
import {createBackupRestoreState} from '../apps/api/src/backup-restore-state.ts';
import {exportEnterpriseBackup} from '../apps/api/src/enterprise-backup-export.ts';
import {decryptEnterpriseBackup,createEnterpriseBackup} from '../apps/api/src/enterprise-backup-schema.ts';
import {validateEnterpriseBackupReferences} from '../apps/api/src/backup-checkpoints.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';

test('enterprise task carrier resolves original API commits without granting execution',async t=>{
  assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
  const root=mkdtempSync(join(tmpdir(),'enterprise-task-export-')),traceRoot=join(root,'runs'),dataRoot=join(root,'credentials');
  process.env.DATA_DIR=dataRoot;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');delete process.env.LOCAL_WORKSPACE_ROOT;mkdirSync(dataRoot);writeFileSync(join(dataRoot,'credential.key'),Buffer.alloc(32,9));
  await migrate();const f=await acceptedStopApiFixture(traceRoot);
  t.after(async()=>{await f.close();await pool.end();rmSync(root,{recursive:true,force:true});});
  // Reuse existing HTTP/SQL/positive-commit fixture. Physical device effects are
  // fixtures; this proves backup preservation, not real employee/sandbox success.
  await f.acceptA();await pool.query("UPDATE project_runs SET status='cancelled' WHERE id=$1",[f.runId]);f.archive.append('run/finished',{status:'cancelled'});
  const bytes=Buffer.from('input'),file={path:'in.txt',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64'),kind:'text',text:'input',warnings:[]};
  await pool.query("INSERT INTO work_file_snapshots(id,name,files,bytes) VALUES('snapshot','fixture',$1,$2)",[JSON.stringify([file]),bytes.length]);
  // The old forensic archive is retained even if unrelated journal content is damaged.
  const old=createRunArchive(traceRoot,{projectId:'old',planVersion:1});writeFileSync(join(old.dir,'events.jsonl'),'old truncated evidence');
  const state=createBackupRestoreState({pool,writers:f.service.writers!,traceRoot,dataRoot}),password='owned-task-export-fixture';
  const value=await decryptEnterpriseBackup(await exportEnterpriseBackup({principal:{kind:'local-owner'},traceRoot,writers:f.service.writers!,state,password}),password);
  assert.ok(value.tables.task_attempt_workspaces.length);assert.ok(value.tables.local_operations.some(row=>row.merge_state==='committed'));assert.ok(value.tables.project_runs[0].canonical_workspace);
  assert.doesNotThrow(()=>validateEnterpriseBackupReferences(value,traceRoot));
  for(const damage of ['operation-missing','task-missing','merge-digest','result-digest','principal','import-missing','canonical-operation'] as const)await t.test('rejects '+damage,()=>{
    const changed=structuredClone(value),task=changed.tables.task_attempt_workspaces[0],operations=changed.tables.local_operations;
    const committed=operations.filter(row=>row.merge_state==='committed').at(-1)!;
    const edit=(row:any,key:string,fn:(v:any)=>void)=>{const v=JSON.parse(row[key]);fn(v);row[key]=JSON.stringify(v);};
    if(damage==='operation-missing')changed.tables.local_operations=[];
    if(damage==='task-missing')changed.tables.task_attempt_workspaces=[];
    if(damage==='merge-digest')edit(committed,'merge_record',v=>v.digest='f'.repeat(64));
    if(damage==='result-digest')edit(committed,'result',v=>v.result.execution.sandboxId='changed');
    if(damage==='principal')task.principal='another-employee';
    if(damage==='import-missing')changed.tables.work_file_snapshots=[];
    if(damage==='canonical-operation')edit(changed.tables.project_runs[0],'canonical_workspace',v=>{v.mergeId=operations.find(op=>op.id!==v.mergeId)!.id;v.receipt.operationId=v.mergeId;v.receipt.mergeId=v.mergeId;});
    // Recompute the package manifest: schema/hash integrity cannot replace
    // semantic closure against original operations and imported object sources.
    const {manifest:_manifest,...input}=changed;const payload=createEnterpriseBackup(input);
    assert.throws(()=>validateEnterpriseBackupReferences(payload,traceRoot),(error:any)=>error.code==='BACKUP_REFERENCE_INVALID');
  });
});
