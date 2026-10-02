import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const args = process.argv.slice(2), check = args.includes('--check');
if (args.includes('--help')) { console.log('npm run demo [-- --web-port=4320]\nnpm run demo:check\n本地固定模型 + 独立数据库 + 实际 Todo 接口测试；不需要 Docker 或 API Key。'); process.exit(0); }
if (args.some(value => value !== '--check' && !/^--web-port=\d+$/.test(value))) throw Error('未知参数；请使用 --help');
const port = Number(args.find(value => value.startsWith('--web-port='))?.split('=')[1] ?? 4320);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('演示网页端口必须在 1024–65535 之间');
if (!existsSync(join(root, 'services/agent-runtime/node_modules/@deepseek-ai/dsh'))) throw Error('先运行 npm --prefix services/agent-runtime ci 安装员工运行时');
const sessionRoot = join(root, '.data', 'demo', randomUUID());
mkdirSync(sessionRoot, { recursive: true });
let db, socket, child, web, childExit, shutdown, resolveStopped, stopping = false;
const stopped = new Promise(resolve => { resolveStopped = resolve; });
function requestStop() { stopping=true;resolveStopped();if(child?.connected)child.send('stop'); }
function ensureActive() { if(stopping)throw Error('演示启动已取消'); }
function stop() {
  return shutdown??=(async()=>{stopping = true;
  await web?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send('stop'); else child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
    await childExit; clearTimeout(kill);
  }
  await socket?.stop(); await db?.close(); resolveStopped();})();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, requestStop);
try {
  console.log('正在启动为伍独立 Todo 演示环境…');
  db = await PGlite.create({ dataDir: join(sessionRoot, 'database'), extensions: { vector } });
  ensureActive();
  socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 8 });
  let dbPort; socket.addEventListener('listening', event => { dbPort = event.detail.port; }); await socket.start();ensureActive();
  const env = { ...process.env, AGENT_DEPARTMENT_DEMO: 'isolated', DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`, DATA_DIR: join(sessionRoot, 'credentials'), TRACE_ROOT: join(sessionRoot, 'runs'), ALLOWED_ORIGINS: '' };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  child = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo/api.ts'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  childExit = new Promise(resolve => { child.once('exit', code => { resolve(code); if (!stopping) { process.exitCode = code || 1; requestStop(); } }); child.once('error', error => { console.error(error.message); resolve(1); }); });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('演示启动超过 60 秒')), 60000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); reject(Error('演示 API 已退出：' + code)); });
    child.on('message', value => { if (value.type === 'ready') { clearTimeout(timeout); resolve(value); } else if (value.type === 'error') { clearTimeout(timeout); reject(Error(value.message)); } });
  });
  ensureActive();
  const url = `http://127.0.0.1:${ready.apiPort}/api`;
  writeFileSync(join(sessionRoot, 'session.json'), JSON.stringify({ pid:process.pid,apiPid:child.pid,projectId: ready.projectId, apiPort: ready.apiPort, webPort: check ? null : port, fixtureModel: true }, null, 2) + '\n');
  if (check) {
    await verify(url, ready, sessionRoot);
    console.log('Todo 演示验收通过：开发自检 2 项、独立接口验收 6 项，实际员工交接、两次审批、6 个交付物、费用为 0。');
  } else {
    const { createServer } = await import('vite');
    web = await createServer({ configFile: join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': `http://127.0.0.1:${ready.apiPort}` } } });
    ensureActive();
    await web.listen();
    console.log(`\n为伍演示已就绪：http://127.0.0.1:${port}\n一个想法，一支团队。\n在首页打开 Todo 示例方案，点击“批准并运行”。在执行页逐次批准两条测试命令。\n演示档案：${sessionRoot}\n每次启动创建独立演示空间；Ctrl+C 停止，文件保留。`);
    await stopped;
  }
} catch (error) { if(!stopping){console.error('演示启动或验收失败：' + error.message); process.exitCode = 1;} }
finally { await stop(); }

async function verify(url, ready, directory) {
  const call = async (path, method = 'GET', body, expected = 200) => {
    const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const value = await response.json(); assert.equal(response.status, expected, path + ': ' + JSON.stringify(value)); return value;
  };
  const { DemoSandbox } = await import('./demo/support.mjs');
  const guard = new DemoSandbox({ dir: join(directory, 'guard-check') }); await guard.prepare();
  await assert.rejects(guard.execute('artifact_write', { path: '../outside.mjs', content: 'outside' }), /固定 Todo/);
  await assert.rejects(guard.execute('artifact_write', { path: 'todo.mjs', content: 'changed code' }), /固定 Todo/);
  await assert.rejects(guard.execute('terminal', { command: 'arbitrary-command' }), /预置 Node/); await guard.close();
  assert.equal((await call('/health')).demo.projectId, ready.projectId);
  const external = { name: 'External', baseUrl: 'https://example.invalid/v1', apiKey: 'not-used' };
  for (const path of ['/gateways', '/GATEWAYS/']) await call(path, 'POST', external, 422);
  const gateway = (await call('/gateways'))[0];
  for (const path of ['/gateways/' + gateway.id, '/GATEWAYS/' + gateway.id + '/']) await call(path, 'PUT', { ...external, version: gateway.version }, 422);
  for (const path of ['/backup/restore', '/BACKUP/RESTORE/']) await call(path, 'POST', {}, 422);
  const { id } = await call('/projects/' + ready.projectId + '/approve', 'POST', { version: ready.version }, 202);
  const deadline = Date.now() + 90000; let detail, approved = 0;
  while (Date.now() < deadline) {
    detail = await call('/runs/' + id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(detail.status)) break;
    for (const approval of (await call('/approvals?runId=' + id)).filter(item => item.status === 'pending')) {
      assert.ok(['node --test smoke.test.mjs', 'node --test acceptance.test.mjs'].includes(approval.arguments.command));
      await call('/approvals/' + approval.id, 'POST', { decision: 'approved' }); approved++;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const events = [...detail.events];
  while (detail.hasMore) { detail = await call('/runs/' + id + '?after=' + detail.nextCursor); events.push(...detail.events); }
  assert.equal(detail.status, 'completed', JSON.stringify(events.findLast(item => item.type === 'run/finished')?.data)); assert.equal(approved, 2);
  assert.ok(events.some(item => item.type === 'quality/reviewed' && item.data.verdict === 'pass'));
  assert.equal(events.filter(item => item.type === 'handoff/accepted').length, 2);
  assert.ok(events.some(item => item.type === 'runtime/created' && item.data.employeeId === 'developer'));
  assert.ok(events.some(item => item.type === 'runtime/created' && item.data.employeeId === 'tester'));
  const files = await call('/runs/' + id + '/artifacts');
  assert.deepEqual(files.map(item => item.path).sort(), ['README.md', 'acceptance.test.mjs', 'review.json', 'smoke.test.mjs', 'test-report.json', 'todo.mjs'].sort());
  const artifact = await fetch(url + '/runs/' + id + '/artifact?path=test-report.json'); assert.equal(artifact.status, 200);
  const report = await artifact.json(); assert.equal(report.passed, true); assert.equal(report.tests, 6); assert.equal(report.exitCode, 0);
  assert.ok((await call('/usage')).every(item => item.cost === 0));
  writeFileSync(join(directory, 'verification.json'), JSON.stringify({ runId: id, status: detail.status, approved, report, artifacts: files, fixtureModel: true }, null, 2) + '\n');
}
