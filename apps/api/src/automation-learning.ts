import { Router } from 'express';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { validateKnowledgeGrants } from './knowledge-store.ts';
import {syncReuseCandidates,validateReuseEvidence} from './knowledge-reuse.ts';
import {resolve} from 'node:path';

export const automationTables = ['automation_schedules', 'automation_occurrences', 'automation_notifications', 'automation_observations', 'automation_knowledge_candidates', 'automation_improvements', 'automation_evaluations', 'automation_reviews'];
export async function migrateAutomationLearning(db: pg.Pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS automation_schedules(id text PRIMARY KEY,name text NOT NULL,source_project_id text NOT NULL REFERENCES projects(id),snapshot jsonb NOT NULL,kind text NOT NULL CHECK(kind IN ('once','interval')),interval_seconds int,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','cancelled','completed')),next_due timestamptz NOT NULL,version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS automation_occurrences(id text PRIMARY KEY,schedule_id text NOT NULL REFERENCES automation_schedules(id),due_at timestamptz NOT NULL,project_id text NOT NULL REFERENCES projects(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(schedule_id,due_at));
    CREATE TABLE IF NOT EXISTS automation_notifications(id text PRIMARY KEY,event_key text NOT NULL UNIQUE,kind text NOT NULL,title text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz);
    CREATE TABLE IF NOT EXISTS automation_observations(id text PRIMARY KEY,run_id text NOT NULL REFERENCES project_runs(id),bucket text NOT NULL,status text NOT NULL,details jsonb NOT NULL,observed_at timestamptz NOT NULL,UNIQUE(run_id,bucket));
    CREATE TABLE IF NOT EXISTS automation_knowledge_candidates(id text PRIMARY KEY,run_id text NOT NULL REFERENCES project_runs(id),document_id text NOT NULL REFERENCES knowledge_documents(id),source_version int NOT NULL,source_hash text NOT NULL,space_id text NOT NULL REFERENCES knowledge_spaces(id),title text NOT NULL,content text NOT NULL,status text NOT NULL DEFAULT 'pending',published_document_id text,version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(document_id,source_hash));
    CREATE TABLE IF NOT EXISTS automation_improvements(id text PRIMARY KEY,title text NOT NULL,source_run_id text REFERENCES project_runs(id),baseline text NOT NULL,proposal text NOT NULL,cases jsonb NOT NULL,status text NOT NULL DEFAULT 'proposed',version int NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS automation_evaluations(id text PRIMARY KEY,improvement_id text NOT NULL REFERENCES automation_improvements(id),results jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS automation_reviews(id text PRIMARY KEY,improvement_id text NOT NULL REFERENCES automation_improvements(id),evaluation_id text REFERENCES automation_evaluations(id),action text NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS automation_schedules_due ON automation_schedules(status,next_due);
    CREATE INDEX IF NOT EXISTS automation_notifications_unread ON automation_notifications(read_at,created_at);
    ALTER TABLE automation_knowledge_candidates ADD COLUMN IF NOT EXISTS publishing_at timestamptz;
    ALTER TABLE automation_knowledge_candidates ADD COLUMN IF NOT EXISTS reuse_evidence jsonb;
  `);
}

type Database = Pick<pg.PoolClient, 'query'>;
const terminal = ['completed', 'failed', 'cancelled', 'interrupted'];
const iso = (value: Date | string) => new Date(value).toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function transaction<T>(db: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) {
  const client = await db.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function notify(db: Database, key: string, kind: string, title: string, details: unknown, now: Date) {
  await db.query('INSERT INTO automation_notifications(id,event_key,kind,title,details,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING', [randomUUID(), key, kind, title, details, now]);
}
/** Missed intervals coalesce into one approval draft, avoiding a restart storm. */
export function nextScheduleTime(due: Date, now: Date, seconds: number): Date {
  return new Date(due.getTime() + (Math.floor(Math.max(0, now.getTime() - due.getTime()) / (seconds * 1000)) + 1) * seconds * 1000);
}

export class AutomationLearningService {
  private timer?: NodeJS.Timeout;
  private work?: Promise<void>;
  private stopped = false;
  public lastError: string | null = null;
  public lastCheckedAt: string | null = null;
  private reuseCheckedAt?: number;
  private reuseDepartmentCursor='';
  constructor(private db: pg.Pool = pool, private options: { clock?: () => Date; intervalMs?: number;traceRoot?:string } = {}) {}
  start() { if (this.timer) return this; this.stopped = false; this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 10000); this.timer.unref(); void this.tick(); return this; }
  async close() { this.stopped = true; clearInterval(this.timer); this.timer = undefined; await this.work; }
  async tick() {
    if (this.stopped) return;
    if (this.work) return this.work;
    this.work = this.check().catch(() => { this.lastError = '自动化检查失败；下次检查将重试，未自动执行项目。'; }).finally(() => { this.work = undefined; });
    return this.work;
  }
  private async check() {
    const now = this.options.clock?.() ?? new Date();let reuseChecked=false,reuseCursor=this.reuseDepartmentCursor;
    await transaction(this.db, async client => {
      // Share the backup/coordinator fence; writes and notification dedupe commit together.
      if (!(await client.query('SELECT pg_try_advisory_xact_lock(918274) AS locked')).rows[0].locked) return;
      if(this.reuseCheckedAt===undefined||now.getTime()-this.reuseCheckedAt>=60000){
        let departments=(await client.query("SELECT DISTINCT p.department_id FROM projects p JOIN departments d ON d.id=p.department_id JOIN project_runs r ON r.project_id=p.id WHERE d.deleted_at IS NULL AND r.status='completed' AND p.department_id>$1 ORDER BY p.department_id LIMIT 20",[this.reuseDepartmentCursor])).rows;
        if(!departments.length&&this.reuseDepartmentCursor)departments=(await client.query("SELECT DISTINCT p.department_id FROM projects p JOIN departments d ON d.id=p.department_id JOIN project_runs r ON r.project_id=p.id WHERE d.deleted_at IS NULL AND r.status='completed' ORDER BY p.department_id LIMIT 20")).rows;
        for(const department of departments)await syncReuseCandidates(client,this.options.traceRoot??resolve(process.env.TRACE_ROOT??'.data/runs'),department.department_id);
        reuseCursor=departments.length===20?departments.at(-1).department_id:'';
        reuseChecked=true;
      }
      const schedules = (await client.query("SELECT * FROM automation_schedules WHERE status='active' AND next_due<=$1 ORDER BY next_due LIMIT 20 FOR UPDATE SKIP LOCKED", [now])).rows;
      for (const schedule of schedules) {
        // Clone the complete approved-to-be plan, including file selections and tool scopes.
        // A schedule does not infer new grants or approve this newly created project.
        const projectId = randomUUID(), occurrenceId = randomUUID(), source = schedule.snapshot;
        await client.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source,status) VALUES($1,$2,$3,$4,$5,$6,$7,'manual','DRAFT')", [projectId, source.department_id, source.department_version, source.department_name, source.requirement, source.policy, source.plan]);
        await client.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,1,$2,$3)', [projectId, source.plan, source.policy]);
        await client.query('INSERT INTO automation_occurrences(id,schedule_id,due_at,project_id,created_at) VALUES($1,$2,$3,$4,$5)', [occurrenceId, schedule.id, schedule.next_due, projectId, now]);
        const next = schedule.kind === 'interval' ? nextScheduleTime(new Date(schedule.next_due), now, schedule.interval_seconds) : new Date(schedule.next_due);
        await client.query('UPDATE automation_schedules SET next_due=$1,status=$2,version=version+1 WHERE id=$3', [next, schedule.kind === 'once' ? 'completed' : 'active', schedule.id]);
        await notify(client, 'schedule:' + occurrenceId, 'approval', `「${schedule.name}」已生成待批准项目`, { scheduleId: schedule.id, projectId, dueAt: iso(schedule.next_due), requiresApproval: true }, now);
      }
      const runs = (await client.query(`SELECT r.id,r.project_id,r.status,r.created_at,r.started_at,r.finished_at,r.lease_until,r.cancel_requested,r.snapshot->>'title' AS title,
        COALESCE((SELECT sum(cost)::float FROM usage WHERE run_id=r.id),0) AS cost,
        (SELECT count(*)::int FROM usage WHERE run_id=r.id) AS calls
        FROM project_runs r WHERE r.snapshot ? 'approval' AND (r.status IN ('queued','running') OR NOT EXISTS(SELECT 1 FROM automation_notifications n WHERE n.event_key='run:'||r.id)) ORDER BY r.created_at DESC LIMIT 200`)).rows;
      for (const run of runs) {
        const staleLease = run.status === 'running' && (!run.lease_until || new Date(run.lease_until) <= now);
        const details = { projectId: run.project_id, ageSeconds: Math.max(0, Math.floor((now.getTime() - new Date(run.started_at ?? run.created_at).getTime()) / 1000)), cost: run.cost, modelCalls: run.calls, staleLease, cancelRequested: run.cancel_requested, note: staleLease ? '租约已过期，由运行协调器中断并核对；本监督器不会重启执行。' : '监督器记录状态；执行仍受原批准快照、预算和截止时间限制。' };
        const bucket = terminal.includes(run.status) ? 'terminal' : `${run.status}:${now.toISOString().slice(0, 13)}`;
        await client.query('INSERT INTO automation_observations(id,run_id,bucket,status,details,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,bucket) DO NOTHING', [randomUUID(), run.id, bucket, run.status, details, now]);
        if (terminal.includes(run.status)) await notify(client, 'run:' + run.id, run.status === 'completed' ? 'success' : 'attention', `${run.status === 'completed' ? '项目完成' : '项目已停止'}：${run.title ?? run.id}`, { runId: run.id, projectId: run.project_id, status: run.status }, now);
      }
    });
    if(reuseChecked){this.reuseCheckedAt=now.getTime();this.reuseDepartmentCursor=reuseCursor;}
    this.lastCheckedAt = now.toISOString(); this.lastError = null;
  }
}

export const improvementCaseSchema = z.object({ id: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(1000), requiredTerms: z.array(z.string().trim().min(1).max(200)).max(30).default([]), forbiddenTerms: z.array(z.string().trim().min(1).max(200)).max(30).default([]), maxCharacters: z.number().int().positive().max(50000).optional(), jsonKeys: z.array(z.string().trim().min(1).max(100)).max(30).default([]) }).refine(c => c.requiredTerms.length + c.forbiddenTerms.length + c.jsonKeys.length > 0 || c.maxCharacters !== undefined, '案例至少有一条可检查规则');
type ImprovementCase = z.infer<typeof improvementCaseSchema>;
export function evaluateImprovement(cases: ImprovementCase[], responses: { caseId: string; before: string; after: string }[]) {
  if (new Set(cases.map(c => c.id)).size !== cases.length || responses.length !== cases.length || new Set(responses.map(r => r.caseId)).size !== responses.length || cases.some(c => !responses.some(r => r.caseId === c.id))) throw new AppError(422, '前后结果必须覆盖每一个固定案例，案例 ID 不能重复');
  const score = (c: ImprovementCase, text: string) => {
    let parsed: unknown; try { parsed = JSON.parse(text); } catch {}
    const checks = [...c.requiredTerms.map(term => ({ label: '包含 ' + term, pass: text.includes(term) })), ...c.forbiddenTerms.map(term => ({ label: '不含 ' + term, pass: !text.includes(term) })), ...c.jsonKeys.map(key => ({ label: 'JSON 字段 ' + key, pass: !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, key) })), ...(c.maxCharacters === undefined ? [] : [{ label: `不超过 ${c.maxCharacters} 字符`, pass: text.length <= c.maxCharacters }])];
    return { score: checks.filter(c => c.pass).length / checks.length, checks };
  };
  const results = cases.map(c => { const response = responses.find(r => r.caseId === c.id)!; return { caseId: c.id, description: c.description, before: { text: response.before, ...score(c, response.before) }, after: { text: response.after, ...score(c, response.after) } }; });
  return { method: 'deterministic-rules-v1', modelExecuted: false, beforeScore: results.reduce((n, r) => n + r.before.score, 0) / results.length, afterScore: results.reduce((n, r) => n + r.after.score, 0) / results.length, cases, results };
}

async function authorizedSource(db: Database, runId: string, documentId: string) {
  const run = (await db.query('SELECT snapshot FROM project_runs WHERE id=$1', [runId])).rows[0];
  if (!run?.snapshot?.approval) throw new AppError(404, '请先选择已批准运行');
  const snapshot = run.snapshot, reference = snapshot.knowledge?.documents?.find((d: any) => d.documentId === documentId);
  const agents = (snapshot.agents ?? []).filter((a: any) => snapshot.knowledge?.agentDocuments?.[a.id]?.includes(documentId));
  if (!reference || !agents.length) throw new AppError(403, '资料不在本次运行授权范围');
  await validateKnowledgeGrants(agents, snapshot.departmentId, db);
  const source = (await db.query('SELECT d.title,d.space_id,r.content,r.sha256 FROM knowledge_documents d JOIN knowledge_spaces s ON s.id=d.space_id JOIN knowledge_revisions r ON r.document_id=d.id AND r.version=$2 WHERE d.id=$1 AND d.deleted_at IS NULL AND s.deleted_at IS NULL', [documentId, reference.version])).rows[0];
  if (!source || source.sha256 !== reference.sha256 || source.space_id !== reference.spaceId) throw new AppError(409, '引用资料已归档或授权版本缺失');
  return { ...source, version: reference.version };
}

export type PublishKnowledge = (input: { spaceId: string; title: string; content: string; source: { runId: string; note: string } }, id: string) => Promise<{ id: string; version: number }>;
export function automationLearningRouter(options: { db?: pg.Pool; service?: AutomationLearningService; publishKnowledge?: PublishKnowledge } = {}) {
  const db = options.db ?? pool, router = Router();
  router.get('/automation/status', (_req, res) => res.json({ lastCheckedAt: options.service?.lastCheckedAt ?? null, error: options.service?.lastError ?? null, dispatchMode: 'approval-draft', observation: 'hourly-and-terminal', actualMultiDayValidation: false }));
  router.get('/automation/schedules', async (_req, res) => res.json((await db.query('SELECT id,name,source_project_id AS "sourceProjectId",kind,interval_seconds AS "intervalSeconds",status,next_due AS "nextDue",version,created_at AS "createdAt" FROM automation_schedules ORDER BY created_at DESC LIMIT 200')).rows));
  router.get('/automation/occurrences', async (_req, res) => res.json((await db.query('SELECT id,schedule_id AS "scheduleId",project_id AS "projectId",due_at AS "dueAt",created_at AS "createdAt" FROM automation_occurrences ORDER BY created_at DESC LIMIT 200')).rows));
  router.post('/automation/schedules', async (req, res) => {
    const input = z.object({ name: z.string().trim().min(1).max(100), projectId: z.string().min(1), firstDue: z.iso.datetime({ offset: true }), kind: z.enum(['once', 'interval']), intervalSeconds: z.number().int().min(60).max(31536000).optional() }).refine(v => v.kind !== 'interval' || v.intervalSeconds !== undefined, '间隔计划需要间隔秒数').parse(req.body);
    const project = (await db.query('SELECT * FROM projects WHERE id=$1', [input.projectId])).rows[0];
    if (!project) throw new AppError(404, '源项目不存在');
    const id = randomUUID();
    await db.query('INSERT INTO automation_schedules(id,name,source_project_id,snapshot,kind,interval_seconds,next_due) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, input.name, input.projectId, { department_id: project.department_id, department_version: project.department_version, department_name: project.department_name, requirement: project.requirement, plan: project.plan, policy: project.policy, sourceVersion: project.version }, input.kind, input.intervalSeconds ?? null, input.firstDue]);
    res.status(201).json({ id, requiresApproval: true });
  });
  router.post('/automation/schedules/:id/state', async (req, res) => {
    const input = z.object({ action: z.enum(['pause', 'resume', 'cancel']), version: z.number().int().positive() }).parse(req.body);
    const result = await db.query("UPDATE automation_schedules SET status=$1,version=version+1 WHERE id=$2 AND version=$3 AND status=ANY($4::text[]) RETURNING id", [{ pause: 'paused', resume: 'active', cancel: 'cancelled' }[input.action], req.params.id, input.version, input.action === 'pause' ? ['active'] : input.action === 'resume' ? ['paused'] : ['active', 'paused']]);
    if (!result.rowCount) throw new AppError(409, '计划状态已变化，请刷新；已完成或取消的计划不能恢复');
    res.json({ ok: true });
  });
  router.get('/automation/notifications', async (_req, res) => res.json((await db.query('SELECT id,kind,title,details,created_at AS "createdAt",read_at AS "readAt" FROM automation_notifications ORDER BY created_at DESC LIMIT 300')).rows));
  router.post('/automation/notifications/:id/read', async (req, res) => { await db.query('UPDATE automation_notifications SET read_at=now() WHERE id=$1 AND read_at IS NULL', [req.params.id]); res.json({ ok: true }); });
  router.get('/automation/observations', async (_req, res) => res.json((await db.query('SELECT id,run_id AS "runId",status,details,observed_at AS "observedAt" FROM automation_observations ORDER BY observed_at DESC LIMIT 200')).rows));
  router.get('/automation/knowledge-sources', async (_req, res) => {
    const runs = (await db.query("SELECT id,snapshot FROM project_runs WHERE snapshot ? 'approval' ORDER BY created_at DESC LIMIT 100")).rows;
    res.json(runs.map(r => ({ runId: r.id, title: r.snapshot.title ?? r.id, documents: (r.snapshot.knowledge?.documents ?? []).map((d: any) => ({ id: d.documentId, title: d.title, version: d.version })) })));
  });
  router.get('/automation/knowledge-candidates', async (_req, res) => res.json((await db.query('SELECT id,run_id AS "runId",document_id AS "documentId",source_version AS "sourceVersion",source_hash AS "sourceHash",space_id AS "spaceId",title,content,status,published_document_id AS "publishedDocumentId",reuse_evidence AS "reuseEvidence",version FROM automation_knowledge_candidates ORDER BY created_at DESC LIMIT 100')).rows));
  router.post('/automation/knowledge-candidates', async (req, res) => {
    const input = z.object({ runId: z.string().min(1), documentId: z.string().min(1) }).parse(req.body);
    const result = await transaction(db, async client => {
      const source = await authorizedSource(client, input.runId, input.documentId), id = randomUUID();
      const content = `# 待审查知识摘录\n\n来源：${source.title}（版本 ${source.version}）\n\n${source.content.slice(0, 12000)}${source.content.length > 12000 ? '\n\n[摘录已截断，请核对原文后整理。]' : ''}`;
      const row = (await client.query("INSERT INTO automation_knowledge_candidates(id,run_id,document_id,source_version,source_hash,space_id,title,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(document_id,source_hash) DO UPDATE SET document_id=EXCLUDED.document_id RETURNING id", [id, input.runId, input.documentId, source.version, source.sha256, source.space_id, ('经验整理：' + source.title).slice(0, 200), content])).rows[0];
      return row;
    });
    res.status(201).json(result);
  });
  router.put('/automation/knowledge-candidates/:id', async (req, res) => {
    const input = z.object({ title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(250000), version: z.number().int().positive() }).parse(req.body);
    const result = await db.query("UPDATE automation_knowledge_candidates SET title=$1,content=$2,version=version+1 WHERE id=$3 AND version=$4 AND status='pending'", [input.title, input.content, req.params.id, input.version]);
    if (!result.rowCount) throw new AppError(409, '候选已变化或已发布'); res.json({ ok: true });
  });
  router.post('/automation/knowledge-candidates/:id/publish', async (req, res) => {
    const input = z.object({ version: z.number().int().positive(), reviewed: z.literal(true) }).parse(req.body);
    const candidate = (await db.query('SELECT * FROM automation_knowledge_candidates WHERE id=$1', [req.params.id])).rows[0];
    if (!candidate) throw new AppError(404, '候选不存在');
    if (candidate.status === 'published') return res.json({ id: candidate.published_document_id });
    if (candidate.version !== input.version) throw new AppError(409, '候选已变化，请重新审查');
    await authorizedSource(db, candidate.run_id, candidate.document_id);
    if(candidate.reuse_evidence)await validateReuseEvidence(db,resolve(process.env.TRACE_ROOT??'.data/runs'),candidate.reuse_evidence);
    if (!options.publishKnowledge) throw new AppError(503, '知识发布服务未启用');
    // Stable document identity makes a retry after a lost response recover the same publication.
    const publicationId = candidate.id;
    const existing = (await db.query('SELECT d.id,d.space_id,r.content FROM knowledge_documents d JOIN knowledge_revisions r ON r.document_id=d.id AND r.version=d.version WHERE d.id=$1', [publicationId])).rows[0];
    if (existing && (existing.space_id !== candidate.space_id || hash(existing.content) !== hash(candidate.content))) throw new AppError(409, '已发布文档与当前候选不同，请核对知识库');
    if (!existing) {
      const claim = await db.query("UPDATE automation_knowledge_candidates SET status='publishing',publishing_at=now() WHERE id=$1 AND version=$2 AND (status='pending' OR (status='publishing' AND publishing_at<now()-interval '2 minutes')) RETURNING id", [candidate.id, input.version]);
      if (!claim.rowCount) throw new AppError(409, '候选正在发布或已变化，请稍后刷新；中断的发布可在两分钟后重试');
      try { await options.publishKnowledge({ spaceId: candidate.space_id, title: candidate.title, content: candidate.content, source: { runId: candidate.run_id, note: `人工审查的知识候选 ${candidate.id}；原文 ${candidate.document_id}:v${candidate.source_version} SHA256 ${candidate.source_hash}` } }, publicationId); }
      catch (error) { await db.query("UPDATE automation_knowledge_candidates SET status='pending',publishing_at=NULL WHERE id=$1 AND version=$2 AND status='publishing'", [candidate.id, input.version]); throw error; }
    }
    await db.query("UPDATE automation_knowledge_candidates SET status='published',published_document_id=$1,version=version+1 WHERE id=$2 AND status IN ('pending','publishing') AND version=$3", [publicationId, candidate.id, input.version]);
    res.json({ id: publicationId });
  });
  router.get('/automation/improvements', async (_req, res) => res.json((await db.query('SELECT id,title,source_run_id AS "sourceRunId",baseline,proposal,cases,status,version FROM automation_improvements ORDER BY created_at DESC LIMIT 100')).rows));
  router.post('/automation/improvements', async (req, res) => {
    const input = z.object({ title: z.string().trim().min(1).max(200), sourceRunId: z.string().optional(), baseline: z.string().trim().min(1).max(10000), proposal: z.string().trim().min(1).max(10000), cases: z.array(improvementCaseSchema).min(1).max(20) }).parse(req.body);
    if (new Set(input.cases.map(c => c.id)).size !== input.cases.length) throw new AppError(422, '案例 ID 不能重复');
    if (input.sourceRunId && !(await db.query('SELECT id FROM project_runs WHERE id=$1', [input.sourceRunId])).rowCount) throw new AppError(404, '来源运行不存在');
    const id = randomUUID(); await db.query('INSERT INTO automation_improvements(id,title,source_run_id,baseline,proposal,cases) VALUES($1,$2,$3,$4,$5,$6)', [id, input.title, input.sourceRunId ?? null, input.baseline, input.proposal, JSON.stringify(input.cases)]); res.status(201).json({ id });
  });
  router.get('/automation/improvements/:id/history', async (req, res) => { res.json({ evaluations: (await db.query('SELECT id,results,created_at AS "createdAt" FROM automation_evaluations WHERE improvement_id=$1 ORDER BY created_at DESC', [req.params.id])).rows, reviews: (await db.query('SELECT action,note,evaluation_id AS "evaluationId",created_at AS "createdAt" FROM automation_reviews WHERE improvement_id=$1 ORDER BY created_at DESC', [req.params.id])).rows }); });
  router.post('/automation/improvements/:id/evaluate', async (req, res) => {
    const input = z.object({ responses: z.array(z.object({ caseId: z.string(), before: z.string().max(50000), after: z.string().max(50000) })).min(1).max(20) }).parse(req.body);
    const candidate = (await db.query('SELECT cases FROM automation_improvements WHERE id=$1', [req.params.id])).rows[0]; if (!candidate) throw new AppError(404, '改进候选不存在');
    const result = evaluateImprovement(candidate.cases, input.responses), id = randomUUID();
    await db.query('INSERT INTO automation_evaluations(id,improvement_id,results) VALUES($1,$2,$3)', [id, req.params.id, result]); res.status(201).json({ id, ...result });
  });
  router.post('/automation/improvements/:id/review', async (req, res) => {
    const input = z.object({ action: z.enum(['adopt', 'reject', 'rollback']), note: z.string().trim().min(1).max(3000), evaluationId: z.string().optional(), version: z.number().int().positive() }).parse(req.body);
    await transaction(db, async client => {
      const candidate = (await client.query('SELECT * FROM automation_improvements WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!candidate || candidate.version !== input.version) throw new AppError(409, '改进候选已变化');
      if (input.action === 'rollback' && candidate.status !== 'adopted') throw new AppError(409, '只有已采纳候选能回滚');
      if (input.action !== 'rollback' && candidate.status === 'adopted') throw new AppError(409, '请先回滚已采纳候选');
      const evaluation = input.evaluationId ? (await client.query('SELECT results FROM automation_evaluations WHERE id=$1 AND improvement_id=$2', [input.evaluationId, req.params.id])).rows[0] : null;
      if (input.action === 'adopt' && (!evaluation || evaluation.results.afterScore < evaluation.results.beforeScore)) throw new AppError(422, '采纳需要关联本候选的评测，且规则分数不能下降');
      if (input.evaluationId && !evaluation) throw new AppError(422, '评测不属于当前候选');
      await client.query('UPDATE automation_improvements SET status=$1,version=version+1 WHERE id=$2', [{ adopt: 'adopted', reject: 'rejected', rollback: 'rolled_back' }[input.action], req.params.id]);
      await client.query('INSERT INTO automation_reviews(id,improvement_id,evaluation_id,action,note) VALUES($1,$2,$3,$4,$5)', [randomUUID(), req.params.id, input.evaluationId ?? null, input.action, input.note]);
    });
    res.json({ ok: true, changesEmployeePermissions: false, changesRuntimePrompt: false });
  });
  return router;
}
