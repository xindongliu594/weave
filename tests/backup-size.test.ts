import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// This file always creates its own database and workspace directory. It never
// opens the user database, copies a credential or sends a model request.
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = randomUUID(), password = 'local-size-fixture-password';
const MiB = 1024 * 1024;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
let directory: string, dataDirectory: string, traceRoot: string, artifact: string, url: string;
let db: PGlite, socket: PGLiteSocketServer, pool: pg.Pool, server: http.Server;
let backupModule: typeof import('../apps/api/src/backup.ts'), backup: any, plain: any;
let artifactHash: string, roundtripBytes: number;
const results: Record<string, unknown>[] = [];
const startedAt = new Date().toISOString();

async function call(action: 'export' | 'restore', body: unknown) {
  const response = await fetch(url + '/backup/' + action, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000),
  });
  return { status: response.status, data: await response.json() as any };
}

before(async () => {
  const dataRoot = join(root, '.data'); await mkdir(dataRoot, { recursive: true });
  directory = await mkdtemp(join(dataRoot, 'mvp-backup-size-'));
  const targetRelative = relative(resolve(dataRoot), resolve(directory));
  assert.ok(targetRelative && !targetRelative.startsWith('..') && !isAbsolute(targetRelative));
  dataDirectory = join(directory, 'credentials'); traceRoot = join(directory, 'runs');
  process.env.DATA_DIR = dataDirectory; process.env.TRACE_ROOT = traceRoot;
  process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  db = await PGlite.create({ dataDir: join(directory, 'database'), extensions: { vector } });
  socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 4 });
  let port: number | undefined;
  socket.addEventListener('listening', event => { port = (event as any).detail.port; });
  await socket.start(); assert.ok(port);
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const database = await import('../apps/api/src/db.ts'); pool = database.pool;
  (pool as any).options.max = 1; await database.migrate();
  backupModule = await import('../apps/api/src/backup.ts');
  const agent = { id: 'size-manager', name: '本地资料检查员', role: 'manager', modelId: 'size-model', instructions: '只检查本地 fixture，不运行模型。', tools: [] };
  const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, deadlineSeconds: 300, allowedModelIds: ['size-model'], allowedTools: [], allowedKnowledgeSpaceIds: [], allowedDepartmentIds: ['size-department'] };
  const plan = { agents: [agent], tasks: [] };
  await pool.query("INSERT INTO gateways(id,data) VALUES('size-gateway',$1)", [{ name: 'Never called size fixture', baseUrl: 'http://127.0.0.1:1/v1' }]);
  await pool.query("INSERT INTO models(id,data,status) VALUES('size-model',$1,'available')", [{ name: 'Never called size fixture', gatewayId: 'size-gateway', model: 'not-called', inputRate: 1, outputRate: 1 }]);
  await pool.query("INSERT INTO departments(id,data) VALUES('size-department',$1)", [{ name: 'Backup size fixture', agents: [agent] }]);
  await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,status,source) VALUES('size-project','size-department',1,'Backup size fixture','Synthetic backup size fixture, not employee delivery',$1,$2,'COMPLETED','manual')", [policy, plan]);
  await pool.query("INSERT INTO plan_versions(project_id,version,plan,policy) VALUES('size-project',1,$1,$2)", [plan, policy]);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,'size-project',1,'completed',$2)", [runId, { projectId: 'size-project', projectVersion: 1, agents: [agent], policy }]);
  await pool.query("INSERT INTO usage(id,model_id,project_id,run_id,input_tokens,output_tokens,cost,purpose) VALUES('size-usage','size-model','size-project',$1,10,5,.003,'synthetic-data-fixture')", [runId]);
  artifact = join(traceRoot, runId, 'artifacts', 'synthetic-size-fixture.txt');
  await mkdir(join(traceRoot, runId, 'artifacts'), { recursive: true });
  const bytes = Buffer.alloc(31 * MiB, 'fixture-only-size-data\n'); artifactHash = hash(bytes);
  await writeFile(artifact, bytes);
  const app = express(); app.use(express.json({ limit: '70mb' }));
  app.use(backupModule.backupRouter(traceRoot));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ message: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (directory) await writeFile(join(directory, 'validation.json'), JSON.stringify({
    kind: 'isolated-backup-size-regression', status: results.length === 2 ? 'passed' : 'failed', startedAt, finishedAt: new Date().toISOString(),
    directory, sourceUserDatabaseOpened: false, sourceCredentialsCopied: false, modelHttpCalls: 0,
    limitBytes: backupModule?.ONLINE_BACKUP_LIMIT_BYTES, results,
    limitations: ['Synthetic local data; no real employee Todo acceptance.', 'PGlite single product connection; independent backend locks are not tested.'],
  }, null, 2) + '\n');
  if (server) { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); }
  await pool?.end(); await socket?.stop(); await db?.close();
});

