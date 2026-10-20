import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {migrateIdentity} from '../../../apps/api/src/identity-schema.ts';

export function identityPostgresUrl(value:string){
 const url=new URL(value);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username!=='weiwu_test'||!url.password||!/^\d+$/.test(url.port)||Number(url.port)<1||Number(url.port)>65535||!/^\/weiwu_identity_test_[a-f0-9]{32}$/.test(url.pathname)||url.search||url.hash)throw Error('An explicit owned loopback identity test database is required');
 return url.href;
}

/** Test-only explicit URL; never fall back to ambient DATABASE_URL. */
export async function identityPostgresPool(value:string):Promise<pg.Pool>{
 const connectionString=identityPostgresUrl(value),schema='oidc_'+randomUUID().replaceAll('-','');
 const connect=()=>new pg.Pool({connectionString,connectionTimeoutMillis:3000,statement_timeout:10000});
 const admin=connect();try{await admin.query(`CREATE SCHEMA ${schema}`);}finally{await admin.end();}
 const pool=new pg.Pool({connectionString,options:'-c search_path='+schema,connectionTimeoutMillis:3000,statement_timeout:10000,max:8});
 const originalEnd=pool.end.bind(pool);let closing:Promise<void>|undefined;
 pool.end=()=>closing??=(async()=>{await originalEnd();const cleanup=connect();try{await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await cleanup.end();}})();
 try{await pool.query('CREATE TABLE departments(id text PRIMARY KEY)');await migrateIdentity(pool);return pool;}
 catch(error){await pool.end();throw error;}
}
