import {isAbsolute} from 'node:path';
import {z} from 'zod';
import type {EffectContract} from '../../../packages/contracts/tool-effects.ts';
import {effectDigest,validateEffectContract} from '../../../services/agent-runtime/tool-effects.mjs';
import {inspectRuntimeToolInventory,readRuntimeToolRelease,type RuntimeToolEntry,type ToolVariant} from '../../../services/agent-runtime/runtime-tool-inventory.mjs';
import {readNativeBundle} from './native-capabilities.ts';
import {AppError} from './provider.ts';
import type {ToolEffectBindingResolver,ToolEffectKey} from './tool-effect-contracts.ts';
import {embeddingVersion} from '../../../services/embedding/local.mjs';

type Client=Parameters<ToolEffectBindingResolver>[0];
type Options={variant:ToolVariant;nativeRoot?:string;productionProfile?:'keyword'|'hybrid'};
export interface ToolEffectSources {
  readonly releaseSha256:string;
  listBuiltinCandidates():Promise<readonly EffectContract[]>;
  resolveBinding(client:Client,key:ToolEffectKey):Promise<EffectContract|null>;
}
const optionsSchema=z.strictObject({variant:z.enum(['container','local','demo']),nativeRoot:z.string().min(1).max(4096).refine(isAbsolute).optional(),productionProfile:z.enum(['keyword','hybrid']).optional()});
const keySchema=z.strictObject({namespace:z.string().min(1).max(128),toolName:z.string().min(1).max(128)});
const sourceError=(code:string)=>new AppError(409,code,code);

function candidate(tool:RuntimeToolEntry,namespace:string,source:EffectContract['source'],evidenceRefs:string[]):EffectContract {
  return validateEffectContract({schema:1,capabilityId:'registered:'+effectDigest({namespace,toolName:tool.name}),namespace,toolName:tool.name,source,
    definitionSha256:tool.definitionSha256,effect:'unknown',cost:{kind:'unknown'},retry:'never',permissions:['tool:'+tool.name],
    isolationProfile:'source-attestation-pending-v1',reconciliation:{kind:'manual'},compensation:{kind:'none',requiresApproval:true},evidenceRefs});
}

// These effects describe the fixed production composition. The runtime factory
// must additionally check the exact injected callbacks; this is not a grant.
function productionCandidate(original:EffectContract,mode:'keyword'|'hybrid'):EffectContract {
  const reads=['knowledge_read','skill','knowledge_search','capability_search'];
  const runtimeWrites=['agent_teams_create','agent_teams_create_task','agent_teams_approve','agent_teams_status','agent_teams_claim_task','agent_teams_update_task','agent_teams_send_message','capability_use'];
  const hybrid=mode==='hybrid'&&['knowledge_search','capability_search'].includes(original.toolName);
  if(!reads.includes(original.toolName)&&!runtimeWrites.includes(original.toolName))return original;
  const effect=runtimeWrites.includes(original.toolName)||hybrid?'workspace':'read';
  return validateEffectContract({...original,effect,cost:{kind:'free'},retry:effect==='read'?'bounded-read':'never',
    isolationProfile:`weiwu-runtime-${mode}-v1`,reconciliation:{kind:'receipt'},
    evidenceRefs:original.evidenceRefs.filter(ref=>!ref.startsWith('attestation:')).concat('composition:production-'+mode+'-v1',...(hybrid?['embedding:'+embeddingVersion]:[]))});
}

/** Proven registration/source identity, not semantic review or execution authorization. */
export async function createToolEffectSources(value:Options):Promise<ToolEffectSources> {
  let options:Options;
  try{effectDigest(value);options=optionsSchema.parse(value);}catch{throw sourceError('TOOL_EFFECT_SOURCE_OPTIONS_INVALID');}
  const inventory=await inspectRuntimeToolInventory({variant:options.variant,includeRecovery:true});
  if(options.productionProfile&&options.variant==='demo')throw sourceError('TOOL_EFFECT_SOURCE_OPTIONS_INVALID');
  const releaseSha256=inventory.release.sha256,namespace=options.productionProfile?`weiwu:production:${options.variant}:${options.productionProfile}`:'weiwu:builtin:'+options.variant;
  const builtins=Object.freeze(inventory.tools.map(tool=>{
    const value=candidate(tool,namespace,
      {kind:'builtin',reference:'weiwu:registered-tools:'+options.variant,version:'source-v1:'+releaseSha256,digest:releaseSha256},
      ['release:'+releaseSha256,'registration:'+tool.registrationBinding,'attestation:runtime-callback-binding-unavailable']);
    return options.productionProfile?productionCandidate(value,options.productionProfile):value;
  }));
  const byName=new Map(builtins.map(item=>[item.toolName,item]));
  const nativeEntries=new Map<string,readonly RuntimeToolEntry[]>();
  const verify=async()=>{if((await readRuntimeToolRelease()).sha256!==releaseSha256)throw sourceError('TOOL_EFFECT_SOURCE_CHANGED_RESTART_REQUIRED');};
  return Object.freeze({releaseSha256,
    async listBuiltinCandidates(){await verify();return builtins;},
    async resolveBinding(client:Client,value:ToolEffectKey):Promise<EffectContract|null>{
      let key:ToolEffectKey;try{effectDigest(value);key=keySchema.parse(value);}catch{throw sourceError('TOOL_EFFECT_SOURCE_KEY_INVALID');}
      if(key.namespace===namespace){const contract=byName.get(key.toolName);if(!contract)return null;await verify();return contract;}
      // MCP target/source/account semantics are not attested in this slice.
      // Neither a remote annotation nor the generic dispatcher can fill that gap.
      const native=/^native:([a-z][a-z0-9_]{0,19}):([a-f0-9]{64})$/.exec(key.namespace);
      if(!native || !options.nativeRoot)return null;
      await verify();
      // Source row precedes the contract row. No new connection/transaction and
      // no network discovery is started while the caller owns this lock.
      const state=(await client.query('SELECT namespace,enabled FROM native_capabilities WHERE namespace=$1 FOR SHARE',[native[1]])).rows[0];
      if(!state?.enabled)return null;
      const bundle=readNativeBundle(native[2],options.nativeRoot);
      if(bundle.manifest.namespace!==native[1])throw sourceError('TOOL_EFFECT_SOURCE_CHANGED');
      let entries=nativeEntries.get(bundle.id);
      if(!entries){
        const inspected=await inspectRuntimeToolInventory({variant:options.variant,nativeBindings:[{id:bundle.id,manifest:bundle.manifest}]});
        if(inspected.release.sha256!==releaseSha256)throw sourceError('TOOL_EFFECT_SOURCE_CHANGED_RESTART_REQUIRED');
        entries=inspected.tools.filter(tool=>tool.nativeManifestId===bundle.id);
        if(nativeEntries.size>=32)nativeEntries.delete(nativeEntries.keys().next().value!);
        nativeEntries.set(bundle.id,entries);
      }
      const tool=entries.find(item=>item.name===key.toolName);if(!tool)return null;
      return candidate(tool,key.namespace,{kind:'native',reference:'native-manifest:'+bundle.id,version:bundle.manifest.version,
        digest:effectDigest({releaseSha256,manifestId:bundle.id})},
      ['release:'+releaseSha256,'native-manifest:'+bundle.id,'attestation:native-effect-semantics-unreviewed']);
    },
  });
}
