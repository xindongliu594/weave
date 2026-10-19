// Accelerated checkpoint workload, not a five-hour employee or model run.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRunArchive} from '../../../services/agent-runtime/trace-store.mjs';
import {commitStepCheckpoint,readStepCheckpoints} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {archiveStorageUsage} from '../../../services/agent-runtime/archive-storage.mjs';

const root=mkdtempSync(join(tmpdir(),'weiwu-checkpoint-growth-'));
const digest=data=>createHash('sha256').update(data).digest('hex');
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
try {
 const archive=createRunArchive(root,{projectId:'synthetic-growth',tasks:[]});
 const workspace=join(archive.dir,'artifacts');mkdirSync(workspace);
 const fileCount=20,fileBytes=64*1024,checkpoints=600,expectedObjects=new Set(),latencies=[],records=[];
 const writeVersion=(file,version)=>{
  const bytes=Buffer.alloc(fileBytes,file);bytes.write(`file=${file};version=${version};`);
  writeFileSync(join(workspace,`file-${file}.txt`),bytes);expectedObjects.add(digest(bytes));
 };
 for(let file=0;file<fileCount;file++)writeVersion(file,0);
 const start=performance.now();
 for(let index=0;index<checkpoints;index++) {
  if(index>0&&index%10===0)writeVersion((index/10)%fileCount,index);
  const before=performance.now();
  records.push(commitStepCheckpoint({archive,workspace,receipts:[],boundary:{taskId:'synthetic',attemptId:'attempt',sessionId:'session',trigger:'cycle-complete',eventCursor:index+1,contractHash:'a'.repeat(64)}}));
  latencies.push(performance.now()-before);
 }
 const commitMs=performance.now()-start,readStart=performance.now();
 const restored=readStepCheckpoints({root,runId:archive.id}),readMs=performance.now()-readStart;
 assert.equal(restored.size,checkpoints);
 for(const checkpoint of records)assert.deepEqual(restored.get(checkpoint.id).files,checkpoint.files);
 const objectDir=join(archive.dir,'checkpoint-objects'),objects=readdirSync(objectDir);
 assert.deepEqual(new Set(objects),expectedObjects,'unchanged content must not be copied per checkpoint');
 for(const name of objects)assert.equal(digest(readFileSync(join(objectDir,name))),name);
 const objectBytes=objects.reduce((sum,name)=>sum+statSync(join(objectDir,name)).size,0);
 assert.equal(objectBytes,expectedObjects.size*fileBytes);
 const archiveBytes=archiveStorageUsage(archive.dir).bytes,naiveSnapshotBytes=checkpoints*fileCount*fileBytes;
 assert.ok(archiveBytes<naiveSnapshotBytes/20,'metadata plus content must remain below 5% of full repeated copies for this workload');
 console.log(JSON.stringify({passed:true,kind:'accelerated synthetic filesystem workload',platform:process.platform,node:process.version,modelCalls:0,checkpoints,fileCount,fileBytes,changedVersions:59,uniqueObjects:objects.length,objectBytes,archiveBytes,naiveSnapshotBytes,bytesSavedFraction:1-archiveBytes/naiveSnapshotBytes,commitMs,commitP50Ms:percentile(latencies,.5),commitP95Ms:percentile(latencies,.95),first50P95Ms:percentile(latencies.slice(0,50),.95),last50P95Ms:percentile(latencies.slice(-50),.95),validateAllMs:readMs,limits:'No employee sessions, sandbox commands, model calls or real elapsed five-hour soak; no performance threshold assertion.'},null,2));
} finally {rmSync(root,{recursive:true,force:true});}
