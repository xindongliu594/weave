import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { pool } from './db.ts';
export const idempotency:RequestHandler=async(req,res,next)=>{
 if(['GET','HEAD'].includes(req.method)||!req.get('Idempotency-Key'))return next();
 // Backup payloads and passphrases must never enter a response cache.
 if(req.path.startsWith('/backup/'))return next();
 const key=req.get('Idempotency-Key')!;if(!/^[A-Za-z0-9_-]{8,100}$/.test(key))return res.status(422).json({message:'Idempotency-Key 格式不正确'});
 const fingerprint=createHash('sha256').update(req.method+' '+req.originalUrl+' '+JSON.stringify(req.body)).digest('hex');
 const inserted=await pool.query('INSERT INTO request_keys(key,fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING',[key,fingerprint]);
 if(!inserted.rowCount){const saved=(await pool.query('SELECT * FROM request_keys WHERE key=$1',[key])).rows[0];if(saved.fingerprint!==fingerprint)return res.status(409).json({message:'此请求编号已用于不同内容'});if(saved.status)return res.status(saved.status).json(saved.response);return res.status(409).json({message:'该请求正在处理或结果尚未确认，请刷新后查看，勿自动重复提交'});}
 const json=res.json.bind(res);let captured=false;
 res.json=(body:any)=>{if(captured)return json(body);captured=true;const status=res.statusCode;void pool.query('UPDATE request_keys SET status=$1,response=$2 WHERE key=$3',[status,JSON.stringify(body),key]).then(()=>json(body)).catch(()=>res.status(503).send('请求结果暂未确认，请刷新查看'));return res;};
 next();
};
