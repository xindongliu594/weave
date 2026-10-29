import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {api} from './api.ts';
import {identitySession} from './identity-session.ts';
import {ENTERPRISE_BACKUP_FORMAT} from '../../../packages/contracts/backup.ts';
import {readBackupFile,canRestoreBackup,backupFailureMessage,backupStateMessage} from './enterprise-backup-state.ts';

export function EnterpriseBackupCenter({download}:{download:(value:unknown,name:string)=>void}){
 const identity=useSyncExternalStore(identitySession.subscribe,identitySession.getSnapshot,identitySession.getSnapshot);
 const [password,setPassword]=useState(''),[backup,setBackup]=useState<any>(null),[filename,setFilename]=useState(''),[preview,setPreview]=useState<any>(null),[confirmation,setConfirmation]=useState(''),[status,setStatus]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const working=useRef(false);
 async function refresh(){try{setStatus(await api('/backup/enterprise/status'));}catch(e){setStatus(null);throw e;}}
 useEffect(()=>{void refresh().catch(e=>setError(backupFailureMessage(e)));},[]);
 async function act(work:()=>Promise<void>){if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');try{await work();}catch(e){setError(backupFailureMessage(e));}finally{try{await refresh();}catch(e){setError(backupFailureMessage(e));}working.current=false;setBusy(false);}}
 const enterprise=backup?.format===ENTERPRISE_BACKUP_FORMAT,readyPassword=password.length>=12&&password.length<=200;
 const canRestore=canRestoreBackup({backup,preview,password,confirmation,busy:busy||status?.state!=='normal'});
 return <section className="panel padded lower"><h2>完整企业备份与恢复</h2>
  <p className="subcopy">默认 v2 保存企业身份与授权历史、费用、执行档案、知识版本、插件及交付文件。使用密码加密，密码无法找回。导出前请停止队列和运行任务；待核对费用会原样保留。</p>
  <div className="banner enterprise-backup-status" role="status"><p>{backupStateMessage(status)}</p>{status?.operationId&&<p>恢复编号：<code>{status.operationId}</code></p>}{status?.state==='quarantined'&&<p>物理文件核对：{status.physicalVerified?'已通过':'未通过'}。完整 v2 只能导入全新隔离实例；导入后需配置与来源相同的 OIDC 身份服务及引导账户，重新登录后激活。激活不沿用旧设备和工具授权。</p>}</div>
  <div className="enterprise-backup-actions">
   <button disabled={busy} onClick={()=>void act(refresh)}>重新核对恢复状态</button>
   {status?.state==='quarantined'&&<button className="primary" disabled={busy||!status.physicalVerified||identity.status!=='authenticated'||identity.session?.mode!=='oidc'} onClick={()=>void act(async()=>{await api('/backup/enterprise/activate','POST',{operationId:status.operationId,inputDigest:status.inputDigest});setNotice('目标环境已激活，请分别核对并重新授权需要使用的资源。');})}>核对后激活执行</button>}
  </div>
  {error&&<div className="banner error" role="alert">{error}</div>}{notice&&<div className="banner" role="status">{notice}</div>}
  <label className="field">备份密码（12～200 个字符）<input type="password" minLength={12} maxLength={200} autoComplete="new-password" disabled={busy} value={password} onChange={e=>{setPassword(e.target.value);setPreview(null);setConfirmation('');}}/></label>
  <button className="primary" disabled={busy||!readyPassword} onClick={()=>void act(async()=>{download(await api('/backup/enterprise/export','POST',{password}),'weave-enterprise-backup-'+new Date().toISOString().slice(0,10)+'.json');setNotice('完整企业备份已生成，请妥善保存文件和密码。');})}>生成并下载完整企业备份</button>
  <details className="lower"><summary>导入到全新隔离实例</summary><p className="subcopy">不会合并或覆盖已有企业数据。先预览计数，再确认导入；导入后保持隔离，不会自动续跑。身份初始化、设备目录和工具权限需要在新环境重新核对。</p>
   <label className="field">选择加密备份（最大 70 MiB）<input type="file" accept=".json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];setBackup(null);setPreview(null);setConfirmation('');setFilename('');if(file)void act(async()=>{const value=await readBackupFile(file);setBackup(value);setFilename(file.name);});}}/></label>
   {backup&&<p>{filename} · {enterprise?'完整企业 v2':'旧版业务格式 v1'}</p>}
   {enterprise&&<button disabled={busy||!readyPassword} onClick={()=>void act(async()=>{setPreview(null);setPreview(await api('/backup/enterprise/inspect','POST',{password,backup}));})}>预览并核对备份</button>}
   {preview&&<div className="lower"><p>创建时间：{preview.createdAt}</p><p>{Object.keys(preview.tableCounts).length} 张数据表 · {preview.fileCount} 个文件 · {(preview.totalBytes/1024/1024).toFixed(2)} MiB 文件内容</p><p>待核对费用：{preview.unresolvedCosts} 笔；未确认工具效果：{preview.unresolvedOperations} 项。记录会保留，恢复时不会自动重放。</p><details><summary>查看数据表计数</summary><dl>{Object.entries(preview.tableCounts).map(([name,count])=><div key={name}><dt>{name}</dt><dd>{String(count)} 行</dd></div>)}</dl></details></div>}
   {backup&&!enterprise&&<p className="subcopy">旧版业务格式只做格式识别，密码及内容在恢复时核对。它不包含完整企业身份和授权历史，已有企业历史的目标会拒绝导入。</p>}
   <label className="field">输入 {backup&&!enterprise?'RESTORE':'RESTORE ENTERPRISE'} 确认导入<input disabled={busy} autoComplete="off" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
   <button disabled={!canRestore} onClick={()=>void act(async()=>{const result=await api<{status?:string}>(enterprise?'/backup/enterprise/restore':'/backup/restore','POST',{password,backup,confirmation});setBackup(null);setPreview(null);setConfirmation('');setPassword('');setNotice(result.status==='quarantined'?'数据已导入，执行保持隔离。请按上方指引重新登录并核对。':'旧业务数据已导入，请重新核对设备与权限。');})}>{busy?'正在核对…':'确认导入备份'}</button>
  </details>
  <details className="lower"><summary>旧版业务格式</summary><p className="subcopy">为原本机业务备份保留 v1。该格式不能完整保存企业身份、审批与工具授权；存在这些历史时导出或导入会被拒绝。</p><button disabled={busy||!readyPassword} onClick={()=>void act(async()=>{download(await api('/backup/export','POST',{password}),'weave-business-v1-'+new Date().toISOString().slice(0,10)+'.json');setNotice('旧业务格式备份已生成。');})}>生成旧业务 v1 备份</button></details>
 </section>;
}
