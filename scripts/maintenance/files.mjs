import {lstatSync,realpathSync,openSync,readSync,closeSync,fstatSync,mkdirSync,writeFileSync,renameSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve,parse,relative,sep,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {MAX_INPUT_BYTES,MAX_REPORT_BYTES,REPORT_FORMAT} from './health.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};

export function plainPath(path){
 const target=resolve(path);let current=parse(target).root;
 for(const part of relative(current,target).split(sep).filter(Boolean)){current=join(current,part);const s=lstatSync(current);if(s.isSymbolicLink()||current!==target&&!s.isDirectory())fail('PATH_NOT_REGULAR');}
 if(realpathSync(target).toLowerCase()!==target.toLowerCase())fail('PATH_NOT_REGULAR');
 return target;
}
const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.nlink].join(':');
export function readEvidence(path,maxBytes=MAX_INPUT_BYTES){
 // Check the leaf first so hardlinks and special files are never opened.
 const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)fail('EVIDENCE_NOT_REGULAR');
 if(before.size>maxBytes)fail('EVIDENCE_TOO_LARGE');plainPath(path);
 const fd=openSync(path,'r');try{
  const opened=fstatSync(fd);if(identity(opened)!==identity(before))fail('EVIDENCE_CHANGED');
  const bytes=Buffer.alloc(before.size+1),count=readSync(fd,bytes,0,bytes.length,0);
  if(count!==before.size||identity(fstatSync(fd))!==identity(before)||identity(lstatSync(path))!==identity(before))fail('EVIDENCE_CHANGED');
  const data=bytes.subarray(0,count);let parsed;try{parsed=JSON.parse(data.toString('utf8'));}catch{fail('EVIDENCE_INVALID_JSON');}
  return {data:parsed,sha256:createHash('sha256').update(data).digest('hex')};
 }finally{closeSync(fd);}
}
export function contains(parent,child){const path=relative(resolve(parent),resolve(child));return path===''||path!=='..'&&!path.startsWith('..'+sep)&&!parse(path).root;}

/** Only two fixed report slots can be replaced; no directory sweep or business deletion. */
export function saveReport(directory,text){
 if(Buffer.byteLength(text)>MAX_REPORT_BYTES)fail('REPORT_TOO_LARGE');
 try{plainPath(directory);}catch(error){if(error.code!=='ENOENT')throw error;const parent=resolve(directory,'..');plainPath(parent);mkdirSync(directory,{mode:0o700});plainPath(directory);}
 if(!lstatSync(directory).isDirectory())fail('REPORT_DIRECTORY_REQUIRED');
 const lock=join(directory,'.maintenance-lock');mkdirSync(lock,{mode:0o700});
 let temporary;
 try{
  const slots=[0,1].map(index=>{const path=join(directory,`report-${index}.json`);try{const value=readEvidence(path,MAX_REPORT_BYTES).data;if(value.format!==REPORT_FORMAT||value.scope!=='offline-read-only'||!Number.isFinite(Date.parse(value.checkedAt)))fail('REPORT_SLOT_NOT_OWNED');return {path,time:Date.parse(value.checkedAt)};}catch(error){if(error.code==='ENOENT')return {path,time:-Infinity};throw error;}});
  const target=slots.sort((a,b)=>a.time-b.time)[0].path;
  temporary=join(directory,`.maintenance-${randomUUID()}.tmp`);writeFileSync(temporary,text,{flag:'wx',mode:0o600});
  plainPath(directory);renameSync(temporary,target);temporary=undefined;
 }finally{if(temporary)unlinkSync(temporary);rmdirSync(lock);}
}
