import type pg from 'pg';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {embeddingVersion} from '../../../services/embedding/local.mjs';
import {queryKnowledge} from './knowledge-store.ts';
import {createToolEffectSources} from './tool-effect-sources.ts';
import {ToolEffectContractService} from './tool-effect-contracts.ts';
import {ToolOperationService} from './tool-operations.ts';
import {AppError} from './provider.ts';

type Options={db:Pick<pg.Pool,'query'|'connect'>;writers:ArchiveWriterManager;variant:'container'|'local';knowledgeMode:'keyword'|'hybrid'};
const denied=(code:string)=>new AppError(409,code,code);

/** Only the server composition supplies this factory. No executable or semantic
 * declarations are accepted from HTTP, a manifest, an employee or a plugin. */
export async function createProductionToolEffects(options:Options) {
  if(!options||Object.keys(options).some(key=>!['db','writers','variant','knowledgeMode'].includes(key))||
    !['container','local'].includes(options.variant)||!['keyword','hybrid'].includes(options.knowledgeMode)||
    !options.db?.query||!options.db.connect||!options.writers?.withWriter)
    throw denied('TOOL_EFFECT_PRODUCTION_OPTIONS_INVALID');
  const {db,writers,variant,knowledgeMode}=options;
  const sources=await createToolEffectSources({variant,productionProfile:knowledgeMode});
  const service=new ToolEffectContractService({db,resolveBinding:sources.resolveBinding});
  const operations=new ToolOperationService({db,writers,contracts:service});
  const namespace=`weiwu:production:${variant}:${knowledgeMode}`;
  const checkManifest=(manifest:any)=>{
    if(manifest?.format!=='document-versions-v2'||manifest.retrieval?.mode!==knowledgeMode||
      knowledgeMode==='hybrid'&&manifest.retrieval.embeddingVersion!==embeddingVersion)
      throw denied('TOOL_EFFECT_RUNTIME_BINDING_INVALID');
  };
  // The closure always calls the imported production function and the same DB;
  // no caller-supplied callback can inherit this release's reviewed semantics.
  const boundQuery=async(manifest:any,agentId:string,operation:'search'|'read'|'skill',value:string)=>{
    checkManifest(manifest);return queryKnowledge(manifest,agentId,operation,value,6,db);
  };
  const assertRuntimeBindings=async(input:{queryKnowledge:unknown;snapshot:any})=>{
    const snapshot=input?.snapshot;
    if(input?.queryKnowledge!==boundQuery||snapshot?.demo||
      (snapshot?.executionTarget?.kind==='local'?'local':'container')!==variant||
      snapshot?.effectContractVersion!==1||!Array.isArray(snapshot.effectContracts)||
      snapshot.effectContracts.some((contract:any)=>contract.namespace!==namespace))
      throw denied('TOOL_EFFECT_RUNTIME_BINDING_INVALID');
    checkManifest(snapshot.knowledge);
    // Drift is checked again by the contract service at each actual admission.
    await sources.listBuiltinCandidates();
  };
  return Object.freeze({sources,service,operations,queryKnowledge:boundQuery,
    authorityForRun(runId:string,owner:string){return Object.freeze({
      assertSnapshot:service.assertSnapshot.bind(service),withAdmission:service.withAdmission.bind(service),
      runtimeOperations:operations.forRun(runId,owner),assertRuntimeBindings,
    });},
  });
}
