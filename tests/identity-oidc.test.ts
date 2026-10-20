import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import express from 'express';
import { createIdentityHttp } from '../apps/api/src/identity-http.ts';
import { browser, identityTestPool, listen, stop, testIdp } from './fixtures/identity/idp.ts';
import type { OidcIdentityConfig } from '../apps/api/src/identity-types.ts';
import { migrateIdentity } from '../apps/api/src/identity-schema.ts';

test('real OIDC over trusted TLS and persistent HTTP sessions', async t => {
  const idp=await testIdp(); const pool=await identityTestPool(); let now=Date.now();
  const config:OidcIdentityConfig={mode:'oidc',publicOrigin:'https://weiwu.example',issuer:idp.issuer,clientId:'weiwu',clientSecret:'fixture-client-credential',
    sessionSecrets:['R5fKs9vX2aQ7wZ4nE8cJ6tH3yU0pL1dB'],bootstrapIssuer:idp.issuer,bootstrapSubject:'owner-sub'};
  const gate=()=>{let release!:()=>void,arrive!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{arrive=resolve;});return{waiting,started,release,arrive};};
  let tokenGate:ReturnType<typeof gate>|undefined,lateGate:ReturnType<typeof gate>|undefined,logoutGate:ReturnType<typeof gate>|undefined;
  const transport:typeof idp.transport=async(url,options)=>{const response=await idp.transport(url,options);if(tokenGate&&new URL(url).pathname==='/token'){const current=tokenGate;current.arrive();await current.waiting;}return response;};
  t.mock.timers.enable({apis:['setInterval']});
  let identity=createIdentityHttp({pool,config,transport,now:()=>new Date(now)});
  const app=express(); app.use(express.json()); app.use((req,res,next)=>identity.sessionMiddleware(req,res,next));
  app.use(async(req,_res,next)=>{if(logoutGate&&req.path==='/auth/logout'){const current=logoutGate;current.arrive();await current.waiting;}next();});
  app.use((req,res,next)=>identity.router(req,res,next));
  app.get('/private',async(req,res)=>{const principal=await identity.authenticate(req);res.status(principal?200:401).json({principal});});
  app.get('/late/:kind',async(req,res)=>{const current=lateGate!;if(req.params.kind==='end')assert.ok(await identity.authenticate(req));current.arrive();await current.waiting;
    if(req.params.kind==='explicit'){const principal=await identity.authenticate(req);res.status(principal?200:401).json({principal});}
    else{req.session.csrf='stale-response-end-write';res.json({done:true});}});
  app.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(!res.headersSent)res.status(503).json({error:'unavailable'});});
  const server=createServer(idp.tls,app); const origin=await listen(server);
  const b=browser(idp.fetchTls);
  const request=(path:string,init?:RequestInit)=>b.request(`${origin}${path}`,init);
  const info=async()=>{const response=await request('/auth/session'); assert.equal(response.status,200); return response.json();};
  const login=async(returnTo='/private')=>{const current=await info();return request('/auth/login',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':current.csrf},body:JSON.stringify({returnTo})});};
  const begin=async()=>{const response=await login();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');return b.authorize((await response.json()).authorizationUrl);};
  const callback=(url:string)=>request(`/auth/callback${new URL(url).search}`);
  try {
    await identity.ready;
    await t.test('session cookie, CSRF, exact routes and relative return target reject forgery',async()=>{
      const response=await request('/auth/session');const cookie=response.headers.get('set-cookie')!;
      assert.match(cookie,/^__Host-weiwu\.sid=/);for(const attr of ['HttpOnly','Secure','SameSite=Lax','Path=/'])assert.ok(cookie.includes(attr));assert.ok(!cookie.includes('Domain='));
      const data=await response.json();assert.equal(data.authenticated,false);assert.equal(data.loginAvailable,true);
      assert.equal((await request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
      assert.equal((await request('/auth/login',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':'é'.repeat(data.csrf.length)},body:'{}'})).status,403);
      for(const value of ['https://evil.test','//evil.test','/\\evil','/x\n','/%2f%2fevil','/%5cevil'])assert.equal((await login(value)).status,400,value);
      assert.equal((await request('/AUTH/session')).status,404);assert.equal((await request('/auth/session/')).status,404);
      assert.equal((await request('/auth/session',{method:'HEAD'})).status,404);
    });
    await t.test('PKCE S256 and state binding, three transaction limit, wrong SID denied',async()=>{
      for(let i=0;i<3;i++){const response=await login();assert.equal(response.status,200);const url=new URL((await response.json()).authorizationUrl);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(url.searchParams.get('nonce'));}
      assert.equal((await login()).status,429);
      await pool.query('DELETE FROM oidc_login_transactions');
      const url=await begin();const alien=browser(idp.fetchTls);assert.equal((await alien.request(`${origin}/auth/callback${new URL(url).search}`)).status,400);
      const wrong=new URL(url);wrong.searchParams.set('state','wrong');assert.equal((await callback(wrong.href)).status,400);
      assert.equal((await callback(url)).status,303);
    });
    await t.test('verified administrator, SID and CSRF rotate; replay fails; tokens never persisted',async()=>{
      const before=await info();const cookie=b.cookies.get(origin);const url=await begin();const [first,second]=await Promise.all([callback(url),callback(url)]);
      assert.deepEqual([first.status,second.status].sort(),[303,400]);assert.notEqual(b.cookies.get(origin),cookie);
      const after=await info();assert.equal(after.authenticated,true);assert.equal(after.user.orgRole,'admin');assert.notEqual(after.csrf,before.csrf);
      assert.equal((await request('/private')).status,200);
      const stored=JSON.stringify((await pool.query('SELECT sess FROM human_sessions')).rows);assert.ok(!/access_token|refresh_token|id_token/.test(stored));
      assert.equal((await callback(url)).status,400);
    });
    for(const kind of ['explicit','end'])await t.test(`authenticated late ${kind} save cannot resurrect logout SID`,async()=>{
        assert.equal((await callback(await begin())).status,303);const current=await info(),oldCookie=b.cookies.get(origin)!;
        lateGate=gate();const late=request(`/late/${kind}`);await lateGate.started;
        try{assert.equal((await request('/auth/logout',{method:'POST',headers:{'x-csrf-token':current.csrf}})).status,204);}
        finally{lateGate.release();}
        await late;assert.equal((await idp.fetchTls(`${origin}/private`,{headers:{cookie:oldCookie}})).status,401,kind);
        assert.equal(Number((await pool.query("SELECT count(*) AS count FROM human_sessions WHERE sess::jsonb ? 'human'")).rows[0].count),0);
    });
    await t.test('rotation permanently invalidates authenticated old SID despite late response-end save',async()=>{
      assert.equal((await callback(await begin())).status,303);const oldCookie=b.cookies.get(origin)!;
      lateGate=gate();const late=request('/late/end');await lateGate.started;
      let newCookie:string;
      try{assert.equal((await callback(await begin())).status,303);newCookie=b.cookies.get(origin)!;}finally{lateGate.release();}
      await late;assert.equal((await idp.fetchTls(`${origin}/private`,{headers:{cookie:oldCookie}})).status,401);
      assert.equal((await idp.fetchTls(`${origin}/private`,{headers:{cookie:newCookie!}})).status,200);b.cookies.set(origin,newCookie!);
    });
    await t.test('logout cancels a pending real token exchange callback in the same login lineage',async()=>{
      const url=await begin(),current=await info();tokenGate=gate();const pending=callback(url);await tokenGate.started;
      try{assert.equal((await request('/auth/logout',{method:'POST',headers:{'x-csrf-token':current.csrf}})).status,204);}
      finally{tokenGate.release();}
      assert.equal((await pending).status,400);tokenGate=undefined;assert.equal((await request('/private')).status,401);
    });
    await t.test('logout already loaded before rotation revokes its child while another login stays valid',async()=>{
      const independent=browser(idp.fetchTls),safe=await (await independent.request(`${origin}/auth/session`)).json();
      const redirect=await independent.request(`${origin}/auth/login`,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':safe.csrf},body:'{}'});
      const independentCallback=await independent.authorize((await redirect.json()).authorizationUrl);
      assert.equal((await independent.request(`${origin}/auth/callback${new URL(independentCallback).search}`)).status,303);
      assert.equal((await callback(await begin())).status,303);const current=await info();
      logoutGate=gate();const pending=request('/auth/logout',{method:'POST',headers:{'x-csrf-token':current.csrf}});await logoutGate.started;
      let childCookie:string;
      try{assert.equal((await callback(await begin())).status,303);childCookie=b.cookies.get(origin)!;}finally{logoutGate.release();}
      assert.equal((await pending).status,204);logoutGate=undefined;
      assert.equal((await idp.fetchTls(`${origin}/private`,{headers:{cookie:childCookie!}})).status,401);
      assert.equal((await independent.request(`${origin}/private`)).status,200);
    });
    await t.test('migration invalidates untracked old sessions and preserves tracked sessions on repeat',async()=>{
      assert.equal((await callback(await begin())).status,303);
      await pool.query("INSERT INTO human_sessions(sid,sess,expire) VALUES('pre-lineage','{}',to_timestamp($1))",[Math.ceil(Date.now()/1000)+3600]);
      await migrateIdentity(pool);await migrateIdentity(pool);
      assert.equal((await pool.query("SELECT sid FROM human_sessions WHERE sid='pre-lineage'")).rows.length,0);
      assert.equal((await request('/private')).status,200);
    });
    await t.test('expired ancestor tombstones are pruned while a newer child in the lineage stays valid',async()=>{
      assert.equal((await callback(await begin())).status,303);const current=await info();
      const old=(await pool.query("SELECT sid FROM human_sessions WHERE sess::jsonb->>'csrf'=$1",[current.csrf])).rows[0].sid;
      assert.equal((await callback(await begin())).status,303);
      await pool.query('UPDATE human_session_lifecycles SET valid_until=$2 WHERE sid=$1',[old,new Date(now-1000)]);
      t.mock.timers.tick(60_000);await identity.drainMaintenance();
      assert.equal((await pool.query('SELECT sid FROM human_session_lifecycles WHERE sid=$1',[old])).rows.length,0);
      assert.equal((await request('/private')).status,200);
    });
    await t.test('store recreation retains identity, epoch and disabled user recheck immediately',async()=>{
      assert.equal((await callback(await begin())).status,303);
      await identity.close();identity=createIdentityHttp({pool,config,transport,now:()=>new Date(now)});await identity.ready;
      assert.equal((await request('/private')).status,200);
      await pool.query("UPDATE human_users SET session_epoch=session_epoch+1 WHERE subject='owner-sub'");assert.equal((await request('/private')).status,401);
      assert.equal((await callback(await begin())).status,303);
      await pool.query("UPDATE human_users SET status='disabled' WHERE subject='owner-sub'");assert.equal((await request('/private')).status,401);
      await pool.query("UPDATE human_users SET status='active' WHERE subject='owner-sub'");
      assert.equal((await request('/private')).status,401,'re-enabling a disabled identity cannot revive its revoked HTTP session');
    });
    await t.test('expiry and failed exchange consume transaction; cryptographic and claim checks remain enabled',async()=>{
      let url=await begin();now+=300_000;assert.equal((await callback(url)).status,400);now=Date.now();
      for(const fault of ['issuer','audience','nonce','key'] as const){url=await begin();idp.setFault(fault);assert.equal((await callback(url)).status,400,fault);idp.setFault(undefined);assert.equal((await callback(url)).status,400);}
      url=await begin();await pool.query("UPDATE oidc_login_transactions SET verifier='wrong-verifier' WHERE consumed_at IS NULL");assert.equal((await callback(url)).status,400);assert.equal((await callback(url)).status,400);
    });
    await t.test('pending user stays unauthenticated; logout destroys SID and CSRF',async()=>{
      idp.setSubject('pending-sub');b.cookies.delete(idp.issuer);assert.equal((await callback(await begin())).status,303);const pending=await info();assert.equal(pending.authenticated,false);assert.equal(pending.user.status,'pending');assert.equal((await request('/private')).status,401);
      const cookie=b.cookies.get(origin);assert.equal((await request('/auth/logout',{method:'POST',headers:{'x-csrf-token':pending.csrf}})).status,204);
      assert.notEqual(b.cookies.get(origin),cookie);assert.equal((await info()).user,null);
      assert.equal((await request('/auth/logout',{method:'POST',headers:{'x-csrf-token':pending.csrf}})).status,403);
    });
    await t.test('idle and absolute bounds rechecked on each request',async()=>{
      idp.setSubject('owner-sub');b.cookies.delete(idp.issuer);assert.equal((await callback(await begin())).status,303);now+=30*60_000;assert.equal((await request('/private')).status,401);now=Date.now();
      assert.equal((await callback(await begin())).status,303);now+=8*60*60_000;assert.equal((await request('/private')).status,401);now=Date.now();
    });
    await t.test('IdP outage prevents new login while persisted valid sessions retain their TTL; store outage fails closed',async()=>{
      assert.equal((await callback(await begin())).status,303);
      idp.setUnavailable(true);await identity.close();identity=createIdentityHttp({pool,config,transport,now:()=>new Date(now)});await identity.ready;
      assert.equal((await request('/private')).status,200);const current=await info();assert.equal(current.loginAvailable,false);
      assert.equal((await login()).status,503);idp.setUnavailable(false);
      const query=pool.query.bind(pool);pool.query=(()=>Promise.reject(Error('isolated store offline'))) as typeof pool.query;
      try {assert.equal((await request('/private')).status,503);assert.equal((await request('/auth/session')).status,503);}
      finally {pool.query=query;}
    });
    await t.test('bounded lifecycle pruning cannot readmit a late response-end save after tombstones disappear',async()=>{
      assert.equal((await callback(await begin())).status,303);
      const oldCookie=b.cookies.get(origin)!,rows=(await pool.query("SELECT sid FROM human_sessions WHERE sess::jsonb ? 'human'")).rows;
      lateGate=gate();const late=request('/late/end');await lateGate.started;now+=24*60*60_000;
      try{
        const expired=new Date(now-48*60*60_000);
        await pool.query("INSERT INTO human_session_lifecycles(sid,family_sid,valid_until,retain_until) VALUES('cleanup-root','cleanup-root',$1,$1)",[expired]);
        await pool.query("INSERT INTO human_session_lifecycles(sid,family_sid,valid_until,retain_until) SELECT 'cleanup-child-'||n,'cleanup-root',$1,$1 FROM generate_series(1,501) n",[expired]);
        t.mock.timers.tick(60_000);await identity.drainMaintenance();
        assert.equal(Number((await pool.query("SELECT count(*) AS count FROM human_session_lifecycles WHERE family_sid='cleanup-root'")).rows[0].count),2,'one cleanup removes at most 500 children and retains their root');
        for(let cycle=0;cycle<40;cycle++){
          t.mock.timers.tick(60_000);
          // Flush each bounded asynchronous cleanup before deciding whether another minute is needed.
          await identity.drainMaintenance();
          if(!(await pool.query('SELECT sid FROM human_session_lifecycles')).rows.length)break;
        }
        assert.equal((await pool.query('SELECT sid FROM human_session_lifecycles')).rows.length,0);
      }finally{lateGate.release();await late;}
      await identity.close();identity=createIdentityHttp({pool,config,transport,now:()=>new Date(now)});await identity.ready;
      for(const row of rows)assert.equal((await pool.query('SELECT sid FROM human_sessions WHERE sid=$1',[row.sid])).rows.length,0);
      assert.equal((await idp.fetchTls(`${origin}/private`,{headers:{cookie:oldCookie}})).status,401);
      now=Date.now();assert.equal((await callback(await begin())).status,303,'fresh trusted issuance still works after pruning and service recreation');
    });
  } finally {lateGate?.release();tokenGate?.release();logoutGate?.release();await identity.close();await stop(server);await pool.end();await idp.close();}
});
