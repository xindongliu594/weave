import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {once} from 'node:events';
import type http from 'node:http';
import type pg from 'pg';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {inspectArtifact} from '../services/agent-runtime/handoff.mjs';

const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const department=randomUUID(),project=randomUUID(),runId=randomUUID(),space=randomUUID(),otherSpace=randomUUID();
let root:string,url:string,pool:pg.Pool,server:http.Server,shutdown:()=>Promise<void>,fixtureSnapshot:any;
const api=async(path:string,body?:unknown)=>{const r=await fetch(url+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json() as any};};
before(async()=>{
 if(!isolated)return;
 root=mkdtempSync(join(tmpdir(),'work-records-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=join(root,'runs');process.env.OBSIDIAN_VAULT=join(root,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[department,{name:'隔离研发部门',agents:[]}]);
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[project,department,'隔离研发部门','测试知识登记：不是模型验收证据',{maxBudget:1},{agents:[],tasks:[]},'manual']);
 const snapshot={mode:'product',projectId:project,departmentId:department,planVersion:1,requirement:'测试知识登记：不是模型验收证据',title:'隔离工作记录',agents:[],tasks:[{id:'code',kind:'implementation',subject:'测试用源码',dependencies:[],inputs:[],outputs:[{path:'cli.mjs'}],inScope:['cli.mjs'],verify:['node --check cli.mjs']}]};
 fixtureSnapshot=snapshot;
 const archive=createRunArchive(process.env.TRACE_ROOT,snapshot,{id:runId}),files=join(process.env.TRACE_ROOT!,runId,'artifacts');mkdirSync(files,{recursive:true});writeFileSync(join(files,'cli.mjs'),'console.log("fixture");\n');
 const seal=inspectArtifact(files,{path:'cli.mjs'});archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'code'}]});archive.append('handoff/accepted',{runId,taskId:'code',attemptId:'a',inputs:[],outputs:[seal],commands:[]});archive.append('team/checkpoint',{tasks:[{id:'t1',status:'completed',attemptId:'a'}]});archive.append('run/finished',{status:'completed'});
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,$2,1,'completed',$3)",[runId,project,snapshot]);
 await pool.query("INSERT INTO knowledge_spaces(id,name,scope,department_id,agent_ids) VALUES($1,'本部门记录','department',$2,'[]')",[space,department]);
 await pool.query("INSERT INTO knowledge_spaces(id,name,scope,agent_ids) VALUES($1,'公司共享','company','[]')",[otherSpace]);
 const {createApp}=await import('../apps/api/src/app.ts');const app=createApp();shutdown=app.locals.shutdown;await shutdown();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port+'/api';
});

test('directional workspace imports and legacy private knowledge cannot publish into department knowledge',{skip:!isolated},async()=>{
 let attempt=2;
 for(const privateSource of [{importedFiles:[{path:'private.txt',agentIds:['reader']}]},{knowledge:{reader:[{content:'private fixture'}],manager:[]}}]){
  const id=randomUUID(),snapshot={...structuredClone(fixtureSnapshot),agents:[{id:'reader',tools:['filesystem','artifact_write','terminal_test']},{id:'manager',tools:['filesystem']}],...privateSource};snapshot.tasks[0].assigneeId='reader';
  const archive=createRunArchive(process.env.TRACE_ROOT!,snapshot,{id}),files=join(process.env.TRACE_ROOT!,id,'artifacts');mkdirSync(files,{recursive:true});writeFileSync(join(files,'cli.mjs'),'fixture');
  archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'code'}]});archive.append('handoff/accepted',{runId:id,taskId:'code',attemptId:'a',inputs:[],outputs:[inspectArtifact(files,{path:'cli.mjs'})],commands:[]});archive.append('team/checkpoint',{tasks:[{id:'t1',status:'completed',attemptId:'a'}]});archive.append('run/finished',{status:'completed'});
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,attempt,status,snapshot) VALUES($1,$2,1,$3,'completed',$4)",[id,project,attempt++,snapshot]);
  const read=await api('/knowledge/work-records/'+id);assert.equal(read.status,200,JSON.stringify(read.data));assert.equal(read.data.shareable,false);
  assert.equal((await api('/knowledge/work-records/'+id+'/publish',{spaceId:space})).status,422);
 }
});

