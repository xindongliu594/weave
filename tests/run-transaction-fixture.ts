import assert from 'node:assert/strict';
import type pg from 'pg';

// PGlite's socket RAISE path emits an unexpected commandComplete in this
// runtime. Inject only the second persistence statement's client failure while
// the real BEGIN, run/approval writes and ROLLBACK still execute in PGlite.
export async function withProjectStatusFailure(pool:pg.Pool,work:()=>Promise<unknown>){
 assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');assert.match(process.env.DATABASE_URL??'',/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres(?:\?|$)/);
 const connect=pool.connect;let injected=0;
 (pool as any).connect=async()=>{
  const client=await (connect as ()=>Promise<pg.PoolClient>).call(pool),query=client.query,release=client.release;
  (client as any).query=function(text:any,...args:any[]){
   if(typeof text==='string'&&text.startsWith('UPDATE projects SET status=')){injected++;throw Error('injected project status persistence failure');}
   return (query as any).call(client,text,...args);
  };
  client.release=function(error?:Error|boolean){client.query=query;client.release=release;release.call(client,error);};return client;
 };
 try{await work();assert.equal(injected,1,'only the intended project persistence statement fails');}finally{pool.connect=connect;}
}
