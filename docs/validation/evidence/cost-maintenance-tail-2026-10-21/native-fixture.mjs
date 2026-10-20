import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import * as binaries from '@embedded-postgres/windows-x64';

const exec = promisify(execFile);
const root = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const pointer = path.join(root, 'active-fixture.private.json');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG') && key !== 'DATABASE_URL'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const binaryPaths = Object.fromEntries(['postgres', 'pg_ctl', 'initdb'].map(name => {
  const target = fs.realpathSync(binaries[name]);
  if (!target.startsWith(root + path.sep)) throw Error('Binary escapes private runtime');
  return [name, target];
}));
const provision = JSON.parse(fs.readFileSync(path.join(root, 'provision.json'), 'utf8'));
for (const [name, target] of Object.entries(binaryPaths))
  if (hash(fs.readFileSync(target)) !== provision.binaries[name].sha256) throw Error('Provisioned binary changed');

async function command(name, args, log) {
  try {
    const result = await exec(binaryPaths[name], args, {env, windowsHide: true, timeout: 50000, maxBuffer: 4 * 1024 * 1024});
    fs.writeFileSync(log, result.stdout + result.stderr + '\nEXIT=0\n');
    return 0;
  } catch (error) {
    fs.writeFileSync(log, String(error.stdout ?? '') + String(error.stderr ?? '') + '\nEXIT=' + String(error.code ?? 'unknown') + '\n');
    throw Error(name + ' failed; inspect private log');
  }
}

function owned(config) {
  if (config.kind !== 'weiwu-cost-tail-private-fixture-v1' || !/^[a-f0-9]{32}$/.test(config.id)) throw Error('Fixture identity rejected');
  const expected = path.join(root, 'clusters', config.id);
  if (config.fixtureRoot !== expected || fs.realpathSync(expected) !== expected || fs.lstatSync(expected).isSymbolicLink()) throw Error('Fixture path rejected');
  if (config.dataDir !== path.join(expected, 'data') || fs.realpathSync(config.dataDir) !== config.dataDir || fs.lstatSync(config.dataDir).isSymbolicLink()) throw Error('Data path rejected');
  return config;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function start() {
  if (fs.existsSync(pointer)) throw Error('Existing private fixture pointer; inspect it before any new start');
  const id = crypto.randomUUID().replaceAll('-', '');
  const fixtureRoot = path.join(root, 'clusters', id);
  fs.mkdirSync(fixtureRoot, {recursive: true});
  if (fs.realpathSync(fixtureRoot) !== fixtureRoot) throw Error('Fixture root aliases another path');
  const dataDir = path.join(fixtureRoot, 'data');
  const pwfile = path.join(fixtureRoot, 'init-password.private');
  const adminPassword = crypto.randomBytes(32).toString('hex');
  const password = crypto.randomBytes(32).toString('hex');
  const port = await freePort();
  const config = {kind: 'weiwu-cost-tail-private-fixture-v1', id, fixtureRoot, dataDir, host: '127.0.0.1', port,
    user: 'weiwu_cost_tail_test', database: 'weiwu_cost_tail_test_' + id, password, state: 'initializing'};
  fs.writeFileSync(pointer, JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  fs.writeFileSync(pwfile, adminPassword + '\n', {flag: 'wx', mode: 0o600});
  try {
    await command('initdb', ['-D', dataDir, '-U', 'weiwu_fixture_admin', '--pwfile', pwfile,
      '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C'],
    path.join(fixtureRoot, 'initdb.txt'));
  } finally {
    fs.unlinkSync(pwfile);
  }
  owned(config);
  await command('pg_ctl', ['-D', dataDir, '-l', path.join(fixtureRoot, 'server.log'), '-w', '-t', '30',
    '-o', `-h 127.0.0.1 -p ${port} -c shared_buffers=16MB -c max_connections=20 -c log_statement=none`,
    'start'], path.join(fixtureRoot, 'start.txt'));
  config.state = 'started';
  fs.writeFileSync(pointer, JSON.stringify(config, null, 2) + '\n');
  const admin = new pg.Client({host: config.host, port, user: 'weiwu_fixture_admin', password: adminPassword,
    database: 'postgres', connectionTimeoutMillis: 5000, statement_timeout: 10000});
  try {
    await admin.connect();
    await admin.query(`CREATE ROLE ${config.user} LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE ${config.database} OWNER ${config.user}`);
    const result = (await admin.query("SELECT current_setting('server_version') AS version, current_setting('data_directory') AS data_dir, current_setting('listen_addresses') AS listen_addresses, pg_postmaster_start_time() AS started_at")).rows[0];
    if (fs.realpathSync(result.data_dir) !== dataDir || result.listen_addresses !== '127.0.0.1') throw Error('Server identity mismatch');
    config.state = 'ready';
    fs.writeFileSync(pointer, JSON.stringify(config, null, 2) + '\n');
    const evidence = {id, host: config.host, port, database: config.database, role: config.user, dataDir,
      ...result, fixtureKind: config.kind, installScriptsExecuted: false, systemService: false, productionAccess: false};
    fs.writeFileSync(path.join(fixtureRoot, 'ready.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({state: 'ready', id, version: result.version, host: config.host, port, database: config.database, privateConfig: pointer}));
  } finally {
    await admin.end();
  }
}

async function stop() {
  const config = owned(JSON.parse(fs.readFileSync(pointer, 'utf8')));
  if (config.state === 'stopped') throw Error('Already stopped; do not repeat lifecycle action');
  await command('pg_ctl', ['-D', config.dataDir, '-w', '-t', '30', '-m', 'fast', 'stop'], path.join(config.fixtureRoot, 'stop.txt'));
  if (fs.existsSync(path.join(config.dataDir, 'postmaster.pid'))) throw Error('Postmaster pid still exists after stop');
  config.state = 'stopped';
  fs.writeFileSync(pointer, JSON.stringify(config, null, 2) + '\n');
  console.log(JSON.stringify({state: 'stopped', id: config.id, dataRetained: true}));
}

try {
  if (process.argv[2] === 'start') await start();
  else if (process.argv[2] === 'stop') await stop();
  else throw Error('Use start or stop only');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
