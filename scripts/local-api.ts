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
const openshellBootstrap = createRequire(import.meta.url)('./local-openshell-bootstrap.cjs');
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
const app = createApp({ localWorkspace: workspace,sandboxMaintenance:()=>openshellClient?{deviceId:openshellClient.device.id,grantId:openshellClient.device.grant.id,fingerprint:openshellClient.executor.backend.fingerprint,executor:openshellClient.executor}:undefined });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); if (!address || typeof address === 'string') throw Error('本机 API 启动失败');
const apiPort = address.port;
const client = new LocalDeviceClient({ connection: { server: `http://127.0.0.1:${apiPort}/` }, device, journalRoot: join(root, 'journal'), pollMs: 500 });
let openshellClient: any;
let openshellStatus: any = { status: 'not-configured' };
async function disableSavedOpenShell() {
  const saved=openshellBootstrap.readDevice(root,unseal);
  if (!saved) return;
  if (saved.id===device.id || saved.grant.id===device.grant.id) throw Error('OpenShell 设备不得复用原本机授权');
  const inactive=new LocalDeviceClient({connection:{server:`http://127.0.0.1:${apiPort}/`},device:saved,journalRoot:openshellBootstrap.locations(root).journalRoot,executor:{async execute(){throw Object.assign(Error('OpenShell 配置无效，操作未执行'),{notExecuted:true});}}});
  try{await inactive.api(saved.id+'/disable',{});}finally{await inactive.close();}
}
async function startOpenShell() {
  const configFile=process.env.LOCAL_OPENSHELL_CONFIG;
  if (!configFile) {
    if(process.env.LOCAL_ENABLE_OPENSHELL_DEVICE==='explicit') console.error('OpenShell 未启用：请先显式配置 LOCAL_OPENSHELL_CONFIG；原本机设备保持不变。');
    return;
  }
  try {
    if(process.platform!=='linux')throw Object.assign(Error('此固定 OpenShell CLI 仅支持 Linux 执行后端'),{code:'OPENSHELL_PLATFORM_UNSUPPORTED'});
    const {OpenShellDeviceExecutor,canonicalConfigFingerprint}=createRequire(import.meta.url)('../apps/desktop/openshell-executor.cjs');
    const checked=openshellBootstrap.readConfig(configFile,{fingerprint:canonicalConfigFingerprint});
    const opened=openshellBootstrap.prepareDevice({root,...checked,seal,unseal,reenable:process.env.LOCAL_ENABLE_OPENSHELL_DEVICE==='explicit'});
    if (opened.device.id===device.id || opened.device.grant.id===device.grant.id) throw Error('OpenShell 设备不得复用原本机授权');
    const executor=new OpenShellDeviceExecutor({grant:opened.device.grant,config:checked.config,journalRoot:opened.journalRoot});
    openshellClient=new LocalDeviceClient({connection:{server:`http://127.0.0.1:${apiPort}/`},device:opened.device,journalRoot:opened.journalRoot,executor,pollMs:500,onState:(state:any)=>{openshellStatus={status:state.status,deviceId:opened.device.id,backend:opened.backend};}});
    await openshellClient.start();
    openshellStatus={status:'connected',deviceId:opened.device.id,backend:opened.backend};
    console.log('OpenShell 隔离执行设备已启用；请在新项目策略中明确选择它。原本机设备、已有项目及模型宿主保持原样。');
  } catch (error) {
    const code=typeof (error as any)?.code==='string' && /^[A-Z_]{1,60}$/.test((error as any).code)?(error as any).code:'OPENSHELL_START_FAILED';
    openshellStatus={status:'disabled',code};
    console.error('OpenShell 隔离执行设备未启用（'+code+'）：请检查显式启动配置、固定文件哈希及设备授权。原本机设备继续使用原授权；不会回退执行 OpenShell 操作。');
    try{await openshellClient?.close();await disableSavedOpenShell();}catch{openshellStatus={status:'offline',code,disableUnconfirmed:true};console.error('OpenShell 设备停用回执未确认；不会启动其执行循环，请检查设备页面。');}
    openshellClient=undefined;
  }
}
let stopping: Promise<void> | undefined;
function stop() {
  return stopping ??= (async () => {
    await app.locals.shutdown(); await Promise.all([client.close(),openshellClient?.close()]);
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
  await startOpenShell();
  process.send!({ type: 'ready', apiPort: address.port, workspace, openshell:openshellStatus });
} catch (error) {
  process.send!({ type: 'error', message: (error as Error).message }); await stop();
}
