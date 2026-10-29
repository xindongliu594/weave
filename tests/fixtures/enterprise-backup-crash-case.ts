import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {enterpriseCrashCase,enterpriseCrashPhases} from '../helpers/enterprise-backup-crash.ts';
assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use isolated integration runner');
after(async()=>{await (await import('../../apps/api/src/db.ts')).pool.end();});
for(const phase of enterpriseCrashPhases)test('enterprise preserving import process restart after '+phase,async t=>enterpriseCrashCase(phase,false,t));
for(const fault of ['marker','generation','file'] as const)test('committed enterprise restart retains its barrier after damaged '+fault,async t=>enterpriseCrashCase('committed',false,t,fault));
