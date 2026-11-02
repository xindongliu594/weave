import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { createArchiveWriteFence } from './archive-write-fence.mjs';

const current = new AsyncLocalStorage();
const mappings = new Map();
const owners = new WeakMap();
const registeredRoots = new Map(), archiveBindings = new WeakMap();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (kind='SCOPE') => Object.assign(Error(`Archive writer ${kind.toLowerCase()}`), {code:`E_ARCHIVE_WRITER_${kind}`});
const key = value => process.platform==='win32'?value.toLowerCase():value;
function contains(parent,child){const relative=path.relative(key(parent),key(child));return !relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function runSet(ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>128||Array.from(ids).some(id=>typeof id!=='string'||!uuid.test(id))||new Set(ids).size!==ids.length)throw fail();
  return [...ids].sort();
}

/** Application startup only; registration cannot be reversed by a caller. */
export function registerArchiveWriterRoot(manager){
  if(!archiveBindings.has(manager)||mappings.get(key(manager.traceRoot))!==manager)throw fail('CONFIG');
  registeredRoots.set(key(manager.traceRoot),manager);
}
/** Assert the original factory manager, not a caller-supplied assertion method. */
export function assertArchiveSourceScope(manager,runId){
  const binding=archiveBindings.get(manager);
  if(!binding)throw fail('CONFIG');
  binding.assertSource(runId);
}
function registeredManager(root){
  const logical=key(path.resolve(root)),manager=registeredRoots.get(logical);
  if(manager)return manager;
  // A second spelling through a junction must not fall back to the raw API.
  if(registeredRoots.size){
    let physical;try{physical=key(fs.realpathSync(root));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(physical&&registeredRoots.has(physical))throw fail('CONFIG');
  }
}
export function bindArchiveJournal(root,runId){
  const manager=registeredManager(root);
  if(manager)return archiveBindings.get(manager).bindJournal(runId);
  return fn=>{if(registeredManager(root))throw fail();return fn();};
}
export function withArchiveMutationSync(root,runId,mode,fn){
  const manager=registeredManager(root);
  return manager?archiveBindings.get(manager).mutate(runId,mode,fn):fn();
}

/** Shared startup mapping; strict file coverage is enabled by application registration. */
export function createArchiveWriterManager({traceRoot,lockRoot=path.join(path.dirname(traceRoot),'.archive-write-locks'),workspaceRoots=[],initializeTraceRoot=true}){
  if(typeof initializeTraceRoot!=='boolean')throw fail('CONFIG');
  if([traceRoot,lockRoot,...workspaceRoots].some(value=>typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value))throw fail('CONFIG');
  if(contains(traceRoot,lockRoot)||contains(lockRoot,traceRoot)||workspaceRoots.some(root=>contains(root,lockRoot)||contains(lockRoot,root)))throw fail('CONFIG');
  const prior=mappings.get(key(traceRoot));
  if(prior){if(key(prior.lockRoot)!==key(lockRoot))throw fail('CONFIG');return prior;}
  if(initializeTraceRoot)fs.mkdirSync(traceRoot,{recursive:true});fs.mkdirSync(lockRoot,{recursive:true});
  const fence=createArchiveWriteFence({traceRoot,lockRoot,allowMissingTraceRoot:!initializeTraceRoot});
  const failedScopes=new Set();
  let manager;
  function assertContext(runId,mode='writer'){
    const context=current.getStore();
    if(!context||context.state.manager!==manager||!context.live||context.state.failed||context.state.released||context.state.mode==='source'||!context.state.ids.includes(runId))throw fail();
    if(mode==='maintenance'&&context.state.mode!=='maintenance')throw fail();
    // An exclusive maintenance owner can call ordinary writer helpers. Always
    // validate its actual native mode; a shared writer can never upgrade.
    try{fence.assertGuard(context.state.guard,{mode:context.state.guardMode??context.state.mode,runId});}
    catch(error){if(context.state.mode==='recovery-source')context.latch(error);throw error;}
    return context;
  }
  function assertRootContext(){
    const context=current.getStore();
    if(!context||context.state.manager!==manager||!context.live||context.state.failed||context.state.released||context.state.mode!=='root-exclusive')throw fail();
    fence.assertGuard(context.state.guard,{mode:'root-exclusive'});return context;
  }
  function assertSourceContext(runId){
    const context=current.getStore();
    if(!context||context.state.manager!==manager||!context.live||context.state.failed||context.state.released)throw fail();
    const source=context.state.mode==='source'&&context.state.ids.includes(runId);
    const recovery=context.state.mode==='recovery-source'&&context.state.sourceRunId===runId&&context.state.sourceContext===context;
    if(!source&&!recovery)throw fail();
    try{fence.assertGuard(context.state.guard,{mode:context.state.guardMode??context.state.mode,runId});}
    catch(error){context.latch(error);throw error;}
  }
  async function withSource(runId,fn,options){
    const ids=runSet([runId]);
    if(current.getStore()||typeof fn!=='function')throw fail();
    const guard=await fence.acquireSource(runId,options);
    const state={manager,ids,guard,mode:'source',failed:undefined,released:false};
    const latch=error=>{if(!state.failed){state.failed=error;failedScopes.add(state);}};
    const context={state,live:true,latch};
    try{
      try{fence.assertGuard(guard,{mode:'source',runId});}catch(error){latch(error);throw error;}
      const result=current.run(context,()=>fn());
      // Pending async descendants share this live guard until settlement is observed.
      if(result&&typeof result.then==='function')return await result;
      return result;
    }finally{
      context.live=false;
      // Read validation rejection is harmless; native identity/release failure is not.
      if(!state.failed){
        try{fence.assertGuard(guard,{mode:'source',runId});guard.release();state.released=true;}
        catch(error){latch(error);}
      }
      if(state.failed)throw state.failed;
    }
  }
  function makeOwner(ids,guard,mode,sourceRunId){
    let resolve,reject;
    const writerDrained=new Promise((yes,no)=>{resolve=yes;reject=no;});writerDrained.catch(()=>{});
    const guardMode=sourceRunId?'maintenance':mode,nativeIds=sourceRunId?[...ids,sourceRunId]:ids;
    const state={manager,ids,guard,mode,guardMode,sourceRunId,sourceContext:undefined,admission:true,failed:undefined,released:false,producers:new Set(),owner:undefined};
    function assertNative(){
      try{fence.assertGuard(guard,{mode:guardMode});for(const id of nativeIds)fence.assertGuard(guard,{mode:guardMode,runId:id});}
      catch(error){if(sourceRunId)latch(error);throw error;}
    }
    function latch(error){if(!state.failed){state.failed=error instanceof Error?error:fail('FAILED');failedScopes.add(state);reject(state.failed);}}
    function drain(){
      if(state.admission||state.failed||state.released||state.producers.size)return;
      try{if(sourceRunId)assertNative();guard.release();state.released=true;resolve();}catch(error){latch(error);}
    }
    function invoke(record,fn){
      if(state.failed||state.released)throw fail();
      // Root mode has no run IDs, but must still validate its real native guard.
      assertNative();
      const context={state,live:true,latch,invoke:nested=>invoke(record,nested)};record.inflight++;
      const settle=()=>{context.live=false;record.inflight--;if(record.finished&&!record.inflight)state.producers.delete(record);drain();};
      let result;
      try{result=current.run(context,()=>fn(context));}catch(error){latch(error);settle();throw error;}
      if(result&&typeof result.then==='function'){
        Promise.resolve(result).then(settle,error=>{latch(error);settle();});
      }else settle();
      return result;
    }
    function producer(isOwner=false){
      const record={finished:false,inflight:0};state.producers.add(record);
      function settle(){if(record.finished&&!record.inflight)state.producers.delete(record);drain();}
      const handle={
        run(fn){
          if(record.finished||state.failed||state.released)throw fail();
          return invoke(record,()=>fn());
        },
        finish(error){
          if(error)latch(error);
          if(isOwner)state.admission=false;
          record.finished=true;settle();
        },
      };
      if(isOwner)Object.assign(handle,{
        writerDrained,
        closeAdmission(){state.admission=false;drain();},
        retain(label){
          if(typeof label!=='string'||!label||!state.admission||record.finished||state.failed||state.released)throw fail();
          return producer();
        },
      });
      return Object.freeze(handle);
    }
    const owner=producer(true);state.owner=owner;owners.set(owner,state);return owner;
  }
  async function withRecoverySource(sourceRunId,childRunId,fn,options){
    const ids=runSet([sourceRunId,childRunId]);
    if(current.getStore()||typeof fn!=='function')throw fail();
    // One existing native acquisition fences both runs; logical authority stays split.
    const guard=await fence.acquireMaintenance(ids,options),owner=makeOwner([childRunId],guard,'recovery-source',sourceRunId);
    let result;
    try{result=await owner.run(()=>{
      const context=current.getStore();context.state.sourceContext=context;
      const scope=Object.freeze({retain(label){if(current.getStore()!==context)throw fail();assertContext(childRunId);return owner.retain(label);}});
      return fn(scope);
    });}catch(error){owner.finish(error);throw error;}
    owner.finish();await owner.writerDrained;return result;
  }
  async function withMode(mode,runIds,fn,options){
    const ids=mode==='root-exclusive'?[]:runSet(runIds),context=current.getStore();
    const assertRequested=()=>{if(mode==='root-exclusive')assertRootContext();else for(const id of ids)assertContext(id,mode);};
    if(context){
      assertRequested();
      return context.invoke(nested=>{
        const borrowed=Object.freeze({retain(label){if(current.getStore()!==nested)throw fail();assertRequested();return nested.state.owner.retain(label);}});
        return fn(borrowed);
      });
    }
    const guard=await (mode==='root-exclusive'?fence.acquireRootExclusive(options):mode==='maintenance'?fence.acquireMaintenance(ids,options):fence.acquireWriter(ids,options)),owner=makeOwner(ids,guard,mode);
    let result;
    try{result=await owner.run(()=>fn(owner));}catch(error){owner.finish(error);throw error;}
    owner.finish();await owner.writerDrained;return result;
  }
  manager=Object.freeze({
    traceRoot,lockRoot,
    async acquireOwner(runIds,options){
      // Explicit ownership is a top-level operation; nesting uses withWriter.
      if(current.getStore())throw fail();
      const ids=runSet(runIds),guard=await fence.acquireWriter(ids,options);return makeOwner(ids,guard,'writer');
    },
    assertOwner(owner,runId){
      const state=owners.get(owner);
      if(!state||state.manager!==manager||state.failed||state.released||!state.admission||!state.ids.includes(runId))throw fail();
      fence.assertGuard(state.guard,{mode:state.mode,runId});
    },
    assertWriter(runId){assertContext(runId);},
    assertSource(runId){assertSourceContext(runId);},
    assertMaintenance(runId){assertContext(runId,'maintenance');},
    assertRootExclusive(){assertRootContext();},
    withWriter(runIds,fn,options){return withMode('writer',runIds,fn,options);},
    withMaintenance(runIds,fn,options){return withMode('maintenance',runIds,fn,options);},
    withRootExclusive(fn,options){return withMode('root-exclusive',[],fn,options);},
    withSource,
    withRecoverySource,
  });
  archiveBindings.set(manager,{
    assertSource:assertSourceContext,
    bindJournal(runId){
      const origin=assertContext(runId);
      return fn=>{
        const active=assertContext(runId);
        if(!origin.live||active.state!==origin.state)throw fail();
        let entered=false;
        try{return fence.withJournalAppendSync(origin.state.guard,runId,()=>{entered=true;return fn();});}
        catch(error){if(entered)origin.latch(error);throw error;}
      };
    },
    mutate(runId,mode,fn){
      if(!['writer','maintenance'].includes(mode))throw fail();
      const context=assertContext(runId,mode);
      try{return fn();}catch(error){context.latch(error);throw error;}
    },
  });
  mappings.set(key(traceRoot),manager);return manager;
}
