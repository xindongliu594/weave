import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createTeamHost} from './host.mjs';
import {installApprovedSkills,companySkills} from './approved-skills.mjs';

const require=createRequire(import.meta.url),base=createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));
test('fixed production Skill composition refuses extra providers before loading their bodies',async()=>{
  const root=await mkdtemp(join(tmpdir(),'skill-effect-binding-')),content='Verify only the approved fixed version.';
  const sha256=createHash('sha256').update(content).digest('hex'),employee={id:'reader',role:'manager',tools:['knowledge_read','knowledge_search']};
  const manifest={format:'document-versions-v2',documents:[{documentId:'method',title:'Fixed method',spaceId:'space',version:1,sha256,source:{skillName:'fixed-method'}}],agentDocuments:{reader:['method']}};
  let modelCalls=0,foreignLoads=0,approvedLoads=0;
  const adapter=new class extends LlmAdapter{async*stream(){modelCalls++;throw Error('No model call allowed');}}();
  const host=await createTeamHost({adapter,provider:'fixture',sessionRoot:join(root,'sessions')}),fibers=[];
  try{
    const agent=await host.captain({cwd:root,model:'fixture',instructions:'Protocol test'});
    const mount=async name=>{const module=await import(pathToFileURL(base.resolve(name)).href),fiber=host.ctx.plugin(module.default??module);fibers.push(fiber);await fiber.await();};
    await installApprovedSkills(host.ctx,mount,{manifest,employee,agent,fixedRegistry:true,archive:{append(){}},queryKnowledge:async()=>{approvedLoads++;return {...manifest.documents[0],content};}});
    const name=companySkills(manifest,employee)[0].name;
    const invoke=callId=>host.ctx.tools.execute({name:'skill',arguments:{name},agent,callId,signal:AbortSignal.timeout(2000)});
    const good=await invoke('known');assert.equal(good.isError,false,JSON.stringify(good));assert.equal(good.value.content,content);assert.equal(approvedLoads,1);
    host.ctx.skills.registerProvider(()=>({name:'extra',list:async()=>[{name,description:'Foreign',source:'fixture',provider:'extra',rank:0,invocation:{modelInvocable:true,userInvocable:false}}],get:async()=>{foreignLoads++;return {name,description:'Foreign',provider:'extra',content:'FOREIGN_BODY',invocation:{modelInvocable:true,userInvocable:false}};}}));
    const denied=await invoke('changed');assert.equal(denied.isError,true,JSON.stringify(denied));assert.equal(foreignLoads,0);assert.equal(approvedLoads,1);assert.equal(modelCalls,0);
  }finally{for(const fiber of fibers.reverse())await fiber.dispose();await host.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
