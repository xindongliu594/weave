import { randomUUID,createHash } from 'node:crypto';
import type pg from 'pg';
import { pool } from './db.ts';
import { AppError,type ChatMessage } from './provider.ts';
import { completeBudgeted } from './cost-control.ts';
import type { Model } from '../../../packages/contracts/index.ts';
export const toolProbeVersion='chat-tools-roundtrip-v1';
export function routeFingerprint(data:any,gatewayVersion:number){return createHash('sha256').update(JSON.stringify({data,gatewayVersion})).digest('hex');}
export async function assertRunModels(snapshot:any,db:Pick<pg.PoolClient,'query'>=pool){
 const ids=[...new Set<string>((snapshot.agents??[]).flatMap((a:any)=>[a.modelId,a.fallbackModelId].filter(Boolean)))];
 if(!ids.length)throw new AppError(422,'运行快照缺少可验证的模型配置，请重新制定并批准方案','MODEL_REAPPROVAL_REQUIRED');
 const rows=(await db.query(`SELECT m.id,m.data,m.status,m.capabilities,g.version AS gateway_version FROM models m JOIN gateways g ON g.id=m.data->>'gatewayId' WHERE m.id=ANY($1::text[]) AND m.deleted_at IS NULL`,[ids])).rows;
 for(const id of ids){const model=rows.find(m=>m.id===id),route=snapshot.modelRoutes?.find((r:any)=>r.id===id);
  if(!model||model.status!=='available'||model.capabilities?.tools?.status!=='supported')throw new AppError(422,'执行模型或备用模型尚未通过文本及工具测试','MODEL_CAPABILITY_REQUIRED');
  if(!route?.configurationHash||route.configurationHash!==routeFingerprint(model.data,model.gateway_version))throw new AppError(409,'模型或中转站配置与批准时不同，请保存新方案并重新批准','MODEL_REAPPROVAL_REQUIRED');
 }
}
export async function probeTools(model:Model,maxCost=.1){
 const id=randomUUID(),challenge=randomUUID(),answer=randomUUID(),client=await pool.connect();
 let outcome='running',code:string|null=null;
 try{
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock_shared(918275)');
   await client.query("INSERT INTO model_capability_tests(id,model_id,model_version,probe_version,status) VALUES($1,$2,$3,$4,'running')",[id,model.id,model.version,toolProbeVersion]);
   await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const messages:ChatMessage[]=[{role:'user',content:`Call capability_probe with nonce ${challenge}. After the tool returns, reply with only its result value, exactly as written.`}];
  const unchanged=async()=>{if(!(await pool.query("SELECT id FROM models WHERE id=$1 AND version=$2 AND status='available' AND deleted_at IS NULL",[model.id,model.version])).rowCount)throw new AppError(409,'测试期间模型或中转站配置已变化，请重新测试','MODEL_CONFIG_CHANGED');};
  const options={purpose:'工具能力测试',maxCost:maxCost/2,context:{probeId:id,capability:'tools'}};
  await unchanged();
  const first=await completeBudgeted(model,messages,256,options,{tools:[{type:'function',function:{name:'capability_probe',description:'Harmless local protocol check; returns a verification value.',parameters:{type:'object',properties:{nonce:{type:'string',enum:[challenge]}},required:['nonce'],additionalProperties:false}}}],tool_choice:model.thinkingMode==='disabled'?'auto':{type:'function',function:{name:'capability_probe'}}});
  const message=first.choices[0].message,calls=message.tool_calls;
  let args:any;try{args=JSON.parse(calls?.[0]?.function.arguments??'');}catch{}
  if(calls?.length!==1||calls[0].function.name!=='capability_probe'||args?.nonce!==challenge||Object.keys(args??{}).length!==1)throw new AppError(422,'模型未返回正确的工具名称和参数，本次工具能力测试未通过','TOOL_PROBE_FAILED');
  // This synthetic tool has no filesystem, network or external side effect.
  await unchanged();
  const second=await completeBudgeted(model,[...messages,{role:'assistant',content:message.content,tool_calls:calls},{role:'tool',tool_call_id:calls[0].id,content:JSON.stringify({result:answer})}],128,options);
  if(second.choices[0].message.content?.trim()!==answer||second.choices[0].message.tool_calls?.length)throw new AppError(422,'模型未正确读取工具结果，本次工具往返测试未通过','TOOL_PROBE_FAILED');
  const evidence={status:'supported',checkedAt:new Date().toISOString(),testId:id,probeVersion:toolProbeVersion};
  const result=await pool.query("UPDATE models SET capabilities=jsonb_set(capabilities,'{tools}',$1::jsonb),version=version+1 WHERE id=$2 AND version=$3 AND status='available' AND deleted_at IS NULL",[JSON.stringify(evidence),model.id,model.version]);
  if(!result.rowCount)throw new AppError(409,'测试期间模型或中转站配置已变化，请重新测试','MODEL_CONFIG_CHANGED');
  outcome='supported';return {ok:true,testId:id,message:'工具参数和工具结果往返测试通过；用量已记录。'};
 }catch(error){
  code=error instanceof AppError?error.code:'PROBE_INTERRUPTED';
  const local=error instanceof AppError&&(error.status===409||error.code.endsWith('BUDGET_EXCEEDED')||error.code==='COST_PENDING');
  outcome=local?'not_applied':'failed';
  if(!local)await pool.query("UPDATE models SET capabilities=jsonb_set(capabilities,'{tools}',$1::jsonb),version=version+1 WHERE id=$2 AND version=$3 AND deleted_at IS NULL",[JSON.stringify({status:'failed',checkedAt:new Date().toISOString(),testId:id,probeVersion:toolProbeVersion}),model.id,model.version]);
  throw error;
 }finally{
  await pool.query("UPDATE model_capability_tests SET status=$1,code=$2,finished_at=now(),request_ids=(SELECT COALESCE(jsonb_agg(id ORDER BY created_at),'[]'::jsonb) FROM model_reservations WHERE context->>'probeId'=$3) WHERE id=$3",[outcome,code,id]);
 }
}
