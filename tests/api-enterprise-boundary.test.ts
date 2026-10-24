import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {AddressInfo} from 'node:net';

test('enterprise createApp route, device, cache and network gates',async()=>{
  assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');assert.ok(process.env.DATABASE_URL);
  const dir=await mkdtemp(join(tmpdir(),'task2-review-'));
  const secret='R5fKs9vX2aQ7wZ4nE8cJ6tH3yU0pL1dB';
  Object.assign(process.env,{DATA_DIR:dir,TRACE_ROOT:join(dir,'runs'),WEIWU_AUTH_MODE:'oidc',WEIWU_PUBLIC_ORIGIN:'https://review.example',
    WEIWU_OIDC_ISSUER:'https://review-idp.invalid',WEIWU_BOOTSTRAP_ISSUER:'https://review-idp.invalid',WEIWU_BOOTSTRAP_SUBJECT:'owner',
    WEIWU_OIDC_CLIENT_ID:'review',WEIWU_OIDC_CLIENT_SECRET:'fixture-client-credential',WEIWU_SESSION_SECRETS:JSON.stringify([secret]),ALLOWED_ORIGINS:''});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,options)=>{
    const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(target.hostname!=='127.0.0.1')throw Error('Review fixture forbids external network');
    return originalFetch(input,options);
  };
  const db=await import('../apps/api/src/db.ts');await db.migrate();
  const {createApp}=await import('../apps/api/src/app.ts');
  const {routePolicies}=await import('../apps/api/src/api-route-policies.ts');
  const app=createApp();await app.locals.ready;await app.locals.shutdownBackground();
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sid=randomUUID(),user=randomUUID(),now=new Date().toISOString(),csrf='review-csrf';
  const signed=sid+'.'+createHmac('sha256',secret).update(sid).digest('base64').replace(/=+$/,'');
  const cookie='__Host-weiwu.sid='+encodeURIComponent('s:'+signed);
  const headers={'x-forwarded-host':'review.example','x-forwarded-proto':'https','content-type':'application/json',cookie};
  const call=(path:string,method='GET',extra:Record<string,string>={},body?:string)=>fetch(base+path,{method,headers:{...headers,...extra},...(body===undefined?{}:{body})});
  const navigation=(path:string)=>new Promise<number>((resolve,reject)=>{
    const request=http.get(base+path,{headers:{...headers,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});request.on('error',reject);
  });
  try{
    await db.pool.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES($1,'https://review-idp.invalid','member','active','member')",[user]);
    await db.pool.query("INSERT INTO human_session_lifecycles(sid,family_sid,valid_until,retain_until) VALUES($1,$1,now()+interval '1 hour',now()+interval '1 hour')",[sid]);
    await db.pool.query("INSERT INTO human_sessions(sid,sess,expire) VALUES($1,$2,now()+interval '1 hour')",[sid,JSON.stringify({
      cookie:{originalMaxAge:3600000,expires:new Date(Date.now()+3600000).toISOString(),secure:true,httpOnly:true,path:'/',sameSite:'lax'},csrf,
      human:{userId:user,sessionId:sid,sessionEpoch:0,authenticatedAt:now,createdAt:now,lastSeenAt:now}})]);
    for(const policy of routePolicies){
      const path=policy.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g,'11111111-1111-4111-8111-111111111111');
      const response=await call(path,policy.method,{},policy.method==='GET'?undefined:'{}');
      const emptyCollections:Record<string,unknown>={
        '/api/departments':[], '/api/projects':[], '/api/runs':[], '/api/work-files':[],
        '/api/automation/knowledge-candidates':[], '/api/automation/knowledge-sources':[],
        '/api/capabilities/plugins':[], '/api/knowledge/documents':[], '/api/knowledge/spaces':[],
        '/api/knowledge/work-records':[], '/api/costs':{timezone:'UTC',departments:[]},
      };
      const emptyCollection=policy.method==='GET'&&Object.hasOwn(emptyCollections,path);
      // The authenticated member has no department grants. Collection reads may
      // succeed only with empty data; scoped resources stay concealed, and
      // administrative/device routes retain their original denial.
      assert.equal(response.status,emptyCollection?200:policy.access==='member'?404:403,`${policy.method} ${path}`);
      if(emptyCollection)assert.deepEqual(await response.json(),emptyCollections[path],path+' must not reveal ungranted resources');
    }
    for(const path of ['/api/health/','/API/health','/api/%68ealth','/api//health','/api/unknown'])assert.equal((await call(path)).status,404,path);
    assert.equal((await call('/api/health','HEAD')).status,404);
    assert.equal((await call('/api/health','OPTIONS',{},'{}')).status,404);
    assert.equal((await call('/api/health','GET',{'x-forwarded-host':'wrong.example'})).status,403);
    assert.equal((await call('/api/health','GET',{'sec-fetch-site':'cross-site'})).status,403);
    assert.equal(await navigation('/auth/callback'),400);
    assert.equal(await navigation('/auth/session'),403);
    await db.pool.query("UPDATE human_users SET org_role='admin' WHERE id=$1",[user]);
    assert.equal((await call('/api/health')).status,200);
    const auditResponse=await call('/api/audit/events');assert.equal(auditResponse.status,200);
    assert.equal(auditResponse.headers.get('cache-control'),'no-store');
    const auditPage=await auditResponse.json();assert.ok(Array.isArray(auditPage.items));
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM human_audit_events WHERE action='audit.read' AND actor_user_id=$1",[user])).rows[0].n,1);
    const key='review-cached',fingerprint=createHash('sha256').update('POST /api/departments {}').digest('hex');
    await db.pool.query('INSERT INTO request_keys(principal_key,key,fingerprint,status,response) VALUES($1,$2,$3,200,$4)',['human:'+user,key,fingerprint,JSON.stringify({reviewCached:true})]);
    assert.equal((await call('/api/departments','POST',{'idempotency-key':key},'{}')).status,403);
    assert.deepEqual(await (await call('/api/departments','POST',{'idempotency-key':key,'x-csrf-token':csrf},'{}')).json(),{reviewCached:true});
    await db.pool.query('UPDATE human_users SET session_epoch=session_epoch+1 WHERE id=$1',[user]);
    assert.equal((await call('/api/departments','POST',{'idempotency-key':key,'x-csrf-token':csrf},'{}')).status,401);
    assert.equal((await call('/api/audit/events')).status,401);
    const device=randomUUID(),token='a'.repeat(64);
    await db.pool.query("INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,'review','win32',$3,'workspaces',false,$4)",[device,createHash('sha256').update(token).digest('hex'),randomUUID(),JSON.stringify({kind:'native'})]);
    const machine=(path:string)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':token},body:'{}'});
    assert.equal((await machine('/api/local-devices/'+device+'/poll')).status,200);
    assert.equal((await machine('/api/local-devices/register')).status,403);
    assert.equal((await machine('/api/local-devices/'+device+'/disable')).status,200);
    assert.equal((await machine('/api/local-devices/'+device+'/poll')).status,403);
    await app.locals.shutdown();assert.equal((await call('/api/health')).status,503);
    assert.deepEqual(await (await fetch(base+'/healthz')).json(),{ok:true});
  }finally{
    await app.locals.shutdown();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await db.pool.end();globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});
  }
});
