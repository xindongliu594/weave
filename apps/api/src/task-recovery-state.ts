import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {isProxy} from 'node:util/types';
import {z} from 'zod';
import {redact} from '../../../services/agent-runtime/trace-store.mjs';
import {AppError} from './provider.ts';

const {validPath,canonicalManifest}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const invalid=():never=>{throw new AppError(409,'任务恢复记录格式或摘要无效','TASK_RECOVERY_STATE_INVALID');};
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const text=(max=240)=>z.string().min(1).max(max).refine(v=>v.trim()===v&&!/\p{Cc}/u.test(v));
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path=z.string().refine(v=>{try{validPath(v);return true;}catch{return false;}});
const key=z.strictObject({runId:uuid,taskId:text(),attemptId:text(),generation:positive});
const entry=z.strictObject({path,size:nonnegative.max(5*1024*1024),sha256:sha});
const manifest=z.array(entry).max(128);
const receipt=z.strictObject({mergeId:uuid,operationId:uuid,key,scopeHash:sha,beforeRevision:sha,afterRevision:sha,workRevision:sha,status:z.literal('committed')});
const head=z.strictObject({version:z.literal(1),revision:sha,manifest,mergeId:uuid.nullable(),receipt:receipt.nullable()});
const source=z.strictObject({
 version:z.literal(1),mode:z.literal('live-sql-v1'),sourceRunId:uuid,sourceHead:head,
 sourceCheckpoint:z.strictObject({key,id:uuid,sha256:sha,seq:positive}),sourceHistoryDigest:sha,
 sourceArchiveCursor:z.strictObject({seq:positive,eventSha256:sha,prefixSha256:sha,snapshotSha256:sha}),
 authority:z.strictObject({projectId:uuid,planVersion:positive,taskId:text(),contractHash:sha,permissionHash:sha,capabilityHash:sha,resourceRevision:positive,
  backend:z.strictObject({kind:z.literal('openshell'),version:z.literal('0.1.2'),gateway:text(1024),image:text(1024),policySha256:sha,fingerprint:sha})}),
});
const unsignedInitialization=z.strictObject({
 version:z.literal(1),childRunId:uuid,approvalDigest:sha,source,
 readPaths:z.array(path).max(128),writePaths:z.array(path).max(128),checkpointWorkRevision:sha,plannerScopeHash:sha,
 delta:z.array(z.strictObject({path,beforeSha256:sha.nullable(),afterSha256:sha,size:nonnegative})).max(128),initialHead:head,
});
const initialization=unsignedInitialization.extend({digest:sha});
const evidence=z.strictObject({version:z.literal(1),recoveryInitialization:initialization.nullable(),sourceHistory:z.null()});
export type TaskRecoverySource=z.infer<typeof source>;
export type TaskRecoveryInitialization=z.infer<typeof initialization>;
export type TaskRecoveryInitializationInput=z.infer<typeof unsignedInitialization>;
export type TaskRecoveryEvidenceV1=z.infer<typeof evidence>;
type Head=z.infer<typeof head>;

const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const ordered=(value:any):any=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
const digest=(value:unknown)=>hash(JSON.stringify(ordered(value)));
const approvalDigest=(value:TaskRecoverySource)=>digest({kind:'task-recovery-source',version:1,record:value});
const initializationDigest=(value:TaskRecoveryInitializationInput)=>digest({kind:'task-recovery-initialization',version:1,record:value});

