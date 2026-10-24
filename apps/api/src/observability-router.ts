import {Router} from 'express';
import type pg from 'pg';
import {queryAuditEvents} from './audit-query.ts';
import {AppError} from './provider.ts';

export function observabilityRouter(pool:pg.Pool,options:{now?:()=>Date}={}) {
 const router=Router();
 router.get('/audit/events',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try {res.json(await queryAuditEvents(pool,res.locals.principal??null,req.query,options.now?.()??new Date()));}
  catch(error){
   if(error instanceof AppError&&[401,403,404,422].includes(error.status))res.status(error.status).json({code:error.code,message:error.message});
   else res.status(503).json({code:'AUDIT_QUERY_UNAVAILABLE',message:'暂时无法确认审计查询结果，请稍后手动刷新。'});
  }
 });
 return router;
}
