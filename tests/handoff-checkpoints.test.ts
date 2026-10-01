import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectArtifact } from '../services/agent-runtime/handoff.mjs';
import { resumeHandoff, completedTasks } from '../apps/api/src/handoff-checkpoints.ts';
test('resume uses exact accepted attempt and rejects missing evidence or a changed restored file',async()=>{
  const root=await mkdtemp(join(tmpdir(),'resume-handoff-'));
  try {
    await writeFile(join(root,'data.json'),'{"count":2}');
    const snapshot={agents:[],tasks:[{id:'produce',dependencies:[],outputs:[{path:'data.json'}]},{id:'consume',dependencies:['produce'],inputs:[{path:'data.json',producerTaskId:'produce'}]}]};
    const completed=new Map([['produce',{attempt_id:'a'}]]),record={taskId:'produce',attemptId:'a',outputs:[inspectArtifact(root,{path:'data.json'})]},events=[{type:'handoff/accepted',data:record}];
    assert.equal(resumeHandoff(snapshot,events,completed,root)[0].outputs[0].sha256,record.outputs[0].sha256);
    assert.throws(()=>resumeHandoff(snapshot,[...events,{type:'quality/rework-created',data:{}}],completed,root),/完整重试/);
    assert.throws(()=>resumeHandoff(snapshot,[],completed,root),/缺少宿主/);
    assert.throws(()=>resumeHandoff(snapshot,events,new Map([['produce',{attempt_id:'b'}]]),root),/缺少宿主/);
    await writeFile(join(root,'data.json'),'{"count":3}');assert.throws(()=>resumeHandoff(snapshot,events,completed,root),/已变化/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('rework recovery uses the newest mapping and requires independent acceptance of the complete pair',async()=>{
 const root=await mkdtemp(join(tmpdir(),'resume-rework-'));
 try{
  await writeFile(join(root,'data.json'),'{"count":2}');
  const snapshot={agents:[],tasks:[{id:'build',kind:'implementation',dependencies:[],inputs:[],outputs:[{path:'data.json',format:'json',expectedValues:{count:2}}],inScope:['data.json'],verify:['check']},{id:'review',kind:'review',reviewedTaskId:'build',dependencies:['build'],inputs:[{path:'data.json',producerTaskId:'build'}],outputs:[],maxReworkRounds:1},{id:'deliver',dependencies:['review'],inputs:[{path:'data.json',producerTaskId:'build'}]}]};
  const output=inspectArtifact(root,{path:'data.json'});
  const events:any[]=[{type:'run/task-mapping',data:{tasks:[{task_id:'t1',seed_id:'build'},{task_id:'t2',seed_id:'review'}]}},{type:'quality/rework-created',data:{reviewTaskId:'review',round:1}},{type:'run/task-mapping',data:{tasks:[{task_id:'t3',seed_id:'build'},{task_id:'t4',seed_id:'review'}]}},{type:'handoff/accepted',data:{taskId:'build',attemptId:'repair',outputs:[output]}},{type:'handoff/accepted',data:{taskId:'review',attemptId:'recheck',outputs:[]}},{type:'quality/reviewed',data:{taskId:'review',attemptId:'recheck',verdict:'pass'}},{type:'team/checkpoint',data:{tasks:[{id:'t1',status:'completed',attemptId:'initial'},{id:'t2',status:'failed'},{id:'t3',status:'completed',attemptId:'repair'},{id:'t4',status:'completed',attemptId:'recheck',verdict:'pass'}]}}];
  const done=completedTasks(events);assert.equal(done.get('build').attemptId,'repair');assert.equal(resumeHandoff(snapshot,events,done,root).length,2);
  events.at(-1).data.tasks.at(-1).status='in_progress';assert.throws(()=>resumeHandoff(snapshot,events,completedTasks(events),root),/尚未形成独立验收/);
  events.at(-1).data.tasks.at(-1).status='completed';events.at(-1).data.tasks[2].status='in_progress';assert.equal(completedTasks(events).has('build'),false);
  assert.throws(()=>resumeHandoff(snapshot,events,completedTasks(events),root),/尚未形成独立验收/);
  events.at(-1).data.tasks[2].status='completed';await writeFile(join(root,'data.json'),'{"count":3}');assert.throws(()=>resumeHandoff(snapshot,events,completedTasks(events),root),/ACCEPTANCE_FAILED|已变化/);
 }finally{await rm(root,{recursive:true,force:true});}
});
