import test from 'node:test';
import assert from 'node:assert/strict';
const load=()=>import('../apps/web/src/tool-effect-review-client.ts');
const contract:any={toolName:'knowledge_read',namespace:'weiwu:production:container:keyword',effect:'read',cost:{kind:'free'},retry:'bounded-read',source:{version:'fixed'},permissions:['tool:knowledge_read']};
const candidate={digest:'a'.repeat(64),contract,status:'unreviewed'};
test('review UI sends nothing until opened and coalesces a pending read',async()=>{
  const {createToolEffectReviewClient}=await load();let calls=0,finish:any;
  const client=createToolEffectReviewClient(async()=>{calls++;return new Promise(resolve=>finish=resolve);});
  await client.catalog();assert.equal(calls,0);client.setActive(true);
  const first=client.catalog(),second=client.catalog();assert.equal(calls,1);finish([contract]);await Promise.all([first,second]);assert.deepEqual(client.getSnapshot().items,[contract]);client.dispose();
});
test('review uses the fetched exact digest once; an unknown transport result clears the action and never repeats',async()=>{
  const {createToolEffectReviewClient}=await load();const sent:any[]=[];
  const client=createToolEffectReviewClient(async(path,method,body)=>{sent.push({path,method,body});if(method==='POST')throw Error('结果尚未确认');return candidate;});
  client.setActive(true);await client.select(contract);await client.review();await client.review();
  assert.equal(sent.length,2);assert.deepEqual(sent[1],{path:'/tool-effect-contracts/reviews',method:'POST',body:{namespace:contract.namespace,toolName:'knowledge_read',expectedDigest:candidate.digest}});
  assert.equal(client.getSnapshot().selected,null);assert.match(client.getSnapshot().error,/尚未确认/);client.dispose();
});
test('close clears old identity data and discards late responses without aborting or repeating a write',async()=>{
  const {createToolEffectReviewClient}=await load();let finish:any,calls=0;
  const client=createToolEffectReviewClient(async(_path,method)=>{calls++;return method==='GET'?candidate:new Promise(resolve=>finish=resolve);});
  client.setActive(true);await client.select(contract);const work=client.review();client.setActive(false);finish({...candidate,status:'reviewed',version:1});await work;
  assert.equal(calls,2);assert.equal(client.getSnapshot().selected,null);assert.equal(client.getSnapshot().busy,false);client.dispose();
});
test('unknown source semantics cannot submit a review and retirement binds the displayed version',async()=>{
  const {createToolEffectReviewClient}=await load();const requests:any[]=[];let shown:any={...candidate,contract:{...contract,effect:'unknown'}};
  const client=createToolEffectReviewClient(async(path,method,body)=>{requests.push({path,method,body});return shown;});client.setActive(true);
  await client.select(contract);await client.review();assert.equal(requests.length,1);
  shown={...candidate,status:'reviewed',version:1};await client.select(contract);await client.retire();
  assert.deepEqual(requests.at(-1),{path:'/tool-effect-contracts/'+candidate.digest+'/retire',method:'POST',body:{expectedVersion:1}});client.dispose();
});
