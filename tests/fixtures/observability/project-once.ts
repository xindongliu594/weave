import { validateObservabilityTestConfig } from '../../../scripts/test-observability-postgres.mjs';
import { projectAuditOutbox } from '../../../apps/api/src/audit-outbox.ts';

async function main() {
  const config = validateObservabilityTestConfig(process.env.OBSERVABILITY_TEST_DATABASE_URL, ['tests/audit-outbox.test.ts']);
  const schema = process.env.OBSERVABILITY_TEST_SCHEMA;
  if (process.env.OBSERVABILITY_TEST_RUNNER !== 'postgresql' || !/^weiwu_observation_[a-f0-9]{32}$/.test(schema ?? '')) throw Error('OBSERVABILITY_TEST_SCHEMA_NOT_OWNED');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: config.connectionString, options: `-c search_path=${schema}`, max: 1, connectionTimeoutMillis: 3000 });
  try {
    const { rows } = await pool.query('SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname=$1', [schema]);
    if (rows[0]?.owned !== true) throw Error('OBSERVABILITY_TEST_SCHEMA_NOT_OWNED');
    console.log(JSON.stringify(await projectAuditOutbox(pool, { limit: 100, now: new Date(Date.now() + 60000) })));
  } finally { await pool.end(); }
}

main().catch(error => {
  console.error(['OBSERVABILITY_TEST_URL_REJECTED', 'OBSERVABILITY_TEST_SCHEMA_NOT_OWNED'].includes(error?.message) ? error.message : 'OBSERVABILITY_TEST_WORKER_FAILED');
  process.exitCode = 1;
});
