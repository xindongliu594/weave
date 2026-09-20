import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';import {createTeamHost} from './host.mjs';import {Semaphore} from './limits.mjs';import {createRunArchive} from './trace-store.mjs';
class NeverModel extends LlmAdapter{providerInfo(){return{id:'fixture',name:'fixture'};}async resolveModel(){return{provider:'fixture',id:'test',name:'test'};}async *stream(){throw Error('Unexpected model call');}}
test('actual DSH tool pipeline enforces employee grants and waits for explicit terminal approval',async()=>{
 const root=await mkdtemp(join(tmpdir(),'permissions-'));let host,executed=0,approved=false;
 const snapshot={agents:[{id:'manager',role:'manager',tools:['knowledge_search','terminal_test']}],knowledge:{manager:[{id:'allowed',documentId:'doc',version:1,lineStart:1,lineEnd:1,content:'Deployment rollback test',title:'Manual'}]}};
 const archive=createRunArchive(root,snapshot);
 try{host=await createTeamHost({adapter:new NeverModel(),provider:'fixture',sessionRoot:join(root,'sessions'),archive,product:{snapshot,gate:new Semaphore(1),sandbox:{execute:async()=>{executed++;return{artifacts:[],output:'ok'};}},requestApproval:async()=>{if(!approved)throw Error('Approval denied');}}});const captain=await host.captain({cwd:root,model:'test'});
  await assert.rejects(host.call(captain,'artifact_write',{path:'x',content:'x'}),/TOOL_PERMISSION_DENIED/);assert.equal(executed,0);
  const hits=await host.call(captain,'knowledge_search',{query:'rollback'});assert.equal(hits[0].id,'allowed');
  await assert.rejects(host.call(captain,'terminal_test',{command:'npm test'}),/Approval denied/);assert.equal(executed,0);
  approved=true;await host.call(captain,'terminal_test',{command:'npm test'});assert.equal(executed,1);
  host.lockPlan();await assert.rejects(host.call(captain,'agent_teams_create',{name:'unauthorized',plan:{members:[],tasks:[]}}),/APPROVED_PLAN_IMMUTABLE/);
 }finally{await host?.close();await rm(root,{recursive:true,force:true});}
});
