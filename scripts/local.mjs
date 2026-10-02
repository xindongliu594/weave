import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url)); process.chdir(root);
const args = process.argv.slice(2), check = args.includes('--check');
if (args.includes('--help')) { console.log('为伍 · 一个想法，一支团队\n\nnpm run local -- [--web-port=4310] [--data-dir="绝对路径"]\nnpm run local:check\nnpm run local -- --enable-device：明确重新授予本机执行权限\n--data-dir 沿用指定本机数据目录、配置和已有目录授权，须先停止使用该目录的服务；检查模式不接受此参数。\n本机持久数据库与实际文件/命令执行；在模型目录配置自己的 API。'); process.exit(0); }
if (args.some(value => value !== '--check' && value !== '--enable-device' && !/^--web-port=\d+$/.test(value) && !value.startsWith('--data-dir='))) throw Error('未知参数；请使用 --help');
if(check&&args.includes('--enable-device'))throw Error('检查模式不接受 --enable-device');
const dataDirs = args.filter(value => value.startsWith('--data-dir='));
if (check && dataDirs.length) throw Error('检查模式不接受 --data-dir，检查只使用独立临时数据目录');
if (dataDirs.length > 1) throw Error('--data-dir 只能指定一次');
const dataDir = dataDirs[0]?.slice('--data-dir='.length);
if (dataDir !== undefined && (!dataDir || !isAbsolute(dataDir))) throw Error('--data-dir 必须是绝对路径');
const port = Number(args.find(value => value.startsWith('--web-port='))?.split('=')[1] ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('网页端口必须在 1024–65535 之间');
if (!existsSync(join(root, 'services/agent-runtime/node_modules/@deepseek-ai/dsh'))) throw Error('先运行 npm --prefix services/agent-runtime ci');
const directory = check ? join(root, '.data', 'local-check', randomUUID()) : dataDir ? resolve(dataDir) : join(root, '.data', 'local');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lockFile = join(directory, 'launcher.lock'), lock = { id: randomUUID(), pid: process.pid };
if (existsSync(lockFile)) {
  const old = JSON.parse(readFileSync(lockFile, 'utf8'));
  if (!Number.isInteger(old.pid) || old.pid < 1) throw Error('本机启动锁格式异常');
  let alive = true;
  try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  if (alive) throw Error('本机工作空间正在运行，请打开已有页面或先停止服务');
  unlinkSync(lockFile);
}
writeFileSync(lockFile, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
let db, socket, child, childExit, web, shutdown, stopping = false, resolveStopped;
const stopped = new Promise(resolve => { resolveStopped = resolve; });
function requestStop() { stopping = true; resolveStopped(); if (child?.connected) child.send('stop'); }
function ensureActive() { if (stopping) throw Error('本机启动已取消'); }
function stopChild() {
  return (async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send('stop'); else child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
    await childExit; clearTimeout(kill);
  })();
}
function stop() {
  return shutdown ??= (async () => {
    stopping = true;
    try { await web?.close(); await stopChild(); await socket?.stop(); await db?.close(); }
    finally { if (existsSync(lockFile) && JSON.parse(readFileSync(lockFile, 'utf8')).id === lock.id) unlinkSync(lockFile); resolveStopped(); }
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, requestStop);
try {
  console.log('正在启动为伍本机真实 API 工作空间…');
  db = await PGlite.create({ dataDir: join(directory, 'database'), extensions: { vector } }); ensureActive();
  socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 8 });
  let dbPort; socket.addEventListener('listening', event => { dbPort = event.detail.port; }); await socket.start(); ensureActive();
  const launchApi = async () => {
    const env = { ...process.env, AGENT_DEPARTMENT_LOCAL: 'isolated', LOCAL_ENABLE_DEVICE: args.includes('--enable-device')?'explicit':'', LOCAL_WORKSPACE_ROOT: directory, DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`, DATA_DIR: join(directory, 'credentials'), TRACE_ROOT: join(directory, 'runs'), OBSIDIAN_VAULT: join(directory, 'obsidian-vault'), ALLOWED_ORIGINS: '' };
    delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.AGENT_DEPARTMENT_DEMO;
    child = spawn(process.execPath, ['--import', 'tsx', 'scripts/local-api.ts'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    childExit = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(1)); });
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('本机 API 启动超过 60 秒')), 60000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(Error('本机 API 已退出：' + code)); });
      child.on('message', value => { if (value.type === 'ready') { clearTimeout(timeout); resolve(value); } else if (value.type === 'error') { clearTimeout(timeout); reject(Error(value.message)); } });
    });
    ensureActive(); return ready;
  };
  const ready = await launchApi();
  const url = `http://127.0.0.1:${ready.apiPort}/api`;
  writeFileSync(join(directory, 'session.json'), JSON.stringify({ pid: process.pid, apiPid: child.pid, apiPort: ready.apiPort, webPort: check ? null : port }, null, 2) + '\n');
  if (check) {
    const { verifyLocal } = await import('./local-check.mjs');
    const saved = await verifyLocal(url, directory);
    await stopChild(); const reopened = await launchApi();
    await verifyLocal(`http://127.0.0.1:${reopened.apiPort}/api`, directory, saved);
    await fetch(`http://127.0.0.1:${reopened.apiPort}/api/local-devices/${saved.deviceId}`,{method:'DELETE',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)}).then(response=>{if(!response.ok)throw Error('停用设备检查失败：'+response.status);});
    await stopChild(); const disabled = await launchApi();
    await verifyLocal(`http://127.0.0.1:${disabled.apiPort}/api`, directory, {...saved,disabled:true});
    console.log('本机运行检查通过：外部 API 配置、本机执行、逐次审批和重启后配置/授权保留；未调用付费模型。');
  } else {
    child.once('exit', code => { if (!stopping) { process.exitCode = code || 1; requestStop(); } });
    const { createServer } = await import('vite');
    web = await createServer({ configFile: join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': `http://127.0.0.1:${ready.apiPort}` } } }); ensureActive();
    await web.listen(); ensureActive();
    console.log(`\n为伍本机工作台已就绪：http://127.0.0.1:${port}/\n一个想法，一支团队。\n从首页描述需求并组建部门；首次使用请在模型目录配置并测试 API。\n数据保存在 ${directory}\n项目默认使用本机执行器；每条命令仍需批准。Ctrl+C 停止，重启保留配置。`);
    await stopped;
  }
} catch (error) { if (!stopping) { console.error('本机启动或检查失败：' + error.message); process.exitCode = 1; } }
finally { await stop(); }
