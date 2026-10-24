import {createHash} from 'node:crypto';
import type pg from 'pg';
import {readRun,type RunDetail,type TraceEvent} from '../../../services/agent-runtime/trace-store.mjs';
import type {Principal} from './identity-types.ts';
import {knowledgePrincipal,requireRunRoute,assertRunArchiveBinding} from './project-route-access.ts';
import {visibleSourceQuery} from './resource-authorization.ts';

const metrics=['wallMs','activeMs','modelMs','inputTokens','outputTokens','totalTokens','modelCalls','cost'] as const;
type Metric=typeof metrics[number];
export type Efficiency={runId:string;goalHash:string;acceptanceHash:string;modelHash:string;deviceHash:string;initialFilesHash?:string;resumed?:boolean;usageComplete:boolean}&Record<Metric,number|null>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex');

/** Wall time spent waiting for at least one human decision, not a sum per employee. */
export function approvalWaitMs(events:Pick<TraceEvent,'type'|'at'|'data'>[],start:number,end:number){
 const pending=new Map<string,number>(),intervals:number[][]=[];
 for(const event of events){const at=Date.parse(event.at),id=event.data?.id;if(!Number.isFinite(at)||typeof id!=='string')continue;
  if(event.type==='approval/requested'&&!pending.has(id))pending.set(id,at);
  if(event.type==='approval/decided'&&pending.has(id)){intervals.push([pending.get(id)!,at]);pending.delete(id);}
 }
 for(const at of pending.values())intervals.push([at,end]);
 const clipped=intervals.map(([a,b])=>[Math.max(start,a),Math.min(end,b)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
 let total=0,left=start,right=start;
 for(const [a,b] of clipped){if(a>right){total+=right-left;left=a;right=b;}else right=Math.max(right,b);}
 return total+right-left;
}

export function compareEfficiency(baseline:Efficiency,current:Efficiency){
 const comparable=!baseline.resumed&&!current.resumed&&baseline.usageComplete&&current.usageComplete&&(['goalHash','acceptanceHash','modelHash','deviceHash','initialFilesHash'] as const).every(key=>baseline[key]===current[key]);
 const changes=Object.fromEntries(metrics.map(key=>{const first=baseline[key],now=current[key],saved=comparable&&first!==null&&now!==null?first-now:null;return [key,{baseline:first,current:now,saved,savedPercent:saved!==null&&first!==null&&first!==0?saved/first*100:null}];})) as Record<Metric,{baseline:number|null;current:number|null;saved:number|null;savedPercent:number|null}>;
 return {comparable,changes};
}

/** Read receipts and immutable run inputs; never call a model or infer a missing bill as zero. */
export async function runEfficiency(db:Pick<pg.Pool,'query'>,run:RunDetail,identity?:Principal){
 const principal=knowledgePrincipal(identity);await requireRunRoute(db,principal,run.id,'viewer');
 const row=(await db.query('SELECT * FROM project_runs WHERE id=$1',[run.id])).rows[0];assertRunArchiveBinding(principal,row,run);
 const rows=(await db.query('SELECT id,input_tokens,output_tokens,cost,duration_ms FROM usage WHERE run_id=$1 ORDER BY created_at,id',[run.id])).rows;
 const receipts=(await db.query('SELECT id,status FROM model_reservations WHERE run_id=$1',[run.id])).rows;
 const open=receipts.filter(r=>['pending','uncertain'].includes(r.status)).length;
 const started=run.events.find(e=>e.type==='run/started')?.at,finished=run.events.findLast(e=>e.type==='run/finished')?.at;
 const start=started?Date.parse(started):NaN,end=finished?Date.parse(finished):NaN,wallMs=Number.isFinite(start)&&Number.isFinite(end)&&end>=start?end-start:null;
 const waitingMs=wallMs===null?null:approvalWaitMs(run.events,start,end);
 const wires=run.events.filter(e=>e.type==='model/wire-request'),requests=wires.length;
 const receiptById=new Map(receipts.map(r=>[r.id,r.status])),rowById=new Map(rows.map(r=>[r.id,r]));
 const ids=wires.map(e=>e.data.usageId);
 const complete=run.status==='completed'&&run.integrity==='ok'&&open===0&&ids.every(id=>typeof id==='string')&&new Set(ids).size===ids.length&&ids.every(id=>receiptById.get(id)==='released'||receiptById.get(id)==='settled'&&rowById.has(id))&&rows.every(r=>ids.includes(r.id)&&Number.isInteger(r.input_tokens)&&Number.isInteger(r.output_tokens)&&r.input_tokens>=0&&r.output_tokens>=0&&Number.isFinite(Number(r.cost)));
 const sum=(key:string)=>rows.reduce((n,r)=>n+Number(r[key]),0);
 const s=run.snapshot as any;
 const citations=[...new Map(run.events.filter(e=>e.type==='knowledge/citation').flatMap(e=>(e.data.sources??[]).map((source:any)=>({agentId:e.data.agentId,documentId:source.documentId,version:source.version,chunkId:source.chunkId,sha256:source.sha256}))).map(source=>[JSON.stringify(source),source])).values()];
 return {runId:run.id,goalHash:hash(s.requirement),acceptanceHash:hash((s.approvedTasks??s.tasks).map((t:any)=>({id:t.id,kind:t.kind,criteria:t.acceptanceCriteria,verify:t.verify,checks:t.acceptanceChecks}))),modelHash:hash({agents:s.agents.map((a:any)=>({id:a.id,model:a.model,modelId:a.modelId})),routes:s.modelRoutes,outputLimits:s.tasks.map((t:any)=>({id:t.id,maxOutputTokens:t.maxOutputTokens}))}),deviceHash:hash(s.executionTarget),initialFilesHash:hash((s.importedFiles??[]).map((f:any)=>({path:f.path,sha256:f.sha256}))),resumed:Boolean(s.resumedFrom||s.completedCheckpoints?.length||s.recovery),usageComplete:complete,wallMs,approvalWaitMs:waitingMs,activeMs:wallMs===null||waitingMs===null?null:wallMs-waitingMs,modelMs:rows.length&&rows.length===requests&&rows.every(r=>Number.isFinite(r.duration_ms)&&r.duration_ms>=0)?sum('duration_ms'):null,inputTokens:complete?sum('input_tokens'):null,outputTokens:complete?sum('output_tokens'):null,totalTokens:complete?sum('input_tokens')+sum('output_tokens'):null,modelCalls:requests,cost:complete?sum('cost'):null,pendingReceipts:open,knowledgeVersions:(s.knowledge?.documents??[]).map((d:any)=>({documentId:d.documentId,version:d.version,sha256:d.sha256})),citations};
}

export async function workEfficiency(db:Pick<pg.Pool,'query'>,traceRoot:string,run:RunDetail,identity?:Principal){
 const principal=knowledgePrincipal(identity),current=await runEfficiency(db,run,principal),visible=visibleSourceQuery(principal,'run','viewer',{parameterOffset:3});
 const candidates=(await db.query(`SELECT id FROM project_runs WHERE status='completed' AND snapshot->>'requirement'=$1 AND snapshot->>'departmentId'=$2 AND created_at<(SELECT created_at FROM project_runs WHERE id=$3) AND id IN (${visible.text}) ORDER BY created_at,id LIMIT 100`,[run.snapshot.requirement,(run.snapshot as any).departmentId,run.id,...visible.values])).rows;
 let baseline:Awaited<ReturnType<typeof runEfficiency>>|null=null;
 for(const candidate of candidates){await requireRunRoute(db,principal,candidate.id,'viewer');const previous=readRun(traceRoot,candidate.id);if(!previous||previous.status!=='completed'||previous.integrity!=='ok')continue;const value=await runEfficiency(db,previous,principal);if(compareEfficiency(value,current).comparable){baseline=value;break;}}
 return {current,baseline,comparison:baseline?compareEfficiency(baseline,current):null,method:'同部门、同需求、同验收标准、同模型、同初始工作区文件及执行设备的首次完整成功运行；恢复分段不计算收益。仅统计执行阶段，规划对话另记。固定知识版本数量只统计公司 / 部门知识文档，导入工作区资料另见来源运行。净耗时仅扣除审批等待，不代表 CPU 时间。正值为减少，负值为增加；零基准无百分比。此为实测对照，不能单独证明知识复用导致收益。'};
}
