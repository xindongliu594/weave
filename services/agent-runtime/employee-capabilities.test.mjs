import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createTeamHost} from './host.mjs';
import {EmployeeHostFactory} from './employee-hosts.mjs';
import {createRunArchive,readRun} from './trace-store.mjs';

const require=createRequire(import.meta.url),baseRequire=createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));
const content='needle 公司固定测试方法',sha256=createHash('sha256').update(content).digest('hex');
const doc={documentId:'method',version:1,title:'needle 公司方法',sha256,source:{skillName:'test-method'}};
const chunk={...doc,id:'chunk',content,lineStart:1,lineEnd:1};

async function fixture(run){
 const root=await mkdtemp(join(tmpdir(),'employee-capabilities-'));
 const manifest={format:'document-versions-v2',documents:[doc],agentDocuments:{reader:['method'],other:[]}};
 const archive=createRunArchive(join(root,'runs'),{knowledge:manifest});
 const host=await createTeamHost({adapter:new class extends LlmAdapter{async *stream(){throw Error('no model calls permitted');}}(),provider:'fixture',sessionRoot:join(root,'sessions')});
 const work={taskId:'task',attemptId:'attempt-1'};let failure=false,beforeRead;
 const queryKnowledge=async(_manifest,id,operation,value)=>{if(failure)throw Error('backend unavailable');if(operation==='read')beforeRead?.();if(id!=='reader')return operation==='search'?[]:undefined;return operation==='search'?(value==='needle'?[chunk]:[]):operation==='read'?(value==='chunk'?chunk:undefined):{...doc,content};};
 for(const name of ['filesystem','knowledge_search','knowledge_read'])host.ctx.tools.register(defineTool({name,description:'needle '+name,parameters:{chunkId:{type:'string'}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args,exec)=>{
  if(name==='knowledge_read')archive.append('knowledge/citation',{operation:'read',agentId:'reader',sources:[{...doc,chunkId:'chunk'}]},{sessionId:exec.agent.id});return chunk;
 }}));
 const options={coordinator:host.ctx,provider:'fixture',sessionRoot:join(root,'sessions'),archive,skillManifest:manifest,queryKnowledge,activeWork:()=>work,
  identify:agent=>({id:agent.options.model,tools:agent.options.model==='reader'?['filesystem','knowledge_search','knowledge_read']:['filesystem']}),
  loadPlugin:name=>import(pathToFileURL(baseRequire.resolve(name)).href)};
 let factory=new EmployeeHostFactory(options);
 try{
  const reader=await factory.createAgent(host.ctx,{sessionId:randomUUID(),meta:{cwd:root},agentOptions:{provider:'fixture',model:'reader'}});
  const other=await factory.createAgent(host.ctx,{sessionId:randomUUID(),meta:{cwd:root},agentOptions:{provider:'fixture',model:'other'}});
  let ctx=factory.list().find(slot=>slot.sessionId===reader.agent.id).ctx,agent=reader.agent;
  const call=(name,args,who=agent)=>ctx.tools.execute({name,arguments:args,callId:randomUUID(),agent:who,signal:AbortSignal.timeout(3000)});
  const otherContext=factory.list().find(slot=>slot.sessionId===other.agent.id).ctx;
  const otherCall=(name,args)=>otherContext.tools.execute({name,arguments:args,callId:randomUUID(),agent:other.agent,signal:AbortSignal.timeout(3000)});
  await run({archive,manifest,work,call,other,otherCall,coordinator:host.ctx,agent,employeeContext:()=>ctx,onRead:fn=>{beforeRead=fn;},fail:()=>{failure=true;},resume:async()=>{const id=agent.id;await factory.close();factory=new EmployeeHostFactory(options);agent=(await factory.resume(host.ctx,{resumeSessionId:id,agentOptions:{provider:'fixture',model:'reader'}})).agent;ctx=factory.list()[0].ctx;}});
 }finally{await factory.close();await host.close();await rm(root,{recursive:true,force:true});}
}

