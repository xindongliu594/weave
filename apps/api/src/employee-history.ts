import {Router} from 'express';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {pool} from './db.ts';
import {AppError} from './provider.ts';
import {departmentSchema,agentSchema} from '../../../packages/contracts/index.ts';
export function employeeHistoryRouter(){
 const router=Router();
 router.get('/departments/:id/removed-employees',async(req,res)=>{
  const department=(await pool.query('SELECT data,version,deleted_at FROM departments WHERE id=$1',[req.params.id])).rows[0];
  if(!department)throw new AppError(404,'部门不存在');if(department.deleted_at)throw new AppError(409,'请先恢复部门');
  const versions=(await pool.query(`SELECT DISTINCT ON (agent->>'id') agent,version AS "sourceVersion" FROM department_versions,
    LATERAL jsonb_array_elements(data->'agents') agent WHERE department_id=$1 ORDER BY agent->>'id',version DESC`,[req.params.id])).rows;
  res.json({departmentVersion:department.version,employees:versions.filter(v=>!department.data.agents.some((a:any)=>a.id===v.agent.id))});
 });
 router.post('/departments/:id/restore-employee',async(req,res)=>{
  const input=z.object({agentId:z.string().min(1).max(80),sourceVersion:z.number().int().positive(),departmentVersion:z.number().int().positive(),role:z.enum(['member','manager'])}).parse(req.body);
  const client=await pool.connect();
  try{await client.query('BEGIN');
   const current=(await client.query('SELECT * FROM departments WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
   if(!current)throw new AppError(404,'部门不存在');if(current.deleted_at)throw new AppError(409,'请先恢复部门');
   if(current.version!==input.departmentVersion)throw new AppError(409,'部门已修改，请重新查看待恢复员工','VERSION_CONFLICT');
   if(current.data.agents.some((a:any)=>a.id===input.agentId))throw new AppError(409,'此员工已在部门中，不能重复恢复');
   if(current.data.agents.length>=6)throw new AppError(422,'部门已有六位员工，请先调整人员再恢复');
   const source=(await client.query('SELECT data FROM department_versions WHERE department_id=$1 AND version=$2',[req.params.id,input.sourceVersion])).rows[0];
   const saved=source?.data.agents.find((a:any)=>a.id===input.agentId);if(!saved)throw new AppError(404,'所选历史版本没有该员工');
   const previous=(await client.query(`SELECT COALESCE(max((agent->>'roleVersion')::int),1) AS version FROM department_versions,
     LATERAL jsonb_array_elements(data->'agents') agent WHERE department_id=$1 AND agent->>'id'=$2`,[req.params.id,input.agentId])).rows[0].version;
   const restored=agentSchema.parse({...saved,role:input.role,roleVersion:Number(previous)+1});
   const agents=current.data.agents.map((a:any)=>input.role==='manager'&&a.role==='manager'?{...a,role:'member',roleVersion:(a.roleVersion??1)+1}:a);
   const data=departmentSchema.parse({...current.data,agents:[...agents,restored]});
   const result=(await client.query('UPDATE departments SET data=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING version',[data,req.params.id])).rows[0];
   await client.query('INSERT INTO activity(id,kind,title) VALUES($1,$2,$3)',[randomUUID(),'employee_restore',`从部门配置 v${input.sourceVersion} 恢复「${restored.name}」，生成配置 v${result.version}`]);
   await client.query('COMMIT');res.json({ok:true,version:result.version,agent:restored});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });
 return router;
}
