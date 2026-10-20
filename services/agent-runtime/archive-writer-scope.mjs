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
export function createArchiveWriterManager({traceRoot,lockRoot=path.join(path.dirname(traceRoot),'.archive-write-locks'),workspaceRoots=[]}){
  if([traceRoot,lockRoot,...workspaceRoots].some(value=>typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value))throw fail('CONFIG');
  if(contains(traceRoot,lockRoot)||contains(lockRoot,traceRoot)||workspaceRoots.some(root=>contains(root,lockRoot)||contains(lockRoot,root)))throw fail('CONFIG');
  const prior=mappings.get(key(traceRoot));
  if(prior){if(key(prior.lockRoot)!==key(lockRoot))throw fail('CONFIG');return prior;}
  fs.mkdirSync(traceRoot,{recursive:true});fs.mkdirSync(lockRoot,{recursive:true});
  const fence=createArchiveWriteFence({traceRoot,lockRoot});
  const failedScopes=new Set();
  let manager;
  function assertContext(runId){
    const context=current.getStore();
    if(!context||context.state.manager!==manager||!context.live||context.state.failed||context.state.released||!context.state.ids.includes(runId))throw fail();
    fence.assertGuard(context.state.guard,{mode:'writer',runId});
    return context;
  }
  function makeOwner(ids,guard){
    let resolve,reject;
    const writerDrained=new Promise((yes,no)=>{resolve=yes;reject=no;});writerDrained.catch(()=>{});
    const state={manager,ids,guard,admission:true,failed:undefined,released:false,producers:new Set(),owner:undefined};
    function latch(error){if(!state.failed){state.failed=error instanceof Error?error:fail('FAILED');failedScopes.add(state);reject(state.failed);}}
    function drain(){
      if(state.admission||state.failed||state.released||state.producers.size)return;
      try{guard.release();state.released=true;resolve();}catch(error){latch(error);}
    }
    function producer(isOwner=false){
      const record={finished:false,inflight:0};state.producers.add(record);
      function settle(){if(record.finished&&!record.inflight)state.producers.delete(record);drain();}
      const handle={
        run(fn){
          if(record.finished||state.failed||state.released)throw fail();
          for(const id of ids)fence.assertGuard(guard,{mode:'writer',runId:id});
          const context={state,live:true};record.inflight++;
          let result;
          try{result=current.run(context,fn);}catch(error){context.live=false;record.inflight--;latch(error);settle();throw error;}
          if(result&&typeof result.then==='function'){
            Promise.resolve(result).then(()=>{context.live=false;record.inflight--;settle();},error=>{context.live=false;record.inflight--;latch(error);settle();});
          }else{context.live=false;record.inflight--;settle();}
          return result;
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
  manager=Object.freeze({
    traceRoot,lockRoot,
    async acquireOwner(runIds,options){
      // Explicit ownership is a top-level operation; nesting uses withWriter.
      if(current.getStore())throw fail();
      const ids=runSet(runIds),guard=await fence.acquireWriter(ids,options);return makeOwner(ids,guard);
    },
    assertOwner(owner,runId){
      const state=owners.get(owner);
      if(!state||state.manager!==manager||state.failed||state.released||!state.admission||!state.ids.includes(runId))throw fail();
      fence.assertGuard(state.guard,{mode:'writer',runId});
    },
    assertWriter(runId){assertContext(runId);},
    async withWriter(runIds,fn,options){
      const ids=runSet(runIds),context=current.getStore();
      if(context){
        for(const id of ids)assertContext(id);
        // A borrower can retain original work, but cannot close its parent.
        const borrowed=Object.freeze({retain(label){for(const id of ids)assertContext(id);return context.state.owner.retain(label);}});
        return fn(borrowed);
      }
      const owner=await manager.acquireOwner(ids,options);
      let result;
      try{result=await owner.run(()=>fn(owner));}catch(error){owner.finish(error);throw error;}
      owner.finish();await owner.writerDrained;return result;
    },
  });
  mappings.set(key(traceRoot),manager);return manager;
}
