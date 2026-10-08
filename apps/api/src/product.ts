import {bindPolicy,assertPolicy,assertPlanningModel} from './execution-policy.ts';
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pool } from './db.ts';
import type pg from 'pg';
import { AppError } from './provider.ts';
import { agentSchema, departmentSchema, policySchema, planSchema, validatePlan, type Model } from '../../../packages/contracts/index.ts';
import { organizationCandidateSchema, templatePlan } from '../../../packages/contracts/organization.ts';
import { completeBudgeted,lockCostPolicy,checkDailyBudget,shareCostMaintenance,requireProjectCostReady } from './cost-control.ts';
import { departmentTemplates, roleTemplates } from '../../../packages/contracts/templates.ts';
import { organizationChatRouter } from './organization-chat.ts';
export const settingsSchema=z.object({autoBudgetLimit:z.number().min(0).max(100),dailyBudgetLimit:z.number().positive().max(100000),maxActiveRuns:z.number().int().min(1).max(8),retentionDays:z.literal(0),knowledgeSearchMode:z.enum(['keyword','hybrid']).optional()});
export async function settings(client:pg.Pool|pg.PoolClient=pool){return (await client.query('SELECT version,data FROM product_settings WHERE id=1')).rows[0];}
// Role versions are server-managed metadata, not a different user-approved proposal.
function withoutRoleVersions<T extends {agents:any[]}>(value:T){return {...value,agents:value.agents.map(({roleVersion,...agent}:any)=>agent)};}
export function productRouter(){
  const router=Router();
  router.use(organizationChatRouter());
  router.get('/settings',async(_req,res)=>res.json(await settings()));
  router.put('/settings',async(req,res)=>{const data=settingsSchema.parse(req.body.data);const r=await pool.query('UPDATE product_settings SET data=$1,version=version+1 WHERE id=1 AND version=$2',[data,z.number().int().positive().parse(req.body.version)]);if(!r.rowCount)throw new AppError(409,'设置已修改，请刷新');res.json({ok:true});});
  router.get('/templates',async(_req,res)=>{const saved=(await pool.query('SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY name')).rows;res.json({departments:[...departmentTemplates.map(t=>({...t,builtin:true})),...saved.filter(t=>t.kind==='department')],roles:[...roleTemplates.map(t=>({...t,builtin:true})),...saved.filter(t=>t.kind==='role').map(t=>({...t,...t.data}))]});});
  router.post('/templates',async(req,res)=>{const input=z.object({name:z.string().trim().min(1).max(100),kind:z.enum(['department','role']),data:z.unknown()}).parse(req.body);const data=input.kind==='department'?departmentSchema.parse(input.data):agentSchema.parse(input.data);const id=randomUUID();await pool.query('INSERT INTO templates(id,kind,name,data) VALUES($1,$2,$3,$4)',[id,input.kind,input.name,data]);res.status(201).json({id});});
  router.delete('/templates/:id',async(req,res)=>{const r=await pool.query('UPDATE templates SET deleted_at=now(),version=version+1 WHERE id=$1 AND version=$2',[req.params.id,z.number().int().positive().parse(req.body.version)]);if(!r.rowCount)throw new AppError(409,'模板不存在或已变更');res.json({ok:true});});
  router.get('/departments/archived',async(_req,res)=>res.json((await pool.query('SELECT id,data,version,deleted_at AS "deletedAt" FROM departments WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')).rows));
  router.post('/departments/:id/restore',async(req,res)=>{const r=await pool.query('UPDATE departments SET deleted_at=NULL,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NOT NULL',[req.params.id,z.number().int().positive().parse(req.body.version)]);if(!r.rowCount)throw new AppError(409,'归档版本已变化');res.json({ok:true});});
  router.get('/departments/:id/versions',async(req,res)=>res.json((await pool.query('SELECT version,data,created_at AS "createdAt" FROM department_versions WHERE department_id=$1 ORDER BY version DESC',[req.params.id])).rows));
  router.post('/organizations/preview',async(req,res)=>{
    const input=z.object({requirement:z.string().trim().min(10).max(50000),templateId:z.string(),modelId:z.string().default(''),policy:policySchema,generate:z.boolean().default(false),maxPlanningCost:z.number().positive().max(10).optional()}).parse(req.body);
    const template=departmentTemplates.find(t=>t.id===input.templateId)??(await pool.query("SELECT data FROM templates WHERE id=$1 AND kind='department' AND deleted_at IS NULL",[input.templateId])).rows[0];
    if(!template)throw new AppError(404,'部门模板不存在');
    let planningUsageId:string|undefined;
    let department=departmentSchema.parse({...template.data,agents:template.data.agents.slice(0,input.policy.maxAgents).map((a:any)=>({...a,modelId:input.modelId}))});
    input.policy=bindPolicy(input.policy,department.agents);
    let plan=templatePlan(department,input.requirement);
    const rows=(await pool.query("SELECT id,data,version,status,capabilities FROM models WHERE deleted_at IS NULL")).rows;
    const catalog:Model[]=rows.map(r=>({...r.data,id:r.id,version:r.version,status:r.status,capabilities:r.capabilities}));
    if(input.generate){
      assertPlanningModel(input.modelId,input.policy);
      const model=catalog.find(m=>m.id===input.modelId&&m.status==='available');if(!model)throw new AppError(422,'请先选择可用的规划模型');
      const messages=[{role:'system',content:'根据需求生成完整的部门、岗位配置与任务依赖 DAG，只输出符合 JSON Schema 的对象。岗位职责是长期职能，不把当前项目目标写入岗位。任务必须有负责人、具体目标、依赖和验收标准，最后由经理验收。涉及文件交接时，必须显式声明 inputs 和 outputs，输入绑定 producerTaskId 并将来源列入前置依赖；固定文件必须声明 SHA256。输出可声明 JSON 必需字段和预期值。只有拥有工作区读取权限的员工能消费文件，产出者需要写入权限。实现/修复使用相应 kind、inScope 和 verify；验证命令必须真实执行。独立审查使用 review，绑定 reviewedTaskId，并由另一位员工承担。普通研究、诊断或文本任务可使用 work。不得捏造已验收文件版本。小任务可只有经理。只可使用给定模型，工具和知识权限为空。'+JSON.stringify(z.toJSONSchema(organizationCandidateSchema))},{role:'user',content:JSON.stringify({requirement:input.requirement,policy:input.policy,template:department,models:catalog.filter(m=>m.status==='available'&&input.policy.allowedModelIds!.includes(m.id)).map(m=>({id:m.id,name:m.name,inputRate:m.inputRate,outputRate:m.outputRate}))})}];
      const response=await completeBudgeted(model,messages,4000,{purpose:'部门组织规划',maxCost:Math.min(input.policy.maxBudget,input.maxPlanningCost??input.policy.maxBudget*.1)});
      planningUsageId=response.usageId;
      try{const candidate=organizationCandidateSchema.parse(JSON.parse((response.choices[0].message.content??'').replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,'')));department=candidate.department;plan={agents:department.agents,rationale:candidate.rationale,tasks:candidate.tasks};}catch{throw new AppError(422,'生成结果格式不正确，未创建部门');}
      if(department.agents.length>input.policy.maxAgents||department.agents.some(a=>a.tools.length||!catalog.some(m=>m.id===a.modelId)||(a.knowledgeSpaceIds??[]).length))throw new AppError(422,'生成结果超出人数、模型或权限约束');
      const validation=validatePlan(plan,input.policy,catalog,false);if(!validation.valid)throw new AppError(422,'生成方案校验失败：'+validation.errors.join('；'));
    }
    const previewId=randomUUID(),source=input.generate?'model':'template',draft={department,plan,requirement:input.requirement,policy:input.policy,source};
    await pool.query('INSERT INTO organization_previews(id,data) VALUES($1,$2)',[previewId,draft]);
    if(planningUsageId)await pool.query('UPDATE usage SET planning_preview_id=$1 WHERE id=$2',[previewId,planningUsageId]);
    res.json({...draft,previewId,validation:validatePlan(plan,input.policy,catalog,false)});
  });
  router.post('/organizations',async(req,res)=>{
    const input=z.object({department:departmentSchema,requirement:z.string().trim().min(10).max(50000),policy:policySchema,plan:planSchema.optional(),previewId:z.uuid().optional(),target:z.object({departmentId:z.uuid(),projectId:z.uuid(),departmentVersion:z.number().int().positive(),projectVersion:z.number().int().positive()}).strict().optional()}).parse(req.body);
    if(input.target&&!input.previewId)throw new AppError(422,'更新团队前请先生成待确认方案');
    if(input.department.agents.length>input.policy.maxAgents)throw new AppError(422,'员工数超过上限');
    let dId=input.target?.departmentId??randomUUID(),pId=input.target?.projectId??randomUUID(),departmentVersion=1,projectVersion=1;
    const plan=input.plan??templatePlan(input.department,input.requirement);
    if(JSON.stringify(plan.agents)!==JSON.stringify(input.department.agents))throw new AppError(422,'方案员工必须与待创建部门的员工配置一致');
    const client=await pool.connect();try{await client.query('BEGIN');await shareCostMaintenance(client);
      const preview=input.previewId?(await client.query('SELECT * FROM organization_previews WHERE id=$1 FOR UPDATE',[input.previewId])).rows[0]:null;
      if(input.previewId&&!preview)throw new AppError(404,'组织预览不存在');
      if(preview?.data.kind==='project-plan')throw new AppError(409,'这是项目方案候选，请在原项目中确认','PLANNING_PREVIEW_MISMATCH');
      dId=preview?.department_id??dId;
      input.policy=bindPolicy(input.policy,input.department.agents,dId);assertPolicy(plan.agents,input.policy);
      if(preview?.project_id){
        const saved=(await client.query('SELECT p.version AS project_version,d.version AS department_version,p.plan,p.policy,p.requirement,d.data FROM projects p JOIN departments d ON d.id=p.department_id WHERE p.id=$1 AND d.deleted_at IS NULL',[preview.project_id])).rows[0];
        if(!saved||!isDeepStrictEqual(withoutRoleVersions(saved.plan),withoutRoleVersions(plan))||!isDeepStrictEqual(saved.policy,input.policy)||saved.requirement!==input.requirement||!isDeepStrictEqual(withoutRoleVersions(saved.data),withoutRoleVersions(input.department)))throw new AppError(409,'此预览已保存且之后发生了变更，请查看现有团队后再修改');
        if(input.target&&(input.target.departmentId!==preview.department_id||input.target.projectId!==preview.project_id))throw new AppError(409,'此预览已保存到其他团队');
        await client.query('COMMIT');return res.json({departmentId:preview.department_id,projectId:preview.project_id,departmentVersion:saved.department_version,projectVersion:saved.project_version,existing:true});
      }
      let currentProject:any,currentDepartment:any,costConfig:any;
      if(input.target){
        currentProject=(await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[pId])).rows[0];
        await requireProjectCostReady(client,pId);
        // Match model admission lock ordering: project, global cost policy, then department.
        costConfig=await lockCostPolicy(client);
        currentDepartment=(await client.query('SELECT * FROM departments WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[dId])).rows[0];
        if(!currentProject||!currentDepartment||currentProject.department_id!==dId)throw new AppError(404,'原团队或项目不存在，请查看部门与员工');
        if(currentProject.version!==input.target.projectVersion||currentDepartment.version!==input.target.departmentVersion)throw new AppError(409,'团队或项目已在其他页面修改，请查看最新方案后再调整','VERSION_CONFLICT');
        if(currentProject.status!=='DRAFT'||(await client.query("SELECT id FROM project_runs WHERE project_id=$1 AND status IN ('queued','running')",[pId])).rowCount)throw new AppError(409,'该项目已进入执行流程。请在项目页管理后续修改，或开始新需求','PROJECT_ACTIVE');
        if((await client.query("SELECT r.id FROM project_runs r JOIN projects p ON p.id=r.project_id WHERE r.status IN ('queued','running') AND ($1=ANY(r.department_ids) OR p.department_id=$1 OR r.snapshot->'departmentIds' ? $1) LIMIT 1",[dId])).rowCount)throw new AppError(409,'该团队正在参与其他项目，请等待执行结束后再更新员工配置','DEPARTMENT_ACTIVE');
        if(input.department.agents.some(agent=>agent.sourceDepartmentId||agent.sourceAgentId))throw new AppError(422,'对话更新不支持更改跨部门员工身份');
        input.department.agents=input.department.agents.map(agent=>{const old=currentDepartment.data.agents.find((item:any)=>item.id===agent.id);const changed=!old||['instructions','systemConstraints','outputFormat','title','role'].some(key=>(old[key]??'')!==((agent as any)[key]??''));return {...agent,roleVersion:old?(old.roleVersion??1)+(changed?1:0):1};});
        plan.agents=input.department.agents;
        departmentVersion=currentDepartment.version+1;projectVersion=currentProject.version+1;
      }
      const conversationCost=preview?.data.costAccounting==='conversation';
      const planningCost=input.previewId&&!conversationCost?Number((await client.query('SELECT COALESCE(sum(cost),0) AS total FROM usage WHERE planning_preview_id=$1',[input.previewId])).rows[0].total):0;
      const priorCost=input.target?Number((await client.query('SELECT COALESCE(sum(cost),0) AS total FROM usage WHERE project_id=$1',[pId])).rows[0].total):0;
      if(planningCost+priorCost>=input.policy.maxBudget)throw new AppError(422,'已保存方案的规划费用达到项目预算，请调整预算后保存');
      if(input.target){
        await client.query('UPDATE departments SET data=$1,version=$2,updated_at=now() WHERE id=$3',[input.department,departmentVersion,dId]);
        await client.query("UPDATE projects SET department_version=$1,department_name=$2,requirement=$3,policy=$4,plan=$5,version=$6,source=$7 WHERE id=$8",[departmentVersion,input.department.name,input.requirement,input.policy,plan,projectVersion,preview?.data.source==='model'?'model':'manual',pId]);
      }else{
        await client.query('INSERT INTO departments(id,data) VALUES($1,$2)',[dId,input.department]);
        await client.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[pId,dId,input.department.name,input.requirement,input.policy,plan,preview?.data.source==='model'?'model':'manual']);
        if(preview?.data.source==='model')await client.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,0,$2,$3)',[pId,preview.data.plan,preview.data.policy]);
      }
      await client.query('INSERT INTO plan_versions(project_id,version,plan,policy) VALUES($1,$2,$3,$4)',[pId,projectVersion,plan,input.policy]);
      if(input.previewId){await client.query('UPDATE organization_previews SET project_id=$1,department_id=$2 WHERE id=$3',[pId,dId,input.previewId]);if(!conversationCost){await client.query('UPDATE usage SET project_id=$1 WHERE planning_preview_id=$2',[pId,input.previewId]);await client.query('UPDATE model_reservations SET project_id=$1,department_id=$2 WHERE id IN (SELECT id FROM usage WHERE planning_preview_id=$3)',[pId,dId,input.previewId]);}}
      if(!conversationCost)await checkDailyBudget(client,costConfig??await lockCostPolicy(client),dId,0);
      await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}res.status(input.target?200:201).json({departmentId:dId,projectId:pId,departmentVersion,projectVersion});
  });
  return router;
}
