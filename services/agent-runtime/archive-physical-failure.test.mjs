import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {readRun} from './trace-store.mjs';

const runId='10000000-0000-4000-8000-000000000071';
const helper=fileURLToPath(new URL('./test-helpers/archive-physical-failure-child.mjs',import.meta.url));
function start(f,action){
  const proc=fork(helper,[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,ARCHIVE_PHYSICAL_TEST:JSON.stringify({...f.args,action})}});
  let stderr='';proc.stderr.on('data',chunk=>{stderr+=chunk;});
  const exited=once(proc,'exit');
  const message=new Promise((resolve,reject)=>{
    proc.once('message',resolve);proc.once('error',reject);
    proc.once('exit',(code,signal)=>reject(Error(`child exited before message: ${code}/${signal} ${stderr}`)));
  });
  f.children.push({proc,exited});return {proc,exited,message,stderr:()=>stderr};
}
function bytesAt(args,target){
  const dir=path.join(args.traceRoot,runId),journal=path.join(dir,'events.jsonl');
  const bytes=file=>fs.existsSync(file)?fs.readFileSync(file):null;
  const targetBytes=bytes(target),journalBytes=bytes(journal);
  return {targetBytes:targetBytes?.length??null,targetSha256:targetBytes&&createHash('sha256').update(targetBytes).digest('hex'),journalBytes:journalBytes?.length??null,
    journalSha256:journalBytes&&createHash('sha256').update(journalBytes).digest('hex')};
}

for(const operation of ['create','append','object'])for(const fault of ['write','fsync']){
  test(`registered ${operation} ${fault} failure swallowed by business keeps source blocked across processes until owner exits`,{timeout:15000},async t=>{
    const evidenceRoot=path.resolve('.private/checkpoint-physical-20261029');fs.mkdirSync(evidenceRoot,{recursive:true});
    const parent=fs.realpathSync(evidenceRoot),base=fs.mkdtempSync(path.join(parent,'physical-'));
    const args={base,traceRoot:path.join(base,'runs'),lockRoot:path.join(base,'locks'),runId,operation,fault,nonce:randomUUID()};
    const f={args,children:[]};
    t.after(async()=>{
      for(const child of f.children)if(child.proc.exitCode===null&&child.proc.signalCode===null){child.proc.kill();await child.exited;}
      assert.equal(fs.realpathSync(base),base);assert.equal(path.dirname(base),parent);assert.match(path.basename(base),/^physical-[A-Za-z0-9]+$/);
      const markerFile=path.join(base,'OWNER.json');
      if(fs.existsSync(markerFile)){const marker=JSON.parse(fs.readFileSync(markerFile,'utf8'));assert.equal(marker.nonce,args.nonce);assert.equal(marker.traceRoot,args.traceRoot);assert.ok(f.children.some(child=>child.proc.pid===marker.pid));}
      fs.rmSync(base,{recursive:true});
    });
    const holder=start(f,'holder'),failure=await holder.message;
    assert.equal(failure.kind,'failed-owner');assert.equal(failure.pid,holder.proc.pid);assert.equal(failure.nonce,args.nonce);
    assert.equal(failure.originalError.code,'EIO');assert.equal(failure.originalError.syscall,fault);assert.equal(failure.originalError.path,failure.target);
    assert.equal(failure.swallowed,true);assert.equal(failure.finished,true);assert.equal(failure.drainedOriginalError,true);assert.equal(failure.hits,1);
    assert.equal(failure.writeCalls,fault==='write'?2:1);assert.equal(failure.fsyncCalls,fault==='fsync'?1:0);
    const before=bytesAt(args,failure.target);
    assert.equal(before.targetBytes,failure.initialBytes+(fault==='write'?7:failure.bytesWritten));
    let eventCount=0,integrity='journal absent';
    if(operation==='create'){
      assert.equal(before.journalBytes,null);
      if(fault==='write')assert.throws(()=>readRun(args.traceRoot,runId),SyntaxError);
    }else{
      const run=readRun(args.traceRoot,runId);
      eventCount=run.eventCount;integrity=run.integrity;
      assert.equal(run.eventCount,operation==='append'&&fault==='fsync'?2:1);
      assert.equal(run.integrity,operation==='append'&&fault==='write'?'incomplete':'ok');
      assert.deepEqual(run.events.map(event=>event.type),operation==='append'&&fault==='fsync'?['run/created','uncertain-write']:['run/created']);
      if(operation==='object'&&fault==='fsync')assert.equal(before.targetSha256,failure.sha256);
    }
    const probe=start(f,'source'),blocked=await probe.message;
    assert.notEqual(probe.proc.pid,holder.proc.pid);assert.equal(blocked.acquired,false);assert.equal(blocked.code,'E_ARCHIVE_FENCE_TIMEOUT');
    assert.deepEqual(await probe.exited,[0,null]);assert.equal(holder.proc.exitCode,null);assert.equal(holder.proc.signalCode,null);
    assert.deepEqual(bytesAt(args,failure.target),before,'no replay or repair while failed owner is alive');
    holder.proc.kill();const holderExit=await holder.exited;
    const after=start(f,'source'),released=await after.message;
    assert.equal(released.acquired,true);assert.deepEqual(await after.exited,[0,null]);
    assert.deepEqual(bytesAt(args,failure.target),before,'OS lock release must not replay uncertain writes');
    t.diagnostic(JSON.stringify({operation,fault,base,holderPid:holder.proc.pid,blockedPid:probe.proc.pid,releasedPid:after.proc.pid,ownerNonce:args.nonce,holderExit,originalError:failure.originalError,initialBytes:failure.initialBytes,bytesWritten:failure.bytesWritten,...before,eventCount,integrity,blocked:blocked.code,blockedElapsedMs:blocked.elapsedMs,released:released.acquired}));
  });
}
