import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:https';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {browser,listen,stop,testIdp} from './fixtures/identity/idp.ts';
import {createIdentityHttp} from '../apps/api/src/identity-http.ts';
import type {IdentityConfig,OidcIdentityConfig} from '../apps/api/src/identity-types.ts';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createBackupRestoreState} from '../apps/api/src/backup-restore-state.ts';

test('enterprise restore requires fresh OIDC login after restart without importing old session authority',async t=>{
 assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use the owned isolated integration runner');
 const root=mkdtempSync(join(tmpdir(),'enterprise-identity-')),schema='enterprise_identity_'+randomUUID().replaceAll('-','');
 const idp=await testIdp();t.after(async()=>{await idp.close();rmSync(root,{recursive:true,force:true});});
 function environment(name:string){const folder=join(root,name);Object.assign(process.env,{DATA_DIR:folder,TRACE_ROOT:join(folder,'runs'),OBSIDIAN_VAULT:join(folder,'vault'),LOCAL_WORKSPACE_ROOT:folder,WEIWU_AUTH_MODE:'legacy-local'});mkdirSync(join(folder,'runs'),{recursive:true});return folder;}
 const sourceRoot=environment('source');mkdirSync(join(sourceRoot,'runs','history'));writeFileSync(join(sourceRoot,'runs','history','delivery.txt'),'preserved identity acceptance delivery');writeFileSync(join(sourceRoot,'credential.key'),Buffer.alloc(32,7));
 const {pool,migrate}=await import('../apps/api/src/db.ts');await migrate();
 t.after(async()=>{await pool.query('SET search_path TO public');await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();});
 const {apiAccess}=await import('../apps/api/src/api-access.ts'),{enterpriseBackupRouter}=await import('../apps/api/src/enterprise-backup-router.ts'),{readEnterpriseTables}=await import('../apps/api/src/enterprise-backup-export.ts'),{readRestoreAdmission}=await import('../apps/api/src/enterprise-restore-admission.ts');
 const config:OidcIdentityConfig={mode:'oidc',publicOrigin:'https://weiwu.example',issuer:idp.issuer,clientId:'weiwu',clientSecret:'fixture-client-credential',sessionSecrets:['R5fKs9vX2aQ7wZ4nE8cJ6tH3yU0pL1dB'],bootstrapIssuer:idp.issuer,bootstrapSubject:'owner-sub'};
 async function server(folder:string,identityConfig:IdentityConfig){
  const traceRoot=join(folder,'runs'),writers=createArchiveWriterManager({traceRoot}),state=createBackupRestoreState({pool,writers,traceRoot,dataRoot:folder});
  const identity=createIdentityHttp({pool,config:identityConfig,transport:idp.transport,initializeAfter:state.reconcilePending().then(()=>{})});
  await identity.ready;
  const app=express();app.use(express.json({limit:'70mb'}));app.use(identity.sessionMiddleware,identity.router);
  app.use('/api',(req,res,next)=>['GET','HEAD'].includes(req.method)?next():identity.csrf(req,res,next),apiAccess(identity,identityConfig),enterpriseBackupRouter(traceRoot,writers,state));
  app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??500).json({error:error.message,code:error.code}));
  const http=createServer(idp.tls,app),origin=await listen(http),b=browser(idp.fetchTls);let closed=false;
  const close=async()=>{if(closed)return;closed=true;await stop(http);await identity.close();};t.after(close);
  const request=(path:string,init?:RequestInit)=>b.request(origin+path,init);
  const info=async()=>{const response=await request('/auth/session');assert.equal(response.status,200);return response.json();};
  const post=async(path:string,body:unknown)=>{const session=await info();return request(path,{method:'POST',headers:{'content-type':'application/json',...(session.csrf?{'x-csrf-token':session.csrf}:{})},body:JSON.stringify(body)});};
  const login=async()=>{const start=await post('/auth/login',{returnTo:'/#settings'});assert.equal(start.status,200);const callback=await b.authorize((await start.json()).authorizationUrl);assert.equal((await request('/auth/callback'+new URL(callback).search)).status,303);return info();};
  return {origin,b,close,request,post,login,info};
 }
 const source=await server(sourceRoot,config);let userId='',sourceCookie='',sourceCsrf='',backup:any;
 await t.test('source administrator signs in through OIDC and exports through the protected HTTP route',async()=>{
  const session=await source.login();assert.equal(session.authenticated,true);assert.equal(session.user.orgRole,'admin');userId=session.user.id;sourceCookie=source.b.cookies.get(source.origin)!;sourceCsrf=session.csrf;
  await pool.query("INSERT INTO models(id,data,status) VALUES('identity-model','{}','untested')");
  await pool.query("INSERT INTO model_reservations(id,model_id,purpose,amount,input_rate,output_rate,status,expires_at) VALUES('identity-unknown','identity-model','synthetic unknown cost',0.02,1,1,'uncertain',now()-interval '1 hour')");
  const response=await source.post('/api/backup/enterprise/export',{password:'synthetic-identity-backup'});assert.equal(response.status,200);backup=await response.json();
 });
 assert.ok(backup,'Source export must succeed before attempting restore');await source.close();
 const sourceRows=JSON.stringify(await readEnterpriseTables(pool));
 await pool.query('CREATE SCHEMA '+schema);await pool.query('SET search_path TO '+schema+',public');await migrate();const targetRoot=environment('target');
 const local=await server(targetRoot,{mode:'legacy-local'});let operation:any;
 await t.test('fresh local target imports history but contains no source sessions or login transactions',async()=>{
  const response=await local.post('/api/backup/enterprise/restore',{password:'synthetic-identity-backup',backup,confirmation:'RESTORE ENTERPRISE'});assert.equal(response.status,201);operation=await response.json();assert.equal(operation.status,'quarantined');
  for(const table of ['human_sessions','human_session_lifecycles','oidc_login_transactions'])assert.equal((await pool.query('SELECT * FROM '+table)).rowCount,0);
  assert.equal((await pool.query('SELECT consumed_by FROM identity_bootstrap WHERE id=1')).rows[0].consumed_by,userId);
  assert.equal((await readRestoreAdmission(pool))?.status,'quarantined');
 });
 assert.ok(operation,'Target import must succeed before restart');await local.close();
 const beforeRestart=JSON.stringify(await readEnterpriseTables(pool));
 const {createApp}=await import('../apps/api/src/app.ts');
 await t.test('real application restart refuses legacy-local downgrade without changing restored history',async()=>{
  const app=createApp();try{await assert.rejects(app.locals.ready,/OIDC activation forbids legacy-local downgrade/);}finally{await app.locals.shutdown();}
  assert.equal(JSON.stringify(await readEnterpriseTables(pool)),beforeRestart);
 });
 await t.test('changed bootstrap configuration cannot take over restored administration',async()=>{
  const identity=createIdentityHttp({pool,config:{...config,bootstrapSubject:'different-owner'},transport:idp.transport});
  try{await assert.rejects(identity.ready,/Bootstrap identity configuration changed/);}finally{await identity.close();}
  assert.equal(JSON.stringify(await readEnterpriseTables(pool)),beforeRestart);
 });
 // The fixture deliberately retains the signing key: missing source sessions
 // must reject the old cookie even without relying on key rotation.
 const target=await server(targetRoot,config),activation={operationId:operation.operationId,inputDigest:operation.inputDigest};
 await t.test('old signed cookie cannot read restored administration or activate execution',async()=>{
  const response=await idp.fetchTls(target.origin+'/api/backup/enterprise/status',{headers:{cookie:sourceCookie}});assert.equal(response.status,401);
  const forged=await idp.fetchTls(target.origin+'/api/backup/enterprise/activate',{method:'POST',headers:{cookie:sourceCookie,'content-type':'application/json','x-csrf-token':sourceCsrf},body:JSON.stringify(activation)});assert.equal(forged.status,403);
  assert.equal((await target.info()).authenticated,false);assert.equal((await readRestoreAdmission(pool))?.status,'quarantined');
 });
 await t.test('new verified login and CSRF are required to activate once, preserving unknown cost',async()=>{
  const session=await target.login();assert.equal(session.user.id,userId);assert.equal(session.authenticated,true);
  assert.equal((await target.request('/api/backup/enterprise/activate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(activation)})).status,403);
  assert.equal((await readRestoreAdmission(pool))?.status,'quarantined');
  const response=await target.post('/api/backup/enterprise/activate',activation);assert.equal(response.status,200,await response.text());
  assert.equal((await target.post('/api/backup/enterprise/activate',activation)).status,200);
  assert.equal((await readRestoreAdmission(pool))?.verified,true);
  assert.equal((await pool.query("SELECT * FROM human_audit_events WHERE action='backup.restore'")).rowCount,1);
  const cost=(await pool.query("SELECT status,amount::text FROM model_reservations WHERE id='identity-unknown'")).rows[0];assert.equal(cost.status,'uncertain');assert.equal(Number(cost.amount),0.02);
  assert.equal(readFileSync(join(targetRoot,'runs','history','delivery.txt'),'utf8'),'preserved identity acceptance delivery');
 });
 await target.close();await pool.query('SET search_path TO public');assert.equal(JSON.stringify(await readEnterpriseTables(pool)),sourceRows);
 assert.equal(readFileSync(join(sourceRoot,'runs','history','delivery.txt'),'utf8'),'preserved identity acceptance delivery');
 t.diagnostic(JSON.stringify({operationId:operation.operationId,inputDigest:operation.inputDigest,sourceDigest:createHash('sha256').update(sourceRows).digest('hex'),sourceUnchanged:true,oidcProvider:'local oidc-provider fixture over trusted TLS',productionProvider:false,modelCalls:0}));
});
