// Open only a disposable copy of the stopped database. Never run app services.
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {resolve} from 'node:path';
import {realpathSync} from 'node:fs';
const data=realpathSync(process.argv[2]);
const allowed=['mvp-hardening-20261020','mvp-hardening-final-20261020','mvp-hardening-runtime-20261020','mvp-hardening-correction-20261020','mvp-hardening-admission-20261020','mvp-hardening-snapshot-20261020','mvp-hardening-coordination-20261020'].map(phase=>resolve('/home/jj/.local/share/weiwu/validation',phase,'stopped-database-check'));
if(!allowed.includes(data))throw Error('Only the disposable stopped database copy is permitted');
const db=await PGlite.create({dataDir:data,extensions:{vector}});
try{
 const count=async sql=>Number((await db.query(sql)).rows[0].count);
 const result={activeRuns:await count("SELECT count(*) FROM project_runs WHERE status IN ('queued','running')"),activeMessages:await count("SELECT count(*) FROM manager_messages WHERE status IN ('waiting','replying')"),pendingCalls:await count("SELECT count(*) FROM model_reservations WHERE status='pending'"),activeCapabilities:await count("SELECT count(*) FROM model_capability_tests WHERE status='running'")};
 console.log(JSON.stringify(result));
 if(Object.values(result).some(Boolean))process.exitCode=3;
}finally{await db.close();}
