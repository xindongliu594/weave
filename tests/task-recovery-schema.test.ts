import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {enterpriseTableSpecs,createEnterpriseBackup,parseEnterpriseBackup,ENTERPRISE_BACKUP_SCHEMA_ID,type EnterpriseTableName} from '../apps/api/src/enterprise-backup-schema.ts';
import {inspectEnterpriseTable,enterpriseCatalogFingerprint,assertEnterpriseCatalog} from '../apps/api/src/enterprise-backup-catalog.ts';
import {validateEnterpriseBackupReferences} from '../apps/api/src/backup-checkpoints.ts';
import {resolve} from 'node:path';

const isolated=process.env.SIMULATED_INTEGRATION==='pglite',at='2026-11-01T00:00:00.000Z';
const emptyEvidence='{"version":1,"recoveryInitialization":null,"sourceHistory":null}';
function row(table:EnterpriseTableName,values:Record<string,unknown>){
  return Object.fromEntries(Object.entries(enterpriseTableSpecs[table].columns).map(([name,[type,required]])=>[
    name,Object.hasOwn(values,name)?values[name]:!required?null:type==='integer'?1:type==='boolean'?false:type==='jsonb'?'{}':type==='text[]'?[]:type==='timestamp with time zone'?at:'fixture',
  ]));
}
function payload(evidence:string|null){
  const tables=Object.fromEntries(Object.keys(enterpriseTableSpecs).map(name=>[name,[] as Record<string,unknown>[]]));
  tables.departments.push(row('departments',{id:'department'}));
  tables.projects.push(row('projects',{id:'project',department_id:'department'}));
  tables.project_runs.push(row('project_runs',{id:randomUUID(),project_id:'project',task_evidence:evidence}));
  return {version:2,schemaId:ENTERPRISE_BACKUP_SCHEMA_ID,createdAt:at,source:{applicationVersion:'0.2.0',databaseId:randomUUID(),engine:'pglite'},tables,files:{},master:null,nativePluginBundles:{},vaultFiles:{}};
}

test('fixed backup metadata includes nullable task evidence without silently inventing old-row fields',()=>{
  assert.deepEqual((enterpriseTableSpecs.project_runs.columns as Record<string,unknown>).task_evidence,['jsonb',false]);
  for(const evidence of [null,'null',emptyEvidence]){
    const backup=createEnterpriseBackup(payload(evidence));
    assert.equal(backup.tables.project_runs[0].task_evidence,evidence);
    assert.equal(parseEnterpriseBackup(backup).tables.project_runs[0].task_evidence,evidence);
  }
  const old=createEnterpriseBackup(payload(null));delete old.tables.project_runs[0].task_evidence;
  const original=JSON.stringify(old);
  assert.throws(()=>parseEnterpriseBackup(old),(error:any)=>error.code==='BACKUP_FORMAT_INVALID');
  assert.equal(JSON.stringify(old),original);
});

test('task recovery carrier rejects non-NULL markers and uninitialized task recovery ancestry',()=>{
  const root=resolve('.private/recovery-schema-unused');
  for(const evidence of ['null',emptyEvidence,'{"version":1,"recoveryInitialization":{"forged":true},"sourceHistory":null}']){
    const backup=payload(evidence);
    assert.throws(()=>validateEnterpriseBackupReferences(backup as any,root),(error:any)=>error.code==='BACKUP_REFERENCE_INVALID');
  }
  const ancestry=payload(null);ancestry.tables.project_runs[0].snapshot=JSON.stringify({executionProfile:'task-attempt-openshell-v1',recovery:{sourceRunId:'parent'}});
  assert.throws(()=>validateEnterpriseBackupReferences(ancestry as any,root),(error:any)=>error.code==='BACKUP_REFERENCE_INVALID');
  const plain=payload(null);
  assert.doesNotThrow(()=>validateEnterpriseBackupReferences(plain as any,root));
});

test('nullable task evidence migration preserves old runs, defaults new rows to SQL NULL and matches the fixed catalog',{skip:!isolated},async()=>{
  const {pool,migrate}=await import('../apps/api/src/db.ts');
  const departmentId=randomUUID(),projectId=randomUUID(),runId=randomUUID(),nextRunId=randomUUID();
  try{
    await migrate();await pool.query('ALTER TABLE project_runs DROP COLUMN IF EXISTS task_evidence');
    await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'owned schema fixture',agents:[]}]);
    const policy={allowedModelIds:[],allowedTools:[],allowedKnowledgeSpaceIds:[],allowedDepartmentIds:[]};
    await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$3,$4,$5,$3)',[projectId,departmentId,'schema fixture',policy,{agents:[],tasks:[]}]);
    const canonical={version:1,revision:'preserved-old-value',manifest:[],mergeId:null,receipt:null},snapshot={projectId,planVersion:1,oldRecord:'preserve exactly'};
    await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,canonical_workspace) VALUES($1,$2,1,'cancelled',$3,$4)",[runId,projectId,snapshot,canonical]);
    const before=(await pool.query('SELECT row_to_json(r) AS row FROM project_runs r WHERE id=$1',[runId])).rows[0].row;
    await migrate();
    const column=(await pool.query("SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_runs' AND column_name='task_evidence'")).rows;
    assert.deepEqual(column,[{is_nullable:'YES',column_default:null}]);
    assert.deepEqual((await pool.query('SELECT row_to_json(r) AS row FROM project_runs r WHERE id=$1',[runId])).rows[0].row,{...before,task_evidence:null});
    await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt) VALUES($1,$2,1,'queued',$3,2)",[nextRunId,projectId,snapshot]);
    assert.equal((await pool.query('SELECT task_evidence FROM project_runs WHERE id=$1',[nextRunId])).rows[0].task_evidence,null);
    await pool.query('UPDATE project_runs SET task_evidence=$1::jsonb WHERE id=$2',[emptyEvidence,runId]);
    const stored=(await pool.query('SELECT row_to_json(r) AS row FROM project_runs r WHERE project_id=$1 ORDER BY id',[projectId])).rows;
    await migrate();
    assert.deepEqual((await pool.query('SELECT row_to_json(r) AS row FROM project_runs r WHERE project_id=$1 ORDER BY id',[projectId])).rows,stored);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations WHERE run_id=ANY($1::text[])',[[runId,nextRunId]])).rows[0].n,0);
    for(const table of ['usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table+' WHERE project_id=$1',[projectId])).rows[0].n,0);
    const {readEnterpriseTables}=await import('../apps/api/src/enterprise-backup-export.ts'),portable=await readEnterpriseTables(pool);
    const archived=portable.project_runs.find(row=>row.id===runId)!;
    assert.ok(Object.hasOwn(archived,'task_evidence'));assert.deepEqual(JSON.parse(archived.task_evidence as string),JSON.parse(emptyEvidence));
    assert.equal(portable.project_runs.find(row=>row.id===nextRunId)!.task_evidence,null);
    const table=await inspectEnterpriseTable(pool,'project_runs'),schema=(await pool.query('SELECT current_schema() AS name')).rows[0].name;
    const fingerprint=enterpriseCatalogFingerprint(table,schema);
    console.log('TASK_RECOVERY_PROJECT_RUNS_FINGERPRINT='+fingerprint);
    assert.deepEqual(table.columns,Object.entries(enterpriseTableSpecs.project_runs.columns).map(([name,[type,required]])=>({name,type,required})));
    assert.equal(fingerprint,enterpriseTableSpecs.project_runs.databaseFingerprint);
    await assertEnterpriseCatalog(pool);
  }finally{await pool.end();}
});
