import { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, readdirSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type pg from 'pg';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { isNativeToolName } from '../../../packages/contracts/native-tool-ids.mjs';
import { nativeManifestId, nativeToolBinding, assertNativeTaskAccess } from '../../../services/agent-runtime/native-capabilities.mjs';
import { createNativeInstallManager } from './native-plugin-install.ts';
import {httpPrincipal,administrative} from './project-route-access.ts';
import {visibleResourceQuery} from './resource-authorization.ts';
export { assertNativeTaskAccess };

type Database = Pick<pg.PoolClient,'query'>;
export const nativeCapabilityTables = ['native_capabilities'];
export const nativeCapabilityRoot = () => resolve(process.env.LOCAL_WORKSPACE_ROOT ?? process.env.DATA_DIR ?? '.data', 'native-plugins');
const hash = (value: Buffer|string) => createHash('sha256').update(value).digest('hex');
export async function migrateNativeCapabilities(db: Database) {
 await db.query('CREATE TABLE IF NOT EXISTS native_capabilities(namespace text PRIMARY KEY, manifest_id text NOT NULL, enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now())');
}
function boundedFile(file: string, max: number) {
 const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw Error('NATIVE_BUNDLE_INVALID: 插件文件类型或大小不匹配');
 return readFileSync(file);
}
export function readNativeBundle(id: string, root = nativeCapabilityRoot()) {
 if (!/^[a-f0-9]{64}$/.test(id)) throw Error('NATIVE_VERSION_INVALID');
 const directory = join(root,id), stat = lstatSync(directory);
 if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('NATIVE_BUNDLE_INVALID');
 const manifest = JSON.parse(boundedFile(join(directory,'manifest.json'),256*1024).toString());
 if (nativeManifestId(manifest) !== id) throw Error('NATIVE_VERSION_MISMATCH');
 const compressed = boundedFile(join(directory,'bundle.gz'),4*1024*1024), metadata = boundedFile(join(directory,'package.json'),16384);
 if (compressed.length !== manifest.bundle.bytes || hash(compressed) !== manifest.bundle.sha256 || hash(metadata) !== manifest.bundle.metadataSha256 ||
     hash(gunzipSync(compressed,{maxOutputLength:24*1024*1024})) !== manifest.bundle.codeSha256) throw Error('NATIVE_BUNDLE_MISMATCH: 固定插件文件校验失败');
 return {id,manifest,compressed,metadata};
}
export async function setNativeCapability(id: string, enabled: boolean, db: Database = pool, root = nativeCapabilityRoot()) {
 if (!/^[a-f0-9]{64}$/.test(id)) throw new AppError(422,'插件版本编号不合法');
 if (!enabled) {
  const rows=(await db.query('UPDATE native_capabilities SET enabled=false,updated_at=now() WHERE manifest_id=$1 RETURNING namespace',[id])).rows;
  return {id,namespace:rows[0]?.namespace,enabled:false};
 }
 const {manifest} = readNativeBundle(id,root);
 // Changing current installation only affects new snapshots. Previous content
 // remains available; disabling its namespace revokes both old and new runs.
 await db.query('INSERT INTO native_capabilities(namespace,manifest_id,enabled) VALUES($1,$2,$3) ON CONFLICT(namespace) DO UPDATE SET manifest_id=$2,enabled=$3,updated_at=now()', [manifest.namespace,id,enabled]);
 return {id,namespace:manifest.namespace,enabled};
}
export async function snapshotNativeCapabilities(agents: any[], db: Database = pool, root = nativeCapabilityRoot()) {
 const names = [...new Set(agents.flatMap(agent => agent.tools ?? []).filter(isNativeToolName))];
 if (!names.length) return [];
 const namespaces=[...new Set(names.map(name=>String(name).split('__')[1]))];
 const rows = (await db.query('SELECT * FROM native_capabilities WHERE enabled=true AND namespace=ANY($1::text[])',[namespaces])).rows;
 const bindings = rows.map(row => {const {id,manifest}=readNativeBundle(row.manifest_id,root);return {id,manifest};});
 const snapshot = {nativeCapabilities:bindings};
 const used = new Set(names.map(name => nativeToolBinding(snapshot,name).id));
 return bindings.filter(binding => used.has(binding.id));
}
export async function assertNativeCapabilities(snapshot: any, db: Database = pool, root = nativeCapabilityRoot()) {
 const names = [...new Set<string>((snapshot.agents??[]).flatMap((agent:any)=>agent.tools??[]).filter(isNativeToolName))];
 if (!names.length && !snapshot.nativeCapabilities?.length) return;
 const rows = (await db.query('SELECT namespace,enabled FROM native_capabilities')).rows;
 for (const name of names) {
  const binding = nativeToolBinding(snapshot,name);
  if (!rows.some(row => row.namespace === binding.manifest.namespace && row.enabled)) throw new AppError(409,'NATIVE_PLUGIN_DISABLED: 此插件已停用，请调整方案后重新批准','NATIVE_PLUGIN_DISABLED');
  readNativeBundle(binding.id,root);
 }
}
export function exportNativeBundles(tables: Record<string,any[]>, root = nativeCapabilityRoot()) {
 const ids=new Set<string>([...(tables.native_capabilities??[]).map(row=>row.manifest_id),...(tables.project_runs??[]).flatMap(row=>(row.snapshot.nativeCapabilities??[]).map((binding:any)=>binding.id))]);
 const records:Record<string,any>={};let size=0;
 for(const id of ids){const loaded=readNativeBundle(id,root);size+=loaded.compressed.length+loaded.metadata.length;if(size>32*1024*1024)throw new AppError(422,'插件安装包超过在线备份限制，请使用本机目录备份');records[id]={manifest:loaded.manifest,compressed:loaded.compressed.toString('base64'),metadata:loaded.metadata.toString('base64')};}
 return records;
}
export function restoreNativeBundles(records: Record<string,any>, root = nativeCapabilityRoot()) {
 if(!records||Array.isArray(records)||typeof records!=='object'||Object.keys(records).length>100)throw Error('NATIVE_BACKUP_INVALID');
 mkdirSync(root,{recursive:true,mode:0o700});const stage=mkdtempSync(join(root,'.restore-'));
 try{
  let total=0;
  for(const [id,value]of Object.entries(records)){
   if(!/^[a-f0-9]{64}$/.test(id)||nativeManifestId(value.manifest)!==id||typeof value.compressed!=='string'||value.compressed.length>6*1024*1024||typeof value.metadata!=='string'||value.metadata.length>24000)throw Error('NATIVE_BACKUP_INVALID');
   const bytes=Buffer.from(value.compressed,'base64'),metadata=Buffer.from(value.metadata,'base64');total+=bytes.length+metadata.length;if(total>32*1024*1024)throw Error('NATIVE_BACKUP_LIMIT');
   mkdirSync(join(stage,id));writeFileSync(join(stage,id,'manifest.json'),JSON.stringify(value.manifest));writeFileSync(join(stage,id,'bundle.gz'),bytes);writeFileSync(join(stage,id,'package.json'),metadata);readNativeBundle(id,stage);
  }
  // Existing content is verified and retained, never overwritten by restore.
  for(const id of Object.keys(records)){if(existsSync(join(root,id)))readNativeBundle(id,root);else renameSync(join(stage,id),join(root,id));}
 }finally{rmSync(stage,{recursive:true,force:true});}
}
export async function listNativeCapabilities(db:Database=pool,root=nativeCapabilityRoot()) {
  const states=(await db.query('SELECT * FROM native_capabilities')).rows;
  const ids=[...new Set([...states.map(row=>row.manifest_id),...(existsSync(root)?readdirSync(root).filter(id=>/^[a-f0-9]{64}$/.test(id)):[])])];
  if(ids.length>100)throw new AppError(422,'插件安装版本超过目录限制，请先归档未引用版本');
  return ids.map(id=>{const state=states.find(row=>row.manifest_id===id);try{const {manifest}=readNativeBundle(id,root);return {id,manifest,available:true,enabled:!!state?.enabled};}catch{return {id,namespace:state?.namespace,available:false,enabled:!!state?.enabled,error:'安装文件缺失、版本不符或校验失败；可停用后重新安装固定版本'};}});
}
export function nativeCapabilityRouter(options:{demo?:unknown;root?:string}={}) {
 const router=Router();
 const installer=createNativeInstallManager(options.root);
 router.get('/capabilities/plugins',async(_req,res)=>{
  const principal=httpPrincipal(res);if(administrative(principal))return res.json(await listNativeCapabilities());
  const visible=visibleResourceQuery(principal,'department','viewer');
  const departments=(await pool.query(`SELECT data FROM departments WHERE id IN (${visible.text})`,visible.values)).rows;
  const names=new Set<string>(departments.flatMap(row=>(row.data.agents??[]).flatMap((agent:any)=>agent.tools??[]).filter(isNativeToolName)));
  const namespaces=[...new Set([...names].map(name=>name.split('__')[1]))];
  const rows=(await pool.query('SELECT namespace,manifest_id FROM native_capabilities WHERE enabled=true AND namespace=ANY($1::text[]) ORDER BY namespace LIMIT 100',[namespaces])).rows;
  const result=[];
  for(const row of rows){try{const {id,manifest}=readNativeBundle(row.manifest_id,options.root);if(manifest.namespace!==row.namespace)continue;
    const tools=manifest.tools.filter((tool:any)=>names.has(tool.name)).map(({name,originalName,description}:any)=>({name,originalName,description}));
    if(tools.length)result.push({id,available:true,enabled:true,manifest:{namespace:manifest.namespace,package:manifest.package,version:manifest.version,dshVersion:manifest.dshVersion,source:{kind:manifest.source.kind},tools}});
  }catch{/* An unverified installed version grants no member metadata. */}}
  res.json(result);
 });
 router.post('/capabilities/plugins/install',(req,res)=>{if(options.demo)return res.status(403).json({message:'演示环境不能下载安装插件。'});try{res.status(202).json(installer.start(req.body));}catch(error:any){res.status(error?.status??422).json({message:typeof error?.status==='number'?error.message:'插件安装配置无效；请检查精确包名、版本及工具文件字段。'});}});
 router.get('/capabilities/plugins/install/:id',(req,res)=>{const state=installer.get(String(req.params.id));if(!state)return res.status(404).json({message:'安装任务不存在'});res.json(state);});
 router.put('/capabilities/plugins/:id',async(req,res)=>{const enabled=z.object({enabled:z.boolean()}).parse(req.body).enabled;res.json(await setNativeCapability(String(req.params.id),enabled));});
 return router;
}