// Validate before JSON.stringify: it otherwise drops undefined/symbols, invokes
// getters/toJSON and converts non-finite numbers, sparse arrays or custom objects.
function assertJson(value:unknown,ancestors=new Set<object>()):void{
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'){if(!Number.isFinite(value))invalid();return;}
 if(typeof value!=='object'||isProxy(value)||ancestors.has(value))return invalid();
 const array=Array.isArray(value);
 if(Object.getPrototypeOf(value)!==(array?Array.prototype:Object.prototype))invalid();
 const keys=Reflect.ownKeys(value);
 if(array&&(keys.length!==value.length+1||!keys.includes('length')))invalid();
 ancestors.add(value);
 for(const k of keys){
  if(array&&k==='length')continue;
  if(typeof k!=='string'||array&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=(value as unknown[]).length))invalid();
  const property=Object.getOwnPropertyDescriptor(value,k)!;
  if(!property.enumerable||!('value' in property))invalid();
  assertJson(property.value,ancestors);
 }
 ancestors.delete(value);
}
function checked<T>(value:unknown,parse:()=>T):T{
 try{
  assertJson(value);
  const encoded=JSON.stringify(value);
  if(typeof encoded!=='string'||Buffer.byteLength(encoded,'utf8')>512*1024||!isDeepStrictEqual(value,JSON.parse(encoded))||!isDeepStrictEqual(value,redact(value)))invalid();
  return parse();
 }catch{return invalid();}
}
function validatePaths(paths:string[]):void{
 const seen=new Set<string>();let previous:string|undefined;
 for(const name of paths){
  const folded=name.toLowerCase();
  if(previous!==undefined&&previous>=name||seen.has(folded)||[...seen].some(v=>v.startsWith(folded+'/')||folded.startsWith(v+'/')))invalid();
  validPath(name);seen.add(folded);previous=name;
 }
}
function validateHead(value:Head,runId:string):void{
 validatePaths(value.manifest.map(v=>v.path));
 if(value.manifest.reduce((total,v)=>total+v.size,0)>20*1024*1024||value.revision!==hash(JSON.stringify(canonicalManifest(value.manifest))))invalid();
 if(value.mergeId===null){if(value.receipt!==null)invalid();return;}
 const r=value.receipt;
 if(!r||r.mergeId!==value.mergeId||r.operationId!==value.mergeId||r.afterRevision!==value.revision||r.key.runId!==runId)invalid();
}
function validateSource(value:TaskRecoverySource):void{
 validateHead(value.sourceHead,value.sourceRunId);
 if(value.sourceHead.mergeId===null||value.sourceCheckpoint.key.runId!==value.sourceRunId||value.authority.taskId!==value.sourceCheckpoint.key.taskId||value.sourceCheckpoint.seq>value.sourceArchiveCursor.seq)invalid();
}
function validateInitialization(value:TaskRecoveryInitializationInput):void{
 validateSource(value.source);validateHead(value.initialHead,value.childRunId);
 if(value.childRunId===value.source.sourceRunId||value.initialHead.mergeId!==null||value.initialHead.receipt!==null)invalid();
 validatePaths(value.readPaths);validatePaths(value.writePaths);validatePaths(value.delta.map(v=>v.path));
 const before=new Map(value.source.sourceHead.manifest.map(v=>[v.path,v]));
 const after=new Map(value.initialHead.manifest.map(v=>[v.path,v]));
 const changed=new Set(value.delta.map(v=>v.path));
 for(const row of value.delta){
  const old=before.get(row.path),next=after.get(row.path);
  if(!value.writePaths.includes(row.path)||row.beforeSha256!==(old?.sha256??null)||!next||row.afterSha256!==next.sha256||row.size!==next.size||row.beforeSha256===row.afterSha256)invalid();
 }
 for(const row of value.source.sourceHead.manifest){
  const next=after.get(row.path);
  if(!next||!changed.has(row.path)&&!isDeepStrictEqual(row,next))invalid();
 }
 for(const row of value.initialHead.manifest)if(!changed.has(row.path)&&!before.has(row.path))invalid();
 // Cross-field validation must finish before verifying either new record digest.
 if(value.approvalDigest!==approvalDigest(value.source))invalid();
}
function validateSignedInitialization(value:TaskRecoveryInitialization):void{
 const {digest:actual,...unsigned}=value;
 validateInitialization(unsigned);
 if(actual!==initializationDigest(unsigned))invalid();
}

/** Private format/digest codec only: passing proves no source authenticity and
 * grants no recovery or execution permission. Gateway/image are identity data;
 * these functions access no files, database, model, network or device. */
export function decodeTaskRecoverySource(value:unknown):TaskRecoverySource{
 return checked(value,()=>{const parsed=source.parse(value);validateSource(parsed);return parsed;});
}
export function taskRecoveryApprovalDigest(value:unknown):string{
 return checked(value,()=>{const parsed=source.parse(value);validateSource(parsed);return approvalDigest(parsed);});
}
export function decodeTaskRecoveryInitialization(value:unknown):TaskRecoveryInitialization{
 return checked(value,()=>{const parsed=initialization.parse(value);validateSignedInitialization(parsed);return parsed;});
}
/** Accept the exact initialization record with only its digest field absent. */
export function taskRecoveryInitializationDigest(value:unknown):string{
 return checked(value,()=>{const parsed=unsignedInitialization.parse(value);validateInitialization(parsed);return initializationDigest(parsed);});
}
export function decodeTaskRecoveryEvidence(value:unknown):TaskRecoveryEvidenceV1{
 return checked(value,()=>{const parsed=evidence.parse(value);if(parsed.recoveryInitialization!==null)validateSignedInitialization(parsed.recoveryInitialization);return parsed;});
}
