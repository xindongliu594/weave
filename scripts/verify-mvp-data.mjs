import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// No user database, Vault, gateway or credentials are opened. Each process uses
// its own persistent PGlite database and product DATA_DIR under a new directory.
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = join(root, 'docs', 'test-evidence');
await mkdir(join(root, '.data'), { recursive: true });
await mkdir(evidenceRoot, { recursive: true });
const directory = await mkdtemp(join(root, '.data', 'mvp-data-'));
const startedAt = new Date().toISOString();
const results = [];
for (const phase of ['source', 'restore', 'reopen']) {
  const side = phase === 'source' ? 'source' : 'target';
  const dataDirectory = join(directory, side);
  await mkdir(dataDirectory, { recursive: true });
  const db = await PGlite.create({ dataDir: join(dataDirectory, 'database'), extensions: { vector } });
  const socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 4 });
  let port;
  socket.addEventListener('listening', event => { port = event.detail.port; });
  await socket.start();
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', './scripts/test-support/pglite-pool.mjs', './scripts/test-support/mvp-data-fixture.ts', phase, directory], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIMULATED_INTEGRATION: 'pglite', DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, DATA_DIR: dataDirectory, TRACE_ROOT: join(dataDirectory, 'runs'), OBSIDIAN_VAULT: join(dataDirectory, 'vault') },
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; process.stdout.write(bytes); });
    child.stderr.on('data', bytes => { output += bytes; process.stderr.write(bytes); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    let code;
    try { code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); }); }
    finally { clearTimeout(timer); }
    await writeFile(join(directory, `${phase}.log`), output);
    if (code !== 0) throw Error(`${phase} verification failed (${code}); evidence: ${directory}`);
    results.push(JSON.parse(await readFile(join(directory, `${phase}.json`), 'utf8')));
  } finally { await socket.stop(); await db.close(); }
}
const evidence = {
  kind: 'isolated-local-data-validation', status: 'passed', startedAt, finishedAt: new Date().toISOString(),
  command: 'node scripts/verify-mvp-data.mjs', directory: resolve(directory),
  originalDataOpened: false, modelHttpCalls: 0, originalCredentialsCopied: false,
  database: 'Two independent persistent PGlite databases, with product API and schema; one connection per process.',
  scope: 'Knowledge authorization, fixed revisions, checkpoint citation references, encrypted backup, nested files and reopen after process restart. Synthetic bookkeeping is not a real model execution result.',
  limitations: ['Independent PostgreSQL backend locking and Docker isolation are not exercised by PGlite.', 'No paid model or Todo acceptance is claimed by this data fixture.'], phases: results,
};
const output = join(evidenceRoot, 'mvp-data-2026-10-02.json');
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(`PASS: ${output}`);
