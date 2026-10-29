import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

const schema = `extensions_backup_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const originalURL = process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin = new pg.Pool({ connectionString: originalURL });
const password = 'test-fixture-password';
const archivedRunId = randomUUID();
let archivedEvents:any;
let stepCheckpoint:any;
let lineageSourceId:string,lineageChildId:string;
let pool: pg.Pool, server: http.Server, url: string, directory: string, backupModule: typeof import('../apps/api/src/backup.ts'), backup: any, documentId: string;
let extensionTables: string[];
async function call(path: string, body: any) { const result = await fetch(url + '/backup/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: result.status, data: await result.json() }; }
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); const dbUrl = new URL(originalURL); dbUrl.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = dbUrl.toString();
  directory = await mkdtemp(join(tmpdir(), 'ad-extensions-backup-')); process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  await mkdir(join(directory, 'runs', archivedRunId, 'artifacts'), { recursive: true }); await writeFile(join(directory, 'runs', archivedRunId, 'artifacts', 'result.txt'), 'Windows 嵌套档案也必须完整保留。');
  const trace=await import('../services/agent-runtime/trace-store.mjs'),journals=await import('../services/agent-runtime/journal-archive.mjs');const completed=trace.createRunArchive(join(directory,'runs'),{title:'cold backup fixture'},{id:archivedRunId});
  const {commitStepCheckpoint}=await import('../services/agent-runtime/step-checkpoints.mjs');
  const workspace=join(directory,'runs',archivedRunId,'artifacts');
  await writeFile(join(workspace,'progress.txt'),'checkpoint version');
  stepCheckpoint=commitStepCheckpoint({archive:completed,workspace,boundary:{taskId:'qa',attemptId:'qa-first',sessionId:'qa-session',trigger:'tool-result',eventCursor:1,contractHash:'a'.repeat(64)},receipts:[]});
  await writeFile(join(workspace,'progress.txt'),'later workspace version');
  completed.append('evidence/test-output',{output:'backup evidence\n'.repeat(2000)});completed.append('run/finished',{status:'completed'});archivedEvents=trace.readRun(join(directory,'runs'),archivedRunId)!.events;journals.archiveJournal(join(directory,'runs'),journals.journalArchiveCandidate(join(directory,'runs'),archivedRunId));
  // Protocol fixture only: tests archive/backup inheritance, not an employee or sandbox execution.
  const backend={kind:'openshell',version:'fixture',image:'node@sha256:'+'1'.repeat(64)};
  const execution={...backend,node:'v24.19.0',uid:1000,gid:1000,effectivePolicyHash:'2'.repeat(64),memory:536870912,cpu:[100000,100000]};
  const task={id:'qa',assignee:'qa',kind:'verification',dependencies:[],inputs:[],outputs:[{path:'unit.test.mjs'}],verify:['node --test unit.test.mjs'],verificationReuse:'same-workspace'};
  const savedSnapshot={projectId:'backup-lineage',planVersion:1,agents:[{id:'qa',tools:['filesystem','terminal_test']}],tasks:[task],executionTarget:{kind:'local',backend}};
  const source=trace.createRunArchive(join(directory,'runs'),savedSnapshot);lineageSourceId=source.id;
  const sourceFiles=join(source.dir,'artifacts');await mkdir(sourceFiles);await writeFile(join(sourceFiles,'unit.test.mjs'),'// backup fixture; not actually executed\n');
  const {HandoffGate}=await import('../services/agent-runtime/handoff.mjs');
  const {listArtifacts}=await import('../services/agent-runtime/sandbox.mjs');
  const {buildCheckpointContext}=await import('../services/agent-runtime/checkpoint-context.mjs');
  source.append('local/device-bound',{execution});
  const context={sessionId:'fixture-qa',callId:'fixture-call',approvalId:'fixture-approval'};
  for(const type of ['local/operation-queued','local/operation-finished'])source.append(type,{operationId:'fixture-op',name:'terminal_test',taskId:'qa',attemptId:'source-attempt',...context,execution});
  new HandoffGate({snapshot:savedSnapshot,archive:source,sandbox:{root:sourceFiles}}).observe('qa','source-attempt','terminal_test',{command:task.verify[0]},
   {exitCode:0,output:'# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',execution,verificationProfile:'node-permission-workspace-v1'},listArtifacts(sourceFiles),context);
  source.append('run/finished',{status:'cancelled'});
  const recovery=buildCheckpointContext(savedSnapshot,trace.readRun(join(directory,'runs'),source.id)!.events,new Map(),new Map(),sourceFiles,source.id);
  const child=trace.createRunArchive(join(directory,'runs'),{...savedSnapshot,recovery});lineageChildId=child.id;
  await cp(sourceFiles,join(child.dir,'artifacts'),{recursive:true});child.append('local/device-bound',{execution});child.append('run/finished',{status:'cancelled'});
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate(); backupModule = await import('../apps/api/src/backup.ts');
  const automation = await import('../apps/api/src/automation-learning.ts'), chat = await import('../apps/api/src/manager-chat.ts'), browser = await import('../apps/api/src/work-tools-browser.ts'), files = await import('../apps/api/src/work-files.ts');
  const storage=await import('../apps/api/src/storage-governance.ts');
  extensionTables = [...chat.managerChatTables, ...browser.browserMcpTables, ...files.workFileTables, ...automation.automationTables,...storage.storageTables];
  await pool.query("INSERT INTO storage_cleanups(id,status,preview,result) VALUES('cleanup-fixture','completed',$1,$2)",[{candidates:[{runId:archivedRunId,path:'result.txt',bytes:42}],policy:'fixture'}, {bytes:42,deleted:[{runId:archivedRunId,path:'result.txt'}]}]);
  await pool.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)", [{ name: 'Fixture gateway', baseUrl: 'http://127.0.0.1:1/v1' }]);
  await pool.query("INSERT INTO models(id,data,status) VALUES('model',$1,'available')", [{ name: 'Fixture', gatewayId: 'gateway', model: 'fixture', inputRate: 1, outputRate: 2 }]);
  const agent = { id: 'manager', name: '经理', role: 'manager', title: '经理', modelId: 'model', instructions: '协调项目', tools: [] };
  await pool.query("INSERT INTO departments(id,data) VALUES('department',$1)", [{ name: 'Fixture', agents: [agent] }]);
  const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 300, allowedModelIds: ['model'], allowedTools: [], allowedKnowledgeSpaceIds: [], allowedDepartmentIds: ['department'] }, plan = { agents: [agent], tasks: [] };
  await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('project','department',1,'Fixture','备份扩展功能测试需求',$1,$2,'manual')", [policy, plan]);
  await pool.query("INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES('latest-usage','model','project',12,13,0.12,'backup-fixture')");
  await pool.query("INSERT INTO model_reservations(id,model_id,project_id,purpose,amount,input_rate,output_rate,status) VALUES('unknown-cost','model','project','backup-fixture',0.13,1,2,'uncertain')");
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES('run','project',1,'completed',$1)", [{ approval: { kind: 'project' }, title: 'Fixture completed', agents: [agent], policy }]);
  await pool.query("INSERT INTO knowledge_spaces(id,name,scope,agent_ids) VALUES('space','经验','company','[]')");
  // This positive fixture represents a pre-identity business-only installation.
  // Modern knowledge writes create audit history that v1 intentionally cannot export.
  documentId = randomUUID(); const content = '测试前应确认版本。';
  await pool.query("INSERT INTO knowledge_documents(id,space_id,title) VALUES($1,'space','经验来源')", [documentId]);
  await pool.query('INSERT INTO knowledge_revisions(document_id,version,content,sha256) VALUES($1,1,$2,$3)', [documentId, content, createHash('sha256').update(content).digest('hex')]);
  const { chunkDocument } = await import('../services/agent-runtime/knowledge.mjs');
  for (const chunk of chunkDocument(documentId, 1, content)) await pool.query('INSERT INTO knowledge_chunks(id,document_id,version,line_start,line_end,content,tokens) VALUES($1,$2,1,$3,$4,$5,$6)', [chunk.id, documentId, chunk.lineStart, chunk.lineEnd, chunk.content, JSON.stringify(chunk.tokens)]);
  await (await import('../apps/api/src/obsidian.ts')).writeVaultDocument(documentId);
  const revision = (await pool.query('SELECT sha256 FROM knowledge_revisions WHERE document_id=$1 AND version=1', [documentId])).rows[0];
  await pool.query("INSERT INTO automation_schedules(id,name,source_project_id,snapshot,kind,interval_seconds,next_due) VALUES('schedule','每日检查','project',$1,'interval',86400,now()+interval '1 day')", [{ department_id: 'department', department_version: 1, department_name: 'Fixture', requirement: '备份扩展功能测试需求', policy, plan }]);
  await pool.query("INSERT INTO automation_occurrences(id,schedule_id,due_at,project_id) VALUES('occurrence','schedule',now(),'project')");
  await pool.query("INSERT INTO automation_notifications(id,event_key,kind,title,details,read_at) VALUES('notification','run:run','success','已完成','{}',now())");
  await pool.query("INSERT INTO automation_observations(id,run_id,bucket,status,details,observed_at) VALUES('observation','run','terminal','completed','{}',now())");
  await pool.query("INSERT INTO automation_knowledge_candidates(id,run_id,document_id,source_version,source_hash,space_id,title,content,reuse_evidence) VALUES('candidate','run',$1,1,$2,'space','待审查经验','来源摘录',$3)", [documentId, revision.sha256,{source:{documentId,version:1,sha256:revision.sha256},works:[{runId:'run',workKey:'project:1'}],successWorkCount:3,minSuccessfulWorks:3}]);
  await pool.query("INSERT INTO automation_improvements(id,title,source_run_id,baseline,proposal,cases,status) VALUES('improvement','改进建议','run','原方案','新方案','[]','adopted')");
  await pool.query("INSERT INTO automation_evaluations(id,improvement_id,results) VALUES('evaluation','improvement','{\"beforeScore\":0,\"afterScore\":1}')");
  await pool.query("INSERT INTO automation_reviews(id,improvement_id,evaluation_id,action,note) VALUES('review','improvement','evaluation','adopt','人工核对通过')");
  await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,status,max_cost,model_id,model_version,gateway_version) VALUES('waiting-message','project',1,'等待经理回复','waiting',0.02,'model',1,1)");
  await pool.query("INSERT INTO manager_messages(id,project_id,project_version,content,reply,status,max_cost,model_id,model_version,gateway_version) VALUES('replied-message','project',1,'历史问题','历史答复','replied',0.02,'model',1,1)");
  const vault = await import('../apps/api/src/vault.ts');
  await pool.query("INSERT INTO mcp_connections(id,data,credential,tools) VALUES('mcp',$1,$2,$3)", [{ name: 'Fixture MCP', url: 'http://127.0.0.1:1/mcp', enabled: true, allowedEmployees: [{ departmentId: 'department', agentId: 'manager' }], allowedTools: ['read'] }, vault.seal('fixture-token'), JSON.stringify([{ name: 'read', inputSchema: { type: 'object' } }])]);
  const snapshot = files.prepareWorkFileSnapshot({ name: '导入目录', files: [{ path: 'todo/README.md', base64: Buffer.from('Todo API').toString('base64') }] });
  await pool.query("INSERT INTO work_file_snapshots(id,name,files,bytes) VALUES('files',$1,$2,$3)", [snapshot.name, JSON.stringify(snapshot.files), snapshot.bytes]);
  const {createArchiveWriterManager}=await import('../services/agent-runtime/archive-writer-scope.mjs');
  const {createBackupRestoreState,migrateBackupRestoreState}=await import('../apps/api/src/backup-restore-state.ts');await migrateBackupRestoreState(pool);
  const writers=createArchiveWriterManager({traceRoot:join(directory,'runs')}),state=createBackupRestoreState({pool,writers,traceRoot:join(directory,'runs'),dataRoot:directory});await state.reconcilePending();
  const app = express(); app.use(express.json({ limit: '45mb' }));app.use((_req,res,next)=>{res.locals.principal={kind:'local-owner'};next();}); app.use(backupModule.backupRouter(join(directory, 'runs'),writers,state)); app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ message: error.message, code: error.code }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await pool?.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); if (directory) await rm(directory, { recursive: true, force: true }); });

test('extension tables survive encrypted backup while scheduled dispatch and pending chat require fresh user action', async () => {
  await pool.query("INSERT INTO organization_conversations(id,turn_id,preview_id) VALUES('conversation','latest-turn','latest-preview')");
  const exported = await call('export', { password }); assert.equal(exported.status, 200, JSON.stringify(exported.data)); backup = exported.data;
  const plain = await backupModule.decryptBackup(backup, password);
  assert.equal(plain.tables.organization_conversations[0].turn_id,'latest-turn');
  await pool.query("UPDATE organization_conversations SET turn_id='changed',preview_id=NULL");
  assert.equal(Buffer.from(plain.files[archivedRunId + '/artifacts/result.txt'], 'base64').toString(), 'Windows 嵌套档案也必须完整保留。');
  assert.ok(Object.keys(plain.vaultFiles).length > 0); assert.ok(Object.keys(plain.vaultFiles).every(key => !key.includes('\\')), 'vault paths are portable relative paths');
  for (const table of extensionTables) assert.ok(plain.tables[table].length > 0, `${table} is included`);
  assert.equal(plain.tables.automation_schedules[0].status, 'active');
  assert.equal(plain.tables.storage_cleanups[0].result.bytes,42);
  await pool.query("UPDATE automation_schedules SET name='Changed',status='cancelled'"); await pool.query("UPDATE work_file_snapshots SET name='Changed'");
  const restored = await call('restore', { password, backup, confirmation: 'RESTORE' }); assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.deepEqual((await pool.query('SELECT turn_id,preview_id FROM organization_conversations')).rows,[{turn_id:'latest-turn',preview_id:'latest-preview'}]);
  assert.equal((await pool.query("SELECT name,status FROM automation_schedules WHERE id='schedule'")).rows[0].status, 'paused');
  assert.equal((await pool.query("SELECT name FROM automation_schedules WHERE id='schedule'")).rows[0].name, '每日检查');
  const messages = (await pool.query('SELECT id,status,reply,error FROM manager_messages')).rows;
  assert.equal(messages.find(m => m.id === 'waiting-message').status, 'cancelled'); assert.match(messages.find(m => m.id === 'waiting-message').error, /重新发送/);
  assert.equal(messages.find(m => m.id === 'replied-message').reply, '历史答复'); assert.equal(messages.find(m => m.id === 'replied-message').status, 'replied');
  assert.equal((await pool.query("SELECT name,files FROM work_file_snapshots WHERE id='files'")).rows[0].files[0].path, 'todo/README.md');
  assert.equal((await pool.query('SELECT * FROM automation_reviews')).rows[0].note, '人工核对通过');
  assert.deepEqual((await pool.query("SELECT result FROM storage_cleanups WHERE id='cleanup-fixture'")).rows[0].result,{bytes:42,deleted:[{runId:archivedRunId,path:'result.txt'}]});
  assert.ok((await pool.query('SELECT read_at FROM automation_notifications')).rows[0].read_at);
  const vault = await import('../apps/api/src/vault.ts'); assert.equal(vault.unseal((await pool.query("SELECT credential FROM mcp_connections WHERE id='mcp'")).rows[0].credential), 'fixture-token');
  assert.equal((await pool.query('SELECT document_id FROM automation_knowledge_candidates')).rows[0].document_id, documentId);
  assert.deepEqual((await pool.query('SELECT reuse_evidence FROM automation_knowledge_candidates')).rows[0].reuse_evidence.works,[{runId:'run',workKey:'project:1'}]);
  assert.equal(await readFile(join(directory, 'runs', archivedRunId, 'artifacts', 'result.txt'), 'utf8'), 'Windows 嵌套档案也必须完整保留。');
  const {readRun}=await import('../services/agent-runtime/trace-store.mjs');assert.deepEqual(readRun(join(directory,'runs'),archivedRunId)!.events,archivedEvents);assert.ok((await readFile(join(directory,'runs',archivedRunId,'events.jsonl.gz'))).length>0);
});

test('encrypted backup preserves checkpoint objects separately from later delivery versions',async()=>{
 const {readStepCheckpoint}=await import('../services/agent-runtime/step-checkpoints.mjs');
 const {restoreStepWorkspace}=await import('../apps/api/src/step-checkpoint-recovery.ts');
 const traceRoot=join(directory,'runs'),reference={id:stepCheckpoint.id,runId:archivedRunId,sha256:stepCheckpoint.sha256};
 const restored=readStepCheckpoint({root:traceRoot,runId:archivedRunId,checkpointId:reference.id});
 assert.deepEqual(restored,stepCheckpoint);
 const plain=await backupModule.decryptBackup(backup,password);
 for(const file of restored.files)assert.equal(Buffer.from(plain.files[`${archivedRunId}/checkpoint-objects/${file.sha256}`],'base64').length,file.size);
 const target=join(directory,'checkpoint-restored-workspace');
 restoreStepWorkspace(traceRoot,reference,target);
 assert.equal(await readFile(join(target,'progress.txt'),'utf8'),'checkpoint version');
 assert.equal(await readFile(join(traceRoot,archivedRunId,'artifacts','progress.txt'),'utf8'),'later workspace version');
 const content=restored.files.find((file:any)=>file.path==='progress.txt');
 const object=join(traceRoot,archivedRunId,'checkpoint-objects',content.sha256),original=await readFile(object);
 try {
  await writeFile(object,'corrupt');
  assert.throws(()=>readStepCheckpoint({root:traceRoot,runId:archivedRunId,checkpointId:reference.id}),/CHECKPOINT_CONTENT/);
  await rm(object);
  assert.throws(()=>restoreStepWorkspace(traceRoot,reference,join(directory,'must-not-restore')),/ENOENT|CHECKPOINT/);
 } finally {await writeFile(object,original);}
 assert.deepEqual(readStepCheckpoint({root:traceRoot,runId:archivedRunId,checkpointId:reference.id}),stepCheckpoint);
});

test('missing or corrupt checkpoint objects reject backup restoration before replacing current data',async()=>{
 const content=stepCheckpoint.files.find((file:any)=>file.path==='progress.txt');
 const key=`${archivedRunId}/checkpoint-objects/${content.sha256}`;
 const journal=join(directory,'runs',archivedRunId,'events.jsonl.gz'),before=await readFile(journal);
 for(const mode of ['missing','corrupt']){
  const plain=await backupModule.decryptBackup(backup,password);
  if(mode==='missing')delete plain.files[key];else plain.files[key]=Buffer.from('corrupt').toString('base64');
  await pool.query("UPDATE automation_schedules SET name='preserve current data' WHERE id='schedule'");
  const response=await call('restore',{password,backup:await backupModule.encryptBackup(plain,password),confirmation:'RESTORE'});
  assert.equal(response.status,422,mode+' checkpoint must be rejected before data replacement');
  assert.match(response.data.message,/检查点|checkpoint/i);
  assert.equal((await pool.query("SELECT name FROM automation_schedules WHERE id='schedule'")).rows[0].name,'preserve current data');
  assert.deepEqual(await readFile(journal),before);
  assert.deepEqual((await readdir(directory)).filter(name=>name.startsWith('restore-')),[],'failed staging directories are removed');
 }
});

test('backup restores both generations and original test receipts while retaining current usage and unknown fees',async()=>{
 const {readRun,openRunArchive}=await import('../services/agent-runtime/trace-store.mjs');
 const {HandoffGate}=await import('../services/agent-runtime/handoff.mjs');
 const root=join(directory,'runs'),child=readRun(root,lineageChildId)!;
 const report=new HandoffGate({snapshot:child.snapshot,archive:openRunArchive(root,lineageChildId),sandbox:{root:join(root,lineageChildId,'artifacts')}}).prepare('qa','after-backup',{});
 assert.equal(report.commands.length,1);assert.equal(report.commands[0].evidence.runId,lineageSourceId);
 assert.equal(report.commands[0].inheritedFrom.attemptId,'source-attempt');
 assert.equal(Number((await pool.query("SELECT cost FROM usage WHERE id='latest-usage'")).rows[0].cost),0.12);
 const unknown=(await pool.query("SELECT amount,status FROM model_reservations WHERE id='unknown-cost'")).rows[0];
 assert.equal(Number(unknown.amount),0.13);assert.equal(unknown.status,'uncertain');
 const before=await readFile(join(root,lineageChildId,'events.jsonl'));
 for(const mode of ['source-archive','source-object']){
  const plain=await backupModule.decryptBackup(backup,password);
  for(const key of Object.keys(plain.files))if(key.startsWith(`${lineageSourceId}/`)&&(mode==='source-archive'||key.includes('/checkpoint-objects/')))delete plain.files[key];
  const response=await call('restore',{password,backup:await backupModule.encryptBackup(plain,password),confirmation:'RESTORE'});
  assert.equal(response.status,422,mode);assert.match(response.data.message,/检查点/);
  assert.deepEqual(await readFile(join(root,lineageChildId,'events.jsonl')),before);
 }
});

test('active paid manager replies block export and restore before any database replacement', async () => {
  await pool.query("UPDATE manager_messages SET status='replying',started_at=now() WHERE id='waiting-message'");
  const exported = await call('export', { password }); assert.equal(exported.status, 409); assert.match(exported.data.message, /经理回复/);
  const restored = await call('restore', { password, backup, confirmation: 'RESTORE' }); assert.equal(restored.status, 409); assert.match(restored.data.message, /经理回复/);
  assert.equal((await pool.query("SELECT status FROM manager_messages WHERE id='waiting-message'")).rows[0].status, 'replying');
  await pool.query("UPDATE manager_messages SET status='cancelled' WHERE id='waiting-message'");
});

test('legacy backups without extension tables restore with empty defaults rather than stale extension records', async () => {
  const legacy = await backupModule.decryptBackup(backup, password); for (const table of extensionTables) delete legacy.tables[table];
  const result = await call('restore', { password, backup: await backupModule.encryptBackup(legacy, password), confirmation: 'RESTORE' }); assert.equal(result.status, 200, JSON.stringify(result.data));
  for (const table of extensionTables) assert.equal((await pool.query('SELECT * FROM ' + table)).rowCount, 0, `${table} is reset to the old backup's empty state`);
  assert.equal((await pool.query("SELECT id FROM projects WHERE id='project'")).rowCount, 1);
});

