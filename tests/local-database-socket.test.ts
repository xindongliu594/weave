import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scenario = `
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDatabaseSocket } from './scripts/local-database-socket.mjs';
const directory = await mkdtemp(join(tmpdir(), 'weiwu-socket-drain-'));
const db = await PGlite.create({ dataDir: directory });
const socket = createLocalDatabaseSocket({ db, host: '127.0.0.1', port: 0 });
let port;
socket.addEventListener('listening', event => { port = event.detail.port; });
await socket.start();
const client = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:' + port + '/postgres' });
await client.connect();
await client.query('CREATE TABLE retained(value integer)');
await client.query('INSERT INTO retained VALUES(1)');
await client.query('BEGIN');
await client.query('INSERT INTO retained VALUES(2)');
let releaseRollback, rollbackStarted;
const rollbackGate = new Promise(resolve => { releaseRollback = resolve; });
const started = new Promise(resolve => { rollbackStarted = resolve; });
const exec = db.exec.bind(db);
db.exec = async (...args) => {
  if (args[0] === 'ROLLBACK') {
    rollbackStarted(); await rollbackGate;
    if (process.env.FAIL_CLEANUP === 'yes') throw Error('fixture rollback failure');
  }
  return exec(...args);
};
await client.end();
await started;
let stopped = false;
const stopping = socket.stop().then(() => { stopped = true; });
const failure = stopping.catch(error => error);
// The real close handler has removed itself from the server's handler set,
// but its real transaction cleanup is deliberately still in progress.
await new Promise(resolve => setImmediate(resolve));
assert.equal(stopped, false, 'stop must await cleanup of an already disconnected handler');
releaseRollback();
if (process.env.FAIL_CLEANUP === 'yes') {
  const error = await failure;
  assert.ok(error instanceof AggregateError);
  assert.match(error.errors[0].message, /fixture rollback failure/);
  assert.equal(db.isInTransaction(), true, 'cleanup failure leaves database open and transaction visible');
  await exec('ROLLBACK');
} else await stopping;
assert.equal(db.isInTransaction(), false, 'socket stop must finish transaction cleanup');
assert.deepEqual((await db.query('SELECT value FROM retained ORDER BY value')).rows, [{ value: 1 }]);
await db.close();
// Observe the next upstream deferred close callback, rather than delaying shutdown.
await new Promise(resolve => setImmediate(resolve));
const reopened = await PGlite.create({ dataDir: directory });
assert.deepEqual((await reopened.query('SELECT value FROM retained ORDER BY value')).rows, [{ value: 1 }]);
await reopened.close();
await rm(directory, { recursive: true });
console.log('clean shutdown');
`;

async function verify(failCleanup = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', scenario], { cwd: root, env: { ...process.env, FAIL_CLEANUP: failCleanup ? 'yes' : 'no' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 25000);
  try {
    const exit = await exited;
    assert.equal(timedOut, false, 'isolated socket regression child timed out: ' + output);
    assert.deepEqual(exit, { code: 0, signal: null }, output);
    assert.match(output, /clean shutdown/);
  } finally {
    clearTimeout(timeout);
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

test('real pg disconnect drains its transaction and preserves committed data after disk reopen', { timeout: 30000 }, async () => {
  await verify();
});

test('real socket cleanup failure is surfaced while the database remains open', { timeout: 30000 }, async () => {
  await verify(true);
});
