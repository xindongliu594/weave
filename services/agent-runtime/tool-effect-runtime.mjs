import {randomUUID} from 'node:crypto';
import {effectDigest} from './tool-effects.mjs';

const denied='TOOL_EFFECT_DISPATCH_REQUIRED';
function frozenArguments(value){
  // Validate before cloning: getters, proxies and non-JSON input cannot run here.
  effectDigest(value);
  const copy=structuredClone(value);
  const freeze=item=>{if(item&&typeof item==='object'){for(const child of Object.values(item))freeze(child);Object.freeze(item);}return item;};
  return freeze(copy);
}

/** The installed DSH waterfall still owns dispatch. SQL never spans the body. */
export function installToolEffectRuntime(ctx,{operations,contracts,access,boundary,employee,activeWork,prepareArguments=exec=>exec.arguments,timeoutMs=30000}){
  if(!boundary||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||
    ['prepare','dispatch','abortPrepared','recordEvidence','markUnknown'].some(name=>typeof operations?.[name]!=='function'))throw Error('TOOL_EFFECT_RUNTIME_INVALID');
  const active=new Map(),pending=new Set();let closed=false,failure;
  const remember=error=>{failure??=error;closed=true;};
  const check=exec=>{
    const reason=access.check(exec);if(reason!==undefined)return reason;
    const entry=active.get(exec.token);
    if(closed||!entry||entry.exec!==exec||!entry.dispatched||entry.bodyEntered||entry.argumentsSha256!==effectDigest(exec.arguments))return denied;
    if(exec.signal.aborted)return 'TOOL_EFFECT_CANCELLED';
    entry.bodyEntered=true;
  };
  boundary.setBodyPolicy(check);
  const run=async(exec,next)=>{
    if(closed)throw failure??Error('TOOL_EFFECT_RUNTIME_CLOSED');
    const contract=contracts.get(exec.name),reason=access.check(exec);
    if(!contract||reason!==undefined)throw Error(reason??'TOOL_EFFECT_UNREVIEWED');
    exec.signal.throwIfAborted();
    const parent=exec.parent===undefined?undefined:active.get(exec.parent);
    if(exec.parent!==undefined&&(!parent||!parent.dispatched||!parent.bodyEntered||parent.exec.agent!==exec.agent))throw Error('TOOL_EFFECT_PARENT_INVALID');
    if(active.has(exec.token))throw Error('TOOL_EFFECT_TOKEN_REUSED');
    const entry={exec,argumentsSha256:effectDigest(exec.arguments),effectiveArguments:frozenArguments(prepareArguments(exec)),bodyEntered:false,dispatched:false};
    active.set(exec.token,entry);
    const originalSignal=exec.signal,timeout=new AbortController();let timer,unknown,abortListener;
    let primary,result;
    try{
      // Coordination can create/claim a task before an employee has active work.
      // Its existing Host policy still validates the concrete task arguments.
      const work=employee.role!=='manager'&&!exec.name.startsWith('agent_teams_')&&exec.name!=='recovery_read'?activeWork?.(exec.agent):undefined;
      entry.operation=await operations.prepare({contract,agentId:employee.id,sessionId:exec.agent.id,callId:exec.callId,
        ...(work?.taskId?{taskId:work.taskId}:{}),argumentsSha256:effectDigest(entry.effectiveArguments),
        ...(parent?{parentOperationId:parent.operation.operationId}:{})},originalSignal);
      if(entry.operation.state!=='prepared')throw Error('TOOL_EFFECT_ALREADY_DISPATCHED');
      originalSignal.throwIfAborted();
      const deniedNow=access.check(exec);if(deniedNow!==undefined)throw Error(deniedNow);
      const dispatched=await operations.dispatch({operationId:entry.operation.operationId,intentSha256:entry.operation.intentSha256,expectedVersion:entry.operation.version},originalSignal);
      if(dispatched.state!=='dispatched'||dispatched.operationId!==entry.operation.operationId||dispatched.intentSha256!==entry.operation.intentSha256)throw Error('TOOL_EFFECT_DISPATCH_INVALID');
      entry.dispatched=true;
      const ref={operationId:entry.operation.operationId,intentSha256:entry.operation.intentSha256};
      exec.signal=AbortSignal.any([originalSignal,timeout.signal]);
      abortListener=()=>{unknown??=Promise.resolve().then(()=>operations.markUnknown({...ref,reasonCode:'TOOL_RUNTIME_CANCELLED'})).catch(error=>{remember(error);return {error};});};
      exec.signal.addEventListener('abort',abortListener,{once:true});
      timer=setTimeout(()=>timeout.abort(Error('TOOL_RUNTIME_DEADLINE')),timeoutMs);timer.unref?.();
      if(exec.signal.aborted)abortListener();
      // No race: native execution and every late result stay owned until settled.
      try{result=await next();}catch(error){primary=error;}
      clearTimeout(timer);exec.signal.removeEventListener('abort',abortListener);
      const unknownResult=await unknown;
      if(unknownResult?.error)primary??=unknownResult.error;
      const successful=entry.bodyEntered&&!primary&&result?.isError===false;
      try{
        const receiptSha256=effectDigest(successful?{body:'returned',value:result.value??null}:{body:entry.bodyEntered?'unconfirmed':'not-entered',result:'unknown'});
        await operations.recordEvidence({...ref,evidence:{evidenceId:randomUUID(),outcome:successful?'confirmed':'unknown',receiptSha256,reasonCode:successful?'TOOL_RUNTIME_RETURNED':'TOOL_RUNTIME_UNCONFIRMED'}});
      }catch(error){primary??=error;}
      if(!successful)primary??=Error('TOOL_RUNTIME_UNCONFIRMED');
      if(primary)throw primary;
      return result;
    }catch(error){
      remember(error);
      if(entry.operation?.state==='prepared'&&!entry.dispatched){
        // The service re-locks the exact original intent/version and only
        // closes a row still prepared and unstarted. A lost dispatch COMMIT
        // cannot be relabeled; its writer latch or persisted state rejects this.
        try{await operations.abortPrepared({operationId:entry.operation.operationId,intentSha256:entry.operation.intentSha256,expectedVersion:entry.operation.version});}catch{}
      }
      throw error;
    }
    finally{clearTimeout(timer);if(abortListener)exec.signal.removeEventListener('abort',abortListener);exec.signal=originalSignal;active.delete(exec.token);}
  };
  ctx.on('tools/execute',(exec,next)=>{
    const work=run(exec,next);pending.add(work);work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
  });
  return {
    effectiveArguments(exec){const entry=active.get(exec.token);if(!entry||entry.exec!==exec||!entry.bodyEntered||!entry.dispatched)throw Error(denied);return entry.effectiveArguments;},
    stopAdmission(){closed=true;},
    async close(){closed=true;await Promise.allSettled([...pending]);if(failure)throw failure;},
  };
}
