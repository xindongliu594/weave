import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {isProxy} from 'node:util/types';
import {gunzipSync} from 'node:zlib';
import {assertArchiveSourceScope,type ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {readRun,redact,type TraceEvent} from '../../../services/agent-runtime/trace-store.mjs';
import {AppError} from './provider.ts';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hex=/^[a-f0-9]{64}$/;
function invalid():never{throw new AppError(409,'任务恢复来源档案无效','TASK_RECOVERY_ARCHIVE_INVALID');}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
// This fact projection accepts 8 MiB snapshots, 32 MiB full journals (below
// readJournal's 128 MiB), 250k JSON nodes/structural tokens and depth 128.
// Exceeding any ceiling rejects the ENTIRE
// prefix, never truncates it or writes a repair/compaction to the source.
const snapshotLimit=8*1024*1024,journalLimit=32*1024*1024,eventLimit=100000,depthLimit=128,nodeLimit=250000;

type JsonObject=Record<string,any>;
export type TaskRecoveryArchiveFacts={
  snapshot:JsonObject;
  events:TraceEvent[];
  cursor:{seq:number;eventSha256:string;prefixSha256:string;snapshotSha256:string};
};

function assertJson(value:unknown,budget:{nodes:number;bytes:number},depth=0,ancestors=new Set<object>()):void{
  if(++budget.nodes>nodeLimit||depth>depthLimit)invalid();
  const account=(encoded:string)=>{budget.bytes-=Buffer.byteLength(encoded);if(budget.bytes<0)invalid();};
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'){
    if(typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)))invalid();
    if(typeof value==='string'&&Buffer.byteLength(value)>budget.bytes)invalid();
    account(JSON.stringify(value));return;
  }
  if(typeof value!=='object'||isProxy(value)||ancestors.has(value))return invalid();
  const array=Array.isArray(value);
  if(Object.getPrototypeOf(value)!==(array?Array.prototype:Object.prototype))invalid();
  // Do not materialize millions of array index strings merely to reject them.
  if(array&&(value as unknown[]).length>nodeLimit-budget.nodes)invalid();
  const keys=Reflect.ownKeys(value);
  if(keys.length>nodeLimit-budget.nodes+(array?1:0))invalid();
  if(array&&(keys.length!==(value as unknown[]).length+1||!keys.includes('length')))invalid();
  account(array?'[]':'{}');let entries=0;
  ancestors.add(value);
  for(const key of keys){
    if(array&&key==='length')continue;
    if(typeof key!=='string'||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=(value as unknown[]).length))invalid();
    const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
    if(!descriptor.enumerable||!('value' in descriptor))invalid();
    if(entries++)account(',');
    if(!array){if(Buffer.byteLength(key)>budget.bytes)invalid();account(JSON.stringify(key)+':');}
    assertJson(descriptor.value,budget,depth+1,ancestors);
  }
  ancestors.delete(value);
}
function checkedJson(value:unknown,maxBytes:number):void{
  // Account while walking, not after expanding a shared DAG with stringify.
  assertJson(value,{nodes:0,bytes:maxBytes});
  const encoded=JSON.stringify(value);
  if(typeof encoded!=='string'||Buffer.byteLength(encoded)>maxBytes||!isDeepStrictEqual(value,JSON.parse(encoded)))invalid();
}
// Conservative allocation precheck only, not a JSON parser. Quoted/escaped
// delimiters are data; real syntax validation remains JSON.parse/readRun's job.
// This runs BEFORE those parsers can allocate an unbounded wide array/object.
function precheckRawJson(text:string):void{
  let depth=0,tokens=0,quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}
    if(c==='{'||c==='['){depth++;tokens++;}
    else if(c==='}'||c===']'){depth--;tokens++;}
    else if(c===','||c===':')tokens++;
    if(depth<0||depth>depthLimit||tokens>nodeLimit)invalid();
  }
  if(quoted||depth!==0)invalid();
}
const object=(value:unknown):value is JsonObject=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonicalJson=(v:any):string=>Array.isArray(v)?'['+v.map(canonicalJson).join(',')+']':v&&typeof v==='object'?
  '{'+Object.keys(v).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(v[key])).join(',')+'}':JSON.stringify(v);
// Only called on the strict, finite JSON already checked above. This new
// recursive digest does not change any existing checkpoint/manifest digest.
const digest=(value:unknown)=>sha(canonicalJson(value));

function validCreatedAt(value:unknown):value is string{
  if(typeof value!=='string'||value.length>64)return false;
  const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!parts)return false;
  const [,y,m,d,h,min,s,zone]=parts,year=Number(y),month=Number(m),day=Number(d);
  const date=new Date(0);date.setUTCFullYear(year,month,0);
  return month>=1&&month<=12&&day>=1&&day<=date.getUTCDate()&&Number(h)<24&&Number(min)<60&&Number(s)<60&&
    (zone==='Z'||Number(zone.slice(1,3))<=23&&Number(zone.slice(4))<60)&&Number.isFinite(Date.parse(value));
}

