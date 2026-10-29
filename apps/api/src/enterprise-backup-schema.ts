import {createHash,randomBytes,createCipheriv,createDecipheriv,scrypt as scryptCallback} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {gzipSync,gunzipSync} from 'node:zlib';
import {nativeManifestId} from '../../../services/agent-runtime/native-capabilities.mjs';
import {enterpriseTableSpecs,type EnterpriseTableName,type EnterpriseTableSpec,type EnterpriseColumnType} from './enterprise-backup-tables.ts';
export {enterpriseTableSpecs,type EnterpriseTableName};

import {ENTERPRISE_BACKUP_SCHEMA_ID,ENTERPRISE_BACKUP_FORMAT,ENTERPRISE_BACKUP_LIMIT_BYTES,ENTERPRISE_ENVELOPE_LIMIT_BYTES} from '../../../packages/contracts/backup.ts';
export {ENTERPRISE_BACKUP_SCHEMA_ID,ENTERPRISE_BACKUP_FORMAT,ENTERPRISE_BACKUP_LIMIT_BYTES,ENTERPRISE_ENVELOPE_LIMIT_BYTES};
const MAX_ROWS=100000,MAX_TOTAL_ROWS=500000,MAX_FILES=100000;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const kdfOptions={N:16384,r:8,p:1,maxmem:64*1024*1024};
const deriveKey=(password:string,salt:Buffer)=>new Promise<Buffer>((resolve,reject)=>{
  scryptCallback(password,salt,32,kdfOptions,(error,key)=>error?reject(error):resolve(key));
});
const header={format:ENTERPRISE_BACKUP_FORMAT,kdf:'scrypt-n16384-r8-p1',cipher:'aes-256-gcm'} as const;
const aad=Buffer.from(JSON.stringify(header));
const tableNames=Object.keys(enterpriseTableSpecs) as EnterpriseTableName[];
const hex=/^[a-f0-9]{64}$/;
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
class BackupError extends Error {status=422;constructor(public code:string){super(code==='BACKUP_SIZE_LIMIT'?'备份超出在线大小或条目限制。':'企业备份格式、版本或内容校验失败。');}}
function fail(code='BACKUP_FORMAT_INVALID'):never{throw new BackupError(code);}
function bounded(size:number,limit:number){if(size>limit)fail('BACKUP_SIZE_LIMIT');}

export type EnterpriseBackupManifest={schemaSha256:string;tables:Record<EnterpriseTableName,{rows:number;sha256:string}>;
  files:{root:'trace'|'vault'|'bundle';path:string;bytes:number;sha256:string}[]};
export type EnterpriseBackupV2={version:2;schemaId:typeof ENTERPRISE_BACKUP_SCHEMA_ID;createdAt:string;
  source:{applicationVersion:string;databaseId:string;engine:'pglite'|'postgresql'};
  tables:Record<EnterpriseTableName,Record<string,unknown>[]>;files:Record<string,string>;master:string|null;
  nativePluginBundles:Record<string,{manifest:any;compressed:string;metadata:string}>;vaultFiles:Record<string,string>;manifest:EnterpriseBackupManifest};
export type EncryptedEnterpriseBackupV2=typeof header&{salt:string;iv:string;tag:string;data:string};
type BackupInput=Omit<EnterpriseBackupV2,'manifest'>;

