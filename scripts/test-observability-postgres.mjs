import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// Only suites whose native fixtures stay inside the owned schema belong here.
const allowedTests = new Set(['tests/audit-outbox.test.ts']);

export function validateObservabilityTestConfig(value, args) {
  let url;
  try { url = new URL(value); } catch { throw Error('OBSERVABILITY_TEST_URL_REJECTED'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/weiwu_observation_test_[a-zA-Z0-9_]+$/.test(url.pathname) || url.search || url.hash) throw Error('OBSERVABILITY_TEST_URL_REJECTED');
  const tests = args.length ? args : ['tests/audit-outbox.test.ts'];
  if (new Set(tests).size !== tests.length || tests.some(path => !allowedTests.has(path))) throw Error('OBSERVABILITY_TEST_FILES_REJECTED');
  return { connectionString: url.href, tests };
}

async function main() {
  // Validate before loading pg or opening any connection; DATABASE_URL is never a fallback.
  const config = validateObservabilityTestConfig(process.env.OBSERVABILITY_TEST_DATABASE_URL, process.argv.slice(2));
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: 3000 });
  let interrupted = false;
  try {
    for (const testPath of config.tests) {
      const schema = `weiwu_observation_${randomUUID().replaceAll('-', '')}`;
      let owned = false;
      try {
        await pool.query(`CREATE SCHEMA "${schema}"`); owned = true;
        const url = new URL(config.connectionString);
        url.searchParams.set('options', `-c search_path=${schema}`);
        const env = { ...process.env, DATABASE_URL: url.href, OBSERVABILITY_TEST_RUNNER: 'postgresql', OBSERVABILITY_TEST_SCHEMA: schema };
        delete env.IDENTITY_TEST_DIRECT_PGLITE; delete env.SIMULATED_INTEGRATION;
        const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', testPath], { cwd: root, stdio: 'inherit', env });
        let timedOut = false, killTimer;
        const stop = () => { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000); };
        const interrupt = () => { interrupted = true; stop(); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, 180000);
        process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
        try {
          const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
          if (timedOut || code !== 0) process.exitCode = timedOut ? 124 : code ?? 1;
        } finally { clearTimeout(timer); clearTimeout(killTimer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
      } finally {
        if (owned) {
          const { rows } = await pool.query('SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname=$1', [schema]);
          if (!/^weiwu_observation_[a-f0-9]{32}$/.test(schema) || rows[0]?.owned !== true) throw Error('OBSERVABILITY_TEST_SCHEMA_NOT_OWNED');
          await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
      }
      if (interrupted) break;
    }
  } finally { await pool.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = ['OBSERVABILITY_TEST_URL_REJECTED', 'OBSERVABILITY_TEST_FILES_REJECTED', 'OBSERVABILITY_TEST_SCHEMA_NOT_OWNED'].includes(error?.message)
      ? error.message : 'OBSERVABILITY_TEST_RUN_FAILED';
    console.error(code); process.exitCode = 1;
  });
}
