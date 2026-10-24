import { Router } from 'express';
import { z } from 'zod';
import { pool } from './db.ts';
import { dailyTotals,expireReservations,settleCall } from './cost-control.ts';
import { queryProviderForCall } from './provider-reconciliation.ts';
import {httpPrincipal,administrative,currentRoutePrincipal} from './project-route-access.ts';
import {visibleResourceQuery,visibleSourceQuery} from './resource-authorization.ts';
import type {Principal} from './identity-types.ts';

async function memberCosts(principal:Principal){
 const departments=visibleResourceQuery(principal,'department','viewer'),costs=visibleResourceQuery(principal,'cost','viewer',{parameterOffset:departments.values.length}),runs=visibleSourceQuery(principal,'run','viewer',{parameterOffset:departments.values.length+costs.values.length});
 const rows=(await pool.query(`WITH visible_departments AS (${departments.text}), visible_costs AS (${costs.text}), visible_runs AS (${runs.text}),
  scoped_usage AS (SELECT u.* FROM usage u JOIN visible_costs c ON c.id=u.id JOIN visible_runs r ON r.id=u.run_id
    WHERE u.project_id IS NOT NULL AND u.department_id IS NOT NULL),
  scoped_calls AS (SELECT c.* FROM model_reservations c JOIN visible_costs v ON v.id=c.id JOIN visible_runs r ON r.id=c.run_id
    WHERE c.project_id IS NOT NULL AND c.department_id IS NOT NULL),
  spent AS (SELECT u.department_id,sum(u.cost) amount FROM scoped_usage u
    WHERE u.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND NOT EXISTS(SELECT 1 FROM model_reservations conversation WHERE conversation.id=u.id AND conversation.context->>'accountingMode'='conversation') GROUP BY u.department_id),
  run_spent AS (SELECT run_id,department_id,sum(cost) amount FROM scoped_usage GROUP BY run_id,department_id),
  open_calls AS (SELECT run_id,department_id,sum(amount) amount FROM scoped_calls WHERE status IN ('pending','uncertain') GROUP BY run_id,department_id),
  live_holds AS (SELECT department.id,sum(GREATEST(0,
    COALESCE(CASE WHEN jsonb_typeof(r.snapshot->'departmentBudgets'->department.id)='number' THEN (r.snapshot->'departmentBudgets'->>department.id)::numeric END,
      CASE WHEN r.snapshot->>'departmentId'=department.id AND jsonb_typeof(r.snapshot->'executionBudget')='number' THEN (r.snapshot->>'executionBudget')::numeric ELSE 0 END)-COALESCE(s.amount,0),COALESCE(c.amount,0))) amount
    FROM project_runs r JOIN visible_runs visible ON visible.id=r.id CROSS JOIN LATERAL unnest(r.department_ids) department(id)
    LEFT JOIN run_spent s ON s.run_id=r.id AND s.department_id=department.id LEFT JOIN open_calls c ON c.run_id=r.id AND c.department_id=department.id
    WHERE r.status IN ('queued','running') GROUP BY department.id),
  other_holds AS (SELECT c.department_id,sum(c.amount) amount FROM open_calls c
    WHERE NOT EXISTS(SELECT 1 FROM project_runs r WHERE r.id=c.run_id AND r.status IN ('queued','running')) GROUP BY c.department_id)
  SELECT d.id,COALESCE(s.amount,0)::float8 spent,(COALESCE(l.amount,0)+COALESCE(o.amount,0))::float8 retained,d.data->'dailyBudget' AS "limit"
    FROM departments d JOIN visible_departments visible ON visible.id=d.id LEFT JOIN spent s ON s.department_id=d.id
    LEFT JOIN live_holds l ON l.id=d.id LEFT JOIN other_holds o ON o.department_id=d.id ORDER BY d.id`,[...departments.values,...costs.values,...runs.values])).rows;
 return {timezone:'UTC',departments:rows};
}

function providerResponseDetails(row:Record<string,unknown>){
 const {providerRequestId,upstreamRequestId,responseRequestId,providerStatus,...call}=row;
 const details:Record<string,unknown>={};
 // Only response metadata persisted by recordProviderResponse is public; context
 // also contains the pinned billing route and must never be returned wholesale.
 for(const [key,value] of Object.entries({providerRequestId,upstreamRequestId,responseRequestId})){
  if(typeof value==='string'&&/^[A-Za-z0-9._:/-]{1,128}$/.test(value)&&!/^sk-/i.test(value))details[key]=value;
 }
 if(typeof providerStatus==='number'&&Number.isInteger(providerStatus)&&providerStatus>=100&&providerStatus<=599)details.providerStatus=providerStatus;
 return {...call,...details};
}

export function costRouter(){
 const router=Router();
 router.get('/costs',async(_req,res)=>{
  const principal=httpPrincipal(res);await currentRoutePrincipal(pool,principal);
  if(!administrative(principal)){res.json(await memberCosts(principal));return;}
  await expireReservations();
  const columns=`c.id,c.model_id AS "modelId",m.data->>'name' AS "modelName",c.project_id AS "projectId",c.department_id AS "departmentId",c.run_id AS "runId",c.purpose,c.amount::float8 AS amount,CASE WHEN c.context->>'accountingMode'='conversation' THEN 'conversation' ELSE 'budgeted' END AS "accountingMode",c.input_rate::float8 AS "inputRate",c.output_rate::float8 AS "outputRate",c.status,c.history,c.context->'providerReconciliation' AS "providerReconciliation",c.context->'providerRequestId' AS "providerRequestId",c.context->'upstreamRequestId' AS "upstreamRequestId",c.context->'responseRequestId' AS "responseRequestId",c.context->'providerStatus' AS "providerStatus",c.created_at AS "createdAt"`;
  const calls=(await pool.query(`SELECT ${columns} FROM model_reservations c JOIN models m ON m.id=c.model_id WHERE c.status IN ('pending','uncertain') ORDER BY c.created_at`)).rows.map(providerResponseDetails);
  const recent=(await pool.query(`SELECT ${columns} FROM model_reservations c JOIN models m ON m.id=c.model_id WHERE c.status IN ('settled','released') ORDER BY c.created_at DESC LIMIT 20`)).rows.map(providerResponseDetails);
  const departments=[];for(const d of (await pool.query('SELECT id,data FROM departments WHERE deleted_at IS NULL ORDER BY id')).rows)departments.push({id:d.id,name:d.data.name,limit:d.data.dailyBudget??null,...await dailyTotals(pool,d.id)});
  const totals=await dailyTotals(pool);
  const conversationSpent=Number((await pool.query(`SELECT COALESCE(sum(u.cost),0) AS n FROM usage u JOIN model_reservations c ON c.id=u.id
   WHERE u.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND c.context->>'accountingMode'='conversation'`)).rows[0].n);
  res.json({timezone:'UTC',...totals,conversationSpent,recordedSpent:totals.spent+conversationSpent,calls,recent,departments});
 });
 router.post('/costs/:id/query-provider',async(req,res)=>{
  res.json(await queryProviderForCall(z.uuid().parse(req.params.id)));
 });
 router.post('/costs/:id/reconcile',async(req,res)=>{
  const input=z.object({inputTokens:z.number().int().min(0).max(2147483647),outputTokens:z.number().int().min(0).max(2147483647),note:z.string().trim().min(5).max(1000),confirmation:z.literal('RECONCILE')}).parse(req.body);
  const result=await settleCall(z.uuid().parse(req.params.id),input.inputTokens,input.outputTokens,{},input.note);res.json(result);
 });
 return router;
}
