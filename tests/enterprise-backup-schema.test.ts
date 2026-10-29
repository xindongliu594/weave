import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createCipheriv,scryptSync} from 'node:crypto';
import {nativeManifestId} from '../services/agent-runtime/native-capabilities.mjs';
import {enterpriseTableSpecs,createEnterpriseBackup,parseEnterpriseBackup,encryptEnterpriseBackup,decryptEnterpriseBackup,
  ENTERPRISE_BACKUP_SCHEMA_ID,ENTERPRISE_BACKUP_FORMAT,ENTERPRISE_BACKUP_LIMIT_BYTES,ENTERPRISE_ENVELOPE_LIMIT_BYTES,
  type EnterpriseTableName} from '../apps/api/src/enterprise-backup-schema.ts';

const password='synthetic-backup-password';
const at='2026-10-29T01:00:00.123456Z';
function input(){return {version:2 as const,schemaId:ENTERPRISE_BACKUP_SCHEMA_ID,createdAt:'2026-10-29T01:00:00.000Z',
  source:{applicationVersion:'0.2.0',databaseId:randomUUID(),engine:'pglite' as const},
  tables:Object.fromEntries(Object.keys(enterpriseTableSpecs).map(name=>[name,[] as any[]])),
  files:{} as Record<string,string>,master:null,nativePluginBundles:{},vaultFiles:{} as Record<string,string>};}
function row(table:EnterpriseTableName,values:Record<string,unknown>){
  const spec=enterpriseTableSpecs[table];return Object.fromEntries(Object.entries(spec.columns).map(([name,[type,required]])=>[
    name,name in values?values[name]:!required?null:type==='integer'?1:type==='boolean'?false:type==='jsonb'?'{}':type==='text[]'?[]:type==='bigint'||type==='numeric'?'0':type==='timestamp with time zone'?at:type==='vector(384)'?'['+Array(384).fill(0).join(',')+']':'fixture',
  ]));
}
function fixture(){
  const value=input();
  value.tables.human_users.push(row('human_users',{id:'u',issuer:'https://id.invalid',subject:'owner',status:'active',org_role:'admin',session_epoch:'9007199254740991'}));
  value.tables.models.push(row('models',{id:'m',data:'{"model":"never-called","exact":123456789012345678901234567890}'}));
  value.tables.usage.push(row('usage',{id:'cost',model_id:'m',project_id:null,cost:'0.000000000000000123456789',purpose:'synthetic-only'}));
  value.tables.knowledge_embeddings.push(row('knowledge_embeddings',{chunk_id:'chunk',model_version:'fixture',title:'',embedding:'['+Array(384).fill(0).join(',')+']'}));
  value.files[randomUUID()+'/artifacts/readme.txt']=Buffer.from('synthetic delivery').toString('base64');
  value.vaultFiles['company/方法.md']=Buffer.from('合成经验').toString('base64');
  return createEnterpriseBackup(value);
}
function invalid(work:()=>unknown){assert.throws(work,(error:any)=>error.status===422&&typeof error.code==='string');}

test('strict v2 encryption preserves decimal text, large epochs, timestamps, vectors and file manifests',async()=>{
  const value=fixture(),envelope=await encryptEnterpriseBackup(value,password);
  assert.equal(envelope.format,ENTERPRISE_BACKUP_FORMAT);
  assert.deepEqual(Object.keys(envelope).sort(),['cipher','data','format','iv','kdf','salt','tag']);
  assert.equal(JSON.stringify(envelope).includes('synthetic delivery'),false);
  assert.deepEqual(await decryptEnterpriseBackup(envelope,password),value);
  assert.equal(value.tables.usage[0].cost,'0.000000000000000123456789');
  assert.equal(value.tables.human_users[0].session_epoch,'9007199254740991');
  assert.equal(value.tables.human_users[0].created_at,at);
  assert.equal(value.tables.models[0].data,'{"model":"never-called","exact":123456789012345678901234567890}');
  assert.equal(value.manifest.tables.usage.rows,1);
  assert.equal(value.manifest.files.length,2);
  await assert.rejects(decryptEnterpriseBackup(envelope,'wrong-backup-password'),(error:any)=>error.status===422);
  await assert.rejects(decryptEnterpriseBackup({...envelope,cipher:'aes-128-gcm'},password),(error:any)=>error.status===422);
  await assert.rejects(decryptEnterpriseBackup({...envelope,tag:Buffer.alloc(16).toString('base64')},password),(error:any)=>error.status===422);
});

