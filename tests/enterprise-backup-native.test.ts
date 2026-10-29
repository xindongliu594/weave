import {test,after} from 'node:test';
import {enterpriseCrashCase,enterpriseCrashPhases} from './helpers/enterprise-backup-crash.ts';
const url=process.env.BACKUP_RESTORE_POSTGRES_URL;
if(url){const parsed=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||parsed.username!=='weiwu_test'||!/^\/weiwu_backup_test_[a-f0-9]{32}$/.test(parsed.pathname)||!parsed.port||parsed.search||parsed.hash)throw Error('Explicit owned backup native database required');process.env.DATABASE_URL=url;}
after(async()=>{if(url)await (await import('../apps/api/src/db.ts')).pool.end();});
for(const phase of enterpriseCrashPhases)test('native enterprise preserving import process restart after '+phase,{skip:!url},async t=>enterpriseCrashCase(phase,true,t));
for(const fault of ['marker','generation','file'] as const)test('native committed enterprise restart retains barrier after damaged '+fault,{skip:!url},async t=>enterpriseCrashCase('committed',true,t,fault));
