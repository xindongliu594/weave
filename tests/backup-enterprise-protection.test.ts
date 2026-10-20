import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type http from 'node:http';
import type pg from 'pg';

// Only the guarded isolated integration runner may provide this database.
if(process.env.SIMULATED_INTEGRATION!=='pglite')throw Error('Use scripts/test-integration.mjs for this fixture');
let pool:pg.Pool,server:http.Server,root:string,base:string,backup:any;
const password='isolated-restore-fixture',runId=randomUUID(),key=Buffer.alloc(32,7);
async function post(path:string,body:any){const response=await fetch(base+'/backup/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
before(async()=>{
 root=await mkdtemp(join(tmpdir(),'weiwu-restore-protection-'));process.env.DATA_DIR=root;process.env.OBSIDIAN_VAULT=join(root,'vault');process.env.TRACE_ROOT=join(root,'runs');
 await mkdir(join(root,'runs'),{recursive:true});await writeFile(join(root,'credential.key'),key);
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 const {backupRouter}=await import('../apps/api/src/backup.ts');
 const app=express();app.use(express.json({limit:'50mb'}));app.use(backupRouter(join(root,'runs')));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as any).port;
 const response=await post('export',{password});assert.equal(response.status,200,JSON.stringify(response.data));backup=response.data;
});
after(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(root)await rm(root,{recursive:true,force:true});});

test('legacy encrypted restore remains available for a destination without enterprise history',async()=>{
 const response=await post('restore',{password,backup,confirmation:'RESTORE'});
 assert.equal(response.status,200,JSON.stringify(response.data));assert.deepEqual(await readFile(join(root,'credential.key')),key);
});

test('activated bootstrap alone protects an otherwise empty target before SQL clear and file swap',async()=>{
 await pool.query("UPDATE identity_bootstrap SET expected_fingerprint='fixture-fingerprint',activated_at=now(),version=version+1 WHERE id=1");
 const before=(await pool.query('SELECT * FROM identity_bootstrap')).rows;
 const response=await post('restore',{password,backup,confirmation:'RESTORE'});
 assert.equal(response.status,409,JSON.stringify(response.data));assert.equal(response.data.code,'BACKUP_DESTINATION_PROTECTED');
 assert.deepEqual((await pool.query('SELECT * FROM identity_bootstrap')).rows,before);
 // Remove only this isolated fixture's bootstrap to exercise independent audit/user protection next.
 await pool.query('UPDATE identity_bootstrap SET expected_fingerprint=NULL,activated_at=NULL,version=1 WHERE id=1');
});

test('restore preserves destination users, membership, audits, outbox, projection, files and key',async()=>{
 await pool.query("INSERT INTO departments(id,data) VALUES('target-department',$1)",[{name:'Destination only'}]);
 await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('target-user','https://fixture.invalid','fixture-subject','active','admin')");
 await pool.query("INSERT INTO department_memberships(department_id,user_id,role) VALUES('target-department','target-user','manager')");
 await pool.query("INSERT INTO human_audit_events(id,actor_kind,actor_user_id,actor_snapshot,action,resource_type,resource_id,department_id,outcome) VALUES('target-audit','human','target-user',$1,'fixture','department','target-department','target-department','success')",[{id:'target-user'}]);
 await pool.query("INSERT INTO audit_outbox(id,audit_event_id,event_type,payload) VALUES('target-outbox','target-audit','fixture',$1)",[{fixture:true}]);
 await pool.query("INSERT INTO audit_run_projection(audit_event_id,correlation_id,occurred_at,summary) SELECT id,'fixture-correlation',occurred_at,$1 FROM human_audit_events WHERE id='target-audit'",[{fixture:true}]);
 await mkdir(join(root,'runs',runId,'artifacts'),{recursive:true});await writeFile(join(root,'runs',runId,'artifacts','kept.txt'),'keep target evidence');
 const names=['departments','human_users','department_memberships','human_audit_events','audit_outbox','audit_run_projection','identity_bootstrap'];
 const before=await Promise.all(names.map(async name=>(await pool.query('SELECT * FROM '+name)).rows));
 const paths=(await readdir(root)).filter(name=>!name.startsWith('before-restore-')).sort();
 const response=await post('restore',{password,backup,confirmation:'RESTORE'});
 assert.equal(response.status,409,JSON.stringify(response.data));assert.equal(response.data.code,'BACKUP_DESTINATION_PROTECTED');
 assert.deepEqual(await Promise.all(names.map(async name=>(await pool.query('SELECT * FROM '+name)).rows)),before);
 assert.equal(await readFile(join(root,'runs',runId,'artifacts','kept.txt'),'utf8'),'keep target evidence');assert.deepEqual(await readFile(join(root,'credential.key')),key);
 assert.deepEqual((await readdir(root)).filter(name=>!name.startsWith('before-restore-')).sort(),paths,'rejected stage is removed; target was not swapped');
});
