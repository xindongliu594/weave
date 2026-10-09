import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {once} from 'node:events';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {runLineageEvidenceRouter} from '../apps/api/src/run-lineage-evidence.ts';

// In-memory database, new temporary trace directory and test-owned listener.
// No live service, project data, gateway or model is involved.
const database=new PGlite(),root=mkdtempSync(join(tmpdir(),'weiwu-lineage-api-'));
const sourceId=randomUUID(),currentId=randomUUID(),operationId=randomUUID(),projectId=randomUUID();
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const output='# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
let server:Server,baseUrl:string;
before(async()=>{
 // Production stores these UUID-shaped identifiers as TEXT, not PostgreSQL UUID.
 // Keep the real column types so typed-array queries are exercised faithfully.
 await database.exec('CREATE TABLE project_runs(id text PRIMARY KEY,project_id text,project_version int); CREATE TABLE local_operations(id text PRIMARY KEY,run_id text,status text,started boolean,payload jsonb,result jsonb);');
 const tasks=[{id:'QA',assignee:'qa',kind:'verification',dependencies:[],inputs:[],outputs:[{path:'fixture.test.mjs'}],verify:['node --test fixture.test.mjs']}];
 const snapshot={projectId,planVersion:12,tasks,mode:'product'};
 const source=createRunArchive(root,snapshot,{id:sourceId});
 source.append('run/task-mapping',{tasks:[{task_id:'native-qa',seed_id:'QA'}]});
 const links={operationId,name:'terminal_test',taskId:'QA',attemptId:'attempt',agentId:'qa',sessionId:'session',callId:'call',approvalId:'approval'};
 source.append('local/operation-queued',links);source.append('local/operation-finished',links);
 const command={command:'node --test fixture.test.mjs',exitCode:0,workspaceRevision:hash('workspace'),
  evidence:{version:1,runId:sourceId,tool:'terminal_test',sessionId:'session',callId:'call',approval:{status:'available',approvalId:'approval'},
   operation:{status:'available',operationId,queuedSeq:3,finishedSeq:4},output:{status:'available',complete:true,bytes:Buffer.byteLength(output),sha256:hash(output)}}};
 source.append('handoff/command-observed',{taskId:'QA',attemptId:'attempt',...command});
 const file={path:'fixture.test.mjs',size:1,sha256:hash('fixture')};
 const seal={runId:sourceId,taskId:'QA',attemptId:'attempt',workspaceRevision:hash('workspace'),inputs:[],outputs:[file],commands:[{...command,observationSeq:5}]};
 source.append('handoff/accepted',seal);source.append('team/checkpoint',{tasks:[{id:'native-qa',attemptId:'attempt',status:'completed'}]});source.append('run/finished',{status:'completed'});
 createRunArchive(root,{...snapshot,approvedTasks:tasks,handoffCheckpoints:[seal],recovery:{version:1,sourceRunId:sourceId,completed:[{taskId:'QA',attemptId:'attempt'}],files:[{...file,state:'accepted',producerTaskId:'QA'}]}},{id:currentId});
 await database.query('INSERT INTO project_runs VALUES ($1,$2,12),($3,$2,12)',[sourceId,projectId,currentId]);
 await database.query('INSERT INTO local_operations VALUES ($1,$2,$3,true,$4,$5)',[operationId,sourceId,'completed',{name:'terminal_test',arguments:{command:command.command,expectedWorkspaceRevision:command.workspaceRevision},context:links},{ok:true,result:{exitCode:0,output}}]);
 const app=express();app.use('/api',runLineageEvidenceRouter(database,root));
 app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??400).json({message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');baseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/`;
});
after(async()=>{if(server)await new Promise<void>(done=>server.close(()=>done()));await database.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('weiwu-lineage-api-'));rmSync(root,{recursive:true,force:true});});

test('actual router uses production TEXT identifiers to read the bound operation and immutable source evidence',async()=>{
 const response=await fetch(baseUrl+currentId+'/lineage-evidence');assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.status,'verified');assert.equal(result.receipts[0].sourceRunId,sourceId);assert.equal(result.receipts[0].acceptanceSeq,6);
 assert.equal(result.tests[0].operationId,operationId);assert.equal(result.tests[0].output,output);assert.equal(result.tests[0].nodeTests.pass,1);
 assert.equal((await database.query<{n:number}>('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,1);
});

test('cross-run database operation cannot be substituted by a matching ID',async()=>{
 await database.query('UPDATE local_operations SET run_id=$1 WHERE id=$2',[currentId,operationId]);
 try{const result=await (await fetch(baseUrl+currentId+'/lineage-evidence')).json();assert.equal(result.status,'partial');assert.deepEqual(result.tests,[]);}
 finally{await database.query('UPDATE local_operations SET run_id=$1 WHERE id=$2',[sourceId,operationId]);}
});

test('formal row identity, unknown IDs and strict query validation stay enforced',async()=>{
 assert.equal((await fetch(baseUrl+randomUUID()+'/lineage-evidence')).status,404);
 assert.equal((await fetch(baseUrl+currentId+'/lineage-evidence?sourceRunId='+sourceId)).status,400);
 await database.query('UPDATE project_runs SET project_version=13 WHERE id=$1',[currentId]);
 try{assert.equal((await fetch(baseUrl+currentId+'/lineage-evidence')).status,409);}
 finally{await database.query('UPDATE project_runs SET project_version=12 WHERE id=$1',[currentId]);}
});

test('missing or different database workspace revision cannot produce a verified QA card',async()=>{
 const original=(await database.query<{payload:any}>('SELECT payload FROM local_operations WHERE id=$1',[operationId])).rows[0].payload;
 try{
  for(const revision of [undefined,hash('different workspace')]){
   const changed=structuredClone(original);changed.arguments.expectedWorkspaceRevision=revision;
   await database.query('UPDATE local_operations SET payload=$1 WHERE id=$2',[changed,operationId]);
   const result=await (await fetch(baseUrl+currentId+'/lineage-evidence')).json();
   assert.equal(result.status,'partial');assert.equal(result.receipts.length,1);assert.deepEqual(result.tests,[]);
   assert.equal(result.issues.at(-1)?.code,'COMMAND_UNAVAILABLE');
  }
 }finally{await database.query('UPDATE local_operations SET payload=$1 WHERE id=$2',[original,operationId]);}
});

test('tampered ancestor snapshot and oversized archive return explicit unavailable evidence',async()=>{
 const source=join(root,sourceId,'snapshot.json'),original=readFileSync(source);
 writeFileSync(source,JSON.stringify({...JSON.parse(original.toString()),projectId:randomUUID()}));
 try{const result=await (await fetch(baseUrl+currentId+'/lineage-evidence')).json();assert.equal(result.status,'unavailable');assert.deepEqual(result.receipts,[]);}
 finally{writeFileSync(source,original);}
 const journal=join(root,currentId,'events.jsonl'),events=readFileSync(journal);truncateSync(journal,64*1024*1024+1);
 try{assert.equal((await fetch(baseUrl+currentId+'/lineage-evidence')).status,409);}
 finally{writeFileSync(journal,events);}
});
