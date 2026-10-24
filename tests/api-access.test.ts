import {test} from 'node:test';
import assert from 'node:assert/strict';
import {routePolicy,assertRouteInventory,routePolicies,isClassifiedEntry} from '../apps/api/src/api-route-policies.ts';
import {authorizeRoute,apiAccess} from '../apps/api/src/api-access.ts';
import {idempotency} from '../apps/api/src/idempotency.ts';
import express from 'express';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {pool} from '../apps/api/src/db.ts';

test('all mounted business routes have an explicit policy',()=>{
  assert.equal(routePolicies.length,158);
  assert.doesNotThrow(()=>assertRouteInventory());
});

test('machine access is restricted to four exact operation paths',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  for(const path of [`/api/local-devices/${id}/poll`, `/api/local-devices/${id}/disable`,
    `/api/local-devices/${id}/operations/${id}/start`, `/api/local-devices/${id}/operations/${id}/result`])
    assert.equal(routePolicy('POST',path)?.access,'device');
  for(const path of ['/api/local-devices/register','/api/local-devices',`/api/local-devices/${id}/poll/`,
    `/api/LOCAL-DEVICES/${id}/poll`,`/api/local-devices/${id}%2fpoll`])
    assert.notEqual(routePolicy('POST',path)?.access,'device');
});

test('implicit HEAD and OPTIONS, encoded separators and unknown routes fail closed',()=>{
  for(const method of ['HEAD','OPTIONS'])assert.equal(routePolicy(method,'/api/health'),null);
  for(const path of ['/api/health/','/API/health','/api/%68ealth','/api//health','/api/unknown'])
    assert.equal(routePolicy('GET',path),null);
  assert.equal(routePolicy('GET','/api/health')?.access,'admin');
  assert.equal(routePolicy('PUT','/api/capabilities/plugins/dsh.office')?.access,'admin');
  assert.equal(isClassifiedEntry('GET','/auth/callback'),true);
  assert.equal(isClassifiedEntry('POST','/auth/login'),true);
  for(const [method,path] of [['POST','/auth/callback'],['GET','/auth/other'],['GET','/unexpected'],['POST','/api/unknown']])
    assert.equal(isClassifiedEntry(method,path),false);
});

test('administrative routes require a current admin while device credentials stay on device routes',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const human={kind:'human' as const,userId:'u',sessionId:'s',issuer:'https://issuer.example',subject:'sub',orgRole:'member' as const,sessionEpoch:0,authenticatedAt:new Date().toISOString()};
  assert.equal(authorizeRoute(routePolicy('GET','/api/health'),human),false);
  assert.equal(authorizeRoute(routePolicy('GET','/api/health'),{...human,orgRole:'admin'}),true);
  assert.equal(authorizeRoute(routePolicy('GET','/api/health'),{kind:'device',deviceId:id}),false);
  assert.equal(authorizeRoute(routePolicy('POST',`/api/local-devices/${id}/poll`),{kind:'device',deviceId:id},`/api/local-devices/${id}/poll`),true);
  assert.equal(authorizeRoute(routePolicy('POST',`/api/local-devices/${id}/poll`),{kind:'device',deviceId:'different'},`/api/local-devices/${id}/poll`),false);
});

test('identity administration stays admin-only on all six exact routes',()=>{
  for(const [method,path] of [['GET','/api/identity/users'],['PATCH','/api/identity/users/u'],['POST','/api/identity/users/u/revoke-sessions'],
    ['GET','/api/identity/departments/d/members'],['PUT','/api/identity/departments/d/members/u'],['DELETE','/api/identity/departments/d/members/u']]){
    assert.equal(routePolicy(method,path)?.access,'admin');
    assert.equal(authorizeRoute(routePolicy(method,path),{kind:'device',deviceId:'device'}),false);
    assert.equal(routePolicy(method,path+'/'),null);
  }
});

test('maintenance reports have one read-only administrator route',()=>{
  const policy=routePolicy('GET','/api/storage/maintenance');
  assert.equal(policy?.access,'admin');
  assert.equal(authorizeRoute(policy,{kind:'device',deviceId:'device'}),false);
  for(const method of ['POST','PUT','DELETE','HEAD'])assert.equal(routePolicy(method,'/api/storage/maintenance'),null);
});

