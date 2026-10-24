import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {identityPostgresUrl} from './fixtures/identity/postgres.ts';
import {migrateIdentity} from '../apps/api/src/identity-schema.ts';
import {saveKnowledgeDocument} from '../apps/api/src/knowledge.ts';
import {pool as unusedPool} from '../apps/api/src/db.ts';

test('knowledge publication retains active department authority through commit and rejects a prior archive',{skip:!process.env.KNOWLEDGE_REVIEW_POSTGRES_URL&&process.env.SIMULATED_INTEGRATION!=='resource-postgres'},async()=>{
 const url=process.env.SIMULATED_INTEGRATION==='resource-postgres'?(await import('../scripts/test-support/resource-postgres.mjs')).resourcePostgresEnvironment():identityPostgresUrl(process.env.KNOWLEDGE_REVIEW_POSTGRES_URL!);assert.equal(process.env.DATABASE_URL,url);
 const db=new pg.Pool({connectionString:url,max:3,statement_timeout:5000,connectionTimeoutMillis:3000});
 let writer:pg.PoolClient|undefined,archive:pg.PoolClient|undefined,release!:()=>void;const bodyHold=new Promise<void>(r=>release=r);let publication:Promise<unknown>|undefined;
 try{
  const base=readFileSync(new URL('../apps/api/src/db.ts',import.meta.url),'utf8').match(/await pool\.query\(`([\s\S]*?)`\);/);assert.ok(base);await db.query(base[1]);await migrateIdentity(db);
  const source=readFileSync(new URL('../apps/api/src/product-schema.ts',import.meta.url),'utf8');
  for(const table of ['knowledge_spaces','knowledge_documents','knowledge_revisions','knowledge_chunks']){
   const ddl=source.match(new RegExp('CREATE TABLE IF NOT EXISTS '+table+' \\([\\s\\S]*?\\);'));assert.ok(ddl);await db.query(ddl[0]);
  }
  await db.query("ALTER TABLE knowledge_revisions ADD COLUMN source_bounds jsonb; ALTER TABLE project_runs ADD COLUMN department_ids text[] NOT NULL DEFAULT '{}'; ALTER TABLE plan_versions ADD COLUMN policy jsonb");
  const department=randomUUID(),space=randomUUID(),document=randomUUID(),user=randomUUID();
  await db.query('INSERT INTO departments(id,data) VALUES($1,$2)',[department,{name:'Review fixture',agents:[]}]);
  await db.query("INSERT INTO knowledge_spaces(id,name,scope,department_id) VALUES($1,'Review fixture','department',$2)",[space,department]);
  await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES($1,'https://review.invalid','member','active','member')",[user]);
  await db.query("INSERT INTO department_memberships(department_id,user_id,role,can_approve,granted_by) VALUES($1,$2,'operator',false,$2)",[department,user]);
  writer=await db.connect();const writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;await writer.query('BEGIN');
  let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const wrapped={...writer,query:async(sql:string,values?:unknown[])=>{if(sql.startsWith('INSERT INTO knowledge_revisions')){entered();await bodyHold;}return writer!.query(sql,values);}} as unknown as pg.PoolClient;
  const principal={kind:'human' as const,userId:user,sessionId:'review',issuer:'https://review.invalid',subject:'member',orgRole:'member' as const,sessionEpoch:0,authenticatedAt:new Date().toISOString()};
  publication=saveKnowledgeDocument({spaceId:space,title:'Review publication',content:'Synthetic review content'},document,true,undefined,{principal,client:wrapped});publication.catch(()=>{});
  await Promise.race([ready,publication.then(()=>assert.fail('expected publication barrier'))]);
  archive=await db.connect();let archivePid:number;
  archivePid=(await archive.query('SELECT pg_backend_pid() pid')).rows[0].pid;assert.notEqual(writerPid,archivePid);
  let archiveDone=false;
  const archiveResult=archive.query('UPDATE departments SET deleted_at=now(),version=version+1 WHERE id=$1 AND version=1 AND deleted_at IS NULL RETURNING id',[department]).finally(()=>{archiveDone=true;});
  archiveResult.catch(()=>{});
  let blockers:number[]=[];const deadline=Date.now()+2000;
  do{blockers=(await db.query('SELECT pg_blocking_pids($1) pids',[archivePid])).rows[0].pids;if(blockers.includes(writerPid)||archiveDone)break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<deadline);
  // Removing the department lock permits archive to commit at this exact publication barrier.
  assert.ok(blockers.includes(writerPid),'archive must wait for the authorized publication transaction');assert.equal(archiveDone,false);
  release();const result=await publication;await writer.query('COMMIT');assert.equal((await archiveResult).rowCount,1);
  const row=(await db.query('SELECT d.deleted_at IS NOT NULL archived,(SELECT count(*)::int FROM knowledge_revisions WHERE document_id=$2) revisions FROM departments d WHERE id=$1',[department,document])).rows[0];
  assert.deepEqual(row,{archived:true,revisions:1});
  const rejected=randomUUID(),before=Number((await db.query('SELECT count(*) count FROM human_audit_events')).rows[0].count);await writer.query('BEGIN');
  await assert.rejects(saveKnowledgeDocument({spaceId:space,title:'After archive',content:'Must not persist'},rejected,true,undefined,{principal,client:writer}),(error:any)=>error.status===404);
  await writer.query('ROLLBACK');assert.equal(Number((await db.query('SELECT count(*) count FROM knowledge_revisions WHERE document_id=$1',[rejected])).rows[0].count),0);
  assert.equal(Number((await db.query('SELECT count(*) count FROM human_audit_events')).rows[0].count),before);
  console.log(JSON.stringify({writerPid,archivePid,blockers,archiveBlockedBeforePublication:true,result,persisted:row,priorArchiveRejected:true}));
 }finally{release();await publication?.catch(()=>{});if(writer){await writer.query('ROLLBACK').catch(()=>{});writer.release(true);}archive?.release(true);await db.end();await unusedPool.end();}
});
