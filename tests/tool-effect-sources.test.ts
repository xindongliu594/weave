import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {migrateIdentity} from '../apps/api/src/identity-schema.ts';
import {migrateNativeCapabilities,setNativeCapability} from '../apps/api/src/native-capabilities.ts';
import {migrateToolEffectContracts,ToolEffectContractService} from '../apps/api/src/tool-effect-contracts.ts';
import {nativeManifestId} from '../services/agent-runtime/native-capabilities.mjs';
import {effectDigest} from '../services/agent-runtime/tool-effects.mjs';
import type {HumanPrincipal} from '../apps/api/src/identity-types.ts';
import type {EffectContract} from '../packages/contracts/tool-effects.ts';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use the isolated integration runner; never a production connection');
const hash=(body:Buffer|string)=>createHash('sha256').update(body).digest('hex');
const actor:HumanPrincipal={kind:'human',userId:'source-admin',sessionId:'session',issuer:'https://issuer.example',subject:'admin',orgRole:'admin',sessionEpoch:0,authenticatedAt:new Date().toISOString()};
let db:pg.Pool,root:string;
const load=()=>import('../apps/api/src/tool-effect-sources.ts');
function cannotMutate(contract:EffectContract){
  assert.equal(Reflect.set(contract,'effect','read'),false);
  assert.equal(Reflect.set(contract.cost,'kind','free'),false);
  assert.equal(Reflect.set(contract.source,'digest','f'.repeat(64)),false);
  assert.equal(Reflect.set(contract.permissions,'0','*'),false);
  assert.equal(Reflect.set(contract.evidenceRefs,'0','reviewed'),false);
}
function install(version:string){
  const code=Buffer.from('Native fixture bytes are never executed'),compressed=gzipSync(code),metadata=Buffer.from('{}');
  const manifest={format:'dsh-native-tools-v1',namespace:'fixture',package:'@company/fixture',version,dshVersion:'0.1.5-rc.1',source:{kind:'company',reference:'private'},config:{},lockSha256:hash('fixed lock'),
    bundle:{sha256:hash(compressed),codeSha256:hash(code),metadataSha256:hash(metadata),bytes:compressed.length},
    tools:[{name:'plugin__fixture__read',originalName:'read',description:'Claimed read only',parameters:{type:'object'},files:{read:['path'],write:[]},annotations:{readOnlyHint:true}}]};
  const id=nativeManifestId(manifest),directory=join(root,id);mkdirSync(directory);writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));writeFileSync(join(directory,'bundle.gz'),compressed);writeFileSync(join(directory,'package.json'),metadata);
  return {id,manifest,key:{namespace:`native:fixture:${id}`,toolName:'plugin__fixture__read'}};
}
before(async()=>{
  db=new pg.Pool({connectionString:process.env.DATABASE_URL});root=mkdtempSync(join(tmpdir(),'effect-source-'));
  await db.query('CREATE TABLE departments(id text PRIMARY KEY)');await migrateIdentity(db);await migrateNativeCapabilities(db);await migrateToolEffectContracts(db);
  await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('source-admin','https://issuer.example','admin','active','admin')");
});
after(async()=>{await db?.end();if(root){assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes('effect-source-'));rmSync(root,{recursive:true,force:true});}});

test('builtin candidates come from actual registered release bytes but opaque callbacks stay unknown',async()=>{
  const {createToolEffectSources}=await load();const sources=await createToolEffectSources({variant:'container'});
  const candidates=await sources.listBuiltinCandidates();assert.ok(candidates.length>=25);
  assert.ok(candidates.every(item=>item.namespace==='weiwu:builtin:container'&&item.effect==='unknown'&&item.cost.kind==='unknown'&&item.retry==='never'));
  const knowledge=candidates.find(item=>item.toolName==='knowledge_search')!;assert.equal(knowledge.source.kind,'builtin');assert.match(knowledge.source.digest,/^[a-f0-9]{64}$/);
  assert.ok(knowledge.evidenceRefs.includes('attestation:runtime-callback-binding-unavailable'));
  const originalDigest=effectDigest(knowledge);cannotMutate(knowledge);
  assert.equal(Reflect.set(candidates,'0',{effect:'read'}),false);
  const resolved=await sources.resolveBinding(db,{namespace:knowledge.namespace,toolName:knowledge.toolName});assert.deepEqual(resolved,knowledge);
  assert.equal(effectDigest(resolved),originalDigest);assert.equal(resolved?.effect,'unknown');assert.equal(resolved?.cost.kind,'unknown');
  assert.ok(Object.isFrozen(candidates)&&Object.isFrozen(knowledge));assert.ok(!Object.hasOwn(knowledge,'status'));
});

