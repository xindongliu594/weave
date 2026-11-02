import {existsSync,lstatSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve,parse,relative,sep} from 'node:path';import {createHash} from 'node:crypto';import {gzipSync,gunzipSync} from 'node:zlib';
import {readRun} from './trace-store.mjs';import {unresolvedOperations} from './recovery.mjs';
import {withArchiveMutationSync} from './archive-writer-scope.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex'),same=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,stat.nlink].join(':'),hex=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const changed=()=>Object.assign(Error('日志、快照或归档状态已变化，原数据保留，请重新核对。'),{code:'JOURNAL_ARCHIVE_CHANGED'});
function archivePayload(raw,candidate){
 const compressed=gzipSync(raw),metadata=JSON.stringify({version:1,originalBytes:raw.length,sha256:candidate.sha256,snapshotSha256:candidate.snapshotSha256,compressedBytes:compressed.length,compressedSha256:sha(compressed),createdAt:new Date().toISOString()}),metadataBytes=Buffer.byteLength(metadata),savedBytes=raw.length-compressed.length-metadataBytes;
 if(savedBytes<=0)throw Object.assign(Error('日志过小，压缩与元数据没有净节省，原日志保留。'),{code:'JOURNAL_ARCHIVE_NO_BENEFIT'});
 return {compressed,metadata,metadataBytes,savedBytes};
}
function ordinary(file,maxBytes){let at=parse(resolve(file)).root;for(const part of relative(at,resolve(file)).split(sep).filter(Boolean)){at=join(at,part);const s=lstatSync(at);if(s.isSymbolicLink()||s.isFile()&&s.nlink!==1)throw changed();}const s=lstatSync(file);if(!s.isFile()||s.size>maxBytes)throw changed();return s;}
export function assertJournalWritable(dir){if(existsSync(join(dir,'events.jsonl.gz'))||existsSync(join(dir,'journal-archive.json')))throw Object.assign(Error('完成日志已封存，不允许追加；原事件仍可查看。'),{code:'JOURNAL_ARCHIVED'});}
export function readJournal(dir){
 const plain=join(dir,'events.jsonl');if(existsSync(plain))return readFileSync(plain,'utf8');
 const compressed=join(dir,'events.jsonl.gz'),metadata=join(dir,'journal-archive.json');ordinary(compressed,64*1024*1024);ordinary(metadata,16384);
 const info=JSON.parse(readFileSync(metadata,'utf8'));
 if(info.version!==1||!Number.isSafeInteger(info.originalBytes)||info.originalBytes<0||info.originalBytes>128*1024*1024||![info.sha256,info.compressedSha256,info.snapshotSha256].every(value=>hex.test(value)))throw changed();
 const bytes=readFileSync(compressed);if(sha(bytes)!==info.compressedSha256||bytes.length!==info.compressedBytes)throw changed();
 ordinary(join(dir,'snapshot.json'),8*1024*1024);if(sha(readFileSync(join(dir,'snapshot.json')))!==info.snapshotSha256)throw changed();
 const raw=gunzipSync(bytes,{maxOutputLength:128*1024*1024});if(raw.length!==info.originalBytes||sha(raw)!==info.sha256)throw changed();return raw.toString('utf8');
}
export function journalArchiveCandidate(root,runId){
 if(!uuid.test(runId))throw changed();const dir=join(resolve(root),runId);if(existsSync(join(dir,'events.jsonl.gz'))||existsSync(join(dir,'journal-archive.json')))throw changed();
 const file=join(dir,'events.jsonl'),stat=ordinary(file,128*1024*1024),snapshot=join(dir,'snapshot.json'),snapshotStat=ordinary(snapshot,8*1024*1024);
 const bytes=readFileSync(file),snapshotBytes=readFileSync(snapshot),record=readRun(root,runId);
 if(same(stat)!==same(lstatSync(file))||same(snapshotStat)!==same(lstatSync(snapshot))||!record||record.status!=='completed'||record.integrity!=='ok'||unresolvedOperations(record.events).length)throw changed();
 const candidate={runId,bytes:stat.size,sha256:sha(bytes),identity:same(stat),snapshotSha256:sha(snapshotBytes),snapshotIdentity:same(snapshotStat)};archivePayload(bytes,candidate);return candidate;
}
function durable(file,value){const fd=openSync(file,'wx',0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}}
function syncDirectory(dir){if(process.platform==='win32')return;const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export function archiveJournal(root,candidate){
 return withArchiveMutationSync(root,candidate.runId,'maintenance',()=>{
 const current=journalArchiveCandidate(root,candidate.runId);if(Object.entries(current).some(([key,value])=>candidate[key]!==value))throw changed();
 const dir=join(resolve(root),candidate.runId),file=join(dir,'events.jsonl'),raw=readFileSync(file),{compressed,metadata,metadataBytes,savedBytes}=archivePayload(raw,candidate);
 if(compressed.length>64*1024*1024||sha(gunzipSync(compressed,{maxOutputLength:128*1024*1024}))!==candidate.sha256)throw changed();
 // Durable gzip + manifest precede the only unlink. A crash with both files keeps the original authoritative.
 durable(join(dir,'events.jsonl.gz'),compressed);durable(join(dir,'journal-archive.json'),metadata);syncDirectory(dir);
 if(same(ordinary(file,128*1024*1024))!==candidate.identity||sha(readFileSync(file))!==candidate.sha256||same(ordinary(join(dir,'snapshot.json'),8*1024*1024))!==candidate.snapshotIdentity)throw changed();
 // Verify saved bytes, not only the in-memory gzip.
 ordinary(join(dir,'events.jsonl.gz'),64*1024*1024);ordinary(join(dir,'journal-archive.json'),16384);
 if(readFileSync(join(dir,'journal-archive.json'),'utf8')!==metadata||sha(gunzipSync(readFileSync(join(dir,'events.jsonl.gz')),{maxOutputLength:128*1024*1024}))!==candidate.sha256)throw changed();
 unlinkSync(file);syncDirectory(dir);return {runId:candidate.runId,originalBytes:raw.length,compressedBytes:compressed.length,metadataBytes,savedBytes,sha256:candidate.sha256};
 });
}
