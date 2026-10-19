import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCheckpointContext, recoveryContext, readRecoveryContext } from './checkpoint-context.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { HandoffGate, inspectArtifact } from './handoff.mjs';

test('recovery retains host evidence, bounds bootstrap and pages full own history without exposing sibling/private records',async()=>{
 const root=await mkdtemp(join(tmpdir(),'checkpoint-context-'));
 try{
  const snapshot={projectId:'p',tasks:[{id:'build',dependencies:[],outputs:[{path:'code.txt'}]},{id:'review',dependencies:['build'],inputs:[{path:'code.txt',producerTaskId:'build'}],outputs:[{path:'notes.txt'}],verify:['node --test']},{id:'sibling',dependencies:[]}]};
  const archive=createRunArchive(root,snapshot),files=join(archive.dir,'artifacts');await mkdir(files);await writeFile(join(files,'code.txt'),'verified code');await writeFile(join(files,'notes.txt'),'unfinished review');
  archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'build'},{task_id:'t2',seed_id:'review'},{task_id:'t3',seed_id:'sibling'}]});
  archive.append('model/request',{}, {sessionId:'worker',taskId:'t1'});
  archive.append('session/assistant/message',{message:{content:[{type:'text',text:'PRIVATE_UPSTREAM_KNOWLEDGE'}]}},{sessionId:'worker'});
  archive.append('model/request',{}, {sessionId:'worker',taskId:'t2'});
  const long='continuation detail '.repeat(1500)+' END_OF_HISTORY';
  archive.append('session/assistant/message',{message:{content:[{type:'thinking',text:'HIDDEN_REASONING'},{type:'text',text:long}]}},{sessionId:'worker'});
  archive.append('session/compaction/summary',{summary:'DECISION: keep the agreed API contract; next verify error cases.',rawOutput:[{type:'thinking',text:'HIDDEN_REASONING'}],shadowedSeqs:[1,2]},{sessionId:'worker'});
  archive.append('handoff/command-observed',{taskId:'review',command:'node --test',exitCode:1,workspaceRevision:'v1'});
  archive.append('handoff/command-observed',{taskId:'review',command:'node --test',exitCode:0,workspaceRevision:'v2',evidence:{runId:archive.id,nodeTests:{status:'available',format:'spec',tests:8,suites:0,pass:8,fail:0,cancelled:0,skipped:0,todo:0},output:{text:'PRIVATE_COMMAND_BODY_NOT_BOOTSTRAP'}}});
  archive.append('model/error',{message:'connection closed'},{sessionId:'worker',taskId:'t2'});
  const completed=new Map([['build',{status:'completed',attemptId:'a',output:'Implemented the agreed interface'}]]);
  const states=new Map([...completed,['review',{status:'in_progress'}]]);
  snapshot.handoffCheckpoints=[{taskId:'build',attemptId:'a',outputs:[inspectArtifact(files,{path:'code.txt'})]}];
  snapshot.recovery=buildCheckpointContext(snapshot,readRun(root,archive.id).events,states,completed,files,archive.id);
  assert.equal(snapshot.recovery.files.find(file=>file.path==='code.txt').state,'accepted');
  assert.equal(snapshot.recovery.files.find(file=>file.path==='notes.txt').state,'unverified');
  const brief=recoveryContext(snapshot,'review');assert.equal(brief.current.commands[0].exitCode,1);assert.match(brief.current.errors[0].message,/connection closed/);
  assert.deepEqual(brief.dependencies[0].read,{tool:'recovery_read',arguments:{taskId:'build'}});
  const passing=brief.current.commands.at(-1);assert.equal(passing.runId,archive.id);assert.equal(passing.workspaceRevision,'v2');
  assert.deepEqual(passing.nodeTests,{status:'available',format:'spec',tests:8,suites:0,pass:8,fail:0,cancelled:0,skipped:0,todo:0});
  assert.equal(brief.current.status,'restart');assert.equal(brief.current.lastMessage,long.slice(0,800));
  assert.ok(!JSON.stringify(brief).includes('PRIVATE_COMMAND_BODY_NOT_BOOTSTRAP'));assert.ok(!JSON.stringify(brief).includes('PRIVATE_UPSTREAM_KNOWLEDGE'));
  assert.match(brief.rule,/旧审批不沿用/);assert.match(brief.rule,/stepEvidence 明确核验为 reusable 时可继承/);assert.match(brief.rule,/task_id.*runtimeTaskId/);assert.match(brief.rule,/attempt_id.*attemptId/);
  assert.match(brief.rule,/无需从头重写/);
  // Even a successful historical receipt and a model's copied declaration do
  // not populate the fresh attempt's host command observations or accept it.
  const freshGate=new HandoffGate({snapshot,sandbox:{root:files},archive:{id:'new-run',append(){}}});
  assert.throws(()=>freshGate.prepare('review','fresh-attempt',{commandsRun:[passing]}),/UNVERIFIED_COMMAND/);
  assert.equal(freshGate.accepted.has('review'),false);assert.equal(snapshot.recovery.completed.some(row=>row.taskId==='review'),false);
  assert.match(brief.current.workSummary,/DECISION/);
  assert.ok(JSON.stringify(brief).length<6000);assert.equal(brief.dependencies[0].output,'Implemented the agreed interface');
  const target=join(root,'new-run');
  const upstream=readRecoveryContext(snapshot,target,'review',{taskId:'build'});assert.equal(JSON.stringify(upstream).includes('PRIVATE_UPSTREAM_KNOWLEDGE'),false);
  assert.match(upstream.text,/Implemented the agreed interface/);
  assert.throws(()=>freshGate.beforeFile('review','fresh-attempt','filesystem',{path:'.agent-teams/run-new/inbox/worker.jsonl'}),/UNDECLARED_INPUT/);
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

