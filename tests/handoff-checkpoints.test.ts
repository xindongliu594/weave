import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectArtifact } from '../services/agent-runtime/handoff.mjs';
import { resumeHandoff } from '../apps/api/src/handoff-checkpoints.ts';
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
