import pg from 'pg';
import { once } from 'node:events';
import { createDemoGateway, createDemoPlan, DemoSandbox } from './support.mjs';

if (process.env.AGENT_DEPARTMENT_DEMO !== 'isolated' || !process.send) throw Error('请通过 npm run demo 启动独立演示环境');
// PGlite has one backend; never imply independent PostgreSQL lock coverage.
const NativePool = pg.Pool;
pg.Pool = class extends NativePool { constructor(options?: pg.PoolConfig) { super({ ...options, max: 1 }); } };
const { migrate, pool } = await import('../../apps/api/src/db.ts');
const { createApp } = await import('../../apps/api/src/app.ts');
await migrate();
const gateway = await createDemoGateway();
const gatewayAddress = gateway.address(); if (!gatewayAddress || typeof gatewayAddress === 'string') throw Error('演示模型启动失败');
const demo = { title: 'Todo API 团队开发演示', projectId: '', gatewayUrl: `http://127.0.0.1:${gatewayAddress.port}/v1` };
const app = createApp({ createExecutor: archive => new DemoSandbox(archive), assertExecutorReady: async signal => { signal.throwIfAborted(); }, demo });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); if (!address || typeof address === 'string') throw Error('演示 API 启动失败');
const url = `http://127.0.0.1:${address.port}/api`;
async function call<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); if (!response.ok) throw Error(path + ': ' + value.message); return value;
}

let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await app.locals.shutdown();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => gateway.close(() => resolve()))]);
  await pool.end(); process.exit(0);
}
process.on('message', message => { if (message === 'stop') void stop(); });
process.once('disconnect', () => void stop());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop());

try {
  const { id: gatewayId } = await call('/gateways', 'POST', { name: '本地演示服务（固定响应）', baseUrl: demo.gatewayUrl, apiKey: 'local-demo-no-real-credential' });
  const { id: modelId } = await call('/models', 'POST', { name: '固定响应演示模型 · 无真实费用', gatewayId, model: 'todo-demo-fixture', inputRate: 0, outputRate: 0 });
  await call('/models/' + modelId + '/test', 'POST', {}); await call('/models/' + modelId + '/test-tools', 'POST', {});
  const agents = [
    { id: 'manager', name: '项目经理', role: 'manager', tools: [] },
    { id: 'developer', name: '开发员工', role: 'member', tools: ['filesystem', 'artifact_write', 'terminal_test'] },
    { id: 'tester', name: '测试员工', role: 'member', tools: ['filesystem', 'artifact_write', 'terminal_test'] },
  ].map(agent => ({ ...agent, title: agent.name, instructions: '完成批准的 Todo 示例任务，依据实际文件和测试结果交付。此模型为固定响应演示服务。', modelId }));
  const { id: departmentId } = await call('/departments', 'POST', { name: 'Todo 产品团队', description: '项目经理协调，开发员工实现，测试员工独立验收。', agents });
  const { id: projectId } = await call('/projects', 'POST', { departmentId, requirement: '开发一个本地 Todo REST API，提供健康检查、增删改查、输入校验、开发自检、独立接口验收和运行说明。', policy: { maxBudget: 1, maxAgents: 3, maxConcurrentAgents: 2, deadlineSeconds: 600, maxModelCalls: 80, maxTaskModelCalls: 30, contextBytes: 256000, contextManagement: 'prune' } });
  const projects = await call('/projects');
  const original = projects.find((project: any) => project.id === projectId);
  await call('/projects/' + projectId + '/plan', 'PUT', { version: original.version, plan: createDemoPlan(original.plan.agents) });
  const ready = (await call('/projects')).find((project: any) => project.id === projectId);
  if (!ready.validation.valid) throw Error('预置演示方案无效：' + ready.validation.errors.join('；'));
  demo.projectId = projectId;
  process.send!({ type: 'ready', apiPort: address.port, projectId, version: ready.version });
} catch (error) {
  process.send!({ type: 'error', message: (error as Error).message }); await stop();
}
