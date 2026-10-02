import pg from 'pg';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

if (process.env.AGENT_DEPARTMENT_LOCAL !== 'isolated' || !process.send || !process.env.LOCAL_WORKSPACE_ROOT) throw Error('请通过 npm run local 启动');
// The local prototype uses one PGlite backend, not a multi-user PostgreSQL server.
const NativePool = pg.Pool;
pg.Pool = class extends NativePool { constructor(options?: pg.PoolConfig) { super({ ...options, max: 1 }); } };
const { migrate, pool } = await import('../apps/api/src/db.ts');
const { seal, unseal } = await import('../apps/api/src/vault.ts');
const { createApp } = await import('../apps/api/src/app.ts');
const { LocalDeviceClient } = createRequire(import.meta.url)('../apps/desktop/local-client.cjs');
const root = resolve(process.env.LOCAL_WORKSPACE_ROOT), workspacesPath = join(root, 'workspaces');
mkdirSync(workspacesPath, { recursive: true, mode: 0o700 });
const deviceFile = join(root, 'device.credential');
let device: any;
if (existsSync(deviceFile) && process.env.LOCAL_ENABLE_DEVICE !== 'explicit') device = JSON.parse(unseal(readFileSync(deviceFile, 'utf8')));
else {
  device = { id: randomUUID(), token: randomBytes(32).toString('hex'), name: '本机 Node 执行器', grant: { id: randomUUID(), root: workspacesPath, allowCommands: true } };
  writeFileSync(deviceFile, seal(JSON.stringify(device)), { flag: existsSync(deviceFile) ? 'w' : 'wx', mode: 0o600 });
}
if (device.grant.root !== workspacesPath) throw Error('本机执行目录与已保存的授权不一致');
await migrate();
const workspace = { kind: 'local' as const, database: 'pglite' as const, workspacesPath, executionTarget: { kind: 'local' as const, deviceId: device.id, grantId: device.grant.id } };
// No fixture gateway, DemoSandbox, or readiness bypass is installed here.
const app = createApp({ localWorkspace: workspace });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); if (!address || typeof address === 'string') throw Error('本机 API 启动失败');
const client = new LocalDeviceClient({ connection: { server: `http://127.0.0.1:${address.port}/` }, device, journalRoot: join(root, 'journal'), pollMs: 500 });
let stopping: Promise<void> | undefined;
function stop() {
  return stopping ??= (async () => {
    await app.locals.shutdown(); await client.close();
    await new Promise<void>(done => server.close(() => done()));
    await pool.end(); process.exit(0);
  })();
}
process.on('message', message => { if (message === 'stop') void stop(); });
process.once('disconnect', () => void stop());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop());
try {
  try { await client.start(); }
  catch (error) {
    if ((error as {status?:number}).status !== 403) throw error;
    console.log('本机执行授权已停用，保留配置页面；重新授权请使用 npm run local -- --enable-device。');
  }
  process.send!({ type: 'ready', apiPort: address.port, workspace });
} catch (error) {
  process.send!({ type: 'error', message: (error as Error).message }); await stop();
}
