import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options=args.filter(value=>value.startsWith('--test-name-pattern=')||value.startsWith('--test-skip-pattern='));
const paths=args.filter(value=>!options.includes(value));
const tests = paths.length ? paths : ['tests/api.test.ts', 'tests/plan-readiness.test.ts', 'tests/capabilities.test.ts', 'tests/product-flow.test.ts', 'tests/work-files.test.ts', 'tests/work-file-project.test.ts', 'tests/browser-mcp.test.ts', 'tests/automation-learning.test.ts', 'tests/manager-chat.test.ts', 'tests/organization-chat.test.ts', 'tests/organization-update.test.ts', 'tests/extensions-backup.test.ts'];
console.log('Simulated integration: PGlite + pgvector, a fresh database for each test file and one product DB connection.');
console.log('Models are test doubles; native device scenarios use real temporary workspaces. Docker and independent backend locks are excluded.');
// PGlite's socket layer has a single backend; connection startup search_path
// options do not provide PostgreSQL's per-session isolation. A separate in-memory
// database per file prevents leftover public-schema rows from leaking across files.
let interrupted = false;
for (const testPath of tests) {
  const db = await PGlite.create({ extensions: { vector } });
  const socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 8 });
  let port;
  socket.addEventListener('listening', event => { port = event.detail.port; });
  await socket.start();
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', './scripts/test-support/pglite-pool.mjs', '--test', '--test-concurrency=1', ...options, testPath], {
      cwd: root, stdio: 'inherit', env: { ...process.env, SIMULATED_INTEGRATION: 'pglite', DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` },
    });
    let timedOut = false;
    // Product flow includes real native commands, service recreation and two
    // checkpoint resumes. Keep its per-test deadlines and allow the longer file.
    const fileTimeout = testPath.replaceAll('\\','/').endsWith('product-flow.test.ts') ? 300000 : 180000;
    const timer = setTimeout(() => { timedOut = true; console.error(`Integration file ${testPath} exceeded ${fileTimeout / 1000} seconds`); child.kill('SIGTERM'); }, fileTimeout);
    let killTimer;
    const stop = () => { interrupted = true; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      if (timedOut || code !== 0) process.exitCode = timedOut ? 124 : code ?? 1;
    } finally {
      clearTimeout(timer); clearTimeout(killTimer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    }
  } finally { await socket.stop(); await db.close(); }
  if (interrupted) break;
}
