import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = readdirSync(new URL('../services/agent-runtime/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs') && name !== 'sandbox.test.mjs')
  .sort().map(name => `services/agent-runtime/${name}`);
const child = spawn(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
const stop = () => child.kill('SIGTERM');
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
}