test('historical command bootstrap stays within its 8KB cap with long Unicode history and never includes arbitrary evidence payloads',()=>{
 const task={id:'qa',dependencies:[],outputs:Array.from({length:20},(_,i)=>({path:'file-'+i+'.txt'}))};
 const command={runId:'source-run',seq:123,command:'node --test test.mjs',exitCode:0,workspaceRevision:'f'.repeat(64),evidence:{nodeTests:{status:'available',format:'spec',tests:8,pass:8,fail:0,skipped:0,unexpectedPrivate:'PRIVATE_IGNORED'},output:{text:'PRIVATE_IGNORED'}}};
 const snapshot={policy:{contextBytes:192000},tasks:[task],recovery:{sourceRunId:'source-run',completed:[],files:task.outputs.map(file=>({...file,state:'unverified',sha256:'f'.repeat(64)})),nodes:{qa:{taskId:'qa',status:'restart',previousStatus:'failed',historyRunId:'source-run',output:'恢复'.repeat(3000),lastMessage:'末次员工消息'.repeat(3000),workSummary:'工作摘要'.repeat(3000),citations:[],commands:Array.from({length:4},()=>command),errors:[{runId:'source-run',seq:124,message:'TASK_NOT_ACTIVE: '+'错误'.repeat(1000)}]}}}};
 const original=JSON.stringify(snapshot),context=recoveryContext(snapshot,'qa');
 assert.ok(Buffer.byteLength(JSON.stringify(context))<=8000);assert.equal(context.current.status,'restart');assert.equal(JSON.stringify(snapshot),original);
 assert.ok(!JSON.stringify(context).includes('PRIVATE_IGNORED'));assert.ok(!Object.hasOwn(context,'accepted'));
 // A normal-sized failed-task history retains the latest native error/message
 // alongside the exact bounded host test metadata.
 snapshot.recovery.nodes.qa.output='BUDGET_CONTEXT_LIMIT';snapshot.recovery.nodes.qa.lastMessage='Both verify commands passed; submitting the task.';snapshot.recovery.nodes.qa.workSummary='';
 snapshot.recovery.nodes.qa.errors[0].message='TASK_NOT_ACTIVE: 工具仅能用于当前分派的任务';
 const concise=recoveryContext(snapshot,'qa');assert.equal(concise.current.errors[0].message,snapshot.recovery.nodes.qa.errors[0].message);
 assert.equal(concise.current.lastMessage,snapshot.recovery.nodes.qa.lastMessage);assert.equal(concise.current.commands.at(-1).nodeTests.pass,8);
});

