import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {RuntimeSupervisor} from './supervisor.mjs';
import {createRunArchive,readRun} from './trace-store.mjs';

test('normal employee state persists each assignment and phase, not unchanged timer ticks',t=>{
 const root=mkdtempSync(join(tmpdir(),'supervisor-durable-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const archive=createRunArchive(root,{projectId:'state-fixture'});
 let now=0;const supervisor=new RuntimeSupervisor({archive,now:()=>now});
 const taskId=randomUUID(),sessionId=randomUUID(),firstAttempt=randomUUID(),nextAttempt=randomUUID();
 supervisor.observe({type:'run/task-mapping',data:{tasks:[{task_id:taskId,seed_id:'verify'}]}});
 const status={tasks:[{id:taskId,assignee:'qa',status:'in_progress',attempt_id:firstAttempt}],members:[{member_id:sessionId,name:'qa',status:'working'}]};
 supervisor.tick(status);
 for(let n=0;n<100;n++){now+=10;supervisor.tick(status);}
 const states=()=>readRun(root,archive.id).events.filter(event=>event.type==='runtime/status');
 assert.equal(states().length,1,'unchanged observations must not grow the archive');
 status.tasks[0].attempt_id=nextAttempt;supervisor.tick(status);
 assert.equal(states().length,2,'a new attempt must persist even when the task and phase are unchanged');
 assert.equal(states().at(-1).data.employees[0].attemptId,nextAttempt);
 const leave=supervisor.enter(sessionId,'waiting_approval');supervisor.tick(status);
 now+=1000;supervisor.tick(status);leave();supervisor.tick(status);
 const query=`import {readRun} from ${JSON.stringify(new URL('./trace-store.mjs',import.meta.url).href)};const run=readRun(process.argv[1],process.argv[2]);console.log(JSON.stringify({integrity:run.integrity,states:run.events.filter(e=>e.type==='runtime/status').map(e=>e.data.employees)}));`;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',query,root,archive.id],{encoding:'utf8',timeout:10000});
 assert.equal(child.status,0,child.stderr);
 const restored=JSON.parse(child.stdout);assert.equal(restored.integrity,'ok');
 assert.deepEqual(restored.states.map(rows=>rows[0].phase),['working','working','waiting_approval','working']);
 assert.deepEqual(restored.states.map(rows=>rows[0].attemptId),[firstAttempt,nextAttempt,nextAttempt,nextAttempt]);
 assert.ok(restored.states.every(rows=>rows[0].taskId==='verify'&&rows[0].agentId==='qa'));
 assert.equal(new RuntimeSupervisor({archive}).sessions.size,0,'historical waits are evidence, not a live pending operation');
 status.tasks[0].status='completed';supervisor.tick(status);supervisor.tick(status);
 assert.deepEqual(states().at(-1).data.employees,[]);assert.equal(states().length,5);
});
