import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {resourcePostgresUrl} from './test-support/resource-postgres.mjs';

const url=resourcePostgresUrl(process.env.RESOURCE_TEST_DATABASE_URL);
const allowed=new Set(['tests/resource-approval-audit.test.ts','tests/knowledge-department-lock.test.ts']);
const paths=process.argv.slice(2);if(!paths.length)paths.push('tests/resource-approval-audit.test.ts');
if(paths.some(path=>!allowed.has(path)))throw Error('Only the implemented resource approval and knowledge department-lock fixtures are allowed');
const pool=new pg.Pool({connectionString:url.href,connectionTimeoutMillis:3000,statement_timeout:10000});
try{
  for(const path of paths){
    const schema='resource_'+randomUUID().replaceAll('-','');await pool.query(`CREATE SCHEMA ${schema}`);
    const childUrl=new URL(url);childUrl.searchParams.set('options','-c search_path='+schema);
    try{
      const env={...process.env,DATABASE_URL:childUrl.href,SIMULATED_INTEGRATION:'resource-postgres',RESOURCE_TEST_SCHEMA:schema};
      delete env.KNOWLEDGE_REVIEW_POSTGRES_URL;
      const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1',path],{env,stdio:'inherit',windowsHide:true});
      const timer=setTimeout(()=>child.kill('SIGTERM'),120000);let code;
      try{code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});}finally{clearTimeout(timer);}
      if(code!==0){process.exitCode=code??1;break;}
    }finally{await pool.query(`DROP SCHEMA ${schema} CASCADE`);}
  }
}finally{await pool.end();}
