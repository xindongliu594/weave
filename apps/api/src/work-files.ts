import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { createOfficeFile, readOfficeFile } from '../../../services/agent-runtime/office-files.mjs';
import { isArtifactPath } from '../../../packages/contracts/task-contracts.mjs';
import { readRun } from '../../../services/agent-runtime/trace-store.mjs';
import { artifactFile } from '../../../services/agent-runtime/sandbox.mjs';
import { completedTasks, resumeHandoff } from './handoff-checkpoints.ts';

type Database = Pick<pg.PoolClient,'query'>;
export const workFileLimits={files:100,fileBytes:2*1024*1024,totalBytes:8*1024*1024,textCharacters:250000};
export const workFileTables=['work_file_snapshots'];
export type WorkFile = {path:string;bytes:number;sha256:string;kind:string;text:string;warnings:string[];base64:string};
export type WorkFileSnapshot = {id:string;name:string;files:WorkFile[];bytes:number;createdAt:string;sourceRunId?:string|null};
export type WorkFileSelection = {snapshotId:string;paths:string[];agentIds:string[];mode?:'reference'|'workspace'};
export const workFileSelectionSchema=z.object({snapshotId:z.string().uuid(),paths:z.array(z.string().min(1).max(240)).min(1).max(100),agentIds:z.array(z.string().min(1).max(180)).min(1).max(6),mode:z.enum(['reference','workspace']).optional()}).strict();
const uploadSchema=z.object({name:z.string().trim().min(1).max(100),files:z.array(z.object({path:z.string().min(1).max(240),base64:z.string().max(Math.ceil(workFileLimits.fileBytes/3)*4),kind:z.literal('file').optional()}).strict()).min(1).max(workFileLimits.files)}).strict();

