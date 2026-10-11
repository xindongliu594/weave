import {createHash} from 'node:crypto';
import type pg from 'pg';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {acceptedWorkRecord} from './work-records.ts';
import {AppError} from './provider.ts';

type Database=Pick<pg.Pool,'query'>;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const reuseThreshold=(settings:any)=>Number.isInteger(settings?.reuseMinSuccessfulWorks)&&settings.reuseMinSuccessfulWorks>=2&&settings.reuseMinSuccessfulWorks<=100?settings.reuseMinSuccessfulWorks:3;
function liveSourceAccess(department:any,snapshot:any,adoption:any,spaceId:string){
 const employee=snapshot.agents?.find((agent:any)=>agent.id===adoption.agentId);
 if(employee?.sourceDepartmentId&&employee.sourceDepartmentId!==snapshot.departmentId)return false;
 const live=department.agents?.find((agent:any)=>agent.id===(employee?.sourceAgentId??employee?.knowledgeEmployeeId??employee?.employeeId??employee?.id));
 return live?.tools?.includes('knowledge_search')&&live.tools.includes('knowledge_read')&&live.knowledgeSpaceIds?.includes(spaceId);
}

/** An accepted attempt is evidence; distinct project/semantic-version pairs are works. */
export async function knowledgeReuse(db:Database,traceRoot:string,departmentId:string){
 const department=(await db.query('SELECT data FROM departments WHERE id=$1 AND deleted_at IS NULL',[departmentId])).rows[0];
 if(!department)throw new AppError(404,'部门不存在或已归档');
 const settings=(await db.query('SELECT data FROM product_settings WHERE id=1')).rows[0]?.data;
 const rows=(await db.query("SELECT r.id FROM project_runs r JOIN projects p ON p.id=r.project_id WHERE p.department_id=$1 AND r.status='completed' ORDER BY r.created_at DESC,r.id LIMIT 101",[departmentId])).rows;
 const capacity=(await db.query('SELECT count(*)::int AS count,coalesce(sum(octet_length(content)+coalesce(octet_length(reuse_evidence::text),0)),0)::bigint AS bytes FROM automation_knowledge_candidates')).rows[0];
 const groups=new Map<string,any>(),omissions:{runId:string;code:string}[]=[];
 for(const row of rows.slice(0,100)){
  let record:Awaited<ReturnType<typeof acceptedWorkRecord>>;
  try{record=await acceptedWorkRecord(db,traceRoot,row.id);}catch{omissions.push({runId:row.id,code:'INVALID_WORK'});continue;}
  if(!record.shareable){omissions.push({runId:row.id,code:'PRIVATE_WORK'});continue;}
  const snapshot=readRun(traceRoot,row.id)!.snapshot as any,workKey=record.projectId+':'+record.planVersion;
  if(!snapshot.approval){omissions.push({runId:row.id,code:'UNAPPROVED_WORK'});continue;}
  for(const adoption of record.adoptions){
   const source=adoption.source,reference=snapshot.knowledge?.documents?.find((doc:any)=>doc.documentId===source.documentId&&doc.version===source.version&&doc.sha256===source.sha256);
   if(!reference||!liveSourceAccess(department.data,snapshot,adoption,reference.spaceId)){omissions.push({runId:row.id,code:'SOURCE_UNAVAILABLE'});continue;}
   const key=[source.documentId,source.version,source.sha256].join(':');let group=groups.get(key);
   if(!group){
    const doc=(await db.query(`SELECT d.title,d.space_id,s.scope,s.department_id,r.content,r.sha256 FROM knowledge_documents d JOIN knowledge_spaces s ON s.id=d.space_id JOIN knowledge_revisions r ON r.document_id=d.id AND r.version=$2 WHERE d.id=$1 AND d.deleted_at IS NULL AND s.deleted_at IS NULL`,[source.documentId,source.version])).rows[0];
    if(!doc||doc.space_id!==reference.spaceId||doc.sha256!==source.sha256||hash(doc.content)!==source.sha256||!(doc.scope==='company'||doc.scope==='department'&&doc.department_id===departmentId)){omissions.push({runId:row.id,code:'SOURCE_UNAVAILABLE'});continue;}
    group={source:{documentId:source.documentId,version:source.version,sha256:source.sha256,spaceId:doc.space_id,title:reference.title,scope:doc.scope},workMap:new Map<string,any>()};groups.set(key,group);
   }
   let work=group.workMap.get(workKey);
   if(!work){work={workKey,runId:record.runId,projectId:record.projectId,planVersion:record.planVersion,notes:[],taskIds:[],efficiency:record.efficiency};group.workMap.set(workKey,work);}
   if(!work.taskIds.includes(adoption.taskId)){work.taskIds.push(adoption.taskId);work.notes.push(String(adoption.note).slice(0,1000));}
  }
 }
 const output=[...groups.values()].map(({source,workMap})=>({source,successWorkCount:workMap.size,workReferences:[...workMap.values()].map(({workKey,runId})=>({workKey,runId})),works:[...workMap.values()].slice(0,20)}));
 return {departmentId,minSuccessfulWorks:reuseThreshold(settings),candidateCapacity:{count:capacity.count,bytes:Number(capacity.bytes),maxCount:500,maxBytes:8*1024*1024},scannedRuns:Math.min(rows.length,100),truncated:rows.length>100||output.length>100,omissions:[...new Map(omissions.map(item=>[item.runId,item])).values()],groups:output.slice(0,100),method:'按最近核对窗口内的项目与语义方案版本统计不同已验收工作；超过窗口时次数是已证实下界，不能解释为全部历史总数；恢复、重复读取和失败尝试不增加成功次数。来源版本分别统计，收益仅沿用同条件实测对照；没有基线或用量不齐时保持未验证。每次最多核对100个完成运行、100个来源，每来源显示最近20个工作。'};
}