test('idempotency rejects missing authenticated principal before touching storage',async()=>{
  let status=0,nextCalled=false;
  const req={method:'POST',path:'/departments',originalUrl:'/api/departments',body:{},get:(name:string)=>name==='Idempotency-Key'?'12345678':undefined};
  const res={locals:{},status(code:number){status=code;return this;},json(_body:unknown){return this;}};
  await idempotency(req as never,res as never,()=>{nextCalled=true;});
  assert.equal(status,403);assert.equal(nextCalled,false);
});

test('administrator writes require CSRF before the next middleware',async()=>{
  const admin={kind:'human' as const,userId:'admin',sessionId:'sid',issuer:'https://issuer.example',subject:'subject',orgRole:'admin' as const,sessionEpoch:0,authenticatedAt:new Date().toISOString()};
  let csrf=false,nextCalled=false,status=0;
  const identity={authenticate:async()=>admin,csrf:(_req:unknown,res:{status:(code:number)=>unknown},_next:unknown)=>{csrf=true;res.status(403);}};
  const req={baseUrl:'/api',path:'/departments',method:'POST',get:()=>undefined};
  const res={locals:{},status(code:number){status=code;return this;},json(){return this;},sendStatus(code:number){status=code;return this;}};
  await apiAccess(identity as never,{mode:'oidc',publicOrigin:'https://example.com',issuer:'https://issuer.example',clientId:'c',clientSecret:'x',sessionSecrets:['x'],bootstrapIssuer:'https://issuer.example',bootstrapSubject:'subject'})(req as never,res as never,()=>{nextCalled=true;});
  assert.equal(csrf,true);assert.equal(status,403);assert.equal(nextCalled,false);
});

test('every registered route enforces its explicit member/admin/device policy before handler entry',async()=>{
  const app=express(),member={kind:'human' as const,userId:'u',sessionId:'s',issuer:'https://issuer.example',subject:'sub',orgRole:'member' as const,sessionEpoch:0,authenticatedAt:new Date().toISOString()};
  const identity={authenticate:async()=>member,csrf:(_req:unknown,_res:unknown,next:()=>void)=>next()};
  let handlers=0;
  // This unit host has no database. Provide only a current identity; resource
  // lookups remain empty. Real membership/resource SQL is covered by the HTTP integration suite.
  const query=pool.query;let current=true,identityChecks=0;
  pool.query=(async(sql:string)=>{if(sql.startsWith('SELECT id FROM human_users WHERE id=$1 AND issuer=$2')){identityChecks++;return {rows:current?[{id:'u'}]:[],rowCount:current?1:0};}return {rows:[],rowCount:0};}) as typeof pool.query;
  app.use('/api',apiAccess(identity as never,{mode:'oidc',publicOrigin:'https://example.com',issuer:'https://issuer.example',clientId:'c',clientSecret:'x',sessionSecrets:['x'],bootstrapIssuer:'https://issuer.example',bootstrapSubject:'sub'}));
  app.use((_req,res)=>{handlers++;res.sendStatus(200);});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const collectionRoutes=['/api/departments','/api/projects','/api/runs','/api/work-files','/api/automation/knowledge-candidates','/api/automation/knowledge-sources','/api/capabilities/plugins','/api/knowledge/documents','/api/knowledge/spaces','/api/knowledge/work-records','/api/costs'];
    for(const policy of routePolicies){
      const path=policy.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g,'11111111-1111-4111-8111-111111111111');
      const response=await fetch(base+path,{method:policy.method});
      const unscopedList=policy.method==='GET'&&collectionRoutes.includes(policy.path);
      assert.equal(response.status,policy.access==='member'?(unscopedList?200:404):403,`${policy.method} ${path}`);
    }
    for(const path of ['/api/health/','/API/health','/api/%68ealth','/api//health','/api/unknown'])
      assert.equal((await fetch(base+path)).status,404,path);
    assert.equal((await fetch(base+'/api/health',{method:'HEAD'})).status,404);
    assert.equal((await fetch(base+'/api/health',{method:'OPTIONS'})).status,404);
    assert.equal(handlers,collectionRoutes.length);
    assert.equal(identityChecks,routePolicies.filter(policy=>policy.access==='member').length);
    current=false;
    for(const path of collectionRoutes)assert.equal((await fetch(base+path)).status,404,path);
    assert.equal(handlers,collectionRoutes.length,'revoked identity never reaches even a list handler');
  }finally{pool.query=query;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
