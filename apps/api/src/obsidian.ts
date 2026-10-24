import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash,randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,lstatSync,readdirSync,unlinkSync } from 'node:fs';
import { resolve,join,relative,basename,dirname } from 'node:path';
import { Router } from 'express';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { chunkDocument } from '../../../services/agent-runtime/knowledge.mjs';
const vaultContext = new AsyncLocalStorage<boolean>();
let vaultTail: Promise<unknown> = Promise.resolve();
export function withVaultLock<T>(work: () => Promise<T>): Promise<T> {
 if (vaultContext.getStore()) return work();
 const result = vaultTail.then(() => vaultContext.run(true, work));
 vaultTail = result.catch(() => {});
 return result;
}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
export const obsidianRoot=()=>resolve(process.env.OBSIDIAN_VAULT??join(process.env.DATA_DIR??'.data','obsidian-vault'));
export function parseNote(raw:string){
 const fields:Record<string,string>={};let content=raw;
 const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
 if(front){for(const line of front[1].split(/\r?\n/)){const pair=/^([a-zA-Z_]+):\s*(.*)$/.exec(line);if(pair){let v=pair[2].trim();try{v=JSON.parse(v);}catch{}if(typeof v==='string'||typeof v==='number')fields[pair[1]]=String(v);}}content=raw.slice(front[0].length);}
 return {fields,content};
}
export function renderNote(doc:any,existingRaw=''){
 const managed:Record<string,string|number>={ad_document_id:doc.id,ad_space_id:doc.spaceId,ad_version:doc.version,title:doc.title};
 if(doc.source?.runId)managed.agent_run=doc.source.runId;
 const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(existingRaw);
 const kept:string[]=[];let skip=false;
 for(const line of front?.[1].split(/\r?\n/)??[]){const key=/^([a-zA-Z_]+):/.exec(line)?.[1];if(key)skip=Object.hasOwn(managed,key);else if(line&&!/^\s/.test(line))skip=false;if(!skip)kept.push(line);}
 return '---\n'+[...kept,...Object.entries(managed).map(([key,value])=>key+': '+JSON.stringify(value))].join('\n')+'\n---\n'+doc.content;
}
function safe(path:string){if(!path||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw new AppError(422,'Vault 路径不合法');let current=obsidianRoot();for(const part of path.split('/')){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new AppError(422,'Vault 中不索引符号链接');}return current;}
export function ensureVault(){const root=obsidianRoot();mkdirSync(root,{recursive:true,mode:0o700});if(!existsSync(join(root,'.obsidian')))mkdirSync(join(root,'.obsidian'),{mode:0o700});const welcome=join(root,'知识库说明.md');if(!existsSync(welcome))writeFileSync(welcome,'# 为伍知识库\n\n这是普通 Obsidian Vault，资料以 Markdown 文件保存。\n\n- 请在工作台创建公司、部门或员工知识空间；对应目录会自动建立。\n- 在这些目录中编辑或新建 Markdown，点击同步索引即可供授权员工检索。\n- `ad_document_id` 标识文档，移动文件时请保留；不要复制该 ID 到其他文档。\n- Wiki 链接和标签会保留，引用依据每次索引的文档版本及行号。\n- 删除或移出已授权文件夹的笔记会从当前检索中移除；历史引用仍保留。\n- 员工访问权限由工作台管理，修改 Markdown 属性不会扩大授权。\n',{mode:0o600});return root;}
export async function ensureSpaceFolder(id:string){
 const space=(await pool.query('SELECT * FROM knowledge_spaces WHERE id=$1',[id])).rows[0];if(!space)throw new AppError(404,'知识空间不存在');
 const folder=space.vault_folder??`${space.scope}/${space.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').slice(0,60)}-${space.id.slice(0,8)}`;
 ensureVault();mkdirSync(safe(folder),{recursive:true,mode:0o700});if(!space.vault_folder)await pool.query('UPDATE knowledge_spaces SET vault_folder=$1 WHERE id=$2',[folder,id]);return folder;
}
export async function writeVaultDocument(id:string){
 const doc=(await pool.query('SELECT d.*,r.content,r.source FROM knowledge_documents d JOIN knowledge_revisions r ON r.document_id=d.id AND r.version=d.version WHERE d.id=$1',[id])).rows[0];if(!doc)return;
 const folder=await ensureSpaceFolder(doc.space_id),path=doc.vault_path??`${folder}/${doc.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'-').replace(/\.md$/i,'').slice(0,80)}-${id.slice(0,8)}.md`,file=safe(path);
 if(existsSync(file)&&doc.vault_hash&&sha(readFileSync(file,'utf8'))!==doc.vault_hash)throw new AppError(409,'Obsidian 文件已修改，已保留双方版本，请先同步索引再编辑');
 const text=renderNote({...doc,spaceId:doc.space_id},existsSync(file)?readFileSync(file,'utf8'):'');mkdirSync(dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID()+'.tmp';writeFileSync(temporary,text,{mode:0o600});renameSync(temporary,file);await pool.query('UPDATE knowledge_documents SET vault_path=$1,vault_hash=$2 WHERE id=$3',[path,sha(text),id]);
 await pool.query("UPDATE knowledge_revisions SET source=source || $1::jsonb WHERE document_id=$2 AND version=$3",[JSON.stringify({vaultPath:path}),id,doc.version]);
 const offset=text.slice(0,text.length-doc.content.length).split('\n').length-1;
 for(const chunk of chunkDocument(id,doc.version,doc.content))await pool.query('UPDATE knowledge_chunks SET line_start=$1,line_end=$2 WHERE id=$3',[chunk.lineStart+offset,chunk.lineEnd+offset,chunk.id]);
}
export async function archiveVaultDocument(id:string){const doc=(await pool.query('SELECT vault_path FROM knowledge_documents WHERE id=$1',[id])).rows[0];if(doc?.vault_path){const file=safe(doc.vault_path);if(existsSync(file)){const trash=join(obsidianRoot(),'.trash');mkdirSync(trash,{recursive:true,mode:0o700});renameSync(file,join(trash,id+'-'+Date.now()+'.md'));}}}
export function vaultFileSnapshot(paths:string[]){const files:Record<string,string>={};let size=0;for(const path of paths){const file=safe(path);if(existsSync(file)&&lstatSync(file).isFile()){const bytes=readFileSync(file);if((size+=bytes.length)>20*1024*1024)throw new AppError(422,'Vault 资料超过在线备份上限');files[path]=bytes.toString('base64');}}return files;}
export function restoreVaultFiles(files:Record<string,string>,previousPaths:string[]){
 const paths=[...new Set([...previousPaths,...Object.keys(files)])],before=new Map<string,Buffer|null>(),trash=join(obsidianRoot(),'.trash','restore-'+Date.now());
 for(const path of paths){const file=safe(path);before.set(path,existsSync(file)?readFileSync(file):null);}
 const rollback=()=>{for(const [path,bytes]of before){const file=safe(path);if(bytes){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,bytes,{mode:0o600});}else if(existsSync(file))unlinkSync(file);}};
 try{for(const path of paths){const file=safe(path),old=before.get(path);if(old){const retained=join(trash,path);mkdirSync(dirname(retained),{recursive:true,mode:0o700});writeFileSync(retained,old,{mode:0o600});}if(files[path]!==undefined){if(typeof files[path]!=='string')throw new AppError(422,'Vault 备份格式不正确');mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,Buffer.from(files[path],'base64'),{mode:0o600});}else if(existsSync(file))unlinkSync(file);}return rollback;}catch(e){try{rollback();}catch{/* The caller must verify physical outcome; preserve the original failure. */}throw e;}
}
let lastSync:any=null;
export function syncObsidian(){return withVaultLock(sync);}
async function sync(){
 ensureVault();const spaces=(await pool.query('SELECT * FROM knowledge_spaces WHERE deleted_at IS NULL')).rows;let indexed=0;const errors:string[]=[];
 for(const space of spaces){
  for(const doc of (await pool.query('SELECT id FROM knowledge_documents WHERE space_id=$1 AND vault_path IS NULL AND deleted_at IS NULL',[space.id])).rows)await writeVaultDocument(doc.id);
  const folder=await ensureSpaceFolder(space.id),root=safe(folder),seen=new Set<string>(),ids=new Set<string>();
  const files:string[]=[];function walk(dir:string){for(const name of readdirSync(dir)){if(name.startsWith('.'))continue;const file=join(dir,name),stat=lstatSync(file);if(stat.isSymbolicLink())continue;if(stat.isDirectory())walk(file);else if(/\.md$/i.test(name)&&stat.size<=500000)files.push(file);if(files.length>1000)throw new AppError(422,'单空间笔记超过 1000 份');}}walk(root);
  for(const file of files){const path=relative(obsidianRoot(),file).replaceAll('\\','/'),raw=readFileSync(file,'utf8'),hash=sha(raw),note=parseNote(raw);
   try{
    if(!note.content.trim()||note.content.length>250000)continue;
    const match=(await pool.query('SELECT * FROM knowledge_documents WHERE (id=$1 OR vault_path=$2) AND space_id=$3 ORDER BY (id=$1) DESC LIMIT 1',[note.fields.ad_document_id??'',path,space.id])).rows[0];
    if(note.fields.ad_document_id&&!match&&(await pool.query('SELECT id FROM knowledge_documents WHERE id=$1',[note.fields.ad_document_id])).rowCount)throw Error('笔记 ID 属于其他知识空间，未导入');
    const id=match?.id??randomUUID();if(ids.has(id))throw Error('重复的笔记 ID，请删除复制笔记中的 ad_document_id 属性');ids.add(id);seen.add(id);
    if(match?.vault_hash===hash&&!match.deleted_at){if(match.vault_path!==path)await pool.query('UPDATE knowledge_documents SET vault_path=$1 WHERE id=$2',[path,id]);continue;}
    const title=(note.fields.title??/^#\s+(.+)$/m.exec(note.content)?.[1]??basename(file,'.md')).slice(0,200),client=await pool.connect();
    try{await client.query('BEGIN');let version=1;
     if(match){const r=await client.query('UPDATE knowledge_documents SET title=$1,version=version+1,deleted_at=NULL,vault_path=$2,vault_hash=$3 WHERE id=$4 AND version=$5 RETURNING version',[title,path,hash,id,match.version]);if(!r.rowCount)throw Error('笔记索引版本冲突，请重新同步');version=r.rows[0].version;}
     else await client.query('INSERT INTO knowledge_documents(id,space_id,title,vault_path,vault_hash) VALUES($1,$2,$3,$4,$5)',[id,space.id,title,path,hash]);
     await client.query('INSERT INTO knowledge_revisions(document_id,version,content,sha256,source) VALUES($1,$2,$3,$4,$5)',[id,version,note.content,sha(note.content),{type:'obsidian',vaultPath:path,links:[...note.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m=>m[1])}]);
     const offset=raw.slice(0,raw.length-note.content.length).split('\n').length-1;
     for(const c of chunkDocument(id,version,note.content))await client.query('INSERT INTO knowledge_chunks(id,document_id,version,line_start,line_end,content,tokens) VALUES($1,$2,$3,$4,$5,$6,$7)',[c.id,id,version,c.lineStart+offset,c.lineEnd+offset,c.content,JSON.stringify(c.tokens)]);
     await client.query('COMMIT');indexed++;
     // Keep existing Obsidian properties and user bytes intact. IDs of new notes
     // are tracked by path; renamed notes keep identity when the optional ID is set.
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
   }catch(e){errors.push(path+': '+(e as Error).message);}
  }
  if(!errors.length){await pool.query('UPDATE knowledge_documents SET deleted_at=now() WHERE space_id=$1 AND vault_path IS NOT NULL AND deleted_at IS NULL AND NOT(id=ANY($2::text[]))',[space.id,[...seen]]);}
 }
 lastSync={at:new Date().toISOString(),indexed,errors};return lastSync;
}
export function obsidianRouter(){const router=Router();router.get('/knowledge/vault',async(_req,res)=>res.json({root:obsidianRoot(),name:basename(obsidianRoot()),lastSync,mode:'obsidian-markdown',instructions:'在 Obsidian 中选择「打开本地仓库」，打开此目录。在这里编辑的笔记会在同步索引后供授权员工检索；其他目录的笔记需先同步至此目录。'}));router.post('/knowledge/vault/sync',async(_req,res)=>res.json(await syncObsidian()));return router;}
