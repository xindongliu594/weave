import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCheckpointContext, recoveryContext, readRecoveryContext } from './checkpoint-context.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { inspectArtifact } from './handoff.mjs';

test('recovery retains host evidence, bounds bootstrap and pages full own history without exposing sibling/private records',async()=>{
 const root=await mkdtemp(join(tmpdir(),'checkpoint-context-'));
 try{
  const snapshot={projectId:'p',tasks:[{id:'build',dependencies:[],outputs:[{path:'code.txt'}]},{id:'review',dependencies:['build'],inputs:[{path:'code.txt',producerTaskId:'build'}],outputs:[{path:'notes.txt'}]},{id:'sibling',dependencies:[]}]};
  const archive=createRunArchive(root,snapshot),files=join(archive.dir,'artifacts');await mkdir(files);await writeFile(join(files,'code.txt'),'verified code');await writeFile(join(files,'notes.txt'),'unfinished review');
  archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'build'},{task_id:'t2',seed_id:'review'},{task_id:'t3',seed_id:'sibling'}]});
  archive.append('model/request',{}, {sessionId:'worker',taskId:'t1'});
  archive.append('session/assistant/message',{message:{content:[{type:'text',text:'PRIVATE_UPSTREAM_KNOWLEDGE'}]}},{sessionId:'worker'});
  archive.append('model/request',{}, {sessionId:'worker',taskId:'t2'});
  const long='continuation detail '.repeat(1500)+' END_OF_HISTORY';
  archive.append('session/assistant/message',{message:{content:[{type:'thinking',text:'HIDDEN_REASONING'},{type:'text',text:long}]}},{sessionId:'worker'});
  archive.append('session/compaction/summary',{summary:'DECISION: keep the agreed API contract; next verify error cases.',rawOutput:[{type:'thinking',text:'HIDDEN_REASONING'}],shadowedSeqs:[1,2]},{sessionId:'worker'});
  archive.append('handoff/command-observed',{taskId:'review',command:'node --test',exitCode:1,workspaceRevision:'v1'});
  archive.append('model/error',{message:'connection closed'},{sessionId:'worker',taskId:'t2'});
  const completed=new Map([['build',{status:'completed',attemptId:'a',output:'Implemented the agreed interface'}]]);
  const states=new Map([...completed,['review',{status:'in_progress'}]]);
  snapshot.handoffCheckpoints=[{taskId:'build',attemptId:'a',outputs:[inspectArtifact(files,{path:'code.txt'})]}];
  snapshot.recovery=buildCheckpointContext(snapshot,readRun(root,archive.id).events,states,completed,files,archive.id);
  assert.equal(snapshot.recovery.files.find(file=>file.path==='code.txt').state,'accepted');
  assert.equal(snapshot.recovery.files.find(file=>file.path==='notes.txt').state,'unverified');
  const brief=recoveryContext(snapshot,'review');assert.equal(brief.current.commands[0].exitCode,1);assert.match(brief.current.errors[0].message,/connection closed/);
  assert.match(brief.current.workSummary,/DECISION/);
  assert.ok(JSON.stringify(brief).length<6000);assert.equal(brief.dependencies[0].output,'Implemented the agreed interface');
  const target=join(root,'new-run');
  const upstream=readRecoveryContext(snapshot,target,'review',{taskId:'build'});assert.equal(JSON.stringify(upstream).includes('PRIVATE_UPSTREAM_KNOWLEDGE'),false);
  assert.throws(()=>readRecoveryContext(snapshot,target,'review',{taskId:'sibling'}),/DENIED/);
  const unrelated=createRunArchive(root,{projectId:'other'});
  assert.throws(()=>readRecoveryContext(snapshot,target,'review',{cursor:JSON.stringify({runId:unrelated.id,after:0})}),/DENIED/);
  let cursor='',offset=0,result='',pages=0;
  do{const page=readRecoveryContext(snapshot,target,'review',{cursor,offset});result+=page.text??'';cursor=page.nextCursor;offset=page.nextOffset;assert.ok((page.text?.length??0)<=8000);pages++;}while(cursor&&pages<20);
  assert.ok(pages>3);assert.ok(result.includes('END_OF_HISTORY'));assert.ok(!result.includes('HIDDEN_REASONING'));assert.ok(!result.includes('PRIVATE_UPSTREAM_KNOWLEDGE'));
  // A second recovery can still traverse the first run even with no new work.
  const second=createRunArchive(root,snapshot);const next={...snapshot,recovery:buildCheckpointContext(snapshot,[],new Map(),completed,files,second.id)};
  const firstPage=readRecoveryContext(next,join(root,'third-run'),'review');assert.ok(firstPage.nextCursor?.includes(archive.id));
  assert.match(readRecoveryContext(next,join(root,'third-run'),'review',{cursor:firstPage.nextCursor}).text,/continuation detail/);
 }finally{await rm(root,{recursive:true,force:true});}
});
