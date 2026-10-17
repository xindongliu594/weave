import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { Semaphore } from './limits.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { listArtifacts } from './sandbox.mjs';
import { teamTaskPlan, stageApprovedTeam } from './handoff.mjs';

async function qualityScenario(mode) {
  const root=await mkdtemp(join(tmpdir(),'quality-handoff-')),artifacts=join(root,'files');
  const {mkdirSync}=await import('node:fs');mkdirSync(artifacts);
  if(mode==='restored-output')writeFileSync(join(artifacts,'result.txt'),'expected');
  const snapshot={agents:[{id:'manager',employeeId:'original-manager',role:'manager',tools:[]},{id:'producer',employeeId:'original-producer',role:'member',tools:['artifact_write','terminal_test']},{id:'reviewer',employeeId:'original-reviewer',role:'member',tools:[]}],tasks:[
    {id:'implement',kind:'implementation',subject:'[quality:implement]',assignee:'producer',objective:'Write a fixture result',dependencies:[],acceptanceCriteria:['result correct'],inScope:['result.txt'],verify:['check-fixture'],outputs:[{path:'result.txt',format:'text'}]},
    {id:'review',kind:'review',subject:'[quality:review]',assignee:'reviewer',objective:'Review the implementation independently',dependencies:['implement'],reviewedTaskId:'implement',acceptanceCriteria:['implementation meets goal']},
  ]};
  if(mode==='manager-review'){
    snapshot.agents=snapshot.agents.filter(employee=>employee.id!=='reviewer');
    snapshot.tasks[1].assignee='manager';snapshot.tasks[1].maxOutputTokens=2048;snapshot.tasks[1].outputs=[];
  }
  for(const task of snapshot.tasks) task.assigneeId='original-'+task.assignee;
  if(mode==='manager-contract') snapshot.tasks[0].handoff={sections:[{key:'usage',requirement:'说明如何核验结果'}]};
  if(mode==='manager-contract-chain') {
    snapshot.agents.push({id:'auditor',employeeId:'auditor',role:'member',tools:[]});
    snapshot.tasks.push({id:'accept',subject:'[quality:accept]',assignee:'auditor',assigneeId:'original-auditor',kind:'work',objective:'Read QA handoff',dependencies:['review'],acceptanceCriteria:['QA reviewed'],outputs:[]});
    for(const task of snapshot.tasks)task.handoff={sections:[{key:'usage',requirement:'说明核验结论'}]};
  }
  for(const employee of snapshot.agents) employee.modelId=employee.role==='manager'?'captain':'same-model';
  const archive=createRunArchive(root,snapshot),steps=new Map(),results=[],requests=[],hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  let approvals=0,host,status,postHandoffRequests=0;const leaked=[];
  // Test executor: only one fixed file and one recognized check. No shell or API.
  const sandbox={root:artifacts,revision:()=>hash(JSON.stringify(listArtifacts(artifacts))),async execute(name,args){
    if(name==='artifact_write'){
      assert.equal(args.path,'result.txt');const target=join(artifacts,args.path),current=existsSync(target)?hash(readFileSync(target)):undefined;
      if(current!==args.expectedSha256)throw Error('FILE_VERSION_CONFLICT');writeFileSync(target,args.content);return{artifacts:listArtifacts(artifacts)};
    }
    assert.equal(name,'terminal_test');assert.equal(args.command,'check-fixture');
    return{exitCode:readFileSync(join(artifacts,'result.txt'),'utf8')==='expected'?0:1,output:'observed fixed check',artifacts:listArtifacts(artifacts)};
  }};
  class Adapter extends LlmAdapter {
    async *stream(options) {
      const assignment=options.messages.filter(m=>m.role==='user').flatMap(m=>m.content).filter(b=>b.type==='text').map(b=>b.text).reverse().find(t=>t.includes('AgentTeams automatic task assignment'))??'';
      const match=/Task: (t\d+).*?\[quality:(\w+)\]/.exec(assignment),attempt=/Attempt id: ([a-f0-9-]+)/.exec(assignment)?.[1];
      requests.push(match?.[2]);
      if(match){
        const [,id,task]=match,key=options.sessionId+':'+attempt,step=steps.get(key)??0;steps.set(key,step+1);
        if(mode==='manager-contract-chain'&&task==='accept') {
          leaked.push(...options.messages.filter(message=>JSON.stringify(message).includes('INDIRECT_DEV_REPORT_MARKER')).map(message=>({role:message.role,source:message.source,content:message.content})));
          assert.ok(!JSON.stringify(options.messages).includes('INDIRECT_DEV_REPORT_MARKER'),'indirect report must not arrive through native assignment text: '+JSON.stringify(options.messages.filter(message=>JSON.stringify(message).includes('INDIRECT_DEV_REPORT_MARKER')).map(message=>({role:message.role,source:message.source,start:message.content?.[0]?.text?.slice(0,120)}))));
          assert.ok(JSON.stringify(options.messages).includes('DIRECT_QA_REPORT_MARKER'));
        }
        if(task==='review'){
          const message=options.messages.findLast(item=>item.source?.sections?.some(section=>section.name==='department:approved-context'));
          const context=JSON.parse(message.source.sections.find(section=>section.name==='department:approved-context').text);
          assert.match(context.completionGuidance,/agent_teams_update_task/);assert.match(context.completionGuidance,/600中文字/);
          assert.equal(context.task.kind,'review');assert.equal(context.task.reviewedTaskId,'implement');
          if(mode==='manager-contract') {
            const source=context.runEvidence.completedAncestors.find(item=>item.taskId==='implement');
            assert.equal(source.employeeReport.sections.usage,'读取 result.txt，并核对真实检查回执');
            assert.equal(source.commands[0].exitCode,0);
          }
          if(mode==='manager-review'){assert.equal(context.task.assignee,'manager');assert.equal(context.task.maxOutputTokens,2048);assert.deepEqual(context.task.outputs,[]);assert.match(context.completionGuidance,/2048 Token/);}
        }
        const update=(status,more={})=>['agent_teams_update_task',{task_id:id,attempt_id:attempt,status,...more}];
        const finish={output:'fixture quality evidence',changedPaths:['result.txt'],acceptanceResults:[{criterion:'result correct',status:mode==='failed-acceptance'?'failed':'passed',evidence:'fixture result'}],commandsRun:[{command:'check-fixture',status:'passed',exitCode:0,evidence:'claimed check'}]};
        if(mode==='restored-output'&&task==='implement'){
          const message=options.messages.findLast(item=>item.source?.sections?.some(section=>section.name==='department:approved-context'));
          const context=JSON.parse(message.source.sections.find(section=>section.name==='department:approved-context').text);
          assert.deepEqual(context.fileChanges.changedPaths,[]);
          assert.equal(context.fileChanges.attemptId,attempt);
          assert.match(context.fileChanges.rule,/恢复.*不.*本轮/);
          finish.changedPaths=context.fileChanges.changedPaths;
        }
        if(mode==='manager-contract') finish.output=JSON.stringify({summary:'已完成',sections:{usage:'读取 result.txt，并核对真实检查回执'},risks:[]});
        if(mode==='manager-contract-chain') finish.output=JSON.stringify({summary:'已完成',sections:{usage:'INDIRECT_DEV_REPORT_MARKER'},risks:[]});
        const actions=[['agent_teams_claim_task',{task_id:id}],update('in_progress')];
        if(task==='implement'){
          if(mode!=='restored-output')actions.push(['artifact_write',{path:'result.txt',content:'expected'}]);
          if(mode!=='forged-command')actions.push(['terminal_test',{command:'check-fixture'}]);
          if(mode==='stale-attempt')actions.push(['agent_teams_update_task',{task_id:id,attempt_id:'stale',status:'completed',...finish}]);
          actions.push(update('completed',finish));
        }else actions.push(mode==='review-revision'?update('failed',{verdict:'needs_revision',findings:[{id:'F1',severity:'high',problem:'fixture issue',requiredFix:'fix result'}]}):update('completed',{verdict:'pass',output:mode==='manager-contract-chain'?JSON.stringify({summary:'已核验',sections:{usage:task==='review'?'DIRECT_QA_REPORT_MARKER':'final reviewed'},risks:[]}):'independent fixture review',...(mode==='manager-contract-chain'?{acceptanceResults:[{criterion:task==='review'?'implementation meets goal':'QA reviewed',status:'passed',evidence:'fixture protocol check'}]}:{})}));
        if(step<actions.length){const [name,args]=actions[step];yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)}};yield{type:'finish',reason:{kind:'tool-calls'}};return;}
        if(mode==='bounded-completion'){postHandoffRequests++;throw Object.assign(Error('No model call remains after the accepted handoff'),{code:'TASK_TURN_LIMIT'});}
      }
      yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'fixture done'}};yield{type:'finish',reason:{kind:'stop'}};
    }
  }
  try{
    host=await createTeamHost({adapter:new Adapter(),provider:'fixture',sessionRoot:join(root,'sessions'),archive,product:{snapshot,sandbox,gate:new Semaphore(2),requestApproval:async()=>{approvals++;}}});
    host.ctx.on('tools/result',(exec,result)=>results.push({name:exec.name,args:exec.arguments,result}));
    const captain=await host.captain({cwd:root,model:'captain'});
    const created=await stageApprovedTeam(host,captain,{name:'quality-'+mode,members:(mode==='manager-review'?snapshot.agents:snapshot.agents.slice(1)).map(a=>({name:a.id,provider:'fixture',model:a.modelId})),tasks:teamTaskPlan(snapshot.tasks)});
    host.bindTaskMapping(created.tasks,created.team_id);assert.equal(requests.length,0);
    await host.call(captain,'agent_teams_approve',{confirmation:'fixed quality fixture'});host.lockPlan();
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      status=await host.call(captain,'agent_teams_status');
      if(['forged-command','failed-acceptance'].includes(mode)?status.tasks[0].status==='failed'&&results.some(r=>r.name==='agent_teams_update_task'&&r.args.status==='completed'):mode==='review-revision'?results.some(r=>r.args.verdict==='needs_revision'):status.deliverable)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    if(status.deliverable) await host.verifyDeliverable();
    if(mode==='bounded-completion'){
      // Let the native member loop settle, including a possible redundant final report.
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(postHandoffRequests,0,'accepted handoff must end its turn before another model request');
    }
    assert.ok(status);assert.equal(status.tasks.length,mode==='manager-contract-chain'?3:2,'no unapproved repair/review task may appear');
    const events=readRun(root,archive.id).events,seals=events.filter(e=>e.type==='handoff/accepted');
    if(mode==='forged-command'||mode==='failed-acceptance'){
      // Observe the final native failure after rejection, rather than a stale pre-tool status poll.
      assert.equal(status.tasks[0].status,'failed');assert.equal(status.tasks[1].status,'pending');assert.equal(status.deliverable,false);assert.equal(seals.length,0);assert.ok(!requests.includes('review'));
      assert.ok(events.some(e=>e.type==='handoff/missing'&&e.data.code==='HANDOFF_NOT_SUBMITTED'));
      assert.ok(results.some(r=>r.args.status==='completed'&&r.result.isError));
      if(mode==='forged-command')assert.equal(approvals,0);
    }else if(mode==='review-revision'){
      assert.equal(seals.length,1);assert.notEqual(status.tasks[1].status,'completed');assert.ok(events.some(e=>e.type==='handoff/blocked'&&e.data.message.includes('REPLAN_REQUIRED')));
    }else{
      assert.equal(status.deliverable,true,JSON.stringify({leaked,requests,tasks:status.tasks.map(task=>({id:task.id,status:task.status})),errors:results.filter(item=>item.result.isError).map(item=>item.result.error)}));assert.equal(seals.length,mode==='manager-contract-chain'?3:2);assert.equal(approvals,1);
      assert.equal(status.tasks[0].kind,'implementation');assert.equal(status.tasks[1].kind,'review');assert.equal(status.tasks[1].verdict,'pass');
      if(mode==='stale-attempt')assert.ok(results.some(r=>r.args.attempt_id==='stale'&&r.result.isError));
    }
  }finally{await host?.close();await rm(root,{recursive:true,force:true});}
}
test('native quality contracts receive actual file and command evidence before independent review',()=>qualityScenario('pass'));
test('native resumed implementation can seal existing outputs with observed empty changes and a fresh check',()=>qualityScenario('restored-output'));
test('native DSH tool accepts contracted employee report and passes its seal to independent reviewer',()=>qualityScenario('manager-contract'));
test('native three-stage handoff does not inject indirect reports through assignment messages',()=>qualityScenario('manager-contract-chain'));
test('model claims of a passed command cannot unlock native quality work',()=>qualityScenario('forged-command'));
test('failed native acceptance rolls back the provisional host seal and leaves downstream pending',()=>qualityScenario('failed-acceptance'));
test('review revision cannot create an unapproved automatic repair graph',()=>qualityScenario('review-revision'));
test('stale attempt cannot publish a seal; the current attempt can still complete',()=>qualityScenario('stale-attempt'));
test('a manager-owned worker review receives compact guidance and completes only through the unchanged native quality gate',()=>qualityScenario('manager-review'));
test('accepted task completion at the call boundary ends the native turn without charging a redundant report or stopping downstream review',()=>qualityScenario('bounded-completion'));
