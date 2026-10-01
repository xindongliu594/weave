import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/g, '<id>') : value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !['attempt_id', 'callId', 'workspaceRevision', 'expectedWorkspaceRevision'].includes(key)).map(key => [key, canonical(value[key])]));
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const waiting = new Set(['waiting_model', 'waiting_approval', 'waiting_capacity']);

/** Cheap, deterministic observations. No model is called by this watchdog. */
export class RuntimeSupervisor {
  constructor({ archive, policy = {}, now = Date.now, artifacts = [], onFailure } = {}) {
    Object.assign(this, { archive, now, onFailure });
    this.timeout = (policy.progressTimeoutSeconds ?? 300) * 1000;
    this.actionLimit = policy.repeatActionLimit ?? 8;
    this.errorLimit = policy.repeatErrorLimit ?? 3;
    this.sessions = new Map(); this.mapping = new Map(); this.calls = new Map(); this.commands = new Set();
    this.manifest = digest(artifacts); this.lastSummary = '';
  }
  session(id, ref = {}) {
    if (!id || id === this.captainId) return;
    let item = this.sessions.get(id);
    const runtimeTaskId = ref.runtimeTaskId ?? ref.taskId;
    if (!item || (runtimeTaskId && (item.runtimeTaskId !== runtimeTaskId || (ref.attemptId && item.attemptId !== ref.attemptId)))) {
      item = { sessionId: id, runtimeTaskId, taskId: this.mapping.get(runtimeTaskId) ?? ref.taskId, attemptId: ref.attemptId,
        phase: 'working', lastProgressAt: this.now(), actions: [], errors: 0 };
      this.sessions.set(id, item);
    }
    return item;
  }
  progress(item) { if (item) { item.lastProgressAt = this.now(); item.actions = []; item.errors = 0; item.errorKey = undefined; } }
  enter(sessionId, phase) {
    const item = this.session(sessionId); if (!item) return () => {};
    const previous = item.phase, started = this.now(); item.phase = phase;
    let left=false;
    return () => {
      if(left)return;left=true;
      if (item.phase === phase) item.phase = previous;
      // A human approval or model wait is not time spent fruitlessly working.
      item.lastProgressAt = Math.min(this.now(),item.lastProgressAt + Math.max(0, this.now() - started));
    };
  }
  observe(event) {
    const { type, data = {}, sessionId, callId } = event;
    if (type === 'run/captain') { this.captainId = data.sessionId; this.sessions.delete(data.sessionId); return; }
    if (type === 'run/task-mapping') { for (const row of data.tasks) this.mapping.set(row.task_id, row.seed_id); return; }
    if (type === 'runtime/outcome-unknown') { this.fail(this.session(sessionId), 'OUTCOME_UNKNOWN', '修改操作未取得确认结果，需要核对后再恢复'); return; }
    if (type === 'model/request') {
      const item = this.session(sessionId, event); if (item) { item.phase = 'waiting_model'; item.waitStarted = this.now(); } return;
    }
    if (type === 'model/finish' || type === 'model/error') {
      const item = this.sessions.get(sessionId); if (item) {
        item.lastProgressAt = Math.min(this.now(),item.lastProgressAt + Math.max(0, this.now() - (item.waitStarted ?? this.now()))); item.phase = 'working'; delete item.waitStarted;
      } return;
    }
    if (type === 'tool/start') {
      if (sessionId === this.captainId) return;
      // A requested task_id is model input. Only the trusted model admission
      // and native assignment can change the monitored task/attempt identity.
      const item = this.sessions.get(sessionId) ?? this.session(sessionId);
      if (item) { item.phase = 'executing_tool'; this.calls.set(callId, { item, name: data.name, args: data.arguments }); } return;
    }
    if (type === 'artifact/updated') {
      const manifest = digest(data.files ?? []);
      if (manifest !== this.manifest) { this.manifest = manifest; this.progress(this.sessions.get(sessionId)); } return;
    }
    if (type === 'handoff/accepted') { for (const item of this.sessions.values()) if (item.taskId === data.taskId && item.attemptId === data.attemptId) this.progress(item); return; }
    if (type === 'handoff/command-observed' && data.exitCode === 0) {
      const key = createHash('sha256').update(JSON.stringify(data)).digest('hex'); if (!this.commands.has(key)) {
        this.commands.add(key); for (const item of this.sessions.values()) if (item.taskId === data.taskId && item.attemptId === data.attemptId) this.progress(item);
      } return;
    }
    if (type !== 'tool/result') return;
    const call = this.calls.get(callId); this.calls.delete(callId); if (!call) return;
    const { item, name, args } = call, result = data.result;
    item.phase = 'working';
    const failed = result?.isError || Number(result?.value?.exitCode ?? 0) !== 0;
    const key = digest({ name, args, result });
    item.actions.push(key); if (item.actions.length > this.actionLimit * 3) item.actions.shift();
    if (failed) { const errorKey = digest({ name, error: result?.error ?? result?.value?.exitCode }); item.errors = item.errorKey === errorKey ? item.errors + 1 : 1; item.errorKey = errorKey; }
    else { item.errors = 0; item.errorKey = undefined; }
    if (item.errors >= this.errorLimit) this.fail(item, 'REPEATED_ERROR', `同类工具错误连续出现 ${item.errors} 次`);
    else if (item.actions.filter(value => value === key).length >= this.actionLimit) this.fail(item, 'REPEATED_ACTION', `相同动作与结果重复 ${this.actionLimit} 次，期间未观察到有效进展`);
  }
  fail(item, code, message) {
    if (this.failure) return;
    this.failure = Object.assign(Error(code + ': ' + message), { code });
    this.archive?.append('runtime/anomaly', { ...this.public(item), code, message, recovery: 'inspect_checkpoint' });
    this.onFailure?.(this.failure);
  }
  check() { if (this.failure) throw this.failure; }
  public(item = {}) { const { actions, errorKey, waitStarted, ...rest } = item; return rest; }
  tick(status) {
    const rows = [];
    for (const task of status.tasks ?? []) {
      if (!['claimed', 'in_progress'].includes(task.status)) continue;
      const member = status.members.find(member => member.name === task.assignee), id = member?.member_id ?? member?.id;
      const existing = [...this.sessions.values()].find(item => item.runtimeTaskId === task.id && item.attemptId === (task.attempt_id ?? task.attemptId));
      const item = existing ?? this.session(id, { taskId: task.id, attemptId: task.attempt_id ?? task.attemptId });
      if (!item) continue;
      const idle = member?.status === 'idle' && !waiting.has(item.phase);
      item.idleSince = idle ? item.idleSince ?? this.now() : undefined;
      if (idle && this.now() - item.idleSince > 10000) this.fail(item, 'EMPLOYEE_IDLE', '员工已空闲，但任务尚未完成');
      else if (!waiting.has(item.phase) && this.now() - item.lastProgressAt > this.timeout) this.fail(item, 'NO_PROGRESS', '持续工作期间未观察到文件变化、新验证证据或任务完成');
      rows.push({ ...this.public(item), phase: idle ? 'idle_unfinished' : item.phase, agentId: task.assignee });
    }
    // Persist transitions rather than flooding the trace with timer ticks.
    const signature = digest(rows.map(({ lastProgressAt, idleSince, ...row }) => row));
    if (signature !== this.lastSummary) { this.lastSummary = signature; this.archive?.append('runtime/status', { employees: rows }); }
    this.check(); return rows;
  }
}