test('employee discovers only authorized knowledge, methods and tools without loading all bodies', {timeout:15000},()=>fixture(async({call,other,otherCall,fail})=>{
 const found=await call('capability_search',{query:'needle'});assert.equal(found.isError,false,JSON.stringify(found));
 assert.equal(found.value.knowledge.length,1);assert.equal(found.value.skills.length,1);assert.equal(found.value.tools.length,3);
 assert.ok(!JSON.stringify(found.value.skills).includes(content));
 const forged=await call('capability_search',{query:'needle'},other.agent);assert.equal(forged.isError,true);
 const own=await otherCall('capability_search',{query:'needle'});assert.deepEqual(own.value.knowledge,[]);assert.deepEqual(own.value.skills,[]);assert.equal(own.value.tools.length,1);
 assert.equal((await otherCall('capability_use',{kind:'knowledge',id:'chunk',note:'无权读取'})).isError,true);
 const empty=await call('capability_search',{query:'absent'});assert.equal(empty.isError,false);assert.deepEqual(empty.value,{knowledge:[],skills:[],tools:[]});
 fail();assert.equal((await call('capability_search',{query:'needle'})).isError,true,'backend errors are not no-match results');
}));

test('tool discovery includes fixed unknown-effect metadata and excludes changed coordinator definitions', {timeout:15000},()=>fixture(async({call,coordinator})=>{
 const found=await call('capability_search',{query:'needle'});
 const tool=found.value.tools.find(item=>item.name==='filesystem');
 assert.deepEqual(tool.effectContract,{status:'unreviewed',effect:'unknown',definitionSha256:tool.effectContract?.definitionSha256});
 assert.match(tool.effectContract.definitionSha256,/^[a-f0-9]{64}$/);
 coordinator.tools.get('filesystem').execute=async()=>({unexpected:true});
 const changed=await call('capability_search',{query:'needle'});
 assert.equal(changed.isError,false,JSON.stringify(changed));
 assert.equal(changed.value.tools.some(item=>item.name==='filesystem'),false);
}));

test('tool discovery does not advertise scoped shadows as granted capabilities', {timeout:15000},()=>fixture(async({call,agent})=>{
 agent.ctx.tools.register(defineTool({name:'filesystem',description:'needle scoped shadow',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>null}));
 const changed=await call('capability_search',{query:'needle'});
 assert.equal(changed.isError,false,JSON.stringify(changed));
 assert.equal(changed.value.tools.some(item=>item.name==='filesystem'),false);
}));

test('adoption requires actual reads, remains pending and deduplicates on cold resume', {timeout:15000},()=>fixture(async({call,archive,resume,work})=>{
 const use={kind:'knowledge',id:'chunk',note:'采用其中的测试步骤'};
 assert.equal((await call('capability_use',use)).isError,true,'a search hit alone is not adoption');
 await call('knowledge_read',{chunkId:'chunk'});
 const first=await call('capability_use',use);assert.equal(first.isError,false,JSON.stringify(first));assert.equal(first.value.status,'recorded');assert.equal(first.value.validation,'pending');
 await resume();const again=await call('capability_use',{...use,note:'再次采用'});assert.equal(again.value.status,'already-recorded');
 const found=await call('capability_search',{query:'needle'}),name=found.value.skills[0].name;
 assert.equal((await call('capability_use',{kind:'skill',id:name,note:'采用方法'})).isError,true);
 assert.equal((await call('skill',{name})).isError,false);
 assert.equal((await call('capability_use',{kind:'skill',id:name,note:'按方法核对'})).isError,false);
 work.attemptId='attempt-2';assert.equal((await call('capability_use',use)).value.status,'recorded');
 const events=readRun(join(archive.dir,'..'),archive.id).events;assert.equal(events.filter(e=>e.type==='capability/adopted').length,3);
 const {acceptedAdoptions}=await import('./employee-capabilities.mjs');
 const accepted=acceptedAdoptions(events,[{taskId:'task',attemptId:'attempt-2'}]);assert.equal(accepted.length,1);assert.equal(accepted[0].attemptId,'attempt-2');
 assert.deepEqual(acceptedAdoptions(events,[{taskId:'task',attemptId:'failed-or-unknown'}]),[]);
}));

test('adoption cannot cross a task attempt change while source verification is pending',{timeout:15000},()=>fixture(async({call,archive,work,onRead})=>{
 await call('knowledge_read',{chunkId:'chunk'});onRead(()=>{work.attemptId='new-attempt';});
 const result=await call('capability_use',{kind:'knowledge',id:'chunk',note:'旧尝试采用'});assert.equal(result.isError,true);
 assert.equal(readRun(join(archive.dir,'..'),archive.id).events.filter(e=>e.type==='capability/adopted').length,0);
}));
