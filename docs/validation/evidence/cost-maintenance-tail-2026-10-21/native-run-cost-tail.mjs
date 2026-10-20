import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(runtimeRoot, '../../../../');
const configPath = path.join(runtimeRoot, 'active-fixture.private.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (config.kind !== 'weiwu-cost-tail-private-fixture-v1' || config.state !== 'ready'
  || !/^[a-f0-9]{32}$/.test(config.id) || config.host !== '127.0.0.1'
  || config.user !== 'weiwu_cost_tail_test' || config.database !== 'weiwu_cost_tail_test_' + config.id
  || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
  || !/^[a-f0-9]{64}$/.test(config.password)
  || config.fixtureRoot !== path.join(runtimeRoot, 'clusters', config.id)
  || config.dataDir !== path.join(config.fixtureRoot, 'data')
  || fs.realpathSync(config.dataDir) !== config.dataDir) throw Error('Owned native fixture rejected');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--test-name-pattern' || !args[1] || args[1].length > 500))
  throw Error('Only optional --test-name-pattern is accepted');
const allowedEnv = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'LANG', 'LC_ALL']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnv.has(key.toUpperCase())));
env.COST_TAIL_NATIVE = '1';
env.COST_TAIL_FIXTURE_CONFIG = configPath;
const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  ...(args.length ? ['--test-name-pattern=' + args[1]] : []), 'tests/cost-maintenance-native.test.ts'],
{cwd: workspace, env, stdio: 'inherit', windowsHide: true});
let timedOut = false;
const timer = setTimeout(() => {timedOut = true; child.kill('SIGTERM');}, 150000);
try {
  const {code, signal} = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  process.exitCode = timedOut ? 124 : code ?? 1;
  console.log(JSON.stringify({nativeTestExit: code, signal, timedOut, fixtureId: config.id,
    test: 'tests/cost-maintenance-native.test.ts', modelCalls: 0, productionAccess: false}));
} finally {
  clearTimeout(timer);
}
