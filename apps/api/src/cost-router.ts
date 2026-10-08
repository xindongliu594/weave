import { Router } from 'express';
import { z } from 'zod';
import { pool } from './db.ts';
import { dailyTotals,expireReservations,settleCall } from './cost-control.ts';
import { queryProviderForCall } from './provider-reconciliation.ts';

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
