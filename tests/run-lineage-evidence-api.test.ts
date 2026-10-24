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
import type pg from 'pg';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {runLineageEvidenceRouter} from '../apps/api/src/run-lineage-evidence.ts';

// In-memory database, new temporary trace directory and test-owned listener.
// No live service, project data, gateway or model is involved.
assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname));
const root=mkdtempSync(join(tmpdir(),'weiwu-lineage-api-'));
const sourceId=randomUUID(),currentId=randomUUID(),operationId=randomUUID(),projectId=randomUUID(),departmentId=randomUUID(),deviceId=randomUUID();
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const output='# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
let database:pg.Pool,server:Server,baseUrl:string;
before(async()=>{
 // The isolated runner supplies real schema, TEXT IDs and ownership/FK rows.
 process.env.DATA_DIR=root;process.env.OBSIDIAN_VAULT=join(root,'vault');process.env.WEIWU_AUTH_MODE='legacy-local';
 const db=await import('../apps/api/src/db.ts');database=db.pool;await db.migrate();
 const plan={agents:[{id:'qa'}]},policy={allowedDepartmentIds:[departmentId]};
 await database.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'Fixture'}]);
 await database.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,version,source) VALUES($1,$2,1,'Fixture','Synthetic lineage',$3,$4,12,'manual')",[projectId,departmentId,policy,plan]);
 await database.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,12,$2,$3)',[projectId,plan,policy]);
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
 const currentSnapshot={...snapshot,approvedTasks:tasks,handoffCheckpoints:[seal],recovery:{version:1,sourceRunId:sourceId,completed:[{taskId:'QA',attemptId:'attempt'}],files:[{...file,state:'accepted',producerTaskId:'QA'}]}};
 createRunArchive(root,currentSnapshot,{id:currentId});
 await database.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids,attempt) VALUES($1,$2,12,'completed',$3,$4,1),($5,$2,12,'queued',$6,$4,2)",[sourceId,projectId,snapshot,[departmentId],currentId,currentSnapshot]);
 await database.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label) VALUES($1,'fixture','Fixture','test','grant','fixture')",[deviceId]);
 await database.query("INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,status,started,payload,result) VALUES($1,$2,$3,'grant','fixture','completed',true,$4,$5)",[operationId,deviceId,sourceId,{name:'terminal_test',arguments:{command:command.command,expectedWorkspaceRevision:command.workspaceRevision},context:links},{ok:true,result:{exitCode:0,output}}]);
 const app=express();app.use((_req,res,next)=>{res.locals.principal={kind:'local-owner'};next();});app.use('/api',runLineageEvidenceRouter(database,root));
 app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??400).json({message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');baseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/`;
});
after(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(done=>server.close(()=>done()));await database?.end();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('weiwu-lineage-api-'));rmSync(root,{recursive:true,force:true});});

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
