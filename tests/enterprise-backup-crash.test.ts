import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enterpriseCrashPhases} from './helpers/enterprise-backup-crash.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use isolated integration runner');
const cases=[...enterpriseCrashPhases.map(phase=>'enterprise preserving import process restart after '+phase),...['marker','generation','file'].map(fault=>'committed enterprise restart retains its barrier after damaged '+fault)];
// Reuse the isolated runner once per destructive connection test. A killed
// connection must not leak PGlite bridge state into a different crash case.
for(const name of cases)test(name,{timeout:60000},async t=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 try{const {stdout}=await promisify(execFile)(process.execPath,['scripts/test-integration.mjs','tests/fixtures/enterprise-backup-crash-case.ts','--test-name-pattern='+name+'$'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,signal:t.signal,maxBuffer:512*1024});
  assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);
  const proof=stdout.split(/\r?\n/).find(line=>line.includes('"sourceUnchanged":true'));assert.ok(proof,'real owned importer must emit its source/operation proof');t.diagnostic(proof);
 }catch(error:any){t.diagnostic(String(error.stdout??'').slice(-12000));t.diagnostic(String(error.stderr??'').slice(-12000));throw error;}
});
