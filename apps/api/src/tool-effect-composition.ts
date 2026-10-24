import type pg from 'pg';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {createProductionToolEffects} from './tool-effect-production.ts';
import {ToolEffectContractService} from './tool-effect-contracts.ts';
import {AppError} from './provider.ts';

// The approved AgentTeams workflow uses these original plugin entry points.
// Other infrastructure remains hidden unless a future reviewed workflow needs it.
const collaborationTools=['agent_teams_create','agent_teams_create_task','agent_teams_approve','agent_teams_status','agent_teams_claim_task','agent_teams_update_task','agent_teams_send_message','capability_search','capability_use','skill'];
type Production=Awaited<ReturnType<typeof createProductionToolEffects>>;
type Db=Pick<pg.Pool,'query'|'connect'>;
export function createToolEffectComposition(db:Db,writers:ArchiveWriterManager){
 const profiles=new Map<string,Promise<Production>>();
 const get=(namespace:string)=>{
  const match=/^weiwu:production:(container|local):(keyword|hybrid)$/.exec(namespace);
  if(!match)throw new AppError(409,'工具来源不属于已配置的执行组合','TOOL_EFFECT_SOURCE_UNAVAILABLE');
  let value=profiles.get(namespace);
  if(!value){value=createProductionToolEffects({db,writers,variant:match[1] as 'container'|'local',knowledgeMode:match[2] as 'keyword'|'hybrid'});profiles.set(namespace,value);}
  return value;
 };
 const forSnapshot=(snapshot:any)=>{
  if(snapshot?.demo||snapshot?.knowledge?.format!=='document-versions-v2'||!['keyword','hybrid'].includes(snapshot.knowledge.retrieval?.mode))
   throw new AppError(409,'知识检索版本无法与已审核工具绑定，请重新批准方案','TOOL_EFFECT_RUNTIME_BINDING_INVALID');
  return get(`weiwu:production:${snapshot.executionTarget?.kind==='local'?'local':'container'}:${snapshot.knowledge.retrieval.mode}`);
 };
 const service=new ToolEffectContractService({db,resolveBinding:async(client,key)=>(await get(key.namespace)).sources.resolveBinding(client,key)});
 return Object.freeze({service,
  async sources(){
   const values=[];
   for(const variant of ['container','local'])for(const mode of ['keyword','hybrid'])values.push(...await(await get(`weiwu:production:${variant}:${mode}`)).sources.listBuiltinCandidates());
   return values;
  },
  async snapshotIn(client:Pick<pg.PoolClient,'query'>,snapshot:any){
   const production=await forSnapshot(snapshot),candidates=await production.sources.listBuiltinCandidates();
   const names=[...new Set([...collaborationTools,...snapshot.agents.flatMap((agent:any)=>agent.tools)])];
   // Unselected unknown tools do not block a knowledge-only project. Selected
   // unknown/native tools must not quietly drop out of the approved contract.
   const keys=names.map(toolName=>{
    const candidate=candidates.find(item=>item.toolName===toolName);
    if(!candidate)throw new AppError(409,`工具 ${toolName} 尚无已审核的执行绑定`,'TOOL_EFFECT_SOURCE_UNAVAILABLE');
    return {namespace:candidate.namespace,toolName};
   });
   return production.service.snapshotIn(client,keys);
  },
  async runtimeBindingsForRun(runId:string,snapshot:any,owner:string){
   if(snapshot?.effectContractVersion===undefined&&snapshot?.effectContracts===undefined)return undefined;
   if(snapshot.effectContractVersion!==1)throw new AppError(409,'不支持此工具审核快照版本','TOOL_EFFECT_SNAPSHOT_INVALID');
   const production=await forSnapshot(snapshot);
   return {effectAuthority:production.authorityForRun(runId,owner),queryKnowledge:production.queryKnowledge};
  },
 });
}