test('modern audit history rejects business-only export and restore without changing the ledger, files or audit', async () => {
  const { saveKnowledgeDocument } = await import('../apps/api/src/knowledge.ts');
  const document = await saveKnowledgeDocument({ spaceId: 'space', title: '新审计资料', content: '现代写入必须保留审计，不可降级为旧业务备份。' });
  const vaultPath = (await pool.query('SELECT vault_path FROM knowledge_documents WHERE id=$1', [document.id])).rows[0].vault_path;
  const before = async () => ({
    audits: (await pool.query('SELECT * FROM human_audit_events ORDER BY id')).rows,
    outbox: (await pool.query('SELECT * FROM audit_outbox ORDER BY id')).rows,
    usage: (await pool.query('SELECT * FROM usage ORDER BY id')).rows,
    holds: (await pool.query('SELECT * FROM model_reservations ORDER BY id')).rows,
    documents: (await pool.query('SELECT * FROM knowledge_documents ORDER BY id')).rows,
    revisions: (await pool.query('SELECT * FROM knowledge_revisions ORDER BY document_id,version')).rows,
    artifact: await readFile(join(directory, 'runs', archivedRunId, 'artifacts', 'result.txt')),
    checkpoint: await readFile(join(directory, 'runs', archivedRunId, 'checkpoint-objects', stepCheckpoint.files[0].sha256)),
    vault: await readFile(join(directory, 'vault', vaultPath)),
  });
  const original = await before(); assert.ok(original.audits.length > 0);
  const exported = await call('export', { password });
  assert.equal(exported.status, 409); assert.equal(exported.data.code, 'BACKUP_SOURCE_IDENTITY_UNSUPPORTED');
  assert.deepEqual(await before(), original, 'rejected export cannot mutate persisted state or files');
  const restored = await call('restore', { password, backup, confirmation: 'RESTORE' });
  assert.equal(restored.status, 409); assert.equal(restored.data.code, 'BACKUP_DESTINATION_PROTECTED');
  assert.deepEqual(await before(), original, 'rejected restore cannot mutate persisted state or files');
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('restore-')), []);
});