export async function syncReuseCandidates(db:Database,traceRoot:string,departmentId:string){
 const report=await knowledgeReuse(db,traceRoot,departmentId);let created=0;
 for(const group of report.groups){
  if(group.source.scope!=='department'||group.successWorkCount<report.minSuccessfulWorks)continue;
  const works=group.works.slice(0,10),source=group.source;
  const evidence={departmentId,source,minSuccessfulWorks:report.minSuccessfulWorks,successWorkCount:group.successWorkCount,historyTruncated:report.truncated,workReferences:group.workReferences,works:works.map(({workKey,runId,taskIds,notes})=>({workKey,runId,taskIds,notes}))};
  const content=['# 待审查的复用经验',`固定来源：${source.title} · v${source.version} · SHA256 ${source.sha256}`,`已证实至少 ${group.successWorkCount} 个不同成功工作；触发门槛：${report.minSuccessfulWorks}`,'','## 实际采用步骤与证据',...evidence.works.map(work=>`- ${work.runId}（${work.workKey}）：${work.notes.join('；').slice(0,1000)}`),'','## 发布前需要核对','适用条件、失败条件和反例；对来源步骤的修改；独立测试或验收证据。','本候选是确定性证据整理，不是模型提炼；采用加上任务验收不证明方法带来提速。没有新增工具、权限或自动发布。'].join('\n');
  const bytes=Buffer.byteLength(content)+Buffer.byteLength(JSON.stringify(evidence));
  if(report.candidateCapacity.count>=500||report.candidateCapacity.bytes+bytes>8*1024*1024)continue;
  const id='reuse-'+hash(departmentId+':'+source.documentId+':'+source.sha256).slice(0,40);
  const inserted=await db.query(`INSERT INTO automation_knowledge_candidates(id,run_id,document_id,source_version,source_hash,space_id,title,content,reuse_evidence)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb WHERE (SELECT count(*)<500 AND coalesce(sum(octet_length(content)+coalesce(octet_length(reuse_evidence::text),0)),0)+octet_length($8::text)+octet_length($9::jsonb::text)<=8388608 FROM automation_knowledge_candidates)
    ON CONFLICT(document_id,source_hash) DO NOTHING RETURNING id,octet_length(content)+octet_length(reuse_evidence::text) AS bytes`,[id,works[0].runId,source.documentId,source.version,source.sha256,source.spaceId,('复用经验待审：'+source.title).slice(0,200),content,evidence]);
  created+=inserted.rowCount??0;if(inserted.rowCount){report.candidateCapacity.count++;report.candidateCapacity.bytes+=Number(inserted.rows[0].bytes);}
 }
 return {created,report};
}

export async function validateReuseEvidence(db:Database,traceRoot:string,evidence:any){
 const denied=()=>new AppError(409,'候选来源工作、资料授权或交付证据已变化，请重新核对；不会发布旧声明');
 const references=evidence.workReferences??evidence.works,source=evidence.source;
 const department=(await db.query('SELECT data FROM departments WHERE id=$1 AND deleted_at IS NULL',[evidence.departmentId])).rows[0];
 if(!department||!Array.isArray(references)||references.length>100||references.length<evidence.minSuccessfulWorks||new Set(references.map((work:any)=>work.workKey)).size!==references.length)throw denied();
 for(const reference of references){
  const record=await acceptedWorkRecord(db,traceRoot,reference.runId),snapshot=readRun(traceRoot,reference.runId)!.snapshot as any;
  if(!snapshot.approval||!record.shareable||record.departmentId!==evidence.departmentId||record.projectId+':'+record.planVersion!==reference.workKey||!record.adoptions.some(adoption=>adoption.source.documentId===source.documentId&&adoption.source.version===source.version&&adoption.source.sha256===source.sha256&&liveSourceAccess(department.data,snapshot,adoption,source.spaceId)))throw denied();
 }
}
