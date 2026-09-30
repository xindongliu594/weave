import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const tests = args.length ? args : ['tests/api.test.ts', 'tests/capabilities.test.ts', 'tests/product-flow.test.ts'];
console.log('Simulated integration: PGlite + pgvector, one product DB connection.');
console.log('Model and file executor are test doubles; Docker and independent backend locks are excluded.');
const db = await PGlite.create({ extensions: { vector } });
const socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 8 });
let port;
socket.addEventListener('listening', event => { port = event.detail.port; });
await socket.start();
try {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './scripts/test-support/pglite-pool.mjs', '--test', '--test-concurrency=1', ...tests], {
    cwd: root, stdio: 'inherit', env: { ...process.env, SIMULATED_INTEGRATION: 'pglite', DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; console.error('Integration suite exceeded 180 seconds'); child.kill('SIGTERM'); }, 180000);
  let killTimer;
  const stop = () => { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    process.exitCode = timedOut ? 124 : code ?? 1;
  } finally {
    clearTimeout(timer); clearTimeout(killTimer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
} finally { await socket.stop(); await db.close(); }
