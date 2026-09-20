import { Router } from 'express';
import { z } from 'zod';
import { pool } from './db.ts';
import { dailyTotals,expireReservations,settleCall } from './cost-control.ts';
export function costRouter(){
 const router=Router();
 router.get('/costs',async(_req,res)=>{
  await expireReservations();
  const columns=`c.id,c.model_id AS "modelId",m.data->>'name' AS "modelName",c.project_id AS "projectId",c.department_id AS "departmentId",c.run_id AS "runId",c.purpose,c.amount::float8 AS amount,c.input_rate::float8 AS "inputRate",c.output_rate::float8 AS "outputRate",c.status,c.history,c.created_at AS "createdAt"`;
  const calls=(await pool.query(`SELECT ${columns} FROM model_reservations c JOIN models m ON m.id=c.model_id WHERE c.status IN ('pending','uncertain') ORDER BY c.created_at`)).rows;
  const recent=(await pool.query(`SELECT ${columns} FROM model_reservations c JOIN models m ON m.id=c.model_id WHERE c.status IN ('settled','released') ORDER BY c.created_at DESC LIMIT 20`)).rows;
  const departments=[];for(const d of (await pool.query('SELECT id,data FROM departments WHERE deleted_at IS NULL ORDER BY id')).rows)departments.push({id:d.id,name:d.data.name,limit:d.data.dailyBudget??null,...await dailyTotals(pool,d.id)});
  res.json({timezone:'UTC',...await dailyTotals(pool),calls,recent,departments});
 });
 router.post('/costs/:id/reconcile',async(req,res)=>{
  const input=z.object({inputTokens:z.number().int().min(0).max(2147483647),outputTokens:z.number().int().min(0).max(2147483647),note:z.string().trim().min(5).max(1000),confirmation:z.literal('RECONCILE')}).parse(req.body);
  const result=await settleCall(z.uuid().parse(req.params.id),input.inputTokens,input.outputTokens,{},input.note);res.json(result);
 });
 return router;
}