test('unknown schema, missing/extra tables, credential columns and altered manifests are rejected',()=>{
  const original=fixture();
  for(const mutate of [
    (x:any)=>x.schemaId='future-schema',
    (x:any)=>delete x.tables.audit_outbox,
    (x:any)=>x.tables.human_sessions=[],
    (x:any)=>x.tables.human_users[0].extra='unexpected',
    (x:any)=>x.tables.human_users[0].session_epoch=9007199254740991,
    (x:any)=>x.tables.usage[0].cost=0.0000001,
    (x:any)=>x.manifest.tables.usage.sha256='0'.repeat(64),
    (x:any)=>x.manifest.schemaSha256='0'.repeat(64),
    (x:any)=>x.files[Object.keys(x.files)[0]]=Buffer.from('changed').toString('base64'),
  ]){const value=structuredClone(original);mutate(value);invalid(()=>parseEnterpriseBackup(value));}
  assert.equal('token_hash' in enterpriseTableSpecs.local_devices.columns,false);
  assert.equal('claim_token' in enterpriseTableSpecs.local_operations.columns,false);
  const device=input();device.tables.local_devices.push({...row('local_devices',{id:'d',enabled:false}),token_hash:'secret'});
  invalid(()=>createEnterpriseBackup(device));
});

test('duplicate identities and broken or cyclic foreign-key chains cannot enter a preserving import',()=>{
  const duplicate=input();const user=row('human_users',{id:'u',issuer:'i',subject:'s'});
  duplicate.tables.human_users.push(user,{...user});invalid(()=>createEnterpriseBackup(duplicate));
  duplicate.tables.human_users[1]={...user,id:'other'};invalid(()=>createEnterpriseBackup(duplicate));
  const missing=input();missing.tables.department_memberships.push(row('department_memberships',{department_id:'missing',user_id:'absent'}));
  invalid(()=>createEnterpriseBackup(missing));
  const cycle=input();cycle.tables.human_audit_events.push(
    row('human_audit_events',{id:'a',requested_by_audit_id:'b'}),row('human_audit_events',{id:'b',requested_by_audit_id:'a'}));
  invalid(()=>createEnterpriseBackup(cycle));
});

test('portable paths reject traversal, Windows aliases, alternate data streams and case collisions',()=>{
  for(const path of ['../out','/root','C:/root','a\\b','a//b','a/./b','a/../b','a/b:stream','a/NUL.txt','a/con','a/LPT9','a/COM¹.txt','a/CONIN$','a/CON .txt','a/name.','a/name ','a/\0b','a/\ud800.txt','a/a?.txt','a/<bad>']){
    const value=input();value.files[path]='';invalid(()=>createEnterpriseBackup(value));
  }
  for(const pair of [['a/File.txt','A/file.TXT'],['a/é.txt','a/e\u0301.txt'],['a','a/b'],['a/b','a'],['a','a-b','a/b']]){
    const value=input();for(const path of pair)value.files[path]='';invalid(()=>createEnterpriseBackup(value));
  }
  const value=input();value.vaultFiles['ok/资料.md']='YQ';invalid(()=>createEnterpriseBackup(value));
  value.vaultFiles['ok/资料.md']='YQ==\n';invalid(()=>createEnterpriseBackup(value));
});

