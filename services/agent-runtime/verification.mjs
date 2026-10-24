import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';

export function verificationSnapshot() {
  return {
    title: '需求整理与审核 · 追溯验证', mode: 'fixture', templateVersion: 'trace-verification-v1',
    requirement: '整理 Todo API 需求，再由另一位员工审核并汇报。此运行使用确定性测试模型，不调用外部 API。',
    approval: { kind: 'verification', description: '用户主动启动无 API 的追溯验证，不是业务项目执行审批' },
    planVersion: 1,
    agents: [
      { id: 'captain', name: '协调经理', model: 'fixture-captain', roleVersion: 1, rolePrompt: '协调任务、接收员工汇报并汇总；如实说明未验证项。' },
      { id: 'writer', name: '需求分析师', model: 'fixture-writer', roleVersion: 1, rolePrompt: '整理需求边界和验收标准，产出清晰的需求说明。' },
      { id: 'reviewer', name: '审核员', model: 'fixture-reviewer', roleVersion: 1, rolePrompt: '独立核对需求完整性，记录问题与验证结论。' },
    ],
    tasks: [
      { id: 'draft', assignee: 'writer', subject: '整理接口需求', taskPrompt: '列出 Todo API 的增删改查需求，说明每项的验收标准。', dependencies: [] },
      { id: 'review', assignee: 'reviewer', subject: '审核需求说明', taskPrompt: '依据前置任务结果检查增删改查覆盖情况，提交审核结论。', dependencies: ['draft'] },
    ],
  };
}

/** Explicit offline verification only. Never use this adapter for a product run. */
export async function runTraceVerification(root, { writers, snapshot = verificationSnapshot() } = {}) {
  if (!writers || writers.traceRoot !== root) throw Object.assign(Error('Verification requires the application writer manager'), { code: 'E_ARCHIVE_WRITER_CONFIG' });
  const id = randomUUID();
  const result = await writers.withWriter([id], async () => {
  const stored = createRunArchive(root, snapshot, { id });
  let archiveFailure;
  const archive = { ...stored, append(...args) {
    try { return stored.append(...args); } catch (error) { archiveFailure ??= error; throw error; }
  } };
  const workspace = join(archive.dir, 'workspace');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const steps = new Map();
  const adapter = new class extends LlmAdapter {
    async *stream(options) {
      options.signal?.throwIfAborted();
      const step = steps.get(options.sessionId) ?? 0;
      steps.set(options.sessionId, step + 1);
      const assignment = options.messages.filter(m => m.role === 'user').flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const taskId = /Task: (t\d+)/.exec(assignment)?.[1];
      const attemptId = /Attempt id: ([a-f0-9-]+)/.exec(assignment)?.[1];
      const output = options.model === 'fixture-writer' ? '需求说明：支持创建、查询、更新、删除 Todo；分别验证成功结果与无效输入。' : '审核结论：四项基本操作已覆盖；实际接口与自动化测试尚未执行。';
      if (taskId && step < 4) {
        const calls = [
          ['agent_teams_claim_task', { task_id: taskId }],
          ['agent_teams_update_task', { task_id: taskId, attempt_id: attemptId, status: 'in_progress' }],
          ['agent_teams_update_task', { task_id: taskId, attempt_id: attemptId, status: 'completed', output }],
          ['agent_teams_send_message', { to: 'captain', content: output }],
        ];
        const [name, args] = calls[step];
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: taskId ? '本轮任务已汇报。' : '已接收员工报告；此结果仅验证团队执行与追溯流程。' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }();
  let host, lifecycle, closing;
  const close = () => closing ??= Promise.resolve().then(() => (lifecycle ?? host)?.close());
  try {
    host = await createTeamHost({ adapter, provider: 'trace-fixture', sessionRoot: join(archive.dir, 'sessions'), archive, onLifecycle: value => { lifecycle = value; } });
    let reports = 0;
    host.ctx.on('tools/result', (exec, result) => { if (exec.name === 'agent_teams_send_message' && !result.isError) reports++; });
    const captainConfig = snapshot.agents[0];
    const captain = await host.captain({ cwd: workspace, model: captainConfig.model, instructions: captainConfig.rolePrompt });
    archive.append('run/captain', { agentId: captainConfig.id, sessionId: captain.id });
    const plan = {
      members: snapshot.agents.slice(1).map(a => ({ name: a.id, role: a.rolePrompt, provider: 'trace-fixture', model: a.model })),
      tasks: snapshot.tasks.map(t => ({ id: t.id, subject: t.subject, description: t.taskPrompt, assignee: t.assignee, dependencies: t.dependencies })),
    };
    const created = await host.call(captain, 'agent_teams_create', { name: 'trace-verification', description: snapshot.requirement, approval: 'required', plan });
    archive.append('run/task-mapping', { tasks: created.tasks });
    await host.call(captain, 'agent_teams_status');
    archive.append('run/approved', snapshot.approval);
    await host.call(captain, 'agent_teams_approve', { confirmation: '启动无 API 的追溯验证' });
    const deadline = Date.now() + 15_000;
    let status;
    do {
      status = await host.call(captain, 'agent_teams_status');
      if (status.members.some(m => m.spawn_error)) throw new Error('Member startup failed');
      if (status.deliverable && reports === 2) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    if (!status.deliverable || reports !== 2) throw new Error('Verification deadline exceeded');
    // Quiesce before sealing the archive so final reports and cancellation events are included.
    await captain.whenIdle();
    await close();
    archive.append('run/finished', { status: 'completed', description: '测试模型流程完成；未调用真实 API', tasks: status.tasks });
  } catch (error) {
    let cleanupFailure;
    try { await close(); } catch (failure) { cleanupFailure = failure; }
    try { archive.append('run/finished', { status: 'failed', message: String(error?.message ?? error) }); }
    catch { throw error; } // Preserve the original failure; the append still latches this scope.
    if (archiveFailure || cleanupFailure || error?.code === 'RUNTIME_WRITER_DRAIN_UNPROVEN') throw error;
    // Only proven quiescent business rejection leaves the native scope normally.
    return { ok: false, error };
  }
  return { ok: true, value: readRun(root, archive.id) };
  });
  if (!result.ok) throw result.error;
  return result.value;
}
