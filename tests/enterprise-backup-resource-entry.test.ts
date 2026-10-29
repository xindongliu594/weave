import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {once} from 'node:events';
import express from 'express';
import {nativeManifestId} from '../services/agent-runtime/native-capabilities.mjs';
import {effectDigest} from '../services/agent-runtime/tool-effects.mjs';

test('restored resources use existing native, MCP, device and contract entry points',async t=>{
 const root=mkdtempSync(join(tmpdir(),'restore-resources-')),traceRoot=join(root,'runs'),nativeRoot=join(root,'native-plugins');
 process.env.DATA_DIR=root;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(root,'vault');mkdirSync(traceRoot);mkdirSync(nativeRoot);
 const {pool,migrate}=await import('../apps/api/src/db.ts');t.after(async()=>{await pool.end();rmSync(root,{recursive:true,force:true});});await migrate();
 const native=await import('../apps/api/src/native-capabilities.ts'),admission=await import('../apps/api/src/enterprise-restore-admission.ts');
 const install=(version:string)=>{
  const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex'),code=Buffer.from('fixture code'),compressed=gzipSync(code),metadata=Buffer.from('{}');
  const manifest={format:'dsh-native-tools-v1',namespace:'office',package:'@company/office',version,source:{kind:'company',reference:'private'},dshVersion:'0.1.5-rc.1',config:{},lockSha256:sha('lock'),bundle:{sha256:sha(compressed),codeSha256:sha(code),metadataSha256:sha(metadata),bytes:compressed.length},tools:[{name:'plugin__office__read',originalName:'read',description:'Read',parameters:{type:'object'},files:{read:['file'],write:[]}}]};
  const id=nativeManifestId(manifest),dir=join(nativeRoot,id);mkdirSync(dir);writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));writeFileSync(join(dir,'bundle.gz'),compressed);writeFileSync(join(dir,'package.json'),metadata);return {id,manifest};
 };
 const one=install('1.0.0'),two=install('2.0.0'),agents=[{id:'reader',tools:['plugin__office__read']}];await native.setNativeCapability(one.id,true,pool,nativeRoot);
 await pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('admin','https://fixture.invalid','admin','active','admin')");
 const at=new Date().toISOString(),ref={userId:'admin',sessionId:'fresh-session',sessionEpoch:0,authenticatedAt:at,createdAt:at,lastSeenAt:at};
 const {loadHumanPrincipal}=await import('../apps/api/src/identity-store.ts'),principal=(await loadHumanPrincipal(pool,ref))!;
 const key={namespace:'weiwu',toolName:'fixture_read'},contract:any={schema:1,capabilityId:'fixture.read',...key,source:{kind:'builtin',reference:'weiwu:test-release',version:'1',digest:'a'.repeat(64)},definitionSha256:'b'.repeat(64),effect:'read',isolationProfile:'runtime-read-v1',permissions:['fixture:read'],retry:'bounded-read',cost:{kind:'free'},reconciliation:{kind:'receipt'},compensation:{kind:'none',requiresApproval:true},evidenceRefs:['fixture:source-review']};
 const {ToolEffectContractService}=await import('../apps/api/src/tool-effect-contracts.ts'),contracts=new ToolEffectContractService({db:pool,resolveBinding:async()=>contract}),digest=effectDigest(contract);await contracts.review(key,digest,principal);
 const originalContract=(await pool.query('SELECT * FROM tool_effect_contracts')).rows;
 const deviceId=randomUUID(),grantId=randomUUID(),token='7'.repeat(64),connectionId=randomUUID(),connection={name:'Fixture',url:'https://fixture.invalid/mcp',enabled:true,allowedEmployees:[],allowedTools:['read']};
 await pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands) VALUES($1,$2,'Fixture','linux',$3,'fixture',false)",[deviceId,createHash('sha256').update(token).digest('hex'),grantId]);
 await pool.query('INSERT INTO mcp_connections(id,data) VALUES($1,$2)',[connectionId,connection]);
 const operationId=randomUUID(),inputDigest='c'.repeat(64),pending={native:[one.id,two.id],mcp:[JSON.stringify([connectionId,1])],device:[deviceId],schedule:[],contract:[digest]};
 await pool.query("INSERT INTO enterprise_restore_admission(operation_id,input_digest,status,source_issuer,restored_at,pending_resources) VALUES($1,$2,'quarantined','https://fixture.invalid',clock_timestamp()-interval '2 seconds',$3)",[operationId,inputDigest,pending]);
 await pool.query('UPDATE backup_restore_anchor SET enterprise_restore_operation_id=$1',[operationId]);
 await pool.query('INSERT INTO backup_restore_receipts(operation_id,database_id,previous_generation,next_generation,manifest_sha256) SELECT $1,database_id,0,1,$2 FROM backup_restore_anchor',[operationId,'d'.repeat(64)]);await pool.query('UPDATE backup_restore_anchor SET generation=1');
 await pool.query("INSERT INTO human_sessions(sid,sess,expire) VALUES($1,$2,now()+interval '1 hour')",[ref.sessionId,{human:ref}]);await pool.query("INSERT INTO human_session_lifecycles(sid,family_sid,valid_until,retain_until) VALUES($1,$1,now()+interval '1 hour',now()+interval '1 hour')",[ref.sessionId]);
 const {createArchiveWriterManager}=await import('../services/agent-runtime/archive-writer-scope.mjs'),writers=createArchiveWriterManager({traceRoot});
 const {localDeviceRouter,localTarget}=await import('../apps/api/src/local-execution.ts'),{browserMcpRouter}=await import('../apps/api/src/work-tools-browser.ts'),{apiAccess}=await import('../apps/api/src/api-access.ts');
 const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.principal=principal;next();});app.use('/devices',localDeviceRouter(traceRoot,writers));app.use('/mcp',browserMcpRouter());
 app.use('/api',apiAccess({authenticate:async()=>principal} as any,{mode:'legacy-local'}));let modelTests=0;app.post('/api/models/:id/test',(_req,res)=>{modelTests++;res.json({unexpected:true});});app.get('/api/models',(_req,res)=>res.json([]));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 async function request(path:string,body?:any,method=body===undefined?'GET':'POST'){const response=await fetch(base+path,{method,headers:{'content-type':'application/json','X-Local-Device-Key':token},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
 const quarantined=(e:any)=>e.code==='BACKUP_RESTORED_ENVIRONMENT_QUARANTINED',pendingGrant=(e:any)=>e.code==='BACKUP_RESOURCE_REAUTHORIZATION_REQUIRED';
 await t.test('native enable, device heartbeat and API model tests are denied before any effect',async()=>{
  await assert.rejects(native.setNativeCapability(one.id,true,pool,nativeRoot),quarantined);
  const heartbeat=(await pool.query('SELECT last_seen FROM local_devices WHERE id=$1',[deviceId])).rows;
  assert.equal((await request(`/devices/local-devices/${deviceId}/poll`,{active:null})).body.code,'BACKUP_RESTORED_ENVIRONMENT_QUARANTINED');assert.deepEqual((await pool.query('SELECT last_seen FROM local_devices WHERE id=$1',[deviceId])).rows,heartbeat);
  const denied=await request('/api/models/fixture/test',{});assert.equal(denied.status,409);assert.equal(denied.body.code,'BACKUP_RESTORED_ENVIRONMENT_QUARANTINED');assert.equal(modelTests,0);assert.equal((await request('/api/models')).status,200);
 });
 const client=await pool.connect();try{await client.query('BEGIN');await admission.activateRestoredEnvironmentIn(client,principal,{operationId,inputDigest});await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 await t.test('native versions remain isolated and explicit enable uses the existing bundle validator',async()=>{
  assert.equal((await native.listNativeCapabilities(pool,nativeRoot)).find(row=>row.id===one.id)?.enabled,false);
  await assert.rejects(native.assertNativeCapabilities({agents,nativeCapabilities:[one]},pool,nativeRoot),pendingGrant);
  await native.setNativeCapability(two.id,true,pool,nativeRoot);await native.assertNativeCapabilities({agents,nativeCapabilities:[two]},pool,nativeRoot);
  await assert.rejects(native.assertNativeCapabilities({agents,nativeCapabilities:[one]},pool,nativeRoot),pendingGrant);
  await native.setNativeCapability(one.id,true,pool,nativeRoot);await native.assertNativeCapabilities({agents,nativeCapabilities:[one]},pool,nativeRoot);
 });
 await t.test('copied devices remain effectively disabled and cannot be revived by their old key',async()=>{
  const list=await request('/devices/local-devices');assert.equal(list.body.find((row:any)=>row.id===deviceId).enabled,false);
  await assert.rejects(localTarget({executionTarget:{kind:'local',deviceId,grantId}},[],pool,false),pendingGrant);
  assert.equal((await request(`/devices/local-devices/${deviceId}/poll`,{active:null})).body.code,'BACKUP_RESOURCE_REAUTHORIZATION_REQUIRED');
  assert.equal((await pool.query('SELECT enabled FROM local_devices WHERE id=$1',[deviceId])).rows[0].enabled,true,'portable historical flag retained');
 });
 await t.test('copied MCP cannot discover or call until a new connection version is saved',async()=>{
  assert.equal((await request('/mcp/work-tools/mcp')).body[0].enabled,false);
  assert.equal((await request(`/mcp/work-tools/mcp/${connectionId}/discover`,{version:1})).body.code,'BACKUP_RESOURCE_REAUTHORIZATION_REQUIRED');
  const saved=await request(`/mcp/work-tools/mcp/${connectionId}`,{...connection,version:1},'PUT');assert.equal(saved.status,200);assert.equal(saved.body.version,2);assert.deepEqual(saved.body.tools,[]);assert.equal(saved.body.enabled,true);
 });
 await t.test('copied immutable contract needs a new target review audit without rewriting the old row',async()=>{
  await assert.rejects(contracts.snapshot([key]),pendingGrant);const before=(await pool.query("SELECT * FROM human_audit_events WHERE action='capability.configure'")).rowCount;
  await contracts.review(key,digest,principal);await contracts.snapshot([key]);assert.deepEqual((await pool.query('SELECT * FROM tool_effect_contracts')).rows,originalContract);
  assert.equal((await pool.query("SELECT * FROM human_audit_events WHERE action='capability.configure'")).rowCount,(before??0)+1);
 });
});