test('recovery keeps paired own tool progress and authorized locators without replaying private tool bodies',async()=>{
 const root=await mkdtemp(join(tmpdir(),'recovery-progress-'));
 try {
  const snapshot={policy:{contextBytes:64000},tasks:[{id:'qa',assignee:'qa',dependencies:[],inputs:[{path:'cases.md'}],outputs:[]}],
   knowledge:{format:'document-versions-v2',agentDocuments:{qa:['doc']},documents:[{documentId:'doc',version:1}]}};
  let seq=0;const events=[],add=(type,data,sessionId='worker',callId)=>events.push({seq:++seq,type,data,sessionId,callId});
  add('model/request',{taskId:'qa'});
  add('tool/start',{name:'agent_teams_claim_task',arguments:{task_id:'old-runtime'}},'worker','claim');
  add('tool/result',{name:'agent_teams_claim_task',result:{value:{private:'PRIVATE_BODY'}}},'worker','claim');
  add('tool/start',{name:'knowledge_search',arguments:{query:'PRIVATE_QUERY'}},'worker','search');
  add('tool/result',{name:'knowledge_search',result:{value:[]}},'worker','search');
  add('knowledge/citation',{sources:[{documentId:'doc',version:1,chunkId:'chunk',sha256:'f'.repeat(64)}]});
  add('tool/start',{name:'knowledge_read',arguments:{chunkId:'chunk'}},'worker','read');
  add('tool/result',{name:'knowledge_read',result:{value:{content:'PRIVATE_BODY'}}},'worker','read');
  add('tool/start',{name:'filesystem',arguments:{path:'cases.md'}},'worker','file');
  add('tool/result',{name:'filesystem',result:{value:{content:'PRIVATE_BODY'}}},'sibling','file');
  add('tool/start',{name:'terminal',arguments:{command:'PRIVATE_COMMAND'}},'worker','pending');
  snapshot.recovery=buildCheckpointContext(snapshot,events,new Map(),new Map(),root,'source');
  const brief=recoveryContext(snapshot,'qa');
  assert.deepEqual(brief.current.recentOperations.map(r=>[r.name,r.status]),[
   ['agent_teams_claim_task','succeeded'],['knowledge_search','succeeded'],['knowledge_read','succeeded'],['filesystem','unknown'],['terminal','unknown']]);
  assert.equal(brief.current.recentOperations[2].chunkId,'chunk');
  assert.equal(brief.current.recentOperations[3].path,'cases.md');
  for(const marker of ['PRIVATE_BODY','PRIVATE_QUERY','PRIVATE_COMMAND','old-runtime'])assert.ok(!JSON.stringify(brief).includes(marker));
  assert.match(brief.rule,/重新认领/);assert.match(brief.rule,/unknown/);
  const again=buildCheckpointContext(snapshot,[],new Map(),new Map(),root,'child');
  assert.equal(again.nodes.qa.recentOperations.length,5,'no duplication on another restart');
  snapshot.knowledge.agentDocuments.qa=[];
  snapshot.recovery=buildCheckpointContext(snapshot,[],new Map(),new Map(),root,'third');
  assert.ok(!JSON.stringify(recoveryContext(snapshot,'qa').current.recentOperations).includes('chunk'),'revoked locator not retained');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('explicit unknown mutation outcome outranks the subsequent native error and only matching host confirmation clears it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'recovery-unknown-'));
 try{
  const snapshot={tasks:[{id:'qa',dependencies:[],outputs:[{path:'report.md'}]}]};
  const events=[{seq:1,type:'model/request',sessionId:'worker',data:{taskId:'qa'}},
   {seq:2,type:'tool/start',sessionId:'worker',callId:'write',data:{name:'artifact_write',arguments:{path:'report.md'}}},
   {seq:3,type:'runtime/outcome-unknown',sessionId:'worker',callId:'write',data:{name:'artifact_write',callId:'write'}},
   {seq:4,type:'tool/result',sessionId:'worker',callId:'write',data:{name:'artifact_write',result:{isError:true,error:{message:'Outcome lost'}}}}];
  const state=()=>buildCheckpointContext(snapshot,events,new Map(),new Map(),root,'source').nodes.qa.recentOperations[0].status;
  assert.equal(state(),'unknown');
  events.push({seq:5,type:'runtime/operation-finished',sessionId:'sibling',callId:'write',data:{name:'artifact_write'}});
  assert.equal(state(),'unknown','another session cannot confirm this side effect');
  events.push({seq:6,type:'runtime/operation-finished',sessionId:'worker',callId:'write',data:{name:'artifact_write'}},
   {seq:7,type:'tool/result',sessionId:'worker',callId:'write',data:{name:'artifact_write',result:{value:{path:'report.md'}}}});
  assert.equal(state(),'succeeded');
 }finally{await rm(root,{recursive:true,force:true});}
});
