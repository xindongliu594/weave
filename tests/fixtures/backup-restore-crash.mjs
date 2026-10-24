import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pg from 'pg';
import {createArchiveWriterManager} from '../../services/agent-runtime/archive-writer-scope.mjs';
import {createBackupRestoreState,inspectBackupRestoreStartup} from '../../apps/api/src/backup-restore-state.ts';
import {restoreVaultFiles} from '../../apps/api/src/obsidian.ts';
const args=JSON.parse(process.env.OWNED_BACKUP_RESTART_TEST??'null');
const native=process.env.OWNED_BACKUP_NATIVE_TEST==='true';
if(!args||!native&&process.env.SIMULATED_INTEGRATION!=='pglite')throw Error('Owned isolated restart fixture required');
const temporary=fs.realpathSync(os.tmpdir()),root=fs.realpathSync(args.root),relative=path.relative(temporary,root),owner=JSON.parse(fs.readFileSync(path.join(root,'.owned-backup-test.json'),'utf8'));
if(!/^weiwu-backup-state-[A-Za-z0-9]+$/.test(relative)||owner.root!==root||owner.pid!==process.ppid)throw Error('Owned restart path required');
const connectionString=native?process.env.BACKUP_RESTORE_POSTGRES_URL:process.env.DATABASE_URL,database=new URL(connectionString);if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname)||!database.port||database.search||database.hash||(native?database.username!=='weiwu_test'||!/^\/weiwu_backup_test_[a-f0-9]{32}$/.test(database.pathname):database.pathname!=='/postgres'))throw Error('Isolated database required');
process.env.DATA_DIR=root;process.env.OBSIDIAN_VAULT=path.join(root,'vault');process.env.LOCAL_WORKSPACE_ROOT=root;
const traceRoot=path.join(root,'runs'),pending=inspectBackupRestoreStartup({traceRoot,dataRoot:root}),writers=createArchiveWriterManager({traceRoot,initializeTraceRoot:!pending.pending}),pool=new pg.Pool({connectionString,max:1,application_name:args.applicationName??'owned-backup-restart'}),service=createBackupRestoreState({pool,writers,traceRoot,dataRoot:root});
if(args.action==='reconcile'){
 if(args.notifyWait)process.send({phase:'reconcile-starting'});
 const result=await service.reconcilePending();await pool.end();process.send(result,()=>process.exit(0));
}else await writers.withRootExclusive(async()=>{
 const client=await pool.connect();await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918274)');await client.query('SELECT pg_advisory_xact_lock(918275)');
 const stage=service.createStage();fs.mkdirSync(path.join(stage.path,args.runId));fs.writeFileSync(path.join(stage.path,args.runId,'proof.txt'),'after');
 const operation=await service.prepareRestore(client,{stage,master:Buffer.alloc(32,8).toString('base64'),vaultFiles:{'note.md':Buffer.from('after-note').toString('base64')},previousPaths:['note.md'],nativePluginBundles:{},inputDigest:'b'.repeat(64)});
 await client.query("INSERT INTO activity(id,kind,title) VALUES($1,'owned-restore-crash','isolated receipt business row')",[operation.id]);
 if(args.phase==='old-moved')fs.renameSync(traceRoot,operation.beforeTrace);
 if(['installed','committed'].includes(args.phase)){restoreVaultFiles({'note.md':Buffer.from('after-note').toString('base64')},['note.md']);service.installArchive(operation);}
 if(args.phase==='committed'){await service.recordCommitReceipt(client,operation);await client.query('COMMIT');}
 process.send({phase:args.phase,operationId:operation.id});await new Promise(()=>{});
});