test('unknown, MCP and wrong-variant keys cannot masquerade as approved builtin sources',async()=>{
  const {createToolEffectSources}=await load();const sources=await createToolEffectSources({variant:'local'});
  for(const key of [{namespace:'weiwu:builtin:container',toolName:'knowledge_read'},{namespace:'company',toolName:'knowledge_read'},{namespace:'mcp:connection:1',toolName:'remote_read'},{namespace:'weiwu:builtin:local',toolName:'invented_tool'}])
    assert.equal(await sources.resolveBinding(db,key),null);
  const outer=(await sources.listBuiltinCandidates()).find(item=>item.toolName==='mcp_call_readonly')!;assert.equal(outer.effect,'unknown');assert.equal(outer.cost.kind,'unknown');
  await assert.rejects(createToolEffectSources({variant:'local',releaseSha256:'f'.repeat(64)} as never),/SOURCE_OPTIONS/);
  await assert.rejects(createToolEffectSources({variant:'local',nativeRoot:'relative-path'}),/SOURCE_OPTIONS/);
});

test('native adapter reuses bundle verification and namespace authority while preserving older fixed versions as unknown',async()=>{
  const {createToolEffectSources}=await load();const sources=await createToolEffectSources({variant:'local',nativeRoot:root});
  const one=install('1.0.0'),two=install('2.0.0');await setNativeCapability(one.id,true,db,root);
  const first=await sources.resolveBinding(db,one.key);assert.ok(first);assert.equal(first.source.kind,'native');assert.equal(first.source.reference,`native-manifest:${one.id}`);assert.equal(first.effect,'unknown');assert.equal(first.cost.kind,'unknown');
  const originalDigest=effectDigest(first);cannotMutate(first);assert.equal(effectDigest(await sources.resolveBinding(db,one.key)),originalDigest);
  await setNativeCapability(two.id,true,db,root);assert.deepEqual(await sources.resolveBinding(db,one.key),first);
  const second=await sources.resolveBinding(db,two.key);assert.ok(second);assert.notEqual(effectDigest(first),effectDigest(second));
  await setNativeCapability(two.id,false,db,root);assert.equal(await sources.resolveBinding(db,one.key),null);
  await setNativeCapability(two.id,true,db,root);writeFileSync(join(root,one.id,'bundle.gz'),'tampered');
  await assert.rejects(sources.resolveBinding(db,one.key),/NATIVE_BUNDLE/);
  const unconfigured=await createToolEffectSources({variant:'local'});assert.equal(await unconfigured.resolveBinding(db,two.key),null);
});

test('real contract service displays the server candidate but cannot review missing semantic attestation',async()=>{
  const {createToolEffectSources}=await load();const sources=await createToolEffectSources({variant:'container'}),service=new ToolEffectContractService({db,resolveBinding:sources.resolveBinding});
  const key={namespace:'weiwu:builtin:container',toolName:'knowledge_read'},candidate=await service.candidate(key,actor);
  assert.equal(candidate.status,'unreviewed');assert.equal(candidate.contract.effect,'unknown');
  await assert.rejects(service.review(key,candidate.digest,actor),/TOOL_EFFECT_UNKNOWN/);
  assert.equal((await db.query('SELECT count(*)::int n FROM tool_effect_contracts')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n,0);
});

test('multiple keys reuse one inventory and independently revalidate their fixed release',async()=>{
  const {createToolEffectSources}=await load(),start=performance.now();
  const sources=await createToolEffectSources({variant:'container'}),coldMs=performance.now()-start;
  const listedAt=performance.now(),candidates=await sources.listBuiltinCandidates(),listMs=performance.now()-listedAt;
  let count=0;const manyKeyAt=performance.now();
  for(const candidate of candidates){assert.deepEqual(await sources.resolveBinding(db,{namespace:candidate.namespace,toolName:candidate.toolName}),candidate);count++;}
  const manyKeyMs=performance.now()-manyKeyAt;assert.equal(count,candidates.length);
  console.info(JSON.stringify({inventoryTiming:{coldMs:Math.round(coldMs),listMs:Math.round(listMs),manyKeyMs:Math.round(manyKeyMs),tools:count}}));
});