export function validateWorkFilePath(path:string){
  if(typeof path!=='string'||!path||path.length>240||path!==path.normalize('NFC')||/[\\:\u0000-\u001f%]/.test(path)||path.startsWith('/')||path.endsWith('/'))throw new AppError(422,'仅允许 240 字符以内的规范目录相对路径。');
  const parts=path.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||part.toLowerCase().startsWith('.agent')||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))throw new AppError(422,'文件路径不能越界、为空或使用系统/团队保留名称。');
  if(parts.some(part=>/^(\.git|\.hg|\.svn|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.npmrc|\.pypirc|\.netrc|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|node_modules|__pycache__)$/i.test(part))||/\.(?:pem|key|p12|pfx|keystore|lnk|url|exe|dll|so|dylib|class|pyc)$/i.test(path))throw new AppError(422,'已阻止凭证、私钥、链接、依赖目录或可执行二进制文件：'+path);
  return path;
}
export function prepareWorkFileSnapshot(value:unknown){
  const input=uploadSchema.parse(value);const seen=new Set<string>();let bytes=0;
  const files=input.files.map(file=>{
    const path=validateWorkFilePath(file.path),key=path.toLowerCase();if(seen.has(key))throw new AppError(422,'文件路径重复（忽略大小写）：'+path);if([...seen].some(other=>other.startsWith(key+'/')||key.startsWith(other+'/')))throw new AppError(422,'文件与目录路径冲突：'+path);seen.add(key);
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64))throw new AppError(422,'文件编码无效。');
    const raw=Buffer.from(file.base64,'base64');bytes+=raw.length;
    if(raw.length>workFileLimits.fileBytes||bytes>workFileLimits.totalBytes)throw new AppError(422,'单文件最多 2 MiB，单次快照合计最多 8 MiB。');
    let parsed:ReturnType<typeof readOfficeFile>;try{parsed=readOfficeFile(path,raw);}catch(error){throw new AppError(422,path+'：'+(error as Error).message);}
    if(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(parsed.text))throw new AppError(422,'文件含私钥内容，不能导入：'+path);
    return {path,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex'),base64:file.base64,...parsed};
  });
  return {name:input.name,files,bytes};
}
export async function migrateWorkFiles(db:Database){await db.query(`CREATE TABLE IF NOT EXISTS work_file_snapshots(id text PRIMARY KEY,name text NOT NULL,files jsonb NOT NULL,bytes integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());`);await db.query('ALTER TABLE work_file_snapshots ADD COLUMN IF NOT EXISTS source_run_id text');}
export async function readWorkFileSnapshot(id:string,db:Database=pool):Promise<WorkFileSnapshot>{
  const row=(await db.query('SELECT id,name,files,bytes,created_at AS "createdAt",source_run_id AS "sourceRunId" FROM work_file_snapshots WHERE id=$1',[id])).rows[0];
  if(!row)throw new AppError(404,'导入快照不存在。');return row;
}
function verifiedText(file:WorkFile){
  const raw=Buffer.from(file.base64,'base64');if(createHash('sha256').update(raw).digest('hex')!==file.sha256)throw new AppError(409,'素材完整性校验失败。');
  const parsed=readOfficeFile(file.path,raw);if(parsed.text!==file.text||parsed.kind!==file.kind)throw new AppError(409,'素材正文与原文件不一致。');return raw;
}
export async function selectedWorkFileInputs(selections:WorkFileSelection[],db:Database=pool){
  const selected=z.array(workFileSelectionSchema).max(20).parse(selections),inputs:{id:string;title:string;content:string;agentIds:string[]}[]=[];const seen=new Set<string>();
  for(const selection of selected){
    const snapshot=await readWorkFileSnapshot(selection.snapshotId,db);
    for(const path of selection.paths){
      const file=snapshot.files.find(file=>file.path===path);if(!file)throw new AppError(422,'选用文件不在导入快照中：'+path);verifiedText(file);
      const key=snapshot.id+':'+path;if(seen.has(key))throw new AppError(422,'请合并同一文件的员工授权，不能重复选用。');seen.add(key);
      if(!file.text.trim())throw new AppError(422,'选用文件没有可读正文：'+path);
      if(file.text.length>50000)throw new AppError(422,'项目选用的每个文件正文最多 50,000 字符，请先拆分：'+path);
      inputs.push({id:'import_'+createHash('sha256').update(key).digest('hex').slice(0,40),title:(snapshot.name+' / '+path).slice(0,200),content:file.text,agentIds:[...new Set(selection.agentIds)]});
    }
  }
  if(inputs.length>20||inputs.reduce((n,file)=>n+file.content.length,0)>250000)throw new AppError(422,'本次选用资料最多 20 份、正文合计最多 250,000 字符。');
  return inputs;
}
/** Exact selected files only; callers still enforce employee grants and Run workspace boundaries. */
export async function selectedWorkFileCopies(selections:WorkFileSelection[],db:Database=pool){
  const selected=z.array(workFileSelectionSchema).max(20).parse(selections);const files:{path:string;content:string;sha256:string;agentIds:string[];snapshotId:string}[]=[];const paths=new Set<string>();
  for(const selection of selected){if(selection.mode!=='workspace')continue;const snapshot=await readWorkFileSnapshot(selection.snapshotId,db);for(const path of selection.paths){
    const file=snapshot.files.find(file=>file.path===path);if(!file)throw new AppError(422,'选用文件不在导入快照中。');validateWorkFilePath(path);
    if(!['text','csv'].includes(file.kind))continue;
    if(paths.has(path.toLowerCase()))throw new AppError(422,'不同素材快照有相同目标路径，请只保留一份：'+path);paths.add(path.toLowerCase());
    const raw=verifiedText(file);
    // utf8 decoder intentionally preserves original bytes including BOM for hash-bound copies.
    files.push({path,content:raw.toString('utf8'),sha256:file.sha256,agentIds:[...new Set(selection.agentIds)],snapshotId:snapshot.id});
  }}return files;
}
type ImportedFile={path:string;content:string;sha256:string};
function directoryChain(path:string,create=false){
  const absolute=resolve(path),root=parse(absolute).root;let current=root;
  for(const segment of relative(root,absolute).split(sep).filter(Boolean)){
    current=join(current,segment);const stat=lstatSync(current,{throwIfNoEntry:false});
    if(!stat){if(!create)return false;mkdirSync(current,{mode:0o700});continue;}
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new AppError(422,'运行工作区根目录或父目录包含链接/非目录，已停止复制。');
  }return true;
}
/** Resume keeps parent artifacts; a full retry starts from the original approved imported files. */
export function prepareImportedWorkspace(traceRoot:string,runId:string,files:ImportedFile[]=[],parentRunId?:string|null,recoveryKind?:string){
  if(!/^[a-f0-9-]{36}$/i.test(runId)||parentRunId&&!/^[a-f0-9-]{36}$/i.test(parentRunId))throw new AppError(422,'运行目录 ID 无效。');
  if(!Array.isArray(files)||files.length>100)throw new AppError(422,'导入文件清单无效。');
  const targetRoot=resolve(traceRoot,runId,'artifacts'),copies:{path:string;bytes:Buffer}[]=[];
  if(parentRunId&&recoveryKind!=='retry'){
    const sourceRoot=resolve(traceRoot,parentRunId,'artifacts');
    if(!directoryChain(sourceRoot)){
      if(files.length)throw new AppError(409,'父运行的文件档案缺失，请恢复该档案后再继续；不会用原始素材覆盖恢复状态。');
      return;
    }
    let total=0;
    const walk=(dir:string)=>{for(const name of readdirSync(dir)){
      const source=join(dir,name),stat=lstatSync(source),path=relative(sourceRoot,source).split(sep).join('/');
      if(!isArtifactPath(path)||stat.isSymbolicLink())throw new AppError(422,'父运行的文件档案包含非法路径或链接。');
      if(stat.isDirectory()){walk(source);continue;}
      if(!stat.isFile()||stat.size>5*1024*1024||copies.length>=128)throw new AppError(422,'父运行的文件档案超出可恢复范围。');
      const bytes=readFileSync(source);total+=bytes.length;if(bytes.length>5*1024*1024||total>20*1024*1024)throw new AppError(422,'父运行的文件档案超过 20 MiB 限额。');copies.push({path,bytes});
    }};walk(sourceRoot);
  }else{
    let total=0;
    for(const file of files){
      if(!file||typeof file.content!=='string'||typeof file.sha256!=='string')throw new AppError(422,'导入文件清单无效。');
      validateWorkFilePath(file.path);const bytes=Buffer.from(file.content);total+=bytes.length;
      if(bytes.length>workFileLimits.fileBytes||total>workFileLimits.totalBytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new AppError(422,'导入文件大小或 SHA256 校验值无效。');
      copies.push({path:file.path,bytes});
    }
  }
  // A retry has a new Run ID. Refuse a pre-populated target rather than reusing or clearing it.
  if(recoveryKind==='retry'&&directoryChain(targetRoot)&&readdirSync(targetRoot).length)throw new AppError(409,'完整重试需要独立空工作区，目标运行已有文件。');
  if(!copies.length)return;
  directoryChain(targetRoot);
  const seen=new Set<string>();
  for(const file of copies){
    const key=file.path.toLowerCase(),target=resolve(targetRoot,file.path);
    if(!target.startsWith(targetRoot+sep)||seen.has(key)||[...seen].some(other=>key.startsWith(other+'/')||other.startsWith(key+'/')))throw new AppError(422,'导入文件路径重复、冲突或越界。');seen.add(key);
    directoryChain(dirname(target));
    if(lstatSync(target,{throwIfNoEntry:false}))throw new AppError(409,'目标运行已有文件，不能覆盖：'+file.path);
  }
  for(const file of copies){const target=join(targetRoot,file.path);directoryChain(dirname(target),true);writeFileSync(target,file.bytes,{flag:'wx',mode:0o600});}
}
export function workFilesRouter(db:Pick<pg.Pool,'query'|'connect'>=pool,traceRoot=resolve(process.env.TRACE_ROOT??'.data/runs')){
  const router=Router();
  router.get('/work-files',async(_req,res)=>res.json((await db.query('SELECT id,name,bytes,created_at AS "createdAt",source_run_id AS "sourceRunId",jsonb_array_length(files) AS "fileCount" FROM work_file_snapshots ORDER BY created_at DESC LIMIT 200')).rows));
  async function store(value:unknown,sourceRunId?:string){
    const snapshot=prepareWorkFileSnapshot(value),id=randomUUID(),client=await db.connect();
    try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(918279)');
      if(sourceRunId){
        const signature=(files:WorkFile[])=>files.map(file=>file.path+':'+file.sha256).sort().join('\n');
        const prior=(await client.query('SELECT id,name,files,bytes FROM work_file_snapshots WHERE source_run_id=$1',[sourceRunId])).rows.find(row=>signature(row.files)===signature(snapshot.files));
        if(prior){prior.files.forEach(verifiedText);await client.query('COMMIT');return {id:prior.id,name:prior.name,bytes:prior.bytes,fileCount:prior.files.length,sourceRunId,existing:true};}
      }
      const row=(await client.query('SELECT count(*)::int AS count,coalesce(sum(bytes),0)::bigint AS bytes FROM work_file_snapshots')).rows[0];if(row.count>=200||Number(row.bytes)+snapshot.bytes>128*1024*1024)throw new AppError(422,'素材库已达到 200 份快照或 128 MiB 限额。');await client.query('INSERT INTO work_file_snapshots(id,name,files,bytes,source_run_id) VALUES($1,$2,$3,$4,$5)',[id,snapshot.name,JSON.stringify(snapshot.files),snapshot.bytes,sourceRunId??null]);await client.query('COMMIT');return {id,name:snapshot.name,bytes:snapshot.bytes,fileCount:snapshot.files.length,...(sourceRunId?{sourceRunId}:{})};}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  router.post('/work-files',async(req,res)=>res.status(201).json(await store(req.body)));
  router.post('/work-files/from-run',async(req,res)=>{
    const input=z.object({runId:z.uuid(),paths:z.array(z.string().min(1).max(240)).min(1).max(100),name:z.string().trim().min(1).max(100).optional()}).strict().parse(req.body);
    const row=(await db.query('SELECT status,snapshot FROM project_runs WHERE id=$1',[input.runId])).rows[0];
    const run=readRun(traceRoot,input.runId);
    if(!row||!run)throw new AppError(404,'来源运行不存在。');
    const sourceProjectId=(run.snapshot as {projectId?:unknown}).projectId;
    if(row.status!=='completed'||run.status!=='completed'||run.integrity!=='ok'||typeof sourceProjectId!=='string'||row.snapshot.projectId!==sourceProjectId||row.snapshot.planVersion!==run.snapshot.planVersion)throw new AppError(409,'只能复用完整且已完成的正式运行。');
    const root=join(traceRoot,input.runId,'artifacts');
    let receipts:any[];
    try{const done=completedTasks(run.events,run.snapshot);if(!done.size||!run.snapshot.tasks.every((task:any)=>done.has(task.id)))throw Error('任务尚未全部核验完成');receipts=resumeHandoff(run.snapshot,run.events,done,root);}catch(error){throw new AppError(409,'来源交接不能核对：'+(error as Error).message);}
    const sealed=receipts.flatMap(record=>[...(record.inputs??[]),...(record.outputs??[])]);
    const files=input.paths.map(path=>{
      validateWorkFilePath(path);let raw:Buffer;try{raw=readFileSync(artifactFile(root,path));}catch{throw new AppError(422,'来源文件不存在或路径不允许：'+path);}
      const sha256=createHash('sha256').update(raw).digest('hex');
      if(!sealed.some(file=>file.path===path&&file.sha256===sha256))throw new AppError(409,'文件未绑定已核验交接，或版本已变化：'+path);
      return {path,base64:raw.toString('base64')};
    });
    const result=await store({name:input.name??('已验收交付 · '+input.runId),files},input.runId);
    res.status(result.existing?200:201).json(result);
  });
  router.post('/work-files/generate',async(req,res)=>{
    const input=z.object({format:z.enum(['csv','docx','xlsx']),name:z.string().trim().min(1).max(80),title:z.string().max(200).optional(),text:z.string().max(250000).optional(),rows:z.array(z.array(z.union([z.string(),z.number().finite(),z.boolean(),z.null()]))).optional()}).strict().parse(req.body);
    let output:ReturnType<typeof createOfficeFile>;try{output=createOfficeFile({...input,title:input.title??input.name});}catch(error){throw new AppError(422,(error as Error).message);}
    res.status(201).json(await store({name:input.name,files:[{path:input.name.replace(/[\\/:*?"<>|]/g,'_')+'.'+output.extension,base64:output.buffer.toString('base64')}]}));
  });
  router.get('/work-files/:id',async(req,res)=>{const snapshot=await readWorkFileSnapshot(String(req.params.id),db);res.json({...snapshot,files:snapshot.files.map(({base64,...file})=>file)});});
  router.get('/work-files/:id/files/:index/download',async(req,res)=>{
    const snapshot=await readWorkFileSnapshot(String(req.params.id),db),index=Number(req.params.index);if(!/^\d+$/.test(String(req.params.index))||!Number.isInteger(index)||!snapshot.files[index])throw new AppError(404,'文件不存在。');
    const file=snapshot.files[index];res.setHeader('Content-Type','application/octet-stream');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.path.split('/').at(-1)!));res.send(Buffer.from(file.base64,'base64'));
  });
  return router;
}
