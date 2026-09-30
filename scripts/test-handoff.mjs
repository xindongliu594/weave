import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
const out = join(root, '.data', 'handoff-fixtures', startedAt.replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
mkdirSync(out, { recursive: true });
const result = spawnSync(process.execPath, ['--test', 'services/agent-runtime/handoff-fixtures.test.mjs'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, HANDOFF_REPORT_DIR: out },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const scenarios = ['happy', 'repair', 'failed-upstream', 'missing-file'].map(name =>
  JSON.parse(readFileSync(join(out, name, 'result.json'), 'utf8')));
const summary = { startedAt, finishedAt: new Date().toISOString(), node: process.version,
  testExitCode: result.status, modelHttpCalls: Math.max(...scenarios.map(s => s.modelHttpCalls)), gaps: scenarios.filter(s => s.observation.startsWith('GAP:')).map(s => s.observation),
  scenarios: scenarios.map(({ scenario, observation, tasks, checks, mocked, real }) => ({ scenario, observation, tasks, checks, mocked, real })),
  excluded: ['Production API/database and approval UI', 'Docker RunSandbox', 'real model/API compatibility or quality', 'automatic discovery of dependencies', 'automatic creation of repair tasks', 'production artifact/version scheduling gates'] };
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`\n测试断言通过；已知产品缺口 ${summary.gaps.length} 项。结果、固定产物和运行追溯：${out}`);
for (const gap of summary.gaps) console.log(gap);
