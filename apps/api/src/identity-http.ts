import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Request, type RequestHandler } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type pg from 'pg';
import type { CustomFetch } from 'openid-client';
import { activateIdentityMode, loadHumanPrincipal, upsertOidcIdentity, type HumanSessionReference } from './identity-store.ts';
import { identityText, principalKey, type IdentityConfig, type Principal } from './identity-types.ts';
import { createIdentityOidc } from './identity-oidc.ts';

declare module 'express-session' {
  interface SessionData { csrf?:string; human?:HumanSessionReference; identifiedUserId?:string; }
}

const cookieName='__Host-weiwu.sid';
const cookieOptions={secure:true,httpOnly:true,sameSite:'lax' as const,path:'/'};
const token=()=>randomBytes(32).toString('base64url');
const save=(req:Request)=>new Promise<void>((resolve,reject)=>req.session.save(error=>error?reject(error):resolve()));
const regenerate=(req:Request)=>new Promise<void>((resolve,reject)=>req.session.regenerate(error=>error?reject(error):resolve()));
const destroy=(req:Request)=>new Promise<void>((resolve,reject)=>req.session.destroy(error=>error?reject(error):resolve()));

/** All dependencies come from startup code. Never populate these options from HTTP input. */
export function createIdentityHttp({pool,config,transport,now=()=>new Date(),initializeAfter}: {
  pool:pg.Pool;config:IdentityConfig;transport?:CustomFetch;now?:()=>Date;initializeAfter?:Promise<void>;
}) {
  const router=express.Router({caseSensitive:true,strict:true});
  const protocol=config.mode==='oidc'?createIdentityOidc({pool,config,transport,now}):undefined;
  const PgStore=connectPgSimple(session);
  const freshRequests=new WeakSet<Request>();
  type Lifecycle={sid:string;family_sid:string;valid_until:Date;retain_until:Date;revoked_at:Date|null;family_revoked_at:Date|null};
  class DurablePgStore extends PgStore {
    declare generate:(req:Request)=>void;
    async issue(sid:string) {
      const until=new Date(now().getTime()+8*60*60_000);
      await pool.query('INSERT INTO human_session_lifecycles(sid,family_sid,valid_until,retain_until) VALUES($1,$1,$2,$2)',[sid,until]);
    }
    async transact<T>(work:(db:pg.PoolClient)=>Promise<T>) {
      const db=await pool.connect();
      try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}
      catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    }
    async locked(db:pg.PoolClient,sid:string,active:boolean) {
      const life=(await db.query<Lifecycle>('SELECT * FROM human_session_lifecycles WHERE sid=$1',[sid])).rows[0];
      if(!life){if(active)throw Error('Session is no longer valid');return null;}
      // Every save, rotate, logout and lineage prune acquires this root first. Never lock a child first.
      const root=(await db.query<Lifecycle>('SELECT * FROM human_session_lifecycles WHERE sid=$1 FOR UPDATE',[life.family_sid])).rows[0];
      const current=(await db.query<Lifecycle>('SELECT * FROM human_session_lifecycles WHERE sid=$1',[sid])).rows[0];
      if(!root||!current){if(active)throw Error('Session is no longer valid');return null;}
      if(active&&(root.family_revoked_at||current.revoked_at||new Date(current.valid_until)<=now()||new Date(root.retain_until)<=now()))throw Error('Session is no longer valid');
      return {root,current};
    }
    override set(sid:string,data:session.SessionData,callback?:(error?:unknown)=>void) {
      const work=this.transact(async db=>{
        const locked=(await this.locked(db,sid,true))!;
        const expire=Math.min(new Date(data.cookie.expires??locked.current.valid_until).getTime(),new Date(locked.current.valid_until).getTime());
        await db.query(`INSERT INTO human_sessions(sid,sess,expire) VALUES($1,$2,to_timestamp($3))
          ON CONFLICT(sid) DO UPDATE SET sess=EXCLUDED.sess,expire=EXCLUDED.expire`,[sid,JSON.stringify(data),Math.ceil(expire/1000)]);
      });
      void work.then(()=>callback?.(),error=>callback?.(error));
    }
    override destroy(sid:string,callback?:(error?:unknown)=>void) {
      const work=this.transact(async db=>{
        const locked=await this.locked(db,sid,false);if(!locked)return;
        if(new Date(locked.current.valid_until)<=now())return;
        await db.query('UPDATE human_session_lifecycles SET family_revoked_at=$2 WHERE sid=$1',[locked.root.sid,now()]);
        await db.query('DELETE FROM human_sessions WHERE sid IN (SELECT sid FROM human_session_lifecycles WHERE family_sid=$1)',[locked.root.sid]);
      });
      void work.then(()=>callback?.(),error=>callback?.(error));
    }
    override regenerate(req:Request,callback:(error?:unknown)=>void) {
      const oldSid=req.sessionID,oldSession=req.session;
      const work=this.transact(async db=>{
        const locked=(await this.locked(db,oldSid,true))!;
        this.generate(req);freshRequests.delete(req);
        const until=new Date(now().getTime()+8*60*60_000);
        await db.query('INSERT INTO human_session_lifecycles(sid,family_sid,valid_until,retain_until) VALUES($1,$2,$3,$3)',[req.sessionID,locked.root.sid,until]);
        await db.query('UPDATE human_session_lifecycles SET retain_until=GREATEST(retain_until,$2) WHERE sid=$1',[locked.root.sid,until]);
        await db.query('UPDATE human_session_lifecycles SET revoked_at=$2 WHERE sid=$1',[oldSid,now()]);
        await db.query('DELETE FROM human_sessions WHERE sid=$1',[oldSid]);
      });
      void work.then(()=>callback(),error=>{req.sessionID=oldSid;req.session=oldSession;callback(error);});
    }
    async pruneLineage() {
      await this.transact(async db=>{
        const roots=(await db.query<{sid:string}>(`SELECT root.sid FROM human_session_lifecycles root WHERE root.sid=root.family_sid
          AND (root.retain_until<=$1 OR EXISTS(SELECT 1 FROM human_session_lifecycles child WHERE child.family_sid=root.sid
            AND child.sid<>root.sid AND child.valid_until<=$1 AND NOT EXISTS(SELECT 1 FROM human_sessions stored WHERE stored.sid=child.sid)))
          ORDER BY root.sid LIMIT 500 FOR UPDATE`,[now()])).rows;
        if(!roots.length)return;
        const parameters:unknown[]=[now(),...roots.map(root=>root.sid)],slots=roots.map((_root,index)=>`$${index+2}`).join(',');
        await db.query(`DELETE FROM human_session_lifecycles WHERE sid IN (SELECT child.sid FROM human_session_lifecycles child
          JOIN human_session_lifecycles root ON root.sid=child.family_sid WHERE child.family_sid IN (${slots}) AND child.sid<>root.sid
          AND child.valid_until<=$1 AND NOT EXISTS(SELECT 1 FROM human_sessions stored WHERE stored.sid=child.sid)
          ORDER BY child.valid_until,child.sid LIMIT 500)`,parameters);
        await db.query(`DELETE FROM human_session_lifecycles root WHERE sid IN (${slots}) AND retain_until<=$1 AND NOT EXISTS
          (SELECT 1 FROM human_session_lifecycles child WHERE child.family_sid=root.sid AND child.sid<>root.sid)
          AND NOT EXISTS(SELECT 1 FROM human_sessions stored WHERE stored.sid=root.sid)`,parameters);
      });
    }
  }
  const store=config.mode==='oidc'?new DurablePgStore({pool,tableName:'human_sessions',createTableIfMissing:false,pruneSessionInterval:false,disableTouch:true}):undefined;
  const middleware:RequestHandler=config.mode==='oidc'?session({store,secret:config.sessionSecrets,name:cookieName,
    genid:req=>{freshRequests.add(req);return randomBytes(32).toString('base64url');},
    cookie:{...cookieOptions,maxAge:8*60*60_000},resave:false,saveUninitialized:false,rolling:false}):(_req,_res,next)=>next();
  let closed=false,initializing=false,initialized=false;
  let cleanup:Promise<void>|undefined;
  const ready=(async()=>{
    if(initializeAfter)await initializeAfter;
    if(closed)throw Error('Identity service is closed');
    initializing=true;
    await activateIdentityMode(pool,config);
    if(protocol){await pool.query('SELECT sid FROM human_sessions LIMIT 0');await pool.query('SELECT sid FROM human_session_lifecycles LIMIT 0');await protocol.initialize();}
    if(closed)throw Error('Identity service is closed');
    initialized=true;
  })();
  // Own and drain one bounded cleanup operation; the store's unbounded background prune is disabled.
  const timer=protocol?setInterval(()=>{
    if(closed||!initialized||cleanup)return;
    cleanup=(async()=>{
      await pool.query('DELETE FROM oidc_login_transactions WHERE id IN (SELECT id FROM oidc_login_transactions WHERE expires_at<=$1 LIMIT 500)',[now()]);
      await pool.query('DELETE FROM human_sessions WHERE sid IN (SELECT sid FROM human_sessions WHERE expire<=to_timestamp($1) LIMIT 500)',[now().getTime()/1000]);
      await store!.pruneLineage();
    })().catch(()=>{}).finally(()=>{cleanup=undefined;});
  },60_000):undefined;
  timer?.unref();
  const sessionMiddleware:RequestHandler=(req,res,next)=>{
    if(closed){res.status(503).json({error:'Identity service is closed'});return;}
    ready.then(()=>middleware(req,res,error=>{
      if(error){next(error);return;}
      if(!freshRequests.delete(req)){next();return;}
      // Only the library's fresh random-ID generation can admit a SID; set() can never admit one.
      store!.issue(req.sessionID).then(()=>next(),next);
    }),next);
  };
  async function reset(req:Request) {
    await destroy(req);store!.generate(req);freshRequests.delete(req);await store!.issue(req.sessionID);
    req.session.csrf=token();await save(req);
  }
  async function authenticate(req:Request):Promise<Principal|null> {
    await ready;
    if(closed) return null;
    if(config.mode==='legacy-local')return {kind:'local-owner'};
    const ref=req.session?.human;if(!ref)return null;
    if(ref.sessionId!==req.sessionID){await reset(req);return null;}
    const principal=await loadHumanPrincipal(pool,ref,now());
    if(!principal){await reset(req);return null;}
    principalKey(principal);
    req.session.human={...ref,lastSeenAt:now().toISOString()};await save(req);
    return principal;
  }
  const csrf:RequestHandler=(req,res,next)=>{
    if(config.mode==='legacy-local'){next();return;}
    const supplied=req.get('x-csrf-token'),expected=req.session?.csrf;
    if(!identityText(supplied,128)||!identityText(expected,128)||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)
      ||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))){res.status(403).json({error:'Invalid CSRF token'});return;}
    next();
  };
  // Express treats HEAD as GET. Keep these protocol endpoints exact in both method and path.
  router.use((req,res,next)=>{
    if(!['/auth/session','/auth/login','/auth/callback','/auth/logout'].includes(req.path)){next();return;}
    const expected=(req.path==='/auth/session'||req.path==='/auth/callback')?'GET':'POST';
    if(req.method!==expected){res.sendStatus(404);return;}
    res.set('Cache-Control','no-store');next();
  });
  router.get('/auth/session',async(req,res)=>{
    if(config.mode==='legacy-local'){res.json({mode:config.mode,authenticated:true,user:null,csrf:null,loginAvailable:false});return;}
    req.session.csrf??=token();const principal=await authenticate(req);let user=null;
    const userId=req.session.human?.userId??req.session.identifiedUserId;
    if(userId){const row=(await pool.query('SELECT id,display_name,email,status,org_role FROM human_users WHERE id=$1',[userId])).rows[0];
      if(row)user={id:row.id,displayName:row.display_name,email:row.email,status:row.status,orgRole:row.org_role};}
    await save(req);res.json({mode:config.mode,authenticated:!!principal,user,csrf:req.session.csrf,loginAvailable:protocol!.available()});
  });
  router.post('/auth/login',csrf,async(req,res,next)=>{
    if(!protocol){res.sendStatus(404);return;}
    try {await save(req);const url=await protocol.begin(req.sessionID,req.body?.returnTo);res.json({authorizationUrl:url.href});}
    catch(error){if(error instanceof Error&&error.message==='Invalid return target'){res.status(400).json({error:'Invalid return target'});return;}
      if((error as {status?:number}).status===429){res.sendStatus(429);return;}next(error);}
  });
  router.get('/auth/callback',async(req,res)=>{
    if(!protocol||config.mode!=='oidc'){res.sendStatus(404);return;}
    try {
      const query=req.originalUrl.includes('?')?req.originalUrl.slice(req.originalUrl.indexOf('?')):'';
      const result=await protocol.complete(req.sessionID,query);
      const user=await upsertOidcIdentity(pool,config,result.claims);
      await regenerate(req);req.session.csrf=token();const at=now().toISOString();
      if(user.status==='active')req.session.human={userId:user.id,sessionId:req.sessionID,sessionEpoch:user.sessionEpoch,authenticatedAt:at,createdAt:at,lastSeenAt:at};
      else req.session.identifiedUserId=user.id;
      await save(req);res.redirect(303,result.returnTo);
    }catch {res.status(400).json({error:'Login could not be completed'});}
  });
  router.post('/auth/logout',csrf,async(req,res)=>{
    if(config.mode==='oidc')await destroy(req);
    res.clearCookie(cookieName,cookieOptions);res.sendStatus(204);
  });
  const drainMaintenance=async()=>{await cleanup;};
  return {router,sessionMiddleware,ready,authenticate,csrf,drainMaintenance,async close(){closed=true;if(timer)clearInterval(timer);if(initializing)await ready.catch(()=>{});await drainMaintenance();await store?.close();}};
}