// The native manager verifies its lock/root identities. Inspect every archive
// path component as well: a source lifetime lock cannot make a file alias safe.
// As in the native fence, only physical local paths on its verified platforms
// are accepted; network/alternate-stream or unproved aliases fail closed.
function archiveIdentity(root:string,runId:string):string{
  if(typeof root!=='string'||!path.isAbsolute(root)||path.normalize(root)!==root||root===path.parse(root).root||root.includes('\0'))invalid();
  if(process.platform==='win32'&&(!/^[A-Za-z]:\\/.test(root)||root.slice(2).includes(':')))invalid();
  const dir=path.join(root,runId),identities:unknown[]=[];
  let at=path.parse(dir).root;
  for(const component of ['',...path.relative(at,dir).split(path.sep)]){
    at=path.join(at,component);const stat=fs.lstatSync(at,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync.native(at)!==at)invalid();
    identities.push([at,String(stat.dev),String(stat.ino),String(stat.mode)]);
  }
  const present=new Set<string>();
  for(const [name,limit] of [['snapshot.json',snapshotLimit],['events.jsonl',journalLimit],['events.jsonl.gz',64*1024*1024],['journal-archive.json',16384]] as const){
    const file=path.join(dir,name);let stat;
    try{stat=fs.lstatSync(file,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){identities.push([name,null]);continue;}throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size>BigInt(limit)||fs.realpathSync.native(file)!==file)invalid();
    present.add(name);identities.push([name,...[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].map(String)]);
  }
  if(!present.has('snapshot.json')||!present.has('events.jsonl')&&(!present.has('events.jsonl.gz')||!present.has('journal-archive.json')))invalid();
  return JSON.stringify(identities);
}

/**
 * Private fact check for the future SQL-owning source capture. sourceRunSQL is
 * ONLY its internally read {id,project_id,project_version,snapshot} projection,
 * never caller approval/history/authority. The root comes solely from the real
 * manager and its identity plus actual live source scope are asserted before
 * AND after reads. A structural clone/borrowed method cannot select a new root.
 * This pins an entire archive prefix; it does not authorize recovery, validate
 * SQL operations/permissions or issue a source approval/captureLive certificate.
 */
export function readTaskRecoveryArchive(writers:ArchiveWriterManager,sourceRunSQL:unknown):TaskRecoveryArchiveFacts{
  try{checkedJson(sourceRunSQL,snapshotLimit+4096);}catch{return invalid();}
  if(!object(sourceRunSQL)||Object.keys(sourceRunSQL).sort().join(',')!=='id,project_id,project_version,snapshot')invalid();
  const source=sourceRunSQL;
  if(typeof source.id!=='string'||!uuid.test(source.id)||typeof source.project_id!=='string'||!uuid.test(source.project_id)||
    !Number.isSafeInteger(source.project_version)||source.project_version<1||!object(source.snapshot))invalid();
  assertArchiveSourceScope(writers,source.id);
  try{
    const root=writers.traceRoot,dir=path.join(root,source.id),before=archiveIdentity(root,source.id);
    const bytes=fs.readFileSync(path.join(dir,'snapshot.json'));
    const snapshotText=new TextDecoder('utf-8',{fatal:true}).decode(bytes);precheckRawJson(snapshotText);
    const snapshot=JSON.parse(snapshotText);
    checkedJson(snapshot,snapshotLimit);
    if(!object(snapshot)||snapshot.id!==source.id||snapshot.projectId!==source.project_id||snapshot.planVersion!==source.project_version||
      snapshot.formatVersion!==1||!validCreatedAt(snapshot.createdAt))invalid();
    // createRunArchive spreads SQL AFTER its defaults, then forces id back to
    // the supplied run id. An explicit contradictory SQL id is still rejected.
    for(const field of ['id','createdAt','formatVersion']){
      if(Object.hasOwn(source.snapshot,field)&&!isDeepStrictEqual(source.snapshot[field],snapshot[field]))invalid();
    }
    const expected=redact({id:source.id,createdAt:snapshot.createdAt,formatVersion:1,...source.snapshot});
    if(!isDeepStrictEqual(snapshot,expected))invalid();

    // Validate raw UTF-8 and size/count BEFORE asking readRun to parse the full
    // journal. readRun/readJournal remain responsible for continuous seq,
    // terminal newline and compressed metadata/raw SHA integrity. Plain wins
    // when an interrupted archive leaves both forms, as in the existing reader.
    const plain=path.join(dir,'events.jsonl');
    const raw=fs.existsSync(plain)?fs.readFileSync(plain):gunzipSync(fs.readFileSync(path.join(dir,'events.jsonl.gz')),{maxOutputLength:journalLimit});
    if(raw.length>journalLimit)invalid();
    const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
    precheckRawJson(text);
    let count=0;for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10&&++count>eventLimit)invalid();
    const run=readRun(root,source.id);
    if(!run||run.integrity!=='ok'||!isDeepStrictEqual(run.snapshot,snapshot)||!run.events.length||run.events.length!==count)invalid();
    const events=run.events;
    checkedJson(events,journalLimit);
    let created=0;
    for(let i=0;i<events.length;i++){
      const event=events[i];
      if(!object(event)||event.seq!==i+1||typeof event.type!=='string'||!event.type||!Object.hasOwn(event,'data')||typeof event.at!=='string'||!validCreatedAt(event.at))invalid();
      if(event.type==='run/created'){
        created++;
        if(i!==0||!object(event.data)||typeof event.data.snapshotSha256!=='string'||!hex.test(event.data.snapshotSha256)||event.data.snapshotSha256!==sha(bytes))invalid();
      }
    }
    if(created!==1)invalid();
    const seq=events.length,snapshotSha256=sha(bytes);
    const result={snapshot,events,cursor:{seq,snapshotSha256,eventSha256:digest(events[seq-1]),prefixSha256:digest({kind:'task-source-archive-prefix',version:1,runId:source.id,throughSeq:seq,snapshotSha256,events})}};
    if(archiveIdentity(root,source.id)!==before)invalid();
    return structuredClone(result);
  }catch{return invalid();}
  finally{assertArchiveSourceScope(writers,source.id);}
}
