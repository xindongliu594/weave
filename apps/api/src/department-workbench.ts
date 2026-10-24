import { Router } from 'express';
import { z } from 'zod';
import { AppError } from './provider.ts';
import {httpPrincipal,administrative,visibleProjectsQuery} from './project-route-access.ts';
import {visibleResourceQuery} from './resource-authorization.ts';
import type {Principal} from './identity-types.ts';

type Database = { query: (sql: string, parameters?: any[]) => Promise<{ rows: any[] }> };
export const departmentWorkbenchQuery = z.object({
  departmentId: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict();

/** A bounded read model. It never opens trace archives, expires reservations,
 * resumes work, or infers relationships from display titles. */
export async function readDepartmentWorkbench(db: Database, query: z.infer<typeof departmentWorkbenchQuery>,principal:Principal={kind:'local-owner'}) {
  const { departmentId, limit, offset } = query;
  const projects=visibleProjectsQuery(principal,'viewer',3),costs=visibleResourceQuery(principal,'cost','viewer',{parameterOffset:3+projects.values.length});
  const result = await db.query(`
    WITH scoped AS (
      SELECT p.id,p.requirement,p.version,p.status,p.created_at
      FROM projects p JOIN departments d ON d.id=p.department_id
      WHERE p.department_id=$1 AND d.deleted_at IS NULL AND p.id IN (${projects.text})
    ), enriched AS (
      SELECT p.*, latest.run, done.run AS completed_run,
        coalesce(latest.pending,0) AS pending,
        CASE WHEN coalesce(latest.pending,0)>0 THEN 'attention'
          WHEN p.status IN ('QUEUED','RUNNING') THEN 'running'
          WHEN p.status='DRAFT' THEN 'backlog'
          WHEN p.status='COMPLETED' AND latest.run->>'status'='completed' THEN 'completed'
          ELSE 'attention' END AS bucket
      FROM scoped p
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object('id',r.id,'status',r.status,'projectVersion',r.project_version,
          'createdAt',r.created_at,'finishedAt',r.finished_at,'error',left(r.error,600),
          'pendingApprovalCount',a.pending) AS run, a.pending
        FROM project_runs r
        CROSS JOIN LATERAL (SELECT count(*)::int AS pending FROM tool_approvals a
          WHERE a.run_id=r.id AND a.status='pending' AND r.status='running' AND NOT r.cancel_requested) a
        WHERE r.project_id=p.id AND r.project_version=p.version
        ORDER BY r.created_at DESC,r.id DESC LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object('id',r.id,'status',r.status,'projectVersion',r.project_version,
          'createdAt',r.created_at,'finishedAt',r.finished_at) AS run
        FROM project_runs r WHERE r.project_id=p.id AND r.status='completed'
        ORDER BY coalesce(r.finished_at,r.created_at) DESC,r.id DESC LIMIT 1
      ) done ON true
    )
    SELECT EXISTS(SELECT 1 FROM departments WHERE id=$1 AND deleted_at IS NULL) AS exists,
      jsonb_build_object('total',count(*),'backlog',count(*) FILTER(WHERE bucket='backlog'),
        'running',count(*) FILTER(WHERE bucket='running'),'attention',count(*) FILTER(WHERE bucket='attention'),
        'completed',count(*) FILTER(WHERE completed_run IS NOT NULL),
        'pendingApprovals',coalesce(sum(pending),0),
        'recordedCost',coalesce((SELECT sum(cost) FROM usage WHERE department_id=$1 ${administrative(principal)?'':`AND project_id IN (SELECT id FROM scoped) AND id IN (${costs.text})`}),0)) AS summary,
      coalesce((SELECT jsonb_agg(page.item ORDER BY page.created_at DESC,page.id DESC) FROM (
        SELECT id,created_at,jsonb_build_object('id',id,'requirement',left(requirement,700),'version',version,
          'status',status,'createdAt',created_at,'bucket',bucket,'latestRun',run,'completedRun',completed_run) AS item
        FROM enriched ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3
      ) page),'[]'::jsonb) AS items
    FROM enriched`, [departmentId, limit, offset,...projects.values,...(administrative(principal)?[]:costs.values)]);
  const row = result.rows[0];
  if (!row?.exists) throw new AppError(404, '部门不存在或已归档，请选择其他部门。');
  return { departmentId, summary: row.summary, items: row.items, limit, offset,
    hasMore: offset + row.items.length < row.summary.total, refreshedAt: new Date().toISOString() };
}

export function departmentWorkbenchRouter(db: Database) {
  const router = Router();
  router.get('/department-workbench', async (req, res) => {
    res.json(await readDepartmentWorkbench(db, departmentWorkbenchQuery.parse(req.query),httpPrincipal(res)));
  });
  return router;
}
