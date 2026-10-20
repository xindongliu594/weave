import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { pool } from './db.ts';
import {principalKey,type Principal} from './identity-types.ts';
export const idempotency:RequestHandler=async(req,res,next)=>{
 const principal=res.locals.principal as Principal|undefined;
 if(!principal)return res.status(403).json({error:'Access denied'});
 const owner=principalKey(principal);
 if(['GET','HEAD'].includes(req.method)||!req.get('Idempotency-Key'))return next();
 // Planning quotes inspect a read-only snapshot, including long JSON bodies.
 // They never reserve/dispatch or need a cached mutation result.
 if(req.method==='POST'&&/^\/projects\/[^/]+\/planning-quote\/?$/.test(req.path))return next();
 // Original-stop observations always recheck current authority and the original intent.
 if(req.method==='POST'&&/^\/runs\/[^/]+\/task-stops\/reconcile\/?$/.test(req.path))return next();
 // Backup payloads and passphrases must never enter a response cache.
 if(req.path.startsWith('/backup/'))return next();
 // Device claims and receipts use their durable operation IDs, never a cached claim response.
 if(req.path.startsWith('/local-devices/'))return next();
 // Storage actions have durable preview/cleanup IDs and reconcile their current state.
 if(req.path.startsWith('/storage/'))return next();
 const key=req.get('Idempotency-Key')!;if(!/^[A-Za-z0-9_-]{8,100}$/.test(key))return res.status(422).json({message:'Idempotency-Key 格式不正确'});
 const fingerprint=createHash('sha256').update(req.method+' '+req.originalUrl+' '+JSON.stringify(req.body)).digest('hex');
 const inserted=await pool.query('INSERT INTO request_keys(principal_key,key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[owner,key,fingerprint]);
 if(!inserted.rowCount){const saved=(await pool.query('SELECT * FROM request_keys WHERE principal_key=$1 AND key=$2',[owner,key])).rows[0];if(saved.fingerprint!==fingerprint)return res.status(409).json({message:'此请求编号已用于不同内容'});if(saved.status)return res.status(saved.status).json(saved.response);return res.status(409).json({message:'该请求正在处理或结果尚未确认，请刷新后查看，勿自动重复提交'});}
 const json=res.json.bind(res);let captured=false;
 res.json=(body:any)=>{if(captured)return json(body);captured=true;const status=res.statusCode;void pool.query('UPDATE request_keys SET status=$1,response=$2 WHERE principal_key=$3 AND key=$4',[status,JSON.stringify(body),owner,key]).then(()=>json(body)).catch(()=>res.status(503).send('请求结果暂未确认，请刷新查看'));return res;};
 next();
};