test('31MiB archives below the total plaintext limit survive real encrypted export/restore/export', async () => {
  assert.equal(backupModule.ONLINE_BACKUP_LIMIT_BYTES, 50 * MiB);
  const exported = await call('export', { password }); assert.equal(exported.status, 200, exported.data.message);
  backup = exported.data; plain = await backupModule.decryptBackup(backup, password);
  roundtripBytes = Buffer.byteLength(JSON.stringify(plain));
  assert.ok(roundtripBytes > 30 * MiB && roundtripBytes < backupModule.ONLINE_BACKUP_LIMIT_BYTES);
  assert.equal(plain.master, null); assert.equal(plain.tables.usage.length, 1);
  assert.equal(hash(Buffer.from(plain.files[`${runId}/artifacts/synthetic-size-fixture.txt`], 'base64')), artifactHash);
  await pool.query("UPDATE projects SET requirement='Changed local target before restore' WHERE id='size-project'");
  await writeFile(artifact, 'Changed local target archive before restore.\n');
  const restored = await call('restore', { password, backup, confirmation: 'RESTORE' });
  assert.equal(restored.status, 200, restored.data.message);
  assert.equal((await pool.query("SELECT requirement FROM projects WHERE id='size-project'")).rows[0].requirement, 'Synthetic backup size fixture, not employee delivery');
  assert.equal(Number((await pool.query("SELECT cost FROM usage WHERE id='size-usage'")).rows[0].cost), .003);
  assert.equal(hash(await readFile(artifact)), artifactHash);
  const oldArchive = (await readdir(dataDirectory)).find(name => name.startsWith('before-restore-'));
  assert.ok(oldArchive);
  assert.equal(await readFile(join(dataDirectory, oldArchive, runId, 'artifacts', 'synthetic-size-fixture.txt'), 'utf8'), 'Changed local target archive before restore.\n');
  const exportedAgain = await call('export', { password }); assert.equal(exportedAgain.status, 200, exportedAgain.data.message);
  const roundtrip = await backupModule.decryptBackup(exportedAgain.data, password);
  assert.equal(hash(Buffer.from(roundtrip.files[`${runId}/artifacts/synthetic-size-fixture.txt`], 'base64')), artifactHash);
  assert.equal(roundtrip.tables.usage[0].id, 'size-usage');
  results.push({ name: '31MiB export/restore/export', status: 'passed', archiveBytes: 31 * MiB, plaintextBytes: roundtripBytes, artifactHash, priorArchiveRetained: true, usageRows: 1 });
});

test('plaintext above 50MiB is rejected before replacing target data or files', async () => {
  assert.ok(plain);
  const padding = Buffer.alloc(7 * MiB, 'synthetic oversize fixture only\n');
  const oversized = { ...plain, files: { ...plain.files, [`${runId}/artifacts/padding.txt`]: padding.toString('base64') } };
  const plaintextBytes = Buffer.byteLength(JSON.stringify(oversized)); assert.ok(plaintextBytes > backupModule.ONLINE_BACKUP_LIMIT_BYTES);
  const beforeRows = (await pool.query('SELECT * FROM projects')).rows, beforeUsage = (await pool.query('SELECT * FROM usage')).rows;
  const beforeStageDirectories = (await readdir(dataDirectory)).sort();
  const result = await call('restore', { password, backup: await backupModule.encryptBackup(oversized, password), confirmation: 'RESTORE' });
  assert.equal(result.status, 422);
  assert.deepEqual((await pool.query('SELECT * FROM projects')).rows, beforeRows);
  assert.deepEqual((await pool.query('SELECT * FROM usage')).rows, beforeUsage);
  assert.equal(hash(await readFile(artifact)), artifactHash);
  assert.deepEqual((await readdir(dataDirectory)).sort(), beforeStageDirectories, 'Oversized restore must stop before staging or replacement');
  await writeFile(join(traceRoot, runId, 'artifacts', 'padding.txt'), padding);
  const exported = await call('export', { password }); assert.equal(exported.status, 422); assert.match(exported.data.message, /50MiB/);
  assert.deepEqual((await pool.query('SELECT * FROM projects')).rows, beforeRows);
  assert.deepEqual((await pool.query('SELECT * FROM usage')).rows, beforeUsage);
  assert.equal(hash(await readFile(artifact)), artifactHash);
  results.push({ name: 'Oversize export and restore rejection', status: 'passed', archiveBytes: 38 * MiB, plaintextBytes, targetDataPreserved: true, targetArchivePreserved: true, noRestoreStagingCreated: true });
});
