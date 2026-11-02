import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

export const productFlowTestPaths = ['tests/product-flow.test.ts', 'tests/product-flow-core.test.ts', 'tests/product-flow-rework.test.ts', 'tests/product-flow-escalation.test.ts', 'tests/product-flow-recovery.test.ts', 'tests/product-flow-recovery-rework.test.ts'];
const defaultTests = ['tests/api.test.ts', 'tests/plan-readiness.test.ts', 'tests/capabilities.test.ts', ...productFlowTestPaths, 'tests/work-files.test.ts', 'tests/work-file-project.test.ts', 'tests/browser-mcp.test.ts', 'tests/automation-learning.test.ts', 'tests/manager-chat.test.ts', 'tests/organization-chat.test.ts', 'tests/organization-update.test.ts', 'tests/extensions-backup.test.ts'];
const pathKey = path => {
  const absolute = resolve(root, path.replaceAll('\\', '/'));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

export function integrationTestPaths(paths = []) {
  const selected = paths.length ? paths.flatMap(path => pathKey(path) === pathKey(productFlowTestPaths[0]) ? productFlowTestPaths : [path]) : defaultTests;
  const seen = new Set();
  return selected.filter(path => {
    const key = pathKey(path);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function integrationExitCode(previous, code, timedOut = false) {
  if (timedOut || previous === 124) return 124;
  return previous || (code === 0 ? 0 : code ?? 1);
}

export function integrationTestConfig(testPath, options = []) {
  const actualPath = resolve(root, testPath.replaceAll('\\', '/'));
  const identityPath = resolve(root, 'tests/identity-store.test.ts');
  const directIdentity = process.platform === 'win32'
    ? actualPath.toLowerCase() === identityPath.toLowerCase() : actualPath === identityPath;
  return {
    directIdentity,
    args: ['--import', 'tsx', ...(directIdentity ? [] : ['--import', './scripts/test-support/pglite-pool.mjs']),
      '--test', '--test-concurrency=1', ...options, testPath],
    env: { SIMULATED_INTEGRATION: 'pglite', IDENTITY_TEST_DIRECT_PGLITE: directIdentity ? '1' : '0' },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options=args.filter(value=>value.startsWith('--test-name-pattern=')||value.startsWith('--test-skip-pattern='));
  const paths=args.filter(value=>!options.includes(value));
  const tests = integrationTestPaths(paths);
  console.log('Simulated integration: PGlite + pgvector, a fresh database for each test file and one product DB connection.');
  console.log('Models are test doubles; native device scenarios use real temporary workspaces. Docker and independent backend locks are excluded.');
  // PGlite's socket layer has a single backend; connection startup search_path
  // options do not provide PostgreSQL's per-session isolation. A separate in-memory
  // database per file prevents leftover public-schema rows from leaking across files.
  let interrupted = false;
  for (const testPath of tests) {
    const config = integrationTestConfig(testPath, options);
    // Trigger failures desynchronize the socket protocol; identity-store already owns a direct SQL adapter.
    if (config.directIdentity) console.log('Identity store: direct PGlite SQL adapter; independent backend locks remain excluded.');
    const db = config.directIdentity ? null : await PGlite.create({ extensions: { vector } });
    const socket = db ? new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 8 }) : null;
    let port;
    socket?.addEventListener('listening', event => { port = event.detail.port; });
    await socket?.start();
    try {
      const child = spawn(process.execPath, config.args, {
        cwd: root, stdio: 'inherit', env: { ...process.env, ...config.env, DATABASE_URL: config.directIdentity ? '' : `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` },
      });
      let timedOut = false;
      const fileTimeout = 180000;
      const timer = setTimeout(() => { timedOut = true; console.error(`Integration file ${testPath} exceeded ${fileTimeout / 1000} seconds`); child.kill('SIGTERM'); }, fileTimeout);
      let killTimer;
      const stop = () => { interrupted = true; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        process.exitCode = integrationExitCode(process.exitCode, code, timedOut);
      } finally {
        clearTimeout(timer); clearTimeout(killTimer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
      }
    } finally { await socket?.stop(); await db?.close(); }
    if (interrupted) break;
  }
}
