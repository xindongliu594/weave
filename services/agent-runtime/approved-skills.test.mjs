import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { EmployeeHostFactory } from './employee-hosts.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';

const require=createRequire(import.meta.url),baseRequire=createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));
const content='固定方法原文：先核对版本，再执行获批测试。';
const sha256=createHash('sha256').update(content).digest('hex');
const manifest={format:'document-versions-v2',documents:[],agentDocuments:{},runInputs:[{documentId:'run:source:method',title:'固定测试方法',skillName:'fixed-method',agentIds:['reader'],chunks:[{documentId:'run:source:method',version:1,content,sha256}]}]};
const employee=id=>({id,tools:['knowledge_search','knowledge_read']});

test('official Skill catalog and loader isolate employees, audit reads and retain fixed content on cold resume', {timeout:15000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'approved-skills-')),requests=[];
  const archive=createRunArchive(join(root,'runs'),{knowledge:manifest});
  const adapter=new class extends LlmAdapter { async *stream(options){requests.push(options);yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'local test complete'}};yield {type:'finish',reason:{kind:'stop'}};} }();
  const host=await createTeamHost({adapter,provider:'fixture',sessionRoot:join(root,'sessions')});
  const factoryOptions={coordinator:host.ctx,provider:'fixture',sessionRoot:join(root,'sessions'),archive,
    identify:agent=>employee(agent.options.model),skillManifest:manifest,
    loadPlugin:name=>import(pathToFileURL(baseRequire.resolve(name)).href)};
  let factory=new EmployeeHostFactory(factoryOptions);
  try{
    const reader=await factory.createAgent(host.ctx,{sessionId:randomUUID(),meta:{cwd:root},agentOptions:{provider:'fixture',model:'reader'}});
    const other=await factory.createAgent(host.ctx,{sessionId:randomUUID(),meta:{cwd:root},agentOptions:{provider:'fixture',model:'other'}});
    reader.agent.followup(createUserMessage({content:[{type:'text',text:'检查资料'}],source:{kind:'user'}}));
    await reader.agent.whenIdle();
    const request=JSON.stringify(requests[0]);
    assert.ok(request.includes('fixed-method'));
    assert.ok(!request.includes(content),'catalog injects summaries, not complete method bodies');
    const readerContext=factory.list().find(slot=>slot.sessionId===reader.agent.id).ctx;
    const otherContext=factory.list().find(slot=>slot.sessionId===other.agent.id).ctx;
    assert.equal(otherContext.tools.get('skill'),undefined);
    const result=await readerContext.tools.execute({name:'skill',arguments:{name:'fixed-method'},callId:'read-method',agent:reader.agent,signal:AbortSignal.timeout(1000)});
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.equal(result.value.content,content);
    const forged=await readerContext.tools.execute({name:'skill',arguments:{name:'fixed-method'},callId:'forged-reader',agent:other.agent,signal:AbortSignal.timeout(1000)});
    assert.equal(forged.isError,true);
    const events=readRun(join(root,'runs'),archive.id).events;
    assert.equal(events.filter(event=>event.type==='skill/loaded').length,1);
    assert.equal(events.find(event=>event.type==='skill/loaded').data.sha256,sha256);
    const savedId=reader.agent.id;
    await factory.close();
    const original=readRun(join(root,'runs'),archive.id).snapshot.knowledge;
    const current=structuredClone(manifest);current.runInputs[0].chunks[0].content='updated current method';
    factory=new EmployeeHostFactory({...factoryOptions,skillManifest:original});
    const resumed=await factory.resume(host.ctx,{resumeSessionId:savedId,agentOptions:{provider:'fixture',model:'reader'}});
    const resumedContext=factory.list()[0].ctx;
    const resumedResult=await resumedContext.tools.execute({name:'skill',arguments:{name:'fixed-method'},callId:'resumed-read',agent:resumed.agent,signal:AbortSignal.timeout(1000)});
    assert.equal(resumedResult.value.content,content);
    assert.equal(requests.length,1,'registry reads and restore do not call a model');
  }finally{await factory.close();await host.close();assert.ok(root.startsWith(join(tmpdir(),'approved-skills-')));await rm(root,{recursive:true,force:true});}
});
