import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { createArchiveWriteFence } from './archive-write-fence.mjs';

const current = new AsyncLocalStorage();
const mappings = new Map();
const owners = new WeakMap();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (kind='SCOPE') => Object.assign(Error(`Archive writer ${kind.toLowerCase()}`), {code:`E_ARCHIVE_WRITER_${kind}`});
const key = value => process.platform==='win32'?value.toLowerCase():value;
function contains(parent,child){const relative=path.relative(key(parent),key(child));return !relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function runSet(ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>128||Array.from(ids).some(id=>typeof id!=='string'||!uuid.test(id))||new Set(ids).size!==ids.length)throw fail();
  return [...ids].sort();
}

/** Shared startup mapping only. This does not register strict trace-store coverage. */
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
    if(!context||context.state.manager!==manager||!context.live||context.state.failed||context.state.released||!context.state.ids.includes(runId))throw fail();
    if(mode==='maintenance'&&context.state.mode!=='maintenance')throw fail();
    // An exclusive maintenance owner can call ordinary writer helpers. Always
    // validate its actual native mode; a shared writer can never upgrade.
    fence.assertGuard(context.state.guard,{mode:context.state.mode,runId});
    return context;
  }
  function assertRootContext(){
    const context=current.getStore();
    if(!context||context.state.manager!==manager||!context.live||context.state.failed||context.state.released||context.state.mode!=='root-exclusive')throw fail();
    fence.assertGuard(context.state.guard,{mode:'root-exclusive'});return context;
  }
  function makeOwner(ids,guard,mode){
    let resolve,reject;
    const writerDrained=new Promise((yes,no)=>{resolve=yes;reject=no;});writerDrained.catch(()=>{});
    const state={manager,ids,guard,mode,admission:true,failed:undefined,released:false,producers:new Set(),owner:undefined};
    function latch(error){if(!state.failed){state.failed=error instanceof Error?error:fail('FAILED');failedScopes.add(state);reject(state.failed);}}
    function drain(){
      if(state.admission||state.failed||state.released||state.producers.size)return;
      try{guard.release();state.released=true;resolve();}catch(error){latch(error);}
    }
    function invoke(record,fn){
      if(state.failed||state.released)throw fail();
      // Root mode has no run IDs, but must still validate its real native guard.
      fence.assertGuard(guard,{mode});
      for(const id of ids)fence.assertGuard(guard,{mode,runId:id});
      const context={state,live:true,invoke:nested=>invoke(record,nested)};record.inflight++;
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
    assertMaintenance(runId){assertContext(runId,'maintenance');},
    assertRootExclusive(){assertRootContext();},
    withWriter(runIds,fn,options){return withMode('writer',runIds,fn,options);},
    withMaintenance(runIds,fn,options){return withMode('maintenance',runIds,fn,options);},
    withRootExclusive(fn,options){return withMode('root-exclusive',[],fn,options);},
  });
  mappings.set(key(traceRoot),manager);return manager;
}
