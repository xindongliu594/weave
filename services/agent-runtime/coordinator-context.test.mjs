import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import {createTeamHost} from './host.mjs';
import {createRunArchive} from './trace-store.mjs';
import {Semaphore} from './limits.mjs';

test('coordination can refresh its approved context without claiming an employee task', {timeout:5000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'coordinator-context-')),workspace=join(root,'artifacts');mkdirSync(workspace);
 const snapshot={requirement:'Keep the approved organization',policy:{contextManagement:'prune'},agents:[{id:'manager',role:'manager',modelId:'fixture',tools:[]}],tasks:[]};
 const archive=createRunArchive(join(root,'runs'),snapshot),requests=[];let host;
 const adapter=new class extends LlmAdapter {
  async *stream(options){requests.push(options);yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'Coordination received.'}};yield {type:'finish',reason:{kind:'stop'}};}
 }();
 try{
  host=await createTeamHost({adapter,provider:'fixture',sessionRoot:join(root,'sessions'),archive,product:{snapshot,sandbox:{root:workspace},gate:new Semaphore(1)}});
  const captain=await host.captain({cwd:root,model:'fixture'});
  captain.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Read the current coordination context.'}]}));await captain.whenIdle();
  const endings=captain.session.snapshotEvents().filter(event=>event.type==='turn/end').map(event=>event.data.reason);
  assert.equal(requests.length,1,JSON.stringify(endings));
  assert.ok(endings.every(reason=>reason.kind!=='error'));
  const section=requests[0].messages.flatMap(message=>message.source?.sections??[]).find(row=>row.name==='department:approved-context');
  assert.ok(section);const context=JSON.parse(section.text);
  assert.equal(context.requirement,snapshot.requirement);assert.deepEqual(context.tasks,[]);assert.equal(context.task,undefined);
  assert.deepEqual(context.tools,[],'coordination refresh grants no employee tools');
 }finally{await host?.close();rmSync(root,{recursive:true,force:true});}
});
