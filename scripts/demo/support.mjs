import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { artifactFile, listArtifacts } from '../../services/agent-runtime/sandbox.mjs';
import { Semaphore } from '../../services/agent-runtime/limits.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const assets = new Map(['todo.mjs', 'smoke.test.mjs', 'acceptance.test.mjs', 'README.md'].map(name => [name, readFileSync(new URL('./assets/' + name, import.meta.url), 'utf8')]));
const review = JSON.stringify({ accepted: true, reviewer: '独立测试员工', basis: '开发交付物及实际 HTTP 接口验收；最终是否完成由宿主检查命令退出码和文件版本。', limitations: '固定响应模型演示；Todo 数据仅保存在内存。' }, null, 2) + '\n';
assets.set('review.json', review);

export function createDemoPlan(agents) {
  const common = { estimatedInputTokens: 12000, estimatedOutputTokens: 5000, maxModelCalls: 30 };
  const output = path => ({ path, format: 'text' });
  const inputs = ['todo.mjs', 'smoke.test.mjs', 'README.md'].map(path => ({ path, producerTaskId: 'build' }));
  return { rationale: '经理协调，开发员工制作 Todo API 并自检，另一位测试员工编写独立接口验收并审查。', agents, tasks: [
    { ...common, id: 'build', subject: '开发 Todo API', objective: '实现健康检查和 Todo 增删改查，提供自检与运行说明。', assigneeId: 'developer', dependencies: [], acceptanceCriteria: ['接口可启动，开发自检通过，提交运行说明'], kind: 'implementation', inputs: [], outputs: ['todo.mjs', 'smoke.test.mjs', 'README.md'].map(output), inScope: ['todo.mjs', 'smoke.test.mjs', 'README.md'], verify: ['node --test smoke.test.mjs'] },
    { ...common, id: 'review', subject: '独立测试并验收', objective: '读取开发交付物，编写独立接口测试，实际检查 CRUD、输入校验及错误处理，提交验收报告。', assigneeId: 'tester', dependencies: ['build'], acceptanceCriteria: ['独立接口验收全部通过，有实际命令及文件版本证据'], kind: 'review', reviewedTaskId: 'build', inputs, outputs: [output('acceptance.test.mjs'), { path: 'test-report.json', format: 'json', expectedValues: { passed: true, tests: 6, exitCode: 0 } }, { path: 'review.json', format: 'json', expectedValues: { accepted: true } }], inScope: ['acceptance.test.mjs', 'test-report.json', 'review.json'], verify: ['node --test acceptance.test.mjs'], maxReworkRounds: 0 },
  ] };
}

const tool = (name, args, id) => ({ content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function pinnedTask(messages) {
  for (const message of messages.filter(item => item.role === 'system')) for (const line of String(message.content ?? '').split('\n')) {
    try { const value = JSON.parse(line); if (value.runtimeTaskId && value.attemptId && value.task) return value; } catch { /* Other prompt sections are plain text. */ }
  }
  // The first prompt is assembled before durable team admission. Its user
  // assignment already carries the task and attempt, as in the product fixtures.
  const assignment = messages.filter(item => item.role === 'user' && typeof item.content === 'string').findLast(item => item.content.includes('AgentTeams automatic task assignment'))?.content;
  const task = /Task: (t\d+) — (开发 Todo API|独立测试并验收)/.exec(assignment ?? ''), attempt = /Attempt id: ([a-f0-9-]+)/.exec(assignment ?? '');
  if (task && attempt) return { runtimeTaskId: task[1], attemptId: attempt[1], task: { id: task[2] === '开发 Todo API' ? 'build' : 'review', acceptanceCriteria: [task[2] === '开发 Todo API' ? '接口可启动，开发自检通过，提交运行说明' : '独立接口验收全部通过，有实际命令及文件版本证据'] } };
}

export async function createDemoGateway() {
  const steps = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end('{}'); }
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) throw Error('演示请求过大'); }
      const body = JSON.parse(raw), messages = body.messages ?? [];
      let message = { content: '本地固定响应演示：经理协调完成，请查看员工任务、实际测试结果和交付物。' };
      if (body.tools?.some(item => item.function.name === 'capability_probe') || messages.some(item => item.tool_calls?.some(call => call.function.name === 'capability_probe'))) {
        const last = messages.at(-1);
        if (last?.role === 'tool') message = { content: JSON.parse(last.content).result };
        else message = tool('capability_probe', { nonce: body.tools.find(item => item.function.name === 'capability_probe').function.parameters.properties.nonce.enum[0] }, 'demo-probe');
      } else if (messages.some(item => item.role === 'system' && String(item.content).includes('你是组织规划器'))) {
        message = { content: JSON.stringify(createDemoPlan(JSON.parse(messages.findLast(item => item.role === 'user').content).departmentAgents)) };
      } else {
        const pinned = pinnedTask(messages);
        if (pinned) {
          const key = pinned.runtimeTaskId + ':' + pinned.attemptId, step = steps.get(key) ?? 0;
          const update = (status, extra = {}) => ['agent_teams_update_task', { task_id: pinned.runtimeTaskId, attempt_id: pinned.attemptId, status, ...extra }];
          let actions = [['agent_teams_claim_task', { task_id: pinned.runtimeTaskId }], update('in_progress')];
          if (pinned.task.id === 'build') {
            actions.push(...['todo.mjs', 'smoke.test.mjs', 'README.md'].map(path => ['artifact_write', { path, content: assets.get(path) }]), ['terminal_test', { command: 'node --test smoke.test.mjs' }], update('completed', { output: 'Todo API、开发自检和运行说明已交付；自检实际通过。', changedPaths: ['todo.mjs', 'smoke.test.mjs', 'README.md'], acceptanceResults: [{ criterion: pinned.task.acceptanceCriteria[0], status: 'passed', evidence: '实际 Node HTTP 自检与工作区文件' }], commandsRun: [{command:'node --test smoke.test.mjs',status:'passed',exitCode:0,evidence:'宿主记录的实际 Node HTTP 自检'}] }));
          } else if (pinned.task.id === 'review') {
            actions.push(...['todo.mjs', 'smoke.test.mjs', 'README.md'].map(path => ['filesystem', { path }]), ['artifact_write', { path: 'acceptance.test.mjs', content: assets.get('acceptance.test.mjs') }], ['artifact_write', { path: 'review.json', content: review }], ['terminal_test', { command: 'node --test acceptance.test.mjs' }], update('completed', { output: '独立验收完成：健康检查、完整 CRUD、参数校验、无效 JSON、不存在的 Todo 和未知路由均通过。', verdict: 'pass',acceptanceResults:[{criterion:pinned.task.acceptanceCriteria[0],status:'passed',evidence:'实际六项 HTTP 验收及 test-report.json'}],commandsRun:[{command:'node --test acceptance.test.mjs',status:'passed',exitCode:0,evidence:'宿主记录的实际独立接口验收'}] }));
          } else throw Error('演示模型仅支持预置 Todo 开发和验收任务');
          if (step < actions.length) { message = tool(...actions[step], key + ':' + step); steps.set(key, step + 1); }
        }
      }
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
    } catch (error) { res.writeHead(422); res.end(JSON.stringify({ error: { message: error.message } })); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); return server;
}

