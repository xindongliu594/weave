import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {migrateWorkFiles,workFilesRouter} from '../apps/api/src/work-files.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {inspectArtifact} from '../services/agent-runtime/handoff.mjs';

test('reuse preserves exact accepted bytes and source; duplicates, unsealed, changed and unfinished files never create extra snapshots',async()=>{
 const root=mkdtempSync(join(tmpdir(),'reuse-run-')),db=new PGlite();await db.waitReady;
 await db.query('CREATE TABLE project_runs(id text PRIMARY KEY,status text,snapshot jsonb)');await migrateWorkFiles(db as any);await migrateWorkFiles(db as any);
 const runId=randomUUID(),snapshot={mode:'product',projectId:randomUUID(),planVersion:1,title:'Isolated fixture, not model acceptance',agents:[],tasks:[{id:'code',kind:'implementation',dependencies:[],inputs:[],outputs:[{path:'cli.mjs'}],inScope:['cli.mjs'],verify:['node --check cli.mjs']}]};
 const archive=createRunArchive(root,snapshot,{id:runId}),files=join(root,runId,'artifacts');mkdirSync(files,{recursive:true});writeFileSync(join(files,'cli.mjs'),'console.log("fixture");\n');writeFileSync(join(files,'scratch.txt'),'unverified scratch');
 const seal=inspectArtifact(files,{path:'cli.mjs'});
 archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'code'}]});archive.append('handoff/accepted',{runId,taskId:'code',attemptId:'a',inputs:[],outputs:[seal],commands:[]});archive.append('team/checkpoint',{tasks:[{id:'t1',status:'completed',attemptId:'a'}]});archive.append('run/finished',{status:'completed'});
 await db.query('INSERT INTO project_runs VALUES($1,$2,$3)',[runId,'completed',snapshot]);
 const adapter={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
 const app=express();app.use(express.json());app.use('/api',workFilesRouter(adapter as any,root));app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status??422).json({message:e.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as any).port+'/api';
 const request=async(paths:string[])=>{const r=await fetch(base+'/work-files/from-run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId,paths})});return {status:r.status,data:await r.json() as any};};
 try{
  const first=await request(['cli.mjs']);assert.equal(first.status,201,JSON.stringify(first.data));assert.equal(first.data.sourceRunId,runId);
  const preview=await(await fetch(base+'/work-files/'+first.data.id)).json() as any;assert.equal(preview.sourceRunId,runId);assert.equal(preview.files[0].sha256,seal.sha256);assert.equal(preview.files[0].text,'console.log("fixture");\n');assert.equal(preview.files[0].base64,undefined);
  const again=await request(['cli.mjs']);assert.equal(again.status,200);assert.equal(again.data.id,first.data.id);assert.equal(again.data.existing,true);
  assert.equal((await request(['scratch.txt'])).status,409);assert.equal((await request(['../cli.mjs'])).status,422);
  writeFileSync(join(files,'cli.mjs'),'changed after acceptance');assert.equal((await request(['cli.mjs'])).status,409);
  await db.query("UPDATE project_runs SET status='running'");assert.equal((await request(['cli.mjs'])).status,409);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM work_file_snapshots')).rows[0].n,1);
  const copied=await(await fetch(base+'/work-files/'+first.data.id+'/files/0/download')).text();assert.equal(copied,'console.log("fixture");\n','later source changes cannot change the saved copy');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await db.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'reuse-run-'));rmSync(root,{recursive:true,force:true});}
});
