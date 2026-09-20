import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';
import { AppError, complete } from './provider.ts';
import { agentSchema, departmentSchema, policySchema, type Model } from '../../../packages/contracts/index.ts';
import { departmentTemplates, roleTemplates } from '../../../packages/contracts/templates.ts';
export const settingsSchema=z.object({autoBudgetLimit:z.number().min(0).max(100),dailyBudgetLimit:z.number().positive().max(100000),maxActiveRuns:z.number().int().min(1).max(8),retentionDays:z.literal(0)});
export async function settings(){return (await pool.query('SELECT version,data FROM product_settings WHERE id=1')).rows[0];}
export function productRouter(){
  const router=Router();
  router.get('/settings',async(_req,res)=>res.json(await settings()));
  router.put('/settings',async(req,res)=>{const data=settingsSchema.parse(req.body.data);const r=await pool.query('UPDATE product_settings SET data=$1,version=version+1 WHERE id=1 AND version=$2',[data,z.number().int().positive().parse(req.body.version)]);if(!r.rowCount)throw new AppError(409,'设置已修改，请刷新');res.json({ok:true});});
  router.get('/templates',async(_req,res)=>{const saved=(await pool.query('SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY name')).rows;res.json({departments:[...departmentTemplates.map(t=>({...t,builtin:true})),...saved.filter(t=>t.kind==='department')],roles:[...roleTemplates.map(t=>({...t,builtin:true})),...saved.filter(t=>t.kind==='role').map(t=>({...t,...t.data}))]});});
  router.post('/templates',async(req,res)=>{const input=z.object({name:z.string().trim().min(1).max(100),kind:z.enum(['department','role']),data:z.unknown()}).parse(req.body);const data=input.kind==='department'?departmentSchema.parse(input.data):agentSchema.parse(input.data);const id=randomUUID();await pool.query('INSERT INTO templates(id,kind,name,data) VALUES($1,$2,$3,$4)',[id,input.kind,input.name,data]);res.status(201).json({id});});
  router.delete('/templates/:id',async(req,res)=>{const r=await pool.query('UPDATE templates SET deleted_at=now(),version=version+1 WHERE id=$1 AND version=$2',[req.params.id,z.number().int().positive().parse(req.body.version)]);if(!r.rowCount)throw new AppError(409,'模板不存在或已变更');res.json({ok:true});});
  router.get('/departments/archived',async(_req,res)=>res.json((await pool.query('SELECT id,data,version,deleted_at AS "deletedAt" FROM departments WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')).rows));
  router.post('/departments/:id/restore',async(req,res)=>{const r=await pool.query('UPDATE departments SET deleted_at=NULL,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NOT NULL',[req.params.id,z.number().int().positive().parse(req.body.version)]);if(!r.rowCount)throw new AppError(409,'归档版本已变化');res.json({ok:true});});
  router.get('/departments/:id/versions',async(req,res)=>res.json((await pool.query('SELECT version,data,created_at AS "createdAt" FROM department_versions WHERE department_id=$1 ORDER BY version DESC',[req.params.id])).rows));
  router.post('/organizations/preview',async(req,res)=>{
    const input=z.object({requirement:z.string().trim().min(10).max(50000),templateId:z.string(),modelId:z.string().default(''),policy:policySchema,generate:z.boolean().default(false),maxPlanningCost:z.number().positive().max(10).default(.1)}).parse(req.body);
    const template=departmentTemplates.find(t=>t.id===input.templateId)??(await pool.query("SELECT data FROM templates WHERE id=$1 AND kind='department' AND deleted_at IS NULL",[input.templateId])).rows[0];
    if(!template)throw new AppError(404,'部门模板不存在');
    let department=departmentSchema.parse({...template.data,agents:template.data.agents.slice(0,input.policy.maxAgents).map((a:any)=>({...a,modelId:input.modelId}))});
    if(input.generate){
      const rows=(await pool.query("SELECT id,data,version,status FROM models WHERE deleted_at IS NULL AND status='available'")).rows;
      const catalog:Model[]=rows.map(r=>({...r.data,id:r.id,version:r.version,status:r.status}));
      const model=catalog.find(m=>m.id===input.modelId);if(!model)throw new AppError(422,'请先选择可用的规划模型');
      const messages=[{role:'system',content:'根据需求生成部门和员工配置，只输出符合 JSON Schema 的对象。岗位职责是长期职能，不把当前项目目标写入岗位。只可使用给定模型，工具权限为空。'+JSON.stringify(z.toJSONSchema(departmentSchema))},{role:'user',content:JSON.stringify({requirement:input.requirement,policy:input.policy,template:department,models:catalog.map(m=>({id:m.id,name:m.name,inputRate:m.inputRate,outputRate:m.outputRate}))})}];
      const reserve=(Buffer.byteLength(JSON.stringify(messages))*model.inputRate+4000*model.outputRate)/1e6;
      if(reserve>input.maxPlanningCost||reserve>input.policy.maxBudget)throw new AppError(422,'规划预留超过预算');
      const response=await complete(model,messages,4000);
      if(response.usage)await pool.query('INSERT INTO usage(id,model_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),model.id,response.usage.prompt_tokens,response.usage.completion_tokens,(response.usage.prompt_tokens*model.inputRate+response.usage.completion_tokens*model.outputRate)/1e6,'部门组织规划']);
      else throw new AppError(502,'模型未返回用量，已停止规划');
      try{department=departmentSchema.parse(JSON.parse((response.choices[0].message.content??'').replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,'')));}catch{throw new AppError(422,'生成结果格式不正确，未创建部门');}
      if(department.agents.length>input.policy.maxAgents||department.agents.some(a=>a.tools.length||!catalog.some(m=>m.id===a.modelId)||(a.knowledgeSpaceIds??[]).length))throw new AppError(422,'生成结果超出人数、模型或权限约束');
    }
    res.json({department,requirement:input.requirement,policy:input.policy,source:input.generate?'model':'template'});
  });
  router.post('/organizations',async(req,res)=>{
    const input=z.object({department:departmentSchema,requirement:z.string().trim().min(10).max(50000),policy:policySchema}).parse(req.body);
    if(input.department.agents.length>input.policy.maxAgents)throw new AppError(422,'员工数超过上限');
    const dId=randomUUID(),pId=randomUUID();
    const plan={rationale:'根据需求创建组织后的待审方案。',agents:input.department.agents,tasks:[{id:'deliver',subject:'完成需求并提交验收材料',objective:input.requirement,assigneeId:input.department.agents.find(a=>a.role==='manager')!.id,dependencies:[],acceptanceCriteria:['覆盖需求，提供可核验的结果和来源'],estimatedInputTokens:10000,estimatedOutputTokens:4000}]};
    const client=await pool.connect();try{await client.query('BEGIN');await client.query('INSERT INTO departments(id,data) VALUES($1,$2)',[dId,input.department]);await client.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[pId,dId,input.department.name,input.requirement,input.policy,plan,'manual']);await client.query('INSERT INTO plan_versions(project_id,version,plan) VALUES($1,1,$2)',[pId,plan]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}res.status(201).json({departmentId:dId,projectId:pId});
  });
  return router;
}