// The demo accepts only repo-owned source templates and two fixed test commands.
// General shell commands remain on the normal Docker / authorized-device paths.
export class DemoSandbox {
  constructor(archive) { this.root = join(archive.dir, 'artifacts'); this.mutex = new Semaphore(1); this.closed = false; }
  async prepare(signal) { signal?.throwIfAborted(); mkdirSync(this.root, { recursive: true, mode: 0o700 }); }
  revision() { return hash(JSON.stringify(listArtifacts(this.root).sort((a, b) => a.path.localeCompare(b.path)))); }
  async execute(name, args, signal) {
    const release = await this.mutex.acquire(signal);
    try {
      signal?.throwIfAborted(); if (this.closed) throw Error('演示工作区已停止');
      if (args.expectedWorkspaceRevision && args.expectedWorkspaceRevision !== this.revision()) throw Error('WORKSPACE_VERSION_CONFLICT');
      let result;
      if (name === 'artifact_write') {
        if (!assets.has(args.path) || args.content !== assets.get(args.path)) throw Object.assign(Error('演示仅允许写入固定 Todo 示例文件'), { notExecuted: true });
        const file = join(this.root, args.path), previous = existsSync(file) ? hash(readFileSync(artifactFile(this.root, args.path))) : undefined;
        if (previous !== args.expectedSha256) throw Object.assign(Error('FILE_VERSION_CONFLICT'), { notExecuted: true });
        writeFileSync(file, args.content, { mode: 0o600 }); result = { path: args.path, sha256: hash(args.content), bytes: Buffer.byteLength(args.content) };
      } else if (name === 'filesystem') {
        if (!assets.has(args.path) && args.path !== 'test-report.json') throw Object.assign(Error('演示文件未授权'), { notExecuted: true });
        const content = readFileSync(artifactFile(this.root, args.path), 'utf8'); result = { path: args.path, content, sha256: hash(content) };
      } else if (name === 'terminal_test' || name === 'terminal') {
        const file = ({ 'node --test smoke.test.mjs': 'smoke.test.mjs', 'node --test acceptance.test.mjs': 'acceptance.test.mjs' })[args.command];
        if (!file) throw Object.assign(Error('演示仅允许两条预置 Node 测试命令'), { notExecuted: true });
        for (const path of ['todo.mjs', file]) if (readFileSync(artifactFile(this.root, path), 'utf8') !== assets.get(path)) throw Object.assign(Error('演示测试源码版本不匹配'), { notExecuted: true });
        result = await runTest(this.root, file, signal);
        if (file === 'acceptance.test.mjs') {
          const tests = Number(/# tests (\d+)/.exec(result.output)?.[1] ?? 0), passed = Number(/# pass (\d+)/.exec(result.output)?.[1] ?? 0);
          writeFileSync(join(this.root, 'test-report.json'), JSON.stringify({ command: args.command, exitCode: result.exitCode, tests, passed: result.exitCode === 0 && tests === 6 && passed === 6, output: result.output }, null, 2) + '\n', { mode: 0o600 });
        }
      } else throw Object.assign(Error('演示工具未授权'), { notExecuted: true });
      return { ...result, artifacts: listArtifacts(this.root), workspaceRevision: this.revision() };
    } finally { release(); }
  }
  async close() { this.closed = true; }
}

async function runTest(cwd, file, signal) {
  const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  return new Promise((resolve, reject) => {
    // Disable test worker processes so cancellation also closes the HTTP fixture.
    const child = spawn(process.execPath, ['--test', '--experimental-test-isolation=none', '--test-reporter=tap', file], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let bytes = 0, overflow = false; const chunks = [];
    const kill = () => child.kill('SIGKILL'); abort.addEventListener('abort', kill, { once: true }); if (abort.aborted) kill();
    const collect = chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { overflow = true; kill(); } else chunks.push(chunk); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { abort.removeEventListener('abort', kill); reject(Object.assign(error, { notExecuted: true })); });
    child.once('close', code => { abort.removeEventListener('abort', kill); if (abort.aborted) reject(abort.reason); else if (overflow || code === null) reject(Error('演示测试未取得完整结果')); else resolve({ exitCode: code, output: Buffer.concat(chunks).toString('utf8') }); });
  });
}