test('work knowledge projects sealed test counters without inventing legacy values',{skip:!isolated},async()=>{
 const id=randomUUID(),snapshot=structuredClone(fixtureSnapshot),archive=createRunArchive(process.env.TRACE_ROOT!,snapshot,{id}),files=join(process.env.TRACE_ROOT!,id,'artifacts');mkdirSync(files,{recursive:true});writeFileSync(join(files,'cli.mjs'),'fixture');
 archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'code'}]});archive.append('handoff/accepted',{runId:id,taskId:'code',attemptId:'a',inputs:[],outputs:[inspectArtifact(files,{path:'cli.mjs'})],commands:[{command:'node --test cli.test.mjs',exitCode:0,evidence:{nodeTests:{status:'available',format:'tap',tests:17,pass:17,fail:0,cancelled:0,skipped:0,todo:0}}},{command:'node --check cli.mjs',exitCode:0}]});archive.append('team/checkpoint',{tasks:[{id:'t1',status:'completed',attemptId:'a'}]});archive.append('run/finished',{status:'completed'});
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,attempt,status,snapshot) VALUES($1,$2,1,4,'completed',$3)",[id,project,snapshot]);
 const read=await api('/knowledge/work-records/'+id);assert.equal(read.status,200,JSON.stringify(read.data));
 assert.equal(read.data.nodes[0].commands[0].tests.tests,17);assert.equal(read.data.nodes[0].commands[0].tests.pass,17);
 assert.equal(read.data.nodes[0].commands[1].tests.status,'unknown');assert.equal(read.data.nodes[0].commands[1].tests.tests,undefined);
});
after(async()=>{if(!isolated)return;server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool?.end();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'work-records-'));rmSync(root,{recursive:true,force:true});});

test('accepted work is discoverable and publishes once through the existing versioned knowledge index', {skip:!isolated},async()=>{
 const listed=await api('/knowledge/work-records');assert.equal(listed.status,200);assert.ok(listed.data.some((record:any)=>record.runId===runId));
 const read=await api('/knowledge/work-records/'+runId);assert.equal(read.status,200);assert.equal(read.data.files[0].path,'cli.mjs');assert.match(read.data.content,/不是模型验收证据/);
 assert.equal((await api('/knowledge/work-records/'+runId+'/publish',{spaceId:otherSpace})).status,422,'cannot widen publication to a company space');
 const first=await api('/knowledge/work-records/'+runId+'/publish',{spaceId:space});assert.equal(first.status,201,JSON.stringify(first.data));
 const again=await api('/knowledge/work-records/'+runId+'/publish',{spaceId:space});assert.equal(again.status,200);assert.equal(again.data.id,first.data.id);
 const doc=(await pool.query('SELECT r.* FROM knowledge_revisions r WHERE document_id=$1',[first.data.id])).rows;assert.equal(doc.length,1);assert.equal(doc[0].source.runId,runId);assert.equal(doc[0].sha256,read.data.sha256);
 assert.ok((await pool.query('SELECT id FROM knowledge_chunks WHERE document_id=$1',[first.data.id])).rowCount!>0,'uses existing searchable chunks');
 await pool.query("UPDATE departments SET deleted_at=now() WHERE id=$1",[department]);assert.equal((await api('/knowledge/work-records')).data.length,0);assert.equal((await api('/knowledge/work-records/'+runId)).status,409,'archiving department hides the node while retaining source history');
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE id=$1',[runId])).rowCount,1);
 await pool.query('UPDATE departments SET deleted_at=NULL WHERE id=$1',[department]);
 writeFileSync(join(process.env.TRACE_ROOT!,runId,'artifacts','cli.mjs'),'changed');assert.equal((await api('/knowledge/work-records/'+runId)).status,409,'changed evidence cannot masquerade as an accepted record');
});
