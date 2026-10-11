import {lstatSync,opendirSync,readFileSync,unlinkSync,statfsSync,existsSync} from 'node:fs';
import {join,resolve,relative,parse,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readRun} from './trace-store.mjs';
import {unresolvedOperations} from './recovery.mjs';
const {validPath}=createRequire(import.meta.url)('../../apps/desktop/local-executor.cjs');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const changed=()=>Object.assign(Error('清理清单或文件已变化，请重新生成预览；原档案保留。'),{code:'STORAGE_CANDIDATE_CHANGED'});
const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.nlink].join(':');
function checked(root,path=''){
 const base=resolve(root),target=path?join(base,validPath(path)):base;let at=parse(base).root;
 for(const part of relative(at,target).split(sep).filter(Boolean)){
  at=join(at,part);const stat=lstatSync(at);
  if(stat.isSymbolicLink()||(!stat.isDirectory()&&at!==target)||stat.isFile()&&stat.nlink!==1)throw changed();
 }
 return target;
}
function fileProof(root,path){const full=checked(root,path),before=lstatSync(full);if(!before.isFile()||before.size>5*1024*1024)throw changed();
 const sha256=createHash('sha256').update(readFileSync(full)).digest('hex');if(identity(before)!==identity(lstatSync(full)))throw changed();
 return {bytes:before.size,sha256,identity:identity(before)};
}
export function scanStorage(root,limit=100000){
 const result={bytes:0,files:0,entries:0,links:0,complete:true,errors:[]};if(!existsSync(root))return result;
 try{checked(root);}catch{result.complete=false;result.links=1;result.errors.push({path:'',code:'UNVERIFIED_ROOT'});return result;}
 const pending=[resolve(root)];
 while(pending.length){if(result.entries>=limit){result.complete=false;result.errors.push({path:'',code:'ENTRY_LIMIT'});break;}
  const file=pending.pop();result.entries++;
  try{const stat=lstatSync(file);if(stat.isSymbolicLink()){result.links++;continue;}if(stat.isDirectory()){
    const dir=opendirSync(file);try{let entry;while((entry=dir.readSync())){
     if(result.entries+pending.length>=limit){result.complete=false;result.errors.push({path:relative(root,file),code:'ENTRY_LIMIT'});break;}
     pending.push(join(file,entry.name));
    }}finally{dir.closeSync();}if(!result.complete)break;
   }else if(stat.isFile()){result.bytes+=stat.size;result.files++;}
  }catch(error){result.complete=false;if(result.errors.length<20)result.errors.push({path:relative(root,file),code:error.code??'READ_FAILED'});}
 }
 return result;
}
function eligible(options,runId){const run=options.runs.find(item=>item.id===runId);
 if(!uuid.test(runId)||!run||run.status!=='completed'||!run.native||run.blocked)throw changed();
 checked(options.traceRoot,runId);const logName=existsSync(join(options.traceRoot,runId,'events.jsonl'))?'events.jsonl':'events.jsonl.gz',journalPath=checked(options.traceRoot,runId+'/'+logName),journal=lstatSync(journalPath),snapshotPath=checked(options.traceRoot,runId+'/snapshot.json'),snapshot=lstatSync(snapshotPath);
 if(!journal.isFile()||journal.size>64*1024*1024)throw changed();
 if(!snapshot.isFile()||snapshot.size>8*1024*1024)throw changed();
 const record=readRun(options.traceRoot,runId);
 if(identity(journal)!==identity(lstatSync(journalPath))||identity(snapshot)!==identity(lstatSync(snapshotPath)))throw changed();
 if(!record||record.integrity!=='ok'||record.status!=='completed'||record.snapshot.executionTarget?.kind!=='local'||unresolvedOperations(record.events).length)throw changed();
 return record;
}
function workspaceEnumeration(root,limit=1000){
 const ids=[];if(!root||!existsSync(root))return {ids,complete:true};checked(root);const dir=opendirSync(root);let entries=0,complete=true;
 try{let entry;while((entry=dir.readSync())){if(entries++>=limit){complete=false;break;}if(uuid.test(entry.name))ids.push(entry.name);}}finally{dir.closeSync();}
 return {ids,complete};
}
export function workspaceRunIds(root,limit=1000){return workspaceEnumeration(root,limit).ids;}
export function workspaceCopyCandidates(options){
 const candidates=[],protectedRuns=[];if(!options.workspaceRoot||!existsSync(options.workspaceRoot))return {candidates,protectedRuns};
 try{checked(options.workspaceRoot);}catch{return {candidates,protectedRuns:[{runId:'',reason:'工作区目录含链接或无法核对'}]};}
 const enumeration=workspaceEnumeration(options.workspaceRoot);if(!enumeration.complete)protectedRuns.push({runId:'',reason:'仅核对前 1000 个工作区条目；其余保留'});
 for(const runId of enumeration.ids){
  try{
   eligible(options,runId);const root=checked(options.workspaceRoot,runId);if(!lstatSync(root).isDirectory())throw changed();
   const scan=scanStorage(root,512);if(!scan.complete||scan.links)throw changed();
   const pending=[root],runCandidates=[];let retained=0,entries=0;
   while(pending.length){const dir=opendirSync(pending.pop());try{let entry;while((entry=dir.readSync())){
    if(++entries>512)throw changed();const full=join(dir.path,entry.name),stat=lstatSync(full);if(stat.isDirectory()){pending.push(full);continue;}
    const path=relative(root,full).split(sep).join('/');
    try{const copy=fileProof(root,path),canonical=fileProof(join(options.traceRoot,runId,'artifacts'),path);
     if(copy.bytes!==canonical.bytes||copy.sha256!==canonical.sha256)throw changed();
     runCandidates.push({runId,path,...copy,canonicalIdentity:canonical.identity});
    }catch{retained++;}
   }}finally{dir.closeSync();}}
   if(candidates.length+runCandidates.length>4096){protectedRuns.push({runId,reason:'清单已达 4096 文件上限；剩余现场保留'});break;}
   candidates.push(...runCandidates);if(retained)protectedRuns.push({runId,reason:`${retained} 个文件无相同交付副本或不允许回收`});
  }catch{protectedRuns.push({runId,reason:'活动、失败、未知、未登记或档案/路径无法核对，保留现场'});}
 }
 return {candidates,protectedRuns};
}
export function validateWorkspaceCopies(options,candidates){
 if(!options.workspaceRoot||!Array.isArray(candidates)||candidates.length>4096)throw changed();
 const verified=new Set(),names=new Set();checked(options.workspaceRoot);
 for(const candidate of candidates){const {runId,path}=candidate;
  if(!verified.has(runId)){eligible(options,runId);verified.add(runId);}
  if(names.has(runId+'/'+path))throw changed();names.add(runId+'/'+path);
  try{const copy=fileProof(join(options.workspaceRoot,runId),path),canonical=fileProof(join(options.traceRoot,runId,'artifacts'),path);
   if(copy.identity!==candidate.identity||canonical.identity!==candidate.canonicalIdentity||copy.sha256!==candidate.sha256||canonical.sha256!==candidate.sha256||copy.bytes!==candidate.bytes||canonical.bytes!==candidate.bytes)throw changed();
  }catch{throw changed();}
 }
}
export function removeWorkspaceCopies(options,candidates){
 validateWorkspaceCopies(options,candidates);const result={deleted:[],bytes:0};
 try{for(const candidate of candidates){validateWorkspaceCopies(options,[candidate]);unlinkSync(checked(options.workspaceRoot,candidate.runId+'/'+candidate.path));result.deleted.push({runId:candidate.runId,path:candidate.path,bytes:candidate.bytes,sha256:candidate.sha256});result.bytes+=candidate.bytes;}}
 catch(error){throw Object.assign(error,{cleanupResult:result});}return result;
}
export function reconcileWorkspaceCopies(options,candidates){
 return candidates.map(candidate=>{
  try{eligible(options,candidate.runId);const canonical=fileProof(join(options.traceRoot,candidate.runId,'artifacts'),candidate.path);
   if(canonical.sha256!==candidate.sha256)throw changed();
   try{const copy=fileProof(join(options.workspaceRoot,candidate.runId),candidate.path);return {runId:candidate.runId,path:candidate.path,state:copy.sha256===candidate.sha256?'present':'changed'};}
   catch(error){if(error.code==='ENOENT'){checked(options.workspaceRoot,candidate.runId);return {runId:candidate.runId,path:candidate.path,state:'missing-copy',canonicalPreserved:true};}throw error;}
  }catch{return {runId:candidate.runId,path:candidate.path,state:'unverified'};}
 });
}
export const MIN_STORAGE_FREE_BYTES=256*1024*1024;
export function assertStorageHeadroom(root,minFreeBytes=MIN_STORAGE_FREE_BYTES){
 let at=resolve(root);while(!existsSync(at)){const parent=resolve(at,'..');if(parent===at)throw Error('存储路径无法核对');at=parent;}
 const stat=statfsSync(at),freeBytes=stat.bavail*stat.bsize;
 if(freeBytes<minFreeBytes)throw Object.assign(Error('磁盘可用空间不足 256 MiB，已停止新增工作；请在设置与数据管理核对容量。'),{code:'STORAGE_FREE_LIMIT'});
 return {freeBytes,minFreeBytes};
}
