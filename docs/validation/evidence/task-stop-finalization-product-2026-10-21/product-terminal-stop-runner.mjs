// Isolated engineering fixture runner: one serial scenario, explicit process
// settlement and immutable source evidence; no production/model connection.
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const patterns={normal:'three distinct product tasks',interleave:'historical partial',loss:'lost accepted stop','three-projects':'three sequential complete projects'};
const label=process.argv[2];if(!Object.hasOwn(patterns,label))throw Error('normal/interleave/loss/three-projects required');
const root=process.cwd(),evidence=join(root,'.superpowers/sdd/2026-10-20-task-checkpoint-v2-integration'),started=Date.now(),base='terminal-product-'+label+'-'+started;
const files=['tests/task-accepted-stop-product-flow.test.ts','tests/helpers/task-openshell-product-fixture.cjs','apps/desktop/openshell-executor.cjs','apps/desktop/sandbox-storage.cjs','apps/api/src/local-execution.ts','apps/api/src/task-accepted-stop.ts','apps/api/src/task-original-commit.ts','apps/api/src/task-checkpoint-state.ts','apps/api/src/handoff-checkpoints.ts','apps/api/src/task-execution.ts','apps/api/src/storage-lifecycle.ts','apps/api/src/task-stop-maintenance.ts','apps/api/src/run-management.ts','apps/api/src/app.ts','apps/api/src/task-accepted-stop-state.ts','apps/api/src/live-canonical-reader.ts','services/agent-runtime/product-runtime.mjs','services/agent-runtime/host.mjs','services/agent-runtime/task-tool-boundary.mjs','.superpowers/sdd/2026-10-20-task-checkpoint-v2-integration/product-terminal-stop-runner.mjs'];
const sha=()=>Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')])),startSha=sha(),log=join(evidence,base+'.txt');
const wrapperDeadlineMs=label==='three-projects'?590000:240000;
writeFileSync(log,'Engineering fixtures: models/CLI/UID/cgroup/mTLS; real Product/Host/Handoff/HTTP/CAS/executor/journal/REMOTE_SCRIPT/Node files. Zero paid API.\n');
const db=await PGlite.create({extensions:{vector}}),socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:8});
let port;socket.addEventListener('listening',event=>{port=event.detail.port;});await socket.start();
let timedOut=false;
try{
 const args=['--import','tsx','--import','./scripts/test-support/pglite-pool.mjs','--test','--test-concurrency=1','--test-reporter=tap','--test-name-pattern='+patterns[label],'tests/task-accepted-stop-product-flow.test.ts'];
 const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,SIMULATED_INTEGRATION:'pglite',DATABASE_URL:`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`}});
 writeFileSync(join(evidence,base+'-start.json'),JSON.stringify({label,pid:child.pid,parentPid:process.pid,startedAt:new Date(started).toISOString(),args,startSha,wrapperDeadlineMs},null,2));
 process.stdout.write('EVIDENCE '+base+'\n');
 const collect=stream=>stream.on('data',chunk=>{appendFileSync(log,chunk);process.stdout.write(chunk);});collect(child.stdout);collect(child.stderr);
 let killTimer;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),5000);},wrapperDeadlineMs);
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);clearTimeout(killTimer);
 const endSha=sha(),metadata={label,pid:child.pid,parentPid:process.pid,startedAt:new Date(started).toISOString(),args,...result,elapsedMs:Date.now()-started,timedOut,startSha,endSha,sourceStable:JSON.stringify(startSha)===JSON.stringify(endSha)};
 writeFileSync(join(evidence,base+'-process.json'),JSON.stringify(metadata,null,2));
 const line='\nPROCESS '+JSON.stringify({code:result.code,signal:result.signal,elapsedMs:metadata.elapsedMs,timedOut,sourceStable:metadata.sourceStable})+'\n';appendFileSync(log,line);process.stdout.write(line);process.exitCode=result.code??1;
}finally{await socket.stop();await db.close();}
