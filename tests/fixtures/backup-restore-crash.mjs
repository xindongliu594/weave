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
const traceRoot=path.join(root,'runs'),pending=inspectBackupRestoreStartup({traceRoot,dataRoot:root}),writers=createArchiveWriterManager({traceRoot,initializeTraceRoot:!pending.pending});
const pool=args.kind==='enterprise-v2'?(await import('../../apps/api/src/db.ts')).pool:new pg.Pool({connectionString,max:1,application_name:args.applicationName??'owned-backup-restart'});
// PGlite has one backend. The real importer and receipt service must share its
// product connection instead of opening a second pool in each killed child.
if(args.kind==='enterprise-v2')pool.options.max=1;
const service=createBackupRestoreState({pool,writers,traceRoot,dataRoot:root});
if(args.kind==='enterprise-v2'){
 if(owner.kind!=='enterprise-v2'||!/^enterprise_crash_target_[a-f0-9]{32}$/.test(owner.schema))throw Error('Owned enterprise target schema required');
 await pool.query('SET search_path TO '+owner.schema+',public');
}
if(args.action==='reconcile'){
 if(args.notifyWait)process.send({phase:'reconcile-starting'});
 try{const result=await service.reconcilePending();await pool.end();process.send(result,()=>process.exit(0));}
 catch(error){if(args.kind!=='enterprise-v2')throw error;await pool.end().catch(()=>{});process.send({status:'blocked',code:error?.code??'UNKNOWN'},()=>process.exit(1));}
}else if(args.kind==='enterprise-v2'){
 const productPool=pool;
 const {restoreEnterpriseBackup}=await import('../../apps/api/src/enterprise-backup-restore.ts'),payload=JSON.parse(fs.readFileSync(path.join(root,'payload.json'),'utf8'));let originalOperation;
 function park(phase){
  fs.writeFileSync(path.join(root,'phase.json.tmp'),JSON.stringify({phase,operationId:originalOperation.id,inputDigest:originalOperation.manifest.inputDigest}),{flag:'wx',mode:0o600});fs.renameSync(path.join(root,'phase.json.tmp'),path.join(root,'phase.json'));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 }
 if(args.phase==='committed'){
  const connect=productPool.connect.bind(productPool);productPool.connect=async()=>{
   const client=await connect(),query=client.query.bind(client);client.query=async(sql,...values)=>{const result=await query(sql,...values);if(sql==='COMMIT')park('committed');return result;};return client;
  };
 }
 const crashState={...service,async prepareRestore(db,input){originalOperation=await service.prepareRestore(db,input);if(args.phase==='prepared')park('prepared');return originalOperation;},installArchive(operation){
  if(args.phase==='old-moved'){fs.renameSync(traceRoot,operation.beforeTrace);park('old-moved');}
  service.installArchive(operation);if(args.phase==='installed')park('installed');
 }};
 await restoreEnterpriseBackup({principal:{kind:'local-owner'},payload,traceRoot,writers,state:crashState});throw Error('Enterprise crash phase was not reached');
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