test('native bundles reuse the fixed manifest validator and bind all compressed/code/metadata bytes',async()=>{
  const code=Buffer.from('export default {};'),compressed=gzipSync(code),metadata=Buffer.from('{"name":"fixture","version":"1.0.0"}');
  const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const manifest={format:'dsh-native-tools-v1',namespace:'fixture',package:'fixture',version:'1.0.0',dshVersion:'0.1.5-rc.1',lockSha256:'1'.repeat(64),
    source:{kind:'company',reference:'synthetic-only'},config:{},bundle:{bytes:compressed.length,sha256:sha(compressed),codeSha256:sha(code),metadataSha256:sha(metadata)},
    tools:[{name:'plugin__fixture__read',originalName:'read',description:'synthetic-only',parameters:{type:'object'},files:{read:[],write:[]}}]};
  const id=nativeManifestId(manifest),bundle={manifest,compressed:compressed.toString('base64'),metadata:metadata.toString('base64')};
  const value=createEnterpriseBackup({...input(),nativePluginBundles:{[id]:bundle}});
  assert.equal(value.manifest.files.length,3);
  assert.deepEqual(await decryptEnterpriseBackup(await encryptEnterpriseBackup(value,password),password),value);
  invalid(()=>createEnterpriseBackup({...input(),nativePluginBundles:{[id]:{...bundle,metadata:Buffer.from('changed').toString('base64')}}}));
  invalid(()=>createEnterpriseBackup({...input(),nativePluginBundles:{[id]:{...bundle,compressed:compressed.subarray(1).toString('base64')}}}));
});

test('SQL null and JSON null remain distinct and fixed metadata cannot be mutated',()=>{
  const raw=input();raw.tables.models.push(row('models',{id:'m',data:'null',credential:null}));
  const value=createEnterpriseBackup(raw);assert.equal(value.tables.models[0].data,'null');assert.equal(value.tables.models[0].credential,null);
  assert.throws(()=>{(enterpriseTableSpecs.models.columns.id as any)[0]='numeric';},TypeError);
});

test('size checks precede crypto and decompression is bounded even for an authenticated compressed bomb',async()=>{
  const value=input();value.tables.activity.push(row('activity',{id:'padding',kind:'fixture',title:''}));
  const empty=createEnterpriseBackup(value),emptySize=Buffer.byteLength(JSON.stringify(empty));
  value.tables.activity[0].title='x'.repeat(ENTERPRISE_BACKUP_LIMIT_BYTES-emptySize);
  const boundary=createEnterpriseBackup(value);assert.equal(Buffer.byteLength(JSON.stringify(boundary)),ENTERPRISE_BACKUP_LIMIT_BYTES);
  value.tables.activity[0].title+='x';invalid(()=>createEnterpriseBackup(value));
  const envelope=await encryptEnterpriseBackup(fixture(),password);
  await assert.rejects(decryptEnterpriseBackup({...envelope,data:'x'.repeat(ENTERPRISE_ENVELOPE_LIMIT_BYTES)},password),(error:any)=>error.code==='BACKUP_SIZE_LIMIT');
  const salt=Buffer.alloc(16,1),iv=Buffer.alloc(12,2),cipher=createCipheriv('aes-256-gcm',scryptSync(password,salt,32),iv);
  cipher.setAAD(Buffer.from(JSON.stringify({format:ENTERPRISE_BACKUP_FORMAT,kdf:envelope.kdf,cipher:envelope.cipher})));
  const compressed=gzipSync(Buffer.from('{"padding":"'+'x'.repeat(ENTERPRISE_BACKUP_LIMIT_BYTES)+'"}'));
  const data=Buffer.concat([cipher.update(compressed),cipher.final()]);
  await assert.rejects(decryptEnterpriseBackup({...envelope,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')},password),(error:any)=>error.status===422&&error.code==='BACKUP_DECRYPT_FAILED');
});

test('row/file limits and invalid scalar codecs are rejected without evaluating untrusted objects',()=>{
  const many=input();many.tables.activity=Array.from({length:100001},(_,n)=>row('activity',{id:String(n)}));invalid(()=>createEnterpriseBackup(many));
  const files=input();for(let n=0;n<100001;n++)files.files['a/'+n]='';invalid(()=>createEnterpriseBackup(files));
  for(const [field,value] of [['session_epoch','9223372036854775808'],['version',1.1],['created_at','2026-02-30T00:00:00Z'],['status',{}]] as const){
    const raw=input();raw.tables.human_users.push(row('human_users',{id:'u',issuer:'i',subject:'s',[field]:value}));invalid(()=>createEnterpriseBackup(raw));
  }
  let evaluated=false;const raw=input();Object.defineProperty(raw,'master',{enumerable:true,get(){evaluated=true;return null;}});
  invalid(()=>createEnterpriseBackup(raw));assert.equal(evaluated,false);
});
