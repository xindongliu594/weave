import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const prior=JSON.parse(readFileSync(new URL('../../../docs/validation/evidence/delivery-binding-pilot-2026-10-19/real/broker-result.json',import.meta.url)));
assert.equal(hash(prior.requests[0].content),'47ad11d484ba8e59100c3ab194b81a2926a76815c9e3c3db79ad5bd52baf74f5');
export const baselineRequestSha256='65a41fcc51316503786482ad0c811da26bab0d94b5edd774511306b7339d3ff3';
export function assertBaselineRequest(body){assert.equal(hash(body),baselineRequestSha256,'Pinned baseline request changed');}
assertBaselineRequest(prior.requests[0].request);
export const limits=Object.freeze({maxCalls:12,maxCallCost:.02,maxTrialCost:.24,maxCumulative:3.41,maxTokens:4000});
export const stageClarification='阶段边界补充：每个节点的 verify/acceptanceChecks 必须在该节点完成前能执行，只能读取自己的输出或合法前置 inputs；绝不能依赖后续 QA 才创建的测试文件。开发自检标准只写其命令实际能证明的内容，例如 node --check 只证明语法，不证明 0→32、100→212、非法输入行为或 README 内容。功能验收放在独立 QA 节点，QA 编写自己的测试后运行 node --test；README 内容由后续只读核对者检查。不能为了逐项映射，把所有开发标准都指向同一未来测试命令。最终用户验收标准仍需全部覆盖，不得通过删除功能标准绕过。';
const models=['deepseek-v4.1-flash','glm-5.3-flash'],variants=['original','clarified'];
export const matrix=[0,1,2].flatMap(round=>(round===1?[[0,1],[1,0],[0,0],[1,1]]:[[0,0],[1,1],[0,1],[1,0]]).map(([m,v])=>({id:`r${round+1}-${models[m]}-${variants[v]}`,round:round+1,model:models[m],variant:variants[v]})));
export function bodyFor(model,variant){
 assert.ok(models.includes(model)&&variants.includes(variant));const body=structuredClone(prior.requests[0].request);body.model=model;
 assert.equal(body.max_tokens,4000);assert.equal(body.stream,false);assert.equal(body.tools,undefined);assert.deepEqual(body.thinking,{type:'disabled'});
 if(variant==='clarified')body.messages[0].content+='\n'+stageClarification;
 return body;
}
export function independentCells(previous){
 assert.equal(previous.requests.length,2);assert.equal(previous.requests[0].id,matrix[0].id);assert.equal(previous.requests[1].id,matrix[1].id);
 assert.equal(previous.requests[0].receipts[0].status,'settled');assert.equal(previous.requests[1].error.code,'GATEWAY_REJECTED');
 const held=previous.requests[1].receipts[0];assert.equal(held.status,'uncertain');assert.equal(held.id,'d8af5bf7-377a-4589-a4ec-f3e8ef2df10f');
 assert.deepEqual(previous.after.holds,[...previous.before.holds,{id:held.id,status:held.status,amount:held.amount}].sort((a,b)=>a.id.localeCompare(b.id)));
 for(const e of previous.requests)assert.equal(hash(e.request),hash(bodyFor(e.model,e.variant)));
 return matrix.filter(c=>c.model==='deepseek-v4.1-flash'&&!previous.requests.some(e=>e.id===c.id));
}
// Sequential fixed cells; even failures settle/read the receipt before returning.
export async function runMatrix({before,dispatch,receipt,save,entries,cells=matrix}){
 assert.equal(entries.length,0,'Cannot replay a partial experiment');
 for(const cell of cells){
  const request=bodyFor(cell.model,cell.variant),reserved=await before(cell,request);
  const entry={...cell,requestId:randomUUID(),request,requestSha256:hash(request),reserved,startedAt:new Date().toISOString()};entries.push(entry);save();
  const start=performance.now();let failure;
  try{const result=await dispatch(entry);entry.content=result.choices[0].message.content;entry.finishReason=result.choices[0].finish_reason;entry.returnedAt=new Date().toISOString();}
  catch(error){failure=error;entry.error={message:error.message,code:error.code};}
  finally{
   entry.milliseconds=Math.round(performance.now()-start);
   try{entry.receipts=await receipt(entry);assert.equal(entry.receipts.length,1,'Exactly one receipt per dispatch');
    const r=entry.receipts[0];if(r.cost!=null){entry.cost=r.cost;entry.usageId=r.id;entry.usage={prompt_tokens:r.inputTokens,completion_tokens:r.outputTokens};}
    assert.equal(r.status,'settled','Unresolved receipt; stop without replay');assert.ok(Number.isFinite(entry.cost)&&entry.cost>=0&&entry.cost<=reserved+1e-9,'Settled cost exceeds reservation');
   }catch(error){failure??=error;entry.error??={message:error.message};}save();
  }
  if(failure)throw failure;
 }
}
