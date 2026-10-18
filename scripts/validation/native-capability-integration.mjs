// Real native package + employee Host + handoff integration; zero model calls.
// This is component evidence, never a substitute for paid employee acceptance.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {nativeManifestId} from '../../services/agent-runtime/native-capabilities.mjs';
import {createTeamHost} from '../../services/agent-runtime/host.mjs';
import {EmployeeHostFactory} from '../../services/agent-runtime/employee-hosts.mjs';
import {installNativePluginTools} from '../../services/agent-runtime/native-plugin-tools.mjs';
import {HandoffGate,workspaceRevision} from '../../services/agent-runtime/handoff.mjs';
import {Semaphore} from '../../services/agent-runtime/limits.mjs';
import {createRunArchive} from '../../services/agent-runtime/trace-store.mjs';
import {listArtifacts} from '../../services/agent-runtime/sandbox.mjs';
import {runNativeTool} from '../../apps/desktop/native-plugin-worker.cjs';
const req=createRequire(resolve('services/agent-runtime/package.json')),base=createRequire(req.resolve('@deepseek-ai/dsh-base/package.json'));
const {LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href),AdmZip=req('../../node_modules/adm-zip');
const packageDir=resolve(process.argv[2]),out=resolve(process.argv[3]);mkdirSync(out,{recursive:true});
const manifest=JSON.parse(readFileSync(join(packageDir,'manifest.json'),'utf8')),id=nativeManifestId(manifest),compressed=readFileSync(join(packageDir,'bundle.gz')),metadata=readFileSync(join(packageDir,'package.json'));
const root=join(out,'artifacts'),temporary=join(out,'tmp');mkdirSync(root);mkdirSync(temporary);
const files=['report.docx','metrics.xlsx','brief.pptx'];
const agents=[{id:'writer',role:'manager',tools:manifest.tools.filter(t=>['docx_create','xlsx_write','pptx_create'].includes(t.originalName)).map(t=>t.name)},
 {id:'reader',role:'member',tools:manifest.tools.filter(t=>['docx_read','xlsx_read','pptx_read'].includes(t.originalName)).map(t=>t.name)}];
const tasks=[{id:'produce',kind:'work',assigneeId:'writer',dependencies:[],inputs:[],outputs:files.map(path=>({path}))},
 {id:'review',kind:'work',assigneeId:'reader',dependencies:['produce'],inputs:files.map(path=>({path,producerTaskId:'produce'})),outputs:[]}];