/** Inspect descriptors before reading: package objects never execute getters or toJSON. */
function safeCopy(value:unknown,limit:number):any{
  let size=0,nodes=0;const active=new Set<object>();
  function copy(item:any,depth:number):any{
    if(++nodes>4000000||depth>64)fail('BACKUP_SIZE_LIMIT');
    if(item===null||typeof item==='boolean')return item;
    if(typeof item==='number'){if(!Number.isFinite(item))fail();return item;}
    if(typeof item==='string'){size+=Buffer.byteLength(item);bounded(size,limit);return item;}
    if(typeof item!=='object'||active.has(item))fail();
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail();
    active.add(item);const output:any=array?[]:{};let entries=0;
    for(const key of Reflect.ownKeys(item)){
      if(array&&key==='length')continue;
      const descriptor=Object.getOwnPropertyDescriptor(item,key)!;
      if(typeof key!=='string'||!descriptor.enumerable||!('value'in descriptor)||(array&&!/^(0|[1-9]\d*)$/.test(key)))fail();
      size+=Buffer.byteLength(key);bounded(size,limit);entries++;
      Object.defineProperty(output,key,{value:copy(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    if(array&&entries!==item.length)fail();active.delete(item);return output;
  }
  return copy(value,0);
}
function record(value:any):value is Record<string,any>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function exact(value:any,keys:readonly string[]){if(!record(value)||!isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort()))fail();}
function canonical(value:any):any{return Array.isArray(value)?value.map(canonical):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
export const enterpriseSchemaSha256=hash(JSON.stringify(canonical(enterpriseTableSpecs)));
function jsonHash(value:any){return hash(JSON.stringify(canonical(value)));}
function base64(value:unknown,expectedBytes?:number):Buffer{
  if(typeof value!=='string'||value.length%4!==0||/[^A-Za-z0-9+/=]/.test(value))fail();
  const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value||(expectedBytes!==undefined&&bytes.length!==expectedBytes))fail();return bytes;
}
function timestamp(value:unknown):boolean{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value))return false;
  const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString().slice(0,19)===value.slice(0,19);
}
function scalar(type:EnterpriseColumnType,value:any,required:boolean){
  if(value===null){if(required)fail();return;}
  switch(type){
    case 'text':if(typeof value!=='string'||value.includes('\0'))fail();break;
    case 'boolean':if(typeof value!=='boolean')fail();break;
    case 'integer':if(!Number.isInteger(value)||value< -2147483648||value>2147483647)fail();break;
    case 'bigint':if(typeof value!=='string'||value.length>20||!/^[-]?(?:0|[1-9]\d*)$/.test(value)||BigInt(value)<-9223372036854775808n||BigInt(value)>9223372036854775807n)fail();break;
    case 'numeric':if(typeof value!=='string'||!/^[-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))fail();break;
    // SQL NULL and jsonb 'null', and arbitrarily precise JSON numbers, must remain distinct.
    case 'jsonb':if(typeof value!=='string')fail();try{JSON.parse(value);}catch{fail();}break;
    case 'text[]':if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||item.includes('\0')))fail();break;
    case 'timestamp with time zone':if(!timestamp(value))fail();break;
    case 'vector(384)':{
      if(typeof value!=='string')fail();let vector;try{vector=JSON.parse(value);}catch{fail();}
      if(!Array.isArray(vector)||vector.length!==384||vector.some(n=>typeof n!=='number'||!Number.isFinite(n)))fail();break;
    }
  }
}
const keyOf=(row:Record<string,unknown>,columns:readonly string[])=>JSON.stringify(columns.map(column=>row[column]));
function checkRows(tables:EnterpriseBackupV2['tables']){
  exact(tables,tableNames);let total=0;
  const indexes=new Map<string,Set<string>>();
  const index=(table:EnterpriseTableName,columns:readonly string[])=>{
    const id=JSON.stringify([table,columns]);let values=indexes.get(id);
    if(!values){values=new Set(tables[table].map(row=>keyOf(row,columns)));indexes.set(id,values);}return values;
  };
  for(const name of tableNames){
    const spec:EnterpriseTableSpec=enterpriseTableSpecs[name],rows=tables[name];if(!Array.isArray(rows))fail();
    bounded(rows.length,MAX_ROWS);total+=rows.length;bounded(total,MAX_TOTAL_ROWS);
    for(const row of rows){exact(row,Object.keys(spec.columns));for(const [column,[type,required]]of Object.entries(spec.columns))scalar(type,row[column],required);}
    for(const columns of [spec.primaryKey,...spec.uniqueKeys]){
      const keys=new Set<string>();for(const row of rows){if(columns.some(column=>row[column]===null)){if(columns===spec.primaryKey)fail();continue;}
        const key=keyOf(row,columns);if(keys.has(key))fail();keys.add(key);}
    }
  }
  for(const name of tableNames){
    const spec:EnterpriseTableSpec=enterpriseTableSpecs[name],rows=tables[name];
    for(const foreign of spec.foreignKeys){
      if(!tableNames.includes(foreign.target as EnterpriseTableName))fail();
      const target=index(foreign.target as EnterpriseTableName,foreign.targetColumns);
      for(const row of rows)if(!foreign.columns.some(column=>row[column]===null)&&!target.has(keyOf(row,foreign.columns)))fail();
      if(foreign.target!==name)continue;
      const links=new Map(rows.map(row=>[keyOf(row,foreign.targetColumns),row])),done=new Set<string>();
      for(const row of rows){const chain=new Set<string>();let next:Record<string,unknown>|undefined=row;
        while(next){const key=keyOf(next,foreign.targetColumns);if(done.has(key))break;if(chain.has(key))fail();chain.add(key);
          next=foreign.columns.some(column=>next![column]===null)?undefined:links.get(keyOf(next,foreign.columns));}
        for(const key of chain)done.add(key);}
    }
  }
}
function portablePath(path:string){
  if(!path||Buffer.byteLength(path)>1024||path.includes('\\')||/[\x00-\x1f\x7f:<>"|?*]/.test(path)||Buffer.from(path).toString('utf8')!==path)fail();
  for(const part of path.split('/')){
    const base=part.split('.')[0].replace(/ +$/,'');
    if(!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(base))fail();
  }
}
function filesManifest(value:BackupInput):EnterpriseBackupManifest['files']{
  const files:EnterpriseBackupManifest['files']=[];const paths=new Set<string>();
  function add(root:'trace'|'vault'|'bundle',path:string,bytes:Buffer){
    portablePath(path);const key=root+'/'+path.normalize('NFC').toLowerCase();if(paths.has(key))fail();paths.add(key);bounded(paths.size,MAX_FILES);
    files.push({root,path,bytes:bytes.length,sha256:hash(bytes)});
  }
  for(const [kind,entries]of [['trace',value.files],['vault',value.vaultFiles]] as const){
    if(!record(entries))fail();bounded(Object.keys(entries).length,MAX_FILES);for(const [path,content]of Object.entries(entries))add(kind,path,base64(content));
  }
  if(!record(value.nativePluginBundles))fail();bounded(Object.keys(value.nativePluginBundles).length,100);let expanded=0,compressedBytes=0;
  for(const [id,bundle]of Object.entries(value.nativePluginBundles)){
    exact(bundle,['manifest','compressed','metadata']);if(!hex.test(id))fail();
    const compressed=base64(bundle.compressed),metadata=base64(bundle.metadata);bounded(compressed.length,4*1024*1024);bounded(metadata.length,16384);
    compressedBytes+=compressed.length+metadata.length;bounded(compressedBytes,32*1024*1024);
    try{
      if(nativeManifestId(bundle.manifest)!==id||compressed.length!==bundle.manifest.bundle.bytes||hash(compressed)!==bundle.manifest.bundle.sha256||hash(metadata)!==bundle.manifest.bundle.metadataSha256)fail();
      const code=gunzipSync(compressed,{maxOutputLength:24*1024*1024});expanded+=code.length;bounded(expanded,64*1024*1024);if(hash(code)!==bundle.manifest.bundle.codeSha256)fail();
    }catch(error){if(error instanceof BackupError)throw error;fail();}
    add('bundle',id+'/manifest.json',Buffer.from(JSON.stringify(bundle.manifest)));add('bundle',id+'/bundle.gz',compressed);add('bundle',id+'/package.json',metadata);
  }
  const ordered=[...paths].sort();
  for(let n=0;n<ordered.length;n++){
    const prefix=ordered[n]+'/';let low=n+1,high=ordered.length;
    while(low<high){const middle=(low+high)>>>1;if(ordered[middle]<prefix)low=middle+1;else high=middle;}
    if(ordered[low]?.startsWith(prefix))fail();
  }
  return files.sort((a,b)=>compare(a.root+'/'+a.path,b.root+'/'+b.path));
}
function validateInput(value:any):asserts value is BackupInput{
  exact(value,['version','schemaId','createdAt','source','tables','files','master','nativePluginBundles','vaultFiles']);
  if(value.version!==2||value.schemaId!==ENTERPRISE_BACKUP_SCHEMA_ID||!timestamp(value.createdAt))fail();
  exact(value.source,['applicationVersion','databaseId','engine']);
  if(typeof value.source.applicationVersion!=='string'||!value.source.applicationVersion||value.source.applicationVersion.length>80||!['pglite','postgresql'].includes(value.source.engine)||typeof value.source.databaseId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.source.databaseId))fail();
  if(value.master!==null)base64(value.master,32);checkRows(value.tables);
}
function make(value:BackupInput):EnterpriseBackupV2{
  validateInput(value);
  const tables=Object.fromEntries(tableNames.map(name=>{
    const spec:EnterpriseTableSpec=enterpriseTableSpecs[name];const rows=[...value.tables[name]].sort((a,b)=>compare(keyOf(a,spec.primaryKey),keyOf(b,spec.primaryKey)));
    return [name,{rows:rows.length,sha256:jsonHash(rows)}];
  })) as EnterpriseBackupManifest['tables'];
  const result={...value,manifest:{schemaSha256:enterpriseSchemaSha256,tables,files:filesManifest(value)}};
  bounded(Buffer.byteLength(JSON.stringify(result)),ENTERPRISE_BACKUP_LIMIT_BYTES);return result;
}
export function createEnterpriseBackup(value:unknown):EnterpriseBackupV2{return make(safeCopy(value,ENTERPRISE_BACKUP_LIMIT_BYTES));}
export function parseEnterpriseBackup(value:unknown):EnterpriseBackupV2{
  const copy=safeCopy(value,ENTERPRISE_BACKUP_LIMIT_BYTES);exact(copy,['version','schemaId','createdAt','source','tables','files','master','nativePluginBundles','vaultFiles','manifest']);
  const {manifest,...input}=copy;const result=make(input as BackupInput);if(!isDeepStrictEqual(manifest,result.manifest))fail();return result;
}
function passphrase(value:string){if(typeof value!=='string'||value.length<12||value.length>200)fail();}
export async function encryptEnterpriseBackup(value:EnterpriseBackupV2,password:string):Promise<EncryptedEnterpriseBackupV2>{
  passphrase(password);const parsed=parseEnterpriseBackup(value),salt=randomBytes(16),iv=randomBytes(12),key=await deriveKey(password,salt);
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);const data=Buffer.concat([cipher.update(gzipSync(JSON.stringify(parsed))),cipher.final()]);
  const result={...header,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
  bounded(Buffer.byteLength(JSON.stringify(result)),ENTERPRISE_ENVELOPE_LIMIT_BYTES);return result;
}
export async function decryptEnterpriseBackup(value:unknown,password:string):Promise<EnterpriseBackupV2>{
  passphrase(password);const envelope=safeCopy(value,ENTERPRISE_ENVELOPE_LIMIT_BYTES);exact(envelope,['format','kdf','cipher','salt','iv','tag','data']);
  bounded(Buffer.byteLength(JSON.stringify(envelope)),ENTERPRISE_ENVELOPE_LIMIT_BYTES);
  if(envelope.format!==header.format||envelope.kdf!==header.kdf||envelope.cipher!==header.cipher)fail();
  const salt=base64(envelope.salt,16),iv=base64(envelope.iv,12),tag=base64(envelope.tag,16),data=base64(envelope.data);
  let plain:Buffer;
  try{const key=await deriveKey(password,salt),cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);cipher.setAuthTag(tag);
    plain=gunzipSync(Buffer.concat([cipher.update(data),cipher.final()]),{maxOutputLength:ENTERPRISE_BACKUP_LIMIT_BYTES});
  }catch{fail('BACKUP_DECRYPT_FAILED');}
  let payload;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}catch{fail();}
  return parseEnterpriseBackup(payload);
}