const snapshot={agents,tasks,nativeCapabilities:[{id,manifest}]},archive=createRunArchive(join(out,'runs'),snapshot);
let modelCalls=0,pluginCalls=0;
const sandbox={root,revision:()=>workspaceRevision(root),async execute(name,args,signal){assert.equal(name,'native_plugin');const nativeResult=await runNativeTool({root,tempRoot:temporary,bundle:{...manifest.bundle,compressed:compressed.toString('base64'),metadata:metadata.toString('base64')},originalName:manifest.tools.find(t=>t.name===args.toolName).originalName,args:args.arguments,callId:randomUUID(),readPaths:files,writePaths:args.toolName.endsWith('_read')?[]:files},{signal});pluginCalls++;return {pluginId:id,toolName:args.toolName,nativeResult,artifacts:listArtifacts(root),workspaceRevision:workspaceRevision(root)};}};
const handoff=new HandoffGate({snapshot,sandbox,archive}),activeWork=agent=>({taskId:agent.options.model==='writer'?'produce':'review',attemptId:'attempt-1'});
const host=await createTeamHost({provider:'fixture',adapter:new class extends LlmAdapter{async *stream(){modelCalls++;throw Error('MODEL_CALL_FORBIDDEN');}}(),sessionRoot:join(out,'sessions')});
const writerId=randomUUID();
const dispose=installNativePluginTools(host.ctx,{snapshot,archive,sandbox,gate:new Semaphore(1),captainId:()=>writerId,handoff,activeWork});
const factory=new EmployeeHostFactory({coordinator:host.ctx,provider:'fixture',sessionRoot:join(out,'sessions'),archive,activeWork,identify:agent=>agents.find(item=>item.id===agent.options.model),loadPlugin:name=>import(pathToFileURL(base.resolve(name)).href)});
const result={kind:'native-employee-host-component-integration',modelCalls:0,checks:[],runId:archive.id,pluginId:id};
try{
 const writer=await factory.createAgent(host.ctx,{sessionId:writerId,agentOptions:{provider:'fixture',model:'writer'}});
 let reader=await factory.createAgent(host.ctx,{sessionId:randomUUID(),agentOptions:{provider:'fixture',model:'reader'},setup(_ctx,agent){agent.session.append('subagent/descriptor',{version:3,mode:'continuable',provider:'spawn',label:'fixture:reader',agentProvider:'fixture',agentModel:'reader'});}});
 const call=async(actor,name,args)=>{const ctx=factory.list().find(item=>item.sessionId===actor.agent.id).ctx;return ctx.tools.execute({agent:actor.agent,name,arguments:args,callId:randomUUID(),signal:AbortSignal.timeout(20000)});};
 for(const [name,args] of [
  ['docx_create',{destination_path:'report.docx',title:'Native plugin report',content:[{type:'paragraph',text:'10 checks, 2 failures.'}]}],
  ['xlsx_write',{file_path:'metrics.xlsx',data:[['checks','failures'],[10,2]]}],
  ['pptx_create',{destination_path:'brief.pptx',slides:[{type:'title',title:'Native plugin report',body:'10 checks, 2 failures.'}]}],
 ]){const value=await call(writer,'plugin__office__'+name,args);assert.equal(value.isError,false,JSON.stringify(value));}
 handoff.commit(handoff.prepare('produce','attempt-1',{}));result.checks.push('binary outputs sealed by existing HandoffGate');
 const discovered=await call(reader,'capability_search',{query:'read xlsx docx pptx'});assert.equal(discovered.isError,false);assert.ok(discovered.value.tools.every(t=>agents[1].tools.includes(t.name)));result.checks.push('native tools discovered within employee grants');
 for(const [name,path] of [['docx_read','report.docx'],['xlsx_read','metrics.xlsx'],['pptx_read','brief.pptx']]){const value=await call(reader,'plugin__office__'+name,{file_path:path,...(name==='xlsx_read'?{sheet:'Sheet1'}:{})});assert.equal(value.isError,false,JSON.stringify(value));assert.match(JSON.stringify(value.value.value),/10/);}
 const denied=await call(reader,'plugin__office__docx_create',{destination_path:'blocked.docx',content:[]});assert.equal(denied.isError,true);assert.equal(pluginCalls,6);result.checks.push('ungranted write denied before worker');
 const readerId=reader.agent.id;await reader.dispose();reader=await factory.resume(host.ctx,{resumeSessionId:readerId,agentOptions:{provider:'fixture',model:'reader'}});
 assert.equal((await call(reader,'plugin__office__docx_read',{file_path:'report.docx'})).isError,false);result.checks.push('employee Host reopened with original plugin identity and producer hashes');
 for(const [file,part] of [['report.docx','word/document.xml'],['metrics.xlsx','xl/worksheets/sheet1.xml'],['brief.pptx','ppt/slides/slide1.xml']])assert.match(new AdmZip(readFileSync(join(root,file))).readAsText(part),/10/);
 assert.equal(readdirSync(temporary).length,0);assert.equal(modelCalls,0);result.checks.push('independent ZIP/XML content verification; temporary runtime removed');
 result.artifacts=listArtifacts(root);result.pluginCalls=pluginCalls;result.passed=true;
}finally{await factory.close();dispose();await host.close();result.modelCalls=modelCalls;writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify(result));
